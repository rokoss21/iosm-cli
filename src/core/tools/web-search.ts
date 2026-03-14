import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolPermissionGuard } from "./permissions.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateHead } from "./truncate.js";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query text." }),
	max_results: Type.Optional(Type.Number({ description: "Maximum number of results to return." })),
	include_domains: Type.Optional(Type.Array(Type.String(), { description: "Only include results from these domains." })),
	exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains." })),
	topic: Type.Optional(Type.String({ description: "Optional topic hint (e.g. general, news)." })),
	days: Type.Optional(Type.Number({ description: "Optional recency filter in days (provider support varies)." })),
	search_depth: Type.Optional(
		Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
			description: "Search depth hint for providers that support it (default: basic).",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 20)." })),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;
export type WebSearchProviderMode = "auto" | "tavily";
export type WebSearchFallbackMode = "searxng_ddg" | "searxng_only" | "none";
export type WebSearchSafeSearch = "off" | "moderate" | "strict";
export type WebSearchSearchDepth = "basic" | "advanced";
export type WebSearchProvider = "tavily" | "searxng" | "duckduckgo";
export type WebSearchAttemptStatus = "success" | "empty" | "error" | "skipped";

export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 8;
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 20;

const DEFAULT_PROVIDER_MODE: WebSearchProviderMode = "auto";
const DEFAULT_FALLBACK_MODE: WebSearchFallbackMode = "searxng_ddg";
const DEFAULT_SAFE_SEARCH: WebSearchSafeSearch = "moderate";
const DEFAULT_WEB_SEARCH_ENABLED = true;

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/";
const MAX_PROVIDER_BODY_BYTES = 512 * 1024;
const MAX_RESULTS_CAP = 20;

type WebSearchResult = {
	title: string;
	url: string;
	snippet: string;
	source: string;
};

export interface WebSearchAttemptDetail {
	provider: WebSearchProvider;
	status: WebSearchAttemptStatus;
	reason?: string;
	resultCount?: number;
}

export interface WebSearchToolDetails {
	query: string;
	provider: WebSearchProvider;
	maxResults: number;
	timeoutSeconds: number;
	safeSearch: WebSearchSafeSearch;
	providerMode: WebSearchProviderMode;
	fallbackMode: WebSearchFallbackMode;
	includeDomains: string[];
	excludeDomains: string[];
	attempts: WebSearchAttemptDetail[];
	truncation?: TruncationResult;
}

export interface WebSearchRuntimeConfig {
	enabled: boolean;
	providerMode: WebSearchProviderMode;
	fallbackMode: WebSearchFallbackMode;
	safeSearch: WebSearchSafeSearch;
	maxResults: number;
	timeoutSeconds: number;
}

export interface WebSearchToolOptions {
	fetchImpl?: typeof fetch;
	permissionGuard?: ToolPermissionGuard;
	resolveRuntimeConfig?: () => Partial<WebSearchRuntimeConfig> | WebSearchRuntimeConfig;
	resolveTavilyApiKey?: () => string | undefined;
	resolveSearxngBaseUrl?: () => string | undefined;
	defaultMaxResults?: number;
	defaultTimeoutSeconds?: number;
}

function normalizePositiveInt(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive number.`);
	}
	return value;
}

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	return fallback;
}

function normalizeProviderMode(raw: unknown): WebSearchProviderMode {
	return raw === "tavily" ? "tavily" : "auto";
}

function normalizeFallbackMode(raw: unknown): WebSearchFallbackMode {
	if (raw === "searxng_only" || raw === "none") return raw;
	return "searxng_ddg";
}

function normalizeSafeSearch(raw: unknown): WebSearchSafeSearch {
	if (raw === "off" || raw === "strict") return raw;
	return "moderate";
}

function normalizeRuntimeConfig(
	config: Partial<WebSearchRuntimeConfig> | WebSearchRuntimeConfig | undefined,
	defaultMaxResults: number,
	defaultTimeoutSeconds: number,
): WebSearchRuntimeConfig {
	const maxResults = Math.max(
		1,
		Math.min(
			MAX_RESULTS_CAP,
			normalizePositiveInt(
				typeof config?.maxResults === "number" ? config.maxResults : undefined,
				defaultMaxResults,
				"maxResults",
			),
		),
	);

	const timeoutSeconds = normalizePositiveInt(
		typeof config?.timeoutSeconds === "number" ? config.timeoutSeconds : undefined,
		defaultTimeoutSeconds,
		"timeoutSeconds",
	);

	return {
		enabled: normalizeBoolean(config?.enabled, DEFAULT_WEB_SEARCH_ENABLED),
		providerMode: normalizeProviderMode(config?.providerMode),
		fallbackMode: normalizeFallbackMode(config?.fallbackMode),
		safeSearch: normalizeSafeSearch(config?.safeSearch),
		maxResults,
		timeoutSeconds,
	};
}

function normalizeQuery(query: string): string {
	const normalized = query.trim();
	if (!normalized) {
		throw new Error("query must be a non-empty string.");
	}
	return normalized;
}

function normalizeDomain(raw: string): string | undefined {
	const compact = raw.trim().toLowerCase();
	if (!compact) return undefined;
	const noProtocol = compact.replace(/^https?:\/\//, "");
	const hostPart = noProtocol.split("/")[0] ?? "";
	const withoutPort = hostPart.split(":")[0] ?? "";
	const normalized = withoutPort.replace(/^\*\./, "").replace(/^www\./, "");
	return normalized || undefined;
}

function normalizeDomains(raw: string[] | undefined): string[] {
	if (!raw || raw.length === 0) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const domain of raw) {
		const normalized = normalizeDomain(domain);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function hostMatchesDomain(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function normalizeUrl(rawUrl: string): string | undefined {
	let candidate = decodeHtmlEntities(rawUrl.trim());
	if (!candidate) return undefined;

	if (candidate.startsWith("//")) {
		candidate = `https:${candidate}`;
	}

	const duckRedirectPrefixes = ["/l/?", "https://duckduckgo.com/l/?", "http://duckduckgo.com/l/?"];
	if (duckRedirectPrefixes.some((prefix) => candidate.startsWith(prefix))) {
		try {
			const redirectUrl = new URL(candidate, "https://duckduckgo.com");
			const resolved = redirectUrl.searchParams.get("uddg");
			if (resolved) candidate = resolved;
		} catch {
			// Keep candidate as-is and try best effort parsing below.
		}
	}

	try {
		return new URL(candidate).toString();
	} catch {
		return undefined;
	}
}

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function stripHtml(input: string): string {
	return decodeHtmlEntities(input.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeResult(result: Partial<WebSearchResult> & { url?: string }): WebSearchResult | undefined {
	const url = result.url ? normalizeUrl(result.url) : undefined;
	if (!url) return undefined;
	const title = (result.title ?? "").trim() || url;
	const snippet = (result.snippet ?? "").trim();
	const source = (result.source ?? "").trim() || "unknown";
	return {
		title,
		url,
		snippet,
		source,
	};
}

function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
	const seen = new Set<string>();
	const deduped: WebSearchResult[] = [];
	for (const result of results) {
		const key = result.url.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(result);
	}
	return deduped;
}

function applyDomainFilters(results: WebSearchResult[], includeDomains: string[], excludeDomains: string[]): WebSearchResult[] {
	return results.filter((result) => {
		let hostname = "";
		try {
			hostname = new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
		} catch {
			return false;
		}

		if (excludeDomains.some((domain) => hostMatchesDomain(hostname, domain))) {
			return false;
		}
		if (includeDomains.length === 0) {
			return true;
		}
		return includeDomains.some((domain) => hostMatchesDomain(hostname, domain));
	});
}

function appendDomainOperators(query: string, includeDomains: string[], excludeDomains: string[]): string {
	const tokens = [query];
	for (const domain of includeDomains) {
		tokens.push(`site:${domain}`);
	}
	for (const domain of excludeDomains) {
		tokens.push(`-site:${domain}`);
	}
	return tokens.join(" ").trim();
}

function safeSearchToSearxng(value: WebSearchSafeSearch): "0" | "1" | "2" {
	if (value === "off") return "0";
	if (value === "strict") return "2";
	return "1";
}

function safeSearchToDuckDuckGo(value: WebSearchSafeSearch): "-2" | "-1" | "1" {
	if (value === "off") return "-2";
	if (value === "strict") return "1";
	return "-1";
}

function resolveTavilyApiKeyFromEnv(): string | undefined {
	const key = process.env.TAVILY_API_KEY?.trim();
	return key ? key : undefined;
}

function resolveSearxngBaseUrlFromEnv(): string | undefined {
	const fromPrimary = process.env.IOSM_WEB_SEARCH_SEARXNG_URL?.trim();
	if (fromPrimary) return fromPrimary;
	const fromLegacy = process.env.PI_WEB_SEARCH_SEARXNG_URL?.trim();
	return fromLegacy ? fromLegacy : undefined;
}

function formatAttemptTrace(attempts: WebSearchAttemptDetail[]): string {
	return attempts
		.map((attempt) => {
			const base = `${attempt.provider}:${attempt.status}`;
			if (!attempt.reason) return base;
			return `${base} (${attempt.reason})`;
		})
		.join(" -> ");
}

function formatResultsOutput(params: {
	query: string;
	provider: WebSearchProvider;
	results: WebSearchResult[];
	attempts: WebSearchAttemptDetail[];
}): string {
	const lines: string[] = [];
	lines.push(`Search query: ${params.query}`);
	lines.push(`Provider: ${params.provider}`);
	lines.push(`Attempts: ${formatAttemptTrace(params.attempts)}`);
	lines.push("");

	for (const [index, result] of params.results.entries()) {
		lines.push(`${index + 1}. ${result.title}`);
		lines.push(`   ${result.url}`);
		if (result.snippet) {
			lines.push(`   ${result.snippet}`);
		}
		lines.push(`   source: ${result.source}`);
	}

	return lines.join("\n");
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<{
	buffer: Buffer;
	truncated: boolean;
}> {
	if (!response.body) {
		return { buffer: Buffer.alloc(0), truncated: false };
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	let truncated = false;

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		const chunk = Buffer.from(value);

		if (total + chunk.length > maxBytes) {
			const remaining = maxBytes - total;
			if (remaining > 0) {
				chunks.push(chunk.subarray(0, remaining));
				total += remaining;
			}
			truncated = true;
			await reader.cancel().catch(() => {});
			break;
		}

		chunks.push(chunk);
		total += chunk.length;
	}

	return { buffer: Buffer.concat(chunks, total), truncated };
}

async function parseJsonBody(response: Response): Promise<{ data: unknown; bodyTruncated: boolean }> {
	const captured = await readResponseBodyWithLimit(response, MAX_PROVIDER_BODY_BYTES);
	let data: unknown;
	try {
		data = JSON.parse(captured.buffer.toString("utf-8"));
	} catch (error: any) {
		throw new Error(`Invalid JSON response: ${error?.message ?? "parse failed"}`);
	}
	return { data, bodyTruncated: captured.truncated };
}

async function parseTextBody(response: Response): Promise<{ text: string; bodyTruncated: boolean }> {
	const captured = await readResponseBodyWithLimit(response, MAX_PROVIDER_BODY_BYTES);
	return { text: captured.buffer.toString("utf-8"), bodyTruncated: captured.truncated };
}

async function searchWithTavily(params: {
	fetchImpl: typeof fetch;
	apiKey: string;
	query: string;
	maxResults: number;
	includeDomains: string[];
	excludeDomains: string[];
	topic?: string;
	days?: number;
	searchDepth: WebSearchSearchDepth;
	signal: AbortSignal;
}): Promise<{ results: WebSearchResult[]; notice?: string }> {
	const payload: Record<string, unknown> = {
		api_key: params.apiKey,
		query: params.query,
		max_results: params.maxResults,
		search_depth: params.searchDepth,
	};
	if (params.includeDomains.length > 0) payload.include_domains = params.includeDomains;
	if (params.excludeDomains.length > 0) payload.exclude_domains = params.excludeDomains;
	if (params.topic) payload.topic = params.topic;
	if (params.days !== undefined) payload.days = params.days;

	const response = await params.fetchImpl(TAVILY_SEARCH_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify(payload),
		signal: params.signal,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}

	const { data, bodyTruncated } = await parseJsonBody(response);
	const rawResults = Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : [];

	const results = rawResults
		.map((entry) => {
			const item = entry as Record<string, unknown>;
			return normalizeResult({
				title: typeof item.title === "string" ? item.title : undefined,
				url: typeof item.url === "string" ? item.url : undefined,
				snippet:
					typeof item.content === "string"
						? item.content
						: typeof item.snippet === "string"
							? item.snippet
							: undefined,
				source: "tavily",
			});
		})
		.filter((item): item is WebSearchResult => item !== undefined);

	return { results: dedupeResults(results), notice: bodyTruncated ? "response body truncated" : undefined };
}

async function searchWithSearxng(params: {
	fetchImpl: typeof fetch;
	baseUrl: string;
	query: string;
	maxResults: number;
	topic?: string;
	days?: number;
	safeSearch: WebSearchSafeSearch;
	signal: AbortSignal;
}): Promise<{ results: WebSearchResult[]; notice?: string }> {
	const url = new URL(params.baseUrl);
	const normalizedPath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	url.pathname = normalizedPath;

	const endpoint = new URL("search", url);
	endpoint.searchParams.set("q", params.query);
	endpoint.searchParams.set("format", "json");
	endpoint.searchParams.set("safesearch", safeSearchToSearxng(params.safeSearch));
	endpoint.searchParams.set("language", "en-US");
	if (params.topic) {
		endpoint.searchParams.set("categories", params.topic);
	}
	if (params.days !== undefined) {
		if (params.days <= 1) endpoint.searchParams.set("time_range", "day");
		else if (params.days <= 7) endpoint.searchParams.set("time_range", "week");
		else if (params.days <= 31) endpoint.searchParams.set("time_range", "month");
		else endpoint.searchParams.set("time_range", "year");
	}

	const response = await params.fetchImpl(endpoint, {
		method: "GET",
		headers: { accept: "application/json" },
		signal: params.signal,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}

	const { data, bodyTruncated } = await parseJsonBody(response);
	const rawResults = Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : [];
	const results = rawResults
		.slice(0, Math.max(params.maxResults * 3, params.maxResults))
		.map((entry) => {
			const item = entry as Record<string, unknown>;
			return normalizeResult({
				title: typeof item.title === "string" ? item.title : undefined,
				url: typeof item.url === "string" ? item.url : undefined,
				snippet: typeof item.content === "string" ? item.content : undefined,
				source: typeof item.engine === "string" && item.engine.trim() ? item.engine : "searxng",
			});
		})
		.filter((item): item is WebSearchResult => item !== undefined);

	return { results: dedupeResults(results), notice: bodyTruncated ? "response body truncated" : undefined };
}

function parseDuckDuckGoResults(html: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	const seen = new Set<string>();

	const primaryRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = primaryRegex.exec(html)) !== null) {
		const rawUrl = match[1] ?? "";
		const resolvedUrl = normalizeUrl(rawUrl);
		if (!resolvedUrl || seen.has(resolvedUrl)) continue;
		seen.add(resolvedUrl);

		const title = stripHtml(match[2] ?? "") || resolvedUrl;
		const tail = html.slice(match.index, Math.min(match.index + 2200, html.length));
		const snippetMatch =
			tail.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i) ??
			tail.match(/class="[^"]*result__extras__url[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/i);
		const snippet = snippetMatch ? stripHtml(snippetMatch[1] ?? "") : "";

		results.push({
			title,
			url: resolvedUrl,
			snippet,
			source: "duckduckgo",
		});
	}

	if (results.length > 0) {
		return results;
	}

	const liteRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	while ((match = liteRegex.exec(html)) !== null) {
		const resolvedUrl = normalizeUrl(match[1] ?? "");
		if (!resolvedUrl || seen.has(resolvedUrl)) continue;
		seen.add(resolvedUrl);
		results.push({
			title: stripHtml(match[2] ?? "") || resolvedUrl,
			url: resolvedUrl,
			snippet: "",
			source: "duckduckgo",
		});
	}

	return results;
}

async function searchWithDuckDuckGo(params: {
	fetchImpl: typeof fetch;
	query: string;
	safeSearch: WebSearchSafeSearch;
	signal: AbortSignal;
}): Promise<{ results: WebSearchResult[]; notice?: string }> {
	const endpoint = new URL(DUCKDUCKGO_HTML_URL);
	endpoint.searchParams.set("q", params.query);
	endpoint.searchParams.set("kp", safeSearchToDuckDuckGo(params.safeSearch));
	endpoint.searchParams.set("kl", "us-en");

	const response = await params.fetchImpl(endpoint, {
		method: "GET",
		headers: {
			accept: "text/html,application/xhtml+xml",
		},
		signal: params.signal,
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}

	const { text, bodyTruncated } = await parseTextBody(response);
	return {
		results: dedupeResults(parseDuckDuckGoResults(text)),
		notice: bodyTruncated ? "response body truncated" : undefined,
	};
}

function buildProviderOrder(fallbackMode: WebSearchFallbackMode): WebSearchProvider[] {
	const providers: WebSearchProvider[] = ["tavily"];
	if (fallbackMode === "searxng_ddg") {
		providers.push("searxng", "duckduckgo");
	} else if (fallbackMode === "searxng_only") {
		providers.push("searxng");
	}
	return providers;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function capSnippet(snippet: string, maxLength = 320): string {
	if (snippet.length <= maxLength) return snippet;
	return `${snippet.slice(0, maxLength - 1).trimEnd()}…`;
}

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const permissionGuard = options?.permissionGuard;
	const resolveTavilyApiKey = (): string | undefined => {
		const fromOptions = options?.resolveTavilyApiKey?.()?.trim();
		return fromOptions && fromOptions.length > 0 ? fromOptions : resolveTavilyApiKeyFromEnv();
	};
	const resolveSearxngBaseUrl = (): string | undefined => {
		const fromOptions = options?.resolveSearxngBaseUrl?.()?.trim();
		return fromOptions && fromOptions.length > 0 ? fromOptions : resolveSearxngBaseUrlFromEnv();
	};
	const defaultMaxResults = Math.max(
		1,
		Math.min(MAX_RESULTS_CAP, normalizePositiveInt(options?.defaultMaxResults, DEFAULT_WEB_SEARCH_MAX_RESULTS, "defaultMaxResults")),
	);
	const defaultTimeoutSeconds = normalizePositiveInt(
		options?.defaultTimeoutSeconds,
		DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
		"defaultTimeoutSeconds",
	);

	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for discovery (provider chain: Tavily -> SearXNG -> DuckDuckGo). Use fetch for reading specific pages.",
		parameters: webSearchSchema,
		execute: async (_toolCallId: string, input: WebSearchToolInput, signal?: AbortSignal) => {
			const query = normalizeQuery(input.query);
			const runtimeConfig = normalizeRuntimeConfig(options?.resolveRuntimeConfig?.(), defaultMaxResults, defaultTimeoutSeconds);
			if (!runtimeConfig.enabled) {
				throw new Error("web_search is disabled in settings.");
			}

			const maxResults = Math.max(
				1,
				Math.min(
					MAX_RESULTS_CAP,
					normalizePositiveInt(input.max_results, runtimeConfig.maxResults, "max_results"),
				),
			);
			const timeoutSeconds = normalizePositiveInt(input.timeout, runtimeConfig.timeoutSeconds, "timeout");
			const searchDepth: WebSearchSearchDepth = input.search_depth === "advanced" ? "advanced" : "basic";
			const includeDomains = normalizeDomains(input.include_domains);
			const excludeDomains = normalizeDomains(input.exclude_domains);
			const days = input.days === undefined ? undefined : normalizePositiveInt(input.days, 1, "days");
			const queryWithDomains = appendDomainOperators(query, includeDomains, excludeDomains);
			const providerOrder = buildProviderOrder(runtimeConfig.fallbackMode);

			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "web_search",
					cwd,
					input: {
						query,
						maxResults,
						timeoutSeconds,
						providerMode: runtimeConfig.providerMode,
						fallbackMode: runtimeConfig.fallbackMode,
						safeSearch: runtimeConfig.safeSearch,
						includeDomains,
						excludeDomains,
					},
					summary: `query="${query}"`,
				});
				if (!allowed) {
					throw new Error("Permission denied for web_search operation.");
				}
			}

			const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const providerRequestLimit = Math.min(MAX_RESULTS_CAP, Math.max(maxResults, maxResults * 2));
			const attempts: WebSearchAttemptDetail[] = [];
			let selectedProvider: WebSearchProvider | undefined;
			let selectedResults: WebSearchResult[] = [];
			const providerNotices: string[] = [];

			for (const provider of providerOrder) {
				if (provider === "tavily") {
					const apiKey = resolveTavilyApiKey();
					if (!apiKey) {
						attempts.push({
							provider: "tavily",
							status: runtimeConfig.providerMode === "tavily" ? "error" : "skipped",
							reason: "Tavily API key is not configured",
						});
						continue;
					}

					try {
						const providerResult = await searchWithTavily({
							fetchImpl,
							apiKey,
							query,
							maxResults: providerRequestLimit,
							includeDomains,
							excludeDomains,
							topic: input.topic,
							days,
							searchDepth,
							signal: requestSignal,
						});
						if (providerResult.notice) providerNotices.push(`tavily: ${providerResult.notice}`);
						const filtered = applyDomainFilters(providerResult.results, includeDomains, excludeDomains).slice(0, maxResults);
						if (filtered.length === 0) {
							attempts.push({
								provider: "tavily",
								status: "empty",
								reason: providerResult.results.length === 0 ? "no results returned" : "all results filtered out",
							});
							continue;
						}
						selectedProvider = "tavily";
						selectedResults = filtered;
						attempts.push({
							provider: "tavily",
							status: "success",
							resultCount: filtered.length,
						});
						break;
					} catch (error) {
						attempts.push({
							provider: "tavily",
							status: "error",
							reason: toErrorMessage(error),
						});
						continue;
					}
				}

				if (provider === "searxng") {
					const baseUrl = resolveSearxngBaseUrl();
					if (!baseUrl) {
						attempts.push({
							provider: "searxng",
							status: "skipped",
							reason: "SearXNG base URL is not configured",
						});
						continue;
					}

					try {
						const providerResult = await searchWithSearxng({
							fetchImpl,
							baseUrl,
							query: queryWithDomains,
							maxResults: providerRequestLimit,
							topic: input.topic,
							days,
							safeSearch: runtimeConfig.safeSearch,
							signal: requestSignal,
						});
						if (providerResult.notice) providerNotices.push(`searxng: ${providerResult.notice}`);
						const filtered = applyDomainFilters(providerResult.results, includeDomains, excludeDomains).slice(0, maxResults);
						if (filtered.length === 0) {
							attempts.push({
								provider: "searxng",
								status: "empty",
								reason: providerResult.results.length === 0 ? "no results returned" : "all results filtered out",
							});
							continue;
						}
						selectedProvider = "searxng";
						selectedResults = filtered;
						attempts.push({
							provider: "searxng",
							status: "success",
							resultCount: filtered.length,
						});
						break;
					} catch (error) {
						attempts.push({
							provider: "searxng",
							status: "error",
							reason: toErrorMessage(error),
						});
						continue;
					}
				}

				try {
					const providerResult = await searchWithDuckDuckGo({
						fetchImpl,
						query: queryWithDomains,
						safeSearch: runtimeConfig.safeSearch,
						signal: requestSignal,
					});
					if (providerResult.notice) providerNotices.push(`duckduckgo: ${providerResult.notice}`);
					const filtered = applyDomainFilters(providerResult.results, includeDomains, excludeDomains).slice(0, maxResults);
					if (filtered.length === 0) {
						attempts.push({
							provider: "duckduckgo",
							status: "empty",
							reason: providerResult.results.length === 0 ? "no results returned" : "all results filtered out",
						});
						continue;
					}
					selectedProvider = "duckduckgo";
					selectedResults = filtered;
					attempts.push({
						provider: "duckduckgo",
						status: "success",
						resultCount: filtered.length,
					});
					break;
				} catch (error) {
					attempts.push({
						provider: "duckduckgo",
						status: "error",
						reason: toErrorMessage(error),
					});
				}
			}

			if (!selectedProvider || selectedResults.length === 0) {
				throw new Error(`web_search failed. Attempts: ${formatAttemptTrace(attempts)}`);
			}

			const output = formatResultsOutput({
				query,
				provider: selectedProvider,
				results: selectedResults.map((item) => ({ ...item, snippet: capSnippet(item.snippet) })),
				attempts,
			});
			const truncation = truncateHead(output, {
				maxBytes: Math.max(DEFAULT_MAX_BYTES, 96 * 1024),
				maxLines: DEFAULT_MAX_LINES,
			});
			let finalOutput = truncation.content;
			const notices: string[] = [];
			if (truncation.truncated) {
				notices.push(
					`output truncated by ${truncation.truncatedBy === "lines" ? "line" : "byte"} limit (showing up to ${DEFAULT_MAX_LINES} lines)`,
				);
			}
			if (providerNotices.length > 0) {
				notices.push(...providerNotices);
			}
			if (notices.length > 0) {
				finalOutput += `\n\n[${notices.join(". ")}]`;
			}

			const details: WebSearchToolDetails = {
				query,
				provider: selectedProvider,
				maxResults,
				timeoutSeconds,
				safeSearch: runtimeConfig.safeSearch,
				providerMode: runtimeConfig.providerMode,
				fallbackMode: runtimeConfig.fallbackMode,
				includeDomains,
				excludeDomains,
				attempts,
				truncation: truncation.truncated ? truncation : undefined,
			};

			return {
				content: [{ type: "text", text: finalOutput }],
				details,
			};
		},
	};
}

export const webSearchTool = createWebSearchTool(process.cwd());

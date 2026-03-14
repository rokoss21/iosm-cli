import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { isReadOnlyProfileName } from "../agent-profiles.js";
import type { ToolPermissionGuard } from "./permissions.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

const fetchSchema = Type.Object({
	url: Type.String({ description: "Target URL (http/https)." }),
	method: Type.Optional(
		Type.Union(
			[
				Type.Literal("GET"),
				Type.Literal("POST"),
				Type.Literal("PUT"),
				Type.Literal("PATCH"),
				Type.Literal("DELETE"),
				Type.Literal("HEAD"),
				Type.Literal("OPTIONS"),
			],
			{ description: "HTTP method (default: GET)." },
		),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Optional HTTP headers.",
		}),
	),
	body: Type.Optional(Type.String({ description: "Optional request body (mostly for POST/PUT/PATCH/DELETE)." })),
	timeout: Type.Optional(Type.Number({ description: "Request timeout in seconds (default: 30)." })),
	max_bytes: Type.Optional(
		Type.Number({
			description: "Maximum response bytes to capture from body (default: 262144).",
		}),
	),
	response_format: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("json"), Type.Literal("text")], {
			description: "Body rendering: auto | json | text (default: auto).",
		}),
	),
	max_redirects: Type.Optional(
		Type.Number({
			description: "Maximum redirect hops to follow manually (default: 5).",
		}),
	),
});

export type FetchToolInput = Static<typeof fetchSchema>;
export type FetchResponseFormat = "auto" | "json" | "text";
export type FetchMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export const DEFAULT_FETCH_TIMEOUT_SECONDS = 30;
export const DEFAULT_FETCH_MAX_BYTES = 256 * 1024;
export const DEFAULT_FETCH_MAX_REDIRECTS = 5;

const READ_ONLY_FETCH_METHODS = new Set<FetchMethod>(["GET", "HEAD", "OPTIONS"]);
const FULL_FETCH_METHODS = new Set<FetchMethod>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export interface FetchToolDetails {
	method: FetchMethod;
	requestUrl: string;
	finalUrl: string;
	status: number;
	statusText: string;
	redirectsFollowed: number;
	responseFormat: "json" | "text";
	timeoutSeconds: number;
	maxBytes: number;
	bodyBytesCaptured: number;
	bodyCaptureTruncated: boolean;
	truncation?: TruncationResult;
}

export interface FetchToolOptions {
	fetchImpl?: typeof fetch;
	permissionGuard?: ToolPermissionGuard;
	resolveAllowedMethods?: () => ReadonlySet<FetchMethod> | readonly FetchMethod[];
	defaultTimeoutSeconds?: number;
	defaultMaxBytes?: number;
	defaultMaxRedirects?: number;
}

export function getAllowedFetchMethodsForProfile(profileName: string | undefined): ReadonlySet<FetchMethod> {
	return isReadOnlyProfileName(profileName) ? READ_ONLY_FETCH_METHODS : FULL_FETCH_METHODS;
}

function asSet(methods: ReadonlySet<FetchMethod> | readonly FetchMethod[]): ReadonlySet<FetchMethod> {
	return methods instanceof Set ? methods : new Set(methods);
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const normalized = contentType.toLowerCase();
	return normalized.includes("application/json") || normalized.includes("+json");
}

function isRedirectStatus(status: number): boolean {
	return REDIRECT_STATUS_CODES.has(status);
}

function normalizeMethod(raw: string | undefined): FetchMethod {
	return ((raw ?? "GET").toUpperCase() as FetchMethod);
}

function normalizePositiveInt(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive number.`);
	}
	return value;
}

function normalizeNonNegativeInt(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${field} must be a non-negative number.`);
	}
	return value;
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

function formatHttpSummary(input: {
	method: FetchMethod;
	status: number;
	statusText: string;
	finalUrl: string;
	redirectsFollowed: number;
	body: string;
}): string {
	const lines = [`HTTP ${input.status}${input.statusText ? ` ${input.statusText}` : ""}`, `${input.method} ${input.finalUrl}`];
	if (input.redirectsFollowed > 0) {
		lines.push(`redirects followed: ${input.redirectsFollowed}`);
	}
	if (input.body.length === 0) {
		lines.push("(no response body)");
		return lines.join("\n");
	}
	return `${lines.join("\n")}\n\n${input.body}`;
}

function nextMethodAfterRedirect(status: number, method: FetchMethod): FetchMethod {
	if (status === 303) {
		return method === "HEAD" ? "HEAD" : "GET";
	}
	if ((status === 301 || status === 302) && method === "POST") {
		return "GET";
	}
	return method;
}

export function createFetchTool(cwd: string, options?: FetchToolOptions): AgentTool<typeof fetchSchema> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const permissionGuard = options?.permissionGuard;
	const defaultTimeoutSeconds = options?.defaultTimeoutSeconds ?? DEFAULT_FETCH_TIMEOUT_SECONDS;
	const defaultMaxBytes = options?.defaultMaxBytes ?? DEFAULT_FETCH_MAX_BYTES;
	const defaultMaxRedirects = options?.defaultMaxRedirects ?? DEFAULT_FETCH_MAX_REDIRECTS;

	return {
		name: "fetch",
		label: "fetch",
		description:
			"Make HTTP requests (manual redirect handling). Defaults: method=GET, timeout=30s, max_bytes=262144, response_format=auto, max_redirects=5.",
		parameters: fetchSchema,
		execute: async (_toolCallId: string, input: FetchToolInput, signal?: AbortSignal) => {
			const method = normalizeMethod(input.method);
			const allowedMethods = asSet(options?.resolveAllowedMethods?.() ?? FULL_FETCH_METHODS);
			if (!allowedMethods.has(method)) {
				throw new Error(
					`HTTP method "${method}" is not allowed in the current profile. Allowed methods: ${Array.from(allowedMethods).join(", ")}`,
				);
			}

			if ((method === "GET" || method === "HEAD") && input.body !== undefined) {
				throw new Error(`HTTP ${method} does not accept a request body in this tool.`);
			}

			let requestUrl: string;
			try {
				requestUrl = new URL(input.url).toString();
			} catch {
				throw new Error(`Invalid URL: ${input.url}`);
			}

			const timeoutSeconds = normalizePositiveInt(input.timeout, defaultTimeoutSeconds, "timeout");
			const maxBytes = normalizePositiveInt(input.max_bytes, defaultMaxBytes, "max_bytes");
			const maxRedirects = normalizeNonNegativeInt(input.max_redirects, defaultMaxRedirects, "max_redirects");
			const requestedFormat: FetchResponseFormat = input.response_format ?? "auto";

			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "fetch",
					cwd,
					input: {
						url: requestUrl,
						method,
						headers: input.headers,
						hasBody: input.body !== undefined,
						bodyLength: input.body?.length ?? 0,
						timeoutSeconds,
						maxBytes,
						maxRedirects,
						responseFormat: requestedFormat,
					},
					summary: `${method} ${requestUrl}`,
				});
				if (!allowed) {
					throw new Error("Permission denied for fetch operation.");
				}
			}

			const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			let currentUrl = requestUrl;
			let currentMethod: FetchMethod = method;
			let currentBody = input.body;
			let redirectsFollowed = 0;
			let response: Response | undefined;

			while (true) {
				response = await fetchImpl(currentUrl, {
					method: currentMethod,
					headers: input.headers,
					body: currentBody,
					redirect: "manual",
					signal: requestSignal,
				});

				if (!isRedirectStatus(response.status)) {
					break;
				}

				const location = response.headers.get("location");
				if (!location) {
					break;
				}
				if (redirectsFollowed >= maxRedirects) {
					throw new Error(`Redirect limit exceeded (${maxRedirects}).`);
				}

				currentUrl = new URL(location, currentUrl).toString();
				const redirectedMethod = nextMethodAfterRedirect(response.status, currentMethod);
				if (redirectedMethod !== currentMethod) {
					currentBody = undefined;
				}
				currentMethod = redirectedMethod;
				redirectsFollowed++;
			}

			if (!response) {
				throw new Error("No response received.");
			}

			const bodyResult = await readResponseBodyWithLimit(response, maxBytes);
			const contentType = response.headers.get("content-type");
			const resolvedFormat: "json" | "text" =
				requestedFormat === "auto" ? (isJsonContentType(contentType) ? "json" : "text") : requestedFormat;
			const rawText = bodyResult.buffer.toString("utf-8");

			let formattedBody: string;
			if (resolvedFormat === "json") {
				try {
					const parsed = JSON.parse(rawText);
					formattedBody = JSON.stringify(parsed, null, 2);
				} catch (error: any) {
					throw new Error(`Response body is not valid JSON: ${error?.message ?? "parse failed"}`);
				}
			} else {
				formattedBody = rawText;
			}

			const summary = formatHttpSummary({
				method,
				status: response.status,
				statusText: response.statusText,
				finalUrl: currentUrl,
				redirectsFollowed,
				body: formattedBody.trimEnd(),
			});

			const truncation = truncateHead(summary, {
				maxBytes: Math.max(DEFAULT_MAX_BYTES, maxBytes + 1024),
				maxLines: DEFAULT_MAX_LINES,
			});
			let output = truncation.content;
			const notices: string[] = [];

			if (bodyResult.truncated) {
				notices.push(`response body truncated at ${formatSize(maxBytes)}`);
			}
			if (truncation.truncated) {
				notices.push(
					`output truncated by ${truncation.truncatedBy === "lines" ? "line" : "byte"} limit (showing up to ${DEFAULT_MAX_LINES} lines)`,
				);
			}
			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			const details: FetchToolDetails = {
				method,
				requestUrl,
				finalUrl: currentUrl,
				status: response.status,
				statusText: response.statusText,
				redirectsFollowed,
				responseFormat: resolvedFormat,
				timeoutSeconds,
				maxBytes,
				bodyBytesCaptured: bodyResult.buffer.length,
				bodyCaptureTruncated: bodyResult.truncated,
				truncation: truncation.truncated ? truncation : undefined,
			};

			return {
				content: [{ type: "text", text: output }],
				details,
			};
		},
	};
}

export const fetchTool = createFetchTool(process.cwd());

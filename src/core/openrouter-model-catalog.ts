import type { Api } from "@mariozechner/pi-ai";
import type { ProviderConfigInput } from "./model-registry.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
const OPENROUTER_USER_MODELS_URL = `${OPENROUTER_MODELS_URL}/user`;
const DEFAULT_TIMEOUT_MS = 12_000;
const TOKENS_PER_MILLION = 1_000_000;

interface OpenRouterModelCatalogOptions {
	apiKey?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function tokenPriceToPerMillion(value: unknown, fallback: number): number {
	const perToken = toFiniteNumber(value, Number.NaN);
	if (!Number.isFinite(perToken)) return fallback;
	return perToken * TOKENS_PER_MILLION;
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function includesImageInput(architecture: Record<string, unknown> | undefined): boolean {
	if (!architecture) return false;

	const inputModalities = Array.isArray(architecture.input_modalities)
		? architecture.input_modalities.filter((value): value is string => typeof value === "string")
		: [];
	if (inputModalities.some((modality) => modality.toLowerCase().includes("image"))) {
		return true;
	}

	const modality = toNonEmptyString(architecture.modality)?.toLowerCase() ?? "";
	return modality.includes("image");
}

function supportsReasoning(row: Record<string, unknown>): boolean {
	const params = Array.isArray(row.supported_parameters)
		? row.supported_parameters.filter((value): value is string => typeof value === "string")
		: [];
	return params.some((param) => param.toLowerCase().includes("reason"));
}

function normalizeModelRecord(
	row: Record<string, unknown>,
): NonNullable<ProviderConfigInput["models"]>[number] | undefined {
	const id = toNonEmptyString(row.id);
	if (!id) return undefined;

	const architecture = isRecord(row.architecture) ? row.architecture : undefined;
	const pricing = isRecord(row.pricing) ? row.pricing : undefined;
	const topProvider = isRecord(row.top_provider) ? row.top_provider : undefined;

	const input = includesImageInput(architecture) ? (["text", "image"] as const) : (["text"] as const);
	const contextWindow = toFiniteNumber(row.context_length, toFiniteNumber(topProvider?.context_length, 128000));
	const maxTokens = toFiniteNumber(topProvider?.max_completion_tokens, 16384);

	return {
		id,
		name: toNonEmptyString(row.name) ?? id,
		api: "openai-completions" as Api,
		reasoning: supportsReasoning(row),
		input: [...input],
		cost: {
			input: tokenPriceToPerMillion(pricing?.prompt, 0),
			output: tokenPriceToPerMillion(pricing?.completion, 0),
			cacheRead: tokenPriceToPerMillion(pricing?.input_cache_read, 0),
			cacheWrite: tokenPriceToPerMillion(pricing?.input_cache_write, 0),
		},
		contextWindow,
		maxTokens,
	};
}

function normalizeModels(payload: unknown): NonNullable<ProviderConfigInput["models"]> {
	if (!isRecord(payload) || !Array.isArray(payload.data)) return [];

	const seen = new Set<string>();
	const models: NonNullable<ProviderConfigInput["models"]> = [];
	for (const row of payload.data) {
		if (!isRecord(row)) continue;
		const model = normalizeModelRecord(row);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}

	models.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
	return models;
}

async function requestCatalog(
	url: string,
	options: {
		timeoutMs: number;
		headers?: Record<string, string>;
		fetchImpl: typeof fetch;
	},
): Promise<NonNullable<ProviderConfigInput["models"]> | undefined> {
	try {
		const response = await options.fetchImpl(url, {
			method: "GET",
			headers: options.headers,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		if (!response.ok) return undefined;

		const payload = (await response.json()) as unknown;
		const models = normalizeModels(payload);
		return models.length > 0 ? models : undefined;
	} catch {
		return undefined;
	}
}

export async function loadOpenRouterProviderConfig(
	options: OpenRouterModelCatalogOptions = {},
): Promise<ProviderConfigInput | undefined> {
	const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") return undefined;

	const apiKey = options.apiKey?.trim();
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const fromUserCatalog = apiKey
		? await requestCatalog(OPENROUTER_USER_MODELS_URL, {
				timeoutMs,
				headers,
				fetchImpl,
			})
		: undefined;
	const models =
		fromUserCatalog ??
		(await requestCatalog(OPENROUTER_MODELS_URL, {
			timeoutMs,
			headers,
			fetchImpl,
		}));
	if (!models || models.length === 0) return undefined;

	return {
		baseUrl: OPENROUTER_BASE_URL,
		models,
	};
}

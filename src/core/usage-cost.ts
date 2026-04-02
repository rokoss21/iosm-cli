import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

const TOKENS_PER_MILLION = 1_000_000;

function safeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function estimateAssistantUsageCost(
	usage: AssistantMessage["usage"],
	model: Pick<Model<Api>, "cost"> | undefined,
): number {
	if (!model) return 0;

	const input = safeNumber(usage.input);
	const output = safeNumber(usage.output);
	const cacheRead = safeNumber(usage.cacheRead);
	const cacheWrite = safeNumber(usage.cacheWrite);
	const estimated =
		(model.cost.input * input +
			model.cost.output * output +
			model.cost.cacheRead * cacheRead +
			model.cost.cacheWrite * cacheWrite) /
		TOKENS_PER_MILLION;
	return estimated > 0 ? estimated : 0;
}

export function resolveAssistantCostWithOpenRouterFallback(
	message: AssistantMessage,
	resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined,
): number {
	const recorded = safeNumber(message.usage?.cost?.total);
	if (recorded > 0) return recorded;
	if (message.provider !== "openrouter" || !resolveModel) return recorded;

	const model = resolveModel(message.provider, message.model);
	return estimateAssistantUsageCost(message.usage, model);
}

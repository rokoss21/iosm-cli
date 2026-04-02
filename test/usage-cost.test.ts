import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateAssistantUsageCost, resolveAssistantCostWithOpenRouterFallback } from "../src/core/usage-cost.js";

function createAssistantMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openrouter",
		model: "openai/gpt-4.1",
		usage: {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			totalTokens: 1800,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("usage cost utilities", () => {
	it("estimates cost from per-million model pricing", () => {
		const usage = createAssistantMessage().usage;
		const estimated = estimateAssistantUsageCost(usage, {
			cost: {
				input: 2,
				output: 8,
				cacheRead: 1,
				cacheWrite: 4,
			},
		});
		expect(estimated).toBeCloseTo(0.0066, 8);
	});

	it("keeps recorded cost when it is already available", () => {
		const message = createAssistantMessage({
			usage: {
				...createAssistantMessage().usage,
				cost: {
					input: 0.001,
					output: 0.002,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.003,
				},
			},
		});
		const resolved = resolveAssistantCostWithOpenRouterFallback(message, () => {
			throw new Error("resolveModel must not be called when recorded cost exists");
		});
		expect(resolved).toBeCloseTo(0.003, 8);
	});

	it("uses OpenRouter fallback estimation when recorded cost is zero", () => {
		const message = createAssistantMessage();
		const resolved = resolveAssistantCostWithOpenRouterFallback(message, () => ({
			id: "openai/gpt-4.1",
			name: "GPT-4.1",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 2,
				output: 8,
				cacheRead: 1,
				cacheWrite: 4,
			},
			contextWindow: 200000,
			maxTokens: 32768,
		}));
		expect(resolved).toBeCloseTo(0.0066, 8);
	});

	it("does not fallback for non-openrouter providers", () => {
		const message = createAssistantMessage({ provider: "openai" });
		const resolved = resolveAssistantCostWithOpenRouterFallback(message, () => ({
			cost: {
				input: 2,
				output: 8,
				cacheRead: 1,
				cacheWrite: 4,
			},
		} as any));
		expect(resolved).toBe(0);
	});
});

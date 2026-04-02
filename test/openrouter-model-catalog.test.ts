import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOpenRouterProviderConfig } from "../src/core/openrouter-model-catalog.js";

describe("openrouter model catalog", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("prefers /models/user when API key is provided", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(init?.headers).toMatchObject({
				Accept: "application/json",
				Authorization: "Bearer sk-or-v1-test",
			});
			expect(url).toContain("/api/v1/models/user");
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "openai/gpt-4.1",
							name: "GPT-4.1",
							pricing: {
								prompt: "0.000002",
								completion: "0.000008",
								input_cache_read: "0.000001",
								input_cache_write: "0.000004",
							},
							context_length: 200000,
							architecture: {
								modality: "text+image->text",
								input_modalities: ["text", "image"],
							},
							top_provider: { max_completion_tokens: 32768 },
							supported_parameters: ["temperature", "reasoning"],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const config = await loadOpenRouterProviderConfig({
			apiKey: "sk-or-v1-test",
			timeoutMs: 2000,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(config).toEqual({
			baseUrl: "https://openrouter.ai/api/v1",
			models: [
				{
					id: "openai/gpt-4.1",
					name: "GPT-4.1",
					api: "openai-completions",
					reasoning: true,
					input: ["text", "image"],
					cost: {
						input: 2,
						output: 8,
						cacheRead: 1,
						cacheWrite: 4,
					},
					contextWindow: 200000,
					maxTokens: 32768,
				},
			],
		});
	});

	it("falls back to /models when /models/user fails", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/models/user")) {
				return new Response("unauthorized", { status: 401 });
			}
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "anthropic/claude-sonnet-4",
							pricing: {
								prompt: "0.000003",
								completion: "0.000015",
							},
							context_length: 100000,
							top_provider: { max_completion_tokens: 8192 },
							supported_parameters: ["temperature"],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const config = await loadOpenRouterProviderConfig({
			apiKey: "sk-or-v1-test",
			timeoutMs: 2000,
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).toContain("/api/v1/models/user");
		expect(String(fetchMock.mock.calls[1]?.[0] ?? "")).toContain("/api/v1/models");
		expect(config?.models).toEqual([
			{
				id: "anthropic/claude-sonnet-4",
				name: "anthropic/claude-sonnet-4",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: {
					input: 3,
					output: 15,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: 100000,
				maxTokens: 8192,
			},
		]);
	});

	it("converts tiny per-token prices to non-zero per-million pricing", async () => {
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "kwaipilot/kat-coder-pro-v2",
							pricing: {
								prompt: "0.0000003",
								completion: "0.0000012",
								input_cache_read: "0.00000006",
							},
							context_length: 128000,
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const config = await loadOpenRouterProviderConfig({ timeoutMs: 2000 });

		expect(config?.models[0]?.cost).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0,
		});
	});

	it("returns undefined when catalog endpoints are unavailable", async () => {
		const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
		globalThis.fetch = fetchMock as typeof globalThis.fetch;

		const config = await loadOpenRouterProviderConfig({ timeoutMs: 2000 });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(config).toBeUndefined();
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createWebSearchTool,
	DEFAULT_WEB_SEARCH_MAX_RESULTS,
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
} from "../src/core/tools/web-search.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("web_search tool", () => {
	const originalTavily = process.env.TAVILY_API_KEY;
	const originalSearxng = process.env.IOSM_WEB_SEARCH_SEARXNG_URL;
	const originalLegacySearxng = process.env.PI_WEB_SEARCH_SEARXNG_URL;

	beforeEach(() => {
		delete process.env.TAVILY_API_KEY;
		delete process.env.IOSM_WEB_SEARCH_SEARXNG_URL;
		delete process.env.PI_WEB_SEARCH_SEARXNG_URL;
	});

	afterEach(() => {
		if (originalTavily === undefined) delete process.env.TAVILY_API_KEY;
		else process.env.TAVILY_API_KEY = originalTavily;
		if (originalSearxng === undefined) delete process.env.IOSM_WEB_SEARCH_SEARXNG_URL;
		else process.env.IOSM_WEB_SEARCH_SEARXNG_URL = originalSearxng;
		if (originalLegacySearxng === undefined) delete process.env.PI_WEB_SEARCH_SEARXNG_URL;
		else process.env.PI_WEB_SEARCH_SEARXNG_URL = originalLegacySearxng;
	});

	it("uses Tavily when key is configured and normalizes results", async () => {
		process.env.TAVILY_API_KEY = "test-key";

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("api.tavily.com/search");
			return jsonResponse({
				results: [
					{
						title: "Result A",
						url: "https://example.com/a",
						content: "Snippet A",
					},
				],
			});
		});

		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		const result = await tool.execute("ws-1", { query: "iosm cli" });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(output).toContain("Result A");
		expect(output).toContain("https://example.com/a");
		expect(result.details?.provider).toBe("tavily");
		expect(result.details?.maxResults).toBe(DEFAULT_WEB_SEARCH_MAX_RESULTS);
		expect(result.details?.timeoutSeconds).toBe(DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS);
		expect(result.details?.attempts[0]?.status).toBe("success");
	});

	it("uses Tavily key resolver when key is configured in settings", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const payload = init?.body ? JSON.parse(String(init.body)) : {};
			expect(payload.api_key).toBe("settings-key");
			return jsonResponse({
				results: [{ title: "Result", url: "https://example.com/settings-key", content: "ok" }],
			});
		});

		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
			resolveTavilyApiKey: () => "settings-key",
		});
		const result = await tool.execute("ws-settings-key", { query: "settings key" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.details?.provider).toBe("tavily");
	});

	it("falls back to SearXNG when Tavily key is missing", async () => {
		process.env.IOSM_WEB_SEARCH_SEARXNG_URL = "https://searx.example";

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("searx.example/search");
			return jsonResponse({
				results: [
					{
						title: "Searx Result",
						url: "https://docs.example.dev/guide",
						content: "Searx snippet",
						engine: "searxng",
					},
				],
			});
		});

		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		const result = await tool.execute("ws-2", { query: "structured search" });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.details?.provider).toBe("searxng");
		expect(result.details?.attempts[0]?.provider).toBe("tavily");
		expect(result.details?.attempts[0]?.status).toBe("skipped");
		expect(output).toContain("Searx Result");
	});

	it("uses SearXNG URL resolver when configured in settings", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			expect(url).toContain("searx.settings/search");
			return jsonResponse({
				results: [{ title: "Settings Searx", url: "https://example.com/searx", content: "ok", engine: "searxng" }],
			});
		});

		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
			resolveSearxngBaseUrl: () => "https://searx.settings",
		});
		const result = await tool.execute("ws-settings-searx", { query: "settings searx" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.details?.provider).toBe("searxng");
	});

	it("falls back to DuckDuckGo when Tavily errors and SearXNG is empty", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		process.env.IOSM_WEB_SEARCH_SEARXNG_URL = "https://searx.example";

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("api.tavily.com/search")) {
				return new Response("upstream error", { status: 502 });
			}
			if (url.includes("searx.example/search")) {
				return jsonResponse({ results: [] });
			}
			if (url.includes("duckduckgo.com/html")) {
				return new Response(
					`<html><body><a class="result__a" href="https://duck.example/path">Duck Title</a><div class="result__snippet">Duck snippet</div></body></html>`,
					{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		const result = await tool.execute("ws-3", { query: "fallback chain" });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.details?.provider).toBe("duckduckgo");
		expect(result.details?.attempts.map((a: { status: string }) => a.status)).toEqual(["error", "empty", "success"]);
		expect(output).toContain("Duck Title");
	});

	it("respects fallback mode none and returns provider trace on failure", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
			resolveRuntimeConfig: () => ({
				providerMode: "auto",
				fallbackMode: "none",
			}),
		});

		await expect(tool.execute("ws-4", { query: "no fallback" })).rejects.toThrow(/Attempts:/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("supports provider mode tavily and still falls back when Tavily key is missing", async () => {
		process.env.IOSM_WEB_SEARCH_SEARXNG_URL = "https://searx.example";
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				results: [{ title: "Fallback result", url: "https://example.com/fallback", content: "ok" }],
			}),
		);
		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
			resolveRuntimeConfig: () => ({
				providerMode: "tavily",
				fallbackMode: "searxng_only",
			}),
		});

		const result = await tool.execute("ws-4b", { query: "provider mode test" });
		expect(result.details?.provider).toBe("searxng");
		expect(result.details?.attempts[0]?.provider).toBe("tavily");
		expect(result.details?.attempts[0]?.status).toBe("error");
	});

	it("applies domain filters, max_results and safe-search mapping for SearXNG", async () => {
		process.env.IOSM_WEB_SEARCH_SEARXNG_URL = "https://searx.example";
		let requestedUrl = "";

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return jsonResponse({
				results: [
					{ title: "Main domain", url: "https://example.com/a", content: "A" },
					{ title: "Excluded subdomain", url: "https://sub.example.com/b", content: "B" },
					{ title: "Other domain", url: "https://other.com/c", content: "C" },
				],
			});
		});

		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
			resolveRuntimeConfig: () => ({
				safeSearch: "strict",
			}),
		});
		const result = await tool.execute("ws-5", {
			query: "filters",
			max_results: 1,
			include_domains: ["example.com", "other.com"],
			exclude_domains: ["sub.example.com"],
		});
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		const parsedUrl = new URL(requestedUrl);
		expect(parsedUrl.searchParams.get("safesearch")).toBe("2");
		expect(result.details?.provider).toBe("searxng");
		expect(result.details?.attempts[1]?.resultCount).toBe(1);
		expect(output).toContain("Main domain");
		expect(output).not.toContain("Excluded subdomain");
		expect(output).not.toContain("Other domain");
	});

	it("enforces permission guard", async () => {
		process.env.TAVILY_API_KEY = "test-key";
		const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
		const tool = createWebSearchTool(process.cwd(), {
			fetchImpl: fetchMock as unknown as typeof fetch,
			permissionGuard: async () => false,
		});

		await expect(tool.execute("ws-6", { query: "blocked" })).rejects.toThrow(/Permission denied/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

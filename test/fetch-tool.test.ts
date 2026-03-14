import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFetchTool, getAllowedFetchMethodsForProfile } from "../src/core/tools/fetch.js";
import { createReadOnlyTools } from "../src/core/tools/index.js";

function largeText(size: number): string {
	return "x".repeat(size);
}

describe("fetch tool", () => {
	let server: ReturnType<typeof createServer>;
	let baseUrl = "";

	beforeEach(async () => {
		server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			const path = req.url ?? "/";
			if (path === "/text") {
				res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
				res.end("hello from fetch tool");
				return;
			}
			if (path === "/json") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, value: 42 }));
				return;
			}
			if (path === "/invalid-json") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{invalid");
				return;
			}
			if (path === "/redirect") {
				res.writeHead(302, { location: "/text" });
				res.end();
				return;
			}
			if (path === "/redirect-loop") {
				res.writeHead(302, { location: "/redirect-loop" });
				res.end();
				return;
			}
			if (path === "/large") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(largeText(1024 * 4));
				return;
			}
			if (path === "/echo-method") {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(req.method ?? "UNKNOWN");
				return;
			}

			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	it("formats text response in auto mode", async () => {
		const tool = createFetchTool(process.cwd());
		const result = await tool.execute("fetch-1", { url: `${baseUrl}/text` });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(output).toContain("HTTP 200");
		expect(output).toContain("hello from fetch tool");
		expect(result.details?.responseFormat).toBe("text");
	});

	it("formats json response in auto mode when content-type is json", async () => {
		const tool = createFetchTool(process.cwd());
		const result = await tool.execute("fetch-2", { url: `${baseUrl}/json` });
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(output).toContain("\"ok\": true");
		expect(output).toContain("\"value\": 42");
		expect(result.details?.responseFormat).toBe("json");
	});

	it("throws when response_format=json but body is invalid json", async () => {
		const tool = createFetchTool(process.cwd());
		await expect(
			tool.execute("fetch-3", {
				url: `${baseUrl}/invalid-json`,
				response_format: "json",
			}),
		).rejects.toThrow(/not valid JSON/i);
	});

	it("follows redirects up to max_redirects", async () => {
		const tool = createFetchTool(process.cwd());
		const result = await tool.execute("fetch-4", {
			url: `${baseUrl}/redirect`,
			max_redirects: 3,
		});
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(output).toContain("hello from fetch tool");
		expect(result.details?.redirectsFollowed).toBe(1);
	});

	it("fails when redirect limit is exceeded", async () => {
		const tool = createFetchTool(process.cwd());
		await expect(
			tool.execute("fetch-5", {
				url: `${baseUrl}/redirect-loop`,
				max_redirects: 1,
			}),
		).rejects.toThrow(/Redirect limit exceeded/);
	});

	it("limits response body capture to max_bytes", async () => {
		const tool = createFetchTool(process.cwd());
		const result = await tool.execute("fetch-6", {
			url: `${baseUrl}/large`,
			max_bytes: 64,
		});
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(output).toContain("response body truncated");
		expect(result.details?.bodyCaptureTruncated).toBe(true);
		expect(result.details?.maxBytes).toBe(64);
	});

	it("enforces read-only profile method policy", async () => {
		const tool = createFetchTool(process.cwd(), {
			resolveAllowedMethods: () => getAllowedFetchMethodsForProfile("plan"),
		});
		await expect(
			tool.execute("fetch-7", {
				url: `${baseUrl}/echo-method`,
				method: "POST",
				body: "blocked",
			}),
		).rejects.toThrow(/not allowed in the current profile/i);
	});

	it("allows unsafe methods in write-capable profile", async () => {
		const tool = createFetchTool(process.cwd(), {
			resolveAllowedMethods: () => getAllowedFetchMethodsForProfile("full"),
		});
		const result = await tool.execute("fetch-8", {
			url: `${baseUrl}/echo-method`,
			method: "POST",
			body: "ok",
		});
		const output = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(output).toContain("POST");
	});

	it("enforces safe methods in createReadOnlyTools bundle", async () => {
		const tools = createReadOnlyTools(process.cwd());
		const fetch = tools.find((tool) => tool.name === "fetch");
		expect(fetch).toBeDefined();
		await expect(
			fetch!.execute("fetch-9", {
				url: `${baseUrl}/echo-method`,
				method: "POST",
				body: "blocked",
			}),
		).rejects.toThrow(/not allowed in the current profile/i);
	});
});

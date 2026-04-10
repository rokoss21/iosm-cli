import { describe, expect, it } from "vitest";
import { createToolSearchTool } from "../src/core/tools/tool-search.js";
import { createToolSuggestTool } from "../src/core/tools/tool-suggest.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("tool_search and tool_suggest tools", () => {
	const catalog = [
		{ name: "apply_patch", description: "Apply structured multi-file patches", active: true },
		{ name: "edit", description: "Edit a file by replacing text", active: true },
		{ name: "write", description: "Write full file content", active: false },
		{ name: "fetch", description: "HTTP request tool", active: true },
	];

	it("tool_search ranks name matches first and can filter inactive tools", async () => {
		const tool = createToolSearchTool({
			resolveCatalog: () => catalog,
		});

		const result = await tool.execute("tool-search-1", {
			query: "patch",
			includeInactive: false,
			limit: 10,
		});

		const text = getText(result);
		expect(text).toContain("- apply_patch [active]");
		expect(text).not.toContain("write [inactive]");
	});

	it("tool_suggest recommends apply_patch for patch-heavy tasks", async () => {
		const tool = createToolSuggestTool({
			resolveCatalog: () => catalog,
		});

		const result = await tool.execute("tool-suggest-1", {
			task: "Need to patch many files from a single diff",
			limit: 3,
		});

		const text = getText(result);
		expect(text).toContain("1. apply_patch [active]");
	});

	it("returns a fallback message when no tools can be suggested", async () => {
		const tool = createToolSuggestTool({
			resolveCatalog: () => [],
		});

		const result = await tool.execute("tool-suggest-2", {
			task: "mystery task",
		});

		expect(getText(result)).toContain("No strong tool suggestion found");
	});

	it("includes cost annotation and fallback route for semantic navigation tasks", async () => {
		const tool = createToolSuggestTool({
			resolveCatalog: () => [
				{ name: "lsp", description: "Language Server Protocol navigation", active: true },
				{ name: "ast_grep", description: "AST structural search", active: true },
				{ name: "rg", description: "Fast regex search", active: true },
				{ name: "read", description: "Read files", active: true },
			],
		});

		const result = await tool.execute("tool-suggest-3", {
			task: "Find definition and references for this symbol",
			limit: 4,
		});

		const text = getText(result);
		expect(text).toContain("lsp [active] (cost:3)");
		expect(text).toContain("Fallback route:");
		expect(text).toContain("Detected intents: search, semantic");
	});
});

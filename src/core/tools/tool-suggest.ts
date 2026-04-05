import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolSearchCatalogEntry } from "./tool-search.js";

export interface ToolSuggestOptions {
	resolveCatalog?: () => ToolSearchCatalogEntry[];
}

const toolSuggestSchema = Type.Object({
	task: Type.String({ description: "Describe the task to get the most relevant tools." }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of tool suggestions (default 5)." })),
});

export type ToolSuggestInput = Static<typeof toolSuggestSchema>;

const KEYWORD_TOOL_HINTS: Array<{ keywords: string[]; tools: string[] }> = [
	{ keywords: ["patch", "diff", "bulk", "hunk"], tools: ["apply_patch", "edit", "git_read"] },
	{ keywords: ["search", "find", "grep", "pattern"], tools: ["tool_search", "grep", "rg", "find"] },
	{ keywords: ["http", "api", "request", "endpoint", "url"], tools: ["fetch", "web_search"] },
	{ keywords: ["test", "unit", "integration", "spec"], tools: ["test_run", "lint_run", "typecheck_run"] },
	{ keywords: ["git", "branch", "commit", "stash", "push"], tools: ["git_read", "git_write"] },
	{ keywords: ["database", "sql", "query", "migration"], tools: ["db_run"] },
	{ keywords: ["file", "rename", "move", "copy", "delete"], tools: ["fs_ops", "write", "edit"] },
	{ keywords: ["command", "shell", "terminal", "repl"], tools: ["bash"] },
];

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter((token) => token.length > 0);
}

function scoreByText(entry: ToolSearchCatalogEntry, tokens: string[]): number {
	const haystack = `${entry.name} ${entry.description ?? ""}`.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (entry.name.toLowerCase() === token) score += 40;
		if (entry.name.toLowerCase().startsWith(token)) score += 22;
		if (haystack.includes(token)) score += 10;
	}
	if (entry.active) score += 3;
	return score;
}

function scoreByHints(entry: ToolSearchCatalogEntry, tokens: string[]): number {
	let score = 0;
	for (const hint of KEYWORD_TOOL_HINTS) {
		const matched = hint.keywords.some((keyword) => tokens.includes(keyword));
		if (!matched) continue;
		if (hint.tools.includes(entry.name)) {
			score += 35;
		}
	}
	return score;
}

const DEFAULT_CATALOG: ToolSearchCatalogEntry[] = [];

export function createToolSuggestTool(options?: ToolSuggestOptions): AgentTool<typeof toolSuggestSchema> {
	return {
		name: "tool_suggest",
		label: "tool_suggest",
		description: "Suggest the best tools for a described task, ranking by task keywords and available tool metadata.",
		parameters: toolSuggestSchema,
		execute: async (_toolCallId: string, input: ToolSuggestInput) => {
			const task = input.task.trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "Provide a non-empty task description." }],
					details: { count: 0 },
				};
			}

			const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 5)));
			const tokens = tokenize(task);
			const catalog = options?.resolveCatalog?.() ?? DEFAULT_CATALOG;

			const ranked = catalog
				.map((entry) => ({
					entry,
					score: scoreByText(entry, tokens) + scoreByHints(entry, tokens),
				}))
				.filter((item) => item.score > 0)
				.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
				.slice(0, limit);

			if (ranked.length === 0) {
				return {
					content: [{ type: "text", text: "No strong tool suggestion found. Use tool_search to explore available tools." }],
					details: { count: 0 },
				};
			}

			const lines = ranked.map(({ entry }, idx) => {
				const status = entry.active ? "active" : "inactive";
				const desc = entry.description?.trim() ? ` - ${entry.description.trim()}` : "";
				return `${idx + 1}. ${entry.name} [${status}]${desc}`;
			});

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: ranked.length },
			};
		},
	};
}

export const toolSuggestTool = createToolSuggestTool();

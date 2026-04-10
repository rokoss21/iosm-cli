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

interface KeywordHint {
	keywords: string[];
	tools: string[];
	routeLabel: string;
}

const KEYWORD_TOOL_HINTS: KeywordHint[] = [
	{
		keywords: ["patch", "diff", "bulk", "hunk", "refactor"],
		tools: ["apply_patch", "edit", "git_read"],
		routeLabel: "patch",
	},
	{
		keywords: ["search", "find", "grep", "pattern", "match"],
		tools: ["rg", "grep", "find", "tool_search"],
		routeLabel: "search",
	},
	{
		keywords: ["definition", "reference", "hover", "symbol", "rename", "lsp"],
		tools: ["lsp", "ast_grep", "rg", "read"],
		routeLabel: "semantic",
	},
	{
		keywords: ["http", "api", "request", "endpoint", "url", "web"],
		tools: ["web_search", "fetch"],
		routeLabel: "web",
	},
	{
		keywords: ["test", "unit", "integration", "spec", "verify", "verification", "lint", "typecheck"],
		tools: ["lint_run", "typecheck_run", "test_run"],
		routeLabel: "verification",
	},
	{
		keywords: ["git", "branch", "commit", "stash", "push", "pull", "merge"],
		tools: ["git_read", "git_write"],
		routeLabel: "git",
	},
	{
		keywords: ["database", "sql", "query", "migration", "schema"],
		tools: ["db_run"],
		routeLabel: "database",
	},
	{
		keywords: ["file", "rename", "move", "copy", "delete", "directory"],
		tools: ["fs_ops", "edit", "apply_patch", "write"],
		routeLabel: "filesystem",
	},
	{
		keywords: ["command", "shell", "terminal", "repl"],
		tools: ["bash"],
		routeLabel: "shell",
	},
];

const TOOL_COST_TIER: Record<string, number> = {
	read: 1,
	rg: 1,
	fd: 1,
	grep: 1,
	find: 1,
	ls: 1,
	apply_patch: 2,
	ast_grep: 2,
	comby: 2,
	jq: 2,
	yq: 2,
	git_read: 2,
	write: 4,
	lsp: 3,
	fetch: 3,
	web_search: 4,
	semantic_search: 5,
	test_run: 3,
	lint_run: 2,
	typecheck_run: 3,
	db_run: 4,
	task: 8,
};

const SOFT_FALLBACKS: Record<string, string[]> = {
	lsp: ["ast_grep", "rg", "read"],
	semantic_search: ["rg", "ast_grep", "lsp", "read"],
	ast_grep: ["rg", "read"],
	comby: ["ast_grep", "rg", "read"],
	rg: ["ast_grep", "read"],
	web_search: ["fetch"],
	fetch: ["web_search"],
	test_run: ["typecheck_run", "lint_run"],
	typecheck_run: ["lint_run", "test_run"],
	git_write: ["git_read"],
	db_run: ["read"],
	task: ["todo_read", "todo_write"],
};

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

function scoreByHints(entry: ToolSearchCatalogEntry, tokens: string[]): { score: number; matchedRoutes: string[] } {
	let score = 0;
	const matchedRoutes: string[] = [];
	for (const hint of KEYWORD_TOOL_HINTS) {
		const matchCount = hint.keywords.reduce((count, keyword) => (tokens.includes(keyword) ? count + 1 : count), 0);
		if (matchCount === 0) continue;
		matchedRoutes.push(hint.routeLabel);
		const index = hint.tools.indexOf(entry.name);
		if (index !== -1) {
			// Earlier tools in an intent route should win against generic low-cost tools.
			const positionBoost = Math.max(12, 36 - index * 8);
			score += positionBoost * matchCount;
		}
	}
	return { score, matchedRoutes };
}

function scoreByCost(entry: ToolSearchCatalogEntry): number {
	const tier = TOOL_COST_TIER[entry.name] ?? 3;
	// Lower-cost tools receive a small preference when precision score is tied.
	return Math.max(0, 5 - tier);
}

function buildFallbackRoute(primaryTool: string, catalog: ToolSearchCatalogEntry[]): string[] {
	const activeTools = new Set(catalog.filter((entry) => entry.active).map((entry) => entry.name));
	const candidates = SOFT_FALLBACKS[primaryTool] ?? [];
	return candidates.filter((name) => activeTools.has(name));
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

				const matchedRouteSet = new Set<string>();
				const ranked = catalog
					.map((entry) => ({
						entry,
						score: (() => {
							const hintScore = scoreByHints(entry, tokens);
							for (const route of hintScore.matchedRoutes) {
								matchedRouteSet.add(route);
							}
							return scoreByText(entry, tokens) + hintScore.score + scoreByCost(entry);
						})(),
					}))
					.filter((item) => item.score > 0)
					.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
					.slice(0, limit);

				if (ranked.length === 0) {
					return {
						content: [{ type: "text", text: "No strong tool suggestion found. Use tool_search to explore available tools." }],
						details: { count: 0, routes: [] },
					};
				}

				const lines = ranked.map(({ entry }, idx) => {
					const status = entry.active ? "active" : "inactive";
					const desc = entry.description?.trim() ? ` - ${entry.description.trim()}` : "";
					const tier = TOOL_COST_TIER[entry.name];
					const cost = Number.isFinite(tier) ? ` (cost:${tier})` : "";
					return `${idx + 1}. ${entry.name} [${status}]${cost}${desc}`;
				});
				const primary = ranked[0]?.entry.name;
				const fallbackRoute = primary ? buildFallbackRoute(primary, catalog) : [];
				if (fallbackRoute.length > 0) {
					lines.push(`Fallback route: ${primary} -> ${fallbackRoute.join(" -> ")}`);
				}
				const matchedRoutes = [...matchedRouteSet];
				if (matchedRoutes.length > 0) {
					lines.push(`Detected intents: ${matchedRoutes.join(", ")}`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { count: ranked.length, primary, fallbackRoute, routes: matchedRoutes },
				};
			},
		};
}

export const toolSuggestTool = createToolSuggestTool();

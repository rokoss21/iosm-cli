import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

export interface ToolSearchCatalogEntry {
	name: string;
	description?: string;
	active?: boolean;
}

export interface ToolSearchOptions {
	resolveCatalog?: () => ToolSearchCatalogEntry[];
}

const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for tool names or descriptions." }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default 10)." })),
	includeInactive: Type.Optional(Type.Boolean({ description: "Include inactive tools in results (default true)." })),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9_]+/g)
		.filter((token) => token.length > 0);
}

function scoreEntry(entry: ToolSearchCatalogEntry, query: string, queryTokens: string[]): number {
	const name = entry.name.toLowerCase();
	const description = (entry.description ?? "").toLowerCase();

	let score = 0;
	if (name === query) score += 120;
	if (name.startsWith(query)) score += 80;
	if (name.includes(query)) score += 50;
	if (description.includes(query)) score += 35;

	for (const token of queryTokens) {
		if (name === token) score += 35;
		if (name.startsWith(token)) score += 20;
		if (name.includes(token)) score += 12;
		if (description.includes(token)) score += 8;
	}

	if (entry.active) score += 2;
	return score;
}

const DEFAULT_CATALOG: ToolSearchCatalogEntry[] = [];

export function createToolSearchTool(options?: ToolSearchOptions): AgentTool<typeof toolSearchSchema> {
	return {
		name: "tool_search",
		label: "tool_search",
		description: "Search available tools by name/description and return ranked matches with active/inactive status.",
		parameters: toolSearchSchema,
		execute: async (_toolCallId: string, input: ToolSearchInput) => {
			const query = input.query.trim().toLowerCase();
			if (!query) {
				return {
					content: [{ type: "text", text: "Provide a non-empty search query." }],
					details: { count: 0 },
				};
			}

			const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10)));
			const includeInactive = input.includeInactive ?? true;
			const catalog = (options?.resolveCatalog?.() ?? DEFAULT_CATALOG).filter(
				(entry) => includeInactive || entry.active === true,
			);

			const queryTokens = tokenize(query);
			const ranked = catalog
				.map((entry) => ({
					entry,
					score: scoreEntry(entry, query, queryTokens),
				}))
				.filter((item) => item.score > 0)
				.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
				.slice(0, limit);

			if (ranked.length === 0) {
				return {
					content: [{ type: "text", text: `No tools matched "${input.query}".` }],
					details: { count: 0 },
				};
			}

			const lines = ranked.map(({ entry }) => {
				const status = entry.active ? "active" : "inactive";
				const desc = entry.description?.trim() ? ` - ${entry.description.trim()}` : "";
				return `- ${entry.name} [${status}]${desc}`;
			});

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: ranked.length },
			};
		},
	};
}

export const toolSearchTool = createToolSearchTool();

import { describe, expect, it } from "vitest";
import { AGENT_PROFILES } from "../src/core/agent-profiles.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { allTools, createAllTools, readOnlyTools } from "../src/core/tools/index.js";

describe("semantic integration regressions", () => {
	it("registers semantic_search in built-in tool registries", () => {
		expect("semantic_search" in allTools).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "semantic_search")).toBe(true);
		const perCwdTools = createAllTools(process.cwd());
		expect("semantic_search" in perCwdTools).toBe(true);
	});

	it("exposes /semantic and /singular in slash commands", () => {
		const slashNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(slashNames).toContain("semantic");
		expect(slashNames).toContain("singular");
		expect(slashNames).not.toContain("shadow");
	});

	it("enables semantic_search in full/meta/explore/iosm profiles", () => {
		expect(AGENT_PROFILES.full.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.meta.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.explore.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.iosm.tools).toContain("semantic_search");
	});
});

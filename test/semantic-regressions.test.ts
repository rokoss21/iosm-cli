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

	it("registers fetch/web_search/git_read/git_write/fs_ops in the expected tool registries", () => {
		expect("fetch" in allTools).toBe(true);
		expect("web_search" in allTools).toBe(true);
		expect("git_read" in allTools).toBe(true);
		expect("git_write" in allTools).toBe(true);
		expect("fs_ops" in allTools).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "fetch")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "web_search")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "git_read")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "git_write")).toBe(false);
		expect(readOnlyTools.some((tool) => tool.name === "fs_ops")).toBe(false);
		const perCwdTools = createAllTools(process.cwd());
		expect("fetch" in perCwdTools).toBe(true);
		expect("web_search" in perCwdTools).toBe(true);
		expect("git_read" in perCwdTools).toBe(true);
		expect("git_write" in perCwdTools).toBe(true);
		expect("fs_ops" in perCwdTools).toBe(true);
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

	it("enables fetch/web_search/git_read in read-only profiles and git_write/fs_ops in write profiles", () => {
		expect(AGENT_PROFILES.explore.tools).toContain("fetch");
		expect(AGENT_PROFILES.explore.tools).toContain("web_search");
		expect(AGENT_PROFILES.explore.tools).toContain("git_read");
		expect(AGENT_PROFILES.explore.tools).not.toContain("git_write");
		expect(AGENT_PROFILES.explore.tools).not.toContain("fs_ops");

		expect(AGENT_PROFILES.plan.tools).toContain("fetch");
		expect(AGENT_PROFILES.plan.tools).toContain("web_search");
		expect(AGENT_PROFILES.plan.tools).toContain("git_read");
		expect(AGENT_PROFILES.plan.tools).not.toContain("git_write");
		expect(AGENT_PROFILES.plan.tools).not.toContain("fs_ops");

		expect(AGENT_PROFILES.full.tools).toContain("git_write");
		expect(AGENT_PROFILES.meta.tools).toContain("git_write");
		expect(AGENT_PROFILES.iosm.tools).toContain("git_write");
		expect(AGENT_PROFILES.full.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.meta.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.iosm.tools).toContain("fs_ops");
	});
});

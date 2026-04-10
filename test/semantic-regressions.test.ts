import { describe, expect, it } from "vitest";
import { AGENT_PROFILES } from "../src/core/agent-profiles.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import { allTools, createAllTools, readOnlyTools } from "../src/core/tools/index.js";

describe("semantic integration regressions", () => {
	it("registers semantic_search and lsp in built-in tool registries", () => {
		expect("semantic_search" in allTools).toBe(true);
		expect("lsp" in allTools).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "semantic_search")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "lsp")).toBe(true);
		const perCwdTools = createAllTools(process.cwd());
		expect("semantic_search" in perCwdTools).toBe(true);
		expect("lsp" in perCwdTools).toBe(true);
	});

	it("registers fetch/web_search/git_read/git_write/fs_ops/test/lint/typecheck/db tools in the expected registries", () => {
		expect("fetch" in allTools).toBe(true);
		expect("web_search" in allTools).toBe(true);
		expect("git_read" in allTools).toBe(true);
		expect("git_write" in allTools).toBe(true);
		expect("fs_ops" in allTools).toBe(true);
		expect("test_run" in allTools).toBe(true);
		expect("lint_run" in allTools).toBe(true);
		expect("typecheck_run" in allTools).toBe(true);
		expect("db_run" in allTools).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "fetch")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "web_search")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "git_read")).toBe(true);
		expect(readOnlyTools.some((tool) => tool.name === "git_write")).toBe(false);
		expect(readOnlyTools.some((tool) => tool.name === "fs_ops")).toBe(false);
		expect(readOnlyTools.some((tool) => tool.name === "test_run")).toBe(false);
		expect(readOnlyTools.some((tool) => tool.name === "lint_run")).toBe(false);
		expect(readOnlyTools.some((tool) => tool.name === "typecheck_run")).toBe(false);
		expect(readOnlyTools.some((tool) => tool.name === "db_run")).toBe(false);
		const perCwdTools = createAllTools(process.cwd());
		expect("fetch" in perCwdTools).toBe(true);
		expect("web_search" in perCwdTools).toBe(true);
		expect("git_read" in perCwdTools).toBe(true);
		expect("git_write" in perCwdTools).toBe(true);
		expect("fs_ops" in perCwdTools).toBe(true);
		expect("test_run" in perCwdTools).toBe(true);
		expect("lint_run" in perCwdTools).toBe(true);
		expect("typecheck_run" in perCwdTools).toBe(true);
		expect("db_run" in perCwdTools).toBe(true);
	});

	it("exposes /semantic, /singular, and /ultrathink in slash commands", () => {
		const slashNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);
		expect(slashNames).toContain("semantic");
		expect(slashNames).toContain("singular");
		expect(slashNames).toContain("ultrathink");
		expect(slashNames).not.toContain("shadow");
	});

	it("enables semantic_search and lsp in full/meta/explore/iosm profiles", () => {
		expect(AGENT_PROFILES.full.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.meta.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.explore.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.iosm.tools).toContain("semantic_search");
		expect(AGENT_PROFILES.full.tools).toContain("lsp");
		expect(AGENT_PROFILES.meta.tools).toContain("lsp");
		expect(AGENT_PROFILES.explore.tools).toContain("lsp");
		expect(AGENT_PROFILES.iosm.tools).toContain("lsp");
	});

	it("enables fetch/web_search/git_read in read-only profiles and structured engineering tools in write profiles", () => {
		expect(AGENT_PROFILES.explore.tools).toContain("fetch");
		expect(AGENT_PROFILES.explore.tools).toContain("web_search");
		expect(AGENT_PROFILES.explore.tools).toContain("git_read");
		expect(AGENT_PROFILES.explore.tools).toContain("lsp");
		expect(AGENT_PROFILES.explore.tools).not.toContain("git_write");
		expect(AGENT_PROFILES.explore.tools).not.toContain("fs_ops");
		expect(AGENT_PROFILES.explore.tools).not.toContain("test_run");
		expect(AGENT_PROFILES.explore.tools).not.toContain("lint_run");
		expect(AGENT_PROFILES.explore.tools).not.toContain("typecheck_run");
		expect(AGENT_PROFILES.explore.tools).not.toContain("db_run");

		expect(AGENT_PROFILES.plan.tools).toContain("fetch");
		expect(AGENT_PROFILES.plan.tools).toContain("web_search");
		expect(AGENT_PROFILES.plan.tools).toContain("git_read");
		expect(AGENT_PROFILES.plan.tools).toContain("lsp");
		expect(AGENT_PROFILES.plan.tools).not.toContain("git_write");
		expect(AGENT_PROFILES.plan.tools).not.toContain("fs_ops");
		expect(AGENT_PROFILES.plan.tools).not.toContain("test_run");
		expect(AGENT_PROFILES.plan.tools).not.toContain("lint_run");
		expect(AGENT_PROFILES.plan.tools).not.toContain("typecheck_run");
		expect(AGENT_PROFILES.plan.tools).not.toContain("db_run");

		expect(AGENT_PROFILES.full.tools).toContain("git_write");
		expect(AGENT_PROFILES.meta.tools).toContain("git_write");
		expect(AGENT_PROFILES.iosm.tools).toContain("git_write");
		expect(AGENT_PROFILES.full.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.meta.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.iosm.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.full.tools).toContain("test_run");
		expect(AGENT_PROFILES.meta.tools).toContain("test_run");
		expect(AGENT_PROFILES.iosm.tools).toContain("test_run");
		expect(AGENT_PROFILES.full.tools).toContain("lint_run");
		expect(AGENT_PROFILES.meta.tools).toContain("lint_run");
		expect(AGENT_PROFILES.iosm.tools).toContain("lint_run");
		expect(AGENT_PROFILES.full.tools).toContain("typecheck_run");
		expect(AGENT_PROFILES.meta.tools).toContain("typecheck_run");
		expect(AGENT_PROFILES.iosm.tools).toContain("typecheck_run");
		expect(AGENT_PROFILES.full.tools).toContain("db_run");
		expect(AGENT_PROFILES.meta.tools).toContain("db_run");
		expect(AGENT_PROFILES.iosm.tools).toContain("db_run");
		expect(AGENT_PROFILES.iosm_verifier.tools).toContain("typecheck_run");
		expect(AGENT_PROFILES.iosm_verifier.tools).not.toContain("db_run");
	});
});

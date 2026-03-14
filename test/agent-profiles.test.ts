import { describe, expect, it } from "vitest";
import {
	AGENT_PROFILES,
	getAgentProfile,
	getMainProfileNames,
	isReadOnlyProfileName,
	isValidProfileName,
} from "../src/core/agent-profiles.js";

describe("agent profiles", () => {
	it("keeps full as default fallback profile", () => {
		expect(getAgentProfile(undefined).name).toBe("full");
		expect(getAgentProfile("unknown-profile").name).toBe("full");
	});

	it("registers meta profile with full-capability parity", () => {
		expect(isValidProfileName("meta")).toBe(true);
		expect(AGENT_PROFILES.meta.tools).toEqual(AGENT_PROFILES.full.tools);
		expect(AGENT_PROFILES.meta.thinkingLevel).toBe(AGENT_PROFILES.full.thinkingLevel);
		expect(AGENT_PROFILES.meta.mainMode).toBe(true);
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("bounded read-only recon");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("do not make direct write/edit changes in the main agent before launching the first task call");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain(
			"If the user requested a specific number of parallel agents or delegates",
		);
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("multiple top-level task calls");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("primary optimization target is safe parallel execution");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("single-agent execution is the exception");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain(
			"For conversational or non-repository requests",
		);
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("Do not output internal reasoning");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("only observed runtime evidence");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("mark the metric as unknown");
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("Never claim a report/file/path exists");
	});

	it("includes meta in main profile cycling order", () => {
		expect(getMainProfileNames()).toEqual(["plan", "iosm", "meta", "full"]);
	});

	it("marks read-only profiles correctly", () => {
		expect(isReadOnlyProfileName("explore")).toBe(true);
		expect(isReadOnlyProfileName("plan")).toBe(true);
		expect(isReadOnlyProfileName("iosm_analyst")).toBe(true);
		expect(isReadOnlyProfileName("meta")).toBe(false);
	});

	it("keeps fetch/git_read in read-only profiles and fs_ops in write-capable profiles", () => {
		expect(AGENT_PROFILES.explore.tools).toContain("fetch");
		expect(AGENT_PROFILES.explore.tools).toContain("git_read");
		expect(AGENT_PROFILES.explore.tools).not.toContain("fs_ops");

		expect(AGENT_PROFILES.plan.tools).toContain("fetch");
		expect(AGENT_PROFILES.plan.tools).toContain("git_read");
		expect(AGENT_PROFILES.plan.tools).not.toContain("fs_ops");

		expect(AGENT_PROFILES.iosm_analyst.tools).toContain("fetch");
		expect(AGENT_PROFILES.iosm_analyst.tools).toContain("git_read");
		expect(AGENT_PROFILES.iosm_analyst.tools).not.toContain("fs_ops");

		expect(AGENT_PROFILES.full.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.meta.tools).toContain("fs_ops");
		expect(AGENT_PROFILES.iosm.tools).toContain("fs_ops");
	});
});

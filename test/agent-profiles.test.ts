import { describe, expect, it } from "vitest";
import {
	AGENT_PROFILES,
	getAgentProfile,
	getMainProfileNames,
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
		expect(AGENT_PROFILES.meta.systemPromptAppend).toContain("if the user requested a specific number of parallel agents");
	});

	it("includes meta in main profile cycling order", () => {
		expect(getMainProfileNames()).toEqual(["plan", "iosm", "meta", "full"]);
	});
});

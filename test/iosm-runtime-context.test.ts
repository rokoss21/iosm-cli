import { describe, expect, test } from "vitest";
import { buildIosmRuntimeDirective } from "../src/iosm/runtime-context.js";

describe("buildIosmRuntimeDirective", () => {
	test("keeps IOSM metrics internal by default and guides plain user-facing replies", () => {
		const directive = buildIosmRuntimeDirective({
			userGoal: "improve search flow",
			cwd: "/tmp/project",
			shouldOrchestrate: true,
			autoInitialized: false,
			iosmIndex: 0.84,
			decisionConfidence: 0.91,
		});

		expect(directive).toContain("The IOSM runtime data above is internal execution context.");
		expect(directive).toContain("Behave like a professional, direct engineering agent in user-facing replies.");
		expect(directive).toContain("Do not volunteer IOSM metrics, indices, confidence scores, phase names, or artifact details");
		expect(directive).toContain("Explain outcomes in normal engineering language");
		expect(directive).toContain("IOSM Execution Contract: prefer minimal, surgical edits");
		expect(directive).toContain("IOSM Execution Contract: for existing files, default to edit/apply_patch");
		expect(directive).toContain("overwriteExisting=true + rewriteReason");
	});

	test("avoids forcing IOSM framing for lightweight messages", () => {
		const directive = buildIosmRuntimeDirective({
			userGoal: "thanks",
			cwd: "/tmp/project",
			shouldOrchestrate: false,
			autoInitialized: false,
		});

		expect(directive).toContain("Current message is conversational/lightweight: answer normally and briefly");
		expect(directive).not.toContain("keep IOSM identity");
	});
});

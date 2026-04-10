import { describe, expect, it } from "vitest";
import { __taskToolTestUtils } from "../src/core/tools/task.js";

describe("task worktree cleanup retry", () => {
	it("retries ENOTEMPTY failures and eventually succeeds", async () => {
		let attempts = 0;
		const telemetry: Array<{ type: string; stage: string; attempt: number }> = [];
		const ok = await __taskToolTestUtils.runCleanupStageWithRetry({
			stage: "fs_remove",
			maxAttempts: 4,
			baseDelayMs: 1,
			onTelemetry: (event) => {
				telemetry.push({ type: event.type, stage: event.stage, attempt: event.attempt });
			},
			run: () => {
				attempts += 1;
				if (attempts < 3) {
					return { ok: false as const, errorCode: "ENOTEMPTY", errorMessage: "directory not empty" };
				}
				return { ok: true as const };
			},
		});
		expect(ok).toBe(true);
		expect(telemetry.filter((entry) => entry.type === "retry")).toHaveLength(2);
		expect(telemetry.filter((entry) => entry.type === "failure")).toHaveLength(0);
	});

	it("emits terminal failure telemetry after retry budget is exhausted", async () => {
		const telemetry: Array<{ type: string; stage: string; attempt: number; errorCode?: string }> = [];
		const ok = await __taskToolTestUtils.runCleanupStageWithRetry({
			stage: "git_remove",
			maxAttempts: 3,
			baseDelayMs: 1,
			onTelemetry: (event) => {
				telemetry.push({
					type: event.type,
					stage: event.stage,
					attempt: event.attempt,
					errorCode: event.errorCode,
				});
			},
			run: () => ({ ok: false as const, errorCode: "ENOTEMPTY", errorMessage: "still locked" }),
		});
		expect(ok).toBe(false);
		expect(telemetry.filter((entry) => entry.type === "retry")).toHaveLength(2);
		expect(telemetry.filter((entry) => entry.type === "failure")).toHaveLength(1);
		expect(telemetry.at(-1)?.attempt).toBe(3);
	});
});

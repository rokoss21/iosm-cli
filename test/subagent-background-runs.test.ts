import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	appendSubagentBackgroundRunLog,
	getSubagentBackgroundRun,
	listSubagentBackgroundRuns,
	pruneSubagentBackgroundRuns,
	readSubagentBackgroundRunLogTail,
	registerSubagentBackgroundRunController,
	requestStopAllSubagentBackgroundRuns,
	requestStopSubagentBackgroundRun,
	writeSubagentBackgroundRunStatus,
} from "../src/core/subagent-background-runs.js";

describe("subagent background runs", () => {
	it("writes status, appends logs, and reads tail", () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-subagent-bg-module-"));
		try {
			const runId = "subagent_module_a";
			writeSubagentBackgroundRunStatus(cwd, {
				runId,
				status: "running",
				createdAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				description: "analyze project",
				profile: "plan",
				cwd,
			});
			appendSubagentBackgroundRunLog(cwd, runId, "line one");
			appendSubagentBackgroundRunLog(cwd, runId, "line two");

			const listed = listSubagentBackgroundRuns(cwd, 10);
			expect(listed.length).toBe(1);
			expect(listed[0]?.runId).toBe(runId);
			expect(getSubagentBackgroundRun(cwd, runId)?.status).toBe("running");
			expect(readSubagentBackgroundRunLogTail(cwd, runId, 1)).toContain("line two");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("requests stop and aborts active controller", () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-subagent-bg-stop-module-"));
		try {
			const runId = "subagent_module_stop";
			writeSubagentBackgroundRunStatus(cwd, {
				runId,
				status: "running",
				createdAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				description: "long running",
				profile: "explore",
				cwd,
			});
			const controller = new AbortController();
			registerSubagentBackgroundRunController(cwd, runId, controller);

			const updated = requestStopSubagentBackgroundRun(cwd, runId);
			expect(controller.signal.aborted).toBe(true);
			expect(updated?.requestedStopAt).toBeDefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("supports stop-all and prune", () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-subagent-bg-prune-module-"));
		try {
			writeSubagentBackgroundRunStatus(cwd, {
				runId: "subagent_module_running",
				status: "running",
				createdAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
				description: "running",
				profile: "plan",
				cwd,
			});
			writeSubagentBackgroundRunStatus(cwd, {
				runId: "subagent_module_old_done",
				status: "done",
				createdAt: "2001-01-01T00:00:00.000Z",
				startedAt: "2001-01-01T00:00:00.000Z",
				finishedAt: "2001-01-01T00:00:01.000Z",
				description: "old done",
				profile: "plan",
				cwd,
			});

			const stopAll = requestStopAllSubagentBackgroundRuns(cwd);
			expect(stopAll.requested).toBe(1);
			expect(stopAll.requestedIds).toContain("subagent_module_running");

			const prune = pruneSubagentBackgroundRuns(cwd, 1);
			expect(prune.removedIds).toContain("subagent_module_old_done");
			expect(getSubagentBackgroundRun(cwd, "subagent_module_old_done")).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

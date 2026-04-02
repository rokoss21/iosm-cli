import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getBackgroundProcess,
	listBackgroundProcesses,
	pruneBackgroundProcesses,
	readBackgroundProcessLogTail,
	startBackgroundProcess,
	stopBackgroundProcess,
	type BackgroundProcessStatus,
} from "../src/core/background-processes.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(
	rootCwd: string,
	id: string,
	targets: readonly BackgroundProcessStatus[],
	timeoutMs = 4000,
): Promise<BackgroundProcessStatus | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const status = getBackgroundProcess(rootCwd, id)?.status;
		if (status && targets.includes(status)) return status;
		await sleep(50);
	}
	return getBackgroundProcess(rootCwd, id)?.status;
}

describe("background process manager", () => {
	const tempDirs: string[] = [];

	const makeTempDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-bg-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0, tempDirs.length)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("starts a process, tracks completion, and exposes log tail", async () => {
		const root = makeTempDir();
		const record = startBackgroundProcess({
			rootCwd: root,
			command: "sleep 0.2; echo bg-done",
			source: "interactive",
		});

		expect(record.id).toMatch(/^bg_/);
		expect(record.pid).toBeGreaterThan(0);

		const finalStatus = await waitForStatus(root, record.id, ["done", "error"], 5000);
		expect(finalStatus).toBe("done");

		const refreshed = getBackgroundProcess(root, record.id);
		expect(refreshed?.exitCode).toBe(0);
		const tail = readBackgroundProcessLogTail(root, record.id, 20);
		expect(tail).toContain("bg-done");
	});

	it("stops a running process and records requested stop timestamp", async () => {
		const root = makeTempDir();
		const record = startBackgroundProcess({
			rootCwd: root,
			command: "sleep 5; echo never",
			source: "interactive",
		});
		const stopped = stopBackgroundProcess(root, record.id);
		expect(stopped).toBeDefined();
		expect(stopped?.requestedStopAt).toBeDefined();

		const statusAfterStop = await waitForStatus(root, record.id, ["terminated", "done", "error"], 3000);
		expect(["terminated", "done", "error", "unknown"]).toContain(statusAfterStop);
	});

	it("lists recent processes in reverse chronological order", async () => {
		const root = makeTempDir();
		const first = startBackgroundProcess({
			rootCwd: root,
			command: "echo first-line",
			source: "tool",
		});
		await waitForStatus(root, first.id, ["done", "error"], 3000);
		const second = startBackgroundProcess({
			rootCwd: root,
			command: "echo second-line",
			source: "tool",
		});
		await waitForStatus(root, second.id, ["done", "error"], 3000);

		const listed = listBackgroundProcesses(root, 10);
		const ids = listed.map((item) => item.id);
		expect(ids[0]).toBe(second.id);
		expect(ids).toContain(first.id);
		expect(ids).toContain(second.id);
	});

	it("writes completion markers even when command enables set -e and fails", async () => {
		const root = makeTempDir();
		const record = startBackgroundProcess({
			rootCwd: root,
			command: "set -e\nfalse\necho should-not-run",
			source: "tool",
		});

		const finalStatus = await waitForStatus(root, record.id, ["error"], 5000);
		expect(finalStatus).toBe("error");

		const refreshed = getBackgroundProcess(root, record.id);
		expect(refreshed?.finishedAt).toBeDefined();
		expect(refreshed?.exitCode).toBe(1);
	});

	it("prunes old completed background records and keeps running ones", async () => {
		const root = makeTempDir();
		const doneRecord = startBackgroundProcess({
			rootCwd: root,
			command: "echo prune-me",
			source: "tool",
		});
		await waitForStatus(root, doneRecord.id, ["done", "error"], 4000);
		const doneMeta = JSON.parse(readFileSync(doneRecord.metaPath, "utf8")) as Record<string, unknown>;
		doneMeta.createdAt = "2000-01-01T00:00:00.000Z";
		writeFileSync(doneRecord.metaPath, `${JSON.stringify(doneMeta, null, 2)}\n`, "utf8");

		const runningRecord = startBackgroundProcess({
			rootCwd: root,
			command: "sleep 5; echo keep-running",
			source: "tool",
		});
		await waitForStatus(root, runningRecord.id, ["running"], 4000);

		const result = pruneBackgroundProcesses(root, { maxAgeHours: 1 });
		expect(result.removed).toBeGreaterThanOrEqual(1);
		expect(result.removedIds).toContain(doneRecord.id);
		expect(result.skippedRunning).toBeGreaterThanOrEqual(1);
		expect(getBackgroundProcess(root, doneRecord.id)).toBeUndefined();
		expect(getBackgroundProcess(root, runningRecord.id)?.status).toBe("running");

		stopBackgroundProcess(root, runningRecord.id);
	});
});

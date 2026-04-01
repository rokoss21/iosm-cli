import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getBackgroundProcess,
	listBackgroundProcesses,
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
});


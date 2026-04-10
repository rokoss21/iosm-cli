import { describe, expect, it } from "vitest";
import {
	commandExists,
	getCommandExistsCacheStatsSnapshot,
	resetCommandExistsCacheForTests,
	runVerificationCommandBatch,
} from "../src/core/tools/verification-runner.js";

describe("verification-runner", () => {
	it("caches commandExists results with hit/miss accounting", () => {
		resetCommandExistsCacheForTests();
		const before = getCommandExistsCacheStatsSnapshot();
		expect(commandExists("node")).toBe(true);
		const afterFirst = getCommandExistsCacheStatsSnapshot();
		expect(afterFirst.cacheMisses - before.cacheMisses).toBe(1);
		expect(afterFirst.cacheHits - before.cacheHits).toBe(0);

		expect(commandExists("node")).toBe(true);
		const afterSecond = getCommandExistsCacheStatsSnapshot();
		expect(afterSecond.cacheMisses - afterFirst.cacheMisses).toBe(0);
		expect(afterSecond.cacheHits - afterFirst.cacheHits).toBe(1);
	});

	it("invalidates command cache when PATH fingerprint changes", () => {
		resetCommandExistsCacheForTests();
		const originalPath = process.env.PATH;
		expect(commandExists("node")).toBe(true);
		const afterWarm = getCommandExistsCacheStatsSnapshot();
		process.env.PATH = `${originalPath ?? ""}:/tmp/iosm-path-fingerprint-test`;
		try {
			expect(commandExists("node")).toBe(true);
			const afterInvalidate = getCommandExistsCacheStatsSnapshot();
			expect(afterInvalidate.pathInvalidations - afterWarm.pathInvalidations).toBe(1);
			expect(afterInvalidate.cacheMisses - afterWarm.cacheMisses).toBe(1);
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it("keeps deterministic result ordering in parallel batch mode", async () => {
		const cwd = process.cwd();
		const batch = await runVerificationCommandBatch(
			[
				{
					key: "first",
					command: process.execPath,
					args: ["-e", "setTimeout(() => { console.log('first'); }, 80);"],
					cwd,
					timeoutMs: 5000,
				},
				{
					key: "second",
					command: process.execPath,
					args: ["-e", "setTimeout(() => { console.log('second'); }, 10);"],
					cwd,
					timeoutMs: 5000,
				},
				{
					key: "third",
					command: process.execPath,
					args: ["-e", "setTimeout(() => { console.log('third'); }, 20);"],
					cwd,
					timeoutMs: 5000,
				},
			],
			{ mode: "parallel", maxParallel: 3 },
		);

		expect(batch.map((entry) => entry.key)).toEqual(["first", "second", "third"]);
		expect(batch[0]?.result.stdout).toContain("first");
		expect(batch[1]?.result.stdout).toContain("second");
		expect(batch[2]?.result.stdout).toContain("third");
	});

	it("supports sequential and bounded parallel batch execution modes", async () => {
		const cwd = process.cwd();
		const items = [
			{
				key: "a",
				command: process.execPath,
				args: ["-e", "setTimeout(() => { console.log('a'); }, 120);"],
				cwd,
				timeoutMs: 5000,
			},
			{
				key: "b",
				command: process.execPath,
				args: ["-e", "setTimeout(() => { console.log('b'); }, 120);"],
				cwd,
				timeoutMs: 5000,
			},
			{
				key: "c",
				command: process.execPath,
				args: ["-e", "setTimeout(() => { console.log('c'); }, 120);"],
				cwd,
				timeoutMs: 5000,
			},
		];

		const sequentialStart = Date.now();
		await runVerificationCommandBatch(items, { mode: "sequential" });
		const sequentialMs = Date.now() - sequentialStart;

		const parallelStart = Date.now();
		await runVerificationCommandBatch(items, { mode: "parallel", maxParallel: 3 });
		const parallelMs = Date.now() - parallelStart;

		expect(sequentialMs).toBeGreaterThan(parallelMs + 100);
	});
});

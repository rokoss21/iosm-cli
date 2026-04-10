import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTypecheckRunTool } from "../src/core/tools/typecheck-run.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((item: any) => item.type === "text")
			.map((item: any) => item.text)
			.join("\n") ?? ""
	);
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, "utf-8");
	chmodSync(path, 0o755);
}

describe("typecheck_run tool", () => {
	let testDir: string;
	let previousTscExit: string | undefined;
	let previousPyrightExit: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `iosm-typecheck-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		mkdirSync(join(testDir, "src"), { recursive: true });
		mkdirSync(join(testDir, "test"), { recursive: true });
		mkdirSync(join(testDir, "node_modules", ".bin"), { recursive: true });

		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify(
				{
					name: "typecheck-run-fixture",
					version: "1.0.0",
					private: true,
					scripts: {
						typecheck: "node -e \"console.log('script typecheck ok')\"",
						"typecheck:fail": "node -e \"process.stderr.write('typecheck failed\\n'); process.exit(1)\"",
						"typecheck:nofiles": "node -e \"console.log('No inputs were found in config file')\"",
						"typecheck:slow": "node -e \"setTimeout(() => {}, 5000)\"",
					},
				},
				null,
				2,
			),
		);
		writeFileSync(join(testDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }, null, 2));
		writeFileSync(join(testDir, "pyrightconfig.json"), JSON.stringify({ include: ["src"] }, null, 2));

		writeExecutable(
			join(testDir, "node_modules", ".bin", "tsc"),
			`#!/usr/bin/env bash
echo "tsc-check"
exit "\${TYPECHECK_TSC_EXIT_CODE:-0}"
`,
		);
		writeExecutable(
			join(testDir, "node_modules", ".bin", "pyright"),
			`#!/usr/bin/env bash
echo "pyright-check"
exit "\${TYPECHECK_PYRIGHT_EXIT_CODE:-0}"
`,
		);

		previousTscExit = process.env.TYPECHECK_TSC_EXIT_CODE;
		previousPyrightExit = process.env.TYPECHECK_PYRIGHT_EXIT_CODE;
		delete process.env.TYPECHECK_TSC_EXIT_CODE;
		delete process.env.TYPECHECK_PYRIGHT_EXIT_CODE;
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		if (previousTscExit === undefined) {
			delete process.env.TYPECHECK_TSC_EXIT_CODE;
		} else {
			process.env.TYPECHECK_TSC_EXIT_CODE = previousTscExit;
		}
		if (previousPyrightExit === undefined) {
			delete process.env.TYPECHECK_PYRIGHT_EXIT_CODE;
		} else {
			process.env.TYPECHECK_PYRIGHT_EXIT_CODE = previousPyrightExit;
		}
	});

	it("runs all auto-detected runners and aggregates passed status", async () => {
		const tool = createTypecheckRunTool(testDir);
		const result = await tool.execute("typecheck-run-1", { runner: "auto" });
		const output = getTextOutput(result);
		const details = result.details!;

		expect(details.status).toBe("passed");
		expect(details.runs).toHaveLength(3);
		expect(details.runs.map((run) => run.resolvedRunner)).toEqual(["npm", "tsc", "pyright"]);
		expect(details.aggregateExitCode).toBe(0);
		expect(output).toContain("typecheck_run status: passed");
		expect(output).toContain("script typecheck ok");
		expect(output).toContain("tsc-check");
		expect(output).toContain("pyright-check");
	});

	it("enables bounded parallel batch mode only for auto-detected runners", async () => {
		const tool = createTypecheckRunTool(testDir, {
			resolveBatchMode: () => "parallel",
			resolveMaxParallel: () => 2,
		});
		const result = await tool.execute("typecheck-run-batch-auto", { runner: "auto" });
		expect(result.details?.batchMode).toBe("parallel");
		expect(result.details?.maxParallel).toBe(2);
		expect(result.details?.runs).toHaveLength(3);
	});

	it("keeps explicit single-runner execution sequential even when parallel mode is configured", async () => {
		const tool = createTypecheckRunTool(testDir, {
			resolveBatchMode: () => "parallel",
			resolveMaxParallel: () => 4,
		});
		const result = await tool.execute("typecheck-run-batch-single", { runner: "tsc" });
		expect(result.details?.batchMode).toBe("sequential");
		expect(result.details?.maxParallel).toBeUndefined();
		expect(result.details?.runs).toHaveLength(1);
	});

	it("does not throw when one auto-detected runner fails and returns aggregate failed status", async () => {
		process.env.TYPECHECK_TSC_EXIT_CODE = "1";

		const tool = createTypecheckRunTool(testDir);
		const result = await tool.execute("typecheck-run-2", { runner: "auto" });

		expect(result.details?.status).toBe("failed");
		expect(result.details?.aggregateExitCode).toBe(1);
		expect(result.details?.runs.some((run) => run.resolvedRunner === "tsc" && run.status === "failed")).toBe(true);
		expect(getTextOutput(result)).toContain("typecheck_run status: failed");
	});

	it("maps no-files output to no_files status without throwing", async () => {
		const tool = createTypecheckRunTool(testDir);
		const result = await tool.execute("typecheck-run-3", {
			runner: "npm",
			script: "typecheck:nofiles",
		});

		expect(result.details?.status).toBe("no_files");
		expect(result.details?.runs[0]?.status).toBe("no_files");
		expect(getTextOutput(result)).toContain("typecheck_run status: no_files");
	});

	it("builds npm runner argv with args + targets in the expected order", async () => {
		const tool = createTypecheckRunTool(testDir);
		const result = await tool.execute("typecheck-run-4", {
			runner: "npm",
			args: ["--pretty", "false"],
			targets: ["src", "test"],
		});

		expect(result.details?.runs[0]?.resolvedRunner).toBe("npm");
		expect(result.details?.runs[0]?.resolvedCommand).toBe("npm");
		expect(result.details?.runs[0]?.resolvedArgs).toEqual([
			"run",
			"typecheck",
			"--",
			"--pretty",
			"false",
			"src",
			"test",
		]);
	});

	it("times out long-running commands", async () => {
		const tool = createTypecheckRunTool(testDir);
		await expect(
			tool.execute("typecheck-run-5", {
				runner: "npm",
				script: "typecheck:slow",
				timeout: 1,
			}),
		).rejects.toThrow(/timed out/i);
	});

	it("returns failed for script-based non-zero exit without throwing", async () => {
		const tool = createTypecheckRunTool(testDir);
		const result = await tool.execute("typecheck-run-6", {
			runner: "npm",
			script: "typecheck:fail",
		});

		expect(result.details?.status).toBe("failed");
		expect(result.details?.runs[0]?.exitCode).toBe(1);
		expect(getTextOutput(result)).toContain("typecheck_run status: failed");
	});
});

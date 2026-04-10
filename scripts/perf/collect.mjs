import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

const SUITES = [
	{
		name: "orchestrationCore",
		testArgs: [
			"test/system-prompt.test.ts",
			"test/subagent-orchestration.test.ts",
			"test/parallel-task-agent.test.ts",
			"test/agent-session-retry.test.ts",
		],
	},
	{
		name: "verificationSettings",
		testArgs: [
			"test/test-run-tool.test.ts",
			"test/lint-run-tool.test.ts",
			"test/typecheck-run-tool.test.ts",
			"test/db-run-tool.test.ts",
			"test/settings-manager.test.ts",
			"test/settings-manager-bug.test.ts",
		],
	},
];

function runVitest(testArgs) {
	const startedAt = performance.now();
	const result = spawnSync("npm", ["run", "test", "--", ...testArgs], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		shell: process.platform === "win32",
		maxBuffer: 10 * 1024 * 1024,
	});
	const durationMs = performance.now() - startedAt;
	return {
		ok: result.status === 0,
		status: result.status,
		signal: result.signal,
		durationMs,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function parseHarnessMetrics(output) {
	const match = output.match(/PERF_METRICS::(\{.*\})/);
	if (!match?.[1]) {
		throw new Error("Unable to locate PERF_METRICS marker in perf harness output.");
	}
	return JSON.parse(match[1]);
}

export function collectPerfMetrics() {
	const harnessRun = runVitest(["test/perf-harness.metrics.test.ts"]);
	const harnessOutput = `${harnessRun.stdout}\n${harnessRun.stderr}`;
	if (!harnessRun.ok) {
		throw new Error(`Perf harness test failed:\n${harnessOutput}`);
	}
	const harnessMetrics = parseHarnessMetrics(harnessOutput);

	const suiteMetrics = SUITES.map((suite) => {
		const run = runVitest(suite.testArgs);
		return {
			name: suite.name,
			durationMs: run.durationMs,
			ok: run.ok,
			status: run.status,
			signal: run.signal,
		};
	});

	return {
		timestamp: new Date().toISOString(),
		repoRoot: REPO_ROOT,
		harness: harnessMetrics,
		suites: suiteMetrics,
	};
}

function maybeWriteReport(report, outPath) {
	if (!outPath) return;
	const absolute = resolve(process.cwd(), outPath);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const outArg = process.argv.find((arg) => arg.startsWith("--out="));
	const outPath = outArg ? outArg.slice("--out=".length) : undefined;
	const report = collectPerfMetrics();
	maybeWriteReport(report, outPath);
	console.log(JSON.stringify(report, null, 2));
}

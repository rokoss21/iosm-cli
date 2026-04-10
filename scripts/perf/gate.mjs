import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { collectPerfMetrics } from "./collect.mjs";

const HERE = dirname(new URL(import.meta.url).pathname);
const BASELINE_PATH = resolve(HERE, "baseline.json");
const DEFAULT_REPORT_PATH = resolve(HERE, "latest-report.json");
const MAX_RUNTIME_REGRESSION_FACTOR = 1.15;
const REQUIRED_COMMAND_EXISTS_SPEEDUP = 5;
const REQUIRED_PROMPT_REDUCTION_FACTOR = 0.8;

function loadBaseline() {
	return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function formatMs(value) {
	return `${value.toFixed(2)}ms`;
}

function runGate() {
	const baseline = loadBaseline();
	const report = collectPerfMetrics();
	const failures = [];

	const promptLimit = Math.floor(baseline.promptChars * REQUIRED_PROMPT_REDUCTION_FACTOR);
	if (report.harness.promptChars > promptLimit) {
		failures.push(
			`Prompt size regression: ${report.harness.promptChars} chars (limit ${promptLimit}, baseline ${baseline.promptChars})`,
		);
	}

	const observedSpeedup = Number(report.harness.commandExists?.speedup ?? 0);
	if (!Number.isFinite(observedSpeedup) || observedSpeedup < REQUIRED_COMMAND_EXISTS_SPEEDUP) {
		failures.push(
			`commandExists warm-path speedup too low: ${observedSpeedup.toFixed(2)}x (required >= ${REQUIRED_COMMAND_EXISTS_SPEEDUP}x)`,
		);
	}

	for (const suite of report.suites) {
		const baselineMs = baseline.suiteBaselinesMs?.[suite.name];
		if (typeof baselineMs !== "number") {
			failures.push(`Missing baseline for suite ${suite.name}`);
			continue;
		}
		const upperBoundMs = baselineMs * MAX_RUNTIME_REGRESSION_FACTOR;
		if (!suite.ok) {
			failures.push(`Suite ${suite.name} failed to execute (status=${suite.status ?? "unknown"})`);
			continue;
		}
		if (suite.durationMs > upperBoundMs) {
			failures.push(
				`Suite ${suite.name} exceeded runtime envelope: ${formatMs(suite.durationMs)} (limit ${formatMs(upperBoundMs)}, baseline ${formatMs(baselineMs)})`,
			);
		}
	}

	const output = {
		baseline,
		report,
		thresholds: {
			promptMaxChars: promptLimit,
			requiredCommandExistsSpeedup: REQUIRED_COMMAND_EXISTS_SPEEDUP,
			runtimeRegressionFactor: MAX_RUNTIME_REGRESSION_FACTOR,
		},
		failures,
	};

	const outArg = process.argv.find((arg) => arg.startsWith("--out="));
	const outPath = outArg ? resolve(process.cwd(), outArg.slice("--out=".length)) : DEFAULT_REPORT_PATH;
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

	if (failures.length > 0) {
		console.error("PERF_GATE_FAILED");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		console.error(`Report: ${outPath}`);
		process.exit(1);
	}

	console.log("PERF_GATE_PASSED");
	console.log(`Prompt chars: ${report.harness.promptChars} (limit ${promptLimit})`);
	console.log(`commandExists speedup: ${observedSpeedup.toFixed(2)}x`);
	for (const suite of report.suites) {
		const baselineMs = baseline.suiteBaselinesMs?.[suite.name];
		console.log(`- ${suite.name}: ${formatMs(suite.durationMs)} (baseline ${formatMs(baselineMs)})`);
	}
	console.log(`Report: ${outPath}`);
}

runGate();

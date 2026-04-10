import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";
import {
	commandExists,
	resetCommandExistsCacheForTests,
} from "../src/core/tools/verification-runner.js";

const fullToolSet = [
	"read",
	"bash",
	"edit",
	"write",
	"apply_patch",
	"grep",
	"find",
	"ls",
	"rg",
	"fd",
	"ast_grep",
	"comby",
	"jq",
	"yq",
	"semgrep",
	"sed",
	"semantic_search",
	"fetch",
	"web_search",
	"git_read",
	"git_write",
	"fs_ops",
	"test_run",
	"lint_run",
	"lsp",
	"typecheck_run",
	"db_run",
	"todo_write",
	"todo_read",
	"task",
	"tool_search",
	"tool_suggest",
];

function measureColdCommandExists(command: string, iterations: number): number {
	let totalMs = 0;
	for (let index = 0; index < iterations; index += 1) {
		resetCommandExistsCacheForTests();
		const start = performance.now();
		commandExists(command);
		totalMs += performance.now() - start;
	}
	return totalMs / Math.max(1, iterations);
}

function measureWarmCommandExists(command: string, iterations: number): number {
	resetCommandExistsCacheForTests();
	commandExists(command);
	const start = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		commandExists(command);
	}
	return (performance.now() - start) / Math.max(1, iterations);
}

describe("perf harness metrics", () => {
	it("emits prompt and commandExists metrics", () => {
		const prompt = buildSystemPrompt({
			selectedTools: fullToolSet,
			contextFiles: [],
			skills: [],
		});
		const command = commandExists("node") ? "node" : process.execPath;
		const coldAvgMs = measureColdCommandExists(command, 30);
		const warmAvgMs = measureWarmCommandExists(command, 200);
		const metrics = {
			promptChars: prompt.length,
			commandExists: {
				command,
				coldAvgMs,
				warmAvgMs,
				speedup: coldAvgMs > 0 ? coldAvgMs / Math.max(warmAvgMs, 0.000001) : 0,
			},
		};
		console.log(`PERF_METRICS::${JSON.stringify(metrics)}`);
		expect(metrics.promptChars).toBeGreaterThan(0);
		expect(metrics.commandExists.coldAvgMs).toBeGreaterThan(0);
	});
});

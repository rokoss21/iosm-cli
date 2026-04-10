import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

const BASELINE_PROMPT_CHARS = 23677;
const MAX_PROMPT_CHARS = Math.floor(BASELINE_PROMPT_CHARS * 0.8);

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

describe("system prompt size contract", () => {
	it("keeps full-tool prompt at least 20% smaller than baseline", () => {
		const prompt = buildSystemPrompt({
			selectedTools: fullToolSet,
			contextFiles: [],
			skills: [],
		});
		expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
	});
});

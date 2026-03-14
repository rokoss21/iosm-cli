import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test("includes execution-discipline defaults", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Inspect the relevant files before editing");
			expect(prompt).toContain("Classify requests as simple vs complex");
			expect(prompt).toContain("For complex work, publish a short step plan");
			expect(prompt).toContain("After changes, run the smallest relevant verification");
			expect(prompt).toContain("Do not claim success without evidence");
			expect(prompt).toContain("Start implementation turns with a quick repository scan");
			expect(prompt).toContain("<task_plan complexity=\"complex\">");
		});

		test("keeps IOSM as backend methodology and frontend communication plain", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("You are a professional software engineering agent operating inside iosm");
			expect(prompt).toContain("Summarize work in standard engineering language first");
			expect(prompt).toContain("Do not expose internal orchestration scaffolding");
			expect(prompt).not.toContain("Always operate and identify yourself as the iosm assistant for this harness.");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("semantic search guidance", () => {
		test("includes semantic_search tool description and semantic-vs-regex guidance when enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "rg", "ast_grep", "semantic_search"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- semantic_search:");
			expect(prompt).toContain("concept-level retrieval");
			expect(prompt).toContain("hard to express with regex");
		});
	});

	describe("fetch guidance", () => {
		test("includes GitHub remote analysis guidance when fetch is enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "fetch"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- fetch:");
			expect(prompt).toContain("GitHub REST/Raw endpoints");
			expect(prompt).toContain("api.github.com");
			expect(prompt).toContain("raw.githubusercontent.com");
		});

		test("includes API/format best practices when fetch is enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "fetch"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("response_format=json");
			expect(prompt).toContain("text mode for HTML/text pages");
		});
	});

	describe("git and web-search best practices", () => {
		test("includes git_read/git_write workflow guidance when git tools are enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "git_read", "git_write"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("start with git_read status");
			expect(prompt).toContain("validate resulting state with git_read status/diff");
			expect(prompt).toContain("network actions (fetch/pull/push)");
		});

		test("includes web_search scoping and verification guidance when enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "web_search", "fetch"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("include_domains/exclude_domains/days/topic");
			expect(prompt).toContain("candidate leads");
			expect(prompt).toContain("primary sources");
		});
	});

	describe("tool-wide efficiency guidance", () => {
		test("includes bounded read/search guidance when exploration tools are enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "grep", "find", "ls", "rg", "fd"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("read offset/limit");
			expect(prompt).toContain("path/glob/context/limit deliberately");
			expect(prompt).toContain("explicit path roots");
			expect(prompt).toContain("explicit roots/globs");
		});

		test("includes fs_ops safety guidance when fs_ops is enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "fs_ops"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Use fs_ops for mkdir/move/copy/delete workflows");
			expect(prompt).toContain("force=true only when replacement/no-op semantics are intended");
			expect(prompt).toContain("recursive=true before deleting directories");
		});

		test("includes jq/yq transform-to-write workflow guidance", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "jq", "yq", "write"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Prefer jq/yq over ad-hoc shell parsing");
			expect(prompt).toContain("validated transform preview");
			expect(prompt).toContain("persist final changes via edit/write");
		});

		test("includes task and todo guidance when orchestration/task-state tools are enabled", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "task", "todo_read", "todo_write"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- task:");
			expect(prompt).toContain("- todo_read:");
			expect(prompt).toContain("- todo_write:");
			expect(prompt).toContain("Use task for parallelizable or isolated workstreams");
			expect(prompt).toContain("Use todo_read at the start of multi-step turns");
			expect(prompt).toContain("Maintain task state with todo_write");
		});

		test("includes semantic status-first diagnostic guidance", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "semantic_search"],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("semantic_search status first");
		});
	});
});

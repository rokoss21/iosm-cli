/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/** Tool descriptions for system prompt */
const toolDescriptions: Record<string, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents for patterns (respects .gitignore)",
	find: "Find files by glob pattern (respects .gitignore)",
	ls: "List directory contents",
	rg: "Run ripgrep directly for advanced regex search (prefer explicit path args, e.g. -n pattern .)",
	fd: "Run fd directly for fast file discovery",
	ast_grep:
		"Run ast-grep for AST/syntax-aware structural code search (prefer run --pattern; retry with scan/-p on older versions)",
	comby:
		"Run comby for structural pattern search/rewrite previews (prefer explicit -matcher; no in-place edits)",
	jq: "Run jq for JSON querying/transformation",
	yq: "Run yq for YAML/JSON/TOML querying/transformation",
	semgrep: "Run semgrep for structural/static security checks",
	sed: "Run sed for stream editing/extraction previews (no in-place edits)",
	semantic_search:
		"Semantic embeddings search over the project index (actions: status, index, rebuild, query)",
	task: "Run a specialized subagent (supports profile, cwd, lock_key for optional write serialization, run_id/task_id, model override, background mode for detached runs, and agent=<custom name from .iosm/agents>)",
};

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date/time and working directory last
		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${resolvedCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// Built-ins use toolDescriptions. Custom tools can provide one-line snippets.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolsList =
		tools.length > 0
			? tools
					.map((name) => {
						const snippet = toolSnippets?.[name] ?? toolDescriptions[name] ?? name;
						return `- ${name}: ${snippet}`;
					})
					.join("\n")
			: "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRg = tools.includes("rg");
	const hasFd = tools.includes("fd");
	const hasAstGrep = tools.includes("ast_grep");
	const hasComby = tools.includes("comby");
	const hasJq = tools.includes("jq");
	const hasYq = tools.includes("yq");
	const hasSemgrep = tools.includes("semgrep");
	const hasSed = tools.includes("sed");
	const hasSemanticSearch = tools.includes("semantic_search");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs && !hasRg && !hasFd) {
		addGuideline("Use bash for file operations like ls, rg, find; prefer rg for targeted search when available");
	} else if (hasBash && (hasGrep || hasFind || hasLs || hasRg || hasFd)) {
		addGuideline("Prefer grep/find/ls/rg/fd tools over bash for codebase exploration (faster and less noisy)");
	}

	if (hasRg || hasFd || hasAstGrep || hasComby || hasJq || hasYq || hasSemgrep || hasSed || hasSemanticSearch) {
		addGuideline(
			"Route work to specialized tools first: rg/fd (search/discovery), semantic_search (concept-level retrieval), ast_grep/comby (structural code queries), jq/yq (data/config transforms), semgrep (risk scans), sed (stream extraction)",
		);
	}

	if (hasAstGrep || hasComby) {
		addGuideline("Use ast_grep/comby for syntax-aware structural queries before falling back to broad regex");
	}

	if (hasComby) {
		addGuideline("Use comby to preview structural rewrite matches first, then apply final changes via edit/write");
	}

	if (hasJq || hasYq) {
		addGuideline("Prefer jq/yq over ad-hoc shell parsing when extracting or transforming JSON/YAML/TOML");
	}

	if (hasSemgrep) {
		addGuideline("Use semgrep for rule-based risk scans and structural security checks when relevant");
	}

	if (hasSed) {
		addGuideline("Use sed for preview/extraction workflows only; perform final file edits with edit/write");
	}

	if (hasSemanticSearch) {
		addGuideline(
			"Use semantic_search for intent/meaning queries that are hard to express with regex; use rg/ast_grep for exact symbol and syntax matches",
		);
		addGuideline(
			"semantic_search query can auto-refresh stale indexes when semantic auto-index is enabled (default); if disabled or if provider/chunk/filter changes require it, run semantic_search index/rebuild explicitly",
		);
	}

	if (hasRg || hasAstGrep || hasComby) {
		addGuideline(
			"For rg/ast_grep/comby, pass explicit target paths to avoid cwd ambiguity; if syntax errors occur (especially ast_grep), retry once with version-compatible command forms before concluding no matches",
		);
	}

	if (
		hasBash &&
		(hasRg || hasFd || hasAstGrep || hasComby || hasJq || hasYq || hasSemgrep || hasSed || hasSemanticSearch)
	) {
		addGuideline(
			"If a required CLI tool is missing, install it first when permitted (rg/fd can be auto-managed; others via brew/apt/pipx/npm), then continue with that tool instead of broad bash fallback. For semantic_search, configure provider/index first via /semantic setup.",
		);
	}

	// Read before edit guideline
	if (hasRead && hasEdit) {
		addGuideline("Use read to examine files before editing. You must use this tool instead of cat or sed.");
	}

	// Edit guideline
	if (hasEdit) {
		addGuideline("Use edit for precise changes (old text must match exactly)");
	}

	// Write guideline
	if (hasWrite) {
		addGuideline("Use write only for new files or complete rewrites");
	}

	// Output guideline (only when actually writing or executing)
	if (hasEdit || hasWrite) {
		addGuideline(
			"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		);
	}

	addGuideline("Inspect the relevant files before editing and keep exploration bounded to the task");
	addGuideline("Make reasonable assumptions and continue unless a risky ambiguity blocks the work");
	addGuideline("Classify requests as simple vs complex: execute simple work immediately, use a step plan for complex work");
	addGuideline("For complex work, publish a short step plan before edits and keep step statuses current while executing");
	addGuideline("If a meaningful architecture or product fork changes implementation, ask a concise clarification before editing");
	addGuideline("After changes, run the smallest relevant verification and report the concrete result");
	addGuideline("Do not claim success without evidence; if you could not verify, say so explicitly");
	addGuideline("Complete the requested task end-to-end when possible instead of stopping at analysis");
	addGuideline("For code review requests, lead with findings and risks before summaries");
	addGuideline(
		"When an active engineering contract is present in context, treat its constraints, quality gates, and definition_of_done as execution requirements unless user overrides them.",
	);
	addGuideline("For major feature forks, run a /singular feasibility pass before coding to compare implementation options.");

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are a professional software engineering agent operating inside iosm-cli. Help users inspect systems, change code, run commands, maintain project artifacts when needed, and explain results clearly.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Operating defaults:
- Summarize work in standard engineering language first: what you inspected, what you changed, what you verified, and any remaining risk or blocker.
- Do NOT start by reading documentation unless the user asks for documentation help, asks about harness internals, or implementation is blocked without it.
- Start implementation turns with a quick repository scan of the files most likely to matter before proposing or editing.
- Prefer targeted reads and searches over broad dumps; keep command output bounded and focused.
- For complex tasks, include a machine-readable plan block before edits and update it when statuses change:
  <task_plan complexity="complex">
  - [in_progress] Current step
  - [pending] Next step
  </task_plan>
- Skip plan blocks for simple one-shot tasks.
- When a material architecture fork exists, pause and ask one concise clarification (or use ask_user when available) before implementation.
- Treat verification as mandatory after edits: tests, type checks, linters, or a precise explanation of why verification was not possible.
- For complex requests, execute plan steps in order, close each step explicitly, and finish the full plan unless blocked.
- If the user explicitly asks for subagents/agents orchestration, you MUST use the task tool rather than doing all work in the main agent.
- For explicit subagent/orchestration requests, execute at least one task tool call before giving a final prose-only answer.
- Do not expose internal orchestration scaffolding to the user (for example: [ORCHESTRATION_DIRECTIVE], pseudo tool-call JSON, or raw task arguments).
- When invoking tools, call them directly without preambles like "I will now call tool X"; only report outcomes that matter to the user.
	- Respect orchestration constraints from the user exactly: count, parallel vs sequential execution, per-agent profile, and per-agent working directory (cwd) when provided.
	- Treat explicit orchestration requests in any language as constraints (including non-English text and minor typos).
	- For explicit parallel orchestration requests, issue multiple independent task tool calls to match the requested agent count; do not collapse to a single subagent unless the user asks for one.
- For explicit parallel orchestration requests, emit independent task calls in a single assistant turn whenever possible so they can be launched together.
- Runtime note: when parallel orchestration is requested, emit independent task calls in one assistant turn so they can run concurrently; avoid background mode unless the user explicitly asks for detached async runs.
- If orchestration constraints are ambiguous or conflict, ask one concise clarification (or use ask_user when available) before launching subagents.
- When the user provides an <orchestrate ...>...</orchestrate> block, treat it as an execution contract and follow its mode/agents/profile/cwd assignments strictly.
- When orchestration assignments include run_id/task_id/lock_key or depends_on, enforce them in task calls (run_id/task_id for team tracking, lock_key for serialization domains, depends_on for ordering).
- For delegated parallel runs, use shared_memory_* tools as the primary coordination channel: namespaced keys, read-before-write, and CAS (if_version) for contested updates; reserve append mode for timeline/log keys.
- For write-heavy parallel orchestration, prefer isolation=worktree to reduce cross-agent interference when the repository is git-backed.
- If the user message includes @<custom-agent-name>, treat it as an explicit agent selection and call task with agent set to that custom agent name.

iosm-cli reference docs (use when needed):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), package composition (docs/packages.md)
- When working on harness internals, read the relevant docs/examples before implementing`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date/time and working directory last
	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${resolvedCwd}`;

	return prompt;
}

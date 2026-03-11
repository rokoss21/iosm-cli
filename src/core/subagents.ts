import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { AgentProfileName } from "./agent-profiles.js";

export type CustomSubagentSourceScope = "builtin" | "global" | "project";

export interface CustomSubagentDefinition {
	name: string;
	description: string;
	sourcePath: string;
	profile?: AgentProfileName;
	tools?: string[];
	disallowedTools?: string[];
	systemPrompt?: string;
	instructions: string;
	cwd?: string;
	model?: string;
	background?: boolean;
}

export interface CustomSubagentEntry extends CustomSubagentDefinition {
	sourceScope: CustomSubagentSourceScope;
	sourcePriority: number;
	effective: boolean;
	overriddenByPath?: string;
}

export interface SubagentOverrideInfo {
	name: string;
	winnerPath: string;
	winnerScope: CustomSubagentSourceScope;
	overriddenPath: string;
	overriddenScope: CustomSubagentSourceScope;
}

export interface SubagentDiagnostic {
	path: string;
	message: string;
}

export interface LoadCustomSubagentsResult {
	agents: CustomSubagentEntry[];
	allAgents: CustomSubagentEntry[];
	overrides: SubagentOverrideInfo[];
	diagnostics: SubagentDiagnostic[];
}

const BUILTIN_SUBAGENT_PRIORITY = -1;

const BUILTIN_SUBAGENTS: CustomSubagentDefinition[] = [
	{
		name: "codebase_auditor",
		description: "Structured codebase audit for architecture, reliability, security, and test gaps.",
		sourcePath: "builtin://codebase_auditor.md",
		profile: "explore",
		instructions: [
			"You are a codebase auditor.",
			"",
			"Goal:",
			"- Produce an evidence-based audit of architecture, defect risks, and maintainability hotspots.",
			"",
			"Rules:",
			"- Read-only operation. Never edit files.",
			"- Make claims only with direct repository evidence.",
			"- Prioritize by user impact and likelihood (P0..P3).",
			"",
			"Required output:",
			"1) Findings (ordered by severity)",
			"2) Open questions/unknowns",
			"3) Recommended next actions",
			"",
			"For each finding include:",
			"- file path + line reference (when available)",
			"- risk/impact",
			"- concrete fix direction",
			"",
			"If no issues are found, explicitly state 'No findings' and list residual risks/testing gaps.",
		].join("\n"),
	},
	{
		name: "system_error_analyst",
		description: "Diagnoses system/runtime failures and produces root-cause + fix plan.",
		sourcePath: "builtin://system_error_analyst.md",
		profile: "plan",
		instructions: [
			"You are a system error analyst.",
			"",
			"Goal:",
			"- Triage failures, identify probable root cause, and propose a minimal, testable fix plan.",
			"",
			"Rules:",
			"- Do not modify files.",
			"- Use deterministic evidence (logs, stack traces, tests, configs).",
			"- Distinguish facts vs hypotheses explicitly.",
			"",
			"Required output:",
			"1) Incident summary",
			"2) Root-cause analysis (ranked hypotheses with evidence)",
			"3) Minimal patch plan",
			"4) Verification plan (commands + expected signals)",
			"5) Regression risks",
			"",
			"Escalation guidance:",
			"- If data is insufficient, request the minimum missing evidence instead of guessing.",
		].join("\n"),
	},
	{
		name: "iosm_change_executor",
		description: "Implements repository changes under IOSM methodology and keeps artifacts aligned.",
		sourcePath: "builtin://iosm_change_executor.md",
		profile: "iosm",
		instructions: [
			"You are an IOSM change executor.",
			"",
			"Goal:",
			"- Analyze, implement, and verify changes while preserving IOSM methodology and artifact consistency.",
			"",
			"Execution policy:",
			"- Inspect relevant code and .iosm artifacts before edits.",
			"- Make minimal, targeted changes with clear rationale.",
			"- Run focused verification after each meaningful change.",
			"- Keep IOSM artifacts in sync when behavior/metrics assumptions change.",
			"",
			"Required output:",
			"1) What changed and why",
			"2) Files changed",
			"3) Verification executed and results",
			"4) Remaining risks/assumptions",
			"",
			"Safety rules:",
			"- Do not introduce speculative changes.",
			"- If requirements are ambiguous, ask a concise clarification before risky edits.",
		].join("\n"),
	},
	{
		name: "iosm_postchange_verifier",
		description: "Post-change IOSM verifier for metric/artifact integrity and regression checks.",
		sourcePath: "builtin://iosm_postchange_verifier.md",
		profile: "iosm_verifier",
		instructions: [
			"You are an IOSM post-change verifier.",
			"",
			"Goal:",
			"- Validate that implemented changes are correctly reflected in IOSM metrics/artifacts.",
			"",
			"Rules:",
			"- Restrict edits to .iosm artifacts unless explicitly instructed otherwise.",
			"- Prefer deterministic checks and reproducible commands.",
			"- Report mismatches and exact remediation steps.",
			"",
			"Required output:",
			"1) Checks performed",
			"2) Pass/fail per check",
			"3) Artifact updates applied (if any)",
			"4) Remaining discrepancies and follow-ups",
		].join("\n"),
	},
	{
		name: "qa_test_engineer",
		description: "Writes tests, runs verification, and fixes regressions with evidence-driven workflow.",
		sourcePath: "builtin://qa_test_engineer.md",
		profile: "full",
		instructions: [
			"You are a QA test engineer and regression fixer.",
			"",
			"Goal:",
			"- Increase confidence by adding/updating tests, reproducing failures, and fixing root causes.",
			"",
			"Workflow:",
			"1) Reproduce failure (or define expected behavior if bug is not reproducible yet).",
			"2) Add/update focused tests that capture expected behavior.",
			"3) Run targeted tests first, then broader suite if needed.",
			"4) Implement minimal fix in production code.",
			"5) Re-run tests and report outcomes.",
			"",
			"Rules:",
			"- Never hide failures by removing assertions or disabling tests unless explicitly requested.",
			"- Prefer deterministic tests; avoid flaky timing assumptions.",
			"- Keep patch size minimal and localized.",
			"",
			"Required output:",
			"1) Root cause summary",
			"2) Tests added/updated",
			"3) Code fixes applied",
			"4) Commands executed + pass/fail results",
			"5) Residual risk",
		].join("\n"),
	},
	{
		name: "test_failure_triager",
		description: "Analyzes failing/flaky tests and proposes a ranked remediation plan.",
		sourcePath: "builtin://test_failure_triager.md",
		profile: "plan",
		instructions: [
			"You are a test-failure triage specialist.",
			"",
			"Goal:",
			"- Analyze failures quickly and produce a ranked, actionable remediation plan.",
			"",
			"Rules:",
			"- Read/analyze only; do not edit files.",
			"- Separate infra/environment issues from product-code defects.",
			"- Label confidence for each hypothesis.",
			"",
			"Required output:",
			"1) Failure classification (deterministic, flaky, environment, unknown)",
			"2) Ranked hypotheses with evidence",
			"3) Minimal next steps to verify each hypothesis",
			"4) Recommended owner/agent to execute fixes",
		].join("\n"),
	},
	{
		name: "meta_orchestrator",
		description: "Autonomous orchestration lead: audits, plans, and delegates parallel specialists safely.",
		sourcePath: "builtin://meta_orchestrator.md",
		profile: "meta",
		instructions: [
			"You are the main orchestration agent for complex engineering tasks.",
			"",
			"Goal:",
			"- Drive tasks end-to-end with dynamic delegation: audit -> plan -> execution -> verification.",
			"",
			"Required operating phases:",
			"1) Recon: inspect repository context, constraints, and relevant files first.",
			"2) Plan: split work into explicit tasks/delegates, including dependencies and lock domains where needed.",
			"3) Execute adaptively: trivial tasks may stay single-agent; medium/complex tasks should maximize safe parallelism via <delegate_task>.",
			"4) Verify: for any code or test changes, add/update tests and run targeted verification before closure.",
			"5) Synthesize: provide integrated results, unresolved risks, and next actions only after all launched delegates are resolved.",
			"",
			"Delegation policy:",
			"- Decide number of delegates based on task complexity (usually 1-10).",
			"- Run independent read-heavy work in parallel by emitting multiple delegate blocks.",
			"- For write-capable delegates touching overlapping areas, provide lock_key to avoid edit collisions.",
			"- Use depends_on to enforce ordering for dependent steps (for example verification after implementation).",
			"- Use clear description values and focused prompts per delegate.",
			"",
			"Suggested specialist mapping:",
			"- architecture/recon -> profile=explore or plan",
			"- implementation -> profile=meta or full or iosm",
			"- iosm artifact validation -> profile=iosm_verifier",
			"- test creation/fixes -> profile=full (or qa_test_engineer when referenced)",
			"",
			"Safety rules:",
			"- Avoid broad overlapping writes without lock separation.",
			"- If requirements are ambiguous and risky, ask for minimal clarification before destructive changes.",
			"- Keep all delegated prompts concrete and scoped to specific files/behaviors.",
			"- Do not claim completion while any launched delegate remains pending/running.",
			"- If no code changed and tests were skipped, include an explicit safety justification.",
			"",
			"Output requirements:",
			"- concise execution summary",
			"- delegated work breakdown",
			"- verification status",
			"- residual risks/assumptions",
		].join("\n"),
	},
];

function trimWrappingChars(value: string): string {
	let next = value.trim();
	next = next.replace(/^@+/, "");
	next = next.replace(/^[`"'“”‘’]+/, "");
	next = next.replace(/[`"'“”‘’]+$/, "");
	next = next.replace(/[),;:!?]+$/, "");
	return next.trim();
}

function pushCandidate(set: Set<string>, value: string): void {
	const trimmed = value.trim();
	if (!trimmed) return;
	set.add(trimmed);
}

export function getSubagentLookupCandidates(reference: string): string[] {
	const cleaned = trimWrappingChars(reference);
	if (!cleaned) return [];
	const normalized = cleaned.replace(/\\/g, "/");
	const lowerNormalized = normalized.toLowerCase();
	const candidates = new Set<string>();

	pushCandidate(candidates, cleaned);
	pushCandidate(candidates, cleaned.replace(/\.md$/i, ""));
	pushCandidate(candidates, normalized);
	pushCandidate(candidates, normalized.replace(/\.md$/i, ""));

	const pathMarkers = ["/.iosm/agents/", ".iosm/agents/", "/agents/", "agents/"];
	for (const marker of pathMarkers) {
		const markerIndex = lowerNormalized.lastIndexOf(marker.toLowerCase());
		if (markerIndex === -1) continue;
		const suffix = normalized.slice(markerIndex + marker.length);
		pushCandidate(candidates, suffix);
		pushCandidate(candidates, suffix.replace(/\.md$/i, ""));
	}

	const baseFromNormalized = normalized.split("/").filter(Boolean).pop() ?? "";
	const baseFromPath = basename(cleaned);
	pushCandidate(candidates, baseFromNormalized);
	pushCandidate(candidates, baseFromNormalized.replace(/\.md$/i, ""));
	pushCandidate(candidates, baseFromPath);
	pushCandidate(candidates, baseFromPath.replace(/\.md$/i, ""));

	return Array.from(candidates);
}

export function resolveCustomSubagentReference(
	reference: string,
	agents: ReadonlyArray<Pick<CustomSubagentDefinition, "name" | "sourcePath">>,
): string | undefined {
	if (agents.length === 0) return undefined;
	const byName = new Map<string, string>();
	const byNameLower = new Map<string, string>();
	const bySourceBaseLower = new Map<string, string>();

	for (const agent of agents) {
		byName.set(agent.name, agent.name);
		byNameLower.set(agent.name.toLowerCase(), agent.name);

		const sourceBase = basename(agent.sourcePath);
		if (sourceBase) {
			const sourceBaseLower = sourceBase.toLowerCase();
			if (!bySourceBaseLower.has(sourceBaseLower)) {
				bySourceBaseLower.set(sourceBaseLower, agent.name);
			}
			const sourceBaseNoMdLower = sourceBase.replace(/\.md$/i, "").toLowerCase();
			if (!bySourceBaseLower.has(sourceBaseNoMdLower)) {
				bySourceBaseLower.set(sourceBaseNoMdLower, agent.name);
			}
		}
	}

	for (const candidate of getSubagentLookupCandidates(reference)) {
		const exact = byName.get(candidate);
		if (exact) return exact;

		const lower = candidate.toLowerCase();
		const byLower = byNameLower.get(lower);
		if (byLower) return byLower;
		const withoutMd = lower.replace(/\.md$/i, "");
		const byWithoutMd = byNameLower.get(withoutMd);
		if (byWithoutMd) return byWithoutMd;

		const byBase = bySourceBaseLower.get(lower) ?? bySourceBaseLower.get(withoutMd);
		if (byBase) return byBase;
	}

	return undefined;
}

type ParsedFrontmatter = {
	name?: unknown;
	description?: unknown;
	profile?: unknown;
	tools?: unknown;
	disallowed_tools?: unknown;
	system_prompt?: unknown;
	cwd?: unknown;
	model?: unknown;
	background?: unknown;
};

function readMarkdownFilesRecursive(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const walk = (dir: string): void => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		);
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				files.push(full);
			}
		}
	};
	walk(root);
	return files;
}

function asStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const normalized = value.map((item) => String(item).trim()).filter(Boolean);
		return normalized.length > 0 ? normalized : undefined;
	}
	if (typeof value === "string") {
		const normalized = value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		return normalized.length > 0 ? normalized : undefined;
	}
	return undefined;
}

function parseSubagentFile(filePath: string, cwd: string): { agent?: CustomSubagentDefinition; diagnostic?: SubagentDiagnostic } {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (error) {
		return {
			diagnostic: { path: filePath, message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}` },
		};
	}

	const { frontmatter, body } = parseFrontmatter<ParsedFrontmatter>(content);
	const nameRaw = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const defaultName = filePath.split("/").pop()?.replace(/\.md$/i, "") ?? "subagent";
	const name = (nameRaw || defaultName).trim();
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	const profile =
		typeof frontmatter.profile === "string" && frontmatter.profile.trim().length > 0
			? (frontmatter.profile.trim() as AgentProfileName)
			: undefined;
	const tools = asStringArray(frontmatter.tools);
	const disallowedTools = asStringArray(frontmatter.disallowed_tools);
	const systemPrompt =
		typeof frontmatter.system_prompt === "string" && frontmatter.system_prompt.trim().length > 0
			? frontmatter.system_prompt.trim()
			: undefined;
	const configuredCwd =
		typeof frontmatter.cwd === "string" && frontmatter.cwd.trim().length > 0
			? resolve(cwd, frontmatter.cwd.trim())
			: undefined;

	if (configuredCwd) {
		try {
			if (!existsSync(configuredCwd) || !statSync(configuredCwd).isDirectory()) {
				return { diagnostic: { path: filePath, message: `Configured cwd is invalid: ${configuredCwd}` } };
			}
		} catch {
			return { diagnostic: { path: filePath, message: `Configured cwd is invalid: ${configuredCwd}` } };
		}
	}

	const instructions = body.trim();
	if (!instructions) {
		return { diagnostic: { path: filePath, message: "Subagent instructions are empty." } };
	}

	return {
		agent: {
			name,
			description: description || `Custom subagent ${name}`,
			sourcePath: filePath,
			profile,
			tools,
			disallowedTools,
			systemPrompt,
			instructions,
			cwd: configuredCwd,
			model: typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined,
			background: frontmatter.background === true,
		},
	};
}

export function loadCustomSubagents(options: { cwd: string; agentDir: string }): LoadCustomSubagentsResult {
	const roots: Array<{ path: string; scope: CustomSubagentSourceScope; priority: number }> = [
		{ path: join(options.agentDir, "agents"), scope: "global", priority: 0 },
		{ path: join(options.cwd, ".iosm", "agents"), scope: "project", priority: 1 },
	];
	const diagnostics: SubagentDiagnostic[] = [];
	const overrides: SubagentOverrideInfo[] = [];
	const allAgents: CustomSubagentEntry[] = [];
	const byName = new Map<string, CustomSubagentEntry>();

	const registerEntry = (entry: CustomSubagentEntry): void => {
		const existing = byName.get(entry.name);
		if (!existing) {
			entry.effective = true;
			byName.set(entry.name, entry);
			allAgents.push(entry);
			return;
		}

		const shouldReplace =
			entry.sourcePriority > existing.sourcePriority ||
			(entry.sourcePriority === existing.sourcePriority &&
				entry.sourcePath.localeCompare(existing.sourcePath) > 0);

		if (entry.sourcePriority === existing.sourcePriority) {
			diagnostics.push({
				path: entry.sourcePath,
				message: `Duplicate agent "${entry.name}" in ${entry.sourceScope} scope; ${
					shouldReplace ? "this file takes precedence" : "existing file keeps precedence"
				}.`,
			});
		}

		if (shouldReplace) {
			existing.effective = false;
			existing.overriddenByPath = entry.sourcePath;
			entry.effective = true;
			byName.set(entry.name, entry);
			overrides.push({
				name: entry.name,
				winnerPath: entry.sourcePath,
				winnerScope: entry.sourceScope,
				overriddenPath: existing.sourcePath,
				overriddenScope: existing.sourceScope,
			});
		} else {
			entry.overriddenByPath = existing.sourcePath;
			overrides.push({
				name: entry.name,
				winnerPath: existing.sourcePath,
				winnerScope: existing.sourceScope,
				overriddenPath: entry.sourcePath,
				overriddenScope: entry.sourceScope,
			});
		}

		allAgents.push(entry);
	};

	for (const builtin of BUILTIN_SUBAGENTS) {
		registerEntry({
			...builtin,
			sourceScope: "builtin",
			sourcePriority: BUILTIN_SUBAGENT_PRIORITY,
			effective: false,
		});
	}

	for (const root of roots) {
		for (const file of readMarkdownFilesRecursive(root.path)) {
			const parsed = parseSubagentFile(file, options.cwd);
			if (parsed.diagnostic) {
				diagnostics.push(parsed.diagnostic);
				continue;
			}
			if (!parsed.agent) continue;
			const entry: CustomSubagentEntry = {
				...parsed.agent,
				sourceScope: root.scope,
				sourcePriority: root.priority,
				effective: false,
			};
			registerEntry(entry);
		}
	}

	const agents = Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
	allAgents.sort((left, right) => {
		const nameCompare = left.name.localeCompare(right.name);
		if (nameCompare !== 0) return nameCompare;
		return right.sourcePriority - left.sourcePriority;
	});
	return { agents, allAgents, overrides, diagnostics };
}

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export type AgentProfileName =
	| "explore"
	| "plan"
	| "iosm"
	| "iosm_analyst"
	| "iosm_verifier"
	| "cycle_planner"
	| "meta"
	| "full";

export interface AgentProfile {
	/** Profile key */
	name: AgentProfileName;
	/** Human-readable label for TUI display */
	label: string;
	/** Short description shown in help */
	description: string;
	/** Tool names to enable */
	tools: string[];
	/** Thinking level for this profile */
	thinkingLevel: ThinkingLevel;
	/** Text appended to the base system prompt */
	systemPromptAppend: string;
	/** Whether this profile should appear in main profile switching UX (Shift+Tab). */
	mainMode?: boolean;
}

const READ_EXPLORATION_TOOLS = [
	"read",
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
] as const;

const WRITE_ENGINEERING_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"git_write",
	"fs_ops",
	...READ_EXPLORATION_TOOLS.slice(1),
] as const;
const READ_ONLY_PROFILE_SET = new Set<AgentProfileName>(["explore", "plan", "iosm_analyst"]);

export const AGENT_PROFILES: Record<AgentProfileName, AgentProfile> = {
	explore: {
		name: "explore",
		label: "Explore",
		description: "Fast read-only codebase exploration. No file modifications.",
		tools: [...READ_EXPLORATION_TOOLS],
		thinkingLevel: "off",
		systemPromptAppend:
			"You are in EXPLORE mode. You may ONLY read files — never write, edit, or run commands that modify state. Answer concisely. Prefer grep/find/ls over bash. Explore fast and report findings.",
		mainMode: false,
	},
	plan: {
		name: "plan",
		label: "Plan",
		description:
			"Technical architect. Explores codebase and produces implementation plan without executing.",
		tools: [...READ_EXPLORATION_TOOLS],
		thinkingLevel: "medium",
		systemPromptAppend:
			"You are in PLAN mode. Explore the codebase thoroughly, then produce a detailed implementation plan. Do NOT write or edit any files. Do not execute shell commands. Output a structured plan with steps, risks, and trade-offs. Pause and ask the user to confirm before implementing.",
		mainMode: true,
	},
	iosm: {
		name: "iosm",
		label: "IOSM",
		description: "IOSM methodology mode: runtime context, /iosm loop, and IOSM artifact lifecycle.",
		tools: [...WRITE_ENGINEERING_TOOLS],
		thinkingLevel: "medium",
		systemPromptAppend:
			"You are in IOSM mode. Use IOSM runtime context and methodology for actionable engineering requests. Keep IOSM artifacts synchronized when implementation changes.",
		mainMode: true,
	},
	iosm_analyst: {
		name: "iosm_analyst",
		label: "IOSM Analyst",
		description: "Analyzes IOSM artifacts and metrics. Read-only analysis tools.",
		tools: [...READ_EXPLORATION_TOOLS],
		thinkingLevel: "low",
		systemPromptAppend:
			"You are an IOSM Analyst. Your job is to analyze .iosm/ artifacts, cycle reports, metrics history, and codebase evidence. Be precise and evidence-based. Report metric values, confidence levels, and risks with concrete evidence from the repository. Do not modify product source code. Do not execute shell commands.",
		mainMode: false,
	},
	iosm_verifier: {
		name: "iosm_verifier",
		label: "IOSM Verifier",
		description:
			"Post-change IOSM verification. Validates metrics and artifacts after code changes.",
		tools: ["read", "bash", "write"],
		thinkingLevel: "low",
		systemPromptAppend:
			"You are an IOSM Verifier. Run deterministic checks on the repository to verify IOSM metrics are correct and up-to-date after code changes. Update only .iosm/ artifact files. Validate JSON after edits. Keep checks bounded and focused.",
		mainMode: false,
	},
	cycle_planner: {
		name: "cycle_planner",
		label: "Cycle Planner",
		description: "Plans IOSM improvement cycles with hypotheses and goals.",
		tools: ["read", "bash", "write"],
		thinkingLevel: "medium",
		systemPromptAppend:
			"You are an IOSM Cycle Planner. Analyze the current codebase state, review the IOSM cycle report, and produce actionable improvement hypotheses. Write results to .iosm/ files. Be specific about expected metric improvements.",
		mainMode: false,
	},
		meta: {
			name: "meta",
			label: "Meta",
			description: "Orchestration-first mode. Full tools with adaptive agent/delegate execution.",
			tools: [...WRITE_ENGINEERING_TOOLS],
			thinkingLevel: "medium",
			systemPromptAppend:
				"You are in META mode. Keep full-mode capabilities and operator UX, but change execution behavior: your primary optimization target is safe parallel execution through top-level agents and nested delegates. First classify the request. For conversational or non-repository requests (quick Q&A, opinion, explanation, rewrite, translation, casual chat), do not orchestrate, do not call task, do not run repository reconnaissance, and answer directly in the user's language. Do not output internal reasoning or planning preambles; return only the final user-facing answer. The main agent is the orchestrator for the entire task and should not be the default implementer for non-trivial work. For actionable work on a codebase, do only bounded read-only recon, just enough to identify the relevant files, constraints, and independent workstreams. Then derive a detailed execution graph of tasks, agents, delegate subtasks, dependencies, writable areas, and verification steps before implementation. For any non-trivial task, orchestration is the default and single-agent execution is the exception: launch multiple top-level task calls as soon as the workstreams are known, prefer emitting them in the same assistant turn when branches are independent, and require child agents to further delegate whenever their assigned work still contains multiple independent slices. Do not keep implementing in the main agent after recon, do not make direct write/edit changes in the main agent before launching the first task call unless the work is clearly trivial and single-file, and do not collapse the whole job into one root implementation subagent when independent workstreams exist. Specialist agents should own focused workstreams rather than becoming the sole executor for the entire task. If the user requested a specific number of parallel agents or delegates, treat that fan-out as a hard target when feasible and explain the blocker precisely when it is not feasible. When the user did not specify counts, bias toward multiple smaller focused workstreams rather than one broad worker, and favor additional delegate fan-out inside each workstream when that shortens the critical path safely. Use shared memory as the default inter-agent channel: prefer scope=run keys for cross-stream state, scope=task keys for local state, and stable key namespaces such as findings/<stream>, plan/<stream>, risks/<stream>. Read before overwrite, use CAS (if_version) for contested keys, and reserve append mode for log/timeline keys only. Keep memory writes compact and deduplicated; avoid writing on every loop iteration when state has not changed. Treat code changes as incomplete until relevant tests are added or updated and targeted verification passes. Do not finalize until every launched agent and delegate has finished and their results have been synthesized. If any non-trivial part of the work remained single-agent or undelegated, explain why orchestration was not beneficial and include DELEGATION_IMPOSSIBLE with a precise reason. If no code changed and tests were skipped, explicitly justify safety. When reporting performance, speedup, scores, compliance, or conflict counts, use only observed runtime evidence (task details, shared-memory keys, test outputs, or files verified on disk); otherwise mark the metric as unknown. Never claim a report/file/path exists unless you created it in this run or confirmed it exists in the workspace.",
			mainMode: true,
		},
	full: {
		name: "full",
		label: "Full",
		description: "Full access. All tools enabled. Default engineering agent.",
		tools: [...WRITE_ENGINEERING_TOOLS],
		thinkingLevel: "medium",
		systemPromptAppend: "",
		mainMode: true,
	},
};

export const DEFAULT_PROFILE_NAME: AgentProfileName = "full";

/** Get profile by name, falling back to full */
export function getAgentProfile(name: string | undefined): AgentProfile {
	if (!name || !(name in AGENT_PROFILES)) {
		return AGENT_PROFILES[DEFAULT_PROFILE_NAME];
	}
	return AGENT_PROFILES[name as AgentProfileName];
}

/** Check if a profile name is valid */
export function isValidProfileName(name: string): name is AgentProfileName {
	return name in AGENT_PROFILES;
}

/** Get all profile names for help display */
export function getProfileNames(): AgentProfileName[] {
	return Object.keys(AGENT_PROFILES) as AgentProfileName[];
}

/** Profiles visible in main operator UX (Shift+Tab / mode switching). */
export function getMainProfileNames(): AgentProfileName[] {
	return getProfileNames().filter((name) => AGENT_PROFILES[name].mainMode === true);
}

export function isReadOnlyProfileName(name: string | undefined): boolean {
	return !!name && READ_ONLY_PROFILE_SET.has(name as AgentProfileName);
}

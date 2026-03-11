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
] as const;

const WRITE_ENGINEERING_TOOLS = ["read", "bash", "edit", "write", ...READ_EXPLORATION_TOOLS.slice(1)] as const;

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
		tools: ["read", "bash", ...READ_EXPLORATION_TOOLS.slice(1)],
		thinkingLevel: "medium",
		systemPromptAppend:
			"You are in PLAN mode. Explore the codebase thoroughly, then produce a detailed implementation plan. Do NOT write or edit any files. Output a structured plan with steps, risks, and trade-offs. Pause and ask the user to confirm before implementing.",
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
		description: "Analyzes IOSM artifacts and metrics. Read + bash only.",
		tools: ["read", "bash", ...READ_EXPLORATION_TOOLS.slice(1)],
		thinkingLevel: "low",
		systemPromptAppend:
			"You are an IOSM Analyst. Your job is to analyze .iosm/ artifacts, cycle reports, metrics history, and codebase evidence. Be precise and evidence-based. Report metric values, confidence levels, and risks with concrete evidence from the repository. Do not modify product source code.",
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
			"You are in META mode. Use full tool access, but run an orchestration-first execution contract for actionable engineering work: (1) analyze repository/context first when a codebase exists, (2) decompose work into explicit tasks/delegates with dependencies, (3) execute adaptively (simple requests may stay single-agent; for medium/complex requests you MUST invoke the task tool and bias toward parallel delegates with delegate_parallel_hint based on complexity), (4) enforce verification gates for code/test changes by adding or updating relevant tests and running targeted test commands, and (5) finalize only after all launched agents/delegates have completed and outputs are synthesized. If non-trivial work stayed single-agent, explain why delegation was not beneficial. If no code changed and tests were skipped, explicitly justify why skipping tests is safe.",
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

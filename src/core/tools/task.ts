import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getTeamRun, updateTeamTaskStatus } from "../agent-teams.js";
import {
	buildRetrospectiveDirective,
	classifyFailureCause,
	formatFailureCauseCounts,
	isRetrospectiveRetryable,
	type FailureCause,
} from "../failure-retrospective.js";
import {
	MAX_ORCHESTRATION_AGENTS,
	MAX_ORCHESTRATION_PARALLEL,
	MAX_SUBAGENT_DELEGATE_PARALLEL,
	MAX_SUBAGENT_DELEGATION_DEPTH,
	MAX_SUBAGENT_DELEGATIONS_PER_TASK,
} from "../orchestration-limits.js";
import {
	AGENT_PROFILES,
	isReadOnlyProfileName,
	isValidProfileName,
	type AgentProfileName,
} from "../agent-profiles.js";
import type { SharedMemoryContext } from "../shared-memory.js";
import type { CustomSubagentDefinition } from "../subagents.js";

/**
 * Callback type passed in from sdk.ts to avoid circular imports.
 * Spawns a sub-session and runs it to completion, returning the final text output.
 */
export type SubagentRunResult = {
	output: string;
	sessionId?: string;
	stats?: {
		toolCallsStarted: number;
		toolCallsCompleted: number;
		assistantMessages: number;
	};
};

export type TaskToolProgressPhase = "queued" | "starting" | "running" | "responding";

export type TaskDelegateProgressStatus = "pending" | "running" | "done" | "failed";

export interface TaskDelegateProgressItem {
	index: number;
	description: string;
	profile: string;
	status: TaskDelegateProgressStatus;
}

export interface TaskToolProgress {
	kind: "subagent_progress";
	phase: TaskToolProgressPhase;
	message: string;
	cwd?: string;
	activeTool?: string;
	toolCallsStarted?: number;
	toolCallsCompleted?: number;
	assistantMessages?: number;
	delegateIndex?: number;
	delegateTotal?: number;
	delegateDescription?: string;
	delegateProfile?: string;
	delegateItems?: TaskDelegateProgressItem[];
}

export type SubagentRunner = (options: {
	systemPrompt: string;
	profileName?: string;
	tools: string[];
	prompt: string;
	cwd: string;
	modelOverride?: string;
	sharedMemoryContext?: SharedMemoryContext;
	signal?: AbortSignal;
	onProgress?: (progress: TaskToolProgress) => void;
}) => Promise<string | SubagentRunResult>;

const taskSchema = Type.Object({
	description: Type.Optional(
		Type.String({
			description:
				"Optional short 3-5 word description of what the subagent will do. If omitted, it is derived from prompt.",
		}),
	),
	task: Type.Optional(
		Type.String({
			description:
				"Legacy alias for prompt. If provided, it is treated as the subagent prompt when prompt is omitted.",
		}),
	),
	args: Type.Optional(
		Type.String({
			description:
				"Legacy alias for prompt used by some models. If provided, it is treated as the subagent prompt when prompt/task are omitted.",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			description:
				"Optional full task prompt for the subagent. If omitted, the description is used as the prompt.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description: "Optional custom subagent name loaded from .iosm/agents or global agents directory.",
		}),
	),
	profile: Type.Optional(
		Type.String({
			description:
				"Optional subagent capability profile. Defaults to full when omitted. Recommended values: explore, plan, iosm, meta, iosm_analyst, iosm_verifier, cycle_planner, full. For custom agents, pass the agent name via `agent`, not `profile`.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Optional working directory for this subagent. Relative paths are resolved from the current workspace.",
		}),
	),
	lock_key: Type.Optional(
		Type.String({
			description:
				"Optional logical lock key for write serialization (e.g. src/api/**). Agents with the same lock key run write phases sequentially.",
		}),
	),
	run_id: Type.Optional(
		Type.String({
			description:
				"Optional orchestration run id (from /orchestrate or /swarm). Use with task_id so the team board can track status. When omitted, task mode uses an internal run id for shared-memory collaboration within this task execution.",
		}),
	),
	task_id: Type.Optional(
		Type.String({
			description:
				"Optional orchestration task id (for example task_1). Use with run_id to update the team board. When omitted, task mode uses an internal task id so task-scoped shared memory still works.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override for this subagent (for example anthropic/claude-sonnet-4 or model id).",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run subagent in background and return immediately with run id. Use for detached async runs; orchestrated run_id/task_id calls execute foreground for deterministic coordination. Background mode is read-only policy by default.",
		}),
	),
	isolation: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
			description:
				"Optional isolation mode. Set to worktree to run this subagent in a temporary git worktree.",
		}),
	),
	delegate_parallel_hint: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_SUBAGENT_DELEGATE_PARALLEL,
			description:
				"Optional hint for intra-task delegation fan-out. Higher value allows more delegated subtasks to run in parallel inside a single task execution.",
		}),
	),
});

export type TaskToolInput = Static<typeof taskSchema>;

/** Details attached to the tool result for UI display */
export interface TaskToolDetails {
	profile: string;
	description: string;
	outputLength: number;
	cwd: string;
	agent?: string;
	lockKey?: string;
	runId?: string;
	taskId?: string;
	model?: string;
	subagentSessionId?: string;
	transcriptPath?: string;
	isolation?: "none" | "worktree";
	worktreePath?: string;
	waitMs?: number;
	background?: boolean;
	backgroundStatusPath?: string;
	toolCallsStarted?: number;
	toolCallsCompleted?: number;
	assistantMessages?: number;
	delegatedTasks?: number;
	delegatedSucceeded?: number;
	delegatedFailed?: number;
	retrospectiveAttempts?: number;
	retrospectiveRecovered?: number;
	failureCauses?: Partial<Record<FailureCause, number>>;
}

export interface TaskToolOptions {
	resolveCustomSubagent?: (name: string) => CustomSubagentDefinition | undefined;
	availableCustomSubagents?: string[];
	availableCustomSubagentHints?: Array<{ name: string; description: string }>;
	/** Returns pending live meta updates entered during an active run. */
	getMetaMessages?: () => readonly string[];
	/** Active profile of the host session that is invoking the task tool (static fallback). */
	hostProfileName?: string;
	/** Returns active profile of the host session dynamically (preferred over static fallback when provided). */
	getHostProfileName?: () => string | undefined;
}

/** Tool names available per profile (kept in sync with AGENT_PROFILES). */
const toolsByProfile: Record<AgentProfileName, string[]> = Object.values(AGENT_PROFILES).reduce(
	(acc, profile) => {
		acc[profile.name] = [...profile.tools];
		return acc;
	},
	{} as Record<AgentProfileName, string[]>,
);

/** System prompt injected per profile */
const systemPromptByProfile: Record<string, string> = {
	explore:
		"You are a fast read-only codebase explorer. Answer concisely. Never write or edit files.",
	plan: "You are a technical architect. Analyze the codebase and produce a clear implementation plan. Do not write or edit files.",
	iosm: "You are an IOSM execution agent. Use IOSM methodology and keep IOSM artifacts synchronized with implementation.",
	meta: "You are a meta orchestration agent. Your main job is to maximize safe parallel execution through delegates, not to personally do most of the implementation. Start with bounded read-only recon, then form a concrete execution graph: subtasks, delegate subtasks, dependencies, lock domains, and verification steps. The parent agent remains responsible for orchestration and synthesis, so decompose work aggressively instead of collapsing complex work into one worker. For any non-trivial task, orchestration is required: after recon, launch multiple focused delegates instead of continuing manual implementation in the parent agent, avoid direct write/edit work in the parent agent before delegation unless the task is clearly trivial, and do not hand the whole task to one specialist child when independent workstreams exist. If a delegated workstream still contains multiple independent slices, split it again with nested <delegate_task> blocks. Default to aggressive safe parallelism. If the user requested a specific degree of parallelism, honor it when feasible or explain the exact blocker. Use shared_memory as the default coordination channel between delegates: use stable namespaced keys, prefer read-before-write, and use CAS (if_version) for contested updates; reserve append mode for timeline/log keys. When delegation is not used for non-trivial work, explain why in one line and include DELEGATION_IMPOSSIBLE. Enforce test verification for code changes, complete only after all delegated branches are resolved, and explicitly justify any no-code path where tests are skipped.",
	iosm_analyst:
		"You are an IOSM metrics analyst. Analyze .iosm/ artifacts and codebase metrics. Be precise and evidence-based.",
	iosm_verifier:
		"You are an IOSM verifier. Validate checks and update only required IOSM artifacts with deterministic reasoning.",
	cycle_planner:
		"You are an IOSM cycle planner. Propose and align cycle goals with measurable outcomes and concrete risks.",
	full: "You are a software engineering agent. Execute the task end-to-end.",
};

const writeCapableTools = new Set(["bash", "edit", "write"]);
const backgroundUnsafeTools = new Set(writeCapableTools);
const writeCapableProfiles = new Set(
	(Object.keys(toolsByProfile) as AgentProfileName[]).filter((profileName) =>
		toolsByProfile[profileName].some((tool) => writeCapableTools.has(tool)),
	),
);
const backgroundSafeProfiles = (Object.keys(toolsByProfile) as AgentProfileName[]).filter((profileName) =>
	toolsByProfile[profileName].every((tool) => !backgroundUnsafeTools.has(tool)),
);
const delegationTagName = "delegate_task";

type DelegationRequest = {
	description: string;
	profile: string;
	agent?: string;
	prompt: string;
	cwd?: string;
	lockKey?: string;
	model?: string;
	isolation?: "none" | "worktree";
	dependsOn?: number[];
};

type ParsedDelegationRequests = {
	cleanedOutput: string;
	requests: DelegationRequest[];
	warnings: string[];
};

class Semaphore {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active += 1;
			return () => this.release();
		}

		await new Promise<void>((resolve) => {
			this.queue.push(() => {
				this.active += 1;
				resolve();
			});
		});

		return () => this.release();
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		const next = this.queue.shift();
		if (next) {
			next();
		}
	}

	isIdle(): boolean {
		return this.active === 0 && this.queue.length === 0;
	}
}

class Mutex {
	private locked = false;
	private readonly waiters: Array<() => void> = [];

	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true;
			return () => this.release();
		}

		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.locked = true;
		return () => this.release();
	}

	private release(): void {
		this.locked = false;
		const next = this.waiters.shift();
		if (next) {
			next();
		}
	}

	isIdle(): boolean {
		return !this.locked && this.waiters.length === 0;
	}
}

const maxParallelFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_PARALLEL,
	MAX_ORCHESTRATION_PARALLEL,
	1,
	MAX_ORCHESTRATION_PARALLEL,
);
const subagentSemaphore = new Semaphore(maxParallelFromEnv);
const maxDelegationDepthFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATION_DEPTH,
	1,
	0,
	MAX_SUBAGENT_DELEGATION_DEPTH,
);
const maxDelegationsPerTaskFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATIONS_PER_TASK,
	MAX_SUBAGENT_DELEGATIONS_PER_TASK,
	0,
	MAX_SUBAGENT_DELEGATIONS_PER_TASK,
);
const maxDelegatedParallelFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATE_PARALLEL,
	MAX_SUBAGENT_DELEGATE_PARALLEL,
	1,
	MAX_SUBAGENT_DELEGATE_PARALLEL,
);
const emptyOutputRetriesFromEnv = parseBoundedInt(process.env.IOSM_SUBAGENT_EMPTY_OUTPUT_RETRIES, 1, 0, 2);
const retrospectiveRetriesFromEnv = parseBoundedInt(process.env.IOSM_SUBAGENT_RETRO_RETRIES, 1, 0, 1);
const orchestrationDependencyWaitTimeoutMsFromEnv = parseBoundedInt(
	process.env.IOSM_ORCHESTRATION_DEPENDENCY_WAIT_TIMEOUT_MS,
	120_000,
	5_000,
	900_000,
);
const orchestrationDependencyPollMsFromEnv = parseBoundedInt(
	process.env.IOSM_ORCHESTRATION_DEPENDENCY_POLL_MS,
	150,
	50,
	2_000,
);
const maxDelegatedOutputCharsFromEnv = parseBoundedInt(process.env.IOSM_SUBAGENT_DELEGATED_OUTPUT_MAX_CHARS, 6000, 500, 20_000);
const maxMetaUpdatesPerCheckpoint = parseBoundedInt(process.env.IOSM_SUBAGENT_META_MAX_ITEMS, 5, 1, 20);
const maxMetaUpdateChars = parseBoundedInt(process.env.IOSM_SUBAGENT_META_MAX_CHARS, 600, 100, 4000);
const orchestrationSemaphores = new Map<string, Semaphore>();
const cwdWriteLocks = new Map<string, Mutex>();

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = raw ? Number.parseInt(raw, 10) : fallback;
	if (!Number.isInteger(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function shouldAutoDelegate(input: { profile?: string; agentName?: string; hostProfile?: string }): boolean {
	const profile = input.profile?.trim().toLowerCase();
	if (profile === "meta") return true;
	const hostProfile = input.hostProfile?.trim().toLowerCase();
	if (hostProfile === "meta") return true;
	const agentName = input.agentName?.trim().toLowerCase();
	return !!agentName && agentName.includes("orchestrator");
}

function deriveAutoDelegateParallelHint(
	profile: string | undefined,
	agentName: string | undefined,
	hostProfile: string | undefined,
	description: string,
	prompt: string,
): number | undefined {
	const normalizedProfile = profile?.trim().toLowerCase();
	const isMetaProfile = normalizedProfile === "meta";
	const isMetaHost = hostProfile?.trim().toLowerCase() === "meta";
	if (!shouldAutoDelegate({ profile: normalizedProfile, agentName, hostProfile })) return undefined;
	const text = `${description}\n${prompt}`.trim();
	if (!text) return 1;
	const normalized = text.replace(/\s+/g, " ").trim();
	const words = normalized.length > 0 ? normalized.split(/\s+/).length : 0;
	const clauses = normalized
		.split(/[.;:,\n]+/g)
		.map((item) => item.trim())
		.filter((item) => item.length > 0).length;
	const pathLikeMatches = normalized.match(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g) ?? [];
	const fileLikeMatches = normalized.match(/\b[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}\b/g) ?? [];
	const listMarkers = text.match(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g)?.length ?? 0;
	const hasCodeBlock = text.includes("```");
	const actionTokenMatches =
		normalized.match(
			/\b(?:audit|security|auth|rbac|sqli|sql|injection|fix|implement|refactor|migrat|harden|verify|test|scan|orchestrate|parallel|delegate|bug|vulnerab)\w*/gi,
		) ?? [];
	const strongActionSignal = new Set(actionTokenMatches.map((token) => token.toLowerCase())).size >= 2;
	const metaOrchestratorContext = isMetaProfile || isMetaHost;

	let score = 0;
	if (words >= 40) {
		score += 2;
	} else if (words >= 20) {
		score += 1;
	}
	if (clauses >= 5) {
		score += 2;
	} else if (clauses >= 3) {
		score += 1;
	}
	if (listMarkers >= 2) {
		score += 1;
	}
	const referenceCount = pathLikeMatches.length + fileLikeMatches.length;
	const metaNonTrivialSignal =
		words >= 12 ||
		clauses >= 3 ||
		listMarkers >= 1 ||
		referenceCount >= 1 ||
		hasCodeBlock ||
		(strongActionSignal && words >= 4);
	if (referenceCount >= 3 || (referenceCount >= 1 && words >= 20)) {
		score += 1;
	}
	if (hasCodeBlock) {
		score += 1;
	}
	if (metaOrchestratorContext) {
		// In meta orchestration, require delegation pressure for non-trivial prompts
		// even when lexical scoring is still low.
		if (score === 0) {
			if (strongActionSignal && words >= 4) {
				score = 1;
			} else if (metaNonTrivialSignal) {
				score = 2;
			}
		} else if (score > 0) {
			score += 1;
		}
	}

	if (score >= 6) return 10;
	if (score >= 5) return 8;
	if (score >= 4) return 6;
	if (score >= 3) return 4;
	if (score >= 2) return 3;
	if (score >= 1) return 2;
	return 1;
}

function normalizeSpacing(text: string): string {
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function deriveTaskDescriptionFromPrompt(prompt: string): string {
	const firstMeaningfulLine =
		prompt
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "Run subtask";
	const normalized = firstMeaningfulLine
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= 80) {
		return normalized;
	}
	return `${normalized.slice(0, 77).trimEnd()}...`;
}

function normalizeTaskPayload(input: { description?: string; task?: string; args?: string; prompt?: string }): {
	description: string;
	prompt: string;
} {
	const rawDescription = input.description?.trim();
	const rawTask = input.task?.trim();
	const rawArgs = input.args?.trim();
	const rawPrompt = input.prompt?.trim() || rawTask || rawArgs;
	if (rawDescription && rawPrompt) {
		return { description: rawDescription, prompt: rawPrompt };
	}
	if (rawDescription) {
		return { description: rawDescription, prompt: rawDescription };
	}
	if (rawPrompt) {
		return {
			description: deriveTaskDescriptionFromPrompt(rawPrompt),
			prompt: rawPrompt,
		};
	}
	throw new Error('Task tool requires at least one of "description", "task", "args", or "prompt".');
}

function cloneDelegateItems(items: TaskDelegateProgressItem[] | undefined): TaskDelegateProgressItem[] | undefined {
	return items ? items.map((item) => ({ ...item })) : undefined;
}

function formatMetaCheckpoint(metaMessages: readonly string[] | undefined): {
	section: string | undefined;
	appliedCount: number;
} {
	if (!metaMessages || metaMessages.length === 0) {
		return { section: undefined, appliedCount: 0 };
	}
	const normalized = metaMessages
		.map((item) => item.replace(/\s+/g, " ").trim())
		.filter((item) => item.length > 0)
		.slice(-maxMetaUpdatesPerCheckpoint)
		.map((item) => (item.length > maxMetaUpdateChars ? `${item.slice(0, maxMetaUpdateChars - 3)}...` : item));

	if (normalized.length === 0) {
		return { section: undefined, appliedCount: 0 };
	}

	const lines = normalized.map((item, index) => `${index + 1}. ${item}`).join("\n");
	return {
		section: [
			"[META_UPDATES]",
			"Live user updates captured during execution. Apply them in this subtask if relevant.",
			"If conflicts exist, prioritize later items.",
			lines,
			"[/META_UPDATES]",
		].join("\n"),
		appliedCount: normalized.length,
	};
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return /aborted/i.test(error.message);
	}
	if (typeof error === "string") {
		return /aborted/i.test(error);
	}
	return false;
}

function mergeRunStats(
	base: SubagentRunResult["stats"] | undefined,
	next: SubagentRunResult["stats"] | undefined,
): SubagentRunResult["stats"] | undefined {
	if (!base && !next) return undefined;
	return {
		toolCallsStarted: (base?.toolCallsStarted ?? 0) + (next?.toolCallsStarted ?? 0),
		toolCallsCompleted: (base?.toolCallsCompleted ?? 0) + (next?.toolCallsCompleted ?? 0),
		assistantMessages: (base?.assistantMessages ?? 0) + (next?.assistantMessages ?? 0),
	};
}

function buildDelegationProtocolPrompt(
	depthRemaining: number,
	maxDelegations: number,
	minDelegationsPreferred = 0,
): string {
	if (depthRemaining <= 0) {
		return [
			`Delegation protocol: depth limit reached.`,
			`Do not emit <${delegationTagName}> blocks.`,
		].join("\n");
	}
	if (minDelegationsPreferred > 0) {
		const required = Math.min(Math.max(1, minDelegationsPreferred), maxDelegations);
		return [
			`Delegation protocol (required for this run): emit at least ${required} XML block(s) when the assigned work still contains independent slices.`,
			`For broad audit, implementation, or verification tasks, split by subsystem, file family, or verification stream instead of producing one monolithic answer.`,
			`<${delegationTagName} profile="explore|plan|iosm|meta|iosm_analyst|iosm_verifier|cycle_planner|full" agent="optional custom subagent name" description="short title" cwd="optional relative path" lock_key="optional lock key" model="optional model override" isolation="none|worktree" depends_on="optional indices like 1|3">`,
			"Detailed delegated task prompt",
			`</${delegationTagName}>`,
			`Keep a brief coordinator note outside the blocks, but do not collapse the full workload into one monolithic answer.`,
			`If safe decomposition is truly impossible, output exactly one line: DELEGATION_IMPOSSIBLE: <precise reason>.`,
			`When shared_memory tools are available, exchange intermediate state through shared_memory_write/shared_memory_read instead of repeating large context.`,
			`Shared-memory protocol: use stable namespaced keys (findings/<stream>, plan/<stream>, risks/<stream>).`,
			`Use scope=run for cross-stream coordination, scope=task for local scratch state, read before overwrite, and use if_version for contested updates.`,
			`Reserve mode=append for timeline/log keys only; avoid append on canonical state keys.`,
		].join("\n");
	}
	return [
		`Delegation protocol (optional): if you discover concrete independent follow-ups, emit up to ${maxDelegations} XML block(s):`,
		`<${delegationTagName} profile="explore|plan|iosm|meta|iosm_analyst|iosm_verifier|cycle_planner|full" agent="optional custom subagent name" description="short title" cwd="optional relative path" lock_key="optional lock key" model="optional model override" isolation="none|worktree" depends_on="optional indices like 1|3">`,
		"Detailed delegated task prompt",
		`</${delegationTagName}>`,
		`Only emit blocks when necessary. Keep normal analysis/answer text outside those blocks.`,
		`When shared_memory tools are available, exchange intermediate state through shared_memory_write/shared_memory_read instead of repeating large context.`,
		`Shared-memory protocol: prefer namespaced keys and read-before-write discipline; use CAS (if_version) on shared state updates.`,
		`Reserve mode=append for timeline/log keys only.`,
	].join("\n");
}

function truncateForDelegationContext(text: string, maxChars = 2200): string {
	const normalized = normalizeSpacing(text);
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(100, maxChars - 3)).trimEnd()}...`;
}

function extractDelegationWorkstreams(text: string, maxItems: number): string[] {
	if (maxItems <= 0) return [];
	const seen = new Set<string>();
	const pushUnique = (raw: string): void => {
		const cleaned = raw
			.replace(/^[-*]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.replace(/\s+/g, " ")
			.trim();
		if (cleaned.length < 5) return;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
	};

	for (const line of text.split("\n")) {
		if (!/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) continue;
		pushUnique(line);
		if (seen.size >= maxItems) break;
	}

	if (seen.size < maxItems) {
		const fragments = text
			.split(/[\n.;:]+/g)
			.map((fragment) => fragment.trim())
			.filter((fragment) => fragment.length >= 10)
			.slice(0, maxItems * 3);
		for (const fragment of fragments) {
			pushUnique(fragment);
			if (seen.size >= maxItems) break;
		}
	}

	return Array.from(seen).slice(0, maxItems);
}

function deriveAutoDelegateProfile(baseProfile: AgentProfileName, description: string, prompt: string): AgentProfileName {
	const signal = `${description}\n${prompt}`.toLowerCase();
	const writeIntent = /\b(?:implement|fix|patch|refactor|rewrite|edit|update|migrate|change|write|apply)\b/.test(signal);

	if (baseProfile === "full") return "full";
	if (baseProfile === "meta") return writeIntent ? "full" : "explore";
	if (baseProfile === "iosm") return writeIntent ? "full" : "explore";
	if (baseProfile === "iosm_verifier") return "iosm_verifier";
	if (baseProfile === "cycle_planner") return "cycle_planner";
	if (baseProfile === "plan" || baseProfile === "iosm_analyst") return "explore";
	return "explore";
}

function pickAutoDelegateAgent(workstream: string, availableCustomNames: readonly string[]): string | undefined {
	if (availableCustomNames.length === 0) return undefined;
	const normalizedWorkstream = workstream.toLowerCase();
	const names = availableCustomNames.map((name) => ({ raw: name, normalized: name.toLowerCase() }));
	const findByHint = (hints: readonly string[]): string | undefined => {
		for (const hint of hints) {
			const exact = names.find((item) => item.normalized === hint);
			if (exact) return exact.raw;
			const contains = names.find((item) => item.normalized.includes(hint));
			if (contains) return contains.raw;
		}
		return undefined;
	};

	if (/\b(?:test|qa|coverage|verification|regression)\b/.test(normalizedWorkstream)) {
		return findByHint(["qa_test_engineer", "qa", "tester", "verification"]);
	}
	if (/\b(?:ui|ux|design|layout|accessibility)\b/.test(normalizedWorkstream)) {
		return findByHint(["uiux_top_senior", "uiux", "ui", "ux", "design"]);
	}
	if (/\b(?:architecture|codebase|refactor|security|rbac|auth|database|api)\b/.test(normalizedWorkstream)) {
		return findByHint(["codebase_auditor", "architect", "security", "backend"]);
	}

	return undefined;
}

function buildAutoDelegationPrompt(input: {
	streamTitle: string;
	rootDescription: string;
	rootPrompt: string;
	ordinal: number;
	total: number;
}): string {
	const objective = truncateForDelegationContext(`${input.rootDescription}\n\n${input.rootPrompt}`);
	return normalizeSpacing([
		`Workstream ${input.ordinal}/${input.total}: ${input.streamTitle}`,
		"Scope:",
		`- Own this stream end-to-end and avoid duplicating sibling streams.`,
		`- Produce concrete findings/changes for this stream only.`,
		"Coordinator objective:",
		objective,
	].join("\n"));
}

function synthesizeDelegationRequests(input: {
	description: string;
	prompt: string;
	baseProfile: AgentProfileName;
	currentDelegates: number;
	minDelegationsPreferred: number;
	maxDelegations: number;
	availableCustomNames: readonly string[];
}): DelegationRequest[] {
	const desiredTotal = Math.max(0, Math.min(input.maxDelegations, input.minDelegationsPreferred));
	const missing = Math.max(0, desiredTotal - input.currentDelegates);
	if (missing <= 0) return [];

	const combined = `${input.description}\n${input.prompt}`.trim();
	const extracted = extractDelegationWorkstreams(combined, Math.max(missing, desiredTotal));
	const fallbackByIndex = [
		"Architecture and structure analysis",
		"Behavioral verification and tests",
		"Risk, regressions, and remediation",
		"Integration and dependency checks",
		"Delivery summary and rollout constraints",
	];
	const titles: string[] = [];
	for (const stream of extracted) {
		titles.push(stream);
		if (titles.length >= missing) break;
	}
	for (let index = 0; titles.length < missing && index < fallbackByIndex.length; index += 1) {
		titles.push(fallbackByIndex[index]!);
	}
	while (titles.length < missing) {
		titles.push(`Independent workstream ${titles.length + 1}`);
	}

	const defaultProfile = deriveAutoDelegateProfile(input.baseProfile, input.description, input.prompt);
	return titles.map((streamTitle, index) => ({
		description: `Auto: ${streamTitle}`,
		profile: defaultProfile,
		agent: pickAutoDelegateAgent(streamTitle, input.availableCustomNames),
		prompt: buildAutoDelegationPrompt({
			streamTitle,
			rootDescription: input.description,
			rootPrompt: input.prompt,
			ordinal: input.currentDelegates + index + 1,
			total: input.currentDelegates + titles.length,
		}),
		cwd: undefined,
		lockKey: undefined,
		model: undefined,
		isolation: undefined,
		dependsOn: undefined,
	}));
}

function withDelegationPrompt(
	basePrompt: string,
	depthRemaining: number,
	maxDelegations: number,
	minDelegationsPreferred = 0,
): string {
	const protocol = buildDelegationProtocolPrompt(depthRemaining, maxDelegations, minDelegationsPreferred);
	return `${basePrompt}\n\n${protocol}`;
}

function withSubagentInstructions(basePrompt: string, instructions?: string): string {
	const trimmed = instructions?.trim();
	return trimmed ? `${basePrompt}\n\n${trimmed}` : basePrompt;
}

function buildSharedMemoryGuidance(runId: string, taskId: string | undefined): string {
	return [
		"[SHARED_MEMORY]",
		`run_id: ${runId}`,
		`task_id: ${taskId ?? "(none)"}`,
		"Use shared_memory_write/shared_memory_read to exchange intermediate state across parallel agents and delegates.",
		"Guidelines:",
		"- Use scope=run for cross-agent data and scope=task for task-local notes.",
		"- Keep entries compact and key-based (for example: findings/auth, plan/step-1, risks/session).",
		"- Prefer one canonical key per stream and deduplicate updates; avoid redundant writes in loops.",
		"- Read before overwrite when collaborating on the same key.",
		"- Use if_version CAS for contested updates on shared keys.",
		"- Use mode=append only for log/timeline keys; use mode=set for canonical state.",
		"[/SHARED_MEMORY]",
	].join("\n");
}

function parseDelegationRequests(output: string, maxRequests: number): ParsedDelegationRequests {
	const requests: DelegationRequest[] = [];
	const warnings: string[] = [];
	const pattern = new RegExp(`<${delegationTagName}\\b([^>]*)>([\\s\\S]*?)<\\/${delegationTagName}>`, "gi");

	const cleaned = output.replace(pattern, (_full, attrsRaw: string, bodyRaw: string) => {
		if (maxRequests <= 0) {
			warnings.push(`Ignored delegation block: max delegated tasks per run is 0.`);
			return "";
		}
		if (requests.length >= maxRequests) {
			warnings.push(`Ignored extra delegation block: max ${maxRequests} per run.`);
			return "";
		}
		const attrs: Record<string, string> = {};
		for (const match of attrsRaw.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
			attrs[match[1].toLowerCase()] = (match[2] ?? match[3] ?? "").trim();
		}

		const prompt = normalizeSpacing(bodyRaw ?? "");
		if (!prompt) {
			warnings.push(`Ignored delegation block with empty prompt.`);
			return "";
		}
		const profileRaw = (attrs.profile ?? "explore").trim();
		if (!profileRaw) {
			warnings.push(`Ignored delegation block with empty profile.`);
			return "";
		}
		const normalizedProfile = profileRaw.toLowerCase();
		const profile = isValidProfileName(normalizedProfile) ? normalizedProfile : profileRaw;
		const isolationRaw = (attrs.isolation ?? "").trim().toLowerCase();
		const isolation =
			isolationRaw === "worktree" ? "worktree" : isolationRaw === "none" ? "none" : undefined;
		if (isolationRaw && !isolation) {
			warnings.push(`Ignored invalid isolation value "${attrs.isolation}".`);
			return "";
		}

		requests.push({
			description: (attrs.description ?? `delegated task ${requests.length + 1}`).trim(),
			profile,
			agent: attrs.agent?.trim() || undefined,
			prompt,
			cwd: attrs.cwd?.trim() || undefined,
			lockKey: attrs.lock_key?.trim() || undefined,
			model: attrs.model?.trim() || undefined,
			isolation,
			dependsOn: attrs.depends_on
				? attrs.depends_on
						.split(/[|,]/)
						.map((token) => Number.parseInt(token.trim(), 10))
						.filter((value) => Number.isInteger(value) && value > 0)
				: undefined,
		});
		return "";
	});

	return {
		requests,
		warnings,
		cleanedOutput: normalizeSpacing(cleaned),
	};
}

function isBackgroundSafeToolset(tools: readonly string[]): boolean {
	return tools.every((toolName) => !backgroundUnsafeTools.has(toolName));
}

function getCwdLockKey(cwd: string): string {
	// Normalize lock key to keep behavior consistent across path aliases.
	return path.resolve(cwd).toLowerCase();
}

function getOrCreateWriteLock(cwd: string): Mutex {
	const key = getCwdLockKey(cwd);
	const existing = cwdWriteLocks.get(key);
	if (existing) return existing;
	const created = new Mutex();
	cwdWriteLocks.set(key, created);
	return created;
}

function cleanupWriteLock(lockKey: string | undefined): void {
	if (!lockKey) return;
	const key = getCwdLockKey(lockKey);
	const existing = cwdWriteLocks.get(key);
	if (!existing || !existing.isIdle()) return;
	cwdWriteLocks.delete(key);
}

function getRunParallelLimit(cwd: string, runId: string): number | undefined {
	const teamRun = getTeamRun(cwd, runId);
	if (!teamRun) return undefined;
	if (teamRun.mode === "sequential") return 1;
	const maxParallel = teamRun.maxParallel;
	if (!Number.isInteger(maxParallel) || !maxParallel || maxParallel < 1) {
		return Math.max(1, Math.min(teamRun.agents, MAX_ORCHESTRATION_AGENTS));
	}
	return Math.max(1, Math.min(maxParallel, MAX_ORCHESTRATION_PARALLEL));
}

function getOrCreateOrchestrationSemaphore(cwd: string, runId: string): Semaphore | undefined {
	const limit = getRunParallelLimit(cwd, runId);
	if (!limit || limit < 1) return undefined;
	const key = `${path.resolve(cwd).toLowerCase()}::${runId}::${limit}`;
	const existing = orchestrationSemaphores.get(key);
	if (existing) return existing;
	const created = new Semaphore(limit);
	orchestrationSemaphores.set(key, created);
	return created;
}

function isTeamTaskTerminal(status: string | undefined): boolean {
	return status === "done" || status === "error" || status === "cancelled";
}

function cleanupOrchestrationSemaphore(cwd: string, runId: string): void {
	const prefix = `${path.resolve(cwd).toLowerCase()}::${runId}::`;
	const run = getTeamRun(cwd, runId);
	const canDeleteForRun = !run || run.tasks.every((task) => isTeamTaskTerminal(task.status));
	if (!canDeleteForRun) return;
	for (const [key, semaphore] of orchestrationSemaphores.entries()) {
		if (!key.startsWith(prefix)) continue;
		if (!semaphore.isIdle()) continue;
		orchestrationSemaphores.delete(key);
	}
}

function waitForWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	if (signal.aborted) {
		return Promise.reject(new Error("Operation aborted"));
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(new Error("Operation aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForOrchestrationDependencies(input: {
	cwd: string;
	runId: string;
	taskId: string;
	signal?: AbortSignal;
	onWaiting?: (message: string) => void;
}): Promise<void> {
	const started = Date.now();
	let lastWaiting = "";
	while (true) {
		if (input.signal?.aborted) {
			throw new Error("Operation aborted");
		}
		const run = getTeamRun(input.cwd, input.runId);
		if (!run) {
			return;
		}
		const current = run.tasks.find((task) => task.id === input.taskId);
		if (!current) {
			throw new Error(`Orchestration metadata missing task ${input.taskId} in run ${input.runId}.`);
		}
		const dependencies = current.dependsOn ?? [];
		if (dependencies.length === 0) {
			return;
		}
		const dependencyTasks = dependencies.map((id) => run.tasks.find((task) => task.id === id));
		const missing = dependencyTasks
			.map((task, index) => (task ? undefined : dependencies[index]))
			.filter((value): value is string => typeof value === "string");
		if (missing.length > 0) {
			throw new Error(
				`Orchestration metadata invalid for ${input.taskId}: missing dependency task(s) ${missing.join(", ")}.`,
			);
		}
		const failed = dependencyTasks.filter(
			(task): task is NonNullable<typeof task> => !!task && (task.status === "error" || task.status === "cancelled"),
		);
		if (failed.length > 0) {
			throw new Error(
				`Blocked by failed dependency: ${failed.map((task) => `${task.id}=${task.status}`).join(", ")}.`,
			);
		}
		const pending = dependencyTasks.filter(
			(task): task is NonNullable<typeof task> => !!task && task.status !== "done",
		);
		if (pending.length === 0) {
			return;
		}
		const waitedMs = Date.now() - started;
		if (waitedMs >= orchestrationDependencyWaitTimeoutMsFromEnv) {
			throw new Error(
				`Timed out waiting for dependencies of ${input.taskId}: ${pending
					.map((task) => `${task.id}=${task.status}`)
					.join(", ")}.`,
			);
		}
		const waiting = pending.map((task) => `${task.id}=${task.status}`).join(", ");
		if (waiting !== lastWaiting) {
			lastWaiting = waiting;
			input.onWaiting?.(waiting);
		}
		await waitForWithAbort(orchestrationDependencyPollMsFromEnv, input.signal);
	}
}

function persistSubagentTranscript(input: {
	rootCwd: string;
	runId: string;
	description: string;
	profile: string;
	agent?: string;
	lockKey?: string;
	model?: string;
	subagentCwd: string;
	sessionId?: string;
	prompt: string;
	output: string;
	isolation?: "none" | "worktree";
	worktreePath?: string;
}): string | undefined {
	try {
		const dir = path.join(input.rootCwd, ".iosm", "subagents", "runs");
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${input.runId}.md`);
		const lines = [
			"---",
			`run_id: ${input.runId}`,
			`profile: ${input.profile}`,
			`description: ${JSON.stringify(input.description)}`,
			`cwd: ${JSON.stringify(input.subagentCwd)}`,
			`agent: ${JSON.stringify(input.agent ?? "")}`,
			`lock_key: ${JSON.stringify(input.lockKey ?? "")}`,
			`model: ${JSON.stringify(input.model ?? "")}`,
			`session_id: ${JSON.stringify(input.sessionId ?? "")}`,
			`isolation: ${JSON.stringify(input.isolation ?? "none")}`,
			`worktree_path: ${JSON.stringify(input.worktreePath ?? "")}`,
			`created_at: ${new Date().toISOString()}`,
			"---",
			"",
			"## Prompt",
			"",
			input.prompt,
			"",
			"## Output",
			"",
			input.output,
			"",
		];
		writeFileSync(filePath, lines.join("\n"), "utf8");
		return filePath;
	} catch {
		return undefined;
	}
}

type BackgroundRunStatus = {
	runId: string;
	status: "queued" | "running" | "done" | "error" | "cancelled";
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	description: string;
	profile: string;
	cwd: string;
	agent?: string;
	model?: string;
	error?: string;
	transcriptPath?: string;
};

function writeBackgroundRunStatus(rootCwd: string, status: BackgroundRunStatus): string | undefined {
	try {
		const dir = path.join(rootCwd, ".iosm", "subagents", "background");
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${status.runId}.json`);
		writeFileSync(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
		return filePath;
	} catch {
		return undefined;
	}
}

function gitResult(args: string[], cwd: string): { ok: boolean; stdout: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
	};
}

function provisionWorktree(
	rootCwd: string,
	targetCwd: string,
	runId: string,
): { runCwd: string; worktreePath?: string; cleanup: () => void } {
	const insideRepo = gitResult(["rev-parse", "--is-inside-work-tree"], rootCwd);
	if (!insideRepo.ok || insideRepo.stdout !== "true") {
		return { runCwd: targetCwd, cleanup: () => {} };
	}
	const repoRootResult = gitResult(["rev-parse", "--show-toplevel"], rootCwd);
	if (!repoRootResult.ok || !repoRootResult.stdout) {
		return { runCwd: targetCwd, cleanup: () => {} };
	}

	const repoRoot = repoRootResult.stdout;
	const relative = path.relative(repoRoot, targetCwd);
	if (relative.startsWith("..")) {
		return { runCwd: targetCwd, cleanup: () => {} };
	}

	const worktreePath = path.join(rootCwd, ".iosm", "subagents", "worktrees", runId);
	mkdirSync(path.dirname(worktreePath), { recursive: true });
	const added = gitResult(["worktree", "add", "--detach", worktreePath], repoRoot);
	if (!added.ok) {
		return { runCwd: targetCwd, cleanup: () => {} };
	}

	const runCwd = path.resolve(worktreePath, relative);
	const cleanup = (): void => {
		try {
			gitResult(["worktree", "remove", "--force", worktreePath], repoRoot);
		} catch {
			// best effort
		}
		try {
			rmSync(worktreePath, { recursive: true, force: true });
		} catch {
			// best effort
		}
	};

	return { runCwd, worktreePath, cleanup };
}

/**
 * Create the Task tool using the factory pattern.
 *
 * The `runner` callback is supplied by sdk.ts to avoid a circular import:
 * sdk.ts → task.ts (tool) would otherwise import sdk.ts again.
 *
 * @param cwd  Working directory forwarded to the subagent.
 * @param runner  Callback that creates and runs a sub-session.
 */
export function createTaskTool(
	cwd: string,
	runner: SubagentRunner,
	options?: TaskToolOptions,
): AgentTool<typeof taskSchema> {
	const customAgentsSnippet =
		options?.availableCustomSubagentHints && options.availableCustomSubagentHints.length > 0
			? ` Available custom agents: ${options.availableCustomSubagentHints
					.map((item) => `${item.name} (${item.description})`)
					.join(", ")}.`
			: options?.availableCustomSubagents && options.availableCustomSubagents.length > 0
				? ` Available custom agents: ${options.availableCustomSubagents.join(", ")}.`
			: "";
	return {
		name: "task",
		label: "task",
		description:
			"Launch a specialized subagent to handle a subtask in isolation. " +
			"Use for: codebase exploration (profile=explore), architectural planning (profile=plan), " +
			"IOSM artifact analysis (profile=iosm_analyst/iosm_verifier/cycle_planner), orchestration-first execution (profile=meta), or end-to-end implementation (profile=full). " +
			"Set cwd to isolate subagents into different project areas when orchestrating parallel work. " +
			"The subagent runs to completion and returns its full text output. " +
			"It may request bounded follow-up delegation via <delegate_task> blocks that are executed by the parent task tool." +
			customAgentsSnippet,
		parameters: taskSchema,
		execute: async (
			_toolCallId: string,
			{
				description: rawDescription,
				task: rawTask,
				args: rawArgs,
				prompt: rawPrompt,
				agent: agentName,
				profile,
				cwd: targetCwd,
				lock_key: lockKey,
				run_id: orchestrationRunId,
				task_id: orchestrationTaskId,
				model: requestedModel,
				background,
				isolation,
				delegate_parallel_hint: delegateParallelHint,
			}: TaskToolInput,
			_signal?: AbortSignal,
			onUpdate?,
		) => {
			const updateTrackedTaskStatus = (status: "running" | "done" | "error" | "cancelled"): void => {
				if (!orchestrationRunId || !orchestrationTaskId) return;
				updateTeamTaskStatus({
					cwd,
					runId: orchestrationRunId,
					taskId: orchestrationTaskId,
					status,
				});
			};
			const throwIfAborted = (): void => {
				if (_signal?.aborted) {
					updateTrackedTaskStatus("cancelled");
					throw new Error("Operation aborted");
				}
			};
			const { description, prompt } = normalizeTaskPayload({
				description: rawDescription,
				task: rawTask,
				args: rawArgs,
				prompt: rawPrompt,
			});

				const runId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
				const sharedMemoryRunId = orchestrationRunId?.trim() || runId;
				const sharedMemoryTaskId = orchestrationTaskId?.trim() || runId;
				const availableCustomNames = options?.availableCustomSubagents ?? [];
				const resolveCustom = (name: string | undefined): CustomSubagentDefinition | undefined => {
					if (!name || !options?.resolveCustomSubagent) return undefined;
					const trimmed = name.trim();
					if (!trimmed) return undefined;
					const resolved = options.resolveCustomSubagent(trimmed);
					if (resolved) return resolved;
					const lowered = trimmed.toLowerCase();
					if (lowered !== trimmed) {
						return options.resolveCustomSubagent(lowered);
					}
					return undefined;
				};

					let normalizedAgentName = agentName?.trim() || undefined;
					let customSubagent = resolveCustom(normalizedAgentName);
					const requestedProfileRaw = profile?.trim() || undefined;
					const normalizedHostProfile =
						options?.getHostProfileName?.()?.trim().toLowerCase() ?? options?.hostProfileName?.trim().toLowerCase();
					const hostProfileFallback =
						normalizedHostProfile && isValidProfileName(normalizedHostProfile) ? normalizedHostProfile : "full";
					let normalizedProfile =
						requestedProfileRaw?.toLowerCase() ||
						customSubagent?.profile?.trim().toLowerCase() ||
						hostProfileFallback;

				if (normalizedAgentName && !customSubagent) {
					const available =
						availableCustomNames.length > 0 ? ` Available custom agents: ${availableCustomNames.join(", ")}.` : "";
					throw new Error(`Unknown subagent: ${normalizedAgentName}.${available}`);
				}

					// Recovery path: if model placed a custom agent name into `profile`, remap automatically.
					if (!customSubagent) {
						const profileAsAgent = resolveCustom(normalizedProfile);
						if (profileAsAgent) {
						customSubagent = profileAsAgent;
						normalizedAgentName = profileAsAgent.name;
							normalizedProfile = (profileAsAgent.profile ?? "full").trim().toLowerCase();
						}
					}

					if (!customSubagent && !isValidProfileName(normalizedProfile)) {
						throw new Error(
							`Unknown profile "${requestedProfileRaw ?? normalizedProfile}". Valid profiles: ${Object.keys(
								toolsByProfile,
							).join(", ")}.`,
						);
					}

				const effectiveProfileCandidate = (customSubagent?.profile ?? normalizedProfile).trim().toLowerCase();
				if (!isValidProfileName(effectiveProfileCandidate)) {
					throw new Error(
						`Invalid resolved profile "${effectiveProfileCandidate}". Valid profiles: ${Object.keys(
							toolsByProfile,
						).join(", ")}.`,
					);
				}
					const effectiveProfile = effectiveProfileCandidate as AgentProfileName;
				let tools = customSubagent?.tools
					? [...customSubagent.tools]
					: [...toolsByProfile[effectiveProfile]];
				if (customSubagent?.disallowedTools?.length) {
					const blocked = new Set(customSubagent.disallowedTools);
					tools = tools.filter((tool) => !blocked.has(tool));
				}
					if (isReadOnlyProfileName(normalizedHostProfile) && tools.some((tool) => writeCapableTools.has(tool))) {
						throw new Error(
							`Host profile "${normalizedHostProfile}" is read-only. Switch to full/meta/iosm to launch write-capable subtasks.`,
						);
					}
				const delegationDepth = maxDelegationDepthFromEnv;
					const requestedDelegateParallelHint =
						typeof delegateParallelHint === "number" && Number.isInteger(delegateParallelHint)
							? Math.max(1, Math.min(MAX_SUBAGENT_DELEGATE_PARALLEL, delegateParallelHint))
							: undefined;
				const autoDelegateParallelHint =
					requestedDelegateParallelHint === undefined
						? deriveAutoDelegateParallelHint(
								effectiveProfile,
								normalizedAgentName,
								normalizedHostProfile,
								description,
								prompt,
							)
						: undefined;
				let effectiveDelegateParallelHint = requestedDelegateParallelHint ?? autoDelegateParallelHint;
				const effectiveDelegationDepth =
					effectiveProfile === "meta" || normalizedHostProfile === "meta" || normalizedAgentName?.toLowerCase().includes("orchestrator")
						? Math.max(delegationDepth, 2)
						: delegationDepth;
				const strictDelegationContract =
					effectiveProfile === "meta" ||
					normalizedHostProfile === "meta" ||
					normalizedAgentName?.toLowerCase().includes("orchestrator");
				let effectiveMaxDelegations = Math.max(
					0,
					Math.min(maxDelegationsPerTaskFromEnv, effectiveDelegateParallelHint ?? maxDelegationsPerTaskFromEnv),
				);
				let effectiveMaxDelegateParallel = Math.max(
					1,
					Math.min(maxDelegatedParallelFromEnv, effectiveDelegateParallelHint ?? maxDelegatedParallelFromEnv),
				);
				const preferredDelegationFloor = effectiveProfile === "meta" || normalizedHostProfile === "meta" ? 3 : 2;
				const applyMetaDelegationFloor =
					requestedDelegateParallelHint === undefined &&
					(effectiveProfile === "meta" || normalizedHostProfile === "meta");
				if (applyMetaDelegationFloor) {
					effectiveMaxDelegations = Math.max(
						effectiveMaxDelegations,
						Math.min(maxDelegationsPerTaskFromEnv, preferredDelegationFloor),
					);
					effectiveMaxDelegateParallel = Math.max(
						effectiveMaxDelegateParallel,
						Math.min(maxDelegatedParallelFromEnv, preferredDelegationFloor),
					);
				}
				const minDelegationsPreferred =
					(effectiveDelegateParallelHint ?? 0) >= 2 && effectiveMaxDelegations >= 2
						? Math.min(preferredDelegationFloor, effectiveMaxDelegations, effectiveDelegateParallelHint ?? preferredDelegationFloor)
						: 0;
			const baseSystemPrompt = withSubagentInstructions(
				customSubagent?.systemPrompt ??
					systemPromptByProfile[effectiveProfile] ??
					systemPromptByProfile.full,
				customSubagent?.instructions,
			);
			const systemPrompt = withDelegationPrompt(
				baseSystemPrompt,
				effectiveDelegationDepth,
				effectiveMaxDelegations,
				minDelegationsPreferred,
			);
			const promptWithInstructions = prompt;
			const effectiveModelOverride = requestedModel?.trim() || customSubagent?.model?.trim() || undefined;
			const requestedBackground = background === true || customSubagent?.background === true;
			const trackedOrchestrationRun =
				orchestrationRunId && orchestrationTaskId ? getTeamRun(cwd, orchestrationRunId) : undefined;
			// Deterministic orchestration UX: run tracked team tasks in foreground so the parent turn
			// naturally waits for subagents and aggregates their outputs without ad-hoc polling.
			const runInBackground = trackedOrchestrationRun ? false : requestedBackground;
			const requestedSubagentCwd = targetCwd
				? path.resolve(cwd, targetCwd)
				: customSubagent?.cwd ?? cwd;
			if (!existsSync(requestedSubagentCwd) || !statSync(requestedSubagentCwd).isDirectory()) {
				throw new Error(`Subagent cwd does not exist or is not a directory: ${requestedSubagentCwd}`);
			}
			if (runInBackground && !isBackgroundSafeToolset(tools)) {
				throw new Error(
					`Background policy violation: profile "${effectiveProfile}" has mutable tools (${tools
						.filter((toolName) => backgroundUnsafeTools.has(toolName))
						.join(", ")}). Background mode requires read-only toolsets. Safe baseline profiles: ${backgroundSafeProfiles.join(", ")}.`,
				);
			}
			const useWorktree = isolation === "worktree";

			const queuedAt = Date.now();
			let latestProgress: TaskToolProgress | undefined;
			const emitProgress = (incoming: TaskToolProgress): void => {
				const activeTool = "activeTool" in incoming ? incoming.activeTool : latestProgress?.activeTool;
				const delegateIndex = "delegateIndex" in incoming ? incoming.delegateIndex : latestProgress?.delegateIndex;
				const delegateTotal = "delegateTotal" in incoming ? incoming.delegateTotal : latestProgress?.delegateTotal;
				const delegateDescription =
					"delegateDescription" in incoming ? incoming.delegateDescription : latestProgress?.delegateDescription;
				const delegateProfile =
					"delegateProfile" in incoming ? incoming.delegateProfile : latestProgress?.delegateProfile;
				const delegateItems =
					"delegateItems" in incoming
						? cloneDelegateItems(incoming.delegateItems)
						: cloneDelegateItems(latestProgress?.delegateItems);
				const merged: TaskToolProgress = {
					kind: "subagent_progress",
					phase: incoming.phase,
					message: incoming.message,
					cwd: incoming.cwd ?? latestProgress?.cwd ?? requestedSubagentCwd,
					activeTool,
					toolCallsStarted: incoming.toolCallsStarted ?? latestProgress?.toolCallsStarted,
					toolCallsCompleted: incoming.toolCallsCompleted ?? latestProgress?.toolCallsCompleted,
					assistantMessages: incoming.assistantMessages ?? latestProgress?.assistantMessages,
					delegateIndex,
					delegateTotal,
					delegateDescription,
					delegateProfile,
					delegateItems,
				};
				latestProgress = merged;
				if (!onUpdate) return;
				onUpdate({
					content: [{ type: "text" as const, text: merged.message }],
					details: { progress: merged },
				});
			};
			throwIfAborted();
			emitProgress({
				kind: "subagent_progress",
				phase: "queued",
				message: "queued",
				cwd: requestedSubagentCwd,
				toolCallsStarted: 0,
				toolCallsCompleted: 0,
				assistantMessages: 0,
			});

				const executeSubagent = async (): Promise<{ text: string; details: TaskToolDetails }> => {
					let releaseRunSlot: (() => void) | undefined;
					let releaseSlot: (() => void) | undefined;
					let releaseWriteLock: (() => void) | undefined;
					let releaseIsolation: (() => void) | undefined;
					const explicitRootLockKey = lockKey?.trim();
					let subagentCwd = requestedSubagentCwd;
					let worktreePath: string | undefined;
					let runStats: SubagentRunResult["stats"] | undefined;
					const heldWriteLocks = new Map<string, { count: number; release: () => void }>();
					const acquireLocalWriteLock = async (rawLockKey: string | undefined): Promise<(() => void) | undefined> => {
						const trimmed = rawLockKey?.trim();
						if (!trimmed) return undefined;
						const normalizedKey = getCwdLockKey(trimmed);
						const existing = heldWriteLocks.get(normalizedKey);
						if (existing) {
							existing.count += 1;
							return () => {
								const current = heldWriteLocks.get(normalizedKey);
								if (!current) return;
								current.count -= 1;
								if (current.count <= 0) {
									heldWriteLocks.delete(normalizedKey);
									current.release();
									cleanupWriteLock(trimmed);
								}
							};
						}
						const lock = getOrCreateWriteLock(trimmed);
						const release = await lock.acquire();
						heldWriteLocks.set(normalizedKey, { count: 1, release });
						return () => {
							const current = heldWriteLocks.get(normalizedKey);
							if (!current) return;
							current.count -= 1;
							if (current.count <= 0) {
								heldWriteLocks.delete(normalizedKey);
								current.release();
								cleanupWriteLock(trimmed);
							}
						};
					};
					try {
					throwIfAborted();
					if (orchestrationRunId && orchestrationTaskId) {
						try {
							await waitForOrchestrationDependencies({
								cwd,
								runId: orchestrationRunId,
								taskId: orchestrationTaskId,
								signal: _signal,
								onWaiting: (waiting) => {
									emitProgress({
										kind: "subagent_progress",
										phase: "queued",
										message: `waiting for dependencies: ${waiting}`,
										cwd: requestedSubagentCwd,
										activeTool: undefined,
									});
								},
							});
							} catch (error) {
								if (_signal?.aborted || isAbortError(error)) {
									updateTrackedTaskStatus("cancelled");
									throw new Error("Operation aborted");
								}
								const message = error instanceof Error ? error.message : String(error);
								const cause = classifyFailureCause(message);
								updateTrackedTaskStatus("error");
								const details: TaskToolDetails = {
									profile: effectiveProfile,
									description,
									outputLength: 0,
									cwd: requestedSubagentCwd,
									agent: customSubagent?.name,
									lockKey: lockKey?.trim() || undefined,
									runId,
									taskId: orchestrationTaskId,
									model: effectiveModelOverride,
									isolation: useWorktree ? "worktree" : "none",
									worktreePath,
									waitMs: Date.now() - queuedAt,
									background: runInBackground,
									failureCauses: { [cause]: 1 },
								};
								throw Object.assign(new Error(`Subagent failed: ${message}`), { details });
							}
						}
					const orchestrationSemaphore =
						orchestrationRunId && orchestrationTaskId
							? getOrCreateOrchestrationSemaphore(cwd, orchestrationRunId)
							: undefined;
					if (orchestrationSemaphore) {
						releaseRunSlot = await orchestrationSemaphore.acquire();
						throwIfAborted();
					}
					releaseSlot = await subagentSemaphore.acquire();
					throwIfAborted();
					updateTrackedTaskStatus("running");
						if (writeCapableProfiles.has(effectiveProfile)) {
							// Parallel orchestration should remain truly parallel by default.
							// Serialize write-capable agents only when an explicit lock_key is provided.
							if (explicitRootLockKey) {
								releaseWriteLock = await acquireLocalWriteLock(explicitRootLockKey);
							}
						}
					if (useWorktree) {
						const isolated = provisionWorktree(cwd, requestedSubagentCwd, runId);
						subagentCwd = isolated.runCwd;
						worktreePath = isolated.worktreePath;
						releaseIsolation = isolated.cleanup;
					}
					emitProgress({
						kind: "subagent_progress",
						phase: "starting",
						message: "starting subagent",
						cwd: subagentCwd,
						activeTool: undefined,
					});

						let output: string;
						let subagentSessionId: string | undefined;
						let delegatedTasks = 0;
						let delegatedSucceeded = 0;
						let delegatedFailed = 0;
						let retrospectiveAttempts = 0;
						let retrospectiveRecovered = 0;
						const delegationWarnings: string[] = [];
						const delegatedSections: Array<string | undefined> = [];
						const failureCauses: Partial<Record<FailureCause, number>> = {};
						const delegatedStats = {
							toolCallsStarted: 0,
							toolCallsCompleted: 0,
							assistantMessages: 0,
						};
						const recordFailureCause = (cause: FailureCause): void => {
							failureCauses[cause] = (failureCauses[cause] ?? 0) + 1;
						};
						const rootSharedMemoryContext: SharedMemoryContext = {
							rootCwd: cwd,
							runId: sharedMemoryRunId,
							taskId: sharedMemoryTaskId,
							profile: effectiveProfile,
						};
						try {
							const runRootPass = async (runPrompt: string): Promise<{
								output: string;
								sessionId?: string;
								stats?: SubagentRunResult["stats"];
							}> => {
								let emptyAttempt = 0;
								let retrospectiveAttempt = 0;
								let mergedStats: SubagentRunResult["stats"] | undefined;
								let sessionId: string | undefined;
								let promptForAttempt = runPrompt;
								while (true) {
									try {
										const result = await runner({
											systemPrompt,
											profileName: effectiveProfile,
											tools,
											prompt: promptForAttempt,
											cwd: subagentCwd,
											modelOverride: effectiveModelOverride,
											sharedMemoryContext: rootSharedMemoryContext,
											signal: _signal,
											onProgress: (progress) => emitProgress(progress),
										});
										throwIfAborted();

										let attemptOutput: string;
										let attemptStats: SubagentRunResult["stats"] | undefined;
										if (typeof result === "string") {
											attemptOutput = result;
										} else {
											attemptOutput = result.output;
											attemptStats = result.stats;
											sessionId = result.sessionId ?? sessionId;
										}
										mergedStats = mergeRunStats(mergedStats, attemptStats);
										if (attemptOutput.trim().length > 0) {
											if (retrospectiveAttempt > 0) {
												retrospectiveRecovered += 1;
											}
											return {
												output: attemptOutput,
												sessionId,
												stats: mergedStats,
											};
										}
										if (emptyAttempt >= emptyOutputRetriesFromEnv) {
											const totalAttempts = emptyAttempt + 1;
											throw new Error(
												`Subagent returned empty output after ${totalAttempts} attempt${totalAttempts === 1 ? "" : "s"}.`,
											);
										}
										emptyAttempt += 1;
										emitProgress({
											kind: "subagent_progress",
											phase: "running",
											message: `root subagent returned empty output; retry ${emptyAttempt}/${emptyOutputRetriesFromEnv}`,
											cwd: subagentCwd,
											activeTool: undefined,
										});
									} catch (error) {
										if (_signal?.aborted || isAbortError(error)) {
											throw new Error("Operation aborted");
										}
										const message = error instanceof Error ? error.message : String(error);
										const cause = classifyFailureCause(message);
										recordFailureCause(cause);
										const canRetryRetrospective =
											retrospectiveAttempt < retrospectiveRetriesFromEnv && isRetrospectiveRetryable(cause);
										if (!canRetryRetrospective) {
											throw Object.assign(new Error(message), { failureCause: cause as FailureCause });
										}
										retrospectiveAttempt += 1;
										retrospectiveAttempts += 1;
										const directive = buildRetrospectiveDirective({
											cause,
											errorMessage: message,
											attempt: retrospectiveAttempt,
											target: "root",
										});
										promptForAttempt = `${runPrompt}\n\n${directive}`;
										emitProgress({
											kind: "subagent_progress",
											phase: "running",
											message: `root retrospective retry ${retrospectiveAttempt}/${retrospectiveRetriesFromEnv} (${cause})`,
											cwd: subagentCwd,
											activeTool: undefined,
										});
									}
								}
							};

							const rootMeta = formatMetaCheckpoint(options?.getMetaMessages?.());
							const rootSharedMemoryGuidance = buildSharedMemoryGuidance(sharedMemoryRunId, sharedMemoryTaskId);
							const rootPromptBase = `${promptWithInstructions}\n\n${rootSharedMemoryGuidance}`;
							const rootPrompt =
								rootMeta.section && rootMeta.appliedCount > 0
									? `${rootPromptBase}\n\n${rootMeta.section}`
									: rootPromptBase;
						if (rootMeta.appliedCount > 0) {
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message: `applied ${rootMeta.appliedCount} meta update(s) to root task`,
								cwd: subagentCwd,
								activeTool: undefined,
							});
						}
						const firstPass = await runRootPass(rootPrompt);
						output = firstPass.output;
						subagentSessionId = firstPass.sessionId;
						runStats = firstPass.stats;

						let parsedDelegation = parseDelegationRequests(
							output,
							effectiveDelegationDepth > 0 ? effectiveMaxDelegations : 0,
						);
						if (minDelegationsPreferred > 0 && parsedDelegation.requests.length < minDelegationsPreferred) {
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message: `delegation preference unmet (${parsedDelegation.requests.length}/${minDelegationsPreferred}), retrying with stronger split guidance`,
								cwd: subagentCwd,
								activeTool: undefined,
							});
							const enforcedPrompt = [
								rootPrompt,
								"",
								"[DELEGATION_ENFORCEMENT]",
								`Prefer emitting at least ${minDelegationsPreferred} <delegate_task> blocks for independent sub-work when beneficial.`,
								`Target parallel fan-out: up to ${effectiveMaxDelegateParallel}.`,
								"If decomposition is not beneficial, you may keep single-agent execution and optionally output one line:",
								"DELEGATION_IMPOSSIBLE: <reason>",
								"[/DELEGATION_ENFORCEMENT]",
							].join("\n");
							const secondPass = await runRootPass(enforcedPrompt);
							output = secondPass.output;
							subagentSessionId = secondPass.sessionId ?? subagentSessionId;
							runStats = secondPass.stats ?? runStats;
								parsedDelegation = parseDelegationRequests(
									output,
									effectiveDelegationDepth > 0 ? effectiveMaxDelegations : 0,
								);
						}

						if (
							minDelegationsPreferred > 0 &&
							parsedDelegation.requests.length === 0 &&
							strictDelegationContract
						) {
							const impossibleMatch = output.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
							if (!impossibleMatch) {
								const synthesizedRequests = synthesizeDelegationRequests({
									description,
									prompt,
									baseProfile: effectiveProfile,
									currentDelegates: parsedDelegation.requests.length,
									minDelegationsPreferred,
									maxDelegations: effectiveMaxDelegations,
									availableCustomNames,
								});
								if (synthesizedRequests.length > 0) {
									parsedDelegation.requests.push(...synthesizedRequests);
									delegationWarnings.push(
										`Delegation auto-fanout: synthesized ${synthesizedRequests.length} delegate(s) to satisfy parallelism contract.`,
									);
								}
							}
						}

						if (minDelegationsPreferred > 0 && parsedDelegation.requests.length < minDelegationsPreferred) {
							const impossibleMatch = output.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
							const impossibleReason = impossibleMatch?.[1]?.trim() ?? "not provided";
							if (strictDelegationContract && parsedDelegation.requests.length === 0 && !impossibleMatch) {
								throw new Error(
									`Delegation contract violated: expected >=${minDelegationsPreferred} delegates, got ${parsedDelegation.requests.length}. ` +
										`Provide nested <delegate_task> fan-out or an explicit "DELEGATION_IMPOSSIBLE: <reason>" line.`,
								);
							}
							delegationWarnings.push(
								`Delegation fallback: kept single-agent execution (preferred >=${minDelegationsPreferred} delegates, got ${parsedDelegation.requests.length}). Reason: ${impossibleReason}.`,
							);
						}

						output = parsedDelegation.cleanedOutput;
						delegationWarnings.push(...parsedDelegation.warnings);
						const delegateTotal = parsedDelegation.requests.length;
						const delegateItems: TaskDelegateProgressItem[] = parsedDelegation.requests.map((request, index) => ({
							index: index + 1,
							description: request.description,
							profile: request.profile,
							status: "pending",
						}));
						const normalizedDependsOn: number[][] = parsedDelegation.requests.map((request, index) => {
							const current = index + 1;
							const raw = request.dependsOn ?? [];
							const unique = new Set<number>();
							for (const dep of raw) {
								if (!Number.isInteger(dep) || dep <= 0 || dep > delegateTotal || dep === current) {
									delegationWarnings.push(
										`Delegated task ${current} has invalid depends_on reference "${dep}" and it was ignored.`,
									);
									continue;
								}
								unique.add(dep);
							}
							return Array.from(unique).sort((a, b) => a - b);
						});
						delegatedTasks += delegateTotal;
						if (delegateTotal > 0) {
								emitProgress({
									kind: "subagent_progress",
									phase: "running",
									message: `delegation scheduler: ${delegateTotal} task(s), max parallel ${Math.min(delegateTotal, effectiveMaxDelegateParallel)}`,
									cwd: subagentCwd,
									activeTool: undefined,
									delegateTotal,
									delegateItems,
								});
							}

						const pendingIndices = new Set<number>(Array.from({ length: delegateTotal }, (_v, i) => i));
						const runningDelegates = new Map<number, Promise<void>>();
						const maxDelegateParallel = Math.max(1, Math.min(delegateTotal || 1, effectiveMaxDelegateParallel));

						const statusOf = (idx: number): TaskDelegateProgressStatus =>
							delegateItems[idx]?.status ?? "pending";
						const formatDelegateTarget = (request: DelegationRequest): string => {
							const agent = request.agent?.trim();
							return agent ? `${agent}/${request.profile}` : request.profile;
						};

							const markDelegateFailed = (
								index: number,
								message: string,
								details?: string,
								cause?: FailureCause,
							): void => {
								const request = parsedDelegation.requests[index];
								if (delegateItems[index]) {
									delegateItems[index].status = "failed";
								}
								delegatedFailed += 1;
								if (details) {
									delegationWarnings.push(cause ? `${details} [cause=${cause}]` : details);
								}
								const causeLabel = cause ? ` [cause=${cause}]` : "";
								delegatedSections[index] = `#### ${index + 1}. ${request.description} (${formatDelegateTarget(request)})\nERROR${causeLabel}: ${message}`;
								emitProgress({
									kind: "subagent_progress",
									phase: "running",
								message,
								cwd: subagentCwd,
								activeTool: undefined,
								delegateIndex: index + 1,
								delegateTotal,
								delegateDescription: request.description,
								delegateProfile: request.profile,
								delegateItems,
							});
						};

							const executeNestedDelegates = async (
								requests: DelegationRequest[],
								parentCwd: string,
								depthRemaining: number,
								lineage: string,
							): Promise<{
								sections: string[];
								warnings: string[];
							}> => {
								if (requests.length === 0 || depthRemaining <= 0) {
									return { sections: [], warnings: [] };
								}

								const nestedWarnings: string[] = [];
								const sectionsByIndex: Array<string | undefined> = new Array(requests.length);
								const statuses: TaskDelegateProgressStatus[] = Array.from(
									{ length: requests.length },
									() => "pending",
								);
								const totalNested = requests.length;
								const normalizedDependsOn: number[][] = requests.map((request, index) => {
									const current = index + 1;
									const raw = request.dependsOn ?? [];
									const unique = new Set<number>();
									for (const dep of raw) {
										if (!Number.isInteger(dep) || dep <= 0 || dep > totalNested || dep === current) {
											nestedWarnings.push(
												`Nested delegated task ${lineage}${current} has invalid depends_on reference "${dep}" and it was ignored.`,
											);
											continue;
										}
										unique.add(dep);
									}
									return Array.from(unique).sort((a, b) => a - b);
								});

								const statusOf = (index: number): TaskDelegateProgressStatus => statuses[index] ?? "pending";
								const markNestedFailed = (
									nestedIndex: number,
									requestLabel: string,
									nestedRequest: DelegationRequest,
									nestedProfileLabel: string,
									message: string,
									cause: FailureCause,
								): void => {
									statuses[nestedIndex] = "failed";
									recordFailureCause(cause);
									delegatedTasks += 1;
									delegatedFailed += 1;
									sectionsByIndex[nestedIndex] =
										`###### ${requestLabel}. ${nestedRequest.description} (${nestedProfileLabel})\nERROR [cause=${cause}]: ${message}`;
								};

								const runNestedDelegate = async (nestedIndex: number): Promise<void> => {
									const nestedRequest = requests[nestedIndex]!;
									const requestLabel = `${lineage}${nestedIndex + 1}`;
									statuses[nestedIndex] = "running";
									let requestedNestedAgent = nestedRequest.agent?.trim() || undefined;
									let nestedCustomSubagent = resolveCustom(requestedNestedAgent);
									if (!nestedCustomSubagent && !requestedNestedAgent) {
										const profileAsAgent = resolveCustom(nestedRequest.profile);
										if (profileAsAgent) {
											nestedCustomSubagent = profileAsAgent;
											requestedNestedAgent = profileAsAgent.name;
										}
									}
									if (requestedNestedAgent && !nestedCustomSubagent) {
										nestedWarnings.push(
											`Nested delegated task "${nestedRequest.description}" requested unknown agent "${requestedNestedAgent}". Falling back to profile "${nestedRequest.profile}".`,
										);
									}

									const nestedProfileCandidate = (nestedCustomSubagent?.profile ?? nestedRequest.profile).trim();
									const normalizedNestedProfile = nestedProfileCandidate.toLowerCase();
									if (!isValidProfileName(normalizedNestedProfile)) {
										markNestedFailed(
											nestedIndex,
											requestLabel,
											nestedRequest,
											nestedProfileCandidate || "unknown",
											`nested delegate skipped: unknown profile "${nestedProfileCandidate || nestedRequest.profile}"`,
											"logic_error",
										);
										return;
									}
									const nestedProfile = normalizedNestedProfile as AgentProfileName;
									const nestedProfileLabel = nestedCustomSubagent?.name
										? `${nestedCustomSubagent.name}/${nestedProfile}`
										: nestedProfile;
									let nestedTools = nestedCustomSubagent?.tools
										? [...nestedCustomSubagent.tools]
										: [...toolsByProfile[nestedProfile]];
									if (nestedCustomSubagent?.disallowedTools?.length) {
										const blocked = new Set(nestedCustomSubagent.disallowedTools);
										nestedTools = nestedTools.filter((tool) => !blocked.has(tool));
									}
									const nestedBaseSystemPrompt = withSubagentInstructions(
										nestedCustomSubagent?.systemPrompt ??
											systemPromptByProfile[nestedProfile] ??
											systemPromptByProfile.full,
										nestedCustomSubagent?.instructions,
									);
									const nestedSystemPrompt = withDelegationPrompt(
										nestedBaseSystemPrompt,
										Math.max(0, depthRemaining - 1),
										effectiveMaxDelegations,
									);
									const requestedNestedCwd = nestedRequest.cwd
										? path.resolve(parentCwd, nestedRequest.cwd)
										: nestedCustomSubagent?.cwd ?? parentCwd;
									if (!existsSync(requestedNestedCwd) || !statSync(requestedNestedCwd).isDirectory()) {
										markNestedFailed(
											nestedIndex,
											requestLabel,
											nestedRequest,
											nestedProfileLabel,
											"nested delegate skipped: missing cwd",
											"dependency_env",
										);
										return;
									}

										let nestedReleaseLock: (() => void) | undefined;
										let nestedReleaseIsolation: (() => void) | undefined;
										let nestedCwd = requestedNestedCwd;
										try {
											if (writeCapableProfiles.has(nestedProfile) && nestedRequest.lockKey?.trim()) {
												nestedReleaseLock = await acquireLocalWriteLock(nestedRequest.lockKey.trim());
											}
										if (nestedRequest.isolation === "worktree") {
											const isolated = provisionWorktree(
												cwd,
												requestedNestedCwd,
												`${runId}_nested_${requestLabel.replace(/\./g, "_")}`,
											);
											nestedCwd = isolated.runCwd;
											nestedReleaseIsolation = isolated.cleanup;
										}

										const nestedPromptWithInstructions = nestedRequest.prompt;
										const nestedSharedMemoryGuidance = buildSharedMemoryGuidance(
											sharedMemoryRunId,
											sharedMemoryTaskId,
										);
										const nestedPrompt = `${nestedPromptWithInstructions}\n\n${nestedSharedMemoryGuidance}`;
										const nestedModelOverride =
											nestedRequest.model?.trim() || nestedCustomSubagent?.model?.trim() || undefined;
										const nestedSharedMemoryContext: SharedMemoryContext = {
											rootCwd: cwd,
											runId: sharedMemoryRunId,
											taskId: sharedMemoryTaskId,
											delegateId: requestLabel,
											profile: nestedProfile,
										};

										const nestedResult = await runner({
											systemPrompt: nestedSystemPrompt,
											profileName: nestedProfile,
											tools: nestedTools,
											prompt: nestedPrompt,
											cwd: nestedCwd,
											modelOverride: nestedModelOverride,
											sharedMemoryContext: nestedSharedMemoryContext,
											signal: _signal,
											onProgress: (progress) => {
												emitProgress({
													kind: "subagent_progress",
													phase: "running",
													message: `delegate ${requestLabel}: ${progress.message}`,
													cwd: progress.cwd ?? nestedCwd,
													activeTool: progress.activeTool,
												});
											},
										});
										throwIfAborted();

										let nestedOutput = typeof nestedResult === "string" ? nestedResult : nestedResult.output;
										const nestedStats = typeof nestedResult === "string" ? undefined : nestedResult.stats;
										delegatedTasks += 1;
										delegatedSucceeded += 1;
										statuses[nestedIndex] = "done";
										delegatedStats.toolCallsStarted += nestedStats?.toolCallsStarted ?? 0;
										delegatedStats.toolCallsCompleted += nestedStats?.toolCallsCompleted ?? 0;
										delegatedStats.assistantMessages += nestedStats?.assistantMessages ?? 0;

										const parsedNestedDelegation = parseDelegationRequests(
											nestedOutput,
											depthRemaining > 1 ? effectiveMaxDelegations : 0,
										);
										nestedOutput = parsedNestedDelegation.cleanedOutput;
										nestedWarnings.push(
											...parsedNestedDelegation.warnings.map(
												(warning) => `Nested child ${requestLabel}: ${warning}`,
											),
										);

										let nestedSection = `###### ${requestLabel}. ${nestedRequest.description} (${nestedProfileLabel})\n${
											nestedOutput.trim() || "(no output)"
										}`;
										if (parsedNestedDelegation.requests.length > 0 && depthRemaining > 1) {
											const deeper = await executeNestedDelegates(
												parsedNestedDelegation.requests,
												nestedCwd,
												depthRemaining - 1,
												`${requestLabel}.`,
											);
											nestedWarnings.push(...deeper.warnings);
											if (deeper.sections.length > 0) {
												nestedSection = `${nestedSection}\n\n##### Nested Delegated Subtasks\n\n${deeper.sections.join(
													"\n\n",
												)}`;
											}
										}
										sectionsByIndex[nestedIndex] = nestedSection;
									} catch (error) {
										const message = error instanceof Error ? error.message : String(error);
										const cause = classifyFailureCause(message);
										markNestedFailed(
											nestedIndex,
											requestLabel,
											nestedRequest,
											nestedProfileLabel,
											message,
											cause,
										);
										} finally {
											nestedReleaseIsolation?.();
											nestedReleaseLock?.();
										}
									};

								const pendingIndices = new Set<number>(Array.from({ length: totalNested }, (_v, i) => i));
								const runningNested = new Map<number, Promise<void>>();
								const maxNestedParallel = Math.max(
									1,
									Math.min(totalNested, effectiveMaxDelegateParallel),
								);

								const resolveBlockedByFailedDependencies = (): boolean => {
									let changed = false;
									for (const nestedIndex of Array.from(pendingIndices)) {
										const deps = normalizedDependsOn[nestedIndex] ?? [];
										if (deps.length === 0) continue;
										const failedDep = deps.find((dep) => statusOf(dep - 1) === "failed");
										if (!failedDep) continue;
										pendingIndices.delete(nestedIndex);
										const nestedRequest = requests[nestedIndex]!;
										const requestLabel = `${lineage}${nestedIndex + 1}`;
										markNestedFailed(
											nestedIndex,
											requestLabel,
											nestedRequest,
											nestedRequest.profile,
											`nested delegate skipped: dependency ${lineage}${failedDep} failed`,
											"logic_error",
										);
										changed = true;
									}
									return changed;
								};

								const launchReadyNested = (): boolean => {
									let launched = false;
									while (runningNested.size < maxNestedParallel) {
										let nextIndex: number | undefined;
										for (const nestedIndex of pendingIndices) {
											const deps = normalizedDependsOn[nestedIndex] ?? [];
											const allDone = deps.every((dep) => statusOf(dep - 1) === "done");
											if (allDone) {
												nextIndex = nestedIndex;
												break;
											}
										}
										if (nextIndex === undefined) break;
										pendingIndices.delete(nextIndex);
										const promise = runNestedDelegate(nextIndex).finally(() => {
											runningNested.delete(nextIndex);
										});
										runningNested.set(nextIndex, promise);
										launched = true;
									}
									return launched;
								};

								while (pendingIndices.size > 0 || runningNested.size > 0) {
									throwIfAborted();
									const changed = resolveBlockedByFailedDependencies();
									const launched = launchReadyNested();
									if (runningNested.size === 0) {
										if (pendingIndices.size > 0 && !changed && !launched) {
											for (const nestedIndex of Array.from(pendingIndices)) {
												pendingIndices.delete(nestedIndex);
												const nestedRequest = requests[nestedIndex]!;
												const deps = normalizedDependsOn[nestedIndex] ?? [];
												const requestLabel = `${lineage}${nestedIndex + 1}`;
												markNestedFailed(
													nestedIndex,
													requestLabel,
													nestedRequest,
													nestedRequest.profile,
													`nested delegate blocked: unresolved depends_on (${deps.join(", ") || "unknown"})`,
													"logic_error",
												);
											}
										}
										break;
									}
									await Promise.race(Array.from(runningNested.values()));
								}

								const sections = sectionsByIndex.filter(
									(section): section is string => typeof section === "string" && section.trim().length > 0,
								);
								return { sections, warnings: nestedWarnings };
							};

							const runDelegate = async (index: number): Promise<void> => {
								throwIfAborted();
								const request = parsedDelegation.requests[index];
							let requestedChildAgent = request.agent?.trim() || undefined;
							let childCustomSubagent = resolveCustom(requestedChildAgent);
							if (!childCustomSubagent && !requestedChildAgent) {
								const profileAsAgent = resolveCustom(request.profile);
								if (profileAsAgent) {
									childCustomSubagent = profileAsAgent;
									requestedChildAgent = profileAsAgent.name;
								}
							}
							if (requestedChildAgent && !childCustomSubagent) {
								delegationWarnings.push(
									`Delegated task "${request.description}" requested unknown agent "${requestedChildAgent}". Falling back to profile "${request.profile}".`,
								);
							}
							const childProfileRaw = (childCustomSubagent?.profile ?? request.profile).trim();
							const normalizedChildProfile = childProfileRaw.toLowerCase();
							if (!isValidProfileName(normalizedChildProfile)) {
								recordFailureCause("logic_error");
								markDelegateFailed(
									index,
									`delegate ${index + 1}/${delegateTotal} skipped: unknown profile "${childProfileRaw || request.profile}"`,
									`Delegated task "${request.description}" requested unknown profile "${childProfileRaw || request.profile}".`,
									"logic_error",
								);
								return;
							}
							const childProfile = normalizedChildProfile as AgentProfileName;
							const childProfileLabel = childCustomSubagent?.name
								? `${childCustomSubagent.name}/${childProfile}`
								: childProfile;
							if (delegateItems[index]) {
								delegateItems[index].status = "running";
							}
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message: `delegating ${index + 1}/${delegateTotal}: ${request.description}`,
								cwd: subagentCwd,
								activeTool: undefined,
								delegateIndex: index + 1,
								delegateTotal,
								delegateDescription: request.description,
								delegateProfile: childProfileLabel,
								delegateItems,
							});

							let childTools = childCustomSubagent?.tools
								? [...childCustomSubagent.tools]
								: [...toolsByProfile[childProfile]];
							if (childCustomSubagent?.disallowedTools?.length) {
								const blocked = new Set(childCustomSubagent.disallowedTools);
								childTools = childTools.filter((tool) => !blocked.has(tool));
							}
							const childBaseSystemPrompt = withSubagentInstructions(
								childCustomSubagent?.systemPrompt ??
									systemPromptByProfile[childProfile] ??
									systemPromptByProfile.full,
								childCustomSubagent?.instructions,
							);
							const childAutoDelegateParallelHint = deriveAutoDelegateParallelHint(
								childProfile,
								requestedChildAgent,
								normalizedHostProfile,
								request.description,
								request.prompt,
							);
							const childMinDelegationsPreferred =
								Math.max(0, effectiveDelegationDepth - 1) > 0 &&
								(childAutoDelegateParallelHint ?? 0) >= 2
									? Math.min(
											preferredDelegationFloor,
											effectiveMaxDelegations,
											childAutoDelegateParallelHint ?? preferredDelegationFloor,
										)
									: 0;
							const childSystemPrompt = withDelegationPrompt(
								childBaseSystemPrompt,
								Math.max(0, effectiveDelegationDepth - 1),
								effectiveMaxDelegations,
								childMinDelegationsPreferred,
							);
								const requestedChildCwd = request.cwd
									? path.resolve(subagentCwd, request.cwd)
									: childCustomSubagent?.cwd ?? subagentCwd;
								if (!existsSync(requestedChildCwd) || !statSync(requestedChildCwd).isDirectory()) {
									recordFailureCause("dependency_env");
									markDelegateFailed(
										index,
										`delegate ${index + 1}/${delegateTotal} skipped: missing cwd`,
										`Delegated task "${request.description}" skipped: cwd does not exist (${requestedChildCwd}).`,
										"dependency_env",
									);
									return;
								}

								let childReleaseLock: (() => void) | undefined;
								let childReleaseIsolation: (() => void) | undefined;
								const explicitChildLock = request.lockKey?.trim();
								let childCwd = requestedChildCwd;
								try {
									throwIfAborted();
									if (writeCapableProfiles.has(childProfile) && explicitChildLock) {
										childReleaseLock = await acquireLocalWriteLock(explicitChildLock);
										throwIfAborted();
									}
								if (request.isolation === "worktree") {
									const isolated = provisionWorktree(cwd, requestedChildCwd, `${runId}_delegate_${index + 1}`);
									childCwd = isolated.runCwd;
									childReleaseIsolation = isolated.cleanup;
								}

									const delegateMeta = formatMetaCheckpoint(options?.getMetaMessages?.());
									const childPromptWithInstructions = request.prompt;
									const delegateSharedMemoryGuidance = buildSharedMemoryGuidance(
										sharedMemoryRunId,
										sharedMemoryTaskId,
									);
									const delegatePromptBase = `${childPromptWithInstructions}\n\n${delegateSharedMemoryGuidance}`;
									const delegatePrompt =
										delegateMeta.section && delegateMeta.appliedCount > 0
											? `${delegatePromptBase}\n\n${delegateMeta.section}`
											: delegatePromptBase;
									if (delegateMeta.appliedCount > 0) {
										emitProgress({
											kind: "subagent_progress",
										phase: "running",
										message: `delegate ${index + 1}/${delegateTotal}: applied ${delegateMeta.appliedCount} meta update(s)`,
										cwd: childCwd,
										activeTool: undefined,
										delegateIndex: index + 1,
										delegateTotal,
										delegateDescription: request.description,
										delegateProfile: childProfileLabel,
										delegateItems,
									});
								}
									const childModelOverride = request.model?.trim() || childCustomSubagent?.model?.trim() || undefined;
									const childSharedMemoryContext: SharedMemoryContext = {
										rootCwd: cwd,
										runId: sharedMemoryRunId,
										taskId: sharedMemoryTaskId,
										delegateId: String(index + 1),
										profile: childProfile,
									};

									let childOutput = "";
									let childStats: SubagentRunResult["stats"] | undefined;
									const runChildPass = async (runPrompt: string): Promise<string> => {
										let childEmptyAttempt = 0;
										let childRetrospectiveAttempt = 0;
										let childPromptForAttempt = runPrompt;
										while (true) {
											try {
												const childResult = await runner({
													systemPrompt: childSystemPrompt,
													profileName: childProfile,
													tools: childTools,
													prompt: childPromptForAttempt,
													cwd: childCwd,
													modelOverride: childModelOverride,
													sharedMemoryContext: childSharedMemoryContext,
													signal: _signal,
													onProgress: (progress) => {
														emitProgress({
															kind: "subagent_progress",
															phase: "running",
															message: `delegate ${index + 1}/${delegateTotal}: ${progress.message}`,
															cwd: progress.cwd ?? childCwd,
															activeTool: progress.activeTool,
															delegateIndex: index + 1,
															delegateTotal,
															delegateDescription: request.description,
															delegateProfile: childProfileLabel,
															delegateItems,
														});
													},
												});
												throwIfAborted();
												let attemptOutput: string;
												let attemptStats: SubagentRunResult["stats"] | undefined;
												if (typeof childResult === "string") {
													attemptOutput = childResult;
												} else {
													attemptOutput = childResult.output;
													attemptStats = childResult.stats;
												}
												childStats = mergeRunStats(childStats, attemptStats);
												if (attemptOutput.trim().length > 0) {
													if (childRetrospectiveAttempt > 0) {
														retrospectiveRecovered += 1;
													}
													return attemptOutput;
												}
												if (childEmptyAttempt >= emptyOutputRetriesFromEnv) {
													const totalAttempts = childEmptyAttempt + 1;
													throw new Error(
														`delegate ${index + 1}/${delegateTotal} returned empty output after ${totalAttempts} attempt${totalAttempts === 1 ? "" : "s"}.`,
													);
												}
												childEmptyAttempt += 1;
												emitProgress({
													kind: "subagent_progress",
													phase: "running",
													message: `delegate ${index + 1}/${delegateTotal}: empty output, retry ${childEmptyAttempt}/${emptyOutputRetriesFromEnv}`,
													cwd: childCwd,
													activeTool: undefined,
													delegateIndex: index + 1,
													delegateTotal,
													delegateDescription: request.description,
													delegateProfile: childProfileLabel,
													delegateItems,
												});
											} catch (error) {
												if (_signal?.aborted || isAbortError(error)) {
													throw new Error("Operation aborted");
												}
												const message = error instanceof Error ? error.message : String(error);
												const cause = classifyFailureCause(message);
												recordFailureCause(cause);
												const canRetryRetrospective =
													childRetrospectiveAttempt < retrospectiveRetriesFromEnv &&
													isRetrospectiveRetryable(cause);
												if (!canRetryRetrospective) {
													throw Object.assign(new Error(message), { failureCause: cause as FailureCause });
												}
												childRetrospectiveAttempt += 1;
												retrospectiveAttempts += 1;
												const directive = buildRetrospectiveDirective({
													cause,
													errorMessage: message,
													attempt: childRetrospectiveAttempt,
													target: "delegate",
												});
												childPromptForAttempt = `${runPrompt}\n\n${directive}`;
												emitProgress({
													kind: "subagent_progress",
													phase: "running",
													message: `delegate ${index + 1}/${delegateTotal}: retrospective retry ${childRetrospectiveAttempt}/${retrospectiveRetriesFromEnv} (${cause})`,
													cwd: childCwd,
													activeTool: undefined,
													delegateIndex: index + 1,
													delegateTotal,
													delegateDescription: request.description,
													delegateProfile: childProfileLabel,
													delegateItems,
												});
											}
										}
									};

									childOutput = await runChildPass(delegatePrompt);
									let parsedChildDelegation = parseDelegationRequests(
										childOutput,
										effectiveDelegationDepth > 1 ? effectiveMaxDelegations : 0,
									);
									if (
										childMinDelegationsPreferred > 0 &&
										parsedChildDelegation.requests.length < childMinDelegationsPreferred
									) {
										emitProgress({
											kind: "subagent_progress",
											phase: "running",
											message: `delegate ${index + 1}/${delegateTotal}: nested delegation preference unmet (${parsedChildDelegation.requests.length}/${childMinDelegationsPreferred}), retrying with stronger split guidance`,
											cwd: childCwd,
											activeTool: undefined,
											delegateIndex: index + 1,
											delegateTotal,
											delegateDescription: request.description,
											delegateProfile: childProfileLabel,
											delegateItems,
										});
										const enforcedChildPrompt = [
											delegatePrompt,
											"",
											"[DELEGATION_ENFORCEMENT]",
											`This delegated workstream must emit at least ${childMinDelegationsPreferred} <delegate_task> blocks for independent sub-work when beneficial.`,
											`Target parallel fan-out: up to ${Math.min(effectiveMaxDelegateParallel, effectiveMaxDelegations)}.`,
											"For broad audits or implementations, split by subsystem / file cluster / verification stream instead of doing everything in one pass.",
											"If safe decomposition is impossible, output exactly one line:",
											"DELEGATION_IMPOSSIBLE: <reason>",
											"[/DELEGATION_ENFORCEMENT]",
										].join("\n");
										childOutput = await runChildPass(enforcedChildPrompt);
										parsedChildDelegation = parseDelegationRequests(
											childOutput,
											effectiveDelegationDepth > 1 ? effectiveMaxDelegations : 0,
										);
									}
									if (
										childMinDelegationsPreferred > 0 &&
										parsedChildDelegation.requests.length === 0 &&
										strictDelegationContract
									) {
										const impossibleMatch = childOutput.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
										if (!impossibleMatch) {
											const synthesizedChildRequests = synthesizeDelegationRequests({
												description: request.description,
												prompt: request.prompt,
												baseProfile: childProfile,
												currentDelegates: parsedChildDelegation.requests.length,
												minDelegationsPreferred: childMinDelegationsPreferred,
												maxDelegations: effectiveMaxDelegations,
												availableCustomNames,
											});
											if (synthesizedChildRequests.length > 0) {
												parsedChildDelegation.requests.push(...synthesizedChildRequests);
												delegationWarnings.push(
													`Child ${index + 1}: delegation auto-fanout synthesized ${synthesizedChildRequests.length} nested delegate(s).`,
												);
											}
										}
									}

										if (
											childMinDelegationsPreferred > 0 &&
											parsedChildDelegation.requests.length < childMinDelegationsPreferred
										) {
											const impossibleMatch = childOutput.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
											const impossibleReason = impossibleMatch?.[1]?.trim() ?? "not provided";
											if (
												strictDelegationContract &&
												parsedChildDelegation.requests.length === 0 &&
												!impossibleMatch
											) {
												throw new Error(
													`Delegation contract violated for child ${index + 1}: expected >=${childMinDelegationsPreferred} nested delegates, got ${parsedChildDelegation.requests.length}. ` +
														`Provide nested <delegate_task> fan-out or "DELEGATION_IMPOSSIBLE: <reason>".`,
												);
											}
											delegationWarnings.push(
												`Child ${index + 1}: delegation fallback (preferred >=${childMinDelegationsPreferred}, got ${parsedChildDelegation.requests.length}). Reason: ${impossibleReason}.`,
											);
										}
								childOutput = parsedChildDelegation.cleanedOutput;
								delegationWarnings.push(
									...parsedChildDelegation.warnings.map((warning) => `Child ${index + 1}: ${warning}`),
								);
								let nestedSection = "";
								if (parsedChildDelegation.requests.length > 0 && effectiveDelegationDepth > 1) {
									const nested = await executeNestedDelegates(
										parsedChildDelegation.requests,
										childCwd,
										effectiveDelegationDepth - 1,
										`${index + 1}.`,
									);
									delegationWarnings.push(...nested.warnings);
									if (nested.sections.length > 0) {
										nestedSection = `\n\n##### Nested Delegated Subtasks\n\n${nested.sections.join("\n\n")}`;
									}
								}
								delegatedSucceeded += 1;
								if (delegateItems[index]) {
									delegateItems[index].status = "done";
								}
								delegatedStats.toolCallsStarted += childStats?.toolCallsStarted ?? 0;
								delegatedStats.toolCallsCompleted += childStats?.toolCallsCompleted ?? 0;
								delegatedStats.assistantMessages += childStats?.assistantMessages ?? 0;
								const normalizedChildOutput = childOutput.trim().length > 0 ? childOutput.trim() : "(no output)";
								const childOutputExcerpt =
									normalizedChildOutput.length > maxDelegatedOutputCharsFromEnv
										? `${normalizedChildOutput.slice(0, Math.max(1, maxDelegatedOutputCharsFromEnv - 3))}...`
										: normalizedChildOutput;
								delegatedSections[index] =
									`#### ${index + 1}. ${request.description} (${childProfileLabel})\n${childOutputExcerpt}${nestedSection}`;
								emitProgress({
									kind: "subagent_progress",
									phase: "running",
									message: `delegate ${index + 1}/${delegateTotal} done`,
									cwd: childCwd,
									activeTool: undefined,
									delegateIndex: index + 1,
									delegateTotal,
									delegateDescription: request.description,
									delegateProfile: childProfileLabel,
									delegateItems,
								});
								} catch (error) {
									const message = error instanceof Error ? error.message : String(error);
									if (_signal?.aborted || isAbortError(error)) {
										throw new Error("Operation aborted");
									}
									const classified =
										error && typeof error === "object" && "failureCause" in error
											? (error.failureCause as FailureCause)
											: classifyFailureCause(message);
									if (!(error && typeof error === "object" && "failureCause" in error)) {
										recordFailureCause(classified);
									}
									markDelegateFailed(
										index,
										`delegate ${index + 1}/${delegateTotal} failed`,
										message,
										classified,
									);
									} finally {
									childReleaseIsolation?.();
									childReleaseLock?.();
								}
							};

						const resolveBlockedByFailedDependencies = (): boolean => {
							let changed = false;
							for (const index of Array.from(pendingIndices)) {
								const deps = normalizedDependsOn[index] ?? [];
								if (deps.length === 0) continue;
								const failedDep = deps.find((dep) => statusOf(dep - 1) === "failed");
								if (!failedDep) continue;
									pendingIndices.delete(index);
									recordFailureCause("logic_error");
									markDelegateFailed(
										index,
										`delegate ${index + 1}/${delegateTotal} skipped: dependency ${failedDep} failed`,
										`Delegated task ${index + 1} skipped because dependency ${failedDep} failed.`,
										"logic_error",
									);
									changed = true;
								}
							return changed;
						};

						const launchReadyDelegates = (): boolean => {
							let launched = false;
							while (runningDelegates.size < maxDelegateParallel) {
								let nextIndex: number | undefined;
								for (const index of pendingIndices) {
									const deps = normalizedDependsOn[index] ?? [];
									const allDone = deps.every((dep) => statusOf(dep - 1) === "done");
									if (allDone) {
										nextIndex = index;
										break;
									}
								}
								if (nextIndex === undefined) {
									break;
								}
								pendingIndices.delete(nextIndex);
								const promise = runDelegate(nextIndex).finally(() => {
									runningDelegates.delete(nextIndex);
								});
								runningDelegates.set(nextIndex, promise);
								launched = true;
							}
							return launched;
						};

						while (pendingIndices.size > 0 || runningDelegates.size > 0) {
							throwIfAborted();
							const changed = resolveBlockedByFailedDependencies();
							const launched = launchReadyDelegates();
							if (runningDelegates.size === 0) {
								if (pendingIndices.size > 0 && !changed && !launched) {
										for (const index of Array.from(pendingIndices)) {
											pendingIndices.delete(index);
											const deps = normalizedDependsOn[index] ?? [];
											recordFailureCause("logic_error");
											markDelegateFailed(
												index,
												`delegate ${index + 1}/${delegateTotal} blocked: unresolved depends_on`,
												`Delegated task ${index + 1} blocked by unresolved dependencies: ${deps.join(", ") || "unknown"}.`,
												"logic_error",
											);
										}
								}
								break;
							}
							await Promise.race(Array.from(runningDelegates.values()));
						}
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							if (_signal?.aborted || isAbortError(error)) {
								recordFailureCause("aborted");
								const hasFailureCauses = Object.keys(failureCauses).length > 0;
								const details: TaskToolDetails = {
									profile: effectiveProfile,
									description,
									outputLength: 0,
									cwd: subagentCwd,
									agent: customSubagent?.name,
									lockKey: lockKey?.trim() || undefined,
									runId,
									taskId: orchestrationTaskId,
									model: effectiveModelOverride,
									isolation: useWorktree ? "worktree" : "none",
									worktreePath,
									waitMs: Date.now() - queuedAt,
									background: runInBackground,
									toolCallsStarted: runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted,
									toolCallsCompleted: runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted,
									assistantMessages: runStats?.assistantMessages ?? latestProgress?.assistantMessages,
									delegatedTasks: delegatedTasks > 0 ? delegatedTasks : undefined,
									delegatedSucceeded: delegatedTasks > 0 ? delegatedSucceeded : undefined,
									delegatedFailed: delegatedTasks > 0 ? delegatedFailed : undefined,
									retrospectiveAttempts: retrospectiveAttempts > 0 ? retrospectiveAttempts : undefined,
									retrospectiveRecovered: retrospectiveRecovered > 0 ? retrospectiveRecovered : undefined,
									failureCauses: hasFailureCauses ? { ...failureCauses } : undefined,
								};
								updateTrackedTaskStatus("cancelled");
								throw Object.assign(new Error("Operation aborted"), {
									details,
									failureCause: "aborted" as FailureCause,
								});
							}
							const classified =
								error && typeof error === "object" && "failureCause" in error
									? (error.failureCause as FailureCause)
									: classifyFailureCause(message);
							if (!(error && typeof error === "object" && "failureCause" in error)) {
								recordFailureCause(classified);
							}
							const hasFailureCauses = Object.keys(failureCauses).length > 0;
							const details: TaskToolDetails = {
								profile: effectiveProfile,
								description,
								outputLength: 0,
							cwd: subagentCwd,
							agent: customSubagent?.name,
							lockKey: lockKey?.trim() || undefined,
							runId,
							taskId: orchestrationTaskId,
							model: effectiveModelOverride,
							isolation: useWorktree ? "worktree" : "none",
							worktreePath,
							waitMs: Date.now() - queuedAt,
							background: runInBackground,
							toolCallsStarted: runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted,
							toolCallsCompleted: runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted,
								assistantMessages: runStats?.assistantMessages ?? latestProgress?.assistantMessages,
								delegatedTasks: delegatedTasks > 0 ? delegatedTasks : undefined,
								delegatedSucceeded: delegatedTasks > 0 ? delegatedSucceeded : undefined,
								delegatedFailed: delegatedTasks > 0 ? delegatedFailed : undefined,
								retrospectiveAttempts: retrospectiveAttempts > 0 ? retrospectiveAttempts : undefined,
								retrospectiveRecovered: retrospectiveRecovered > 0 ? retrospectiveRecovered : undefined,
								failureCauses: hasFailureCauses ? { ...failureCauses } : undefined,
							};
						updateTrackedTaskStatus("error");
						throw Object.assign(new Error(`Subagent failed: ${message}`), { details });
					}

						const normalizedOutput = output.trim().length > 0 ? output.trim() : "(Subagent completed with no output)";
						const finalSections: string[] = [normalizedOutput];
						if (delegatedTasks > 0) {
							const header = `### Delegated Subtasks (${delegatedSucceeded}/${delegatedTasks} done)`;
						const delegatedBlocks = delegatedSections.filter(
							(section): section is string => typeof section === "string" && section.trim().length > 0,
						);
						finalSections.push([header, ...delegatedBlocks].join("\n\n"));
						}
						if (delegationWarnings.length > 0) {
							finalSections.push(`### Delegation Notes\n${delegationWarnings.map((w) => `- ${w}`).join("\n")}`);
						}
						const failureCauseSummary = formatFailureCauseCounts(failureCauses);
						if (retrospectiveAttempts > 0 || failureCauseSummary) {
							finalSections.push(
								[
									"### Retrospective",
									`- attempts: ${retrospectiveAttempts}`,
									`- recovered: ${retrospectiveRecovered}`,
									`- failure_causes: ${failureCauseSummary || "none"}`,
								].join("\n"),
							);
						}
						const text = finalSections.join("\n\n");
						emitProgress({
							kind: "subagent_progress",
							phase: "responding",
							message: delegatedTasks > 0 ? "aggregating delegated results" : "finalizing response",
							cwd: subagentCwd,
							activeTool: undefined,
							delegateIndex: undefined,
							delegateTotal: undefined,
							delegateDescription: undefined,
							delegateProfile: undefined,
							delegateItems: undefined,
						});

						const transcriptPath = persistSubagentTranscript({
							rootCwd: cwd,
						runId,
						description,
						profile: effectiveProfile,
						agent: customSubagent?.name,
						lockKey: lockKey?.trim() || undefined,
						model: effectiveModelOverride,
						subagentCwd,
						sessionId: subagentSessionId,
						prompt: promptWithInstructions,
						output: text,
							isolation: useWorktree ? "worktree" : "none",
							worktreePath,
						});
						const hasFailureCauses = Object.keys(failureCauses).length > 0;
						const details: TaskToolDetails = {
							profile: effectiveProfile,
							description,
						outputLength: text.length,
						cwd: subagentCwd,
						agent: customSubagent?.name,
						lockKey: lockKey?.trim() || undefined,
						runId,
						taskId: orchestrationTaskId,
						model: effectiveModelOverride,
						subagentSessionId,
						transcriptPath,
						isolation: useWorktree ? "worktree" : "none",
						worktreePath,
						waitMs: Date.now() - queuedAt,
						background: runInBackground,
						toolCallsStarted:
							typeof (runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted) === "number"
								? (runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted ?? 0) +
									delegatedStats.toolCallsStarted
								: delegatedStats.toolCallsStarted > 0
									? delegatedStats.toolCallsStarted
									: undefined,
						toolCallsCompleted:
							typeof (runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted) === "number"
								? (runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted ?? 0) +
									delegatedStats.toolCallsCompleted
								: delegatedStats.toolCallsCompleted > 0
									? delegatedStats.toolCallsCompleted
									: undefined,
						assistantMessages:
							typeof (runStats?.assistantMessages ?? latestProgress?.assistantMessages) === "number"
								? (runStats?.assistantMessages ?? latestProgress?.assistantMessages ?? 0) +
									delegatedStats.assistantMessages
								: delegatedStats.assistantMessages > 0
									? delegatedStats.assistantMessages
									: undefined,
							delegatedTasks: delegatedTasks > 0 ? delegatedTasks : undefined,
							delegatedSucceeded: delegatedTasks > 0 ? delegatedSucceeded : undefined,
							delegatedFailed: delegatedTasks > 0 ? delegatedFailed : undefined,
							retrospectiveAttempts: retrospectiveAttempts > 0 ? retrospectiveAttempts : undefined,
							retrospectiveRecovered: retrospectiveRecovered > 0 ? retrospectiveRecovered : undefined,
							failureCauses: hasFailureCauses ? { ...failureCauses } : undefined,
						};
						updateTrackedTaskStatus("done");
						return { text, details };
					} finally {
						releaseIsolation?.();
						releaseWriteLock?.();
						releaseSlot?.();
						releaseRunSlot?.();
						if (orchestrationRunId) {
						cleanupOrchestrationSemaphore(cwd, orchestrationRunId);
					}
				}
			};

			if (runInBackground) {
				const now = new Date().toISOString();
				const queuedStatusPath = writeBackgroundRunStatus(cwd, {
					runId,
					status: "queued",
					createdAt: now,
					description,
					profile: effectiveProfile,
					cwd: requestedSubagentCwd,
					agent: customSubagent?.name,
					model: effectiveModelOverride,
				});
				void (async () => {
					writeBackgroundRunStatus(cwd, {
						runId,
						status: "running",
						createdAt: now,
						startedAt: new Date().toISOString(),
						description,
						profile: effectiveProfile,
						cwd: requestedSubagentCwd,
						agent: customSubagent?.name,
						model: effectiveModelOverride,
					});
					try {
						const result = await executeSubagent();
						writeBackgroundRunStatus(cwd, {
							runId,
							status: "done",
							createdAt: now,
							finishedAt: new Date().toISOString(),
							description,
							profile: effectiveProfile,
							cwd: result.details.cwd,
							agent: customSubagent?.name,
							model: effectiveModelOverride,
							transcriptPath: result.details.transcriptPath,
						});
						} catch (error) {
							const aborted = isAbortError(error);
							writeBackgroundRunStatus(cwd, {
								runId,
								status: aborted ? "cancelled" : "error",
								createdAt: now,
								finishedAt: new Date().toISOString(),
								description,
							profile: effectiveProfile,
							cwd: requestedSubagentCwd,
							agent: customSubagent?.name,
							model: effectiveModelOverride,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
				return {
					content: [
						{
							type: "text" as const,
							text: `Started background subagent run ${runId}. Check .iosm/subagents/background and /subagent-runs for results.`,
						},
					],
					details: {
						profile: effectiveProfile,
						description,
						outputLength: 0,
						cwd: requestedSubagentCwd,
						agent: customSubagent?.name,
						lockKey: lockKey?.trim() || undefined,
						runId,
						taskId: orchestrationTaskId,
						model: effectiveModelOverride,
						background: true,
						backgroundStatusPath: queuedStatusPath,
						waitMs: Date.now() - queuedAt,
						isolation: useWorktree ? "worktree" : "none",
						toolCallsStarted: latestProgress?.toolCallsStarted,
						toolCallsCompleted: latestProgress?.toolCallsCompleted,
						assistantMessages: latestProgress?.assistantMessages,
					},
				};
			}

			const result = await executeSubagent();
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
			};
		},
	};
}

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
	AGENT_PROFILES,
	isReadOnlyProfileName,
	isValidProfileName,
	type AgentProfileName,
} from "../agent-profiles.js";
import {
	readSharedMemory,
	type SharedMemoryContext,
	summarizeSharedMemoryUsage,
	writeSharedMemory,
} from "../shared-memory.js";
import {
	appendSubagentBackgroundRunLog,
	registerSubagentBackgroundRunController,
	unregisterSubagentBackgroundRunController,
	writeSubagentBackgroundRunStatus,
} from "../subagent-background-runs.js";
import { normalizeAndFilterToolNames, normalizeToolName, type CustomSubagentDefinition } from "../subagents.js";

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
	agent?: string;
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
			description:
				"Name of a specialist agent to invoke. Prefer agent= over profile= whenever a domain expert exists. " +
				"Built-in specialists: code_reviewer, codebase_auditor, security_auditor, accessibility_auditor, " +
				"system_error_analyst, software_architect, test_failure_triager, incident_response_commander, test_results_analyzer, " +
				"qa_test_engineer, api_test_engineer, backend_architect, frontend_developer, database_optimizer, " +
				"devops_automator, sre_engineer, performance_benchmarker, data_engineer, iosm_change_executor, " +
				"iosm_postchange_verifier, technical_writer, ui_designer, ux_architect, ux_researcher, workflow_optimizer, brand_guardian. " +
				"Custom agents from .iosm/agents/ are also supported.",
		}),
	),
	profile: Type.Optional(
		Type.String({
			description:
				"Capability profile to use when no specialist agent is needed. " +
				"explore = read-only exploration (grep/find/read only). " +
				"plan = architectural analysis, no file writes. " +
				"iosm = IOSM methodology with full write access. " +
				"meta = orchestration-first: decomposes work and fans out delegates. " +
				"full = end-to-end engineering, all tools (default). " +
				"iosm_analyst/iosm_verifier/cycle_planner = IOSM-specific analysis roles. " +
				"Use agent= instead of profile= whenever a named specialist fits the task.",
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
	coordination?: {
		sharedMemoryWrites?: number;
		currentTaskWrites?: number;
		currentTaskDelegateWrites?: number;
		runScopeWrites?: number;
		taskScopeWrites?: number;
		duplicatesDetected?: number;
		claimKeysMatched?: number;
		claimCollisions?: number;
	};
	sharedMemorySummaryKey?: string;
	cleanup?: {
		retries: number;
		failures: number;
		lastErrorCode?: string;
		lastErrorMessage?: string;
	};
}

export interface TaskToolOptions {
	resolveCustomSubagent?: (name: string) => CustomSubagentDefinition | undefined;
	availableCustomSubagents?: string[];
	availableCustomSubagentHints?: Array<{ name: string; description: string; profile?: string; instructions?: string }>;
	/**
	 * Optional semantic router callback used when heuristic auto-routing cannot pick
	 * a specialist. Should return an exact candidate agent name when a strong match exists.
	 */
	routeAgentSemantically?: (input: {
		workstream: string;
		candidates: readonly AutoDelegateAgentHint[];
	}) => Promise<string | undefined>;
	/** Returns currently known runtime tool names (built-ins + extensions) for subagent tool normalization. */
	getAvailableToolNames?: () => readonly string[];
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
	meta: "You are a meta orchestration agent. Your main job is to maximize safe parallel execution through delegates, not to personally do most of the implementation. Start with bounded read-only recon, then form a concrete execution graph: subtasks, delegate subtasks, dependencies, lock domains, and verification steps. The parent agent remains responsible for orchestration and synthesis, so decompose work aggressively instead of collapsing complex work into one worker. For any non-trivial task, orchestration is required: after recon, launch multiple focused delegates instead of continuing manual implementation in the parent agent, avoid direct write/edit work in the parent agent before delegation unless the task is clearly trivial, and do not hand the whole task to one specialist child when independent workstreams exist. If a delegated workstream still contains multiple independent slices, split it again with nested <delegate_task> blocks. Default to aggressive safe parallelism. If the user requested a specific degree of parallelism, honor it when feasible or explain the exact blocker. Delegates are child task calls only; do not treat plain tool invocations (read/bash/grep/etc.) as delegated agents. Assign explicit ownership domains per delegate to minimize overlap; if overlap is unavoidable, declare a primary owner and a secondary verifier. Use shared_memory as the default coordination channel between delegates: use stable namespaced keys, prefer read-before-write, and use CAS (if_version) for contested updates; reserve append mode for timeline/log keys. When delegation is not used for non-trivial work, explain why in one line and include DELEGATION_IMPOSSIBLE. Enforce test verification for code changes, complete only after all delegated branches are resolved, and explicitly justify any no-code path where tests are skipped. For any metrics (speedup, compliance, conflict counts, quality scores), report only values backed by observed runtime evidence; if evidence is missing, mark the metric as unknown. Do not claim report files/artifacts unless they were produced in this run or verified on disk.",
	iosm_analyst:
		"You are an IOSM metrics analyst. Analyze .iosm/ artifacts and codebase metrics. Be precise and evidence-based.",
	iosm_verifier:
		"You are an IOSM verifier. Validate checks and update only required IOSM artifacts with deterministic reasoning.",
	cycle_planner:
		"You are an IOSM cycle planner. Propose and align cycle goals with measurable outcomes and concrete risks.",
	full: "You are a software engineering agent with full tool access. Execute the assigned task end-to-end. Do NOT call task() for greetings, general questions, or anything that does not require code changes — handle those directly. For actionable engineering work that involves a distinct domain, delegate to a specialist via task(agent=NAME) instead of implementing inline. Run independent workstreams in parallel. Prefer task(agent=NAME) over task(profile=) when a specialist exists.",
};

const writeCapableTools = new Set(["bash", "edit", "write", "apply_patch", "git_write", "fs_ops"]);
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

function resolveKnownRuntimeToolNames(options?: TaskToolOptions): Set<string> {
	const known = new Set<string>();
	for (const profileTools of Object.values(toolsByProfile)) {
		for (const tool of profileTools) known.add(normalizeToolName(tool));
	}
	const runtimeTools = options?.getAvailableToolNames?.() ?? [];
	for (const tool of runtimeTools) {
		const normalized = normalizeToolName(tool);
		if (normalized) known.add(normalized);
	}
	return known;
}

function resolveEffectiveToolset(input: {
	tools?: string[];
	disallowedTools?: string[];
	fallbackTools: string[];
	knownToolNames: ReadonlySet<string>;
}): string[] {
	const normalizedFallback = normalizeAndFilterToolNames(input.fallbackTools, input.knownToolNames).normalized;
	const normalizedTools = input.tools
		? normalizeAndFilterToolNames(input.tools, input.knownToolNames).normalized
		: normalizedFallback;
	const normalizedDisallowed = normalizeAndFilterToolNames(input.disallowedTools, input.knownToolNames).normalized;
	if (normalizedDisallowed.length === 0) return normalizedTools;
	const blocked = new Set(normalizedDisallowed);
	return normalizedTools.filter((tool) => !blocked.has(tool));
}

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
	private readonly queue: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(private readonly limit: number) {}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}
		if (this.active < this.limit) {
			this.active += 1;
			return () => this.release();
		}

		await new Promise<void>((resolve, reject) => {
			const waiter: {
				resolve: () => void;
				reject: (error: Error) => void;
				signal?: AbortSignal;
				onAbort?: () => void;
			} = { resolve, reject, signal };
			if (signal) {
				const onAbort = () => {
					const index = this.queue.indexOf(waiter);
					if (index >= 0) {
						this.queue.splice(index, 1);
					}
					signal.removeEventListener("abort", onAbort);
					reject(new Error("Operation aborted"));
				};
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.queue.push(waiter);
		});

		return () => this.release();
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		const next = this.queue.shift();
		if (next) {
			if (next.signal && next.onAbort) {
				next.signal.removeEventListener("abort", next.onAbort);
			}
			this.active += 1;
			next.resolve();
		}
	}

	isIdle(): boolean {
		return this.active === 0 && this.queue.length === 0;
	}
}

class Mutex {
	private locked = false;
	private readonly waiters: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}
		if (!this.locked) {
			this.locked = true;
			return () => this.release();
		}

		await new Promise<void>((resolve, reject) => {
			const waiter: {
				resolve: () => void;
				reject: (error: Error) => void;
				signal?: AbortSignal;
				onAbort?: () => void;
			} = { resolve, reject, signal };
			if (signal) {
				const onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) {
						this.waiters.splice(index, 1);
					}
					signal.removeEventListener("abort", onAbort);
					reject(new Error("Operation aborted"));
				};
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
		this.locked = true;
		return () => this.release();
	}

	private release(): void {
		this.locked = false;
		const next = this.waiters.shift();
		if (next) {
			if (next.signal && next.onAbort) {
				next.signal.removeEventListener("abort", next.onAbort);
			}
			this.locked = true;
			next.resolve();
		}
	}

	isIdle(): boolean {
		return !this.locked && this.waiters.length === 0;
	}
}

const maxParallelFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_PARALLEL,
	Number.MAX_SAFE_INTEGER,
	1,
	Number.MAX_SAFE_INTEGER,
);
const subagentSemaphore = new Semaphore(maxParallelFromEnv);
const maxDelegationDepthFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATION_DEPTH,
	Number.MAX_SAFE_INTEGER,
	0,
	Number.MAX_SAFE_INTEGER,
);
const maxDelegationsPerTaskFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATIONS_PER_TASK,
	Number.MAX_SAFE_INTEGER,
	0,
	Number.MAX_SAFE_INTEGER,
);
const maxDelegatedParallelFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATE_PARALLEL,
	Number.MAX_SAFE_INTEGER,
	1,
	Number.MAX_SAFE_INTEGER,
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
		hasCodeBlock;
	if (referenceCount >= 3 || (referenceCount >= 1 && words >= 20)) {
		score += 1;
	}
	if (hasCodeBlock) {
		score += 1;
	}
	if (metaOrchestratorContext) {
		// In meta orchestration, require delegation pressure for structurally non-trivial prompts.
		if (score === 0) {
			if (metaNonTrivialSignal) {
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

function deriveExplicitDelegateParallelHint(description: string, prompt: string): number | undefined {
	const text = `${description}\n${prompt}`.trim();
	if (!text) return undefined;
	const structuredPatterns = [
		/\bdelegate_parallel_hint\s*[:=]\s*["']?(\d{1,4})\b/i,
		/"delegate_parallel_hint"\s*:\s*(\d{1,4})/i,
	];
	for (const pattern of structuredPatterns) {
		const match = text.match(pattern);
		const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
		if (Number.isInteger(parsed) && parsed >= 1) {
			return parsed;
		}
	}
	return undefined;
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

function stripDelegatedSectionHeading(section: string): string {
	return section.replace(/^####\s+[^\n]*\n?/i, "").trim();
}

function normalizeDelegatedSectionBody(section: string): string {
	return stripDelegatedSectionHeading(section)
		.toLowerCase()
		.replace(/[`"'*_#~[\](){}<>\\|]/g, " ")
		.replace(/[^\w\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function detectDuplicateDelegatedSections(sections: readonly string[]): {
	duplicates: number;
	duplicatePairs: Array<{ duplicate: number; original: number }>;
} {
	const duplicatePairs: Array<{ duplicate: number; original: number }> = [];
	const normalizedSections = sections.map((section) => normalizeDelegatedSectionBody(section));

	for (let index = 0; index < normalizedSections.length; index += 1) {
		const current = normalizedSections[index] ?? "";
		if (current.length < 60) continue;
		for (let previous = 0; previous < index; previous += 1) {
			const baseline = normalizedSections[previous] ?? "";
			if (baseline.length < 60) continue;
			if (current === baseline) {
				duplicatePairs.push({ duplicate: index + 1, original: previous + 1 });
				break;
			}
			const shorter = current.length <= baseline.length ? current : baseline;
			const longer = current.length > baseline.length ? current : baseline;
			if (shorter.length >= 100 && longer.includes(shorter)) {
				const coverage = shorter.length / Math.max(1, longer.length);
				if (coverage >= 0.92) {
					duplicatePairs.push({ duplicate: index + 1, original: previous + 1 });
					break;
				}
			}
		}
	}

	return {
		duplicates: duplicatePairs.length,
		duplicatePairs,
	};
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

	if (baseProfile === "full") return writeIntent ? "full" : "explore";
	if (baseProfile === "meta") return writeIntent ? "full" : "explore";
	if (baseProfile === "iosm") return writeIntent ? "full" : "explore";
	if (baseProfile === "iosm_verifier") return "iosm_verifier";
	if (baseProfile === "cycle_planner") return "cycle_planner";
	if (baseProfile === "plan" || baseProfile === "iosm_analyst") return "explore";
	return "explore";
}

export type AutoDelegateAgentHint = {
	name: string;
	description?: string;
	instructions?: string;
	profile?: string;
};

export function pickAutoDelegateAgent(
	workstream: string,
	availableCustomNames: readonly string[],
	candidateHints?: readonly AutoDelegateAgentHint[],
): string | undefined {
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

	// Semantic description matching: check if any available agent's description
	// contains significant keywords from the workstream. This enables routing to
	// custom agents whose names don't match any hardcoded pattern below.
	if (candidateHints && candidateHints.length > 0) {
		const workstreamWords = normalizedWorkstream
			.split(/\W+/)
			.filter((w) => w.length > 4)
			.slice(0, 20);
		let bestMatch: string | undefined;
		let bestScore = 0;
		for (const hint of candidateHints) {
			if (!hint.description) continue;
			const hintText = `${hint.name} ${hint.description}`.toLowerCase();
			const score = workstreamWords.reduce((acc, word) => acc + (hintText.includes(word) ? 1 : 0), 0);
			if (score > bestScore && score >= 2) {
				bestScore = score;
				bestMatch = hint.name;
			}
		}
		// Only apply semantic match if it wins clearly; fall through to regex patterns otherwise
		if (bestMatch && bestScore >= 3) {
			const resolved = findByHint([bestMatch]);
			if (resolved) return resolved;
		}
	}

	// Test-writing intent must come before security to avoid "auth API tests" → security_auditor
	if (/\b(?:(?:write|add|create|generate)\s+\w*\s*tests?|unit tests?|integration tests?|e2e tests?|specs?|testing)\b/.test(normalizedWorkstream)) {
		return findByHint(["qa_test_engineer", "api_test_engineer", "tester", "qa"]);
	}

	// Security must come before generic catch-all which also contains security/auth keywords.
	// Use authentication/authorization full forms to avoid matching "auth" in unrelated contexts.
	if (
		/\b(?:security|vuln(?:erabilit(?:y|ies))?|pentest|penetration|xss|injection|sqli|csrf|owasp|secrets?|credential|leak|exploit|attack|auth(?:entication|orization)|rbac)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["security_auditor", "code_reviewer", "codebase_auditor", "security"]);
	}

	if (/\b(?:performance|latency|throughput|benchmark|profil(?:e|ing)|load tests?|stress tests?|p95|p99|speed)\b/.test(normalizedWorkstream)) {
		return findByHint(["performance_benchmarker", "performance", "benchmark"]);
	}
	if (/\b(?:code review|review pr|pr review|pull request|merge readiness|diff review|review\s+\w+\.(?:ts|js|py|go|rs|java))\b/.test(normalizedWorkstream)) {
		return findByHint(["code_reviewer", "code reviewer", "reviewer"]);
	}
	// Generic audit/review must come early — before domain catch-alls that also mention codebase/api/etc.
	if (/\b(?:audit|inspect|analys[ei]s|assess)\b/.test(normalizedWorkstream)) {
		return findByHint([
			"codebase_auditor",
			"code_reviewer",
			"security_auditor",
			"test_results_analyzer",
			"auditor",
			"reviewer",
		]);
	}

	if (
		/\b(?:workflow optimization|process optimization|workflow bottleneck|cycle time|handoff|process handoff|process automation|streamline workflow)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["workflow_optimizer", "devops_automator", "technical_writer", "workflow", "process"]);
	}
	if (
		/\b(?:tool evaluation|evaluate tools?|tooling assessment|tool comparison|vendor evaluation|selection matrix|tco|roi|proof of concept|poc)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["tool_evaluator", "workflow_optimizer", "technical_writer", "tool"]);
	}
	if (
		/\b(?:reality check|sanity check|claim validation|evidence validation|readiness gate|production readiness audit|cross-validate|verify claims)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["reality_checker", "test_results_analyzer", "code_reviewer", "qa_test_engineer", "checker"]);
	}
	if (/\b(?:incident|outage|sev[0-9]?|postmortem|post-mortem|rca|root cause|rollback|mitigation)\b/.test(normalizedWorkstream)) {
		return findByHint(["incident_response_commander", "incident", "commander", "system_error_analyst"]);
	}
	// docs/readme before api to avoid "api documentation" → api_test_engineer
	if (/\b(?:docs?|documentation|readme|guide|changelog|api reference|migration guide|getting started)\b/.test(normalizedWorkstream)) {
		return findByHint(["technical_writer", "technical writer", "writer", "docs"]);
	}
	if (/\b(?:api|endpoint|contract|openapi|swagger|http|rest|graphql|webhook)\b/.test(normalizedWorkstream)) {
		return findByHint(["api_test_engineer", "backend_architect", "api_tester", "api tester", "api"]);
	}
	if (
		/\b(?:data pipeline|etl|elt|ingest|ingestion|warehouse|lakehouse|data mart|dbt|spark|kafka|airflow|lineage|freshness)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["data_engineer", "database_optimizer", "backend_architect", "data"]);
	}
	if (/\b(?:database|db |sql|query plan|explain|index(?:ing)?|postgres|mysql|sqlite|mongo)\b/.test(normalizedWorkstream)) {
		return findByHint(["database_optimizer", "database", "db", "sql", "backend"]);
	}
	// devops/CI/CD must come before microservice/backend to avoid false-positive on "microservice pipeline"
	if (/\b(?:devops|ci(?:\/cd)?|pipeline|deploy(?:ment)?|release|kubernetes|terraform|helm|infra(?:structure)?|dockerfile|github actions|gitlab ci)\b/.test(normalizedWorkstream)) {
		return findByHint(["devops_automator", "sre_engineer", "devops", "sre"]);
	}
	if (
		/\b(?:sre|reliability|availability|error budget|slo|sli|burn rate|observability|golden signals|on-call|oncall|runbook)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["sre_engineer", "incident_response_commander", "devops_automator", "sre"]);
	}
	if (
		/\b(?:backend|back-end|service layer|microservice|grpc|repository pattern|domain model|bounded context|event-driven|service mesh)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["backend_architect", "software_architect", "backend", "database_optimizer"]);
	}
	if (
		/\b(?:test results|quality metrics|failure trend|defect density|release readiness|go\/no-go|flaky trend|quality report)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["test_results_analyzer", "qa_test_engineer", "tester", "qa"]);
	}
	if (/\b(?:test|qa|coverage|verification|regression)\b/.test(normalizedWorkstream)) {
		return findByHint([
			"test_results_analyzer",
			"qa_test_engineer",
			"api_test_engineer",
			"performance_benchmarker",
			"accessibility_auditor",
			"qa",
			"tester",
			"verification",
		]);
	}
	// docs/readme must come before generic api pattern to avoid "api documentation" → api_test_engineer
	if (/\b(?:docs?|documentation|readme|guide|changelog|api reference|migration guide|getting started)\b/.test(normalizedWorkstream)) {
		return findByHint(["technical_writer", "technical writer", "writer", "docs"]);
	}
	if (
		/\b(?:brand|branding|voice and tone|tone of voice|messaging|positioning|brand guideline|style guide|brand consistency)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["brand_guardian", "technical_writer", "ui_designer", "brand"]);
	}
	if (
		/\b(?:css|scss|sass|less|stylesheet|styling|style bug|html|dom|javascript|typescript|frontend bug|frontend fix|mobile menu|responsive)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["frontend_developer", "ui_designer", "frontend", "ui"]);
	}
	if (
		/\b(?:svg|icon|icons|illustration|illustrations|image asset|image assets|assets|sprite|logo|figma|visual polish|visual cleanup)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["ui_designer", "frontend_developer", "design", "ui"]);
	}
	if (
		/\b(?:frontend|front-end|client side|client-side|react|vue|angular|svelte|jsx|tsx|tailwind|browser ui)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["frontend_developer", "ui_designer", "frontend", "ui"]);
	}
	if (/\b(?:usability|user research|interview|persona|journey|heuristic|research)\b/.test(normalizedWorkstream)) {
		return findByHint(["ux_researcher", "ux researcher", "researcher", "ux"]);
	}
	if (/\b(?:design system|design token|component|visual|wireframe|mockup|ui)\b/.test(normalizedWorkstream)) {
		return findByHint(["ui_designer", "frontend_developer", "ui designer", "design", "ui"]);
	}
	if (/\b(?:information architecture|interaction flow|user flow|navigation|ux architecture|ux)\b/.test(normalizedWorkstream)) {
		return findByHint(["ux_architect", "ux architect", "ux", "architect"]);
	}
	if (/\b(?:ui|ux|design|layout|accessibility)\b/.test(normalizedWorkstream)) {
		return findByHint([
			"accessibility_auditor",
			"ux_architect",
			"ui_designer",
			"ux_researcher",
			"uiux_top_senior",
			"uiux",
			"ui",
			"ux",
			"design",
		]);
	}
	// Generic architecture / codebase catch-all (security/auth already handled above)
	if (/\b(?:architecture|codebase|refactor|database|api)\b/.test(normalizedWorkstream)) {
		return findByHint([
			"software_architect",
			"backend_architect",
			"code_reviewer",
			"data_engineer",
			"database_optimizer",
			"codebase_auditor",
			"architect",
			"backend",
		]);
	}

	// Error / crash / exception analysis
	if (
		/\b(?:error|exception|crash|stack trace|traceback|bug|failure|broken|fix|debug|diagnos)\b/.test(
			normalizedWorkstream,
		)
	) {
		return findByHint(["system_error_analyst", "code_reviewer", "test_failure_triager", "error"]);
	}

	// Accessibility before generic audit — "a11y audit" should route to accessibility specialist, not codebase_auditor
	if (/\b(?:a11y|wcag|aria|screen reader|keyboard nav(?:igation)?|contrast ratio|accessible)\b/.test(normalizedWorkstream)) {
		return findByHint(["accessibility_auditor", "ux_architect", "ui_designer", "accessibility"]);
	}

	// Audit / review (generic)
	if (/\b(?:audit|inspect|review|check|analys[ei]s|assess|evaluat)\b/.test(normalizedWorkstream)) {
		return findByHint([
			"codebase_auditor",
			"code_reviewer",
			"security_auditor",
			"test_results_analyzer",
			"auditor",
			"reviewer",
		]);
	}

	// Write / add tests (generic)
	if (/\b(?:(?:write|add|create|generate)\s+\w*\s*tests?|unit tests?|integration tests?|e2e tests?|spec(?:s)?|testing)\b/.test(normalizedWorkstream)) {
		return findByHint(["qa_test_engineer", "api_test_engineer", "tester", "qa"]);
	}

	// Documentation (generic)
	if (/\b(?:document|write docs?|update readme|add comments?|explain|annotate|changelog)\b/.test(normalizedWorkstream)) {
		return findByHint(["technical_writer", "writer", "docs"]);
	}

	// Monitoring / alerting / observability
	if (/\b(?:monitor|alert(?:ing)?|metrics?|dashboard|prometheus|grafana|datadog|pagerduty|logging|tracing)\b/.test(normalizedWorkstream)) {
		return findByHint(["sre_engineer", "devops_automator", "sre", "devops"]);
	}

	// System design / architecture planning
	if (/\b(?:design|blueprint|system design|architect(?:ure)?|adr|adl|trade.?off|service mesh|hexagonal|clean arch)\b/.test(normalizedWorkstream)) {
		return findByHint(["software_architect", "backend_architect", "architect"]);
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

function uniquifyWorkstreamTitles(titles: string[]): string[] {
	const counts = new Map<string, number>();
	return titles.map((title) => {
		const key = title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
		const next = (counts.get(key) ?? 0) + 1;
		counts.set(key, next);
		if (next <= 1) return title;
		return `${title} (${next})`;
	});
}

function semanticallyDeduplicateWorkstreamTitles(titles: string[]): string[] {
	const kept: string[] = [];
	const tokenized = (value: string): Set<string> =>
		new Set(
			value
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, " ")
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length >= 3),
		);
	const jaccard = (left: Set<string>, right: Set<string>): number => {
		if (left.size === 0 || right.size === 0) return 0;
		let intersection = 0;
		for (const token of left) {
			if (right.has(token)) intersection += 1;
		}
		const union = left.size + right.size - intersection;
		return union > 0 ? intersection / union : 0;
	};

	for (const candidate of titles) {
		const candidateTokens = tokenized(candidate);
		const duplicate = kept.some((existing) => {
			const existingTokens = tokenized(existing);
			const similarity = jaccard(existingTokens, candidateTokens);
			return similarity >= 0.82;
		});
		if (!duplicate) {
			kept.push(candidate);
		}
	}
	return kept;
}

function deriveAutoSynthLockKey(streamTitle: string, ordinal: number): string {
	const pathLike = streamTitle.match(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/)?.[0];
	if (pathLike) {
		const normalizedPath = pathLike
			.replace(/^[./]+/, "")
			.split("/")
			.filter((segment) => segment.length > 0)
			.slice(0, 2)
			.join("/");
		return `auto-synth:${toSharedMemoryKeySegment(normalizedPath, `stream-${ordinal}`)}`;
	}

	if (/\b(auth|rbac|acl|permission)\b/i.test(streamTitle)) return "auto-synth:auth";
	if (/\b(db|database|sql|storage|schema)\b/i.test(streamTitle)) return "auto-synth:data";
	if (/\b(ui|ux|frontend|view|component)\b/i.test(streamTitle)) return "auto-synth:ui";
	if (/\b(test|qa|verification|coverage)\b/i.test(streamTitle)) return "auto-synth:test";
	if (/\b(api|gateway|route|http)\b/i.test(streamTitle)) return "auto-synth:api";

	return `auto-synth:${toSharedMemoryKeySegment(streamTitle, `stream-${ordinal}`)}`;
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
	const semanticallyDeduped = semanticallyDeduplicateWorkstreamTitles(titles);
	while (semanticallyDeduped.length < missing) {
		semanticallyDeduped.push(`Independent workstream ${semanticallyDeduped.length + 1}`);
	}
	const uniqueTitles = uniquifyWorkstreamTitles(semanticallyDeduped);

	const defaultProfile = deriveAutoDelegateProfile(input.baseProfile, input.description, input.prompt);
	return uniqueTitles.map((streamTitle, index) => ({
		description: `Auto: ${streamTitle}`,
		profile: defaultProfile,
		agent: pickAutoDelegateAgent(streamTitle, input.availableCustomNames),
		prompt: buildAutoDelegationPrompt({
			streamTitle,
			rootDescription: input.description,
			rootPrompt: input.prompt,
			ordinal: input.currentDelegates + index + 1,
			total: input.currentDelegates + uniqueTitles.length,
		}),
		cwd: undefined,
		lockKey: writeCapableProfiles.has(defaultProfile) ? deriveAutoSynthLockKey(streamTitle, index + 1) : undefined,
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

function toSharedMemoryKeySegment(raw: string | undefined, fallback: string): string {
	const normalized = (raw ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!normalized) return fallback;
	return normalized.slice(0, 64);
}

function buildTaskPlanSharedMemoryKey(taskId: string | undefined): string {
	return `plan/${toSharedMemoryKeySegment(taskId, "task")}`;
}

function buildDelegateFindingSharedMemoryKey(taskId: string | undefined, delegateLabel: string): string {
	return `findings/${toSharedMemoryKeySegment(taskId, "task")}/${toSharedMemoryKeySegment(delegateLabel, "stream")}`;
}

function extractClaimCandidates(text: string, maxItems = 3): string[] {
	const matches = text.match(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g) ?? [];
	const normalized = new Set<string>();
	for (const match of matches) {
		const cleaned = match
			.replace(/^[./]+/, "")
			.replace(/\/+/g, "/")
			.trim();
		if (!cleaned) continue;
		normalized.add(cleaned);
		if (normalized.size >= maxItems) break;
	}
	return Array.from(normalized);
}

function buildClaimKey(pathLike: string): string {
	const segments = pathLike
		.split("/")
		.map((segment) => toSharedMemoryKeySegment(segment, "segment"))
		.filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return "claims/unknown";
	}
	return `claims/${segments.slice(0, 6).join("/")}`;
}

function buildDelegateCoordinationGuidance(input: {
	taskId: string | undefined;
	delegateLabel: string;
	delegateDescription: string;
}): string {
	const planKey = buildTaskPlanSharedMemoryKey(input.taskId);
	const findingKey = buildDelegateFindingSharedMemoryKey(input.taskId, input.delegateLabel);
	return [
		"[DELEGATE_COORDINATION]",
		`delegate_label: ${input.delegateLabel}`,
		`delegate_description: ${input.delegateDescription}`,
		`read_first_key: ${planKey}`,
		`publish_key: ${findingKey}`,
		"Before heavy repository reads, check current coordination state via shared_memory_read.",
		"Use claims/<path> run-scoped keys with CAS (if_version) to announce file ownership and reduce duplicate reads.",
		"Before responding, publish concise stream findings via shared_memory_write.",
		"Keep ownership strict: do not duplicate sibling streams.",
		"[/DELEGATE_COORDINATION]",
	].join("\n");
}

function createSharedMemoryExcerpt(value: string, maxChars = 1200): string {
	const normalized = normalizeSpacing(value);
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(120, maxChars - 3)).trimEnd()}...`;
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
		return Math.max(1, teamRun.agents);
	}
	return Math.max(1, maxParallel);
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

function gitResult(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; status: number | null } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
		status: result.status,
	};
}

interface WorktreeCleanupTelemetryEvent {
	type: "retry" | "failure";
	stage: "git_remove" | "fs_remove";
	attempt: number;
	errorCode?: string;
	errorMessage?: string;
}

type WorktreeCleanupTelemetryHook = (event: WorktreeCleanupTelemetryEvent) => void;

interface WorktreeCleanupState {
	retries: number;
	failures: number;
	lastErrorCode?: string;
	lastErrorMessage?: string;
}

const WORKTREE_CLEANUP_MAX_ATTEMPTS = 4;
const WORKTREE_CLEANUP_BASE_DELAY_MS = 40;
const WORKTREE_CLEANUP_RETRYABLE_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"]);

function parseErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const record = error as Record<string, unknown>;
	return typeof record.code === "string" ? record.code : undefined;
}

function parseErrorMessage(error: unknown): string | undefined {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return undefined;
}

function isRetryableWorktreeCleanupError(errorCode: string | undefined, errorMessage: string | undefined): boolean {
	if (errorCode && WORKTREE_CLEANUP_RETRYABLE_CODES.has(errorCode)) return true;
	const message = (errorMessage ?? "").toLowerCase();
	return (
		message.includes("not empty") ||
		message.includes("resource busy") ||
		message.includes("device or resource busy") ||
		message.includes("locked")
	);
}

function createWorktreeCleanupState(): WorktreeCleanupState {
	return {
		retries: 0,
		failures: 0,
		lastErrorCode: undefined,
		lastErrorMessage: undefined,
	};
}

function pauseCleanupRetry(delayMs: number): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runCleanupStageWithRetry(input: {
	stage: "git_remove" | "fs_remove";
	maxAttempts?: number;
	baseDelayMs?: number;
	onTelemetry?: WorktreeCleanupTelemetryHook;
	run: () => { ok: true } | { ok: false; errorCode?: string; errorMessage?: string };
}): Promise<boolean> {
	const attempts = Math.max(1, input.maxAttempts ?? WORKTREE_CLEANUP_MAX_ATTEMPTS);
	let delayMs = Math.max(1, input.baseDelayMs ?? WORKTREE_CLEANUP_BASE_DELAY_MS);
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		const outcome = input.run();
		if (outcome.ok) {
			return true;
		}
		const canRetry =
			attempt < attempts &&
			isRetryableWorktreeCleanupError(outcome.errorCode, outcome.errorMessage);
		if (canRetry) {
			input.onTelemetry?.({
				type: "retry",
				stage: input.stage,
				attempt,
				errorCode: outcome.errorCode,
				errorMessage: outcome.errorMessage,
			});
			await pauseCleanupRetry(delayMs);
			delayMs = Math.min(delayMs * 2, 1_000);
			continue;
		}
		input.onTelemetry?.({
			type: "failure",
			stage: input.stage,
			attempt,
			errorCode: outcome.errorCode,
			errorMessage: outcome.errorMessage,
		});
		return false;
	}
	return false;
}

function provisionWorktree(
	rootCwd: string,
	targetCwd: string,
	runId: string,
	onCleanupTelemetry?: WorktreeCleanupTelemetryHook,
): { runCwd: string; worktreePath?: string; cleanup: () => Promise<void> } {
	const insideRepo = gitResult(["rev-parse", "--is-inside-work-tree"], rootCwd);
	if (!insideRepo.ok || insideRepo.stdout !== "true") {
		return { runCwd: targetCwd, cleanup: async () => {} };
	}
	const repoRootResult = gitResult(["rev-parse", "--show-toplevel"], rootCwd);
	if (!repoRootResult.ok || !repoRootResult.stdout) {
		return { runCwd: targetCwd, cleanup: async () => {} };
	}

	const repoRoot = repoRootResult.stdout;
	const relative = path.relative(repoRoot, targetCwd);
	if (relative.startsWith("..")) {
		return { runCwd: targetCwd, cleanup: async () => {} };
	}

	const worktreePath = path.join(rootCwd, ".iosm", "subagents", "worktrees", runId);
	mkdirSync(path.dirname(worktreePath), { recursive: true });
	const added = gitResult(["worktree", "add", "--detach", worktreePath], repoRoot);
	if (!added.ok) {
		return { runCwd: targetCwd, cleanup: async () => {} };
	}

	const runCwd = path.resolve(worktreePath, relative);
	const cleanup = async (): Promise<void> => {
		await runCleanupStageWithRetry({
			stage: "git_remove",
			onTelemetry: onCleanupTelemetry,
			run: () => {
				const removed = gitResult(["worktree", "remove", "--force", worktreePath], repoRoot);
				if (removed.ok) return { ok: true };
				return {
					ok: false,
					errorCode: removed.status === null ? undefined : `git_exit_${removed.status}`,
					errorMessage: removed.stderr || "git worktree remove failed",
				};
			},
		});
		await runCleanupStageWithRetry({
			stage: "fs_remove",
			onTelemetry: onCleanupTelemetry,
			run: () => {
				try {
					rmSync(worktreePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
					return { ok: true };
				} catch (error) {
					return {
						ok: false,
						errorCode: parseErrorCode(error),
						errorMessage: parseErrorMessage(error),
					};
				}
			},
		});
	};

	return { runCwd, worktreePath, cleanup };
}

export const __taskToolTestUtils = {
	runCleanupStageWithRetry,
	isRetryableWorktreeCleanupError,
};

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
	const buildAgentCatalogSnippet = (): string => {
		const hints = options?.availableCustomSubagentHints;
		const names = options?.availableCustomSubagents;
		if (hints && hints.length > 0) {
			// Group agents by profile category for clear LLM guidance
			const readOnly = hints.filter((h) => h.profile === "explore" || h.profile === "iosm_analyst");
			const analysts = hints.filter((h) => h.profile === "plan");
			const engineers = hints.filter(
				(h) => !h.profile || h.profile === "full" || h.profile === "iosm",
			);
			const iosmSpecific = hints.filter(
				(h) => h.profile === "iosm_verifier" || h.profile === "cycle_planner",
			);
			const ungrouped = hints.filter(
				(h) =>
					!readOnly.includes(h) && !analysts.includes(h) && !engineers.includes(h) && !iosmSpecific.includes(h),
			);
			const parts: string[] = [];
			if (readOnly.length > 0) parts.push(`Read-only: ${readOnly.map((h) => h.name).join(", ")}`);
			if (analysts.length > 0) parts.push(`Analysts: ${analysts.map((h) => h.name).join(", ")}`);
			if (engineers.length > 0) parts.push(`Engineers: ${engineers.map((h) => h.name).join(", ")}`);
			if (iosmSpecific.length > 0) parts.push(`IOSM: ${iosmSpecific.map((h) => h.name).join(", ")}`);
			if (ungrouped.length > 0) parts.push(`Other: ${ungrouped.map((h) => h.name).join(", ")}`);
			return parts.length > 0 ? ` Specialists (agent=NAME): ${parts.join(" | ")}.` : "";
		}
		if (names && names.length > 0) {
			return ` Available agents (agent=NAME): ${names.join(", ")}.`;
		}
		return "";
	};
	const customAgentsSnippet = buildAgentCatalogSnippet();
	return {
		name: "task",
		label: "task",
		description:
			"Launch a specialized subagent to handle a subtask in isolation. " +
			"ROUTING: use agent=NAME for a domain specialist (preferred); use profile= for generic capability routing. " +
			"Profiles: explore=read-only exploration, plan=analysis/no-writes, iosm=IOSM implementation, meta=orchestration fan-out, full=end-to-end (default). " +
			"Set cwd to scope subagents to different project areas when running in parallel. " +
			"The subagent runs to completion and returns its full text output. " +
			"It may emit <delegate_task> blocks for bounded follow-up delegation." +
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
			let runtimeAbortSignal: AbortSignal | undefined = _signal;
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
				if (runtimeAbortSignal?.aborted) {
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
				const autoRoutingEligibleProfiles = new Set<AgentProfileName>(["full", "plan", "explore", "iosm", "meta"]);

				// Auto-route to a specialist whenever no explicit agent was requested and the
				// profile is eligible. The orchestration/meta/parallel guard is removed:
				// even simple single-agent calls benefit from specialist routing when
				// the workstream description matches a known domain pattern.
					const canAutoSelectSpecializedAgent =
						!normalizedAgentName &&
						!customSubagent &&
						availableCustomNames.length > 0 &&
						autoRoutingEligibleProfiles.has((normalizedProfile as AgentProfileName) ?? "full");
					if (canAutoSelectSpecializedAgent) {
						const routingWorkstream = `${description}\n${prompt}`;
						const routingHints: AutoDelegateAgentHint[] =
							options?.availableCustomSubagentHints && options.availableCustomSubagentHints.length > 0
								? options.availableCustomSubagentHints.map((hint) => ({
									name: hint.name,
									description: hint.description,
									profile: hint.profile,
									instructions: hint.instructions,
								}))
								: availableCustomNames.map((name) => ({ name }));
						let inferredAgentName = pickAutoDelegateAgent(
							routingWorkstream,
							availableCustomNames,
							routingHints,
						);
						if (!inferredAgentName && options?.routeAgentSemantically) {
							try {
								const semanticCandidate = await options.routeAgentSemantically({
									workstream: routingWorkstream,
									candidates: routingHints,
								});
								if (semanticCandidate?.trim()) {
									inferredAgentName = semanticCandidate.trim();
								}
							} catch {
								// Semantic fallback is best-effort.
							}
						}
						if (inferredAgentName) {
							const inferredSubagent = resolveCustom(inferredAgentName);
							if (inferredSubagent) {
							customSubagent = inferredSubagent;
							normalizedAgentName = inferredSubagent.name;
							const inferredProfile = inferredSubagent.profile?.trim().toLowerCase();
							if (inferredProfile && isValidProfileName(inferredProfile)) {
								normalizedProfile = inferredProfile;
							}
						}
					}
				}

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
				const knownRuntimeToolNames = resolveKnownRuntimeToolNames(options);
				const tools = resolveEffectiveToolset({
					tools: customSubagent?.tools,
					disallowedTools: customSubagent?.disallowedTools,
					fallbackTools: toolsByProfile[effectiveProfile],
					knownToolNames: knownRuntimeToolNames,
				});
					if (isReadOnlyProfileName(normalizedHostProfile) && tools.some((tool) => writeCapableTools.has(tool))) {
						throw new Error(
							`Host profile "${normalizedHostProfile}" is read-only. Switch to full/meta/iosm to launch write-capable subtasks.`,
						);
					}
				const delegationDepth = maxDelegationDepthFromEnv;
					const requestedDelegateParallelHint =
						typeof delegateParallelHint === "number" && Number.isInteger(delegateParallelHint)
							? Math.max(1, delegateParallelHint)
							: undefined;
				const explicitDelegateParallelHint =
					requestedDelegateParallelHint === undefined
						? deriveExplicitDelegateParallelHint(description, prompt)
						: undefined;
				const autoDelegateParallelHint =
					requestedDelegateParallelHint === undefined && explicitDelegateParallelHint === undefined
						? deriveAutoDelegateParallelHint(
								effectiveProfile,
								normalizedAgentName,
								normalizedHostProfile,
								description,
								prompt,
							)
						: undefined;
				const effectiveDelegateParallelHint =
					requestedDelegateParallelHint ?? explicitDelegateParallelHint ?? autoDelegateParallelHint;
				const effectiveDelegationDepth =
					effectiveProfile === "meta" || normalizedHostProfile === "meta" || normalizedAgentName?.toLowerCase().includes("orchestrator")
						? Math.max(delegationDepth, 2)
						: delegationDepth;
				const orchestratedRunContext = !!(orchestrationRunId && orchestrationTaskId);
				const explicitDelegationContract =
					explicitDelegateParallelHint !== undefined && explicitDelegateParallelHint >= 1;
				const strictDelegationContract =
					effectiveProfile === "meta" ||
					normalizedHostProfile === "meta" ||
					normalizedAgentName?.toLowerCase().includes("orchestrator") ||
					(orchestratedRunContext && (effectiveDelegateParallelHint ?? 0) >= 2) ||
					explicitDelegationContract;
				let effectiveMaxDelegations = Math.max(
					0,
					Math.min(maxDelegationsPerTaskFromEnv, effectiveDelegateParallelHint ?? maxDelegationsPerTaskFromEnv),
				);
				let effectiveMaxDelegateParallel = Math.max(
					1,
					Math.min(maxDelegatedParallelFromEnv, effectiveDelegateParallelHint ?? maxDelegatedParallelFromEnv),
				);
				if (explicitDelegationContract) {
					const explicitTarget = Math.max(
						1,
						explicitDelegateParallelHint ?? 1,
					);
					effectiveMaxDelegations = Math.max(
						effectiveMaxDelegations,
						Math.min(maxDelegationsPerTaskFromEnv, explicitTarget),
					);
					effectiveMaxDelegateParallel = Math.max(
						effectiveMaxDelegateParallel,
						Math.min(maxDelegatedParallelFromEnv, explicitTarget),
					);
				}
				const isMetaDelegationContext = effectiveProfile === "meta" || normalizedHostProfile === "meta";
				const preferredDelegationFloorBase = isMetaDelegationContext ? 3 : 2;
				const preferredDelegationFloorMin = isMetaDelegationContext ? 2 : 1;
				const metaDelegationCapacityFloor = 3;
				const preferredDelegationFloor = Math.max(
					preferredDelegationFloorMin,
					Math.min(preferredDelegationFloorBase, effectiveDelegateParallelHint ?? preferredDelegationFloorBase),
				);
				const applyMetaDelegationFloor =
					requestedDelegateParallelHint === undefined &&
					(effectiveProfile === "meta" || normalizedHostProfile === "meta");
				if (applyMetaDelegationFloor) {
					effectiveMaxDelegations = Math.max(
						effectiveMaxDelegations,
						Math.min(maxDelegationsPerTaskFromEnv, metaDelegationCapacityFloor),
					);
					effectiveMaxDelegateParallel = Math.max(
						effectiveMaxDelegateParallel,
						Math.min(maxDelegatedParallelFromEnv, preferredDelegationFloor),
					);
				}
				const minDelegationsPreferred = explicitDelegationContract
					? effectiveMaxDelegations > 0
						? Math.min(Math.max(1, explicitDelegateParallelHint ?? 1), effectiveMaxDelegations)
						: 0
					: (effectiveDelegateParallelHint ?? 0) >= 2 && effectiveMaxDelegations >= 2
						? Math.min(
								preferredDelegationFloor,
								effectiveMaxDelegations,
								effectiveDelegateParallelHint ?? preferredDelegationFloor,
							)
						: 0;
				const runtimeCapabilityHints =
					"Runtime capability: for long-running shell commands that should not block the turn (especially start/run-project or dev-server/watch commands), use bash with run_in_background=true and report backgroundTaskId for follow-up monitoring/stop actions; keep foreground mode only when immediate command output is required.";
				const baseSystemPrompt = withSubagentInstructions(
					`${customSubagent?.systemPrompt ??
						systemPromptByProfile[effectiveProfile] ??
						systemPromptByProfile.full}\n\n${runtimeCapabilityHints}`,
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
				const agent = "agent" in incoming ? incoming.agent : latestProgress?.agent ?? customSubagent?.name;
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
					agent,
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
					let releaseIsolation: (() => Promise<void>) | undefined;
					const explicitRootLockKey = lockKey?.trim();
					let subagentCwd = requestedSubagentCwd;
					let worktreePath: string | undefined;
					let runStats: SubagentRunResult["stats"] | undefined;
					const cleanupState = createWorktreeCleanupState();
					const onCleanupTelemetry: WorktreeCleanupTelemetryHook = (event) => {
						if (event.type === "retry") {
							cleanupState.retries += 1;
							return;
						}
						cleanupState.failures += 1;
						cleanupState.lastErrorCode = event.errorCode;
						cleanupState.lastErrorMessage =
							event.errorMessage ?? `${event.stage} failed at attempt ${event.attempt}`;
					};
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
						const release = await lock.acquire(runtimeAbortSignal);
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
									signal: runtimeAbortSignal,
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
									if (runtimeAbortSignal?.aborted || isAbortError(error)) {
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
						releaseRunSlot = await orchestrationSemaphore.acquire(runtimeAbortSignal);
						throwIfAborted();
					}
					releaseSlot = await subagentSemaphore.acquire(runtimeAbortSignal);
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
						const isolated = provisionWorktree(cwd, requestedSubagentCwd, runId, onCleanupTelemetry);
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
						const publishTaskCoordinationPlan = async (): Promise<void> => {
							const key = buildTaskPlanSharedMemoryKey(sharedMemoryTaskId);
							const payload = JSON.stringify({
								taskId: sharedMemoryTaskId,
								description,
								profile: effectiveProfile,
								objective: createSharedMemoryExcerpt(prompt, 900),
							});
							try {
								await writeSharedMemory(
									rootSharedMemoryContext,
									{
										key,
										value: payload,
										scope: "run",
										mode: "set",
									},
									runtimeAbortSignal,
								);
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								delegationWarnings.push(`Shared memory plan publish skipped: ${message}`);
							}
						};
						const publishDelegateFinding = async (input: {
							delegateLabel: string;
							delegateDescription: string;
							delegateProfile: string;
							status: "done" | "failed";
							content: string;
						}): Promise<void> => {
							const key = buildDelegateFindingSharedMemoryKey(sharedMemoryTaskId, input.delegateLabel);
							const payload = JSON.stringify({
								taskId: sharedMemoryTaskId,
								delegate: input.delegateLabel,
								description: input.delegateDescription,
								profile: input.delegateProfile,
								status: input.status,
								summary: createSharedMemoryExcerpt(input.content, 1000),
							});
							try {
								await writeSharedMemory(
									{
										rootCwd: cwd,
										runId: sharedMemoryRunId,
										taskId: sharedMemoryTaskId,
										delegateId: input.delegateLabel,
										profile: input.delegateProfile,
									},
									{
										key,
										value: payload,
										scope: "run",
										mode: "set",
									},
									runtimeAbortSignal,
								);
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								delegationWarnings.push(
									`Shared memory finding publish skipped for delegate ${input.delegateLabel}: ${message}`,
								);
							}
						};
						const publishStreamClaims = async (input: {
							owner: string;
							description: string;
							promptText: string;
						}): Promise<void> => {
							const claimPaths = extractClaimCandidates(`${input.description}\n${input.promptText}`, 3);
							if (claimPaths.length === 0) return;
							for (const claimPath of claimPaths) {
								const key = buildClaimKey(claimPath);
								let lastError: string | undefined;
								for (let attempt = 0; attempt < 2; attempt += 1) {
									try {
										const snapshot = await readSharedMemory(
											rootSharedMemoryContext,
											{
												scope: "run",
												key,
												includeValues: true,
											},
											runtimeAbortSignal,
										);
										const current = snapshot.items[0];
										if (!current) {
											await writeSharedMemory(
												rootSharedMemoryContext,
												{
													key,
													value: JSON.stringify({
														path: claimPath,
														owners: [input.owner],
														updatedAt: new Date().toISOString(),
													}),
													scope: "run",
													mode: "set",
												},
												runtimeAbortSignal,
											);
											lastError = undefined;
											break;
										}
										let existingOwners: string[] = [];
										if (current.value) {
											try {
												const parsed = JSON.parse(current.value) as { owners?: unknown };
												if (Array.isArray(parsed.owners)) {
													existingOwners = parsed.owners
														.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
														.slice(0, 12);
												}
											} catch {
												// tolerate malformed payload and overwrite with normalized shape
											}
										}
										if (existingOwners.includes(input.owner)) {
											lastError = undefined;
											break;
										}
										const nextOwners = [...existingOwners, input.owner].slice(0, 12);
										await writeSharedMemory(
											rootSharedMemoryContext,
											{
												key,
												value: JSON.stringify({
													path: claimPath,
													owners: nextOwners,
													updatedAt: new Date().toISOString(),
												}),
												scope: "run",
												mode: "set",
												ifVersion: current.version,
											},
											runtimeAbortSignal,
										);
										lastError = undefined;
										break;
									} catch (error) {
										const message = error instanceof Error ? error.message : String(error);
										lastError = message;
										if (!/version mismatch/i.test(message)) {
											break;
										}
									}
								}
								if (lastError) {
									delegationWarnings.push(
										`Shared memory claim publish skipped (${key}) for ${input.owner}: ${lastError}`,
									);
								}
							}
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
											signal: runtimeAbortSignal,
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
										if (runtimeAbortSignal?.aborted || isAbortError(error)) {
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
						await publishTaskCoordinationPlan();
						await publishStreamClaims({
							owner: "root",
							description,
							promptText: prompt,
						});
						const firstPass = await runRootPass(rootPrompt);
						output = firstPass.output;
						subagentSessionId = firstPass.sessionId;
						runStats = firstPass.stats;

						let parsedDelegation = parseDelegationRequests(
							output,
							effectiveDelegationDepth > 0 ? effectiveMaxDelegations : 0,
						);
						let impossibleMatch = output.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
						const shouldRetryDelegationEnforcement =
							minDelegationsPreferred > 0 &&
							parsedDelegation.requests.length < minDelegationsPreferred &&
							!impossibleMatch;
						if (shouldRetryDelegationEnforcement) {
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
							impossibleMatch = output.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
						}

						if (
							minDelegationsPreferred > 0 &&
							parsedDelegation.requests.length === 0 &&
							strictDelegationContract
						) {
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
								void publishDelegateFinding({
									delegateLabel: String(index + 1),
									delegateDescription: request.description,
									delegateProfile: formatDelegateTarget(request),
									status: "failed",
									content: message,
								});
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
									void publishDelegateFinding({
										delegateLabel: requestLabel,
										delegateDescription: nestedRequest.description,
										delegateProfile: nestedProfileLabel,
										status: "failed",
										content: message,
									});
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
									const nestedTools = resolveEffectiveToolset({
										tools: nestedCustomSubagent?.tools,
										disallowedTools: nestedCustomSubagent?.disallowedTools,
										fallbackTools: toolsByProfile[nestedProfile],
										knownToolNames: knownRuntimeToolNames,
									});
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
										let nestedReleaseIsolation: (() => Promise<void>) | undefined;
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
												onCleanupTelemetry,
											);
											nestedCwd = isolated.runCwd;
											nestedReleaseIsolation = isolated.cleanup;
										}

										const nestedPromptWithInstructions = nestedRequest.prompt;
										const nestedSharedMemoryGuidance = buildSharedMemoryGuidance(
											sharedMemoryRunId,
											sharedMemoryTaskId,
										);
										const nestedCoordinationGuidance = buildDelegateCoordinationGuidance({
											taskId: sharedMemoryTaskId,
											delegateLabel: requestLabel,
											delegateDescription: nestedRequest.description,
										});
										const nestedPrompt = `${nestedPromptWithInstructions}\n\n${nestedSharedMemoryGuidance}\n\n${nestedCoordinationGuidance}`;
										await publishStreamClaims({
											owner: requestLabel,
											description: nestedRequest.description,
											promptText: nestedRequest.prompt,
										});
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
											signal: runtimeAbortSignal,
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
										await publishDelegateFinding({
											delegateLabel: requestLabel,
											delegateDescription: nestedRequest.description,
											delegateProfile: nestedProfileLabel,
											status: "done",
											content: nestedSection,
										});
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
											if (nestedReleaseIsolation) {
												await nestedReleaseIsolation();
											}
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

							const childTools = resolveEffectiveToolset({
								tools: childCustomSubagent?.tools,
								disallowedTools: childCustomSubagent?.disallowedTools,
								fallbackTools: toolsByProfile[childProfile],
								knownToolNames: knownRuntimeToolNames,
							});
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
								let childReleaseIsolation: (() => Promise<void>) | undefined;
								const explicitChildLock = request.lockKey?.trim();
								let childCwd = requestedChildCwd;
								try {
									throwIfAborted();
									if (writeCapableProfiles.has(childProfile) && explicitChildLock) {
										childReleaseLock = await acquireLocalWriteLock(explicitChildLock);
										throwIfAborted();
									}
								if (request.isolation === "worktree") {
									const isolated = provisionWorktree(
										cwd,
										requestedChildCwd,
										`${runId}_delegate_${index + 1}`,
										onCleanupTelemetry,
									);
									childCwd = isolated.runCwd;
									childReleaseIsolation = isolated.cleanup;
								}

									const delegateMeta = formatMetaCheckpoint(options?.getMetaMessages?.());
									const childPromptWithInstructions = request.prompt;
									const delegateSharedMemoryGuidance = buildSharedMemoryGuidance(
										sharedMemoryRunId,
										sharedMemoryTaskId,
									);
									const delegateCoordinationGuidance = buildDelegateCoordinationGuidance({
										taskId: sharedMemoryTaskId,
										delegateLabel: String(index + 1),
										delegateDescription: request.description,
									});
									const delegatePromptBase = `${childPromptWithInstructions}\n\n${delegateSharedMemoryGuidance}\n\n${delegateCoordinationGuidance}`;
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
									await publishStreamClaims({
										owner: String(index + 1),
										description: request.description,
										promptText: request.prompt,
									});
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
													signal: runtimeAbortSignal,
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
												if (runtimeAbortSignal?.aborted || isAbortError(error)) {
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
									let childImpossibleMatch = childOutput.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
									const shouldRetryChildDelegationEnforcement =
										childMinDelegationsPreferred > 0 &&
										parsedChildDelegation.requests.length < childMinDelegationsPreferred &&
										!childImpossibleMatch;
									if (
										shouldRetryChildDelegationEnforcement
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
										childImpossibleMatch = childOutput.match(/^\s*DELEGATION_IMPOSSIBLE\s*:\s*(.+)$/im);
									}
									if (
										childMinDelegationsPreferred > 0 &&
										parsedChildDelegation.requests.length === 0 &&
										strictDelegationContract
									) {
										if (!childImpossibleMatch) {
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
											const impossibleReason = childImpossibleMatch?.[1]?.trim() ?? "not provided";
											if (
												strictDelegationContract &&
												parsedChildDelegation.requests.length === 0 &&
												!childImpossibleMatch
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
								await publishDelegateFinding({
									delegateLabel: String(index + 1),
									delegateDescription: request.description,
									delegateProfile: childProfileLabel,
									status: "done",
									content: `${childOutputExcerpt}${nestedSection}`,
								});
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
									if (runtimeAbortSignal?.aborted || isAbortError(error)) {
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
									if (childReleaseIsolation) {
										await childReleaseIsolation();
									}
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
							if (runtimeAbortSignal?.aborted || isAbortError(error)) {
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
						const delegatedBlocks = delegatedSections.filter(
							(section): section is string => typeof section === "string" && section.trim().length > 0,
						);
						let duplicateDelegatedOutputs = 0;
						if (delegatedTasks > 0) {
							const header = `### Delegated Subtasks (${delegatedSucceeded}/${delegatedTasks} done)`;
							if (delegatedBlocks.length > 1) {
								const duplicateReport = detectDuplicateDelegatedSections(delegatedBlocks);
								duplicateDelegatedOutputs = duplicateReport.duplicates;
								if (duplicateReport.duplicates > 0) {
									const duplicateHints = duplicateReport.duplicatePairs
										.slice(0, 5)
										.map((pair) => `${pair.duplicate}->${pair.original}`)
										.join(", ");
									delegationWarnings.push(
										`Delegation quality: detected ${duplicateReport.duplicates} near-duplicate delegated output(s) (${duplicateHints}). Consider stricter stream partitioning or stronger shared-memory coordination keys.`,
									);
								}
							}
							finalSections.push([header, ...delegatedBlocks].join("\n\n"));
						}

						let sharedMemorySummaryKey: string | undefined;
						if (orchestrationRunId && orchestrationTaskId) {
							const summaryExcerpt =
								normalizedOutput.length > 1200
									? `${normalizedOutput.slice(0, 1197).trimEnd()}...`
									: normalizedOutput;
							const summaryPayload = JSON.stringify({
								taskId: orchestrationTaskId,
								description,
								profile: effectiveProfile,
								delegated: {
									total: delegatedTasks,
									succeeded: delegatedSucceeded,
									failed: delegatedFailed,
									duplicatesDetected: duplicateDelegatedOutputs,
								},
								retrospective: {
									attempts: retrospectiveAttempts,
									recovered: retrospectiveRecovered,
									failureCauses: failureCauses,
								},
								summary: summaryExcerpt,
							});
							try {
								const summaryWrite = await writeSharedMemory(
									{
										rootCwd: cwd,
										runId: sharedMemoryRunId,
										taskId: sharedMemoryTaskId,
										profile: effectiveProfile,
									},
									{
										key: `results/${orchestrationTaskId}`,
										value: summaryPayload,
										scope: "run",
										mode: "set",
									},
									runtimeAbortSignal,
								);
								sharedMemorySummaryKey = summaryWrite.key;
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								delegationWarnings.push(`Shared memory summary write skipped: ${message}`);
							}
						}

						let coordinationSummary:
							| {
									sharedMemoryWrites: number;
									currentTaskWrites: number;
									currentTaskDelegateWrites: number;
									runScopeWrites: number;
									taskScopeWrites: number;
									duplicatesDetected: number;
									claimKeysMatched: number;
									claimCollisions: number;
							  }
							| undefined;
						let claimSummary:
							| {
									keysMatched: number;
									collisions: number;
									examples: string[];
							  }
							| undefined;
						let sharedFindingsSnapshot:
							| {
									keysMatched: number;
									examples: string[];
							  }
							| undefined;
						if (delegatedTasks > 0 || (orchestrationRunId && orchestrationTaskId)) {
							try {
								const usage = await summarizeSharedMemoryUsage(
									{
										rootCwd: cwd,
										runId: sharedMemoryRunId,
										taskId: sharedMemoryTaskId,
									},
									runtimeAbortSignal,
								);
								if (delegatedTasks > 1 && usage.currentTaskDelegateWrites === 0) {
									delegationWarnings.push(
										"No shared_memory writes detected from delegates in this task. Cross-stream coordination may be weak; use stable keys (findings/<stream>, risks/<stream>, plan/<stream>).",
									);
								}
								coordinationSummary = {
									sharedMemoryWrites: usage.totalWrites,
									currentTaskWrites: usage.currentTaskWrites,
									currentTaskDelegateWrites: usage.currentTaskDelegateWrites,
									runScopeWrites: usage.runScopeWrites,
									taskScopeWrites: usage.taskScopeWrites,
									duplicatesDetected: duplicateDelegatedOutputs,
									claimKeysMatched: 0,
									claimCollisions: 0,
								};
							} catch {
								// shared-memory summary is advisory; never fail task completion on analytics path.
							}
						}
						if (delegatedTasks > 0) {
							try {
								const claims = await readSharedMemory(
									{
										rootCwd: cwd,
										runId: sharedMemoryRunId,
										taskId: sharedMemoryTaskId,
									},
									{
										scope: "run",
										prefix: "claims/",
										includeValues: true,
										limit: Math.max(40, delegatedTasks * 8),
									},
									runtimeAbortSignal,
								);
								const collisions: Array<{ key: string; owners: string[] }> = [];
								for (const item of claims.items) {
									if (!item.value) continue;
									try {
										const parsed = JSON.parse(item.value) as { owners?: unknown };
										if (!Array.isArray(parsed.owners)) continue;
										const owners = Array.from(
											new Set(
												parsed.owners
													.filter(
														(value): value is string =>
															typeof value === "string" && value.trim().length > 0,
													)
													.map((value) => value.trim()),
											),
										);
										if (owners.length > 1) {
											collisions.push({ key: item.key, owners: owners.slice(0, 8) });
										}
									} catch {
										// ignore malformed claim entries and continue best-effort aggregation
									}
								}
								claimSummary = {
									keysMatched: claims.totalMatched,
									collisions: collisions.length,
									examples: collisions.slice(0, 6).map((item) => `${item.key}: ${item.owners.join(", ")}`),
								};
								if (coordinationSummary) {
									coordinationSummary.claimKeysMatched = claimSummary.keysMatched;
									coordinationSummary.claimCollisions = claimSummary.collisions;
								}
							} catch {
								// advisory only
							}
						}
						if (delegatedTasks > 0) {
							try {
								const findingsPrefix = `findings/${toSharedMemoryKeySegment(sharedMemoryTaskId, "task")}/`;
								const findings = await readSharedMemory(
									{
										rootCwd: cwd,
										runId: sharedMemoryRunId,
										taskId: sharedMemoryTaskId,
									},
									{
										scope: "run",
										prefix: findingsPrefix,
										includeValues: true,
										limit: Math.max(20, delegatedTasks * 4),
									},
									runtimeAbortSignal,
								);
								const examples = findings.items.slice(0, 6).map((item) => {
									let excerpt = "";
									if (item.value) {
										try {
											const parsed = JSON.parse(item.value) as { summary?: unknown };
											if (typeof parsed.summary === "string" && parsed.summary.trim().length > 0) {
												excerpt = parsed.summary.trim().replace(/\s+/g, " ").slice(0, 120);
											}
										} catch {
											excerpt = item.value.trim().replace(/\s+/g, " ").slice(0, 120);
										}
									}
									return excerpt.length > 0 ? `${item.key}: ${excerpt}` : item.key;
								});
								sharedFindingsSnapshot = {
									keysMatched: findings.totalMatched,
									examples,
								};
							} catch {
								// advisory only
							}
						}

						if (coordinationSummary && delegatedTasks > 0) {
							finalSections.push(
								[
									"### Orchestration Summary",
									`- delegated: ${delegatedSucceeded}/${delegatedTasks} succeeded (${delegatedFailed} failed)`,
									`- duplicate_delegated_outputs: ${coordinationSummary.duplicatesDetected}`,
									`- shared_memory_writes_total: ${coordinationSummary.sharedMemoryWrites}`,
									`- shared_memory_writes_current_task: ${coordinationSummary.currentTaskWrites}`,
									`- shared_memory_delegate_writes_current_task: ${coordinationSummary.currentTaskDelegateWrites}`,
									`- shared_memory_scope_distribution: run=${coordinationSummary.runScopeWrites}, task=${coordinationSummary.taskScopeWrites}`,
									`- claims_keys_matched: ${coordinationSummary.claimKeysMatched}`,
									`- claims_collisions: ${coordinationSummary.claimCollisions}`,
									sharedMemorySummaryKey ? `- shared_memory_summary_key: ${sharedMemorySummaryKey}` : undefined,
								]
									.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
									.join("\n"),
							);
						}
						if (claimSummary && delegatedTasks > 0) {
							finalSections.push(
								[
									"### Claim Overlap Snapshot",
									`- matched_keys: ${claimSummary.keysMatched}`,
									`- collisions: ${claimSummary.collisions}`,
									...claimSummary.examples.map((line) => `- ${line}`),
								].join("\n"),
							);
						}
						if (sharedFindingsSnapshot && delegatedTasks > 0) {
							finalSections.push(
								[
									"### Shared Findings Snapshot",
									`- matched_keys: ${sharedFindingsSnapshot.keysMatched}`,
									...sharedFindingsSnapshot.examples.map((line) => `- ${line}`),
								].join("\n"),
							);
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
							coordination: coordinationSummary,
							sharedMemorySummaryKey,
							cleanup:
								cleanupState.retries > 0 || cleanupState.failures > 0
									? {
											retries: cleanupState.retries,
											failures: cleanupState.failures,
											lastErrorCode: cleanupState.lastErrorCode,
											lastErrorMessage: cleanupState.lastErrorMessage,
										}
									: undefined,
						};
						updateTrackedTaskStatus("done");
						return { text, details };
					} finally {
						if (releaseIsolation) {
							await releaseIsolation();
						}
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
				const backgroundAbortController = new AbortController();
				runtimeAbortSignal = backgroundAbortController.signal;
				registerSubagentBackgroundRunController(cwd, runId, backgroundAbortController);
				const logPath = appendSubagentBackgroundRunLog(cwd, runId, `queued · profile=${effectiveProfile} · cwd=${requestedSubagentCwd}`);
				const queuedStatusPath = writeSubagentBackgroundRunStatus(cwd, {
					runId,
					status: "queued",
					createdAt: now,
					description,
					profile: effectiveProfile,
					cwd: requestedSubagentCwd,
					agent: customSubagent?.name,
					model: effectiveModelOverride,
					logPath,
				});
				void (async () => {
					writeSubagentBackgroundRunStatus(cwd, {
						runId,
						status: "running",
						createdAt: now,
						startedAt: new Date().toISOString(),
						description,
						profile: effectiveProfile,
						cwd: requestedSubagentCwd,
						agent: customSubagent?.name,
						model: effectiveModelOverride,
						logPath,
					});
					appendSubagentBackgroundRunLog(cwd, runId, "running");
					try {
						const result = await executeSubagent();
						writeSubagentBackgroundRunStatus(cwd, {
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
							logPath,
						});
						appendSubagentBackgroundRunLog(cwd, runId, `done · transcript=${result.details.transcriptPath ?? "-"}`);
					} catch (error) {
						const aborted = isAbortError(error);
						writeSubagentBackgroundRunStatus(cwd, {
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
							logPath,
						});
						appendSubagentBackgroundRunLog(
							cwd,
							runId,
							`${aborted ? "cancelled" : "error"} · ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						unregisterSubagentBackgroundRunController(cwd, runId);
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

/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Message, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorAction,
	EditorComponent,
	EditorTheme,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@mariozechner/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	truncateToWidth,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
	APP_NAME,
	CHANGELOG_URL,
	ENV_SESSION_TRACE,
	ENV_OFFLINE,
	ENV_SKIP_VERSION_CHECK,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getModelsPath,
	getSessionTracePath,
	getShareViewerUrl,
	getUpdateInstruction,
	isSessionTraceEnabled,
	PACKAGE_NAME,
	VERSION,
} from "../../config.js";
import { AuthStorage } from "../../core/auth-storage.js";
import {
	getAgentProfile,
	getMainProfileNames,
	getProfileNames,
	isValidProfileName,
	type AgentProfileName,
} from "../../core/agent-profiles.js";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { type AppAction, KeybindingsManager } from "../../core/keybindings.js";
import {
	createCompactionSummaryMessage,
	INTERNAL_UI_META_CUSTOM_TYPE,
	isInternalUiMetaDetails,
} from "../../core/messages.js";
import {
	MAX_ORCHESTRATION_AGENTS,
	MAX_ORCHESTRATION_PARALLEL,
	MAX_SUBAGENT_DELEGATE_PARALLEL,
} from "../../core/orchestration-limits.js";
import {
	loadModelsDevProviderCatalog,
	type ModelsDevProviderCatalogInfo,
} from "../../core/models-dev-provider-catalog.js";
import { ModelRegistry, type ProviderConfigInput } from "../../core/model-registry.js";
import { MODELS_DEV_PROVIDERS, type ModelsDevProviderInfo } from "../../core/models-dev-providers.js";
import { resolveModelScope } from "../../core/model-resolver.js";
import {
	getMcpCommandHelp,
	parseMcpAddCommand,
	parseMcpTargetCommand,
	type McpServerConfig,
	type McpRuntime,
	type McpScope,
} from "../../core/mcp/index.js";
import {
	addMemoryEntry,
	getMemoryFilePath,
	readMemoryEntries,
	removeMemoryEntry,
	updateMemoryEntry,
	type MemoryScope,
} from "../../core/memory.js";
import {
	ContractService,
	normalizeEngineeringContract,
	type ContractScope,
	type ContractState,
	type EngineeringContract,
} from "../../core/contract.js";
import {
	buildProjectIndex,
	collectChangedFilesSince,
	ensureProjectIndex,
	loadProjectIndex,
	queryProjectIndex,
	saveProjectIndex,
	type ProjectIndex,
	type RepoScaleMode,
} from "../../core/project-index/index.js";
import {
	SingularService,
	type SingularAnalysisResult,
	type SingularBlastRadius,
	type SingularComplexity,
	type SingularImpactAnalysis,
	type SingularOption,
	type SingularRecommendation,
	type SingularStageFit,
} from "../../core/singular.js";
import {
	getDefaultSemanticSearchConfig,
	getSemanticConfigPath,
	getSemanticIndexDir,
	isLikelyEmbeddingModelId,
	listOllamaLocalModels,
	listOpenRouterEmbeddingModels,
	loadMergedSemanticConfig,
	readScopedSemanticConfig,
	SemanticConfigMissingError,
	SemanticIndexRequiredError,
	SemanticRebuildRequiredError,
	SemanticSearchRuntime,
	upsertScopedSemanticSearchConfig,
	type SemanticIndexOperationResult,
	type SemanticProviderConfig,
	type SemanticProviderType,
	type SemanticQueryResult,
	type SemanticScope,
	type SemanticSearchConfig,
	type SemanticStatusResult,
} from "../../core/semantic/index.js";
import { DefaultResourceLoader } from "../../core/resource-loader.js";
import { createAgentSession } from "../../core/sdk.js";
import { createTeamRun, getTeamRun, listTeamRuns } from "../../core/agent-teams.js";
import {
	buildSwarmPlanFromSingular,
	buildSwarmPlanFromTask,
	runSwarmScheduler,
	SwarmStateStore,
	type SwarmDispatchResult,
	type SwarmPlan,
	type SwarmRunMeta,
	type SwarmRuntimeState,
	type SwarmTaskPlan,
	type SwarmTaskRuntimeState,
} from "../../core/swarm/index.js";
import {
	loadCustomSubagents,
	resolveCustomSubagentReference,
	type CustomSubagentEntry,
} from "../../core/subagents.js";
import { getSubagentRun, listSubagentRuns } from "../../core/subagent-runs.js";
import type { ResourceDiagnostic } from "../../core/resource-loader.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type { ToolPermissionRequest } from "../../core/tools/index.js";
import { isTaskPlanSnapshot, TASK_PLAN_CUSTOM_TYPE, type TaskPlanSnapshot } from "../../core/task-plan.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import {
	buildIosmAutomationPrompt,
	buildIosmAgentVerificationPrompt,
	buildIosmGuideAuthoringPrompt,
	buildIosmPriorityChecklist,
	createMetricSnapshot,
	extractAssistantText,
	evaluateIosmAutomationProgress,
	formatMetricSnapshot,
	hasReachedIosmTarget,
	getIosmGuidePath,
	initIosmWorkspace,
	inspectIosmCycle,
	listIosmCycles,
	loadIosmConfig,
	planIosmCycle,
	readIosmCycleReport,
	recordIosmCycleHistory,
	resolveIosmAutomationSettings,
	summarizeMetricDelta,
	normalizeIosmGuideMarkdown,
	writeIosmGuideDocument,
	type IosmInitResult,
	type IosmDecision,
	type IosmMetricSnapshot,
} from "../../iosm/index.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { ensureTool, getToolPath } from "../../utils/tools-manager.js";
import { ArminComponent } from "./components/armin.js";
import { AsciiLogoComponent } from "./components/ascii-logo.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { DecryptLoader } from "./components/decrypt-loader.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { appKey, appKeyHint, editorKey } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { McpSelectorComponent } from "./components/mcp-selector.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { type LoginProviderOption, OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import {
	SubagentMessageComponent,
	type SubagentDelegateItem,
	type SubagentInfo,
	type SubagentPhaseState,
} from "./components/subagent-message.js";
import { TaskPlanMessageComponent } from "./components/task-plan-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp" | "meta";
};

export function resolveStreamingSubmissionMode(input: {
	configuredMode: "steer" | "followUp" | "meta";
	activeProfileName: string;
	activeSubagentCount: number;
	activeAssistantOrchestrationContext: boolean;
}): "steer" | "followUp" | "meta" {
	if (
		input.configuredMode === "meta" &&
		input.activeProfileName === "meta" &&
		(input.activeSubagentCount > 0 || input.activeAssistantOrchestrationContext)
	) {
		return "followUp";
	}
	return input.configuredMode;
}

function parseRequestedParallelAgentCount(text: string): number | undefined {
	const patterns = [
		/(\d+)\s+(?:parallel|concurrent)\s+agents?/i,
		/(\d+)\s+agents?/i,
		/(\d+)\s+паралл\w*\s+агент\w*/i,
		/(\d+)\s+агент\w*/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const parsed = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
		if (Number.isInteger(parsed) && parsed >= 1) {
			return Math.max(1, Math.min(MAX_ORCHESTRATION_AGENTS, parsed));
		}
	}
	return undefined;
}

function deriveMetaRequiredTopLevelTaskCalls(
	userInput: string,
	taskPlanSnapshot: TaskPlanSnapshot | undefined,
): number | undefined {
	const requested = parseRequestedParallelAgentCount(userInput);
	if (requested) return requested;
	if (!taskPlanSnapshot) return undefined;
	return Math.max(2, Math.min(3, taskPlanSnapshot.totalSteps));
}

function extractTaskToolErrorText(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const candidate = result as Record<string, unknown>;
	if (typeof candidate.error === "string" && candidate.error.trim()) return candidate.error.trim();
	if (typeof candidate.output === "string" && candidate.output.trim()) return candidate.output.trim();
	return undefined;
}

function buildMetaParallelismCorrection(input: {
	requiredTopLevelTasks: number;
	launchedTopLevelTasks: number;
	taskPlanSnapshot?: TaskPlanSnapshot;
	taskToolError?: string;
}): string {
	const validationFailure =
		input.taskToolError && /Validation failed for tool "task"/i.test(input.taskToolError)
			? input.taskToolError.split("\n").slice(0, 3).join("\n")
			: undefined;
	return [
		"[META_PARALLELISM_CORRECTION]",
		`Meta runtime correction: this run currently has ${input.launchedTopLevelTasks} top-level task call(s), but it should have at least ${input.requiredTopLevelTasks}.`,
		"Stop manual sequential execution in the main agent and convert the execution graph into parallel task calls now.",
		"Emit the missing top-level task calls in the same assistant response when branches are independent.",
		"Each task tool call MUST include description and prompt.",
		'If you want a custom subagent, pass it via agent="name"; keep profile set to the capability profile, not the custom subagent name.',
		"If a child workstream is still broad, require nested <delegate_task> fan-out instead of letting one child do everything alone.",
		input.taskPlanSnapshot
			? `You already produced a complex plan with ${input.taskPlanSnapshot.totalSteps} steps. Turn that plan into parallel execution now.`
			: undefined,
		validationFailure ? `Previous task validation failure:\n${validationFailure}` : undefined,
		"If you truly cannot split safely, output exactly one line: DELEGATION_IMPOSSIBLE: <precise reason>.",
		"[/META_PARALLELISM_CORRECTION]",
	]
		.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
		.join("\n");
}

async function promptMetaWithParallelismGuard(input: {
	session: Pick<AgentSession, "prompt" | "subscribe" | "meta">;
	userInput: string;
}): Promise<void> {
	let taskToolCalls = 0;
	let nonTaskToolCalls = 0;
	let taskPlanSnapshot: TaskPlanSnapshot | undefined;
	let taskToolError: string | undefined;
	let correctionInjected = false;
	let correctionPromise: Promise<void> | undefined;

	const maybeInjectCorrection = () => {
		if (correctionInjected) return;
		const requiredTopLevelTasks = deriveMetaRequiredTopLevelTaskCalls(input.userInput, taskPlanSnapshot);
		if (!requiredTopLevelTasks || taskToolCalls >= requiredTopLevelTasks) {
			return;
		}
		const hasComplexPlan = !!taskPlanSnapshot;
		const hasTaskFailure = !!taskToolError;
		if (!hasTaskFailure && nonTaskToolCalls < 1) {
			return;
		}
		if (!hasComplexPlan && !hasTaskFailure && nonTaskToolCalls < 2) {
			return;
		}
		correctionInjected = true;
		correctionPromise = input.session
			.meta(
				buildMetaParallelismCorrection({
					requiredTopLevelTasks,
					launchedTopLevelTasks: taskToolCalls,
					taskPlanSnapshot,
					taskToolError,
				}),
			)
			.catch(() => {});
	};

	const unsubscribe = input.session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "custom") {
			if (event.message.customType === TASK_PLAN_CUSTOM_TYPE && isTaskPlanSnapshot(event.message.details)) {
				taskPlanSnapshot = event.message.details;
				maybeInjectCorrection();
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			if (event.toolName === "task") {
				taskToolCalls += 1;
			} else {
				nonTaskToolCalls += 1;
			}
			maybeInjectCorrection();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolName === "task" && event.isError) {
			taskToolError = extractTaskToolErrorText(event.result) ?? taskToolError;
			maybeInjectCorrection();
		}
	});

	try {
		await input.session.prompt(input.userInput);
		if (correctionPromise) {
			await correctionPromise;
		}
	} finally {
		unsubscribe();
	}
}

type IosmInitVerificationSummary = {
	completed: boolean;
	cancelled?: boolean;
	skippedReason?: string;
	error?: string;
	current?: IosmMetricSnapshot;
	historyPath?: string;
	tracePath?: string;
	guidePath?: string;
	toolCalls?: number;
	activityLog?: string[];
};

type IosmAutomationLoopStatus = "stabilized" | "threshold_reached" | "max_iterations" | "cancelled" | "failed";

const IOSM_PROFILE_ONLY_COMMANDS = new Set(["iosm", "cycle-list", "cycle-plan", "cycle-status", "cycle-report"]);
const CHECKPOINT_LABEL_PREFIX = "checkpoint:";
const INTERRUPT_ABORT_TIMEOUT_MS = 8_000;

type IosmAutomationRunState = {
	cancelRequested: boolean;
	targetIndex?: number;
	maxIterations?: number;
	iterationsCompleted: number;
};

type IosmAutomationRefreshResult = {
	initResult: IosmInitResult;
	verification?: IosmInitVerificationSummary;
	snapshot: IosmMetricSnapshot;
	guidePath: string;
	cycleDecision?: IosmDecision;
};

type SessionCheckpoint = {
	name: string;
	targetId: string;
	labelEntryId: string;
	timestamp: string;
};

type DoctorCheckLevel = "ok" | "warn" | "fail";

type DoctorCheckItem = {
	level: DoctorCheckLevel;
	label: string;
	detail: string;
	fix?: string;
};

type ContractScopeParseResult = {
	scope: ContractScope | undefined;
	rest: string[];
	error?: string;
};

type ContractFieldKind = "text" | "list";
type ContractFieldKey = keyof EngineeringContract;

type ContractFieldDefinition = {
	key: ContractFieldKey;
	kind: ContractFieldKind;
	placeholder: string;
	help: string;
};

const CONTRACT_FIELD_DEFINITIONS: ContractFieldDefinition[] = [
	{ key: "goal", kind: "text", placeholder: "Ship X with measurable impact", help: "Single primary objective." },
	{
		key: "scope_include",
		kind: "list",
		placeholder: "auth/*",
		help: "What is explicitly in scope.",
	},
	{
		key: "scope_exclude",
		kind: "list",
		placeholder: "billing/*",
		help: "What must remain untouched for this change.",
	},
	{
		key: "constraints",
		kind: "list",
		placeholder: "no breaking API changes",
		help: "Hard constraints that cannot be violated.",
	},
	{
		key: "quality_gates",
		kind: "list",
		placeholder: "tests pass",
		help: "Objective quality checks before merge.",
	},
	{
		key: "definition_of_done",
		kind: "list",
		placeholder: "docs updated",
		help: "Completion criteria.",
	},
	{
		key: "assumptions",
		kind: "list",
		placeholder: "API v2 stays backward compatible",
		help: "Assumptions the plan depends on.",
	},
	{
		key: "non_goals",
		kind: "list",
		placeholder: "no redesign in this cycle",
		help: "Intentional exclusions.",
	},
	{
		key: "risks",
		kind: "list",
		placeholder: "migration may affect legacy clients",
		help: "Known delivery risks.",
	},
	{
		key: "deliverables",
		kind: "list",
		placeholder: "CLI command + tests + docs",
		help: "Expected artifacts.",
	},
	{
		key: "success_metrics",
		kind: "list",
		placeholder: "p95 latency < 250ms",
		help: "Measurable target outcomes.",
	},
	{
		key: "stakeholders",
		kind: "list",
		placeholder: "backend team, QA",
		help: "Who should review/accept the result.",
	},
	{
		key: "owner",
		kind: "text",
		placeholder: "team/platform",
		help: "Owner accountable for delivery.",
	},
	{
		key: "timebox",
		kind: "text",
		placeholder: "this sprint",
		help: "Deadline or delivery window.",
	},
	{
		key: "notes",
		kind: "text",
		placeholder: "additional context",
		help: "Free-form context for this contract.",
	},
];

type DoctorCliToolStatus = {
	tool: string;
	available: boolean;
	source: "managed" | "system" | "missing";
	command?: string;
	hint?: string;
};

type DoctorCliToolSpec = {
	tool: string;
	candidates: string[];
	managed?: "fd" | "rg";
	hint: string;
};

const DOCTOR_CLI_TOOL_SPECS: DoctorCliToolSpec[] = [
	{
		tool: "rg",
		candidates: ["rg"],
		managed: "rg",
		hint: "Install ripgrep (rg) or allow iosm-cli to download managed binaries.",
	},
	{
		tool: "fd",
		candidates: ["fd"],
		managed: "fd",
		hint: "Install fd or allow iosm-cli to download managed binaries.",
	},
	{
		tool: "ast_grep",
		candidates: ["ast-grep", "sg"],
		hint: "Install ast-grep (brew install ast-grep or npm i -g @ast-grep/cli).",
	},
	{
		tool: "comby",
		candidates: ["comby"],
		hint: "Install comby (brew install comby).",
	},
	{
		tool: "jq",
		candidates: ["jq"],
		hint: "Install jq (brew install jq).",
	},
	{
		tool: "yq",
		candidates: ["yq"],
		hint: "Install yq (brew install yq).",
	},
	{
		tool: "semgrep",
		candidates: ["semgrep"],
		hint: "Install semgrep (pipx install semgrep or pip install semgrep).",
	},
	{
		tool: "sed",
		candidates: ["sed"],
		hint: "Install sed or GNU sed if unavailable (brew install gnu-sed).",
	},
];

function commandCandidateExists(candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		try {
			const locator = os.platform() === "win32" ? "where" : "which";
			const located = spawnSync(locator, [candidate], { stdio: "pipe" });
			if ((located.status ?? 1) === 0 && !located.error) {
				return candidate;
			}
		} catch {
			// Continue trying fallback check
		}

		try {
			const result = spawnSync(candidate, ["--version"], { stdio: "pipe" });
			const err = result.error as NodeJS.ErrnoException | undefined;
			if (!err || err.code !== "ENOENT") {
				return candidate;
			}
		} catch {
			// Continue trying other candidates
		}
	}
	return undefined;
}

function resolveDoctorCliToolStatuses(): DoctorCliToolStatus[] {
	return DOCTOR_CLI_TOOL_SPECS.map((spec) => {
		if (spec.managed) {
			const toolPath = getToolPath(spec.managed);
			if (toolPath) {
				const isManagedPath = path.isAbsolute(toolPath);
				return {
					tool: spec.tool,
					available: true,
					source: isManagedPath ? "managed" : "system",
					command: toolPath,
					hint: spec.hint,
				};
			}
			return {
				tool: spec.tool,
				available: false,
				source: "missing",
				hint: spec.hint,
			};
		}

		const resolvedCommand = commandCandidateExists(spec.candidates);
		if (resolvedCommand) {
			return {
				tool: spec.tool,
				available: true,
				source: "system",
				command: resolvedCommand,
				hint: spec.hint,
			};
		}

		return {
			tool: spec.tool,
			available: false,
			source: "missing",
			hint: spec.hint,
		};
	});
}

const OPENROUTER_PROVIDER_ID = "openrouter";
const PROVIDER_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
	"azure-openai-responses": "Azure OpenAI Responses",
	"google-antigravity": "Google Antigravity",
	"google-gemini-cli": "Google Gemini CLI",
	"kimi-coding": "Kimi Coding",
	"openai-codex": "OpenAI Codex",
	"opencode-go": "OpenCode Go",
	"vercel-ai-gateway": "Vercel AI Gateway",
};

function toProviderDisplayName(providerId: string): string {
	const override = PROVIDER_DISPLAY_NAME_OVERRIDES[providerId];
	if (override) return override;
	return providerId
		.split(/[-_]/g)
		.map((part) => {
			const lower = part.toLowerCase();
			if (lower === "ai") return "AI";
			if (lower === "api") return "API";
			if (lower === "gpt") return "GPT";
			if (lower === "aws") return "AWS";
			if (lower === "ui") return "UI";
			if (lower === "llm") return "LLM";
			if (lower === "id") return "ID";
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
}

type OrchestrationMode = "parallel" | "sequential";

type ParsedOrchestrateCommand = {
	mode: OrchestrationMode;
	agents: number;
	maxParallel?: number;
	profile?: AgentProfileName;
	profiles?: AgentProfileName[];
	cwds?: string[];
	locks?: string[];
	isolation?: "none" | "worktree";
	dependencies?: Array<{ agent: number; dependsOn: number[] }>;
	task: string;
};

type ParsedSwarmCommand =
	| {
			subcommand: "run";
			task: string;
			maxParallel?: number;
			budgetUsd?: number;
	  }
	| {
			subcommand: "from-singular";
			runId: string;
			option: number;
			maxParallel?: number;
			budgetUsd?: number;
	  }
	| {
			subcommand: "watch";
			runId?: string;
	  }
	| {
			subcommand: "resume";
			runId: string;
	  }
	| {
			subcommand: "retry";
			runId: string;
			taskId: string;
			resetBrief: boolean;
	  }
		| {
				subcommand: "help";
		  };

function isAbortLikeMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized.includes("aborted") || normalized.includes("cancelled");
}

const SUBAGENT_PHASE_STATES = new Set<SubagentPhaseState>(["queued", "starting", "running", "responding"]);
const SUBAGENT_DELEGATE_STATUSES = new Set<SubagentDelegateItem["status"]>(["pending", "running", "done", "failed"]);

function isSubagentPhaseState(value: unknown): value is SubagentPhaseState {
	return typeof value === "string" && SUBAGENT_PHASE_STATES.has(value as SubagentPhaseState);
}

function isSubagentDelegateStatus(value: unknown): value is SubagentDelegateItem["status"] {
	return typeof value === "string" && SUBAGENT_DELEGATE_STATUSES.has(value as SubagentDelegateItem["status"]);
}

function parseSubagentDelegateItems(value: unknown): SubagentDelegateItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: SubagentDelegateItem[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Record<string, unknown>;
		const indexRaw = candidate.index;
		const index =
			typeof indexRaw === "number" && Number.isFinite(indexRaw) && indexRaw > 0 ? Math.floor(indexRaw) : undefined;
		const description =
			typeof candidate.description === "string" && candidate.description.trim().length > 0
				? candidate.description.trim()
				: undefined;
		const profile =
			typeof candidate.profile === "string" && candidate.profile.trim().length > 0
				? candidate.profile.trim()
				: undefined;
		const status = isSubagentDelegateStatus(candidate.status) ? candidate.status : undefined;
		if (!index || !description || !profile || !status) continue;
		parsed.push({ index, description, profile, status });
		if (parsed.length >= 20) break;
	}
	return parsed;
}

function hasDependencyCycle(
	agents: number,
	dependencies: Array<{ agent: number; dependsOn: number[] }>,
): boolean {
	const graph = new Map<number, number[]>();
	for (let agent = 1; agent <= agents; agent++) {
		graph.set(agent, []);
	}
	for (const dep of dependencies) {
		graph.set(dep.agent, [...dep.dependsOn]);
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();

	const dfs = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;

		visiting.add(node);
		for (const next of graph.get(node) ?? []) {
			if (dfs(next)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (let agent = 1; agent <= agents; agent++) {
		if (dfs(agent)) return true;
	}
	return false;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Whether the session was started in plan mode (shows [PLAN] badge in footer) */
	planMode?: boolean;
	/** Active agent profile name (shows profile badge in footer when not "full") */
	profile?: string;
	/** MCP runtime for /mcp command and dynamic MCP tool updates */
	mcpRuntime?: McpRuntime;
}

type RunningSubagentState = {
	component: SubagentMessageComponent;
	startTime: number;
	profile: string;
	description: string;
	cwd?: string;
	agent?: string;
	lockKey?: string;
	isolation?: "none" | "worktree";
	phase?: string;
	phaseState?: SubagentPhaseState;
	activeTool?: string;
	toolCallsStarted: number;
	toolCallsCompleted: number;
	assistantMessages: number;
	delegatedTasks?: number;
	delegatedSucceeded?: number;
	delegatedFailed?: number;
	delegateIndex?: number;
	delegateTotal?: number;
	delegateDescription?: string;
	delegateProfile?: string;
	delegateItems?: SubagentDelegateItem[];
};

export class InteractiveMode {
	private session: AgentSession;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: DecryptLoader | undefined = undefined;
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private activeProfileName: AgentProfileName = "full";
	private profilePromptSuffix: string | undefined = undefined;
	private permissionMode: "ask" | "auto" | "yolo" = "ask";
	private permissionAllowRules: string[] = [];
	private permissionDenyRules: string[] = [];
	private permissionPromptLock: Promise<void> = Promise.resolve();
	private sessionAllowedToolSignatures = new Set<string>();
	private contractService: ContractService;
	private singularService: SingularService;
	private singularLastEffectiveContract: EngineeringContract = {};
	private swarmActiveRunId: string | undefined = undefined;

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Subagent execution tracking with live progress/metadata for task tool calls.
	private subagentComponents = new Map<string, RunningSubagentState>();
	private subagentElapsedTimer: ReturnType<typeof setInterval> | undefined = undefined;

	// Internal UI metadata emitted by runtime for orchestration rendering.
	private pendingInternalUserDisplayAliases: Array<{ rawPrompt: string; displayText: string }> = [];
	private pendingAssistantOrchestrationContexts = 0;
	private activeAssistantOrchestrationContext = false;

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();
	private mcpRuntime?: McpRuntime;

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// IOSM automation state
	private iosmAutomationRun: IosmAutomationRunState | undefined = undefined;
	private iosmVerificationSession: AgentSession | undefined = undefined;
	private singularAnalysisSession: AgentSession | undefined = undefined;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Text | undefined = undefined;

	// ASCII logo component for startup screen
	private asciiLogo: AsciiLogoComponent | undefined = undefined;

	// API-key provider labels cached for /login and status messages.
	private apiKeyProviderDisplayNames = new Map<string, string>();
	private modelsDevProviderCatalog: readonly ModelsDevProviderInfo[] = MODELS_DEV_PROVIDERS;
	private modelsDevProviderCatalogById: ReadonlyMap<string, ModelsDevProviderCatalogInfo> = new Map(
		MODELS_DEV_PROVIDERS.map((provider) => [
			provider.id,
			{
				...provider,
				models: [],
			} satisfies ModelsDevProviderCatalogInfo,
		]),
	);
	private modelsDevProviderCatalogRefreshPromise: Promise<void> | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Convenience accessors
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(
		session: AgentSession,
		private options: InteractiveModeOptions = {},
	) {
		this.session = session;
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider();
		this.footer = new FooterComponent(session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		const profile = getAgentProfile(options.profile);
		this.activeProfileName = profile.name;
		this.profilePromptSuffix = profile.systemPromptAppend || undefined;
		this.mcpRuntime = options.mcpRuntime;
		this.contractService = new ContractService({ cwd: this.sessionManager.getCwd() });
		this.singularService = new SingularService({ cwd: this.sessionManager.getCwd() });

		// Apply plan mode and profile badges immediately if set
		if (options.planMode || this.activeProfileName === "plan") {
			this.footer.setPlanMode(true);
		}
		this.footer.setActiveProfile(this.activeProfileName);
		this.session.setIosmAutopilotEnabled(this.activeProfileName === "iosm");
		this.syncRuntimePromptSuffix();
		this.permissionMode = this.settingsManager.getPermissionMode();
		this.permissionAllowRules = this.settingsManager.getPermissionAllowRules();
		this.permissionDenyRules = this.settingsManager.getPermissionDenyRules();
		this.session.setToolPermissionHandler((request) => this.requestToolPermission(request));
		this.mcpRuntime?.setPermissionGuard((request) => this.requestToolPermission(request));

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private syncRuntimePromptSuffix(): void {
		let contractSuffix: string | undefined;
		try {
			contractSuffix = this.contractService.buildPromptContext();
		} catch {
			contractSuffix = undefined;
		}
		const suffix = [this.profilePromptSuffix, contractSuffix]
			.map((entry) => entry?.trim())
			.filter((entry): entry is string => !!entry && entry.length > 0)
			.join("\n\n");
		this.session.setSystemPromptSuffix(suffix || undefined);
	}

	private getContractStateSafe(): ContractState | undefined {
		try {
			return this.contractService.getState();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showWarning(`Contract load failed: ${message}`);
			return undefined;
		}
	}

	private getProfileToolNames(profileName: AgentProfileName): string[] {
		const profile = getAgentProfile(profileName);
		const availableTools = new Set(this.session.getAllTools().map((tool) => tool.name));
		const nextActiveTools = [...profile.tools];
		if (availableTools.has("task")) nextActiveTools.push("task");
		if (availableTools.has("todo_write")) nextActiveTools.push("todo_write");
		if (availableTools.has("todo_read")) nextActiveTools.push("todo_read");
		if (availableTools.has("ask_user")) nextActiveTools.push("ask_user");
		return [...new Set(nextActiveTools)];
	}

	private getToolPermissionSignature(request: ToolPermissionRequest): string {
		const summary = request.summary.trim().replace(/\s+/g, " ");
		return `${request.toolName}:${summary}`;
	}

	private matchesPermissionRule(rule: string, request: ToolPermissionRequest): boolean {
		const [ruleToolRaw, ...rest] = rule.split(":");
		const ruleTool = (ruleToolRaw ?? "").trim();
		const ruleNeedle = rest.join(":").trim().toLowerCase();
		const toolMatches = !ruleTool || ruleTool === "*" || ruleTool === request.toolName;
		if (!toolMatches) return false;
		return !ruleNeedle || request.summary.toLowerCase().includes(ruleNeedle);
	}

	private async withPermissionDialogLock<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.permissionPromptLock;
		let release: (() => void) | undefined;
		this.permissionPromptLock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release?.();
		}
	}

	private async requestToolPermission(request: ToolPermissionRequest): Promise<boolean> {
		for (const rule of this.permissionDenyRules) {
			if (this.matchesPermissionRule(rule, request)) {
				this.showWarning(`Denied by rule: ${rule}`);
				return false;
			}
		}

		for (const rule of this.permissionAllowRules) {
			if (this.matchesPermissionRule(rule, request)) {
				return true;
			}
		}

		if (this.permissionMode === "yolo") {
			return true;
		}
		if (this.permissionMode === "auto") {
			// Auto mode mirrors "accept edits": allow edit/write without prompts,
			// still ask for shell execution.
			if (request.toolName === "edit" || request.toolName === "write") {
				return true;
			}
		}

		const signature = this.getToolPermissionSignature(request);
		if (this.sessionAllowedToolSignatures.has(signature)) {
			return true;
		}

		return this.withPermissionDialogLock(async () => {
			if (this.permissionMode === "yolo") return true;
			if (this.sessionAllowedToolSignatures.has(signature)) return true;

			const label = `${request.toolName}: ${request.summary}`;
			const choice = await this.showExtensionSelector("Permission required", [
				"Allow once",
				"Deny",
				"Always allow this command (session)",
			]);
			if (!choice || choice === "Deny") {
				this.showWarning(`Permission denied: ${label}`);
				return false;
			}
			if (choice === "Always allow this command (session)") {
				this.sessionAllowedToolSignatures.add(signature);
			}
			return true;
		});
	}

	private getHookPolicySummary():
		| {
			sources: string[];
			userPromptSubmit: number;
			preToolUse: number;
			postToolUse: number;
			stop: number;
		}
		| undefined {
		const hooks = this.session.resourceLoader.getHooks?.();
		if (!hooks) return undefined;
		return {
			sources: hooks.sources,
			userPromptSubmit: hooks.userPromptSubmit.length,
			preToolUse: hooks.preToolUse.length,
			postToolUse: hooks.postToolUse.length,
			stop: hooks.stop.length,
		};
	}

	private handleYoloCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const value = args[0]?.toLowerCase();
		if (!value) {
			this.permissionMode = this.permissionMode === "yolo" ? "ask" : "yolo";
			this.settingsManager.setPermissionMode(this.permissionMode);
			this.showStatus(`YOLO mode: ${this.permissionMode === "yolo" ? "ON" : "OFF"}`);
			return;
		}
		if (value === "status") {
			this.showStatus(`YOLO mode: ${this.permissionMode === "yolo" ? "ON" : "OFF"}`);
			return;
		}
		if (value === "on") {
			this.permissionMode = "yolo";
			this.settingsManager.setPermissionMode("yolo");
			this.showStatus("YOLO mode: ON (tool confirmations disabled)");
			return;
		}
		if (value === "off") {
			this.permissionMode = "ask";
			this.settingsManager.setPermissionMode("ask");
			this.showStatus("YOLO mode: OFF (tool confirmations enabled)");
			return;
		}
		this.showWarning("Usage: /yolo [on|off|status]");
	}

	private getPermissionsStatusText(): string {
		const hookSummary = this.getHookPolicySummary();
		const hookSegment = hookSummary
			? ` · hooks: U${hookSummary.userPromptSubmit}/P${hookSummary.preToolUse}/T${hookSummary.postToolUse}/S${hookSummary.stop}`
			: "";
		return `Permissions: ${this.permissionMode}${this.permissionAllowRules.length > 0 ? ` · allow rules: ${this.permissionAllowRules.length}` : ""}${this.permissionDenyRules.length > 0 ? ` · deny rules: ${this.permissionDenyRules.length}` : ""}${hookSegment}`;
	}

	private async runPermissionRulesMenu(kind: "allow" | "deny"): Promise<void> {
		while (true) {
			const isAllow = kind === "allow";
			const rules = isAllow ? this.permissionAllowRules : this.permissionDenyRules;
			const selected = await this.showExtensionSelector(`/permissions ${kind} (${rules.length} rule${rules.length === 1 ? "" : "s"})`, [
				"Add rule",
				"Remove rule",
				"Show rules",
				"Back",
			]);
			if (!selected || selected === "Back") {
				return;
			}

			if (selected === "Show rules") {
				if (rules.length === 0) {
					this.showStatus(`Permissions ${kind} rules: (empty)`);
					continue;
				}
				this.showCommandTextBlock(
					`Permissions ${isAllow ? "Allow" : "Deny"} Rules`,
					rules.map((rule) => `- ${rule}`).join("\n"),
				);
				continue;
			}

			if (selected === "Add rule") {
				const input = await this.showExtensionInput(
					`/permissions ${kind} add`,
					"tool:match (example: bash:git *, edit:*.env)",
				);
				if (input === undefined) continue;
				const rawRule = input.trim();
				if (!rawRule || !rawRule.includes(":")) {
					this.showWarning(`Invalid rule "${rawRule || "(empty)"}". Expected <tool:match>.`);
					continue;
				}
				if (isAllow) {
					if (!this.permissionAllowRules.includes(rawRule)) {
						this.permissionAllowRules.push(rawRule);
						this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
					}
				} else {
					if (!this.permissionDenyRules.includes(rawRule)) {
						this.permissionDenyRules.push(rawRule);
						this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
					}
				}
				this.showStatus(`Added ${kind} rule: ${rawRule}`);
				continue;
			}

			if (selected === "Remove rule") {
				if (rules.length === 0) {
					this.showStatus(`No ${kind} rules to remove.`);
					continue;
				}
				const pickedRule = await this.showExtensionSelector(
					`/permissions ${kind}: remove rule`,
					rules.map((rule) => rule),
				);
				if (!pickedRule) continue;

				if (isAllow) {
					this.permissionAllowRules = this.permissionAllowRules.filter((rule) => rule !== pickedRule);
					this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
				} else {
					this.permissionDenyRules = this.permissionDenyRules.filter((rule) => rule !== pickedRule);
					this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
				}
				this.showStatus(`Removed ${kind} rule: ${pickedRule}`);
			}
		}
	}

	private async runPermissionsInteractiveMenu(): Promise<void> {
		while (true) {
			const selected = await this.showExtensionSelector("/permissions", [
				`Mode (${this.permissionMode})`,
				`Allow Rules (${this.permissionAllowRules.length})`,
				`Deny Rules (${this.permissionDenyRules.length})`,
				"Hooks Summary",
				"Show Status",
				"Close",
			]);
			if (!selected || selected === "Close") {
				return;
			}

			if (selected.startsWith("Mode")) {
				const modeChoice = await this.showExtensionSelector("/permissions: mode", [
					"ask (Recommended)",
					"auto",
					"yolo",
				]);
				if (!modeChoice) continue;
				const nextMode = modeChoice.startsWith("ask")
					? "ask"
					: modeChoice.startsWith("auto")
						? "auto"
						: "yolo";
				this.permissionMode = nextMode;
				this.settingsManager.setPermissionMode(nextMode);
				this.showStatus(`Permissions: ${nextMode}`);
				continue;
			}

			if (selected.startsWith("Allow Rules")) {
				await this.runPermissionRulesMenu("allow");
				continue;
			}

			if (selected.startsWith("Deny Rules")) {
				await this.runPermissionRulesMenu("deny");
				continue;
			}

			if (selected === "Hooks Summary") {
				const summary = this.getHookPolicySummary();
				if (!summary) {
					this.showWarning("Hooks policy is unavailable in current session.");
					continue;
				}
				const sourceLines =
					summary.sources.length > 0 ? summary.sources.map((source) => `- ${source}`) : ["- (none loaded)"];
				const lines = [
					`UserPromptSubmit: ${summary.userPromptSubmit}`,
					`PreToolUse: ${summary.preToolUse}`,
					`PostToolUse: ${summary.postToolUse}`,
					`Stop: ${summary.stop}`,
					"",
					"Sources:",
					...sourceLines,
				];
				this.showCommandTextBlock("Hook Policies", lines.join("\n"));
				continue;
			}

			if (selected === "Show Status") {
				this.showStatus(this.getPermissionsStatusText());
			}
		}
	}

	private async handlePermissionsCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const value = args[0]?.toLowerCase();
		if (!value) {
			await this.runPermissionsInteractiveMenu();
			return;
		}
		if (value === "hooks") {
			const mode = args[1]?.toLowerCase();
			const summary = this.getHookPolicySummary();
			if (!summary) {
				this.showWarning("Hooks policy is unavailable in current session.");
				return;
			}
			if (mode === "json") {
				this.showCommandJsonBlock("Hook Policies", summary);
				return;
			}
			const sourceLines =
				summary.sources.length > 0 ? summary.sources.map((source) => `- ${source}`) : ["- (none loaded)"];
			const lines = [
				`UserPromptSubmit: ${summary.userPromptSubmit}`,
				`PreToolUse: ${summary.preToolUse}`,
				`PostToolUse: ${summary.postToolUse}`,
				`Stop: ${summary.stop}`,
				"",
				"Sources:",
				...sourceLines,
			];
			this.showCommandTextBlock("Hook Policies", lines.join("\n"));
			return;
		}
		if (value === "allow") {
			const action = args[1]?.toLowerCase();
			if (action === "list") {
				if (this.permissionAllowRules.length === 0) {
					this.showStatus("Permissions allow rules: (empty)");
					return;
				}
				this.showCommandTextBlock("Permissions Allow Rules", this.permissionAllowRules.map((r) => `- ${r}`).join("\n"));
				return;
			}
			if (action === "add") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule || !rawRule.includes(":")) {
					this.showWarning("Usage: /permissions allow add <tool:match>");
					return;
				}
				if (!this.permissionAllowRules.includes(rawRule)) {
					this.permissionAllowRules.push(rawRule);
					this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
				}
				this.showStatus(`Added allow rule: ${rawRule}`);
				return;
			}
			if (action === "remove") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule) {
					this.showWarning("Usage: /permissions allow remove <tool:match>");
					return;
				}
				this.permissionAllowRules = this.permissionAllowRules.filter((r) => r !== rawRule);
				this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
				this.showStatus(`Removed allow rule: ${rawRule}`);
				return;
			}
			this.showWarning("Usage: /permissions allow [list|add|remove]");
			return;
		}
		if (value === "deny") {
			const action = args[1]?.toLowerCase();
			if (action === "list") {
				if (this.permissionDenyRules.length === 0) {
					this.showStatus("Permissions deny rules: (empty)");
					return;
				}
				this.showCommandTextBlock("Permissions Deny Rules", this.permissionDenyRules.map((r) => `- ${r}`).join("\n"));
				return;
			}
			if (action === "add") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule || !rawRule.includes(":")) {
					this.showWarning("Usage: /permissions deny add <tool:match>");
					return;
				}
				if (!this.permissionDenyRules.includes(rawRule)) {
					this.permissionDenyRules.push(rawRule);
					this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
				}
				this.showStatus(`Added deny rule: ${rawRule}`);
				return;
			}
			if (action === "remove") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule) {
					this.showWarning("Usage: /permissions deny remove <tool:match>");
					return;
				}
				this.permissionDenyRules = this.permissionDenyRules.filter((r) => r !== rawRule);
				this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
				this.showStatus(`Removed deny rule: ${rawRule}`);
				return;
			}
			this.showWarning("Usage: /permissions deny [list|add|remove]");
			return;
		}
		if (value === "status") {
			this.showStatus(this.getPermissionsStatusText());
			return;
		}
		if (value === "ask" || value === "auto" || value === "yolo") {
			this.permissionMode = value;
			this.settingsManager.setPermissionMode(value);
			this.showStatus(`Permissions: ${value}`);
			return;
		}
		this.showWarning("Usage: /permissions [ask|auto|yolo|status|allow|deny|hooks]");
	}

	private getMcpArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const mcpSubcommands = ["list", "status", "add", "get", "tools", "test", "enable", "disable", "remove", "help"];
		const servers = this.mcpRuntime?.getServers() ?? [];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			const candidates = mcpSubcommands.filter((subcommand) => subcommand.includes(query));
			return candidates.map((subcommand) => ({ value: subcommand, label: subcommand }));
		}

		if (["get", "remove", "enable", "disable", "test", "tools"].includes(first)) {
			const query = hasTrailingSpace ? "" : (tokens[1] ?? "");
			const filtered = query
				? fuzzyFilter(servers, query, (server) => `${server.name} ${server.scope}`)
				: servers;
			return filtered.map((server) => ({
				value: server.name,
				label: server.name,
				description: `${server.scope}/${server.transport} · ${server.state}`,
			}));
		}

		if (first === "add" && tokens.length === 2 && !hasTrailingSpace) {
			return [{ value: tokens[1], label: tokens[1], description: "server name" }];
		}

		return null;
	}

	private getMemoryArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const subcommands = ["list", "add", "edit", "rm", "remove", "path", "ui", "help"];
		const scopeFlags = ["--scope", "--project", "--user"];
		const scopeValues = ["project", "user"];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		const scopeFlagIndex = tokens.findIndex((token) => token === "--scope");
		if (scopeFlagIndex >= 0) {
			const needsScopeValue = scopeFlagIndex + 1 >= tokens.length;
			if (needsScopeValue) {
				return scopeValues.map((value) => ({ value, label: value }));
			}
			const currentScopeValue = tokens[scopeFlagIndex + 1] ?? "";
			if (currentScopeValue.length > 0 && !scopeValues.includes(currentScopeValue)) {
				return scopeValues
					.filter((value) => value.startsWith(currentScopeValue))
					.map((value) => ({ value, label: value }));
			}
		}

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			const candidates = [...subcommands, ...scopeFlags].filter((item) => item.includes(query));
			return candidates.map((item) => ({ value: item, label: item }));
		}

		const query = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
		if (query.startsWith("--")) {
			return scopeFlags
				.filter((flag) => flag.includes(query))
				.map((flag) => ({ value: flag, label: flag }));
		}

		return null;
	}

	private getSemanticArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const subcommands = ["ui", "setup", "status", "index", "rebuild", "query", "help"];
		const queryFlags = ["--top-k"];
		const topKValues = ["5", "8", "10", "20"];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			const candidates = subcommands.filter((item) => item.includes(query));
			return candidates.map((item) => ({ value: item, label: item }));
		}

		if (first !== "query") {
			return null;
		}

		const topKIndex = tokens.findIndex((token) => token === "--top-k");
		if (topKIndex >= 0) {
			const currentValue = tokens[topKIndex + 1];
			if (!currentValue) {
				return topKValues.map((value) => ({ value, label: value }));
			}
			return topKValues
				.filter((value) => value.startsWith(currentValue))
				.map((value) => ({ value, label: value }));
		}

		const query = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
		if (query.startsWith("--")) {
			return queryFlags
				.filter((flag) => flag.includes(query))
				.map((flag) => ({ value: flag, label: flag }));
		}

		if (hasTrailingSpace) {
			return queryFlags.map((flag) => ({ value: flag, label: flag }));
		}

		return null;
	}

	private getContractArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const subcommands = ["ui", "show", "edit", "clear", "help"];
		const scopeFlags = ["--scope"];
		const scopeValues = ["project", "session"];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			return [...subcommands, ...scopeFlags]
				.filter((item) => item.includes(query))
				.map((item) => ({ value: item, label: item }));
		}

		const scopeIndex = tokens.findIndex((token) => token === "--scope");
		if (scopeIndex >= 0) {
			const currentValue = tokens[scopeIndex + 1];
			if (!currentValue) {
				return scopeValues.map((value) => ({ value, label: value }));
			}
			return scopeValues
				.filter((value) => value.startsWith(currentValue))
				.map((value) => ({ value, label: value }));
		}

		const query = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
		if (query.startsWith("--")) {
			return scopeFlags.filter((flag) => flag.includes(query)).map((flag) => ({ value: flag, label: flag }));
		}

		return null;
	}

	private getSingularArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const subcommands = ["help", "last"];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			return subcommands.filter((item) => item.includes(query)).map((item) => ({ value: item, label: item }));
		}

		return null;
	}

	private getSwarmArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const subcommands = ["run", "from-singular", "watch", "retry", "resume", "help"];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			return subcommands.filter((item) => item.includes(query)).map((item) => ({ value: item, label: item }));
		}

		const active = first;
		if (active === "run" || active === "from-singular") {
			const flags = ["--max-parallel", "--budget-usd", ...(active === "from-singular" ? ["--option"] : [])];
			const query = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
			if (!query || query.startsWith("--")) {
				return flags.filter((flag) => flag.includes(query)).map((flag) => ({ value: flag, label: flag }));
			}
		}

		if (active === "retry") {
			const flags = ["--reset-brief"];
			const query = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
			if (!query || query.startsWith("--")) {
				return flags.filter((flag) => flag.includes(query)).map((flag) => ({ value: flag, label: flag }));
			}
		}

		return null;
	}

	private setupAutocomplete(fdPath: string | undefined): void {
		// Define commands for autocomplete
		const builtinCommands = BUILTIN_SLASH_COMMANDS.filter(
			(command) => this.activeProfileName === "iosm" || !IOSM_PROFILE_ONLY_COMMANDS.has(command.name),
		);
		const slashCommands: SlashCommand[] = builtinCommands.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const mcpCommand = slashCommands.find((command) => command.name === "mcp");
		if (mcpCommand) {
			mcpCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getMcpArgumentCompletions(prefix);
		}

		const memoryCommand = slashCommands.find((command) => command.name === "memory");
		if (memoryCommand) {
			memoryCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getMemoryArgumentCompletions(prefix);
		}

		const semanticCommand = slashCommands.find((command) => command.name === "semantic");
		if (semanticCommand) {
			semanticCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getSemanticArgumentCompletions(prefix);
		}

		const contractCommand = slashCommands.find((command) => command.name === "contract");
		if (contractCommand) {
			contractCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getContractArgumentCompletions(prefix);
		}

		const singularCommand = slashCommands.find((command) => command.name === "singular");
		if (singularCommand) {
			singularCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getSingularArgumentCompletions(prefix);
		}

		const swarmCommand = slashCommands.find((command) => command.name === "swarm");
		if (swarmCommand) {
			swarmCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getSwarmArgumentCompletions(prefix);
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map((cmd) => ({
			name: cmd.name,
			description: cmd.description ?? "(extension command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		const customAgentMentionItems = (() => {
			const cwd = this.sessionManager.getCwd();
			const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
			return loaded.agents.map((agent) => ({
				name: agent.name,
				value: `@${agent.name} `,
				label: `@${agent.name}`,
				description: `${agent.description} · profile=${agent.profile ?? "full"}`,
			}));
		})();

		// Setup autocomplete
		const baseAutocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			process.cwd(),
			fdPath,
		);

		this.autocompleteProvider = {
			getSuggestions: (lines, cursorLine, cursorCol) => {
				const currentLine = lines[cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, cursorCol);
				const mentionMatch = textBeforeCursor.match(/(?:^|\s)(@[^\s@]*)$/);
				const mentionPrefix = mentionMatch?.[1] ?? null;
				const fallback = baseAutocompleteProvider.getSuggestions(lines, cursorLine, cursorCol);
				if (!mentionPrefix || customAgentMentionItems.length === 0) {
					return fallback;
				}

				const rawQuery = mentionPrefix.slice(1).trim();
				const normalizedQuery = rawQuery.replace(/\\/g, "/");
				const queryTail = normalizedQuery.split("/").filter(Boolean).pop() ?? normalizedQuery;
				const query = queryTail.replace(/\.md$/i, "");
				const filtered = query
					? fuzzyFilter(customAgentMentionItems, query, (item) => `${item.name} ${item.description ?? ""}`)
					: customAgentMentionItems;
				if (filtered.length === 0) {
					return fallback;
				}

				const mergedItems: AutocompleteItem[] = filtered.map((item) => ({
					value: item.value,
					label: item.label,
					description: item.description,
				}));
				const seen = new Set(mergedItems.map((item) => item.value));
				if (fallback && fallback.prefix === mentionPrefix) {
					for (const item of fallback.items) {
						if (seen.has(item.value)) continue;
						mergedItems.push(item);
					}
				}
				return { items: mergedItems, prefix: mentionPrefix };
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				if (prefix.startsWith("@")) {
					const currentLine = lines[cursorLine] || "";
					const replaceStart = Math.max(0, cursorCol - prefix.length);
					const beforePrefix = currentLine.slice(0, replaceStart);
					const afterCursor = currentLine.slice(cursorCol);
					const nextLines = [...lines];
					nextLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;
					return {
						lines: nextLines,
						cursorLine,
						cursorCol: beforePrefix.length + item.value.length,
					};
				}
				return baseAutocompleteProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
		};

		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Restore saved default model early so startup header/session are consistent after restart.
		await this.restoreSavedModelSelectionOnStartup();

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			this.builtInHeader = new Text(this.buildStartupHeaderContent(), 1, 0);
			this.asciiLogo = new AsciiLogoComponent();

			// Setup UI layout with logo + dashboard
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.asciiLogo);
			this.headerContainer.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
			this.headerContainer.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.changelogMarkdown) {
				this.headerContainer.addChild(new DynamicBorder());
				if (this.settingsManager.getCollapseChangelog()) {
					const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.headerContainer.addChild(new Text(condensedText, 1, 0));
				} else {
					this.headerContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.headerContainer.addChild(new Spacer(1));
					this.headerContainer.addChild(
						new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
					);
					this.headerContainer.addChild(new Spacer(1));
				}
				this.headerContainer.addChild(new DynamicBorder());
			}
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
			if (this.changelogMarkdown) {
				// Still show changelog notification even in silent mode
				this.headerContainer.addChild(new Spacer(1));
				const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
				const latestVersion = versionMatch ? versionMatch[1] : this.version;
				const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
				this.headerContainer.addChild(new Text(condensedText, 1, 0));
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Initialize extensions first so resources are shown before messages
		await this.initExtensions();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;

		// Set terminal title
		this.updateTerminalTitle();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Refresh provider catalog from models.dev in background once per startup.
		void this.refreshModelsDevProviderCatalog();

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	private buildStartupHeaderContent(): string {
		const kb = this.keybindings;
		const hasWorkspace = this.hasIosmWorkspace();
		const iosmMode = this.activeProfileName === "iosm";
		const activeModel = this.session.model;
		const activeModelText = activeModel ? `${activeModel.provider}/${activeModel.id}` : "not configured";
		const modelValue = activeModelText.length > 40 ? `${activeModelText.slice(0, 37)}...` : activeModelText;
		const availableModels = this.session.modelRegistry.getAvailable();
		const authProviders = this.session.modelRegistry.authStorage.list().length;
		const mcpStatuses = this.mcpRuntime?.getServers() ?? [];
		const mcpEnabled = mcpStatuses.filter((status) => status.enabled).length;
		const mcpConnected = mcpStatuses.filter((status) => status.state === "connected").length;
		const projectMemoryCount = this.getMemoryEntryCount("project");
		const userMemoryCount = this.getMemoryEntryCount("user");

		// Status indicator with colored dot
		const indicator = (ok: boolean): string =>
			ok ? theme.fg("success", "●") : theme.fg("warning", "○");

		// Title line: version + profile
		const titleLine =
			theme.bold(theme.fg("accent", `IOSM CLI`)) +
			theme.fg("dim", ` v${this.version}`) +
			theme.fg("dim", " │ ") +
			theme.fg("muted", "profile ") +
			theme.fg(iosmMode ? "accent" : "muted", this.activeProfileName);

		// Status rows with colored dot indicators
		const modeLabel = iosmMode ? (hasWorkspace ? "iosm" : "iosm (no workspace)") : "standard";
		const modeOk = iosmMode ? hasWorkspace : true;

		const modelOk = !!activeModel;
		const authOk = authProviders > 0;
		const readyOk = availableModels.length > 0;

		let mcpText = "none";
		let mcpOk = true;
		if (mcpStatuses.length > 0) {
			mcpText = mcpEnabled === 0
				? `0/${mcpStatuses.length} enabled`
				: `${mcpConnected}/${mcpEnabled} connected`;
			mcpOk = mcpEnabled > 0 && mcpConnected === mcpEnabled;
		}

		let memoryText: string;
		let memoryOk: boolean;
		if (projectMemoryCount !== undefined && userMemoryCount !== undefined) {
			const total = projectMemoryCount + userMemoryCount;
			memoryText = `project ${projectMemoryCount}, user ${userMemoryCount}`;
			memoryOk = total > 0;
		} else {
			memoryText = `project ${projectMemoryCount ?? "?"}, user ${userMemoryCount ?? "?"}`;
			memoryOk = false;
		}

		const pad = "  ";
		const statusRows = [
			`${pad}${indicator(modeOk)}  ${theme.fg("muted", "Mode")}     ${theme.fg(modeOk ? "text" : "warning", modeLabel)}`,
			`${pad}${indicator(modelOk)}  ${theme.fg("muted", "Model")}    ${theme.fg(modelOk ? "text" : "warning", modelValue)}`,
			`${pad}${indicator(authOk)}  ${theme.fg("muted", "Auth")}     ${theme.fg(authOk ? "text" : "warning", `${authProviders} provider${authProviders !== 1 ? "s" : ""}`)}`,
			`${pad}${indicator(readyOk)}  ${theme.fg("muted", "Ready")}    ${theme.fg(readyOk ? "text" : "warning", `${availableModels.length} model${availableModels.length !== 1 ? "s" : ""}`)}`,
			`${pad}${indicator(mcpOk)}  ${theme.fg("muted", "MCP")}      ${theme.fg(mcpOk ? "text" : "warning", mcpText)}`,
			`${pad}${indicator(memoryOk)}  ${theme.fg("muted", "Memory")}   ${theme.fg(memoryOk ? "text" : "warning", memoryText)}`,
		];

		// Contextual guidance
		let guidanceLine: string;
		if (!activeModel && availableModels.length === 0) {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Get started: ${theme.fg("accent", "/login")} ${theme.fg("dim", "→")} ${theme.fg("accent", "/model")} ${theme.fg("dim", "→")} ${theme.fg("accent", "/doctor")}`;
		} else if (!activeModel) {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Select a model: ${theme.fg("accent", "/model")}`;
		} else if (iosmMode && !hasWorkspace) {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Initialize workspace: ${theme.fg("accent", "/init")} or ${theme.fg("accent", "/iosm")}`;
		} else {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Ready. Type a task or use ${theme.fg("accent", "/help")} for commands`;
		}

		// Commands and keys
			const commandsLine =
				`${pad}${theme.fg("dim", "cmds")}  ` +
				["model", "login", "contract", "singular", "semantic", "memory", "new"]
					.map((c) => theme.fg("accent", `/${c}`))
					.join(theme.fg("dim", "  "));

		const keysLine =
			`${pad}${theme.fg("dim", "keys")}  ` +
			appKeyHint(kb, "interrupt", "stop") +
			theme.fg("dim", "  ") +
			appKeyHint(kb, "selectModel", "model") +
			theme.fg("dim", "  ") +
			appKeyHint(kb, "cycleModelForward", "next-model") +
			theme.fg("dim", "  ") +
			appKeyHint(kb, "cycleProfile", "profile");

		return [
			titleLine,
			"",
			...statusRows,
			"",
			guidanceLine,
			"",
			commandsLine,
			keysLine,
		].join("\n");
	}

	private getMemoryEntryCount(scope: MemoryScope): number | undefined {
		try {
			return readMemoryEntries(this.resolveMemoryPath(scope)).entries.length;
		} catch {
			return undefined;
		}
	}

	private refreshBuiltInHeader(): void {
		if (!this.builtInHeader || this.customHeader || this.settingsManager.getQuietStartup()) {
			return;
		}
		this.builtInHeader.setText(this.buildStartupHeaderContent());
		this.ui.requestRender();
	}

	private hasIosmWorkspace(): boolean {
		return fs.existsSync(path.join(this.sessionManager.getCwd(), ".iosm"));
	}

	private requireIosmMode(commandName: string): boolean {
		if (this.activeProfileName === "iosm") return true;
		this.showWarning(`\`${commandName}\` is available only in IOSM profile. Switch profile to \`iosm\` (Shift+Tab).`);
		return false;
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(process.cwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_NAME} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_NAME} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		this.checkForNewVersion().then((newVersion) => {
			if (newVersion) {
				this.showNewVersionNotification(newVersion);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			const staleNoModelsWarning = this.session.model && modelFallbackMessage.startsWith("No models available.");
			if (!staleNoModelsWarning) {
				this.showWarning(modelFallbackMessage);
			}
		}
		if (!this.session.model) {
			this.showWarning("No model selected. Choose a model to start.");
			await this.showModelProviderSelector();
		}

		// Process initial messages
		if (initialMessage && this.session.model) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		} else if (initialMessage && !this.session.model) {
			this.showWarning("Initial message not sent: select a model first.");
		}

		if (initialMessages && this.session.model) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		} else if (initialMessages && initialMessages.length > 0 && !this.session.model) {
			this.showWarning("Initial messages not sent: select a model first.");
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.promptWithTaskFallback(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	/**
	 * Check npm registry for a newer version.
	 */
	private async checkForNewVersion(): Promise<string | undefined> {
		if (
			process.env[ENV_SKIP_VERSION_CHECK] ||
			process.env.PI_SKIP_VERSION_CHECK ||
			process.env[ENV_OFFLINE] ||
			process.env.PI_OFFLINE
		) {
			return undefined;
		}

		try {
			const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) return undefined;

			const data = (await response.json()) as { version?: string };
			const latestVersion = data.version;

			if (latestVersion && latestVersion !== this.version) {
				return latestVersion;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - just record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		} else {
			const newEntries = getNewEntries(entries, lastVersion);
			if (newEntries.length > 0) {
				this.settingsManager.setLastChangelogVersion(VERSION);
				return newEntries.map((e) => e.content).join("\n\n");
			}
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, source: string): string {
		// For npm packages, show path relative to node_modules/pkg/
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		// For git packages, show path relative to repo root
		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		// For local/auto, just use formatDisplayPath
		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(
		source: string,
		scope: string,
	): { label: string; scopeLabel?: string; color: "accent" | "muted" } {
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(source: string, scope: string): "user" | "project" | "path" {
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(source: string): boolean {
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(
		paths: string[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }> {
		const groups: Record<
			"user" | "project" | "path",
			{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const p of paths) {
			const meta = this.findMetadata(p, metadata);
			const source = meta?.source ?? "local";
			const scope = meta?.scope ?? "project";
			const groupKey = this.getScopeGroup(source, scope);
			const group = groups[groupKey];

			if (this.isPackageSource(source)) {
				const list = group.packages.get(source) ?? [];
				list.push(p);
				group.packages.set(source, list);
			} else {
				group.paths.push(p);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }>,
		options: {
			formatPath: (p: string) => string;
			formatPackagePath: (p: string, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.localeCompare(b));
			for (const p of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(p)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, paths] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...paths].sort((a, b) => a.localeCompare(b));
				for (const p of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(p, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Find metadata for a path, checking parent directories if exact match fails.
	 * Package manager stores metadata for directories, but we display file paths.
	 */
	private findMetadata(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): { source: string; scope: string; origin: string } | undefined {
		// Try exact match first
		const exact = metadata.get(p);
		if (exact) return exact;

		// Try parent directories (package manager stores directory paths)
		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = metadata.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	/**
	 * Format a path with its source/scope info from metadata.
	 */
	private formatPathWithSource(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const meta = this.findMetadata(p, metadata);
		if (meta) {
			const shortPath = this.getShortPath(p, meta.source);
			const { label, scopeLabel } = this.getDisplaySourceInfo(meta.source, meta.scope);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	/**
	 * Format resource diagnostics with nice collision display using metadata.
	 */
	private formatDiagnostics(
		diagnostics: readonly ResourceDiagnostic[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			// Show winner
			lines.push(
				theme.fg("dim", `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, metadata)}`),
			);
			// Show all losers
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, metadata)} (skipped)`,
						),
					);
				}
			}
		}

		// Format other diagnostics (skill name collisions, parse errors, etc.)
		for (const d of otherDiagnostics) {
			if (d.path) {
				// Use metadata-aware formatting for paths
				const sourceInfo = this.formatPathWithSource(d.path, metadata);
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${sourceInfo}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensionPaths?: string[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const metadata = this.session.resourceLoader.getPathMetadata();
		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles.filter((file) => {
			const normalized = file.path.replace(/\\/g, "/");
			const isIosmPlaybook = normalized.endsWith("/IOSM.md");
			const isAgentsPlaybook = normalized.endsWith("/AGENTS.md");
			if (!isIosmPlaybook && !isAgentsPlaybook) return true;
			return this.activeProfileName === "iosm" ? isIosmPlaybook : isAgentsPlaybook;
		});
		const loadedThemes = themesResult.themes;
		const customThemes = loadedThemes.filter((t) => t.sourcePath);
		const extensionPaths = options?.extensionPaths ?? [];

		if (showListing) {
			const summaryParts = [];
			if (contextFiles.length > 0) summaryParts.push(theme.fg("accent", `${contextFiles.length} context`));
			if (skillsResult.skills.length > 0) summaryParts.push(theme.fg("accent", `${skillsResult.skills.length} skills`));
			if (this.session.promptTemplates.length > 0) {
				summaryParts.push(theme.fg("accent", `${this.session.promptTemplates.length} prompts`));
			}
			if (extensionPaths.length > 0) summaryParts.push(theme.fg("accent", `${extensionPaths.length} extensions`));
			if (customThemes.length > 0) summaryParts.push(theme.fg("accent", `${customThemes.length} themes`));
				if (summaryParts.length > 0) {
					// Build compact resource block: summary + inline items
					const lines: string[] = [];
					lines.push(
						`${theme.fg("dim", "resources")}  ${summaryParts.join(theme.fg("dim", " · "))}`,
					);

				// Context: show file basenames inline
				if (contextFiles.length > 0) {
					const names = contextFiles.map((f) => theme.fg("dim", this.formatDisplayPath(f.path)));
					lines.push(`  ${theme.fg("muted", "ctx")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				// Skills: show file basenames inline
				if (skillsResult.skills.length > 0) {
					const names = skillsResult.skills.map((s) => {
						const parts = s.filePath.replace(/\\/g, "/").split("/");
						// Use the parent directory name as skill name (directory before SKILL.md)
						const skillDir = parts[parts.length - 2] || parts[parts.length - 1];
						return theme.fg("dim", skillDir);
					});
					lines.push(`  ${theme.fg("muted", "ski")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				// Prompts: show command names inline
				if (this.session.promptTemplates.length > 0) {
					const names = this.session.promptTemplates.map((t) => theme.fg("dim", `/${t.name}`));
					lines.push(`  ${theme.fg("muted", "cmd")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				// Extensions: show basenames inline
				if (extensionPaths.length > 0) {
					const names = extensionPaths.map((p) => theme.fg("dim", this.formatDisplayPath(p)));
					lines.push(`  ${theme.fg("muted", "ext")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				const resourceWidth = Math.max(24, this.ui?.terminal?.columns ?? 120);
				const safeLines = lines.map((line) =>
					visibleWidth(line) > resourceWidth ? truncateToWidth(line, resourceWidth, "") : line,
				);

				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(safeLines.join("\n"), 0, 0));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
			extensionDiagnostics.push(...commandDiagnostics);

			const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async initExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();

					// Delegate to AgentSession (handles setup + agent state sync)
					const success = await this.session.newSession(options);
					if (!success) {
						return { cancelled: true };
					}

					// Clear UI state
					this.chatContainer.clear();
					this.pendingMessagesContainer.clear();
					this.compactionQueuedMessages = [];
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.pendingTools.clear();

					// Render any messages added via setup, or show empty session
					this.renderInitialMessages();
					this.ui.requestRender();

					return { cancelled: false };
				},
				fork: async (entryId) => {
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					this.showStatus("Forked to new session");

					return { cancelled: false };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");

					return { cancelled: false };
				},
				switchSession: async (sessionPath) => {
					await this.handleResumeSession(sessionPath);
					return { cancelled: false };
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocomplete(this.fdPath);

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			this.showLoadedResources({ extensionPaths: [], force: false });
			return;
		}

		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		const tools = this.session.extensionRunner?.getAllRegisteredTools() ?? [];
		const registeredTool = tools.find((t) => t.definition.name === toolName);
		return registeredTool?.definition;
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			abort: () => this.session.abort(),
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.executeCompaction(options?.customInstructions, false);
						if (result) {
							options?.onComplete?.(result);
						}
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.setCustomEditorComponent(undefined);
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(
				`${this.defaultWorkingMessage} (${appKey(this.keybindings, "interrupt")} to interrupt)`,
			);
		}
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => this.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async runWithExtensionLoader<T>(message: string, task: () => Promise<T>): Promise<T> {
		const loader = new BorderedLoader(this.ui, theme, message, {
			cancellable: false,
		});
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			return await task();
		} finally {
			restoreEditor();
		}
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			const queuedMessages = this.getAllQueuedMessages();
			const queuedMeta = queuedMessages.meta ?? [];
			const hasInterruptibleWork =
				this.session.isStreaming ||
				this.session.isBashRunning ||
				this.session.isCompacting ||
				this.session.isRetrying ||
				this.iosmAutomationRun !== undefined ||
				this.iosmVerificationSession !== undefined ||
				this.singularAnalysisSession !== undefined ||
				queuedMessages.steering.length > 0 ||
				queuedMessages.followUp.length > 0 ||
				queuedMeta.length > 0;

			if (hasInterruptibleWork) {
				void this.interruptCurrentWork();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("cycleProfile", () => this.cycleProfile("forward"));
		this.defaultEditor.onAction("cycleThinkingLevel", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("cycleModelForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("cycleModelBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("selectModel", () => {
			void this.showModelProviderSelector();
		});
		this.defaultEditor.onAction("expandTools", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("toggleThinking", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("externalEditor", () => this.openExternalEditor());
		this.defaultEditor.onAction("steer", () => this.handleSteer());
		this.defaultEditor.onAction("followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("newSession", () => this.handleClearCommand());
		this.defaultEditor.onAction("tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Write to temp file
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `iosm-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Handle commands
			if (text === "/init" || text.startsWith("/init ")) {
				this.editor.setText("");
				await this.handleIosmInitSlashCommand(text);
				return;
			}
			if (text === "/iosm" || text.startsWith("/iosm ")) {
				this.editor.setText("");
				await this.handleIosmAutomationSlashCommand(text);
				return;
			}
			if (text === "/orchestrate" || text.startsWith("/orchestrate ")) {
				this.editor.setText("");
				await this.handleOrchestrateSlashCommand(text);
				return;
			}
			if (text === "/swarm" || text.startsWith("/swarm ")) {
				this.editor.setText("");
				await this.handleSwarmCommand(text);
				return;
			}
			if (text === "/agents" || text.startsWith("/agents ")) {
				this.editor.setText("");
				await this.handleAgentsSlashCommand(text);
				return;
			}
			if (text === "/subagent-runs" || text.startsWith("/subagent-runs ")) {
				this.editor.setText("");
				this.handleSubagentRunsSlashCommand(text);
				return;
			}
			if (text === "/subagent-resume" || text.startsWith("/subagent-resume ")) {
				this.editor.setText("");
				await this.handleSubagentResumeSlashCommand(text);
				return;
			}
			if (text === "/team-runs" || text.startsWith("/team-runs ")) {
				this.editor.setText("");
				this.handleTeamRunsSlashCommand(text);
				return;
			}
			if (text === "/team-status" || text.startsWith("/team-status ")) {
				this.editor.setText("");
				await this.handleTeamStatusSlashCommand(text);
				return;
			}
			if (text === "/cycle-list") {
				this.editor.setText("");
				this.handleIosmCycleListSlashCommand();
				return;
			}
			if (text === "/cycle-plan" || text.startsWith("/cycle-plan ")) {
				this.editor.setText("");
				await this.handleIosmCyclePlanSlashCommand(text);
				return;
			}
			if (text === "/cycle-report" || text.startsWith("/cycle-report ")) {
				this.editor.setText("");
				await this.handleIosmCycleReportSlashCommand(text);
				return;
			}
			if (text === "/cycle-status" || text.startsWith("/cycle-status ")) {
				this.editor.setText("");
				await this.handleIosmCycleStatusSlashCommand(text);
				return;
			}
			if (text === "/mcp" || text.startsWith("/mcp ")) {
				this.editor.setText("");
				await this.handleMcpSlashCommand(text);
				return;
			}
			if (text === "/memory" || text.startsWith("/memory ")) {
				this.editor.setText("");
				await this.handleMemoryCommand(text);
				return;
			}
			if (text === "/semantic" || text.startsWith("/semantic ")) {
				this.editor.setText("");
				await this.handleSemanticCommand(text);
				return;
			}
			if (text === "/contract" || text.startsWith("/contract ")) {
				this.editor.setText("");
				await this.handleContractCommand(text);
				return;
			}
			if (text === "/singular" || text.startsWith("/singular ")) {
				this.editor.setText("");
				await this.handleSingularCommand(text);
				return;
			}
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/permissions" || text.startsWith("/permissions ")) {
				this.editor.setText("");
				await this.handlePermissionsCommand(text);
				return;
			}
			if (text === "/yolo" || text.startsWith("/yolo ")) {
				this.editor.setText("");
				this.handleYoloCommand(text);
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text.startsWith("/export")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/doctor" || text.startsWith("/doctor ")) {
				this.editor.setText("");
				await this.handleDoctorCommand(text);
				return;
			}
			if (text === "/checkpoint" || text.startsWith("/checkpoint ")) {
				this.editor.setText("");
				this.handleCheckpointCommand(text);
				return;
			}
			if (text === "/rollback" || text.startsWith("/rollback ")) {
				this.editor.setText("");
				await this.handleRollbackCommand(text);
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text === "/auth" || text.startsWith("/auth ")) {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new" || text === "/clear" || text.startsWith("/clear ")) {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Soft first-run gate: require model selection before normal chat/bash input.
			// Slash commands remain available so the user can run /model, /login, /init, etc.
			if (!this.session.model && !text.startsWith("/")) {
				this.showWarning("Select a model first with /model (or configure auth with /login).");
				await this.showModelProviderSelector();
				this.editor.setText("");
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, this.session.streamInputMode);
				}
				return;
			}

			// If streaming, use configured stream input mode (meta/followUp/steer)
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				const streamingBehavior = resolveStreamingSubmissionMode({
					configuredMode: this.session.streamInputMode,
					activeProfileName: this.activeProfileName,
					activeSubagentCount: this.subagentComponents.size,
					activeAssistantOrchestrationContext: this.activeAssistantOrchestrationContext,
				});
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior });
				if (streamingBehavior !== this.session.streamInputMode) {
					this.showStatus("Queued follow-up until meta orchestration completes");
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private updateRunningSubagentDisplay(subagent: RunningSubagentState): void {
		subagent.component.update({
			description: subagent.description,
			profile: subagent.profile,
			status: "running",
			phase: subagent.phase ?? "running",
			phaseState: subagent.phaseState,
			cwd: subagent.cwd,
			agent: subagent.agent,
			lockKey: subagent.lockKey,
			isolation: subagent.isolation,
			activeTool: subagent.activeTool,
			toolCallsStarted: subagent.toolCallsStarted,
			toolCallsCompleted: subagent.toolCallsCompleted,
			assistantMessages: subagent.assistantMessages,
			delegatedTasks: subagent.delegatedTasks,
			delegatedSucceeded: subagent.delegatedSucceeded,
			delegatedFailed: subagent.delegatedFailed,
			delegateIndex: subagent.delegateIndex,
			delegateTotal: subagent.delegateTotal,
			delegateDescription: subagent.delegateDescription,
			delegateProfile: subagent.delegateProfile,
			delegateItems: subagent.delegateItems,
			durationMs: Date.now() - subagent.startTime,
		});
	}

	private ensureSubagentElapsedTimer(): void {
		if (this.subagentElapsedTimer || this.subagentComponents.size === 0) {
			return;
		}
		this.subagentElapsedTimer = setInterval(() => {
			if (this.subagentComponents.size === 0) {
				this.clearSubagentElapsedTimer();
				return;
			}
			for (const subagent of this.subagentComponents.values()) {
				this.updateRunningSubagentDisplay(subagent);
			}
			this.ui.requestRender();
		}, 1000);
	}

	private clearSubagentElapsedTimer(): void {
		if (!this.subagentElapsedTimer) {
			return;
		}
		clearInterval(this.subagentElapsedTimer);
		this.subagentElapsedTimer = undefined;
	}

	private stopSubagentElapsedTimerIfIdle(): void {
		if (this.subagentComponents.size === 0) {
			this.clearSubagentElapsedTimer();
		}
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.loadingAnimation = new DecryptLoader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					this.defaultWorkingMessage,
				);
				this.statusContainer.addChild(this.loadingAnimation);
				// Apply any pending working message queued before loader existed
				if (this.pendingWorkingMessage !== undefined) {
					if (this.pendingWorkingMessage) {
						this.loadingAnimation.setMessage(this.pendingWorkingMessage);
					}
					this.pendingWorkingMessage = undefined;
				}
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.activeAssistantOrchestrationContext = this.pendingAssistantOrchestrationContexts > 0;
					if (this.activeAssistantOrchestrationContext) {
						this.pendingAssistantOrchestrationContexts -= 1;
					}
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (content.name === "task") {
								const staleTaskComponent = this.pendingTools.get(content.id);
								if (staleTaskComponent) {
									this.chatContainer.removeChild(staleTaskComponent);
									this.pendingTools.delete(content.id);
								}
								continue;
							}
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.activeAssistantOrchestrationContext = false;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				if (event.toolName === "task" && !this.subagentComponents.has(event.toolCallId)) {
					const staleTaskComponent = this.pendingTools.get(event.toolCallId);
					if (staleTaskComponent) {
						this.chatContainer.removeChild(staleTaskComponent);
						this.pendingTools.delete(event.toolCallId);
					}
					const args = event.args as {
						description?: string;
						profile?: string;
						prompt?: string;
						cwd?: string;
						lock_key?: string;
						agent?: string;
						isolation?: "none" | "worktree";
					};
					const description = args.description ?? "Running subtask";
					const info: SubagentInfo = {
						description,
						profile: args.profile ?? "explore",
						status: "running",
						phase: "starting subagent",
						phaseState: "starting",
						cwd: args.cwd,
						agent: args.agent,
						lockKey: args.lock_key,
						isolation: args.isolation,
						toolCallsStarted: 0,
						toolCallsCompleted: 0,
						assistantMessages: 0,
					};
					const component = new SubagentMessageComponent(info);
					this.chatContainer.addChild(component);
					this.subagentComponents.set(event.toolCallId, {
						component,
						startTime: Date.now(),
						profile: info.profile,
						description: info.description,
						cwd: info.cwd,
						agent: info.agent,
						lockKey: info.lockKey,
						isolation: info.isolation,
						phase: info.phase,
						phaseState: info.phaseState,
						activeTool: info.activeTool,
						toolCallsStarted: info.toolCallsStarted ?? 0,
						toolCallsCompleted: info.toolCallsCompleted ?? 0,
						assistantMessages: info.assistantMessages ?? 0,
						delegatedTasks: info.delegatedTasks,
						delegatedSucceeded: info.delegatedSucceeded,
						delegatedFailed: info.delegatedFailed,
						delegateIndex: info.delegateIndex,
						delegateTotal: info.delegateTotal,
						delegateDescription: info.delegateDescription,
						delegateProfile: info.delegateProfile,
						delegateItems: info.delegateItems,
					});
					this.ensureSubagentElapsedTimer();
					this.ui.requestRender();
				} else if (event.toolName !== "task" && !this.pendingTools.has(event.toolCallId)) {
					const component = new ToolExecutionComponent(
						event.toolName,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_update": {
				const subagent = this.subagentComponents.get(event.toolCallId);
				if (subagent) {
					const partialResult = event.partialResult as
						| {
							details?: Record<string, unknown>;
							content?: Array<{ type?: string; text?: string }>;
						}
						| undefined;
					const progressCandidate = partialResult?.details?.progress;
					const progress =
						progressCandidate && typeof progressCandidate === "object"
							? (progressCandidate as Record<string, unknown>)
							: undefined;

					if (progress) {
						const phaseText = typeof progress.message === "string" ? progress.message.trim() : undefined;
						const phaseState = isSubagentPhaseState(progress.phase) ? progress.phase : undefined;
						if (phaseText && phaseText.length > 0) {
							subagent.phase = phaseText;
						} else if (phaseState) {
							subagent.phase = phaseState;
						}
						if (phaseState) {
							subagent.phaseState = phaseState;
						}
						if (typeof progress.cwd === "string") {
							subagent.cwd = progress.cwd;
						}
						if ("activeTool" in progress) {
							subagent.activeTool =
								typeof progress.activeTool === "string" && progress.activeTool.trim().length > 0
									? progress.activeTool
									: undefined;
						}
						if (typeof progress.toolCallsStarted === "number") {
							subagent.toolCallsStarted = progress.toolCallsStarted;
						}
						if (typeof progress.toolCallsCompleted === "number") {
							subagent.toolCallsCompleted = progress.toolCallsCompleted;
						}
						if (typeof progress.assistantMessages === "number") {
							subagent.assistantMessages = progress.assistantMessages;
						}
						if ("delegateIndex" in progress) {
							subagent.delegateIndex =
								typeof progress.delegateIndex === "number" && progress.delegateIndex > 0
									? progress.delegateIndex
									: undefined;
						}
						if ("delegateTotal" in progress) {
							subagent.delegateTotal =
								typeof progress.delegateTotal === "number" && progress.delegateTotal > 0
									? progress.delegateTotal
									: undefined;
						}
						if ("delegateDescription" in progress) {
							subagent.delegateDescription =
								typeof progress.delegateDescription === "string" && progress.delegateDescription.trim().length > 0
									? progress.delegateDescription.trim()
									: undefined;
						}
						if ("delegateProfile" in progress) {
							subagent.delegateProfile =
								typeof progress.delegateProfile === "string" && progress.delegateProfile.trim().length > 0
									? progress.delegateProfile.trim()
									: undefined;
						}
						if ("delegateItems" in progress) {
							subagent.delegateItems = parseSubagentDelegateItems(progress.delegateItems);
						}
					} else {
						const text = partialResult?.content?.find((item) => item.type === "text")?.text;
						if (typeof text === "string" && text.trim().length > 0) {
							subagent.phase = text.trim();
						}
					}

					this.updateRunningSubagentDisplay(subagent);
					this.ui.requestRender();
					break;
				}

				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				// Handle subagent (task tool) completion
				const subagent = this.subagentComponents.get(event.toolCallId);
				if (subagent) {
					const durationMs = Date.now() - subagent.startTime;
					const details = event.result?.details as Record<string, unknown> | undefined;
					const outputLength = typeof details?.outputLength === "number" ? details.outputLength : undefined;
					const waitMs = typeof details?.waitMs === "number" ? details.waitMs : undefined;
					const toolCallsStarted =
						typeof details?.toolCallsStarted === "number"
							? details.toolCallsStarted
							: subagent.toolCallsStarted;
					const toolCallsCompleted =
						typeof details?.toolCallsCompleted === "number"
							? details.toolCallsCompleted
							: subagent.toolCallsCompleted;
					const assistantMessages =
						typeof details?.assistantMessages === "number"
							? details.assistantMessages
							: subagent.assistantMessages;
					const delegatedTasks =
						typeof details?.delegatedTasks === "number" ? details.delegatedTasks : subagent.delegatedTasks;
					const delegatedSucceeded =
						typeof details?.delegatedSucceeded === "number"
							? details.delegatedSucceeded
							: subagent.delegatedSucceeded;
					const delegatedFailed =
						typeof details?.delegatedFailed === "number" ? details.delegatedFailed : subagent.delegatedFailed;
					subagent.delegatedTasks = delegatedTasks;
					subagent.delegatedSucceeded = delegatedSucceeded;
					subagent.delegatedFailed = delegatedFailed;
					subagent.component.update({
						description: subagent.description,
						profile: subagent.profile,
						status: event.isError ? "error" : "done",
						outputLength,
						durationMs,
						waitMs,
						phaseState: subagent.phaseState,
						cwd: subagent.cwd,
						agent: subagent.agent,
						lockKey: subagent.lockKey,
						isolation: subagent.isolation,
						toolCallsStarted,
						toolCallsCompleted,
						assistantMessages,
						delegatedTasks,
						delegatedSucceeded,
						delegatedFailed,
						errorMessage: event.isError
							? (event.result?.content?.[0] as { text?: string } | undefined)?.text ?? "error"
							: undefined,
					});
					const staleTaskComponent = this.pendingTools.get(event.toolCallId);
					if (staleTaskComponent) {
						this.chatContainer.removeChild(staleTaskComponent);
						this.pendingTools.delete(event.toolCallId);
					}
					this.subagentComponents.delete(event.toolCallId);
					this.stopSubagentElapsedTimerIfIdle();
					this.ui.requestRender();
					break;
				}
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.subagentComponents.clear();
				this.clearSubagentElapsedTimer();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "auto_compaction_start": {
				// Keep editor active; submissions are queued during compaction.
				// Set up escape to abort auto-compaction
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					void this.interruptCurrentWork();
				};
				// Show compacting indicator with reason
				this.statusContainer.clear();
				const reasonText = event.reason === "overflow" ? "Context overflow detected, " : "";
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`${reasonText}Auto-compacting... (${appKey(this.keybindings, "interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_compaction_end": {
				// Restore escape handler
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				// Stop loader
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				// Handle result
				if (event.aborted) {
					this.showStatus("Auto-compaction cancelled");
				} else if (event.result) {
					// Rebuild chat to show compacted state
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					// Add compaction component at bottom so user sees it without scrolling
					this.addMessageToChat({
						role: "compactionSummary",
						tokensBefore: event.result.tokensBefore,
						summary: event.result.summary,
						timestamp: Date.now(),
					});
					this.footer.invalidate();
				} else if (event.errorMessage) {
					// Compaction failed (e.g., quota exceeded, API error)
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					void this.interruptCurrentWork();
				};
				// Show retry indicator
				this.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s... (${appKey(this.keybindings, "interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		const joined = textBlocks.map((c) => (c as { text: string }).text).join("");
		const aliases = Array.isArray(this.pendingInternalUserDisplayAliases) ? this.pendingInternalUserDisplayAliases : [];
		const aliasIndex = aliases.findIndex((item) => item.rawPrompt === joined);
		if (aliasIndex !== -1) {
			const [alias] = aliases.splice(aliasIndex, 1);
			return alias?.displayText ?? joined;
		}
		return joined;
	}

	private handleInternalUiMetaMessage(message: AgentMessage): void {
		if (message.role !== "custom") return;
		if (message.customType !== INTERNAL_UI_META_CUSTOM_TYPE) return;
		if (!isInternalUiMetaDetails(message.details)) return;
		if (message.details.kind !== "orchestration_context") return;

		this.pendingAssistantOrchestrationContexts += 1;
		if (message.details.rawPrompt && message.details.displayText) {
			this.pendingInternalUserDisplayAliases.push({
				rawPrompt: message.details.rawPrompt,
				displayText: message.details.displayText,
			});
		}
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private showProgressLine(message: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.ui.requestRender();
	}

	private setWorkingMessage(message?: string): void {
		if (this.loadingAnimation) {
			if (message) {
				this.loadingAnimation.setMessage(message);
			} else {
				this.loadingAnimation.setMessage(
					`${this.defaultWorkingMessage} (${appKey(this.keybindings, "interrupt")} to interrupt)`,
				);
			}
		} else {
			this.pendingWorkingMessage = message;
		}
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				this.handleInternalUiMetaMessage(message);
				if (message.display) {
					if (message.customType === TASK_PLAN_CUSTOM_TYPE && isTaskPlanSnapshot(message.details)) {
						const component = new TaskPlanMessageComponent(message.details);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
					} else {
						const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
						const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
					}
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						this.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const hasOrchestrationContext = this.pendingAssistantOrchestrationContexts > 0;
				if (hasOrchestrationContext) {
					this.pendingAssistantOrchestrationContexts -= 1;
				}
				const previousOrchestrationContext = this.activeAssistantOrchestrationContext;
				this.activeAssistantOrchestrationContext = hasOrchestrationContext;
				const displayMessage = this.sanitizeAssistantDisplayMessage(message);
				this.activeAssistantOrchestrationContext = previousOrchestrationContext;
				const assistantComponent = new AssistantMessageComponent(
					displayMessage,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		this.pendingInternalUserDisplayAliases = [];
		this.pendingAssistantOrchestrationContexts = 0;
		this.activeAssistantOrchestrationContext = false;
		const pendingSubagentHistory = new Map<string, SubagentMessageComponent>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						if (content.name === "task") {
							const args = content.arguments as {
								description?: string;
								profile?: string;
								cwd?: string;
								agent?: string;
								lock_key?: string;
								isolation?: "none" | "worktree";
							};
							const subagent = new SubagentMessageComponent({
								description: args.description ?? "Running subtask",
								profile: args.profile ?? "explore",
								status: "running",
								cwd: args.cwd,
								agent: args.agent,
								lockKey: args.lock_key,
								isolation: args.isolation,
							});
							this.chatContainer.addChild(subagent);
							pendingSubagentHistory.set(content.id, subagent);
							continue;
						}
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(content.name),
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				const subagent = pendingSubagentHistory.get(message.toolCallId);
				if (subagent) {
					const details = message.details as Record<string, unknown> | undefined;
					subagent.update({
						description:
							typeof details?.description === "string" ? details.description : "Running subtask",
						profile: typeof details?.profile === "string" ? details.profile : "explore",
						status: message.isError ? "error" : "done",
						outputLength: typeof details?.outputLength === "number" ? details.outputLength : undefined,
						waitMs: typeof details?.waitMs === "number" ? details.waitMs : undefined,
						toolCallsStarted: typeof details?.toolCallsStarted === "number" ? details.toolCallsStarted : undefined,
						toolCallsCompleted:
							typeof details?.toolCallsCompleted === "number" ? details.toolCallsCompleted : undefined,
						assistantMessages:
							typeof details?.assistantMessages === "number" ? details.assistantMessages : undefined,
						delegatedTasks: typeof details?.delegatedTasks === "number" ? details.delegatedTasks : undefined,
						delegatedSucceeded:
							typeof details?.delegatedSucceeded === "number" ? details.delegatedSucceeded : undefined,
						delegatedFailed: typeof details?.delegatedFailed === "number" ? details.delegatedFailed : undefined,
						errorMessage: message.isError
							? (message.content?.[0] as { text?: string } | undefined)?.text ?? "error"
							: undefined,
					});
					pendingSubagentHistory.delete(message.toolCallId);
					continue;
				}
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (this.iosmAutomationRun) {
			if (this.iosmAutomationRun.cancelRequested && now - this.lastSigintTime < 500) {
				void this.shutdown();
				return;
			}
			this.lastSigintTime = now;
			void this.interruptCurrentWork();
			return;
		}
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		// Emit shutdown event to extensions
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner?.hasHandlers("session_shutdown")) {
			await extensionRunner.emit({
				type: "session_shutdown",
			});
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private handleCtrlZ(): void {
		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => { };
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	private async handleSteer(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "steer");
			}
			return;
		}

		// Dedicated steer shortcut always sends as steer while streaming
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "steer" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, steer behaves like regular submit
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private applyProfile(profileName: AgentProfileName): void {
		const profile = getAgentProfile(profileName);
		const nextActiveTools = this.getProfileToolNames(profile.name);
		this.session.setActiveToolsByName(nextActiveTools);
		this.session.setThinkingLevel(profile.thinkingLevel);
		this.profilePromptSuffix = profile.systemPromptAppend || undefined;
		this.syncRuntimePromptSuffix();
		this.session.setIosmAutopilotEnabled(profile.name === "iosm");

		this.activeProfileName = profile.name;
		this.footer.setActiveProfile(profile.name);
		this.footer.setPlanMode(profile.name === "plan");
		this.setupAutocomplete(this.fdPath);
		this.footer.invalidate();
		this.updateEditorBorderColor();
		this.refreshBuiltInHeader();
		this.showStatus(`Profile: ${profile.name}`);
	}

	private cycleProfile(direction: "forward" | "backward"): void {
		if (this.session.isStreaming || this.session.isCompacting || this.iosmAutomationRun || this.iosmVerificationSession) {
			this.showWarning("Wait for current work to finish before switching profile.");
			return;
		}

		const names = getMainProfileNames();
		const currentIndex = Math.max(0, names.indexOf(this.activeProfileName));
		const delta = direction === "forward" ? 1 : -1;
		const nextIndex = (currentIndex + delta + names.length) % names.length;
		this.applyProfile(names[nextIndex]);
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.refreshBuiltInHeader();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.provider}/${result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `${APP_NAME}-editor-${Date.now()}.${APP_NAME}.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		const action = theme.fg("accent", getUpdateInstruction(PACKAGE_NAME));
		const updateInstruction = theme.fg("muted", `New version ${newVersion} is available. `) + action;
		const changelogLine = CHANGELOG_URL
			? theme.fg("muted", "Changelog: ") + theme.fg("accent", CHANGELOG_URL)
			: theme.fg("muted", "Changelog: CHANGELOG.md");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}\n${changelogLine}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[]; meta: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
			meta: [
				...this.session.getMetaMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "meta").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[]; meta: string[] } {
		const { steering, followUp, meta } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		const compactionMeta = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "meta")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
			meta: [...meta, ...compactionMeta],
		};
	}

	private updatePendingMessagesDisplay(): void {
		const bashComponents = [...this.pendingBashComponents];
		this.pendingMessagesContainer.clear();
		const {
			steering: steeringMessages,
			followUp: followUpMessages,
			meta: rawMetaMessages,
		} = this.getAllQueuedMessages();
		const metaMessages = rawMetaMessages ?? [];
		const totalQueued = steeringMessages.length + followUpMessages.length + metaMessages.length;
		if (totalQueued > 0 || bashComponents.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			if (totalQueued > 0) {
				const summaryParts = [theme.bold(theme.fg("accent", `Queue ${totalQueued}`))];
				if (metaMessages.length > 0) {
					summaryParts.push(theme.fg("accent", `${metaMessages.length} meta`));
				}
				if (steeringMessages.length > 0) {
					summaryParts.push(theme.fg("accent", `${steeringMessages.length} steer`));
				}
				if (followUpMessages.length > 0) {
					summaryParts.push(theme.fg("warning", `${followUpMessages.length} follow-up`));
				}
				this.pendingMessagesContainer.addChild(
					new TruncatedText(summaryParts.join(theme.fg("dim", " • ")), 1, 0),
				);
			}

			for (const message of steeringMessages) {
				const text =
					theme.fg("accent", "steer") +
					theme.fg("dim", " → ") +
					this.previewPendingMessage(message);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text =
					theme.fg("warning", "follow-up") +
					theme.fg("dim", " → ") +
					this.previewPendingMessage(message);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of metaMessages) {
				const text =
					theme.fg("accent", "meta") +
					theme.fg("dim", " → ") +
					this.previewPendingMessage(message);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const metaAppliedStep = this.session?.metaAppliedStep ?? 0;
			if (metaAppliedStep > 0) {
				this.pendingMessagesContainer.addChild(
					new TruncatedText(theme.fg("dim", `meta applied at step ${metaAppliedStep}`), 1, 0),
				);
			}
			if (totalQueued > 0) {
				const dequeueHint = this.getAppKeyDisplay("dequeue");
				const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit or restore the queued draft`);
				this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
			}
			if (bashComponents.length > 0) {
				this.pendingMessagesContainer.addChild(
					new TruncatedText(theme.fg("muted", `Pending bash ${bashComponents.length}`), 1, 0),
				);
			}
			for (const component of bashComponents) {
				this.pendingMessagesContainer.addChild(component);
			}
		}
	}

	private previewPendingMessage(message: string): string {
		return theme.fg("muted", message.replace(/\s+/g, " ").trim());
	}

	private async interruptCurrentWork(): Promise<boolean> {
		const queuedMessages = this.getAllQueuedMessages();
		const queuedMeta = queuedMessages.meta ?? [];
		const hasPendingQueuedMessages =
			queuedMessages.steering.length > 0 || queuedMessages.followUp.length > 0 || queuedMeta.length > 0;
		const hasAutomationWork = this.iosmAutomationRun !== undefined;
		const verificationSession = this.iosmVerificationSession;
		const hasVerificationWork = verificationSession !== undefined;
		const singularSession = this.singularAnalysisSession;
		const hasSingularWork = singularSession !== undefined;
		const hasMainStreaming = this.session.isStreaming;
		const hasRetryWork = this.session.isRetrying;
		const hasCompactionWork = this.session.isCompacting;
		const hasBashWork = this.session.isBashRunning;

		if (
			!hasPendingQueuedMessages &&
			!hasAutomationWork &&
			!hasVerificationWork &&
			!hasSingularWork &&
			!hasMainStreaming &&
			!hasRetryWork &&
			!hasCompactionWork &&
			!hasBashWork
		) {
			return false;
		}

		if (!hasMainStreaming && (hasBashWork || hasRetryWork || hasCompactionWork || hasPendingQueuedMessages)) {
			await this.session.notifyStopHooks?.("interrupt");
		}

		if (this.iosmAutomationRun) {
			this.iosmAutomationRun.cancelRequested = true;
		}
		if (hasPendingQueuedMessages) {
			this.restoreQueuedMessagesToEditor();
		} else {
			this.updatePendingMessagesDisplay();
		}
		if (hasBashWork) {
			this.session.abortBash();
		}
		if (hasRetryWork) {
			this.session.abortRetry();
		}
		if (hasCompactionWork) {
			this.session.abortCompaction();
			this.session.abortBranchSummary();
		}

		this.showStatus(
			hasAutomationWork
				? "Stopping IOSM automation..."
				: hasVerificationWork
					? "Stopping IOSM verification..."
					: hasSingularWork
						? "Stopping /singular analysis..."
						: "Stopping current run...",
		);

		const abortPromises: Promise<unknown>[] = [];
		if (hasMainStreaming) {
			abortPromises.push(this.session.abort());
		}
		if (verificationSession) {
			abortPromises.push(verificationSession.abort());
		}
		if (singularSession) {
			abortPromises.push(singularSession.abort());
		}
		if (abortPromises.length > 0) {
			const settleWithTimeout = (promise: Promise<unknown>): Promise<"done" | "timeout"> =>
				new Promise((resolve) => {
					let finished = false;
					const timeout = setTimeout(() => {
						if (finished) return;
						finished = true;
						resolve("timeout");
					}, INTERRUPT_ABORT_TIMEOUT_MS);

					promise.finally(() => {
						if (finished) return;
						finished = true;
						clearTimeout(timeout);
						resolve("done");
					});
				});

			const settled = await Promise.all(
				abortPromises.map((promise) => settleWithTimeout(promise)),
			);
			if (settled.includes("timeout")) {
				this.showWarning(
					`Abort is taking longer than ${Math.round(INTERRUPT_ABORT_TIMEOUT_MS / 1000)}s. Try interrupt again if the run is still active.`,
				);
			}
		}
		return true;
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp, meta } = this.clearAllQueues();
		const allQueued = [...meta, ...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp" | "meta"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "meta") {
						await this.session.meta(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "meta") {
					await this.session.meta(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private syncMcpToolsWithSession(): void {
		if (!this.mcpRuntime) return;
		this.session.setCustomTools(this.mcpRuntime.getToolDefinitions());
		this.setupAutocomplete(this.fdPath);
		this.refreshBuiltInHeader();
	}

	private async refreshMcpRuntimeAndSession(): Promise<void> {
		if (!this.mcpRuntime) return;
		await this.mcpRuntime.refresh();
		this.syncMcpToolsWithSession();
		const errors = this.mcpRuntime.getErrors();
		if (errors.length > 0) {
			this.showWarning(`MCP config warning: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
		}
	}

	private buildMcpStatusReport(statuses: ReturnType<McpRuntime["getServers"]>): string {
		if (statuses.length === 0) {
			return "No MCP servers configured.";
		}
		const lines: string[] = [];
		for (const status of statuses) {
			lines.push(
				`${status.name} · ${status.scope}/${status.transport} · ${status.enabled ? "enabled" : "disabled"} · state=${status.state} · tools=${status.toolCount}`,
			);
			if (status.error) {
				lines.push(`  error: ${status.error}`);
			}
			for (const tool of status.tools.slice(0, 8)) {
				const alias = tool.name === tool.exposedName ? "" : ` -> ${tool.exposedName}`;
				lines.push(`  - ${tool.name}${alias}`);
			}
			if (status.tools.length > 8) {
				lines.push(`  ... ${status.tools.length - 8} more`);
			}
		}
		return lines.join("\n");
	}

	private parseMcpKeyValueMapInput(raw: string): { value?: Record<string, string>; error?: string } {
		const trimmed = raw.trim();
		if (!trimmed) {
			return { value: undefined };
		}
		const pairs = trimmed
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		const value: Record<string, string> = {};
		for (const pair of pairs) {
			const eqIndex = pair.indexOf("=");
			if (eqIndex <= 0) {
				return { error: `Invalid pair "${pair}". Use KEY=VALUE,KEY2=VALUE2` };
			}
			const key = pair.slice(0, eqIndex).trim();
			const entryValue = pair.slice(eqIndex + 1).trim();
			if (!key) {
				return { error: `Invalid pair "${pair}". Key must not be empty.` };
			}
			value[key] = entryValue;
		}
		return { value: Object.keys(value).length > 0 ? value : undefined };
	}

	private parseMcpCsvListInput(raw: string): string[] | undefined {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		const items = trimmed
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return items.length > 0 ? [...new Set(items)] : undefined;
	}

	private async runMcpAddWizard(initialName?: string): Promise<void> {
		if (!this.mcpRuntime) {
			this.showWarning("MCP runtime is unavailable in this session.");
			return;
		}

		await this.refreshMcpRuntimeAndSession();

		let name = initialName?.trim();
		while (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
			const enteredName = await this.showExtensionInput("MCP Add: server name", "filesystem");
			if (enteredName === undefined) {
				this.showStatus("MCP add cancelled");
				return;
			}
			name = enteredName.trim();
			if (!name) {
				this.showWarning("Server name cannot be empty.");
				continue;
			}
			if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
				this.showWarning('Use only letters, numbers, ".", "_" or "-".');
				continue;
			}
		}

		const existing = this.mcpRuntime.getServer(name);
		if (existing) {
			const overwrite = await this.showExtensionConfirm(
				"MCP Add",
				`Server "${name}" already exists (${existing.scope}). Overwrite it?`,
			);
			if (!overwrite) {
				this.showStatus("MCP add cancelled");
				return;
			}
		}

		const scopeChoice = await this.showExtensionSelector("MCP Add: scope", ["project (Recommended)", "user"]);
		if (!scopeChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		const scope: McpScope = scopeChoice.startsWith("user") ? "user" : "project";

		const transportChoice = await this.showExtensionSelector("MCP Add: transport", [
			"stdio (Recommended)",
			"http",
			"sse",
		]);
		if (!transportChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		const transport = transportChoice.startsWith("http")
			? "http"
			: transportChoice.startsWith("sse")
				? "sse"
				: "stdio";

		const config: McpServerConfig = {
			transport,
			enabled: true,
			trust: false,
		};

		if (transport === "stdio") {
			while (!config.command) {
				const commandLine = await this.showExtensionInput(
					"MCP Add: stdio command",
					"npx -y @modelcontextprotocol/server-filesystem .",
				);
				if (commandLine === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const tokens = this.parseSlashArgs(commandLine.trim());
				if (tokens.length === 0) {
					this.showWarning("Command cannot be empty.");
					continue;
				}
				config.command = tokens[0];
				config.args = tokens.slice(1);
			}

			const cwdInput = await this.showExtensionInput(
				"MCP Add: working directory (optional)",
				"leave blank to use current project",
			);
			if (cwdInput === undefined) {
				this.showStatus("MCP add cancelled");
				return;
			}
			if (cwdInput.trim()) {
				config.cwd = cwdInput.trim();
			}

			while (true) {
				const envInput = await this.showExtensionInput(
					"MCP Add: env vars (optional)",
					"KEY=VALUE,API_TOKEN=${API_TOKEN}",
				);
				if (envInput === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const parsed = this.parseMcpKeyValueMapInput(envInput);
				if (parsed.error) {
					this.showWarning(parsed.error);
					continue;
				}
				config.env = parsed.value;
				break;
			}
		} else {
			while (!config.url) {
				const urlInput = await this.showExtensionInput(
					`MCP Add: ${transport.toUpperCase()} URL`,
					transport === "http" ? "https://example.com/mcp" : "https://example.com/sse",
				);
				if (urlInput === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const candidate = urlInput.trim();
				if (!candidate) {
					this.showWarning("URL cannot be empty.");
					continue;
				}
				config.url = candidate;
			}

			while (true) {
				const headersInput = await this.showExtensionInput(
					"MCP Add: headers (optional)",
					"Authorization=Bearer ${TOKEN}",
				);
				if (headersInput === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const parsed = this.parseMcpKeyValueMapInput(headersInput);
				if (parsed.error) {
					this.showWarning(parsed.error);
					continue;
				}
				config.headers = parsed.value;
				break;
			}
		}

		while (true) {
			const timeoutInput = await this.showExtensionInput("MCP Add: timeout ms (optional)", "30000");
			if (timeoutInput === undefined) {
				this.showStatus("MCP add cancelled");
				return;
			}
			const trimmed = timeoutInput.trim();
			if (!trimmed) {
				break;
			}
			const timeoutMs = Number.parseInt(trimmed, 10);
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				this.showWarning("Timeout must be a positive integer (milliseconds).");
				continue;
			}
			config.timeoutMs = timeoutMs;
			break;
		}

		const includeToolsInput = await this.showExtensionInput(
			"MCP Add: include tools (optional, CSV)",
			"toolA,toolB",
		);
		if (includeToolsInput === undefined) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.includeTools = this.parseMcpCsvListInput(includeToolsInput);

		const excludeToolsInput = await this.showExtensionInput(
			"MCP Add: exclude tools (optional, CSV)",
			"dangerousTool",
		);
		if (excludeToolsInput === undefined) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.excludeTools = this.parseMcpCsvListInput(excludeToolsInput);

		const trustChoice = await this.showExtensionSelector("MCP Add: trust this server?", [
			"No (Recommended)",
			"Yes",
		]);
		if (!trustChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.trust = trustChoice.startsWith("Yes");

		const enableChoice = await this.showExtensionSelector("MCP Add: enable now?", ["Yes (Recommended)", "No"]);
		if (!enableChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.enabled = enableChoice.startsWith("Yes");

		const path = await this.mcpRuntime.addServer(name, scope, config);
		this.syncMcpToolsWithSession();
		const status = this.mcpRuntime.getServer(name);
		this.showStatus(`Added MCP server ${name} (${scope})`);

		const details: string[] = [`Config: ${path}`];
		if (status?.state === "connected") {
			details.push(`Connected tools: ${status.toolCount}`);
		} else if (status?.state === "error") {
			details.push(`Connection warning: ${status.error ?? "unknown error"}`);
		}
		this.showCommandTextBlock("MCP Add", details.join("\n"));
	}

	private async handleMcpSlashCommand(text: string): Promise<void> {
		if (!this.mcpRuntime) {
			this.showWarning("MCP runtime is unavailable in this session.");
			return;
		}

		const args = this.parseSlashArgs(text).slice(1);
		if (args.length === 0) {
			await this.refreshMcpRuntimeAndSession();
			this.showMcpSelector();
			return;
		}

		const subcommand = args[0]?.toLowerCase();
		const rest = args.slice(1);

		if (!subcommand || subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
			return;
		}

		if (subcommand === "list" || subcommand === "status") {
			await this.refreshMcpRuntimeAndSession();
			this.showCommandTextBlock("MCP Servers", this.buildMcpStatusReport(this.mcpRuntime.getServers()));
			return;
		}

		if (subcommand === "add") {
			if (
				rest.length === 0 ||
				(rest.length === 1 && !rest[0]!.startsWith("-")) ||
				(rest.length > 0 && rest.includes("--wizard"))
			) {
				const prefilledName = rest.find((token) => !token.startsWith("-"));
				await this.runMcpAddWizard(prefilledName);
				return;
			}

			const parsed = parseMcpAddCommand(rest);
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}

			const path = await this.mcpRuntime.addServer(parsed.value.name, parsed.value.scope, parsed.value.config);
			this.syncMcpToolsWithSession();
			const status = this.mcpRuntime.getServer(parsed.value.name);
			this.showStatus(`Added MCP server ${parsed.value.name} (${parsed.value.scope})`);
			const extraLines = [`Config: ${path}`];
			if (status?.state === "connected") {
				extraLines.push(`Connected tools: ${status.toolCount}`);
			} else if (status?.state === "error") {
				extraLines.push(`Connection warning: ${status.error ?? "unknown error"}`);
			}
			this.showCommandTextBlock("MCP Add", extraLines.join("\n"));
			return;
		}

		if (subcommand === "remove") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}
			const removed = await this.mcpRuntime.removeServer(parsed.value.name, parsed.value.scope);
			if (removed.length === 0) {
				this.showWarning(`MCP server "${parsed.value.name}" not found.`);
				return;
			}
			this.syncMcpToolsWithSession();
			this.showStatus(`Removed MCP server ${parsed.value.name} from ${removed.join(", ")}`);
			return;
		}

		if (subcommand === "enable" || subcommand === "disable") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}

			const enabled = subcommand === "enable";
			let updatedScope: McpScope | undefined;
			if (parsed.value.scope === "all") {
				updatedScope =
					(await this.mcpRuntime.setServerEnabled(parsed.value.name, enabled, "project")) ??
					(await this.mcpRuntime.setServerEnabled(parsed.value.name, enabled, "user"));
			} else {
				updatedScope = await this.mcpRuntime.setServerEnabled(parsed.value.name, enabled, parsed.value.scope);
			}
			if (!updatedScope) {
				this.showWarning(`MCP server "${parsed.value.name}" not found.`);
				return;
			}
			this.syncMcpToolsWithSession();
			this.showStatus(`${enabled ? "Enabled" : "Disabled"} MCP server ${parsed.value.name} (${updatedScope})`);
			return;
		}

		if (subcommand === "reconnect" || subcommand === "refresh") {
			await this.refreshMcpRuntimeAndSession();
			this.showStatus("MCP servers refreshed");
			return;
		}

		if (subcommand === "tools") {
			await this.refreshMcpRuntimeAndSession();
			const serverName = rest[0];
			const statuses = this.mcpRuntime.getServers();
			const filtered = serverName ? statuses.filter((status) => status.name === serverName) : statuses;
			if (filtered.length === 0) {
				this.showWarning(serverName ? `MCP server "${serverName}" not found.` : "No MCP servers configured.");
				return;
			}
			this.showCommandTextBlock("MCP Tools", this.buildMcpStatusReport(filtered));
			return;
		}

		if (subcommand === "test") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}
			await this.refreshMcpRuntimeAndSession();
			const status = this.mcpRuntime.getServer(parsed.value.name);
			if (!status) {
				this.showWarning(`MCP server "${parsed.value.name}" not found.`);
				return;
			}
			if (status.state !== "connected") {
				this.showError(`MCP server "${parsed.value.name}" failed: ${status.error ?? "unknown error"}`);
				return;
			}
			this.showStatus(`MCP server "${parsed.value.name}" connected (${status.toolCount} tools)`);
			return;
		}

		this.showWarning(`Unknown /mcp subcommand "${subcommand}". Use /mcp help.`);
	}

	private showMcpSelector(): void {
		if (!this.mcpRuntime) {
			this.showWarning("MCP runtime is unavailable in this session.");
			return;
		}

		this.showSelector((done) => {
			const selector = new McpSelectorComponent(this.ui, this.mcpRuntime!.getServers(), {
				onClose: () => {
					done();
					this.ui.requestRender();
				},
				onToggleEnabled: async (server) => {
					try {
						const targetEnabled = !server.enabled;
						const updated = await this.mcpRuntime!.setServerEnabled(server.name, targetEnabled, server.scope);
						if (!updated) {
							this.showWarning(`MCP server "${server.name}" not found.`);
							return;
						}
						this.syncMcpToolsWithSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus(`${targetEnabled ? "Enabled" : "Disabled"} ${server.name} (${updated})`);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onReconnect: async () => {
					try {
						await this.refreshMcpRuntimeAndSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus("MCP servers refreshed");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onRemove: async (server) => {
					try {
						const removed = await this.mcpRuntime!.removeServer(server.name, server.scope);
						if (removed.length === 0) {
							this.showWarning(`MCP server "${server.name}" not found.`);
							return;
						}
						this.syncMcpToolsWithSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus(`Removed ${server.name} (${removed.join(", ")})`);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onRefresh: async () => {
					try {
						await this.refreshMcpRuntimeAndSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus("MCP servers refreshed");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onInsertAddCommand: () => {
					done();
					this.editor.setText("/mcp add ");
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					streamInputMode: this.session.streamInputMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocomplete(this.fdPath);
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onStreamInputModeChange: (mode) => {
						this.session.setStreamInputMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.setTransport(transport);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			await this.showModelProviderSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.refreshBuiltInHeader();
				this.showStatus(`Model: ${model.provider}/${model.id}`);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async showModelProviderSelector(preferredProvider?: string): Promise<void> {
		await this.hydrateMissingProviderModelsForSavedAuth();
		this.session.modelRegistry.refresh();
		let models: Model<any>[] = [];
		try {
			models = await this.session.modelRegistry.getAvailable();
		} catch {
			models = [];
		}
		if (models.length === 0) {
			if (preferredProvider) {
				// Fallback for transient registry/load errors: still open model selector
				// with a provider hint so login flow can continue.
				this.showModelSelector(preferredProvider);
				return;
			}
			this.showStatus("No models available");
			return;
		}

		const providerCounts = new Map<string, number>();
		for (const model of models) {
			providerCounts.set(model.provider, (providerCounts.get(model.provider) ?? 0) + 1);
		}
		const providers = Array.from(providerCounts.entries()).sort(([a], [b]) => a.localeCompare(b));
		if (providers.length === 0) {
			this.showStatus("No providers available");
			return;
		}

		if (preferredProvider) {
			const preferred = providers.find(([provider]) => provider.toLowerCase() === preferredProvider.toLowerCase());
			if (preferred) {
				this.showModelSelector(undefined, preferred[0]);
				return;
			}
		}

		if (providers.length === 1) {
			this.showModelSelector(undefined, providers[0]?.[0]);
			return;
		}

		const optionMap = new Map<string, string>();
		const options = ["All providers"];
		for (const [provider, count] of providers) {
			const optionLabel = `${provider} (${count})`;
			optionMap.set(optionLabel, provider);
			options.push(optionLabel);
		}

		const selected = await this.showExtensionSelector("/model: choose provider", options);
		if (!selected) return;
		if (selected === "All providers") {
			this.showModelSelector();
			return;
		}

		const provider = optionMap.get(selected);
		if (!provider) {
			this.showWarning("Provider selection is no longer available.");
			return;
		}
		this.showModelSelector(undefined, provider);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const term = searchTerm.trim();
		if (!term) return undefined;

		let targetProvider: string | undefined;
		let targetModelId = "";

		if (term.includes("/")) {
			const parts = term.split("/", 2);
			targetProvider = parts[0]?.trim().toLowerCase();
			targetModelId = parts[1]?.trim().toLowerCase() ?? "";
		} else {
			targetModelId = term.toLowerCase();
		}

		if (!targetModelId) return undefined;

		const models = await this.getModelCandidates();
		const exactMatches = models.filter((item) => {
			const idMatch = item.id.toLowerCase() === targetModelId;
			const providerMatch = !targetProvider || item.provider.toLowerCase() === targetProvider;
			return idMatch && providerMatch;
		});

		return exactMatches.length === 1 ? exactMatches[0] : undefined;
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
		this.refreshBuiltInHeader();
	}

	private showModelSelector(initialSearchInput?: string, providerFilter?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						this.refreshBuiltInHeader();
						done();
						this.showStatus(`Model: ${model.provider}/${model.id}`);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
				providerFilter,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		const enabledModelIds = new Set<string>();
		let hasFilter = false;

		if (hasSessionScope) {
			// Use current session's scoped models
			for (const sm of sessionScopedModels) {
				enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
			}
			hasFilter = true;
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				hasFilter = true;
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				for (const sm of scopedModels) {
					enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
				}
			}
		}

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(enabledModelIds);
		let currentHasFilter = hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
				const newScopedModels = await resolveModelScope(Array.from(enabledIds), this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				{
					onModelToggle: async (modelId, enabled) => {
						if (enabled) {
							currentEnabledIds.add(modelId);
						} else {
							currentEnabledIds.delete(modelId);
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onEnableAll: async (allModelIds) => {
						currentEnabledIds.clear();
						for (const id of allModelIds) {
							currentEnabledIds.add(id);
						}
						currentHasFilter = false;
						await updateSessionModels(currentEnabledIds);
					},
					onClearAll: async () => {
						currentEnabledIds.clear();
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onToggleProvider: async (_provider, modelIds, enabled) => {
						for (const id of modelIds) {
							if (enabled) {
								currentEnabledIds.add(id);
							} else {
								currentEnabledIds.delete(id);
							}
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						// Extension cancelled the fork
						done();
						this.ui.requestRender();
						return;
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					done();
					this.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							void this.interruptCurrentWork();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${appKey(this.keybindings, "interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		this.contractService.clear("session");

		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Clear UI state
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		// Switch session via AgentSession (emits extension session events)
		await this.session.switchSession(sessionPath);

		// Clear and re-render the chat
		this.chatContainer.clear();
		this.renderInitialMessages();
		this.syncRuntimePromptSuffix();
		this.refreshBuiltInHeader();
		this.showStatus("Resumed session");
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout") {
			const providers = this.session.modelRegistry.authStorage.list();
			const loggedInProviders = providers.filter((provider) => {
				const credential = this.session.modelRegistry.authStorage.get(provider);
				return credential?.type === "oauth" || credential?.type === "api_key";
			});
			if (loggedInProviders.length === 0) {
				this.showStatus("No saved provider credentials. Use /login first.");
				return;
			}
		}
		await this.refreshModelsDevProviderCatalog();
		const apiKeyProviders = this.getApiKeyLoginProviders(this.modelsDevProviderCatalog);

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				async (provider: LoginProviderOption) => {
					done();

					if (mode === "login") {
						if (provider.kind === "api_key") {
							if (provider.id === OPENROUTER_PROVIDER_ID) {
								await this.handleOpenRouterApiKeyLogin();
							} else {
								await this.handleApiKeyLogin(provider.id, { providerName: provider.name });
							}
						} else {
							await this.showLoginDialog(provider.id);
						}
					} else {
						// Logout flow
						const providerName = this.getProviderDisplayName(provider.id);

						try {
							this.session.modelRegistry.authStorage.logout(provider.id);
							this.session.modelRegistry.refresh();
							await this.updateAvailableProviderCount();
							this.showStatus(`Logged out of ${providerName}`);
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				apiKeyProviders,
			);
			return { component: selector, focus: selector };
		});
	}

	private async refreshModelsDevProviderCatalog(): Promise<void> {
		if (this.modelsDevProviderCatalogRefreshPromise) {
			await this.modelsDevProviderCatalogRefreshPromise;
			return;
		}

		this.modelsDevProviderCatalogRefreshPromise = (async () => {
			const catalog = await loadModelsDevProviderCatalog();
			this.modelsDevProviderCatalogById = catalog;
			this.modelsDevProviderCatalog = Array.from(catalog.values())
				.map((provider) => ({
					id: provider.id,
					name: provider.name,
					env: provider.env,
				}))
				.sort((a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
		})()
			.catch(() => {
				this.modelsDevProviderCatalog = MODELS_DEV_PROVIDERS;
				this.modelsDevProviderCatalogById = new Map(
					MODELS_DEV_PROVIDERS.map((provider) => [
						provider.id,
						{
							...provider,
							models: [],
						} satisfies ModelsDevProviderCatalogInfo,
					]),
				);
			})
			.finally(() => {
				this.modelsDevProviderCatalogRefreshPromise = undefined;
			});

		await this.modelsDevProviderCatalogRefreshPromise;
	}

	private resolveModelsDevApi(modelNpm?: string): Api {
		const npm = modelNpm?.toLowerCase() ?? "";
		if (npm.includes("anthropic")) return "anthropic-messages";
		if (npm.includes("google-vertex")) return "google-vertex";
		if (npm.includes("google")) return "google-generative-ai";
		if (npm.includes("amazon-bedrock")) return "bedrock-converse-stream";
		if (npm.includes("mistral")) return "mistral-conversations";
		if (npm.includes("@ai-sdk/openai") && !npm.includes("compatible")) return "openai-responses";
		return "openai-completions";
	}

	private buildModelsDevProviderConfig(providerInfo: ModelsDevProviderCatalogInfo): ProviderConfigInput | undefined {
		const baseUrl = providerInfo.api ?? providerInfo.models.find((model) => !!model.api)?.api;
		if (!baseUrl) return undefined;
		if (providerInfo.models.length === 0) return undefined;

		const models: NonNullable<ProviderConfigInput["models"]> = providerInfo.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: this.resolveModelsDevApi(model.npm ?? providerInfo.npm),
			reasoning: model.reasoning,
			input: [...model.input],
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			headers: Object.keys(model.headers).length > 0 ? model.headers : undefined,
		}));

		return {
			baseUrl,
			models,
		};
	}

	private hasRegisteredProviderModels(providerId: string): boolean {
		const registry = this.session.modelRegistry as { getAll?: () => Model<any>[] };
		if (typeof registry.getAll !== "function") return true;
		return registry.getAll().some((model) => model.provider === providerId);
	}

	private async hydrateProviderModelsFromModelsDev(providerId: string): Promise<boolean> {
		if (this.hasRegisteredProviderModels(providerId)) return true;

		await this.refreshModelsDevProviderCatalog();
		const providerInfo = this.modelsDevProviderCatalogById.get(providerId);
		if (!providerInfo) return false;

		const config = this.buildModelsDevProviderConfig(providerInfo);
		if (!config) return false;

		try {
			this.session.modelRegistry.registerProvider(providerId, config);
			return this.hasRegisteredProviderModels(providerId);
		} catch {
			return false;
		}
	}

	private async hydrateMissingProviderModelsForSavedAuth(): Promise<void> {
		const savedProviders = this.session.modelRegistry.authStorage.list();
		if (savedProviders.length === 0) return;

		for (const providerId of savedProviders) {
			if (this.hasRegisteredProviderModels(providerId)) continue;
			await this.hydrateProviderModelsFromModelsDev(providerId);
		}
	}

	private async restoreSavedModelSelectionOnStartup(): Promise<void> {
		if (this.session.model) return;

		const defaultProvider = this.settingsManager.getDefaultProvider();
		const defaultModelId = this.settingsManager.getDefaultModel();
		if (!defaultProvider || !defaultModelId) return;

		if (!this.hasRegisteredProviderModels(defaultProvider)) {
			await this.hydrateProviderModelsFromModelsDev(defaultProvider);
		}

		const model = this.session.modelRegistry.find(defaultProvider, defaultModelId);
		if (!model) return;

		try {
			const apiKey = await this.session.modelRegistry.getApiKey(model);
			if (!apiKey) return;
		} catch {
			return;
		}

		this.session.agent.setModel(model);
	}

	private getApiKeyLoginProviders(modelsDevProviders: readonly ModelsDevProviderInfo[]): LoginProviderOption[] {
		const providerNames = new Map<string, string>();
		this.apiKeyProviderDisplayNames.clear();

		for (const model of this.session.modelRegistry.getAll()) {
			if (!providerNames.has(model.provider)) {
				providerNames.set(model.provider, toProviderDisplayName(model.provider));
			}
		}

		for (const provider of modelsDevProviders) {
			const fallbackName = toProviderDisplayName(provider.id);
			const current = providerNames.get(provider.id);
			if (!current || current === fallbackName) {
				providerNames.set(provider.id, provider.name || fallbackName);
			}
		}

		for (const providerId of this.session.modelRegistry.authStorage.list()) {
			if (!providerNames.has(providerId)) {
				providerNames.set(providerId, toProviderDisplayName(providerId));
			}
		}

		const oauthProviderIds = new Set(this.session.modelRegistry.authStorage.getOAuthProviders().map((provider) => provider.id));
		const providers: LoginProviderOption[] = [];
		for (const [id, name] of providerNames.entries()) {
			if (oauthProviderIds.has(id)) continue;
			this.apiKeyProviderDisplayNames.set(id, name);
			providers.push({ id, name, kind: "api_key" });
		}

		providers.sort((a, b) => a.name.localeCompare(b.name));
		return providers;
	}

	private getProviderDisplayName(providerId: string): string {
		const apiKeyName = this.apiKeyProviderDisplayNames.get(providerId);
		if (apiKeyName) {
			return apiKeyName;
		}
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		return providerInfo?.name || toProviderDisplayName(providerId);
	}

	private async handleApiKeyLogin(
		providerId: string,
		options?: {
			providerName?: string;
			openModelSelector?: boolean;
			createKeyUrl?: string;
			placeholder?: string;
		},
	): Promise<void> {
		const providerName = options?.providerName || this.getProviderDisplayName(providerId);
		const openModelSelector = options?.openModelSelector ?? true;
		const existingCredential = this.session.modelRegistry.authStorage.get(providerId);
		if (existingCredential) {
			const overwrite = await this.showExtensionConfirm(
				`${providerName}: replace existing credentials?`,
				`Stored at ${getAuthPath()}`,
			);
			if (!overwrite) {
				this.showStatus(`${providerName} login cancelled.`);
				return;
			}
		}

		const promptLines = [`${providerName} API key`];
		if (options?.createKeyUrl) {
			promptLines.push(`Create key: ${options.createKeyUrl}`);
		}
		const keyInput = await this.showExtensionInput(promptLines.join("\n"), options?.placeholder ?? "api-key");
		if (keyInput === undefined) {
			this.showStatus(`${providerName} login cancelled.`);
			return;
		}

		const apiKey = keyInput.trim();
		if (!apiKey) {
			this.showWarning(`${providerName} API key cannot be empty.`);
			return;
		}

		this.session.modelRegistry.authStorage.set(providerId, { type: "api_key", key: apiKey });
		let hasProviderModels = this.hasRegisteredProviderModels(providerId);
		if (!hasProviderModels) {
			hasProviderModels = await this.hydrateProviderModelsFromModelsDev(providerId);
		}
		await this.updateAvailableProviderCount();
		this.showStatus(`${providerName} API key saved to ${getAuthPath()}`);
		if (openModelSelector && hasProviderModels) {
			await this.showModelProviderSelector(providerId);
		} else if (openModelSelector) {
			this.showWarning(
				`${providerName} configured, but no models are available yet. Run /model after network is available.`,
			);
		}
	}

	private async handleOpenRouterApiKeyLogin(options?: { openModelSelector?: boolean }): Promise<void> {
		await this.handleApiKeyLogin(OPENROUTER_PROVIDER_ID, {
			providerName: "OpenRouter",
			openModelSelector: options?.openModelSelector,
			createKeyUrl: "https://openrouter.ai/keys",
			placeholder: "sk-or-v1-...",
		});
	}

	private async showLoginDialog(providerId: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		const providerName = this.getProviderDisplayName(providerId);

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
			// Completion handled below
		});

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					} else if (providerId === "github-copilot") {
						// GitHub Copilot polls after onAuth
						dialog.showWaiting("Waiting for browser authentication...");
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			await this.updateAvailableProviderCount();
			this.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
			await this.showModelProviderSelector(providerId);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private parseSlashArgs(input: string): string[] {
		const args: string[] = [];
		let current = "";
		let quote: '"' | "'" | undefined;
		let escape = false;

		for (const ch of input.trim()) {
			if (escape) {
				current += ch;
				escape = false;
				continue;
			}
			if (ch === "\\") {
				escape = true;
				continue;
			}
			if (quote) {
				if (ch === quote) {
					quote = undefined;
				} else {
					current += ch;
				}
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (/\s/.test(ch)) {
				if (current) {
					args.push(current);
					current = "";
				}
				continue;
			}
			current += ch;
		}

		if (escape) {
			current += "\\";
		}
		if (current) {
			args.push(current);
		}

		return args;
	}

	private parseMemoryScopeOptions(args: string[]): { scope: MemoryScope; rest: string[]; error?: string } {
		let scope: MemoryScope = "project";
		const rest: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const token = args[index] ?? "";
			const normalized = token.toLowerCase();

			if (normalized === "--project") {
				scope = "project";
				continue;
			}
			if (normalized === "--user") {
				scope = "user";
				continue;
			}
			if (normalized === "--scope") {
				const value = (args[index + 1] ?? "").toLowerCase();
				if (!value) {
					return { scope, rest, error: "Usage: /memory ... --scope <project|user>" };
				}
				if (value !== "project" && value !== "user") {
					return { scope, rest, error: `Invalid memory scope "${value}". Use project or user.` };
				}
				scope = value;
				index += 1;
				continue;
			}

			rest.push(token);
		}

		return { scope, rest };
	}

	private resolveMemoryPath(scope: MemoryScope): string {
		return getMemoryFilePath(scope, this.sessionManager.getCwd(), getAgentDir());
	}

	private formatMemoryEntriesReport(
		scope: MemoryScope,
		filePath: string,
		entries: Array<{ text: string; timestamp?: string }>,
		fileExists: boolean,
		hasManagedBlock: boolean,
	): string {
		const lines = [`Scope: ${scope}`, `File: ${filePath}`, ""];
		if (entries.length === 0) {
			if (!fileExists) {
				lines.push("Memory file does not exist yet.");
			} else if (!hasManagedBlock) {
				lines.push("Managed memory block not found in file.");
			} else {
				lines.push("No memory entries yet.");
			}
		} else {
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index]!;
				const prefix = entry.timestamp ? `[${entry.timestamp}] ` : "";
				lines.push(`${index + 1}. ${prefix}${entry.text}`);
			}
		}
		lines.push("");
		lines.push("Usage:");
		lines.push("  /memory                # interactive manager");
		lines.push("  /memory <text>");
		lines.push("  /memory add <text> [--scope project|user]");
		lines.push("  /memory edit <index> <text> [--scope project|user]");
		lines.push("  /memory list [--scope project|user]");
		lines.push("  /memory rm <index> [--scope project|user]");
		lines.push("  /memory path [--scope project|user]");
		return lines.join("\n");
	}

	private formatMemoryEntryOption(index: number, entry: { text: string; timestamp?: string }): string {
		const timestamp = entry.timestamp ? `[${entry.timestamp}] ` : "";
		const preview = entry.text.length > 90 ? `${entry.text.slice(0, 87)}...` : entry.text;
		return `${index}. ${timestamp}${preview}`;
	}

	private async selectMemoryEntry(
		scope: MemoryScope,
		action: string,
		entries: Array<{ text: string; timestamp?: string }>,
	): Promise<{ index: number; entry: { text: string; timestamp?: string } } | undefined> {
		if (entries.length === 0) {
			this.showStatus(`No memory entries in ${scope} scope.`);
			return undefined;
		}
		const options = entries.map((entry, index) => this.formatMemoryEntryOption(index + 1, entry));
		const picked = await this.showExtensionSelector(`/memory: ${action} (${scope})`, options);
		if (!picked) {
			return undefined;
		}
		const selectedIndex = options.indexOf(picked);
		if (selectedIndex < 0) {
			return undefined;
		}
		const entry = entries[selectedIndex];
		if (!entry) return undefined;
		return { index: selectedIndex + 1, entry };
	}

	private async reloadAfterMemoryMutation(successMessage: string, reloadFailurePrefix: string): Promise<void> {
		try {
			await this.session.reload();
			this.showStatus(successMessage);
		} catch (reloadError) {
			const message = reloadError instanceof Error ? reloadError.message : String(reloadError);
			this.showWarning(`${reloadFailurePrefix}: ${message}`);
		}
		this.refreshBuiltInHeader();
	}

	private async addMemoryViaCommand(scope: MemoryScope, memoryPath: string, rawText: string): Promise<void> {
		const saved = addMemoryEntry(memoryPath, rawText);
		const preview = saved.entry.text.length > 80 ? `${saved.entry.text.slice(0, 77)}...` : saved.entry.text;
		await this.reloadAfterMemoryMutation(
			`Memory saved (${scope}) #${saved.count}: ${preview}`,
			"Memory saved but context reload failed",
		);
	}

	private async updateMemoryViaCommand(
		scope: MemoryScope,
		memoryPath: string,
		index: number,
		rawText: string,
	): Promise<void> {
		const updated = updateMemoryEntry(memoryPath, index, rawText);
		const preview = updated.entry.text.length > 80 ? `${updated.entry.text.slice(0, 77)}...` : updated.entry.text;
		await this.reloadAfterMemoryMutation(
			`Updated memory #${index} (${scope}): ${preview}`,
			"Memory updated but context reload failed",
		);
	}

	private async removeMemoryViaCommand(scope: MemoryScope, memoryPath: string, index: number): Promise<void> {
		const removed = removeMemoryEntry(memoryPath, index);
		await this.reloadAfterMemoryMutation(
			`Removed memory #${index} (${scope}). Remaining: ${removed.count}`,
			"Memory removed but context reload failed",
		);
	}

	private async runMemoryInteractiveMenu(initialScope: MemoryScope): Promise<void> {
		let scope: MemoryScope = initialScope;

		while (true) {
			const memoryPath = this.resolveMemoryPath(scope);
			let summary;
			try {
				summary = readMemoryEntries(memoryPath);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
				return;
			}
			const fileExists = fs.existsSync(memoryPath);
			const entries = summary.entries;

			const optionAdd = "Add entry";
			const optionEdit = entries.length > 0 ? "Edit entry" : "Edit entry (no entries)";
			const optionRemove = entries.length > 0 ? "Remove entry" : "Remove entry (no entries)";
			const optionShow = "Show entries";
			const optionPath = "Show file path";
			const optionSwitchScope = `Switch scope (${scope === "project" ? "to user" : "to project"})`;
			const optionClose = "Close";
			const options = [optionAdd, optionEdit, optionRemove, optionShow, optionPath, optionSwitchScope, optionClose];

			const selected = await this.showExtensionSelector(
				`/memory manager (${scope})\n${memoryPath}\nentries: ${entries.length}${fileExists ? "" : " (file missing)"}`,
				options,
			);
			if (!selected || selected === optionClose) {
				return;
			}

			if (selected === optionAdd) {
				const rawText = await this.showExtensionInput(`/memory add (${scope})`, "project starts via PM2");
				if (rawText === undefined) continue;
				if (!rawText.trim()) {
					this.showWarning("Memory text cannot be empty.");
					continue;
				}
				try {
					await this.addMemoryViaCommand(scope, memoryPath, rawText);
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			if (selected === optionEdit) {
				const chosen = await this.selectMemoryEntry(scope, "edit", entries);
				if (!chosen) continue;
				const edited = await this.showExtensionEditor(
					`Edit memory #${chosen.index} (${scope})`,
					chosen.entry.text,
				);
				if (edited === undefined) continue;
				if (!edited.trim()) {
					this.showWarning("Memory text cannot be empty.");
					continue;
				}
				try {
					await this.updateMemoryViaCommand(scope, memoryPath, chosen.index, edited);
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			if (selected === optionRemove) {
				const chosen = await this.selectMemoryEntry(scope, "remove", entries);
				if (!chosen) continue;
				const confirmed = await this.showExtensionConfirm(
					"Remove memory entry?",
					`${this.formatMemoryEntryOption(chosen.index, chosen.entry)}\n${memoryPath}`,
				);
				if (!confirmed) {
					this.showStatus("Memory remove cancelled.");
					continue;
				}
				try {
					await this.removeMemoryViaCommand(scope, memoryPath, chosen.index);
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			if (selected === optionShow) {
				this.showCommandTextBlock(
					"Memory",
					this.formatMemoryEntriesReport(scope, memoryPath, entries, fileExists, summary.hasManagedBlock),
				);
				continue;
			}

			if (selected === optionPath) {
				this.showCommandTextBlock("Memory Path", `Scope: ${scope}\nFile: ${memoryPath}`);
				continue;
			}

			if (selected === optionSwitchScope) {
				scope = scope === "project" ? "user" : "project";
				this.showStatus(`Memory manager switched to ${scope} scope.`);
				continue;
			}
		}
	}

	private async handleMemoryCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const parsedScope = this.parseMemoryScopeOptions(args);
		if (parsedScope.error) {
			this.showWarning(parsedScope.error);
			return;
		}

		const { scope, rest } = parsedScope;
		const subcommand = rest[0]?.toLowerCase();

		if (!subcommand || subcommand === "ui") {
			await this.runMemoryInteractiveMenu(scope);
			return;
		}

		const memoryPath = this.resolveMemoryPath(scope);

		if (subcommand === "list" || subcommand === "ls") {
			try {
				const summary = readMemoryEntries(memoryPath);
				const fileExists = fs.existsSync(memoryPath);
				this.showCommandTextBlock(
					"Memory",
					this.formatMemoryEntriesReport(scope, memoryPath, summary.entries, fileExists, summary.hasManagedBlock),
				);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Memory Help",
				[
					"Usage:",
					"  /memory [--scope project|user]",
					"  /memory ui [--scope project|user]",
					"  /memory <text> [--scope project|user]",
					"  /memory add <text> [--scope project|user]",
					"  /memory edit <index> <text> [--scope project|user]",
					"  /memory list [--scope project|user]",
					"  /memory rm <index> [--scope project|user]",
					"  /memory path [--scope project|user]",
					"",
					"Examples:",
					"  /memory",
					"  /memory project starts via PM2",
					"  /memory add deploy via npm run deploy --scope project",
					"  /memory edit 1 deploy via pnpm run deploy",
					"  /memory rm 2",
					"  /memory list --scope user",
				].join("\n"),
			);
			return;
		}

		if (subcommand === "path") {
			const lines = [`Scope: ${scope}`, `File: ${memoryPath}`];
			this.showCommandTextBlock("Memory Path", lines.join("\n"));
			return;
		}

		if (subcommand === "edit" || subcommand === "update") {
			const rawIndex = (rest[1] ?? "").trim();
			if (!rawIndex) {
				this.showWarning("Usage: /memory edit <index> <text> [--scope project|user]");
				return;
			}
			const index = Number.parseInt(rawIndex, 10);
			if (!Number.isFinite(index) || `${index}` !== rawIndex || index < 1) {
				this.showWarning(`Invalid memory index "${rawIndex}". Use a positive integer.`);
				return;
			}

			let rawText = rest.slice(2).join(" ").trim();
			if (!rawText) {
				try {
					const summary = readMemoryEntries(memoryPath);
					const target = summary.entries[index - 1];
					if (!target) {
						this.showWarning(`Memory entry #${index} not found.`);
						return;
					}
					const edited = await this.showExtensionEditor(`Edit memory #${index} (${scope})`, target.text);
					if (edited === undefined) {
						this.showStatus("Memory edit cancelled.");
						return;
					}
					rawText = edited;
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
					return;
				}
			}

			try {
				await this.updateMemoryViaCommand(scope, memoryPath, index, rawText);
			} catch (error) {
				this.showWarning(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		if (subcommand === "rm" || subcommand === "remove" || subcommand === "delete") {
			const rawIndex = (rest[1] ?? "").trim();
			if (!rawIndex) {
				this.showWarning("Usage: /memory rm <index> [--scope project|user]");
				return;
			}
			const index = Number.parseInt(rawIndex, 10);
			if (!Number.isFinite(index) || `${index}` !== rawIndex || index < 1) {
				this.showWarning(`Invalid memory index "${rawIndex}". Use a positive integer.`);
				return;
			}
			try {
				await this.removeMemoryViaCommand(scope, memoryPath, index);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.showWarning(message);
			}
			return;
		}

		const rawText = subcommand === "add" ? rest.slice(1).join(" ").trim() : rest.join(" ").trim();
		if (!rawText) {
			this.showWarning("Usage: /memory <text> [--scope project|user]");
			return;
		}

		try {
			await this.addMemoryViaCommand(scope, memoryPath, rawText);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private createSemanticRuntime(): SemanticSearchRuntime {
		return new SemanticSearchRuntime({
			cwd: this.sessionManager.getCwd(),
			agentDir: getAgentDir(),
			authStorage: this.session.modelRegistry.authStorage,
		});
	}

	private parseSemanticScopeOptions(
		args: string[],
		usage: string = "Usage: /semantic setup --scope <user|project>",
	): {
		scope: SemanticScope | undefined;
		rest: string[];
		error?: string;
	} {
		let scope: SemanticScope | undefined;
		const rest: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const token = args[index] ?? "";
			const normalized = token.toLowerCase();

			if (normalized === "--scope") {
				const value = (args[index + 1] ?? "").toLowerCase();
				if (!value) {
					return { scope, rest, error: usage };
				}
				if (value !== "user" && value !== "project") {
					return { scope, rest, error: `Invalid semantic scope "${value}". Use user or project.` };
				}
				scope = value;
				index += 1;
				continue;
			}

			rest.push(token);
		}

		return { scope, rest };
	}

	private parseSemanticTopKOptions(args: string[]): {
		topK?: number;
		rest: string[];
		error?: string;
	} {
		let topK: number | undefined;
		const rest: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const token = args[index] ?? "";
			const normalized = token.toLowerCase();
			if (normalized === "--top-k" || normalized === "--topk") {
				const raw = (args[index + 1] ?? "").trim();
				if (!raw) {
					return { topK, rest, error: "Usage: /semantic query <text> [--top-k 1..20]" };
				}
				const parsed = Number.parseInt(raw, 10);
				if (!Number.isFinite(parsed) || `${parsed}` !== raw || parsed < 1 || parsed > 20) {
					return { topK, rest, error: "--top-k must be an integer between 1 and 20." };
				}
				topK = parsed;
				index += 1;
				continue;
			}
			rest.push(token);
		}

		return { topK, rest };
	}

	private formatSemanticStatusReport(status: SemanticStatusResult): string {
		const lines = [
			`configured: ${status.configured ? "yes" : "no"}`,
			`enabled: ${status.enabled ? "yes" : "no"}`,
			`auto_index: ${status.autoIndex ? "on" : "off"}`,
			`indexed: ${status.indexed ? "yes" : "no"}`,
			`stale: ${status.stale ? `yes${status.staleReason ? ` (${status.staleReason})` : ""}` : "no"}`,
		];
		if (status.provider) lines.push(`provider: ${status.provider}`);
		if (status.model) lines.push(`model: ${status.model}`);
		lines.push(`files: ${status.files}`);
		lines.push(`chunks: ${status.chunks}`);
		if (status.dimension !== undefined) lines.push(`dimension: ${status.dimension}`);
		if (status.ageSeconds !== undefined) lines.push(`age_seconds: ${status.ageSeconds}`);
		lines.push(`index_path: ${status.indexPath}`);
		lines.push(`config_user: ${status.configPathUser}`);
		lines.push(`config_project: ${status.configPathProject}`);
		if (!status.configured) {
			lines.push("hint: run /semantic setup");
		}
		return lines.join("\n");
	}

	private formatSemanticIndexReport(result: SemanticIndexOperationResult): string {
		return [
			`action: ${result.action}`,
			`processed_files: ${result.processedFiles}`,
			`reused_files: ${result.reusedFiles}`,
			`new_files: ${result.newFiles}`,
			`changed_files: ${result.changedFiles}`,
			`removed_files: ${result.removedFiles}`,
			`chunks: ${result.chunks}`,
			`dimension: ${result.dimension}`,
			`duration_ms: ${result.durationMs}`,
			`built_at: ${result.builtAt}`,
			`index_path: ${result.indexPath}`,
		].join("\n");
	}

	private formatSemanticQueryReport(result: SemanticQueryResult): string {
		const lines = [
			`query: ${result.query}`,
			`top_k: ${result.topK}`,
			`auto_refreshed: ${result.autoRefreshed ? "yes" : "no"}`,
		];

		if (result.hits.length === 0) {
			lines.push("hits: none");
			return lines.join("\n");
		}

		lines.push("hits:");
		for (let index = 0; index < result.hits.length; index++) {
			const hit = result.hits[index]!;
			lines.push(
				`${index + 1}. score=${hit.score.toFixed(4)} ${hit.path}:${hit.lineStart}-${hit.lineEnd}`,
			);
			lines.push(`   ${hit.snippet}`);
		}
		return lines.join("\n");
	}

	private getSemanticSetupProviderLabel(type: SemanticProviderType): string {
		if (type === "openrouter") return "openrouter";
		if (type === "ollama") return "ollama";
		return "custom_openai";
	}

	private async ensureOpenRouterSemanticCredentials(): Promise<void> {
		const existing = await this.session.modelRegistry.authStorage.getApiKey(OPENROUTER_PROVIDER_ID);
		if (existing) return;

		const shouldLogin = await this.showExtensionConfirm(
			"Semantic setup: OpenRouter key missing",
			"No OpenRouter API key found. Open login flow now?",
		);
		if (!shouldLogin) {
			this.showWarning("OpenRouter key is missing. semantic index/query will fail until credentials are added.");
			return;
		}

		await this.handleOpenRouterApiKeyLogin({ openModelSelector: false });
		const afterLogin = await this.session.modelRegistry.authStorage.getApiKey(OPENROUTER_PROVIDER_ID);
		if (!afterLogin) {
			this.showWarning("OpenRouter key is still missing. You can run /login later.");
		}
	}

	private async selectSemanticModelFromCatalog(
		title: string,
		catalogModels: string[],
		currentModel: string,
		options?: { highlightLikelyEmbedding?: boolean },
	): Promise<string | undefined> {
		const normalizedCurrent = currentModel.trim();
		const uniqueModels: string[] = [];
		const seen = new Set<string>();
		for (const model of catalogModels) {
			const normalized = model.trim();
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			uniqueModels.push(normalized);
		}

		const optionToModel = new Map<string, string>();
		const selectorOptions: string[] = [];
		const addOption = (label: string, modelId: string): void => {
			let uniqueLabel = label;
			let suffix = 2;
			while (optionToModel.has(uniqueLabel)) {
				uniqueLabel = `${label} (${suffix})`;
				suffix += 1;
			}
			optionToModel.set(uniqueLabel, modelId);
			selectorOptions.push(uniqueLabel);
		};

		if (normalizedCurrent) {
			addOption(`Current: ${normalizedCurrent}`, normalizedCurrent);
		}

		for (const modelId of uniqueModels) {
			const marker =
				options?.highlightLikelyEmbedding && isLikelyEmbeddingModelId(modelId) ? " [embedding]" : "";
			addOption(`${modelId}${marker}`, modelId);
		}

		const manualOption = "Enter model manually";
		selectorOptions.push(manualOption);

		const selected = await this.showExtensionSelector(title, selectorOptions);
		if (!selected) return undefined;

		if (selected === manualOption) {
			const modelInput = await this.showExtensionInput(`${title}: model`, normalizedCurrent || "model-id");
			if (modelInput === undefined) return undefined;
			const model = modelInput.trim();
			if (!model) {
				this.showWarning("Model cannot be empty.");
				return undefined;
			}
			return model;
		}

		return optionToModel.get(selected);
	}

	private async runSemanticSetupWizard(initialScope?: SemanticScope): Promise<void> {
		const cwd = this.sessionManager.getCwd();
		const agentDir = getAgentDir();
		const merged = loadMergedSemanticConfig(cwd, agentDir);
		const config: SemanticSearchConfig = merged.config ?? getDefaultSemanticSearchConfig();

		let scope = initialScope;
		if (!scope) {
			const pickedScope = await this.showExtensionSelector("/semantic setup: scope", [
				"user (Recommended)",
				"project",
			]);
			if (!pickedScope) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			scope = pickedScope.startsWith("project") ? "project" : "user";
		}

		const providerOption = await this.showExtensionSelector("/semantic setup: provider", [
			"openrouter (Recommended)",
			"ollama",
			"custom_openai",
		]);
		if (!providerOption) {
			this.showStatus("Semantic setup cancelled");
			return;
		}

		const providerType: SemanticProviderType = providerOption.startsWith("ollama")
			? "ollama"
			: providerOption.startsWith("custom_openai")
				? "custom_openai"
				: "openrouter";

		const providerDefaults: Record<SemanticProviderType, string> = {
			openrouter: "openai/text-embedding-3-small",
			ollama: "nomic-embed-text",
			custom_openai: "text-embedding-3-small",
		};

		const currentModel = (
			config.provider.type === providerType ? config.provider.model : providerDefaults[providerType]
		).trim();
		let model = currentModel;

		const nextProvider: SemanticProviderConfig = {
			...config.provider,
			type: providerType,
			model: model || providerDefaults[providerType],
		};

		if (providerType === "ollama") {
			const defaultBase =
				(config.provider.type === "ollama" ? config.provider.baseUrl : undefined) ?? "http://127.0.0.1:11434";
			const baseUrlInput = await this.showExtensionInput("/semantic setup: ollama base URL", defaultBase);
			if (baseUrlInput === undefined) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			const baseUrl = baseUrlInput.trim();
			nextProvider.baseUrl = baseUrl || undefined;
			nextProvider.apiKeyEnv = undefined;

			let ollamaModels: string[] = [];
			try {
				ollamaModels = await listOllamaLocalModels({
					baseUrl: nextProvider.baseUrl,
					headers: config.provider.type === "ollama" ? config.provider.headers : undefined,
					timeoutMs: nextProvider.timeoutMs,
				});
				if (ollamaModels.length === 0) {
					this.showWarning("No local Ollama models found at /api/tags. You can enter model manually.");
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.showWarning(`Failed to load Ollama models automatically: ${errorMsg}`);
			}

			const selectedModel = await this.selectSemanticModelFromCatalog(
				"/semantic setup: ollama model",
				ollamaModels,
				currentModel || providerDefaults.ollama,
				{ highlightLikelyEmbedding: true },
			);
			if (!selectedModel) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			model = selectedModel;
		} else if (providerType === "custom_openai") {
			const defaultBase =
				(config.provider.type === "custom_openai" ? config.provider.baseUrl : undefined) ?? "http://127.0.0.1:8000/v1";
			const baseUrlInput = await this.showExtensionInput("/semantic setup: custom base URL", defaultBase);
			if (baseUrlInput === undefined) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			const baseUrl = baseUrlInput.trim();
			if (!baseUrl) {
				this.showWarning("Custom provider base URL cannot be empty.");
				return;
			}
			nextProvider.baseUrl = baseUrl;

			const defaultApiKeyEnv =
				(config.provider.type === "custom_openai" ? config.provider.apiKeyEnv : undefined) ?? "OPENAI_API_KEY";
			const apiKeyEnvInput = await this.showExtensionInput(
				"/semantic setup: custom API key env (optional)",
				defaultApiKeyEnv,
			);
			if (apiKeyEnvInput === undefined) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			nextProvider.apiKeyEnv = apiKeyEnvInput.trim() || undefined;

			const modelInput = await this.showExtensionInput("/semantic setup: custom model", currentModel);
			if (modelInput === undefined) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			const normalizedModel = modelInput.trim();
			if (!normalizedModel) {
				this.showWarning("Model cannot be empty.");
				return;
			}
			model = normalizedModel;
		} else {
			nextProvider.baseUrl = undefined;
			nextProvider.apiKeyEnv = undefined;

			let openRouterModels: string[] = [];
			try {
				openRouterModels = await listOpenRouterEmbeddingModels({
					timeoutMs: nextProvider.timeoutMs,
					authStorage: this.session.modelRegistry.authStorage,
				});
				if (openRouterModels.length === 0) {
					this.showWarning("OpenRouter embeddings catalog is empty. You can enter model manually.");
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				this.showWarning(`Failed to load OpenRouter embedding models automatically: ${errorMsg}`);
			}

			const selectedModel = await this.selectSemanticModelFromCatalog(
				"/semantic setup: openrouter model",
				openRouterModels,
				currentModel || providerDefaults.openrouter,
			);
			if (!selectedModel) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			model = selectedModel;
		}

		nextProvider.model = model;

		while (true) {
			const headersInput = await this.showExtensionInput(
				"/semantic setup: headers (optional KEY=VALUE,CSV; press Enter to skip)",
				"",
			);
			if (headersInput === undefined) {
				this.showStatus("Semantic setup cancelled");
				return;
			}
			const parsedHeaders = this.parseMcpKeyValueMapInput(headersInput);
			if (parsedHeaders.error) {
				this.showWarning(parsedHeaders.error);
				continue;
			}
			nextProvider.headers = parsedHeaders.value;
			break;
		}

		const nextConfig: SemanticSearchConfig = {
			...config,
			enabled: true,
			provider: nextProvider,
		};

		const savedPath = upsertScopedSemanticSearchConfig(scope, nextConfig, cwd, agentDir);
		if (providerType === "openrouter") {
			await this.ensureOpenRouterSemanticCredentials();
		}

		this.showStatus(`Semantic setup saved (${scope})`);
		this.showCommandTextBlock(
			"Semantic Setup",
			[
				`scope: ${scope}`,
				`provider: ${this.getSemanticSetupProviderLabel(providerType)}`,
				`model: ${nextProvider.model}`,
				`auto_index: ${nextConfig.autoIndex ? "on" : "off"}`,
				`config: ${savedPath}`,
				`index_dir: ${getSemanticIndexDir(cwd, agentDir)}`,
			].join("\n"),
		);
	}

	private resolveSemanticAutoIndexWriteScope(cwd: string, agentDir: string): SemanticScope {
		const project = readScopedSemanticConfig("project", cwd, agentDir);
		if (!project.error && project.file.semanticSearch) {
			return "project";
		}
		return "user";
	}

	private async updateSemanticAutoIndexSetting(options?: {
		scope?: SemanticScope;
		value?: boolean;
	}): Promise<void> {
		const cwd = this.sessionManager.getCwd();
		const agentDir = getAgentDir();
		const merged = loadMergedSemanticConfig(cwd, agentDir);
		if (!merged.config) {
			this.showWarning("Semantic search is not configured. Run /semantic setup first.");
			return;
		}

		const scope = options?.scope ?? this.resolveSemanticAutoIndexWriteScope(cwd, agentDir);
		const value = options?.value ?? !merged.config.autoIndex;

		const nextConfig: SemanticSearchConfig = {
			...merged.config,
			autoIndex: value,
		};
		const savedPath = upsertScopedSemanticSearchConfig(scope, nextConfig, cwd, agentDir);
		const effective = await this.createSemanticRuntime().status().catch(() => undefined);
		this.showStatus(`Semantic auto-index ${value ? "enabled" : "disabled"} (${scope}).`);
		this.showCommandTextBlock(
			"Semantic Auto-Index",
			[
				`scope: ${scope}`,
				`saved: ${value ? "on" : "off"}`,
				`effective: ${effective ? (effective.autoIndex ? "on" : "off") : "unknown"}`,
				`config: ${savedPath}`,
			].join("\n"),
		);
	}

	private async runSemanticInteractiveMenu(): Promise<void> {
		while (true) {
			let status: SemanticStatusResult | undefined;
			try {
				status = await this.createSemanticRuntime().status();
			} catch (error) {
				this.reportSemanticError(error, "status");
			}

			const summary = status
				? `configured=${status.configured ? "yes" : "no"} auto_index=${status.autoIndex ? "on" : "off"} indexed=${status.indexed ? "yes" : "no"} stale=${status.stale ? "yes" : "no"}`
				: "status unavailable";
			const selected = await this.showExtensionSelector(`/semantic manager\n${summary}`, [
				"Configure provider/model",
				"Show status",
				"Index now",
				"Rebuild index",
				"Query index",
				`Automatic indexing: ${status?.autoIndex ? "on" : "off"}`,
				"Show config/index paths",
				"Close",
			]);
			if (!selected || selected === "Close") {
				return;
			}

			if (selected === "Configure provider/model") {
				await this.runSemanticSetupWizard();
				continue;
			}
			if (selected === "Show status") {
				try {
					const result = await this.runWithExtensionLoader("Checking semantic index status...", async () =>
						this.createSemanticRuntime().status(),
					);
					this.showCommandTextBlock("Semantic Status", this.formatSemanticStatusReport(result));
				} catch (error) {
					this.reportSemanticError(error, "status");
				}
				continue;
			}
			if (selected === "Index now") {
				try {
					const result = await this.runWithExtensionLoader("Indexing semantic embeddings...", async () =>
						this.createSemanticRuntime().index(),
					);
					this.showStatus(`Semantic index updated (${result.processedFiles} files).`);
					this.showCommandTextBlock("Semantic Index", this.formatSemanticIndexReport(result));
				} catch (error) {
					this.reportSemanticError(error, "index");
				}
				continue;
			}
			if (selected === "Rebuild index") {
				try {
					const result = await this.runWithExtensionLoader("Rebuilding semantic index...", async () =>
						this.createSemanticRuntime().rebuild(),
					);
					this.showStatus(`Semantic index rebuilt (${result.processedFiles} files).`);
					this.showCommandTextBlock("Semantic Rebuild", this.formatSemanticIndexReport(result));
				} catch (error) {
					this.reportSemanticError(error, "rebuild");
				}
				continue;
			}
			if (selected === "Query index") {
				const queryInput = await this.showExtensionInput("/semantic query", "where auth token is validated");
				if (queryInput === undefined) continue;
				const query = queryInput.trim();
				if (!query) {
					this.showWarning("Semantic query cannot be empty.");
					continue;
				}

				const topKInput = await this.showExtensionInput("/semantic query: top-k (optional, 1..20)", "8");
				if (topKInput === undefined) continue;
				const topKRaw = topKInput.trim();
				let topK: number | undefined = undefined;
				if (topKRaw) {
					const parsed = Number.parseInt(topKRaw, 10);
					if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
						this.showWarning("top-k must be an integer between 1 and 20.");
						continue;
					}
					topK = parsed;
				}

				try {
					const result = await this.runWithExtensionLoader("Querying semantic index...", async () =>
						this.createSemanticRuntime().query(query, topK),
					);
					this.showCommandTextBlock("Semantic Query", this.formatSemanticQueryReport(result));
				} catch (error) {
					this.reportSemanticError(error, "query");
				}
				continue;
			}
			if (selected.startsWith("Automatic indexing:")) {
				await this.updateSemanticAutoIndexSetting();
				continue;
			}
			if (selected === "Show config/index paths") {
				const runtime = this.createSemanticRuntime();
				const cwd = this.sessionManager.getCwd();
				const agentDir = getAgentDir();
				try {
					const semanticStatus = await this.runWithExtensionLoader("Loading semantic paths...", async () =>
						runtime.status(),
					);
					this.showCommandTextBlock(
						"Semantic Paths",
						[
							`user_config: ${getSemanticConfigPath("user", cwd, agentDir)}`,
							`project_config: ${getSemanticConfigPath("project", cwd, agentDir)}`,
							`index_dir: ${semanticStatus.indexPath}`,
						].join("\n"),
					);
				} catch (error) {
					this.reportSemanticError(error, "status");
				}
				continue;
			}
		}
	}

	private reportSemanticError(error: unknown, context: string): void {
		if (error instanceof SemanticConfigMissingError) {
			this.showWarning("Semantic search is not configured. Run /semantic setup.");
			this.showCommandTextBlock(
				"Semantic Config",
				[
					`user_config: ${error.userConfigPath}`,
					`project_config: ${error.projectConfigPath}`,
					"next: /semantic setup",
				].join("\n"),
			);
			return;
		}
		if (error instanceof SemanticIndexRequiredError) {
			this.showWarning(error.message);
			this.showWarning("Run /semantic index (or enable automatic indexing in /semantic).");
			return;
		}
		if (error instanceof SemanticRebuildRequiredError) {
			this.showWarning(error.message);
			this.showWarning("Run /semantic rebuild.");
			return;
		}
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`Semantic ${context} failed: ${message}`);
	}

	private async handleSemanticCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		if (args.length === 0 || (args[0]?.toLowerCase() ?? "") === "ui") {
			await this.runSemanticInteractiveMenu();
			return;
		}

		const subcommand = (args[0] ?? "").toLowerCase();
		const rest = args.slice(1);

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Semantic Help",
				[
					"Usage:",
					"  /semantic",
					"  /semantic ui",
					"  /semantic setup [--scope user|project]",
					"  /semantic auto-index [on|off] [--scope user|project]",
					"  /semantic status",
					"  /semantic index",
					"  /semantic rebuild",
					"  /semantic query <text> [--top-k N]",
					"  /semantic help",
				].join("\n"),
			);
			return;
		}

		if (subcommand === "setup") {
			const parsedScope = this.parseSemanticScopeOptions(rest);
			if (parsedScope.error) {
				this.showWarning(parsedScope.error);
				return;
			}
			if (parsedScope.rest.length > 0) {
				this.showWarning(`Unexpected arguments for /semantic setup: ${parsedScope.rest.join(" ")}`);
				return;
			}
			await this.runSemanticSetupWizard(parsedScope.scope);
			return;
		}

		if (subcommand === "auto-index" || subcommand === "autoindex") {
			const parsedScope = this.parseSemanticScopeOptions(
				rest,
				"Usage: /semantic auto-index [on|off] [--scope user|project]",
			);
			if (parsedScope.error) {
				this.showWarning(parsedScope.error);
				return;
			}
			let value: boolean | undefined;
			if (parsedScope.rest.length > 1) {
				this.showWarning("Usage: /semantic auto-index [on|off] [--scope user|project]");
				return;
			}
			if (parsedScope.rest.length === 1) {
				const mode = parsedScope.rest[0]?.toLowerCase();
				if (mode === "on" || mode === "enable" || mode === "enabled") value = true;
				else if (mode === "off" || mode === "disable" || mode === "disabled") value = false;
				else {
					this.showWarning(`Unknown auto-index mode "${parsedScope.rest[0]}". Use on|off.`);
					return;
				}
			}
			await this.updateSemanticAutoIndexSetting({
				scope: parsedScope.scope,
				value,
			});
			return;
		}

		if (subcommand === "status") {
			try {
				const result = await this.runWithExtensionLoader("Checking semantic index status...", async () =>
					this.createSemanticRuntime().status(),
				);
				this.showCommandTextBlock("Semantic Status", this.formatSemanticStatusReport(result));
			} catch (error) {
				this.reportSemanticError(error, "status");
			}
			return;
		}

		if (subcommand === "index") {
			try {
				const result = await this.runWithExtensionLoader("Indexing semantic embeddings...", async () =>
					this.createSemanticRuntime().index(),
				);
				this.showStatus(`Semantic index updated (${result.processedFiles} files).`);
				this.showCommandTextBlock("Semantic Index", this.formatSemanticIndexReport(result));
			} catch (error) {
				this.reportSemanticError(error, "index");
			}
			return;
		}

		if (subcommand === "rebuild") {
			try {
				const result = await this.runWithExtensionLoader("Rebuilding semantic index...", async () =>
					this.createSemanticRuntime().rebuild(),
				);
				this.showStatus(`Semantic index rebuilt (${result.processedFiles} files).`);
				this.showCommandTextBlock("Semantic Rebuild", this.formatSemanticIndexReport(result));
			} catch (error) {
				this.reportSemanticError(error, "rebuild");
			}
			return;
		}

		if (subcommand === "query") {
			const parsed = this.parseSemanticTopKOptions(rest);
			if (parsed.error) {
				this.showWarning(parsed.error);
				return;
			}
			const query = parsed.rest.join(" ").trim();
			if (!query) {
				this.showWarning("Usage: /semantic query <text> [--top-k N]");
				return;
			}

			try {
				const result = await this.runWithExtensionLoader("Querying semantic index...", async () =>
					this.createSemanticRuntime().query(query, parsed.topK),
				);
				this.showCommandTextBlock("Semantic Query", this.formatSemanticQueryReport(result));
			} catch (error) {
				this.reportSemanticError(error, "query");
			}
			return;
		}

		this.showWarning(`Unknown /semantic subcommand "${subcommand}". Use /semantic help.`);
	}

	private parseContractScopeOptions(
		args: string[],
		usage = "Usage: /contract <edit|clear> --scope <project|session>",
	): ContractScopeParseResult {
		let scope: ContractScope | undefined;
		const rest: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const token = args[index] ?? "";
			const normalized = token.toLowerCase();
			if (normalized === "--scope") {
				const value = (args[index + 1] ?? "").toLowerCase().trim();
				if (!value) {
					return { scope, rest, error: usage };
				}
				if (value !== "project" && value !== "session") {
					return { scope, rest, error: `Invalid contract scope "${value}". Use project or session.` };
				}
				scope = value;
				index += 1;
				continue;
			}
			rest.push(token);
		}

		return { scope, rest };
	}

	private cloneContract(contract: EngineeringContract): EngineeringContract {
		return normalizeEngineeringContract({
			...(contract.goal ? { goal: contract.goal } : {}),
			...(contract.scope_include ? { scope_include: [...contract.scope_include] } : {}),
			...(contract.scope_exclude ? { scope_exclude: [...contract.scope_exclude] } : {}),
			...(contract.constraints ? { constraints: [...contract.constraints] } : {}),
			...(contract.quality_gates ? { quality_gates: [...contract.quality_gates] } : {}),
			...(contract.definition_of_done ? { definition_of_done: [...contract.definition_of_done] } : {}),
			...(contract.assumptions ? { assumptions: [...contract.assumptions] } : {}),
			...(contract.non_goals ? { non_goals: [...contract.non_goals] } : {}),
			...(contract.risks ? { risks: [...contract.risks] } : {}),
			...(contract.deliverables ? { deliverables: [...contract.deliverables] } : {}),
			...(contract.success_metrics ? { success_metrics: [...contract.success_metrics] } : {}),
			...(contract.stakeholders ? { stakeholders: [...contract.stakeholders] } : {}),
			...(contract.owner ? { owner: contract.owner } : {}),
			...(contract.timebox ? { timebox: contract.timebox } : {}),
			...(contract.notes ? { notes: contract.notes } : {}),
		});
	}

	private formatContractSection(title: string, contract: EngineeringContract): string {
		const payload = Object.keys(contract).length > 0 ? contract : {};
		return `${title}:\n${JSON.stringify(payload, null, 2)}`;
	}

	private formatContractFieldPreview(field: ContractFieldDefinition, value: unknown): string {
		if (field.kind === "text") {
			if (typeof value !== "string" || value.trim().length === 0) return "(empty)";
			return value.trim();
		}
		if (!Array.isArray(value) || value.length === 0) return "(empty)";
		const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		if (values.length === 0) return "(empty)";
		const preview = values.slice(0, 2).join("; ");
		return values.length > 2 ? `${preview} (+${values.length - 2})` : preview;
	}

	private showContractState(state: ContractState): void {
		this.showCommandTextBlock(
			"Contract",
			[
				`project_path: ${state.projectPath}${state.hasProjectFile ? "" : " (missing)"}`,
				"",
				this.formatContractSection("Project", state.project),
				"",
				this.formatContractSection("Session overlay", state.sessionOverlay),
				"",
				this.formatContractSection("Effective", state.effective),
			].join("\n"),
		);
	}

	private async editContractFieldValue(
		scope: ContractScope,
		field: ContractFieldDefinition,
		draft: EngineeringContract,
	): Promise<EngineeringContract | undefined> {
		const payload = draft as Record<string, unknown>;
		const current = payload[field.key];

		if (field.kind === "text") {
			const entered = await this.showExtensionInput(
				`/contract ${scope}: ${field.key}\n${field.help}\nEnter empty value to clear.`,
				typeof current === "string" && current.trim().length > 0 ? current : field.placeholder,
			);
			if (entered === undefined) return undefined;
			const nextPayload: Record<string, unknown> = { ...payload };
			const normalized = entered.trim();
			if (normalized.length === 0) {
				delete nextPayload[field.key];
			} else {
				nextPayload[field.key] = normalized;
			}
			return normalizeEngineeringContract(nextPayload);
		}

		const prefill = Array.isArray(current)
			? current.filter((item): item is string => typeof item === "string").join("\n")
			: "";
		const edited = await this.showExtensionEditor(
			`/contract ${scope}: ${field.key}\n${field.help}\nOne item per line. Empty value clears the field.`,
			prefill,
		);
		if (edited === undefined) return undefined;
		const values = edited
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		const nextPayload: Record<string, unknown> = { ...payload };
		if (values.length === 0) {
			delete nextPayload[field.key];
		} else {
			nextPayload[field.key] = values;
		}
		return normalizeEngineeringContract(nextPayload);
	}

	private formatContractEditorSummary(scope: ContractScope, draft: EngineeringContract): string {
		const setCount = CONTRACT_FIELD_DEFINITIONS.filter((field) => {
			const value = (draft as Record<string, unknown>)[field.key];
			if (field.kind === "text") return typeof value === "string" && value.trim().length > 0;
			return Array.isArray(value) && value.length > 0;
		}).length;
		return `/contract editor (${scope})\nfilled=${setCount}/${CONTRACT_FIELD_DEFINITIONS.length}`;
	}

	private async editContractScope(scope: ContractScope): Promise<void> {
		const state = this.getContractStateSafe();
		if (!state) return;
		let draft = this.cloneContract(scope === "project" ? state.project : state.sessionOverlay);

		while (true) {
			const fieldOptions = CONTRACT_FIELD_DEFINITIONS.map((field) => {
				const value = (draft as Record<string, unknown>)[field.key];
				return {
					field,
					label: `Edit ${field.key}: ${this.formatContractFieldPreview(field, value)}`,
				};
			});
			const selected = await this.showExtensionSelector(
				`${this.formatContractEditorSummary(scope, draft)}\nHow to use: select a field and press Enter to edit. Changes are auto-saved immediately.`,
				[
					...fieldOptions.map((entry) => entry.label),
					"Open JSON preview",
					"Delete scope contract",
					"Cancel",
				],
			);
			if (!selected || selected.startsWith("Cancel")) {
				this.showStatus("Contract edit cancelled.");
				return;
			}

			if (selected.startsWith("Open JSON preview")) {
				this.showCommandTextBlock(
					`Contract Draft (${scope})`,
					JSON.stringify(Object.keys(draft).length > 0 ? draft : {}, null, 2),
				);
				continue;
			}

			if (selected.startsWith("Delete scope contract")) {
				if (scope === "project") {
					const confirm = await this.showExtensionConfirm(
						"Delete project contract?",
						`${state.projectPath}\nThis removes .iosm/contract.json`,
					);
					if (!confirm) {
						this.showStatus("Project contract delete cancelled.");
						continue;
					}
				}
				this.contractService.clear(scope);
				this.syncRuntimePromptSuffix();
				this.showStatus(`Contract cleared (${scope}).`);
				return;
			}

			const fieldEntry = fieldOptions.find((entry) => entry.label === selected);
			const field = fieldEntry?.field;
			if (!field) {
				this.showWarning("Unknown contract field selection.");
				continue;
			}
			const updated = await this.editContractFieldValue(scope, field, draft);
			if (!updated) {
				this.showStatus(`Field edit cancelled (${field.key}).`);
				continue;
			}
			draft = updated;
			try {
				this.contractService.save(scope, draft);
				this.syncRuntimePromptSuffix();
				this.showStatus(`Saved ${field.key} (${scope}).`);
			} catch (error) {
				this.showWarning(error instanceof Error ? error.message : String(error));
			}
		}
	}

	private async runContractInteractiveMenu(): Promise<void> {
		while (true) {
			const state = this.getContractStateSafe();
			if (!state) return;
			const selected = await this.showExtensionSelector(
				[
					`/contract manager`,
					`project=${state.hasProjectFile ? "yes" : "no"} session_keys=${Object.keys(state.sessionOverlay).length} effective_keys=${Object.keys(state.effective).length}`,
					`How to use: open effective to inspect merged JSON, edit session for temporary changes, edit project for persistent changes.`,
					`Field edits are auto-saved right after Enter.`,
				].join("\n"),
				[
					"Open effective contract",
					"Edit session contract",
					"Edit project contract",
					"Copy effective -> session",
					"Copy effective -> project",
					"Delete session contract",
					"Delete project contract",
					"Close",
				],
			);
			if (!selected || selected.startsWith("Close")) {
				return;
			}

			if (selected === "Open effective contract") {
				this.showContractState(state);
				continue;
			}
			if (selected === "Edit session contract") {
				await this.editContractScope("session");
				continue;
			}
			if (selected === "Edit project contract") {
				await this.editContractScope("project");
				continue;
			}
			if (selected === "Copy effective -> session") {
				try {
					this.contractService.save("session", state.effective);
					this.syncRuntimePromptSuffix();
					this.showStatus("Effective contract copied to session overlay.");
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (selected === "Copy effective -> project") {
				try {
					this.contractService.save("project", state.effective);
					this.syncRuntimePromptSuffix();
					this.showStatus("Effective contract copied to project.");
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
				continue;
			}
			if (selected === "Delete session contract") {
				this.contractService.clear("session");
				this.syncRuntimePromptSuffix();
				this.showStatus("Session contract deleted.");
				continue;
			}
			if (selected === "Delete project contract") {
				const confirm = await this.showExtensionConfirm(
					"Delete project contract?",
					`${state.projectPath}\nThis removes .iosm/contract.json`,
				);
				if (!confirm) {
					this.showStatus("Project contract delete cancelled.");
					continue;
				}
				this.contractService.clear("project");
				this.syncRuntimePromptSuffix();
				this.showStatus("Project contract deleted.");
			}
		}
	}

	private async handleContractCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		if (args.length === 0 || (args[0]?.toLowerCase() ?? "") === "ui") {
			await this.runContractInteractiveMenu();
			return;
		}

		const subcommand = (args[0] ?? "").toLowerCase();
		const rest = args.slice(1);

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Contract Help",
				[
					"Usage:",
					"  /contract",
					"  /contract ui",
					"  /contract show",
					"  /contract edit --scope <project|session>",
					"  /contract clear --scope <project|session>",
					"  /contract help",
						"",
						"Editor model:",
						"  - Fill fields interactively (goal, scope, constraints, quality gates, DoD, risks, etc.)",
						"  - Each field is saved immediately after Enter (no extra Save step)",
					].join("\n"),
				);
			return;
		}

		if (subcommand === "show" || subcommand === "status" || subcommand === "open") {
			const state = this.getContractStateSafe();
			if (!state) return;
			this.showContractState(state);
			return;
		}

		if (subcommand === "edit") {
			const parsed = this.parseContractScopeOptions(rest, "Usage: /contract edit --scope <project|session>");
			if (parsed.error) {
				this.showWarning(parsed.error);
				return;
			}
			if (parsed.rest.length > 0) {
				this.showWarning(`Unexpected arguments for /contract edit: ${parsed.rest.join(" ")}`);
				return;
			}
			await this.editContractScope(parsed.scope ?? "session");
			return;
		}

		if (subcommand === "clear" || subcommand === "rm" || subcommand === "remove" || subcommand === "delete") {
			const parsed = this.parseContractScopeOptions(rest, "Usage: /contract clear --scope <project|session>");
			if (parsed.error) {
				this.showWarning(parsed.error);
				return;
			}
			if (!parsed.scope) {
				this.showWarning("Usage: /contract clear --scope <project|session>");
				return;
			}
			if (parsed.rest.length > 0) {
				this.showWarning(`Unexpected arguments for /contract clear: ${parsed.rest.join(" ")}`);
				return;
			}
			this.contractService.clear(parsed.scope);
			this.syncRuntimePromptSuffix();
			this.showStatus(`Contract cleared (${parsed.scope}).`);
			return;
		}

		this.showWarning(`Unknown /contract subcommand "${subcommand}". Use /contract help.`);
	}

	private normalizeSingularComplexity(value: unknown, fallback: SingularComplexity): SingularComplexity {
		const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
		if (normalized === "low" || normalized === "medium" || normalized === "high") {
			return normalized;
		}
		return fallback;
	}

	private normalizeSingularBlastRadius(value: unknown, fallback: SingularBlastRadius): SingularBlastRadius {
		const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
		if (normalized === "low" || normalized === "medium" || normalized === "high") {
			return normalized;
		}
		return fallback;
	}

	private normalizeSingularRecommendation(value: unknown, fallback: SingularRecommendation): SingularRecommendation {
		const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
		if (normalized === "implement_now" || normalized === "implement_incrementally" || normalized === "defer") {
			return normalized;
		}
		return fallback;
	}

	private normalizeSingularStageFit(value: unknown): SingularStageFit | undefined {
		const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
		if (normalized === "needed_now" || normalized === "optional_now" || normalized === "later") {
			return normalized;
		}
		if (normalized === "now") return "needed_now";
		if (normalized === "optional") return "optional_now";
		return undefined;
	}

	private toTrimmedString(value: unknown, maxLength: number, fallback?: string): string | undefined {
		if (typeof value !== "string") return fallback;
		const compact = value.replace(/\s+/g, " ").trim();
		if (!compact) return fallback;
		if (compact.length <= maxLength) return compact;
		return compact.slice(0, maxLength).trim();
	}

	private toTrimmedStringList(value: unknown, maxItems: number, maxLength = 220): string[] {
		if (!Array.isArray(value)) return [];
		const lines: string[] = [];
		for (const item of value) {
			const normalized = this.toTrimmedString(item, maxLength);
			if (!normalized) continue;
			lines.push(normalized);
			if (lines.length >= maxItems) break;
		}
		return lines;
	}

	private normalizeSingularImpactAnalysis(
		value: unknown,
		fallback?: SingularImpactAnalysis,
	): SingularImpactAnalysis | undefined {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return fallback;
		}
		const payload = value as Record<string, unknown>;
		const codebase = this.toTrimmedString(payload.codebase, 260, fallback?.codebase ?? "Unknown.");
		const delivery = this.toTrimmedString(payload.delivery, 260, fallback?.delivery ?? "Unknown.");
		const risks = this.toTrimmedString(payload.risks, 260, fallback?.risks ?? "Unknown.");
		const operations = this.toTrimmedString(payload.operations, 260, fallback?.operations ?? "Unknown.");
		if (!codebase || !delivery || !risks || !operations) return fallback;
		return {
			codebase,
			delivery,
			risks,
			operations,
		};
	}

	private buildSingularContractPromptSection(contract: EngineeringContract): string {
		const lines: string[] = [];
		if (contract.goal) lines.push(`- goal: ${contract.goal}`);
		if ((contract.scope_include ?? []).length > 0) {
			lines.push(`- scope_include: ${(contract.scope_include ?? []).slice(0, 8).join("; ")}`);
		}
		if ((contract.scope_exclude ?? []).length > 0) {
			lines.push(`- scope_exclude: ${(contract.scope_exclude ?? []).slice(0, 8).join("; ")}`);
		}
		if ((contract.constraints ?? []).length > 0) {
			lines.push(`- constraints: ${(contract.constraints ?? []).slice(0, 10).join("; ")}`);
		}
		if ((contract.quality_gates ?? []).length > 0) {
			lines.push(`- quality_gates: ${(contract.quality_gates ?? []).slice(0, 10).join("; ")}`);
		}
		if ((contract.definition_of_done ?? []).length > 0) {
			lines.push(`- definition_of_done: ${(contract.definition_of_done ?? []).slice(0, 10).join("; ")}`);
		}
		if ((contract.non_goals ?? []).length > 0) {
			lines.push(`- non_goals: ${(contract.non_goals ?? []).slice(0, 8).join("; ")}`);
		}
		return lines.length > 0 ? lines.join("\n") : "- none";
	}

	private resolveSingularRepoScaleMode(
		baseline: SingularAnalysisResult,
	): { mode: "small" | "medium" | "large"; reason: string } {
		if (baseline.scannedFiles >= 8000 || baseline.sourceFiles >= 4000) {
			return {
				mode: "large",
				reason: `scanned=${baseline.scannedFiles}, source=${baseline.sourceFiles}`,
			};
		}
		if (baseline.scannedFiles >= 2500 || baseline.sourceFiles >= 1200) {
			return {
				mode: "medium",
				reason: `scanned=${baseline.scannedFiles}, source=${baseline.sourceFiles}`,
			};
		}
		return {
			mode: "small",
			reason: `scanned=${baseline.scannedFiles}, source=${baseline.sourceFiles}`,
		};
	}

	private buildSingularSemanticGuidanceFromStatus(status: SemanticStatusResult): {
		statusLine: string;
		promptGuidance: string[];
		operatorHint?: string;
	} {
		if (!status.configured) {
			return {
				statusLine: "not_configured",
				promptGuidance: [
					"Semantic index is unavailable; use narrow path-based discovery and avoid wide repo scans.",
					"If confidence is low, explicitly ask user to run /semantic setup and /semantic index, then rerun /singular.",
				],
				operatorHint: "Large/medium repo mode: semantic index is not configured. Run /semantic setup, then /semantic index.",
			};
		}
		if (!status.enabled) {
			return {
				statusLine: "configured_but_disabled",
				promptGuidance: [
					"Semantic index is configured but disabled; proceed with targeted rg/read steps only.",
					"If discovery quality is insufficient, ask user to enable semantic search in /semantic setup.",
				],
				operatorHint: "Large/medium repo mode: semantic index is disabled. Enable it in /semantic setup for faster planning.",
			};
		}
		if (!status.indexed) {
			return {
				statusLine: "configured_not_indexed",
				promptGuidance: [
					"Semantic index is configured but missing; do focused discovery and avoid broad scans.",
					"If context coverage is insufficient, ask user to run /semantic index before final recommendation.",
				],
				operatorHint: "Large/medium repo mode: semantic index is missing. Run /semantic index.",
			};
		}
		if (status.stale) {
			const requiresRebuild =
				status.staleReason === "provider_changed" ||
				status.staleReason === "chunking_changed" ||
				status.staleReason === "index_filters_changed" ||
				status.staleReason === "dimension_mismatch";
			return {
				statusLine: `stale${status.staleReason ? ` (${status.staleReason})` : ""}`,
				promptGuidance: [
					"Semantic index is stale; treat semantic hits as hints and verify with direct file reads.",
					"If index staleness blocks confidence, ask user to run /semantic rebuild or /semantic index.",
				],
				operatorHint: requiresRebuild
					? "Large/medium repo mode: semantic index is stale and requires /semantic rebuild."
					: "Large/medium repo mode: semantic index is stale. Run /semantic index.",
			};
		}
		return {
			statusLine: `ready (${status.provider}/${status.model}, files=${status.files}, chunks=${status.chunks}, auto_index=${status.autoIndex ? "on" : "off"})`,
			promptGuidance: [
				"Use semantic_search for first-pass discovery, then confirm with targeted reads and grep.",
				"Avoid full-tree scans unless evidence is still insufficient.",
			],
		};
	}

	private async buildSingularSemanticGuidance(
		scaleMode: "small" | "medium" | "large",
	): Promise<{
		statusLine: string;
		promptGuidance: string[];
		operatorHint?: string;
	}> {
		if (scaleMode === "small") {
			return {
				statusLine: "optional_for_small_repo",
				promptGuidance: [
					"Prefer direct targeted reads/grep; semantic index is optional for this repository size.",
				],
			};
		}
		try {
			const status = await this.createSemanticRuntime().status();
			return this.buildSingularSemanticGuidanceFromStatus(status);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				statusLine: `status_unavailable (${message})`,
				promptGuidance: [
					"Semantic status is unavailable; proceed with conservative targeted discovery.",
					"If discovery quality is insufficient, ask user to configure /semantic setup and rerun /singular.",
				],
				operatorHint: `Large/medium repo mode: cannot read semantic status (${message}). Run /semantic status.`,
			};
		}
	}

	private buildSingularAgentPrompt(
		request: string,
		baseline: SingularAnalysisResult,
		contract: EngineeringContract,
		runtimeGuidance: {
			scaleMode: "small" | "medium" | "large";
			scaleReason: string;
			semanticStatusLine: string;
			semanticGuidance: string[];
		},
	): string {
		const filesHint =
			baseline.matchedFiles.length > 0
				? baseline.matchedFiles.slice(0, 12).map((item) => `- ${item}`).join("\n")
				: "- no direct file matches found in heuristic pass";

		return [
			"You are running a feasibility pass for `/singular`.",
			"Task: analyze the codebase for this request and decide whether to implement now, incrementally, or defer.",
			"",
			"Hard requirements:",
			"- Inspect repository files with tools before final output (at least one tool call).",
			"- Return a human-readable markdown report (no JSON).",
			"- Include exactly three options (Option 1, Option 2, Option 3).",
			"- Each option must contain concrete file paths when possible.",
			"",
			"Use this exact template:",
			"# Singular Feasibility",
			"Recommendation: implement_now|implement_incrementally|defer",
			"Reason: <one concise reason>",
			"Complexity: low|medium|high",
			"Blast Radius: low|medium|high",
			"Stage Fit: needed_now|optional_now|later",
			"Stage Fit Reason: <why this stage fit>",
			"Impact - Codebase: <impact>",
			"Impact - Delivery: <impact>",
			"Impact - Risks: <impact>",
			"Impact - Operations: <impact>",
			"",
			"## Option 1: <title>",
			"Summary: <summary>",
			"Complexity: low|medium|high",
			"Blast Radius: low|medium|high",
			"When to choose: <guidance>",
			"Suggested files:",
			"- <path>",
			"Plan:",
			"1. <step>",
			"Pros:",
			"- <pro>",
			"Cons:",
			"- <con>",
			"",
			"## Option 2: <title>",
			"... same fields ...",
			"",
			"## Option 3: <title>",
			"... same fields ...",
			"",
			`Feature request: ${request}`,
			"",
			"Baseline scan summary (heuristic pass):",
			`- scanned_files: ${baseline.scannedFiles}`,
			`- source_files: ${baseline.sourceFiles}`,
			`- test_files: ${baseline.testFiles}`,
			`- baseline_complexity: ${baseline.baselineComplexity}`,
			`- baseline_blast_radius: ${baseline.baselineBlastRadius}`,
			`- baseline_recommendation: ${baseline.recommendation}`,
				"",
				"Repository runtime guidance:",
				`- scale_mode: ${runtimeGuidance.scaleMode}`,
				`- scale_reason: ${runtimeGuidance.scaleReason}`,
				`- semantic_status: ${runtimeGuidance.semanticStatusLine}`,
				...runtimeGuidance.semanticGuidance.map((line) => `- ${line}`),
				"",
				"Matched file hints from baseline (verify, do not assume blindly):",
				filesHint,
				"",
			"Active engineering contract:",
			this.buildSingularContractPromptSection(contract),
		].join("\n");
	}

	private extractLabeledValue(text: string, labels: string[], maxLength = 320): string | undefined {
		for (const label of labels) {
			const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const match = text.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, "im"));
			if (!match?.[1]) continue;
			const normalized = this.toTrimmedString(match[1], maxLength);
			if (normalized) return normalized;
		}
		return undefined;
	}

	private parseSingularListSection(block: string, heading: string, maxItems: number): string[] {
		const headings = [
			"Summary",
			"Complexity",
			"Blast Radius",
			"When to choose",
			"Suggested files",
			"Plan",
			"Pros",
			"Cons",
		];
		const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const nextHeadings = headings.filter((item) => item !== heading).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const sectionRegex = new RegExp(
			`(?:^|\\n)\\s*${escapedHeading}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${nextHeadings.join("|")})\\s*:|\\n\\s*##\\s*Option\\s*[123]\\s*:|$)`,
			"i",
		);
		const sectionMatch = block.match(sectionRegex);
		if (!sectionMatch?.[1]) return [];

		const result: string[] = [];
		const lines = sectionMatch[1].split(/\r?\n/);
		for (const rawLine of lines) {
			let line = rawLine.trim();
			if (!line) continue;
			line = line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
			if (!line) continue;
			result.push(line);
			if (result.length >= maxItems) break;
		}
		return result;
	}

	private parseSingularOptionsFromText(
		text: string,
		baseline: SingularAnalysisResult,
	): { options: SingularOption[]; parsedCount: number } {
		const optionRegex = /^##\s*Option\s*([123])\s*:\s*(.+?)\s*$/gim;
		const matches = [...text.matchAll(optionRegex)];
		const parsed: SingularOption[] = [];

		for (let index = 0; index < matches.length; index += 1) {
			const current = matches[index];
			const optionIndexRaw = Number.parseInt(current[1] ?? "", 10);
			const optionIndex = Number.isInteger(optionIndexRaw) ? Math.max(1, Math.min(3, optionIndexRaw)) - 1 : index;
			const fallback = baseline.options[optionIndex] ?? baseline.options[Math.min(index, baseline.options.length - 1)];
			if (!fallback) continue;

			const bodyStart = (current.index ?? 0) + current[0].length;
			const bodyEnd = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
			const body = text.slice(bodyStart, bodyEnd);
			const title = this.toTrimmedString(current[2], 120, fallback.title) ?? fallback.title;
			const summary = this.extractLabeledValue(body, ["Summary"], 320) ?? fallback.summary;
			const complexity = this.normalizeSingularComplexity(
				this.extractLabeledValue(body, ["Complexity"], 24),
				fallback.complexity,
			);
			const blastRadius = this.normalizeSingularBlastRadius(
				this.extractLabeledValue(body, ["Blast Radius", "Blast"], 24),
				fallback.blast_radius,
			);
			const whenToChoose = this.extractLabeledValue(body, ["When to choose"], 220) ?? fallback.when_to_choose;
			const suggestedFiles = this.parseSingularListSection(body, "Suggested files", 8);
			const plan = this.parseSingularListSection(body, "Plan", 8);
			const pros = this.parseSingularListSection(body, "Pros", 6);
			const cons = this.parseSingularListSection(body, "Cons", 6);

			parsed.push({
				id: String(parsed.length + 1),
				title,
				summary,
				complexity,
				blast_radius: blastRadius,
				suggested_files: suggestedFiles.length > 0 ? suggestedFiles : fallback.suggested_files,
				plan: plan.length > 0 ? plan : fallback.plan,
				pros: pros.length > 0 ? pros : fallback.pros,
				cons: cons.length > 0 ? cons : fallback.cons,
				when_to_choose: whenToChoose,
			});
		}

		while (parsed.length < 3 && parsed.length < baseline.options.length) {
			const fallback = baseline.options[parsed.length];
			parsed.push({
				...fallback,
				id: String(parsed.length + 1),
			});
		}

		return {
			options: parsed.slice(0, 3),
			parsedCount: matches.length,
		};
	}

	private parseSingularAgentAnalysisFromText(
		baseline: SingularAnalysisResult,
		rawText: string,
	): { result: SingularAnalysisResult; parsedOptions: number; hasRecommendation: boolean } {
		const recommendationRaw = this.extractLabeledValue(rawText, ["Recommendation"], 64);
		const recommendation = this.normalizeSingularRecommendation(recommendationRaw, baseline.recommendation);
		const recommendationReason =
			this.extractLabeledValue(rawText, ["Reason", "Recommendation Reason"], 320) ?? baseline.recommendationReason;
		const baselineComplexity = this.normalizeSingularComplexity(
			this.extractLabeledValue(rawText, ["Complexity"], 24),
			baseline.baselineComplexity,
		);
		const baselineBlastRadius = this.normalizeSingularBlastRadius(
			this.extractLabeledValue(rawText, ["Blast Radius", "Blast"], 24),
			baseline.baselineBlastRadius,
		);
		const stageFit = this.normalizeSingularStageFit(this.extractLabeledValue(rawText, ["Stage Fit"], 40)) ?? baseline.stageFit;
		const stageFitReason = this.extractLabeledValue(rawText, ["Stage Fit Reason"], 280) ?? baseline.stageFitReason;
		const impactAnalysis: SingularImpactAnalysis = {
			codebase: this.extractLabeledValue(rawText, ["Impact - Codebase", "Codebase Impact"], 260) ?? "Unknown.",
			delivery: this.extractLabeledValue(rawText, ["Impact - Delivery", "Delivery Impact"], 260) ?? "Unknown.",
			risks: this.extractLabeledValue(rawText, ["Impact - Risks", "Risk Impact"], 260) ?? "Unknown.",
			operations: this.extractLabeledValue(rawText, ["Impact - Operations", "Operations Impact"], 260) ?? "Unknown.",
		};
		const { options, parsedCount } = this.parseSingularOptionsFromText(rawText, baseline);

		return {
			result: {
				...baseline,
				recommendation,
				recommendationReason,
				baselineComplexity,
				baselineBlastRadius,
				stageFit,
				stageFitReason,
				impactAnalysis,
				options,
			},
			parsedOptions: parsedCount,
			hasRecommendation: recommendationRaw !== undefined,
		};
	}

	private async runSingularAgentFeasibilityPass(
		request: string,
		baseline: SingularAnalysisResult,
		contract: EngineeringContract,
		runtimeGuidance: {
			scaleMode: "small" | "medium" | "large";
			scaleReason: string;
			semanticStatusLine: string;
			semanticGuidance: string[];
		},
	): Promise<SingularAnalysisResult | undefined> {
		const model = this.session.model;
		if (!model) {
			return undefined;
		}

		const cwd = this.sessionManager.getCwd();
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(getAuthPath());
		const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			authStorage,
			modelRegistry,
			resourceLoader,
			model,
			profile: "plan",
			enableTaskTool: false,
		});

		let toolCallsStarted = 0;
		const chunks: string[] = [];
		const eventBridge = this.createIosmVerificationEventBridge({
			loaderMessage: `Running /singular feasibility analysis... (${appKey(this.keybindings, "interrupt")} to interrupt)`,
		});
		const unsubscribe = session.subscribe((event) => {
			eventBridge(event);
			if (event.type === "tool_execution_start") {
				toolCallsStarted += 1;
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				for (const part of event.message.content) {
					if (part.type === "text" && part.text.trim()) {
						chunks.push(part.text.trim());
					}
				}
			}
		});

		this.singularAnalysisSession = session;
		try {
			const primaryPrompt = this.buildSingularAgentPrompt(request, baseline, contract, runtimeGuidance);
			const strictRetryPrompt = [
				"Retry strict mode:",
				"- Inspect repository files using tools first.",
				"- Return markdown report using the exact template from previous prompt.",
				"- Include Recommendation and Option 1/2/3 sections.",
				"- Do not return JSON.",
			].join("\n");

			const runAttempt = async (promptText: string): Promise<{ text: string; toolCalls: number }> => {
				const chunkStart = chunks.length;
				const toolStart = toolCallsStarted;
				await session.prompt(promptText, {
					expandPromptTemplates: false,
					skipIosmAutopilot: true,
					skipOrchestrationDirective: true,
					source: "interactive",
				});
				return {
					text: chunks.slice(chunkStart).join("\n\n").trim(),
					toolCalls: Math.max(0, toolCallsStarted - toolStart),
				};
			};

			let attempt = await runAttempt(primaryPrompt);
			let parsed = this.parseSingularAgentAnalysisFromText(baseline, attempt.text);

			if ((parsed.parsedOptions < 3 || !parsed.hasRecommendation || attempt.toolCalls === 0) && !session.isStreaming) {
				attempt = await runAttempt(strictRetryPrompt);
				parsed = this.parseSingularAgentAnalysisFromText(baseline, attempt.text);
			}

			if ((parsed.parsedOptions < 3 || !parsed.hasRecommendation) || toolCallsStarted === 0) {
				return undefined;
			}

			return parsed.result;
		} finally {
			if (session.isStreaming) {
				await session.abort().catch(() => {
					// best effort
				});
			}
			if (this.singularAnalysisSession === session) {
				this.singularAnalysisSession = undefined;
			}
			unsubscribe();
			session.dispose();
		}
	}

	private formatSingularRunReport(result: SingularAnalysisResult): string {
		const recommendedId = this.resolveRecommendedSingularOptionId(result);
		const coverageLine = `${result.scannedFiles} scanned · ${result.sourceFiles} source · ${result.testFiles} tests`;
		const lines = [
			`run_id: ${result.runId}`,
			`request: ${result.request}`,
			`generated_at: ${result.generatedAt}`,
			"",
			"overview:",
			`  recommendation: ${result.recommendation}`,
			`  reason: ${result.recommendationReason}`,
			`  complexity: ${result.baselineComplexity}`,
			`  blast_radius: ${result.baselineBlastRadius}`,
			`  repository_coverage: ${coverageLine}`,
		];
		if (result.stageFit) {
			lines.push(`  stage_fit: ${result.stageFit}`);
		}
		if (result.stageFitReason) {
			lines.push(`  stage_fit_reason: ${result.stageFitReason}`);
		}
		if (result.impactAnalysis) {
			lines.push("");
			lines.push("impact_analysis:");
			lines.push(`  codebase: ${result.impactAnalysis.codebase}`);
			lines.push(`  delivery: ${result.impactAnalysis.delivery}`);
			lines.push(`  risks: ${result.impactAnalysis.risks}`);
			lines.push(`  operations: ${result.impactAnalysis.operations}`);
		}
		if (result.matchedFiles.length > 0) {
			lines.push("");
			lines.push(`matched_files: ${result.matchedFiles.slice(0, 8).join(", ")}`);
		}
		if (result.contractSignals.length > 0) {
			lines.push(`contract_signals: ${result.contractSignals.join(", ")}`);
		}
		lines.push("");
		lines.push("implementation_options:");
		for (const option of result.options) {
			const recommendedMark = option.id === recommendedId ? " [recommended]" : "";
			lines.push(
				`${option.id}. ${option.title}${recommendedMark} [complexity=${option.complexity}, blast=${option.blast_radius}]`,
			);
			lines.push(`   ${option.summary}`);
			if (option.when_to_choose) {
				lines.push(`   when_to_choose: ${option.when_to_choose}`);
			}
			if (option.suggested_files.length > 0) {
				lines.push(`   files: ${option.suggested_files.slice(0, 8).join(", ")}`);
			}
			if (option.plan.length > 0) {
				lines.push(`   first_step: ${option.plan[0]}`);
			}
		}
		lines.push("");
		lines.push("next_action:");
		lines.push("  choose option 1/2/3, then pick Start with Swarm or Continue without Swarm");
		return lines.join("\n");
	}

	private buildSingularExecutionDraft(
		result: SingularAnalysisResult,
		option: SingularOption,
		contract?: EngineeringContract,
	): string {
		const effectiveContract = contract ?? this.singularLastEffectiveContract ?? {};
		const defaultQualityGates = [
			"Targeted tests for changed flows pass.",
			"No regressions in adjacent user paths.",
			"Logs/metrics updated for the new behavior.",
		];
		const defaultDoD = [
			"Core behavior implemented and manually validated.",
			"Automated coverage added for critical path.",
			"Documentation/changelog updated for user-visible changes.",
		];
		const qualityGates =
			(effectiveContract.quality_gates ?? []).length > 0
				? (effectiveContract.quality_gates ?? []).slice(0, 10)
				: defaultQualityGates;
		const definitionOfDone =
			(effectiveContract.definition_of_done ?? []).length > 0
				? (effectiveContract.definition_of_done ?? []).slice(0, 10)
				: defaultDoD;
		const constraints = (effectiveContract.constraints ?? []).slice(0, 10);
		const scopeInclude = (effectiveContract.scope_include ?? []).slice(0, 10);
		const scopeExclude = (effectiveContract.scope_exclude ?? []).slice(0, 10);
		const risksFromOption = option.cons.slice(0, 6);
		const files = option.suggested_files.slice(0, 14);
		const planSteps = option.plan.length > 0 ? option.plan : ["Implement minimal working path for selected option."];

		const lines = [
			"# Singular Execution Plan",
			"",
			`Request: ${result.request}`,
			`Selected option: ${option.id}. ${option.title}`,
			`Decision context: recommendation=${result.recommendation}, complexity=${option.complexity}, blast_radius=${option.blast_radius}`,
			...(result.stageFit ? [`Stage fit: ${result.stageFit}`] : []),
			...(result.stageFitReason ? [`Stage fit reason: ${result.stageFitReason}`] : []),
			...(option.when_to_choose ? [`When to choose: ${option.when_to_choose}`] : []),
			"",
			"## 1) Scope and Boundaries",
			"In scope:",
			...(scopeInclude.length > 0 ? scopeInclude.map((item) => `- ${item}`) : ["- Deliver selected option with minimal blast radius."]),
			"Out of scope:",
			...(scopeExclude.length > 0 ? scopeExclude.map((item) => `- ${item}`) : ["- Broad refactors outside touched modules."]),
			"Hard constraints:",
			...(constraints.length > 0 ? constraints.map((item) => `- ${item}`) : ["- Keep backward compatibility for existing behavior."]),
			"",
			"## 2) Implementation Phases",
			"Phase A - Preparation",
			"1. Confirm acceptance criteria and edge cases for the selected option.",
			"2. Lock touched modules and define rollback strategy before coding.",
			"Phase B - Implementation",
			...planSteps.map((step, index) => `${index + 1}. ${step}`),
			"Phase C - Hardening",
			"1. Run targeted regression checks on impacted flows.",
			"2. Address review findings and update docs if behavior changed.",
			"",
			"## 3) Priority Files",
		];
		lines.push(...(files.length > 0 ? files.map((filePath) => `- ${filePath}`) : ["- Determine target files during code scan."]));
		lines.push(
			"",
			"## 4) Validation and Quality Gates",
			"Functional checks:",
			"- Validate main user flow end-to-end.",
			"- Validate failure/edge path handling.",
			"Quality gates:",
			...qualityGates.map((gate) => `- [ ] ${gate}`),
			"",
			"## 5) Risk Controls and Rollout",
			...(result.impactAnalysis?.risks ? [`- Risk focus: ${result.impactAnalysis.risks}`] : ["- Risk focus: maintain safe rollout with quick rollback."]),
			...(risksFromOption.length > 0 ? risksFromOption.map((risk) => `- [ ] Mitigate: ${risk}`) : ["- [ ] Track and mitigate newly discovered risks during implementation."]),
			"- [ ] Prepare rollback checkpoint before merge.",
			"- [ ] Use incremental rollout/feature-flag if blast radius is medium or high.",
			"",
			"## 6) Definition of Done",
			...definitionOfDone.map((item) => `- [ ] ${item}`),
			"",
			"## 7) Delivery Notes",
			"- Keep commits scoped by phase (prep -> impl -> hardening).",
			"- Include tests and docs in the same delivery stream.",
		);
		return lines.join("\n");
	}

	private resolveRecommendedSingularOptionId(result: SingularAnalysisResult): string {
		if (result.recommendation === "defer") {
			return "3";
		}
		if (result.recommendation === "implement_incrementally") {
			const incremental = result.options.find((option) => /increment|mvp|phased/i.test(`${option.title} ${option.summary}`));
			return incremental?.id ?? "1";
		}
		const nonDefer = result.options.find((option) => !/defer|later|postpone/i.test(`${option.title} ${option.summary}`));
		return nonDefer?.id ?? "1";
	}

	private async promptSingularDecision(result: SingularAnalysisResult): Promise<void> {
		const recommendedId = this.resolveRecommendedSingularOptionId(result);
		const options = result.options.map((option) => {
			const recommendedSuffix = option.id === recommendedId ? " (Recommended)" : "";
			return `Option ${option.id}${recommendedSuffix}: ${option.title} [risk=${option.blast_radius}]`;
		});
		options.push("Close without decision");
		const selected = await this.showExtensionSelector("/singular: choose next step", options);
		if (!selected || selected === "Close without decision") return;

		const match = selected.match(/^Option\s+(\d+)/);
		if (!match) return;
		const picked = result.options.find((option) => option.id === match[1]);
		if (!picked) return;

		this.showCommandTextBlock(
			"Singular Decision",
			[
				`selected: ${picked.id}. ${picked.title}`,
				`summary: ${picked.summary}`,
				`complexity: ${picked.complexity}`,
				`blast_radius: ${picked.blast_radius}`,
				...(picked.when_to_choose ? [`when_to_choose: ${picked.when_to_choose}`] : []),
				"",
				"plan:",
				...picked.plan.map((step, index) => `${index + 1}. ${step}`),
				"",
				"pros:",
				...picked.pros.map((item) => `- ${item}`),
				"",
				"cons:",
				...picked.cons.map((item) => `- ${item}`),
			].join("\n"),
		);

		if (picked.id === "3") {
			this.showStatus("Singular: defer option selected, implementation postponed.");
			return;
		}

		const executionChoice = await this.showExtensionSelector(
			"/singular: execution mode",
			["Start with Swarm (Recommended)", "Continue without Swarm", "Cancel"],
		);
		if (!executionChoice || executionChoice === "Cancel") {
			this.showStatus("Singular: execution cancelled.");
			return;
		}

		if (executionChoice.startsWith("Start with Swarm")) {
			await this.runSwarmFromSingular({
				runId: result.runId,
				option: Number.parseInt(picked.id, 10),
			});
			return;
		}

		this.editor.setText(this.buildSingularExecutionDraft(result, picked, this.singularLastEffectiveContract));
		this.showStatus("Singular: detailed execution draft generated in editor.");
	}

	private showSingularLastSummary(): void {
		const last = this.singularService.getLastRun();
		if (!last) {
			this.showWarning("No /singular analyses found yet.");
			return;
		}
		this.showCommandTextBlock(
			"Singular Last Run",
			[
				`run_id: ${last.runId}`,
				`generated_at: ${last.generatedAt ?? "unknown"}`,
				`recommendation: ${last.recommendation ?? "unknown"}`,
				`request: ${last.request ?? "unknown"}`,
				`analysis_path: ${last.analysisPath}`,
				...(last.metaPath ? [`meta_path: ${last.metaPath}`] : []),
			].join("\n"),
		);
	}

	private async runSingularAnalysis(request: string): Promise<void> {
		let effectiveContract: EngineeringContract = {};
		try {
			effectiveContract = this.contractService.getState().effective;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showWarning(`Contract unavailable, continuing /singular without contract overlay: ${message}`);
		}
		this.singularLastEffectiveContract = effectiveContract;

		try {
			this.showStatus("Singular: preparing baseline scan...");
			const baseline = await this.singularService.analyze({
				request,
				autosave: false,
				contract: effectiveContract,
			});
			const scale = this.resolveSingularRepoScaleMode(baseline);
			const semanticGuidance = await this.buildSingularSemanticGuidance(scale.mode);
			if (scale.mode !== "small") {
				this.showStatus(`Singular scale mode: ${scale.mode} (${scale.reason})`);
			}
			if (semanticGuidance.operatorHint) {
				this.showWarning(semanticGuidance.operatorHint);
			}
			const runtimeGuidance = {
				scaleMode: scale.mode,
				scaleReason: scale.reason,
				semanticStatusLine: semanticGuidance.statusLine,
				semanticGuidance: semanticGuidance.promptGuidance,
			};

			let result = baseline;
			if (!this.session.model) {
				this.showWarning("No model selected. /singular used heuristic analysis only. Use /model to enable agent feasibility pass.");
			} else {
				try {
					const enriched = await this.runSingularAgentFeasibilityPass(
						request,
						baseline,
						effectiveContract,
						runtimeGuidance,
					);
					if (enriched) {
						result = enriched;
					} else {
						this.showWarning("Agent feasibility pass returned incomplete output. Showing heuristic fallback.");
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.showWarning(`Agent feasibility pass failed. Showing heuristic fallback: ${message}`);
				}
			}

			this.singularService.saveAnalysis(result);
			this.showStatus(`Singular analysis complete: ${result.runId}`);
			this.showCommandTextBlock("Singular Analysis", this.formatSingularRunReport(result));
			await this.promptSingularDecision(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(`Singular analysis failed: ${message}`);
		}
	}

	private async handleSingularCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		if (args.length === 0) {
			this.showWarning("Usage: /singular <feature request>");
			return;
		}

		const subcommand = (args[0] ?? "").toLowerCase();
		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Singular Help",
				[
					"Usage:",
					"  /singular <feature request>",
					"  /singular last",
					"  /singular help",
					"",
					"Flow:",
					"  /singular -> choose option -> Start with Swarm or Continue without Swarm",
					"",
					"Examples:",
					"  /singular add account dashboard",
					"  /singular introduce RBAC for API",
				].join("\n"),
			);
			return;
		}

		if (subcommand === "last" && args.length === 1) {
			this.showSingularLastSummary();
			return;
		}

		const request = args.join(" ").trim();
		if (!request) {
			this.showWarning("Usage: /singular <feature request>");
			return;
		}
		await this.runSingularAnalysis(request);
	}

	private parseCheckpointNameFromLabel(label: string | undefined): string | undefined {
		if (!label) return undefined;
		if (!label.startsWith(CHECKPOINT_LABEL_PREFIX)) return undefined;
		const name = label.slice(CHECKPOINT_LABEL_PREFIX.length).trim();
		return name.length > 0 ? name : undefined;
	}

	private buildCheckpointLabel(name: string): string {
		return `${CHECKPOINT_LABEL_PREFIX}${name}`;
	}

	private normalizeCheckpointName(raw: string): string | undefined {
		const normalized = raw.replace(/\s+/g, " ").trim();
		if (!normalized) return undefined;
		if (normalized.length > 80) return undefined;
		return normalized;
	}

	private getSessionCheckpoints(): SessionCheckpoint[] {
		const active = new Map<string, SessionCheckpoint>();
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "label") continue;
			const name = this.parseCheckpointNameFromLabel(entry.label);
			if (!name) {
				active.delete(entry.targetId);
				continue;
			}
			active.set(entry.targetId, {
				name,
				targetId: entry.targetId,
				labelEntryId: entry.id,
				timestamp: entry.timestamp,
			});
		}
		return [...active.values()].sort(
			(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		);
	}

	private buildDefaultCheckpointName(checkpoints: SessionCheckpoint[]): string {
		const used = new Set(checkpoints.map((checkpoint) => checkpoint.name.toLowerCase()));
		let index = 1;
		while (used.has(`cp-${index}`)) {
			index += 1;
		}
		return `cp-${index}`;
	}

	private formatCheckpointList(checkpoints: SessionCheckpoint[]): string {
		if (checkpoints.length === 0) {
			return "No checkpoints yet.\nCreate one with: /checkpoint [name]";
		}
		const newestFirst = [...checkpoints].reverse();
		const lines = newestFirst.map((checkpoint, index) => {
			const target = this.sessionManager.getEntry(checkpoint.targetId);
			const type = target?.type ?? "missing";
			return `${index + 1}. ${checkpoint.name} -> ${checkpoint.targetId} (${type}) @ ${checkpoint.timestamp}`;
		});
		lines.push("");
		lines.push("Usage: /rollback [name|index]");
		return lines.join("\n");
	}

	private formatCheckpointOption(index: number, checkpoint: SessionCheckpoint): string {
		const target = this.sessionManager.getEntry(checkpoint.targetId);
		const type = target?.type ?? "missing";
		return `${index}. ${checkpoint.name} -> ${checkpoint.targetId} (${type}) @ ${checkpoint.timestamp}`;
	}

	private handleCheckpointCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const subcommand = args[0]?.toLowerCase();
		const checkpoints = this.getSessionCheckpoints();

		if (subcommand === "list" || subcommand === "ls") {
			this.showCommandTextBlock("Checkpoints", this.formatCheckpointList(checkpoints));
			return;
		}

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Checkpoint Help",
				["Usage:", "  /checkpoint [name]", "  /checkpoint list", "", "Examples:", "  /checkpoint", "  /checkpoint before-refactor"].join("\n"),
			);
			return;
		}

		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showWarning("Cannot create checkpoint yet (session has no entries).");
			return;
		}

		const requestedName = args.join(" ");
		const name = requestedName ? this.normalizeCheckpointName(requestedName) : this.buildDefaultCheckpointName(checkpoints);
		if (!name) {
			this.showWarning("Invalid checkpoint name. Use 1-80 visible characters.");
			return;
		}

		this.sessionManager.appendLabelChange(leafId, this.buildCheckpointLabel(name));
		this.showStatus(`Checkpoint saved: ${name} (${leafId})`);
	}

	private async handleRollbackCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const subcommand = args[0]?.toLowerCase();
		const checkpoints = this.getSessionCheckpoints();

		if (subcommand === "list" || subcommand === "ls") {
			this.showCommandTextBlock("Checkpoints", this.formatCheckpointList(checkpoints));
			return;
		}

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Rollback Help",
				[
					"Usage:",
					"  /rollback",
					"  /rollback <name>",
					"  /rollback <index>",
					"",
					"Examples:",
					"  /rollback",
					"  /rollback before-refactor",
					"  /rollback 2",
				].join("\n"),
			);
			return;
		}

		if (checkpoints.length === 0) {
			this.showWarning("No checkpoints available. Create one with /checkpoint.");
			return;
		}

		const newestFirst = [...checkpoints].reverse();
		const selector = args.join(" ").trim();
		let target: SessionCheckpoint | undefined = newestFirst[0];

		if (selector) {
			const numeric = Number.parseInt(selector, 10);
			if (Number.isFinite(numeric) && `${numeric}` === selector) {
				target = newestFirst[numeric - 1];
				if (!target) {
					this.showWarning(`Checkpoint index ${numeric} is out of range.`);
					return;
				}
			} else {
				target = newestFirst.find((checkpoint) => checkpoint.name === selector);
				if (!target) {
					this.showWarning(`Checkpoint "${selector}" not found.`);
					return;
				}
			}
		} else {
			const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
			if (canShowInteractiveSelector) {
				const options = newestFirst.map((checkpoint, index) => this.formatCheckpointOption(index + 1, checkpoint));
				const picked = await this.showExtensionSelector("/rollback: choose checkpoint", options);
				if (!picked) {
					this.showStatus("Rollback cancelled");
					return;
				}
				const selectedIndex = options.indexOf(picked);
				if (selectedIndex >= 0) {
					target = newestFirst[selectedIndex];
				}
			}
		}
		if (!target) {
			this.showWarning("No rollback target selected.");
			return;
		}

		try {
			const result = await this.session.navigateTree(target.targetId, { summarize: false });
			if (result.cancelled || result.aborted) {
				this.showStatus("Rollback cancelled");
				return;
			}

			this.chatContainer.clear();
			this.renderInitialMessages();
			if (result.editorText && !this.editor.getText().trim()) {
				this.editor.setText(result.editorText);
			}
			this.showStatus(`Rolled back to checkpoint: ${target.name}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async runDoctorInteractiveFixes(checks: DoctorCheckItem[]): Promise<void> {
		const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
		if (!canShowInteractiveSelector) {
			return;
		}

		const hasModelIssues = checks.some(
			(check) =>
				(check.label === "Active model" || check.label === "Active model auth" || check.label === "Available models") &&
				check.level === "fail",
		);
		const hasMcpIssues = checks.some((check) => check.label === "MCP servers" && check.level !== "ok");
		const hasSemanticIssues = checks.some((check) => check.label === "Semantic index" && check.level !== "ok");
		const hasContractIssues = checks.some((check) => check.label === "Contract state" && check.level !== "ok");
		const hasResourceIssues = checks.some((check) => check.label === "Resources" && check.level !== "ok");

		while (true) {
			const options: string[] = [];
			if (hasModelIssues) {
				options.push("Open model selector");
				options.push("Login provider");
			}
			if (this.mcpRuntime) {
				if (hasMcpIssues) {
					options.push("Open MCP manager");
				}
				options.push("Refresh MCP runtime");
			}
			if (hasSemanticIssues) {
				options.push("Open semantic manager");
			}
			if (hasContractIssues) {
				options.push("Open contract manager");
			}
			if (this.permissionMode === "yolo") {
				options.push("Set permissions mode to ask");
			}
			if (hasResourceIssues) {
				options.push("Reload resources");
			}
			options.push("Show auth/models paths");
			options.push("Close");

			const selected = await this.showExtensionSelector("/doctor fixes", options);
			if (!selected || selected === "Close") {
				return;
			}

			if (selected === "Open model selector") {
				await this.showModelProviderSelector();
				return;
			}
			if (selected === "Login provider") {
				await this.showOAuthSelector("login");
				return;
			}
			if (selected === "Open MCP manager") {
				await this.refreshMcpRuntimeAndSession();
				this.showMcpSelector();
				return;
			}
			if (selected === "Refresh MCP runtime") {
				await this.refreshMcpRuntimeAndSession();
				this.showStatus("MCP servers refreshed");
				continue;
			}
			if (selected === "Open semantic manager") {
				await this.handleSemanticCommand("/semantic");
				return;
			}
			if (selected === "Open contract manager") {
				await this.handleContractCommand("/contract");
				return;
			}
			if (selected === "Set permissions mode to ask") {
				this.permissionMode = "ask";
				this.settingsManager.setPermissionMode("ask");
				this.showStatus("Permissions: ask");
				continue;
			}
			if (selected === "Reload resources") {
				await this.handleReloadCommand();
				return;
			}
			if (selected === "Show auth/models paths") {
				const cwd = this.sessionManager.getCwd();
				const agentDir = getAgentDir();
				this.showCommandTextBlock(
					"Runtime Paths",
						[
							`auth.json: ${getAuthPath()}`,
							`models.json: ${getModelsPath()}`,
							`contract(project): ${this.contractService.getProjectPath()}`,
							`singular(analyses): ${this.singularService.getAnalysesRoot()}`,
							`semantic(user): ${getSemanticConfigPath("user", cwd, agentDir)}`,
							`semantic(project): ${getSemanticConfigPath("project", cwd, agentDir)}`,
							`semantic(index): ${getSemanticIndexDir(cwd, agentDir)}`,
					].join("\n"),
				);
				continue;
			}
		}
	}

	private async handleDoctorCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const outputJson = args.includes("--json");
		const hooks = this.getHookPolicySummary();
		const model = this.session.model;
		const modelRegistry = this.session.modelRegistry;
		const allModels = modelRegistry.getAll();
		const availableModels = modelRegistry.getAvailable();
		const modelLoadError = modelRegistry.getError();
		const authProviders = modelRegistry.authStorage.list();
		const hasModelAuth = model ? modelRegistry.authStorage.hasAuth(model.provider) : false;
		const extensionErrors = this.session.resourceLoader.getExtensions().errors.length;
		const skillDiagnostics = this.session.resourceLoader.getSkills().diagnostics.length;
		const promptDiagnostics = this.session.resourceLoader.getPrompts().diagnostics.length;
		const themeDiagnostics = this.session.resourceLoader.getThemes().diagnostics.length;

		const mcpStatuses = this.mcpRuntime?.getServers() ?? [];
		const mcpConfigErrors = this.mcpRuntime?.getErrors() ?? [];
		const mcpConnected = mcpStatuses.filter((status) => status.state === "connected").length;
		const mcpErrored = mcpStatuses.filter((status) => status.state === "error").length;
		const mcpDisabled = mcpStatuses.filter((status) => !status.enabled).length;
		const cliToolStatuses = resolveDoctorCliToolStatuses();
		const missingCliTools = cliToolStatuses.filter((status) => !status.available).map((status) => status.tool);
		let semanticStatus: SemanticStatusResult | undefined;
		let semanticStatusError: string | undefined;
		try {
			semanticStatus = await this.createSemanticRuntime().status();
		} catch (error) {
			semanticStatusError = error instanceof Error ? error.message : String(error);
		}
		let contractState: ContractState | undefined;
		let contractStateError: string | undefined;
		try {
			contractState = this.contractService.getState();
		} catch (error) {
			contractStateError = error instanceof Error ? error.message : String(error);
		}

		const checks: DoctorCheckItem[] = [];
		const addCheck = (
			level: DoctorCheckLevel,
			label: string,
			detail: string,
			fix?: string,
		) => checks.push({ level, label, detail, fix });

		if (!model) {
			addCheck("fail", "Active model", "No active model selected", "Run /model and pick a model.");
		} else if (!hasModelAuth) {
			addCheck(
				"fail",
				"Active model auth",
				`Model ${model.provider}/${model.id} has no auth configured`,
				`Run /login ${model.provider} or set API key env vars.`,
			);
		} else {
			addCheck("ok", "Active model", `${model.provider}/${model.id}`);
		}

		if (availableModels.length === 0) {
			addCheck("fail", "Available models", "No models currently have valid auth", "Run /login or configure API keys.");
		} else {
			addCheck("ok", "Available models", `${availableModels.length}/${allModels.length} ready`);
		}

		if (modelLoadError) {
			addCheck("warn", "models.json", modelLoadError.split("\n")[0] ?? modelLoadError, `Inspect ${getModelsPath()}.`);
		} else {
			addCheck("ok", "models.json", "Loaded without schema/runtime errors");
		}

		if (!fs.existsSync(getAuthPath())) {
			addCheck("warn", "auth.json", `Missing ${getAuthPath()}`, "Run /login to create credentials.");
		} else {
			addCheck("ok", "auth.json", `${authProviders.length} provider credential(s) stored`);
		}

		if (!this.mcpRuntime) {
			addCheck("warn", "MCP runtime", "Unavailable in this session");
		} else if (mcpStatuses.length === 0) {
			addCheck("warn", "MCP servers", "No MCP servers configured", "Use /mcp add or iosm mcp add ...");
		} else if (mcpErrored > 0 || mcpConfigErrors.length > 0) {
			addCheck(
				"warn",
				"MCP servers",
				`${mcpConnected} connected, ${mcpErrored} error, ${mcpDisabled} disabled`,
				"Open /mcp to reconnect or inspect server errors.",
			);
		} else {
			addCheck("ok", "MCP servers", `${mcpConnected} connected, ${mcpDisabled} disabled`);
		}

		if (semanticStatusError) {
			addCheck("fail", "Semantic index", semanticStatusError, "Run /semantic setup and retry /semantic status.");
		} else if (!semanticStatus) {
			addCheck("warn", "Semantic index", "Status unavailable", "Run /semantic setup.");
		} else if (!semanticStatus.configured) {
			addCheck(
				"warn",
				"Semantic index",
				"Not configured",
				`Run /semantic setup (user: ${semanticStatus.configPathUser} or project: ${semanticStatus.configPathProject}).`,
			);
		} else if (!semanticStatus.enabled) {
			addCheck("warn", "Semantic index", "Configured but disabled", "Enable semanticSearch.enabled or rerun /semantic setup.");
		} else if (!semanticStatus.indexed) {
			addCheck("warn", "Semantic index", "Configured but index is missing", "Run /semantic index.");
		} else if (semanticStatus.stale) {
			const requiresRebuild =
				semanticStatus.staleReason === "provider_changed" ||
				semanticStatus.staleReason === "chunking_changed" ||
				semanticStatus.staleReason === "index_filters_changed" ||
				semanticStatus.staleReason === "dimension_mismatch";
			addCheck(
				"warn",
				"Semantic index",
				`Indexed but stale${semanticStatus.staleReason ? ` (${semanticStatus.staleReason})` : ""}`,
				requiresRebuild ? "Run /semantic rebuild." : "Run /semantic index.",
			);
		} else {
			addCheck(
				"ok",
				"Semantic index",
				`${semanticStatus.provider}/${semanticStatus.model} · auto_index=${semanticStatus.autoIndex ? "on" : "off"} · files=${semanticStatus.files} chunks=${semanticStatus.chunks}`,
			);
		}

		if (contractStateError) {
			addCheck("fail", "Contract state", contractStateError, "Fix .iosm/contract.json or run /contract clear --scope project.");
		} else if (!contractState) {
			addCheck("warn", "Contract state", "Unavailable", "Run /contract show to inspect state.");
		} else if (!contractState.hasProjectFile && Object.keys(contractState.sessionOverlay).length === 0) {
			addCheck("warn", "Contract state", "No project/session contract active", "Run /contract to define constraints and quality gates.");
		} else {
			addCheck(
				"ok",
				"Contract state",
				`project=${contractState.hasProjectFile ? "yes" : "no"} session_keys=${Object.keys(contractState.sessionOverlay).length} effective_keys=${Object.keys(contractState.effective).length}`,
			);
		}

		addCheck("ok", "Singular analyzer", "Available via /singular <request>");

		if (missingCliTools.length > 0) {
			addCheck(
				"warn",
				"CLI toolchain",
				`${cliToolStatuses.length - missingCliTools.length}/${cliToolStatuses.length} available (missing: ${missingCliTools.join(", ")})`,
				`Install missing CLI tools: ${missingCliTools.join(", ")}.`,
			);
		} else {
			addCheck("ok", "CLI toolchain", `${cliToolStatuses.length}/${cliToolStatuses.length} available`);
		}

		if (extensionErrors > 0 || skillDiagnostics > 0 || promptDiagnostics > 0 || themeDiagnostics > 0) {
			addCheck(
				"warn",
				"Resources",
				`extensions:${extensionErrors} skills:${skillDiagnostics} prompts:${promptDiagnostics} themes:${themeDiagnostics}`,
				"Run /reload and inspect warnings shown in the chat.",
			);
		} else {
			addCheck("ok", "Resources", "No extension/skill/prompt/theme diagnostics");
		}

		addCheck(
			this.permissionMode === "yolo" ? "warn" : "ok",
			"Permissions",
			`mode=${this.permissionMode}, allowRules=${this.permissionAllowRules.length}, denyRules=${this.permissionDenyRules.length}`,
			this.permissionMode === "yolo" ? "Switch to /permissions ask for safer execution." : undefined,
		);

		addCheck(
			process.env[ENV_OFFLINE] ? "warn" : "ok",
			"Environment",
			`offline=${process.env[ENV_OFFLINE] ? "on" : "off"}, sessionTrace=${isSessionTraceEnabled() ? "on" : "off"}`,
			process.env[ENV_OFFLINE] ? "Unset IOSM_OFFLINE/PI_OFFLINE when network access is required." : undefined,
		);

		addCheck(
			"ok",
			"Hooks",
			hooks
				? `U${hooks.userPromptSubmit}/P${hooks.preToolUse}/T${hooks.postToolUse}/S${hooks.stop}`
				: "No hooks loaded",
		);

		const recommendations = [...new Set(checks.map((check) => check.fix).filter((fix): fix is string => !!fix))];

		if (outputJson) {
			this.showCommandJsonBlock("Doctor Report", {
				timestamp: new Date().toISOString(),
				cwd: this.sessionManager.getCwd(),
				sessionFile: this.sessionManager.getSessionFile() ?? null,
				activeProfile: this.activeProfileName,
				externalCliTools: cliToolStatuses,
				checks,
				recommendations,
			});
			return;
		}

		const lines: string[] = [];
		lines.push(`Timestamp: ${new Date().toISOString()}`);
		lines.push(`CWD: ${this.sessionManager.getCwd()}`);
		lines.push(`Session: ${this.sessionManager.getSessionFile() ?? "in-memory"}`);
		lines.push(`Profile: ${this.activeProfileName}`);
		lines.push("");
		for (const check of checks) {
			const prefix = check.level === "ok" ? "[OK]" : check.level === "warn" ? "[WARN]" : "[FAIL]";
			lines.push(`${prefix} ${check.label}: ${check.detail}`);
		}
		lines.push("");
		lines.push("External CLI tools:");
		for (const status of cliToolStatuses) {
			const prefix = status.available ? "[OK]" : "[WARN]";
			const sourceLabel =
				status.source === "missing"
					? "missing"
					: `${status.source}${status.command ? ` (${status.command})` : ""}`;
			lines.push(`${prefix} ${status.tool}: ${sourceLabel}`);
			if (!status.available && status.hint) {
				lines.push(`       fix: ${status.hint}`);
			}
		}
		if (recommendations.length > 0) {
			lines.push("");
			lines.push("Recommended actions:");
			for (const recommendation of recommendations) {
				lines.push(`- ${recommendation}`);
			}
		}
		lines.push("");
		lines.push("Tip: /doctor --json");
		this.showCommandTextBlock("Doctor Report", lines.join("\n"));

		const wantsInteractiveFixes = !args.includes("--no-fix");
		if (wantsInteractiveFixes) {
			await this.runDoctorInteractiveFixes(checks);
		}
	}

	private showCommandTextBlock(title: string, body: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(body, 1, 0));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private showCommandJsonBlock(title: string, value: unknown): void {
		const json = JSON.stringify(value, null, 2);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(`\`\`\`json\n${json}\n\`\`\``, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async runIosmInitAgentVerification(
		result: IosmInitResult,
		targetDir: string,
		onEvent?: (event: AgentSessionEvent) => void,
	): Promise<IosmInitVerificationSummary> {
		if (!result.cycle) {
			return {
				completed: false,
				skippedReason: "No cycle scaffold was available for verification.",
			};
		}

		const cycleId = result.cycle.cycleId;
		process.env[ENV_SESSION_TRACE] = "1";
		process.env.PI_SESSION_TRACE = "1";

		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(targetDir, agentDir);
		const settingsErrors = settingsManager.drainErrors();
		for (const { scope, error } of settingsErrors) {
			this.showWarning(`Init verify warning (${scope} settings): ${error.message}`);
		}

		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
		const resourceLoader = new DefaultResourceLoader({
			cwd: targetDir,
			agentDir,
			settingsManager,
			noExtensions: true,
		});
		await resourceLoader.reload();

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: targetDir,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			authStorage,
			modelRegistry,
			resourceLoader,
		});
		let toolExecutions = 0;
		const activityLog: string[] = [];
		const pushActivity = (line: string, persist = false): void => {
			activityLog.push(line);
			if (activityLog.length > 30) {
				activityLog.shift();
			}
			if (persist) {
				this.showProgressLine(`IOSM init verify: ${line}`);
			}
		};
		const setVerifyLiveStatus = (message: string): void => {
			this.setWorkingMessage(`${message} (${appKey(this.keybindings, "interrupt")} to interrupt)`);
		};
		const unsubscribe = session.subscribe((event) => {
			onEvent?.(event);
			if (event.type === "turn_start") {
				pushActivity("agent turn started");
				setVerifyLiveStatus("Verifying workspace...");
				return;
			}
			if (event.type !== "tool_execution_start") {
				return;
			}
			toolExecutions += 1;
			if (event.toolName === "bash") {
				const commandRaw =
					event.args && typeof event.args === "object" && "command" in event.args
						? String((event.args as { command?: unknown }).command ?? "")
						: "";
				const preview = commandRaw.replace(/\s+/g, " ").trim().slice(0, 68);
				const line = `bash #${toolExecutions}${preview ? ` ${preview}${commandRaw.length > 68 ? "..." : ""}` : ""}`;
				pushActivity(line);
				setVerifyLiveStatus(`Verifying workspace · ${line}`);
				return;
			}
			const line = `${event.toolName} #${toolExecutions}`;
			pushActivity(line);
			setVerifyLiveStatus(`Verifying workspace · ${line}`);
		});
		this.iosmVerificationSession = session;

		try {
			if (!session.model) {
				return {
					completed: false,
					skippedReason:
						modelFallbackMessage ??
						"No model available for agent verification. Configure /login or an API key, then re-run /init.",
					activityLog,
				};
			}

			const timeoutMs = 180_000;
			const startedAt = Date.now();
			const heartbeatMs = 10_000;
			let nextPersistentHeartbeatSec = 30;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
			try {
				pushActivity("waiting for model response...", true);
				setVerifyLiveStatus("Waiting for model response...");
				heartbeatHandle = setInterval(() => {
					const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
					if (toolExecutions === 0 && elapsedSec >= nextPersistentHeartbeatSec) {
						pushActivity(`still waiting for model response (${elapsedSec}s)`, true);
						nextPersistentHeartbeatSec += 30;
					}
					setVerifyLiveStatus(
						toolExecutions === 0
							? `Waiting for model response... ${elapsedSec}s`
							: `Verifying workspace... ${elapsedSec}s · tool calls=${toolExecutions}`,
					);
				}, heartbeatMs);
				await Promise.race([
					session.prompt(buildIosmAgentVerificationPrompt(result), {
						expandPromptTemplates: false,
						skipIosmAutopilot: true,
						source: "interactive",
					}),
					new Promise<never>((_resolve, reject) => {
						timeoutHandle = setTimeout(() => {
							reject(new Error(`Verifier timeout after ${Math.round(timeoutMs / 1000)}s.`));
						}, timeoutMs);
					}),
				]);
			} finally {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (heartbeatHandle) {
					clearInterval(heartbeatHandle);
				}
			}

			const messages = session.state.messages;
			let lastAssistant: AssistantMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const message = messages[index];
				if (message.role === "assistant") {
					lastAssistant = message as AssistantMessage;
					break;
				}
			}

			if (
				lastAssistant &&
				(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
			) {
				pushActivity(`agent finished with ${lastAssistant.stopReason}`);
				if (lastAssistant.stopReason === "aborted") {
					return {
						completed: false,
						cancelled: true,
						skippedReason: "Cancelled by user.",
						tracePath:
							session.sessionTracePath ??
							(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
						activityLog,
					};
				}
				return {
					completed: false,
					error: lastAssistant.errorMessage ?? `Verifier finished with ${lastAssistant.stopReason}.`,
					tracePath:
						session.sessionTracePath ??
						(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
					activityLog,
				};
			}

			let authoredGuide: string | undefined;
			try {
				pushActivity("authoring IOSM.md from repository evidence...");
				setVerifyLiveStatus("Authoring IOSM.md...");
				await session.prompt(buildIosmGuideAuthoringPrompt(result), {
					expandPromptTemplates: false,
					skipIosmAutopilot: true,
					source: "interactive",
				});
				const guideAssistant = (() => {
					const messages = session.state.messages;
					for (let index = messages.length - 1; index >= 0; index--) {
						const message = messages[index];
						if (message.role === "assistant") {
							return message as AssistantMessage;
						}
					}
					return undefined;
				})();
				const guideText = extractAssistantText(guideAssistant);
				const normalizedGuide = normalizeIosmGuideMarkdown(guideText);
				if (normalizedGuide.trim().length > 0) {
					authoredGuide = normalizedGuide;
					pushActivity("IOSM.md authored by agent");
				}
			} catch {
				pushActivity("agent IOSM.md authoring failed; using structured fallback");
			}

			let current: IosmMetricSnapshot | undefined;
			let guidePath: string | undefined;
			try {
				const report = readIosmCycleReport(result.rootDir, cycleId);
				current = createMetricSnapshot(report);
				if (authoredGuide) {
					guidePath = getIosmGuidePath(targetDir);
					fs.writeFileSync(guidePath, authoredGuide, "utf8");
				} else {
					guidePath = writeIosmGuideDocument(
						{
							rootDir: targetDir,
							cycleId,
							assessmentSource: "verified",
							metrics: report.metrics,
							iosmIndex: report.iosm_index,
							decisionConfidence: report.decision_confidence,
							goals: report.goals,
							filesAnalyzed: result.analysis.files_analyzed,
							sourceFileCount: result.analysis.source_file_count,
							testFileCount: result.analysis.test_file_count,
							docFileCount: result.analysis.doc_file_count,
						},
						true,
					).path;
				}
			} catch {
				current = undefined;
				guidePath = undefined;
			}

			let historyPath: string | undefined;
			try {
				const history = recordIosmCycleHistory(result.rootDir, cycleId);
				historyPath = history.historyPath;
			} catch {
				historyPath = undefined;
			}

			pushActivity(`completed (${toolExecutions} tool calls)`, true);
			return {
				completed: true,
				current,
				historyPath,
				guidePath,
				toolCalls: toolExecutions,
				tracePath:
					session.sessionTracePath ??
					(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
				activityLog,
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (isAbortLikeMessage(message)) {
				pushActivity("cancelled by user", true);
				return {
					completed: false,
					cancelled: true,
					skippedReason: "Cancelled by user.",
					activityLog,
				};
			}
			pushActivity(`failed (${message})`);
			this.showWarning(`IOSM init verify: failed (${message})`);
			return {
				completed: false,
				error: message,
				activityLog,
			};
		} finally {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// Best-effort shutdown to avoid a stuck verification loader.
			}
			if (this.iosmVerificationSession === session) {
				this.iosmVerificationSession = undefined;
			}
			unsubscribe();
			session.dispose();
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();
			this.pendingWorkingMessage = undefined;
			this.ui.requestRender();
		}
	}

	private getLastAssistantMessage(): AssistantMessage | undefined {
		return this.session.messages
			.slice()
			.reverse()
			.find((message): message is AssistantMessage => {
				if (message.role !== "assistant") {
					return false;
				}
				return !(message.stopReason === "aborted" && message.content.length === 0);
			});
	}

	private sanitizeAssistantDisplayMessage(message: AssistantMessage): AssistantMessage {
		const hideAllTextForOrchestration = this.activeAssistantOrchestrationContext;
		let changed = false;
		const nextContent = message.content.map((content) => {
			if (content.type !== "text") return content;
			if (hideAllTextForOrchestration) {
				if (content.text !== "") {
					changed = true;
				}
				return { ...content, text: "" };
			}
			return content;
		});

		return changed ? { ...message, content: nextContent } : message;
	}

	private resolveMentionedAgent(text: string): string | undefined {
		const cwd = this.sessionManager.getCwd();
		const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
		if (loaded.agents.length === 0) return undefined;
		const matches = text.matchAll(/(?:^|\s)@([^\s]+)/g);
		for (const match of matches) {
			const candidate = (match[1] ?? "").trim();
			const resolved = resolveCustomSubagentReference(candidate, loaded.agents);
			if (resolved) {
				return resolved;
			}
		}
		return undefined;
	}

	private isCapabilityQuery(text: string): boolean {
		const normalized = text.toLowerCase().trim();
		if (!normalized) return true;
		return (
			normalized === "?" ||
			normalized === "help" ||
			normalized === "--help" ||
			normalized === "/help" ||
			normalized === "/capabilities" ||
			normalized === "capabilities"
		);
	}

	private async promptWithTaskFallback(userInput: string): Promise<void> {
		const mentionedAgent = this.resolveMentionedAgent(userInput);
		if (mentionedAgent) {
			const cleaned = userInput.replace(/(?:^|\s)@[^\s]+/g, " ").trim();
			if (this.isCapabilityQuery(cleaned)) {
				const cwd = this.sessionManager.getCwd();
				const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
				const agent = loaded.agents.find((item) => item.name === mentionedAgent);
				if (agent) {
					const capabilityPrompt = [
						"<agent_capability_query>",
						`agent_name: ${agent.name}`,
						`description: ${agent.description}`,
						`profile: ${agent.profile ?? "full"}`,
						`model: ${agent.model ?? "default"}`,
						`background: ${agent.background ? "true" : "false"}`,
						`tools: ${agent.tools?.join(", ") ?? "default profile tools"}`,
						`disallowed_tools: ${agent.disallowedTools?.join(", ") ?? "none"}`,
						"",
						"agent_instructions:",
						agent.instructions,
						"",
						`user_question: ${cleaned || "what can you do?"}`,
						"Answer normally and concisely in plain language. Do not run task tool for this query.",
						"</agent_capability_query>",
					].join("\n");
					await this.session.prompt(capabilityPrompt, {
						expandPromptTemplates: false,
						source: "interactive",
					});
					return;
				}
			}
			const mentionTask = cleaned.length > 0 ? cleaned : userInput;
			const orchestrationAwareAgent = /orchestrator/i.test(mentionedAgent);
			const mentionMode: OrchestrationMode = orchestrationAwareAgent ? "parallel" : "sequential";
			const mentionMaxParallel = orchestrationAwareAgent ? MAX_ORCHESTRATION_PARALLEL : undefined;
			const mentionPrompt = [
				`<orchestrate mode="${mentionMode}" agents="1"${mentionMaxParallel ? ` max_parallel="${mentionMaxParallel}"` : ""}>`,
				`- agent 1: profile=${this.activeProfileName} cwd=${this.sessionManager.getCwd()} agent=${mentionedAgent}`,
				`task: ${mentionTask}`,
				"constraints:",
				"- user selected a concrete custom agent via @mention",
				`- MUST call task tool with agent="${mentionedAgent}"`,
				...(orchestrationAwareAgent
					? [
							"- Include delegate_parallel_hint in the task call.",
							`- If user explicitly requested an agent count, set delegate_parallel_hint to that count (clamp 1..${MAX_SUBAGENT_DELEGATE_PARALLEL}).`,
							`- Otherwise set delegate_parallel_hint based on complexity: simple=1, medium=3-6, complex/risky=7-${MAX_SUBAGENT_DELEGATE_PARALLEL}.`,
							"- For non-trivial tasks, prefer delegate_parallel_hint >= 2 and split into independent <delegate_task> workstreams.",
							'- Prefer existing custom agents for delegated work when suitable (use <delegate_task agent="name" ...>).',
							"- If no existing custom agent fits, create focused delegate streams via profile-based <delegate_task> blocks.",
							"- If single-agent execution is still chosen, include one line: DELEGATION_IMPOSSIBLE: <reason>.",
						]
					: []),
				"</orchestrate>",
			].join("\n");
			await this.session.prompt(mentionPrompt, {
				expandPromptTemplates: false,
				source: "interactive",
			});
			return;
		}
		if (this.activeProfileName === "meta") {
			await promptMetaWithParallelismGuard({
				session: this.session,
				userInput,
			});
			return;
		}
		await this.session.prompt(userInput);
	}

	private createIosmVerificationEventBridge(options?: {
		loaderMessage?: string;
		hideAssistantText?: boolean;
	}): (event: AgentSessionEvent) => void {
		const loaderMessage =
			options?.loaderMessage ?? `Verifying workspace... (${appKey(this.keybindings, "interrupt")} to interrupt)`;
		const hideAssistantText = options?.hideAssistantText === true;
		let verifyStreamingComponent: AssistantMessageComponent | undefined;
		let verifyStreamingMessage: AssistantMessage | undefined;
		const verifyPendingTools = new Map<string, ToolExecutionComponent>();

		return (event: AgentSessionEvent): void => {
			switch (event.type) {
				case "agent_start":
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
					}
					this.statusContainer.clear();
					this.loadingAnimation = new DecryptLoader(
						this.ui,
						(s) => theme.fg("accent", s),
						(t) => theme.fg("muted", t),
						loaderMessage,
					);
					this.statusContainer.addChild(this.loadingAnimation);
					break;

				case "message_start":
					if (event.message.role === "assistant" && !hideAssistantText) {
						verifyStreamingComponent = new AssistantMessageComponent(
							undefined,
							false,
							this.getMarkdownThemeWithSettings(),
						);
						verifyStreamingMessage = event.message as AssistantMessage;
						this.chatContainer.addChild(verifyStreamingComponent);
						verifyStreamingComponent.updateContent(verifyStreamingMessage);
					}
					break;

				case "message_update":
					if (verifyStreamingComponent && event.message.role === "assistant") {
						verifyStreamingMessage = event.message as AssistantMessage;
						verifyStreamingComponent.updateContent(verifyStreamingMessage);
						for (const content of verifyStreamingMessage.content) {
							if (content.type === "toolCall" && !verifyPendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.arguments,
									{ showImages: this.settingsManager.getShowImages() },
									this.getRegisteredToolDefinition(content.name),
									this.ui,
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								verifyPendingTools.set(content.id, component);
							}
						}
					}
					break;

				case "message_end":
					if (verifyStreamingComponent && event.message.role === "assistant") {
						verifyStreamingMessage = event.message as AssistantMessage;
						verifyStreamingComponent.updateContent(verifyStreamingMessage);
						verifyStreamingComponent = undefined;
						verifyStreamingMessage = undefined;
					}
					break;

				case "tool_execution_start":
					if (!verifyPendingTools.has(event.toolCallId)) {
						const component = new ToolExecutionComponent(
							event.toolName,
							event.args,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(event.toolName),
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						verifyPendingTools.set(event.toolCallId, component);
					}
					break;

				case "tool_execution_update": {
					const component = verifyPendingTools.get(event.toolCallId);
					if (component) {
						component.updateResult({ ...event.partialResult, isError: false }, true);
					}
					break;
				}

				case "tool_execution_end": {
					const component = verifyPendingTools.get(event.toolCallId);
					if (component) {
						component.updateResult({ ...event.result, isError: event.isError });
						verifyPendingTools.delete(event.toolCallId);
					}
					break;
				}

				case "agent_end":
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
						this.statusContainer.clear();
					}
					verifyPendingTools.clear();
					break;
			}

			this.ui.requestRender();
		};
	}

	private resolveIosmSnapshot(
		result: IosmInitResult,
		verification: IosmInitVerificationSummary | undefined,
	): IosmMetricSnapshot {
		let snapshot: IosmMetricSnapshot | undefined = verification?.current;
		if (!snapshot && result.cycle) {
			try {
				snapshot = createMetricSnapshot(readIosmCycleReport(result.rootDir, result.cycle.cycleId));
			} catch {
				snapshot = undefined;
			}
		}

		return (
			snapshot ?? {
				metrics: result.analysis.metrics,
				iosm_index: null,
				decision_confidence: null,
			}
		);
	}

	private async runIosmRefreshPass(options: {
		cwd: string;
		force: boolean;
		agentVerify: boolean;
	}): Promise<IosmAutomationRefreshResult> {
		const initResult = await initIosmWorkspace({ cwd: options.cwd, force: options.force });
		let verification: IosmInitVerificationSummary | undefined;
		if (options.agentVerify) {
			verification = await this.runIosmInitAgentVerification(
				initResult,
				options.cwd,
				this.createIosmVerificationEventBridge(),
			);
		}

		let cycleDecision: IosmDecision | undefined;
		if (initResult.cycle) {
			try {
				cycleDecision = inspectIosmCycle(initResult.rootDir, initResult.cycle.cycleId).decision;
			} catch {
				cycleDecision = undefined;
			}
		}

		return {
			initResult,
			verification,
			snapshot: this.resolveIosmSnapshot(initResult, verification),
			guidePath: verification?.guidePath ?? getIosmGuidePath(initResult.rootDir),
			cycleDecision,
		};
	}

	private parseIosmAutomationSlashCommand(
		text: string,
	): { targetIndex?: number; maxIterations?: number; forceInit: boolean } | undefined {
		const args = this.parseSlashArgs(text).slice(1);
		let targetIndex: number | undefined;
		let maxIterations: number | undefined;
		let forceInit = false;

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--force-init" || arg === "--force") {
				forceInit = true;
				continue;
			}
			if (arg === "--max-iterations") {
				const nextValue = args[index + 1];
				const parsed = nextValue ? Number.parseInt(nextValue, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1) {
					this.showWarning('Usage: /iosm [target-index] [--max-iterations N] [--force-init]');
					return undefined;
				}
				maxIterations = parsed;
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /iosm: ${arg}`);
				this.showWarning('Usage: /iosm [target-index] [--max-iterations N] [--force-init]');
				return undefined;
			}

			if (targetIndex !== undefined) {
				this.showWarning(`Unexpected argument for /iosm: ${arg}`);
				this.showWarning('Usage: /iosm [target-index] [--max-iterations N] [--force-init]');
				return undefined;
			}

			const parsed = Number.parseFloat(arg);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
				this.showWarning(`Invalid target index for /iosm: ${arg}`);
				this.showWarning("Target index must be a number in the range 0.0 to 1.0.");
				return undefined;
			}
			targetIndex = parsed;
		}

		return { targetIndex, maxIterations, forceInit };
	}

	private getSwarmHelpText(): string {
		return [
			"Usage:",
			"  /swarm run <task> [--max-parallel N] [--budget-usd X]",
			"  /swarm from-singular <run-id> --option <1|2|3> [--max-parallel N] [--budget-usd X]",
			"  /swarm watch [run-id]",
			"  /swarm retry <run-id> <task-id> [--reset-brief]",
			"  /swarm resume <run-id>",
			"  /swarm help",
			"",
			"Consistency model:",
			"  Scopes -> Touches -> Locks -> Gates -> Done",
		].join("\n");
	}

	private buildSwarmRecommendationFromOrchestrate(parsed: ParsedOrchestrateCommand): {
		recommend: boolean;
		reasons: string[];
		command: string;
	} {
		const reasons: string[] = [];
		let score = 0;
		const task = parsed.task.replace(/\s+/g, " ").trim();
		const normalizedTask = task.toLowerCase();
		const dependencyEdges = parsed.dependencies?.reduce((sum, entry) => sum + entry.dependsOn.length, 0) ?? 0;
		const effectiveParallel = parsed.mode === "parallel" ? parsed.maxParallel ?? parsed.agents : 1;

		const highRiskPattern =
			/\b(refactor|rewrite|migration|migrate|breaking|rollback|security|auth|authentication|authorization|permission|payment|billing|schema|database|critical)\b/i;
		const mediumRiskPattern = /\b(cross[-\s]?module|architecture|infra|platform|multi[-\s]?file|integration)\b/i;

		if (highRiskPattern.test(normalizedTask)) {
			score += 2;
			reasons.push("task has high-risk keywords");
		} else if (mediumRiskPattern.test(normalizedTask)) {
			score += 1;
			reasons.push("task has architecture/cross-module scope");
		}
		if (parsed.agents >= 4) {
			score += 2;
			reasons.push(`high agent count (${parsed.agents})`);
		} else if (parsed.agents >= 3) {
			score += 1;
			reasons.push(`multi-agent run (${parsed.agents})`);
		}
		if (dependencyEdges >= 3) {
			score += 2;
			reasons.push(`complex dependency graph (${dependencyEdges} edges)`);
		} else if (dependencyEdges > 0) {
			score += 1;
			reasons.push(`dependency graph present (${dependencyEdges} edges)`);
		}
		if (effectiveParallel >= 3) {
			score += 1;
			reasons.push(`high parallelism (${effectiveParallel})`);
		}
		if ((parsed.locks?.length ?? 0) > 0) {
			score += 1;
			reasons.push("explicit lock coordination requested");
		}
		if (task.length >= 180) {
			score += 1;
			reasons.push("long task brief");
		}

		const safeTask = task.replace(/"/g, "'");
		const commandParts = [`/swarm run "${safeTask}"`];
		if (parsed.maxParallel !== undefined && parsed.maxParallel > 0) {
			commandParts.push(`--max-parallel ${parsed.maxParallel}`);
		}

		return {
			recommend: score >= 3,
			reasons,
			command: commandParts.join(" "),
		};
	}

	private isEffectiveContractReady(contract: EngineeringContract): boolean {
		const hasText = (value: string | undefined): boolean => typeof value === "string" && value.trim().length > 0;
		const hasList = (value: string[] | undefined): boolean => Array.isArray(value) && value.some((item) => item.trim().length > 0);
		return (
			hasText(contract.goal) ||
			hasList(contract.scope_include) ||
			hasList(contract.constraints) ||
			hasList(contract.quality_gates) ||
			hasList(contract.definition_of_done)
		);
	}

	private parseContractListInput(raw: string | undefined): string[] {
		if (!raw) return [];
		return raw
			.split(/[\n;,]+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	private buildAutoDraftContractFromTask(task: string): EngineeringContract {
		const normalizedTask = task.replace(/\s+/g, " ").trim();
		const hints = loadProjectIndex(this.sessionManager.getCwd());
		const matchedFiles = hints ? queryProjectIndex(hints, task, 8).matches.map((entry) => entry.path) : [];
		const scopeInclude = matchedFiles.length > 0 ? matchedFiles.map((filePath) => filePath.split("/").slice(0, 2).join("/")).slice(0, 6) : [];
		return normalizeEngineeringContract({
			goal: normalizedTask.length > 0 ? normalizedTask : "Deliver requested change safely with bounded blast radius.",
			scope_include: scopeInclude.length > 0 ? [...new Set(scopeInclude)].map((scope) => `${scope}/**`) : ["src/**", "test/**"],
			scope_exclude: ["node_modules/**", "dist/**", ".iosm/**"],
			constraints: [
				"Preserve backward compatibility unless explicitly approved.",
				"Keep changes scoped to declared touch zones.",
			],
			quality_gates: [
				"Targeted tests for touched modules pass.",
				"Lint/type checks pass for changed files.",
			],
			definition_of_done: [
				"Implementation merged with verification evidence.",
				"Risk notes and rollback path documented.",
			],
		});
	}

	private async runSwarmContractGuidedInterview(task: string): Promise<EngineeringContract | undefined> {
		const goal = await this.showExtensionInput(
			"Swarm contract: goal (required)",
			task.trim() || "Deliver requested change safely.",
		);
		if (goal === undefined) return undefined;
		const scopeInclude = await this.showExtensionInput(
			"Swarm contract: scope_include (comma/newline separated)",
			"src/**, test/**",
		);
		if (scopeInclude === undefined) return undefined;
		const scopeExclude = await this.showExtensionInput(
			"Swarm contract: scope_exclude (comma/newline separated)",
			"node_modules/**, dist/**, .iosm/**",
		);
		if (scopeExclude === undefined) return undefined;
		const constraints = await this.showExtensionInput(
			"Swarm contract: constraints (comma/newline separated)",
			"no breaking API changes; no unrelated refactors",
		);
		if (constraints === undefined) return undefined;
		const gates = await this.showExtensionInput(
			"Swarm contract: quality_gates (comma/newline separated)",
			"targeted tests pass; lint/type checks pass",
		);
		if (gates === undefined) return undefined;
		const done = await this.showExtensionInput(
			"Swarm contract: definition_of_done (comma/newline separated)",
			"implementation complete; validation evidence attached",
		);
		if (done === undefined) return undefined;

		return normalizeEngineeringContract({
			goal: goal.trim(),
			scope_include: this.parseContractListInput(scopeInclude),
			scope_exclude: this.parseContractListInput(scopeExclude),
			constraints: this.parseContractListInput(constraints),
			quality_gates: this.parseContractListInput(gates),
			definition_of_done: this.parseContractListInput(done),
		});
	}

	private async ensureSwarmEffectiveContract(task: string): Promise<EngineeringContract | undefined> {
		const initialState = this.getContractStateSafe();
		if (!initialState) return undefined;
		if (this.isEffectiveContractReady(initialState.effective)) {
			return initialState.effective;
		}

		while (true) {
			const selected = await this.showExtensionSelector(
				[
					"/swarm requires an effective /contract before execution can start.",
					"Choose how to bootstrap contract policy:",
				].join("\n"),
				[
					"Auto-draft from task (Recommended)",
					"Guided Q&A",
					"Open manual /contract editor",
					"Cancel",
				],
			);
			if (!selected || selected === "Cancel") {
				this.showStatus("Swarm cancelled: contract bootstrap not completed.");
				return undefined;
			}

			if (selected.startsWith("Auto-draft")) {
				try {
					const draft = this.buildAutoDraftContractFromTask(task);
					this.contractService.save("session", draft);
					this.syncRuntimePromptSuffix();
					this.showStatus("Swarm contract bootstrap: auto-draft saved to session overlay.");
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
			} else if (selected === "Guided Q&A") {
				const drafted = await this.runSwarmContractGuidedInterview(task);
				if (!drafted) {
					this.showStatus("Swarm contract interview cancelled.");
				} else {
					try {
						this.contractService.save("session", drafted);
						this.syncRuntimePromptSuffix();
						this.showStatus("Swarm contract bootstrap: guided contract saved to session overlay.");
					} catch (error) {
						this.showWarning(error instanceof Error ? error.message : String(error));
					}
				}
			} else if (selected === "Open manual /contract editor") {
				await this.runContractInteractiveMenu();
			}

			const state = this.getContractStateSafe();
			if (!state) return undefined;
			if (this.isEffectiveContractReady(state.effective)) {
				return state.effective;
			}
			this.showWarning("Effective contract is still empty. Swarm execution remains blocked.");
		}
	}

	private async maybeWarnSwarmSemantic(scaleMode: RepoScaleMode): Promise<string> {
		if (scaleMode === "small") {
			return "optional_for_small_repo";
		}
		try {
			const status = await this.createSemanticRuntime().status();
			if (!status.configured) {
				this.showWarning("Swarm recommendation: configure semantic index via /semantic setup and /semantic index.");
				return "not_configured";
			}
			if (!status.enabled) {
				this.showWarning("Swarm recommendation: enable semantic index in /semantic setup for medium/large repositories.");
				return "configured_but_disabled";
			}
			if (!status.indexed) {
				this.showWarning("Swarm recommendation: run /semantic index before long swarm runs.");
				return "configured_not_indexed";
			}
			if (status.stale) {
				const action = status.staleReason === "provider_changed" || status.staleReason === "dimension_mismatch" ? "/semantic rebuild" : "/semantic index";
				this.showWarning(`Swarm recommendation: semantic index is stale (${status.staleReason ?? "unknown"}). Run ${action}.`);
				return `stale:${status.staleReason ?? "unknown"}`;
			}
			return `ready:${status.provider}/${status.model}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showWarning(`Swarm recommendation: semantic status unavailable (${message}). Use /semantic status.`);
			return `status_unavailable:${message}`;
		}
	}

	private ensureSwarmProjectIndex(task: string): { index: ProjectIndex; scaleMode: RepoScaleMode; rebuilt: boolean } {
		const cwd = this.sessionManager.getCwd();
		const existing = loadProjectIndex(cwd);
		if (existing) {
			if (existing.meta.repoScaleMode === "small") {
				return { index: existing, scaleMode: "small", rebuilt: false };
			}
			const ensured = ensureProjectIndex(cwd, existing.meta.repoScaleMode);
			return { index: ensured.index, scaleMode: ensured.index.meta.repoScaleMode, rebuilt: ensured.rebuilt };
		}

		const quick = buildProjectIndex(cwd, { maxFiles: 6_000 });
		const scaleMode = quick.meta.repoScaleMode;
		if (scaleMode === "small") {
			return { index: quick, scaleMode, rebuilt: true };
		}
		saveProjectIndex(cwd, quick);
		return { index: quick, scaleMode, rebuilt: true };
	}

	private parseSwarmCommand(text: string): ParsedSwarmCommand | undefined {
		const args = this.parseSlashArgs(text).slice(1);
		if (args.length === 0) {
			return { subcommand: "help" };
		}

		const subcommand = (args[0] ?? "").toLowerCase();
		const rest = args.slice(1);
		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			return { subcommand: "help" };
		}

		if (subcommand === "watch") {
			return {
				subcommand: "watch",
				runId: rest[0],
			};
		}

		if (subcommand === "resume") {
			const runId = rest[0];
			if (!runId) {
				this.showWarning("Usage: /swarm resume <run-id>");
				return undefined;
			}
			return { subcommand: "resume", runId };
		}

		if (subcommand === "retry") {
			const runId = rest[0];
			const taskId = rest[1];
			if (!runId || !taskId) {
				this.showWarning("Usage: /swarm retry <run-id> <task-id> [--reset-brief]");
				return undefined;
			}
			const resetBrief = rest.slice(2).some((token) => token === "--reset-brief");
			return { subcommand: "retry", runId, taskId, resetBrief };
		}

		let maxParallel: number | undefined;
		let budgetUsd: number | undefined;
		const taskParts: string[] = [];
		let fromSingularOption: number | undefined;
		let fromSingularRunId: string | undefined;

		for (let index = 0; index < rest.length; index += 1) {
			const token = rest[index] ?? "";
			if (token === "--max-parallel") {
				const next = rest[index + 1];
				const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ORCHESTRATION_PARALLEL) {
					this.showWarning(`Invalid --max-parallel value (expected 1..${MAX_ORCHESTRATION_PARALLEL}).`);
					return undefined;
				}
				maxParallel = parsed;
				index += 1;
				continue;
			}
			if (token === "--budget-usd") {
				const next = rest[index + 1];
				const parsed = next ? Number.parseFloat(next) : Number.NaN;
				if (!Number.isFinite(parsed) || parsed <= 0) {
					this.showWarning("Invalid --budget-usd value (expected > 0).");
					return undefined;
				}
				budgetUsd = parsed;
				index += 1;
				continue;
			}
			if (token === "--option") {
				const next = rest[index + 1];
				const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
					this.showWarning("Invalid --option value (expected 1|2|3).");
					return undefined;
				}
				fromSingularOption = parsed;
				index += 1;
				continue;
			}
			if (token.startsWith("-")) {
				this.showWarning(`Unknown option for /swarm ${subcommand}: ${token}`);
				return undefined;
			}
			if (subcommand === "from-singular" && !fromSingularRunId) {
				fromSingularRunId = token;
				continue;
			}
			taskParts.push(token);
		}

		if (subcommand === "run") {
			const task = taskParts.join(" ").trim();
			if (!task) {
				this.showWarning("Usage: /swarm run <task> [--max-parallel N] [--budget-usd X]");
				return undefined;
			}
			return { subcommand, task, maxParallel, budgetUsd };
		}

		if (subcommand === "from-singular") {
			if (!fromSingularRunId || !fromSingularOption) {
				this.showWarning("Usage: /swarm from-singular <run-id> --option <1|2|3> [--max-parallel N] [--budget-usd X]");
				return undefined;
			}
			return {
				subcommand,
				runId: fromSingularRunId,
				option: fromSingularOption,
				maxParallel,
				budgetUsd,
			};
		}

		this.showWarning(`Unknown /swarm subcommand "${subcommand}". Use /swarm help.`);
		return undefined;
	}

	private buildSwarmBootstrapState(runId: string, plan: SwarmPlan, budgetUsd?: number): SwarmRuntimeState {
		const tasks: SwarmRuntimeState["tasks"] = {};
		for (const task of plan.tasks) {
			tasks[task.id] = {
				id: task.id,
				status: task.depends_on.length === 0 ? "ready" : "pending",
				attempts: 0,
				depends_on: [...task.depends_on],
				touches: [...task.touches],
				scopes: [...task.scopes],
			};
		}
		return {
			runId,
			status: "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			tick: 0,
			noProgressTicks: 0,
			readyQueue: Object.values(tasks)
				.filter((task) => task.status === "ready")
				.map((task) => task.id),
			blockedTasks: [],
			tasks,
			locks: {},
			retries: {},
			budget: {
				limitUsd: budgetUsd,
				spentUsd: 0,
				warned80: false,
				hardStopped: false,
			},
		};
	}

	private buildSwarmRunMeta(input: {
		runId: string;
		source: "plain" | "singular";
		request: string;
		contract: EngineeringContract;
		repoScaleMode: RepoScaleMode;
		semanticStatus: string;
		maxParallel: number;
		budgetUsd?: number;
		linkedSingularRunId?: string;
		linkedSingularOption?: string;
	}): SwarmRunMeta {
		return {
			runId: input.runId,
			createdAt: new Date().toISOString(),
			source: input.source,
			request: input.request,
			contract: input.contract,
			contractHash: crypto.createHash("sha256").update(JSON.stringify(input.contract)).digest("hex").slice(0, 16),
			repoScaleMode: input.repoScaleMode,
			semanticStatus: input.semanticStatus,
			maxParallel: input.maxParallel,
			budgetUsd: input.budgetUsd,
			linkedSingularRunId: input.linkedSingularRunId,
			linkedSingularOption: input.linkedSingularOption,
		};
	}

	private resolveSwarmTaskProfile(task: SwarmTaskPlan): AgentProfileName {
		if (task.concurrency_class === "analysis") return "explore";
		if (task.concurrency_class === "verification" || task.concurrency_class === "tests") return "iosm_verifier";
		if (task.concurrency_class === "docs") return "plan";
		return "full";
	}

	private estimateSwarmTaskCostUsd(task: SwarmTaskPlan): number {
		if (task.severity === "high") return 0.35;
		if (task.severity === "medium") return 0.2;
		return 0.12;
	}

	private deriveSwarmTaskDelegateParallelHint(task: SwarmTaskPlan): number {
		const brief = task.brief.toLowerCase();
		const hasComplexKeyword = /(refactor|migration|rewrite|split|cross[-\s]?module|architecture|platform|integration|security|auth)/i.test(
			brief,
		);
		const hasVeryComplexSignal =
			/(overhaul|major|system-wide|cross-cutting|multi-service|facet|registry)/i.test(brief) ||
			task.touches.length >= 5 ||
			task.scopes.length >= 4;
		if (task.severity === "low" && task.touches.length <= 2 && task.scopes.length <= 2 && !hasComplexKeyword) {
			return 1;
		}
		if (task.severity === "high" && (hasVeryComplexSignal || hasComplexKeyword || task.touches.length >= 3)) {
			return 10;
		}
		if (task.severity === "high") return 8;
		if (task.severity === "medium" && (hasVeryComplexSignal || task.touches.length >= 4 || hasComplexKeyword)) return 7;
		if (task.severity === "medium") return 5;
		return hasComplexKeyword ? 3 : 1;
	}

	private parseSwarmSpawnCandidates(output: string, parentTaskId: string): SwarmDispatchResult["spawnCandidates"] {
		const lines = output.split(/\r?\n/);
		const results: NonNullable<SwarmDispatchResult["spawnCandidates"]> = [];
		for (const rawLine of lines) {
			const line = rawLine.trim();
			const match = line.match(/^[*-]\s+(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(low|medium|high)\s*$/i);
			if (!match) continue;
			results.push({
				description: match[1]!.trim(),
				path: match[2]!.trim(),
				changeType: match[3]!.trim(),
				severity: match[4]!.trim().toLowerCase() as "low" | "medium" | "high",
				parentTaskId,
			});
			if (results.length >= 10) break;
		}
		return results;
	}

	private loadSingularAnalysisByRunId(runId: string): SingularAnalysisResult | undefined {
		const analysisPath = path.join(this.singularService.getAnalysesRoot(), runId, "analysis.json");
		if (!fs.existsSync(analysisPath)) return undefined;
		try {
			return JSON.parse(fs.readFileSync(analysisPath, "utf8")) as SingularAnalysisResult;
		} catch {
			return undefined;
		}
	}

	private async dispatchSwarmTaskWithAgent(input: {
		meta: SwarmRunMeta;
		task: SwarmTaskPlan;
		runtime: SwarmTaskRuntimeState;
		contract: EngineeringContract;
	}): Promise<SwarmDispatchResult> {
		const model = this.session.model;
		if (!model) {
			return {
				taskId: input.task.id,
				status: "error",
				error: "No active model configured for swarm task dispatch.",
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}

		const profile = this.resolveSwarmTaskProfile(input.task);
		const delegateParallelHint = this.deriveSwarmTaskDelegateParallelHint(input.task);
		const safeDescription = input.task.brief.replace(/\s+/g, " ").trim().slice(0, 120).replace(/"/g, "'");
		const prompt = [
			`<swarm_task run_id="${input.meta.runId}" task_id="${input.task.id}" profile_hint="${profile}">`,
			`request: ${input.meta.request}`,
			`task_brief: ${input.task.brief}`,
			`touches: ${input.runtime.touches.join(", ") || "(none)"}`,
			`scopes: ${input.runtime.scopes.join(", ") || "(none)"}`,
			`constraints: ${(input.contract.constraints ?? []).join("; ") || "(none)"}`,
			`quality_gates: ${(input.contract.quality_gates ?? []).join("; ") || "(none)"}`,
			"",
			"Execution requirements:",
			`- Use the task tool exactly once with description="${safeDescription || input.task.id}", profile="${profile}", delegate_parallel_hint=${delegateParallelHint}, run_id="${input.meta.runId}", task_id="${input.task.id}".`,
			`- Inside this single task call, prefer decomposition into <delegate_task> subtasks when delegate_parallel_hint >= 2 (target parallel fan-out up to ${delegateParallelHint}).`,
			"- If decomposition is not beneficial, continue with single-agent execution (optional note: DELEGATION_IMPOSSIBLE: <reason>).",
			"- Keep edits inside declared scopes/touches. If scope expansion is required, explain and stop.",
			"- If blocked, respond with line: BLOCKED: <reason>",
			"- Optional spawn candidates format: '- <description> | <path> | <change_type> | <low|medium|high>'",
			"</swarm_task>",
		].join("\n");

		const cwd = this.sessionManager.getCwd();
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = this.session.modelRegistry.authStorage;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
		});
		try {
			await resourceLoader.reload();
		} catch (error) {
			return {
				taskId: input.task.id,
				status: "error",
				error: `Failed to initialize swarm task runtime: ${error instanceof Error ? error.message : String(error)}`,
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}

		let swarmSession: AgentSession | undefined;
		try {
			const created = await createAgentSession({
				cwd,
				sessionManager: SessionManager.inMemory(),
				settingsManager,
				authStorage,
				modelRegistry: this.session.modelRegistry,
				resourceLoader,
				model,
				thinkingLevel: this.session.thinkingLevel,
				profile: "full",
				enableTaskTool: true,
			});
			swarmSession = created.session;
		} catch (error) {
			return {
				taskId: input.task.id,
				status: "error",
				error: `Failed to create isolated swarm session: ${error instanceof Error ? error.message : String(error)}`,
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}

		let taskToolCalls = 0;
		const taskErrors: string[] = [];
		let delegatedFailed = 0;
		let delegatedTasks = 0;
		const delegatedFailureCauses = new Map<string, number>();
		const accumulateFailureCauses = (raw: unknown): void => {
			if (!raw || typeof raw !== "object") return;
			for (const [cause, count] of Object.entries(raw as Record<string, unknown>)) {
				if (typeof cause !== "string" || !cause.trim()) continue;
				const numeric = typeof count === "number" ? count : Number.parseInt(String(count ?? 0), 10);
				if (!Number.isFinite(numeric) || numeric <= 0) continue;
				delegatedFailureCauses.set(cause, (delegatedFailureCauses.get(cause) ?? 0) + numeric);
			}
		};
		const chunks: string[] = [];
		const unsubscribe = swarmSession.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "task") {
				taskToolCalls += 1;
				return;
			}
			if (event.type === "tool_execution_end" && event.toolName === "task") {
				const result = event.result as { output?: string; error?: string; details?: Record<string, unknown> } | undefined;
				const details = result?.details;
				if (typeof details?.delegatedFailed === "number" && Number.isFinite(details.delegatedFailed)) {
					delegatedFailed += Math.max(0, details.delegatedFailed);
				}
				if (typeof details?.delegatedTasks === "number" && Number.isFinite(details.delegatedTasks)) {
					delegatedTasks += Math.max(0, details.delegatedTasks);
				}
				accumulateFailureCauses(details?.failureCauses);
				if (event.isError) {
					taskErrors.push(result?.error ?? result?.output ?? "task tool failed");
				}
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				for (const part of event.message.content) {
					if (part.type === "text" && part.text.trim()) {
						chunks.push(part.text.trim());
					}
				}
			}
		});

		try {
			await swarmSession.prompt(prompt, {
				expandPromptTemplates: false,
				skipIosmAutopilot: true,
				skipOrchestrationDirective: true,
				source: "interactive",
			});
		} catch (error) {
			return {
				taskId: input.task.id,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		} finally {
			unsubscribe();
			if (swarmSession.isStreaming) {
				await swarmSession.abort().catch(() => {
					// best effort
				});
			}
			swarmSession.dispose();
		}

		const output = chunks.join("\n\n").trim();
		if (/^\s*BLOCKED\s*:/im.test(output)) {
			const reason = output.match(/^\s*BLOCKED\s*:\s*(.+)$/im)?.[1]?.trim() ?? "Blocked by execution policy.";
			return {
				taskId: input.task.id,
				status: "blocked",
				error: reason,
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}
		if (taskToolCalls === 0) {
			return {
				taskId: input.task.id,
				status: "error",
				error: "No task tool call executed by assistant.",
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}
		if (taskErrors.length > 0) {
			return {
				taskId: input.task.id,
				status: "error",
				error: taskErrors.join(" | "),
				failureCause: "task_tool_error",
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}
		if (delegatedFailed > 0) {
			const failureSummary = [...delegatedFailureCauses.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([cause, count]) => `${cause}=${count}`)
				.join(", ");
			const totalDelegates = delegatedTasks > 0 ? delegatedTasks : delegatedFailed;
			const error = `delegates_failed ${delegatedFailed}/${totalDelegates}${failureSummary ? ` (${failureSummary})` : ""}`;
			return {
				taskId: input.task.id,
				status: "error",
				error,
				failureCause: failureSummary || "delegates_failed",
				costUsd: this.estimateSwarmTaskCostUsd(input.task),
			};
		}
		return {
			taskId: input.task.id,
			status: "done",
			costUsd: this.estimateSwarmTaskCostUsd(input.task),
			spawnCandidates: this.parseSwarmSpawnCandidates(output, input.task.id),
		};
	}

	private async executeSwarmRun(input: {
		runId: string;
		plan: SwarmPlan;
		meta: SwarmRunMeta;
		contract: EngineeringContract;
		budgetUsd?: number;
		resumeState?: SwarmRuntimeState;
		projectIndex?: ProjectIndex;
		enableIncrementalIndex?: boolean;
	}): Promise<void> {
		const cwd = this.sessionManager.getCwd();
		const store = new SwarmStateStore(cwd, input.runId);
		const initialState = input.resumeState ?? this.buildSwarmBootstrapState(input.runId, input.plan, input.budgetUsd);
		if (!input.resumeState) {
			store.init(input.meta, input.plan, initialState);
		}
		let rollingIndex = input.projectIndex;
		let localStopRequested = false;
		const refreshIncrementalIndex = (): void => {
			if (!input.enableIncrementalIndex || !rollingIndex) return;
			const changed = collectChangedFilesSince(rollingIndex, cwd);
			if (changed.length === 0) return;
			const rebuilt = buildProjectIndex(cwd, {
				incrementalFrom: rollingIndex,
				changedFiles: changed,
				maxFiles: Math.max(2_000, rollingIndex.meta.totalFiles + 1_000),
			});
			saveProjectIndex(cwd, rebuilt);
			rollingIndex = rebuilt;
		};

		this.swarmActiveRunId = input.runId;
		this.showStatus(`Swarm run started: ${input.runId}`);
		const schedulerResult = await runSwarmScheduler({
			runId: input.runId,
			plan: input.plan,
			contract: input.contract,
			maxParallel: input.meta.maxParallel,
			budgetUsd: input.budgetUsd,
			existingState: initialState,
			dispatchTask: async ({ task, runtime }) =>
				this.dispatchSwarmTaskWithAgent({
					meta: input.meta,
					task,
					runtime,
					contract: input.contract,
				}),
			confirmSpawn: async ({ candidate, parentTask }) => {
				const requiresConfirmation = candidate.severity === "high" || parentTask.spawn_policy === "manual_high_risk";
				if (!requiresConfirmation) return true;
				const choice = await this.showExtensionSelector(
					[
						`/swarm spawn candidate requires confirmation`,
						`severity=${candidate.severity} task=${parentTask.id}`,
						`description=${candidate.description}`,
						`path=${candidate.path}`,
					].join("\n"),
					["Approve spawn", "Reject spawn (Recommended)", "Abort run"],
				);
				if (!choice || choice.startsWith("Reject")) {
					this.showStatus(`Swarm spawn rejected: ${candidate.description}`);
					return false;
				}
				if (choice === "Abort run") {
					localStopRequested = true;
					this.showWarning("Swarm run marked to stop after current scheduling step.");
					return false;
				}
				return true;
			},
			onEvent: (event) => {
				store.appendEvent(event);
			},
			onStateChanged: (state) => {
				store.saveState(state);
				store.saveCheckpoint(state);
				refreshIncrementalIndex();
			},
			shouldStop: () => this.shutdownRequested || localStopRequested,
		});
		this.swarmActiveRunId = undefined;

		const taskStates = Object.values(schedulerResult.state.tasks);
		const doneCount = taskStates.filter((task) => task.status === "done").length;
		const errorCount = taskStates.filter((task) => task.status === "error").length;
		const blockedCount = taskStates.filter((task) => task.status === "blocked").length;
		const total = taskStates.length;

		const reportLines = [
			"# Swarm Integration Report",
			"",
			`- run_id: ${input.runId}`,
			`- source: ${input.meta.source}`,
			`- request: ${input.meta.request}`,
			`- status: ${schedulerResult.state.status}`,
			`- tasks: ${doneCount}/${total} done, ${errorCount} error, ${blockedCount} blocked`,
			`- budget: ${schedulerResult.state.budget.spentUsd.toFixed(2)}${input.meta.budgetUsd ? ` / ${input.meta.budgetUsd.toFixed(2)}` : ""} USD`,
			"",
			"## Consistency Model",
			"Scopes -> Touches -> Locks -> Gates -> Done",
			"",
			"## Task Gates",
			...schedulerResult.taskGates.map(
				(gate) => `- ${gate.taskId}: ${gate.pass ? "pass" : "fail"}${gate.failures.length > 0 ? ` (${gate.failures.join("; ")})` : ""}`,
			),
			"",
			"## Run Gates",
			`- pass: ${schedulerResult.runGate.pass}`,
			...schedulerResult.runGate.failures.map((item) => `- fail: ${item}`),
			...schedulerResult.runGate.warnings.map((item) => `- warn: ${item}`),
			"",
			"## Spawn Backlog",
			...(schedulerResult.spawnBacklog.length > 0
				? schedulerResult.spawnBacklog.map((item) => `- ${item.description} | ${item.path} | ${item.changeType} | fp=${item.fingerprint}`)
				: ["- none"]),
		];

		store.writeReports({
			integrationReport: reportLines.join("\n"),
			gates: {
				task_gates: schedulerResult.taskGates,
				run_gate: schedulerResult.runGate,
				status: schedulerResult.state.status,
			},
			sharedContext: [
				"# Shared Context",
				"",
				`Run ${input.runId} finished with status: ${schedulerResult.state.status}.`,
				`Recommendation: ${schedulerResult.runGate.pass ? "proceed to /iosm for measurable optimization" : "resolve failed gates before /iosm"}.`,
			].join("\n"),
		});

		this.showCommandTextBlock(
			"Swarm Run",
			[
				`run_id: ${input.runId}`,
				`status: ${schedulerResult.state.status}`,
				`tasks: ${doneCount}/${total} done · ${errorCount} error · ${blockedCount} blocked`,
				`budget_usd: ${schedulerResult.state.budget.spentUsd.toFixed(2)}${input.meta.budgetUsd ? `/${input.meta.budgetUsd.toFixed(2)}` : ""}`,
				`watch: /swarm watch ${input.runId}`,
				`resume: /swarm resume ${input.runId}`,
			].join("\n"),
		);
	}

	private async runSwarmFromTask(task: string, options: { maxParallel?: number; budgetUsd?: number }): Promise<void> {
		const contract = await this.ensureSwarmEffectiveContract(task);
		if (!contract) return;

		const indexInfo = this.ensureSwarmProjectIndex(task);
		if (indexInfo.rebuilt) {
			this.showStatus(`Swarm project index ready (${indexInfo.scaleMode}).`);
		}
		const semanticStatus = await this.maybeWarnSwarmSemantic(indexInfo.scaleMode);
		const plan = buildSwarmPlanFromTask({
			request: task,
			contract,
			index: indexInfo.index,
		});

		const runId = `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const maxParallel = Math.max(1, Math.min(MAX_ORCHESTRATION_PARALLEL, options.maxParallel ?? 3));
		const meta = this.buildSwarmRunMeta({
			runId,
			source: "plain",
			request: task,
			contract,
			repoScaleMode: indexInfo.scaleMode,
			semanticStatus,
			maxParallel,
			budgetUsd: options.budgetUsd,
		});

		await this.executeSwarmRun({
			runId,
			plan,
			meta,
			contract,
			budgetUsd: options.budgetUsd,
			projectIndex: indexInfo.index,
			enableIncrementalIndex: indexInfo.scaleMode !== "small",
		});
	}

	private async runSwarmFromSingular(input: {
		runId: string;
		option: number;
		maxParallel?: number;
		budgetUsd?: number;
	}): Promise<void> {
		const analysis = this.loadSingularAnalysisByRunId(input.runId);
		if (!analysis) {
			this.showWarning(`Singular run not found: ${input.runId}`);
			return;
		}
		const option = analysis.options.find((item) => item.id === String(input.option));
		if (!option) {
			this.showWarning(`Option ${input.option} not found in singular run ${input.runId}.`);
			return;
		}

		const contract = await this.ensureSwarmEffectiveContract(analysis.request);
		if (!contract) return;

		const indexInfo = this.ensureSwarmProjectIndex(`${analysis.request} ${option.title}`);
		const semanticStatus = await this.maybeWarnSwarmSemantic(indexInfo.scaleMode);
		const plan = buildSwarmPlanFromSingular({
			analysis,
			option,
			contract,
			index: indexInfo.index,
		});

		const runId = `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const maxParallel = Math.max(1, Math.min(MAX_ORCHESTRATION_PARALLEL, input.maxParallel ?? 3));
		const meta = this.buildSwarmRunMeta({
			runId,
			source: "singular",
			request: analysis.request,
			contract,
			repoScaleMode: indexInfo.scaleMode,
			semanticStatus,
			maxParallel,
			budgetUsd: input.budgetUsd,
			linkedSingularRunId: analysis.runId,
			linkedSingularOption: option.id,
		});

		await this.executeSwarmRun({
			runId,
			plan,
			meta,
			contract,
			budgetUsd: input.budgetUsd,
			projectIndex: indexInfo.index,
			enableIncrementalIndex: indexInfo.scaleMode !== "small",
		});
	}

	private loadSwarmRunBundle(runId: string): { meta: SwarmRunMeta; plan: SwarmPlan; state: SwarmRuntimeState } | undefined {
		const store = new SwarmStateStore(this.sessionManager.getCwd(), runId);
		const meta = store.loadMeta();
		const plan = store.loadPlan();
		const state = store.loadState();
		if (!meta || !plan || !state) return undefined;
		return { meta, plan, state };
	}

	private computeSwarmCriticalPathLength(plan: SwarmPlan): number {
		const byId = new Map(plan.tasks.map((task) => [task.id, task]));
		const memo = new Map<string, number>();
		const visiting = new Set<string>();
		const visit = (taskId: string): number => {
			if (memo.has(taskId)) return memo.get(taskId)!;
			if (visiting.has(taskId)) return 1;
			visiting.add(taskId);
			const task = byId.get(taskId);
			if (!task) return 1;
			const depMax = task.depends_on.reduce((maxValue, depId) => Math.max(maxValue, visit(depId)), 0);
			const value = depMax + 1;
			memo.set(taskId, value);
			visiting.delete(taskId);
			return value;
		};

		let best = 0;
		for (const task of plan.tasks) {
			best = Math.max(best, visit(task.id));
		}
		return best;
	}

	private computeSwarmDependentCounts(plan: SwarmPlan): Map<string, number> {
		const counts = new Map<string, number>();
		for (const task of plan.tasks) {
			for (const dep of task.depends_on) {
				counts.set(dep, (counts.get(dep) ?? 0) + 1);
			}
		}
		return counts;
	}

	private formatSwarmWatch(meta: SwarmRunMeta, plan: SwarmPlan, state: SwarmRuntimeState): string {
		const tasks = Object.values(state.tasks);
		const done = tasks.filter((task) => task.status === "done").length;
		const running = tasks.filter((task) => task.status === "running").length;
		const blocked = tasks.filter((task) => task.status === "blocked").length;
		const errors = tasks.filter((task) => task.status === "error").length;
		const pending = tasks.filter((task) => task.status === "pending" || task.status === "ready").length;
		const total = tasks.length;
		const remaining = Math.max(0, total - done);
		const throughputPerTick = done > 0 && state.tick > 0 ? done / state.tick : 0;
		const etaTicks = throughputPerTick > 0 ? Math.ceil(remaining / throughputPerTick) : undefined;
		const criticalPath = this.computeSwarmCriticalPathLength(plan);
		const speedupPotential = criticalPath > 0 ? total / criticalPath : 1;
		const dependentCounts = this.computeSwarmDependentCounts(plan);
		const bottlenecks = [...dependentCounts.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 3);
		const lines = [
			`run_id: ${meta.runId}`,
			`status: ${state.status}`,
			`source: ${meta.source}`,
			`request: ${meta.request}`,
			"consistency_model: Scopes -> Touches -> Locks -> Gates -> Done",
			`progress: done=${done}/${tasks.length} running=${running} pending=${pending} blocked=${blocked} error=${errors}`,
			`budget_usd: ${state.budget.spentUsd.toFixed(2)}${meta.budgetUsd ? `/${meta.budgetUsd.toFixed(2)}` : ""} warned80=${state.budget.warned80 ? "yes" : "no"}`,
			`tick: ${state.tick} no_progress_ticks: ${state.noProgressTicks}`,
			`eta_ticks: ${etaTicks ?? "unknown"} throughput_per_tick=${throughputPerTick > 0 ? throughputPerTick.toFixed(2) : "0.00"}`,
			`critical_path: ${criticalPath} theoretical_speedup=${speedupPotential.toFixed(2)}x`,
			`repo_scale: ${meta.repoScaleMode} semantic: ${meta.semanticStatus ?? "unknown"}`,
			"",
			...(bottlenecks.length > 0
				? ["bottlenecks:", ...bottlenecks.map(([taskId, dependents]) => `- ${taskId}: unlocks ${dependents} downstream task(s)`), ""]
				: []),
			"tasks:",
			...plan.tasks.map((task) => {
				const runtime = state.tasks[task.id];
				if (!runtime) return `- ${task.id}: missing runtime state`;
				return `- ${task.id}: ${runtime.status} attempts=${runtime.attempts} touches=${runtime.touches.slice(0, 3).join(",") || "-"}`;
			}),
		];
		if (Object.keys(state.locks).length > 0) {
			lines.push("", "locks:");
			for (const [taskId, touches] of Object.entries(state.locks)) {
				lines.push(`- ${taskId}: ${touches.join(", ")}`);
			}
		}
		return lines.join("\n");
	}

	private async runSwarmResume(runId: string): Promise<void> {
		const bundle = this.loadSwarmRunBundle(runId);
		if (!bundle) {
			this.showWarning(`Swarm run not found or incomplete: ${runId}`);
			return;
		}
		if (bundle.state.status === "completed") {
			this.showStatus(`Swarm run ${runId} is already completed.`);
			return;
		}
		bundle.state.status = "running";
		bundle.state.updatedAt = new Date().toISOString();
		await this.executeSwarmRun({
			runId,
			plan: bundle.plan,
			meta: bundle.meta,
			contract: bundle.meta.contract,
			budgetUsd: bundle.meta.budgetUsd,
			resumeState: bundle.state,
			projectIndex: bundle.meta.repoScaleMode === "small" ? undefined : loadProjectIndex(this.sessionManager.getCwd()),
			enableIncrementalIndex: bundle.meta.repoScaleMode !== "small",
		});
	}

	private async runSwarmRetry(runId: string, taskId: string, resetBrief: boolean): Promise<void> {
		const bundle = this.loadSwarmRunBundle(runId);
		if (!bundle) {
			this.showWarning(`Swarm run not found or incomplete: ${runId}`);
			return;
		}
		const target = bundle.state.tasks[taskId];
		if (!target) {
			this.showWarning(`Task ${taskId} not found in run ${runId}.`);
			return;
		}
		if (resetBrief) {
			const existingPlan = bundle.plan.tasks.find((task) => task.id === taskId);
			const edited = await this.showExtensionInput(
				`/swarm retry: update brief for ${taskId}`,
				existingPlan?.brief ?? target.id,
			);
			if (edited === undefined) {
				this.showStatus("Swarm retry cancelled.");
				return;
			}
			if (existingPlan) {
				existingPlan.brief = edited.trim() || existingPlan.brief;
			}
		}

		target.status = "ready";
		target.lastError = undefined;
		target.completedAt = undefined;
		bundle.state.retries[taskId] = 0;
		bundle.state.status = "running";
		bundle.state.updatedAt = new Date().toISOString();

		const store = new SwarmStateStore(this.sessionManager.getCwd(), runId);
		store.savePlan(bundle.plan);
		store.saveState(bundle.state);
		store.appendEvent({
			type: "task_retry",
			timestamp: new Date().toISOString(),
			runId,
			taskId,
			message: resetBrief ? "manual retry with reset brief" : "manual retry",
		});

		await this.executeSwarmRun({
			runId,
			plan: bundle.plan,
			meta: bundle.meta,
			contract: bundle.meta.contract,
			budgetUsd: bundle.meta.budgetUsd,
			resumeState: bundle.state,
			projectIndex: bundle.meta.repoScaleMode === "small" ? undefined : loadProjectIndex(this.sessionManager.getCwd()),
			enableIncrementalIndex: bundle.meta.repoScaleMode !== "small",
		});
	}

	private async handleSwarmCommand(text: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /swarm while the agent is processing another request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /swarm while compaction is running.");
			return;
		}

		const parsed = this.parseSwarmCommand(text);
		if (!parsed) return;

		if (parsed.subcommand === "help") {
			this.showCommandTextBlock("Swarm Help", this.getSwarmHelpText());
			return;
		}

		if (parsed.subcommand === "watch") {
			let runId = parsed.runId;
			if (!runId) {
				const runs = SwarmStateStore.listRuns(this.sessionManager.getCwd(), 20);
				if (runs.length === 0) {
					this.showStatus("No swarm runs found.");
					return;
				}
				runId = runs[0]!.runId;
			}
			const bundle = this.loadSwarmRunBundle(runId);
			if (!bundle) {
				this.showWarning(`Swarm run not found or incomplete: ${runId}`);
				return;
			}
			this.showCommandTextBlock("Swarm Watch", this.formatSwarmWatch(bundle.meta, bundle.plan, bundle.state));
			return;
		}

		if (parsed.subcommand === "resume") {
			await this.runSwarmResume(parsed.runId);
			return;
		}

		if (parsed.subcommand === "retry") {
			await this.runSwarmRetry(parsed.runId, parsed.taskId, parsed.resetBrief);
			return;
		}

		if (parsed.subcommand === "run") {
			await this.runSwarmFromTask(parsed.task, {
				maxParallel: parsed.maxParallel,
				budgetUsd: parsed.budgetUsd,
			});
			return;
		}

		if (parsed.subcommand === "from-singular") {
			await this.runSwarmFromSingular({
				runId: parsed.runId,
				option: parsed.option,
				maxParallel: parsed.maxParallel,
				budgetUsd: parsed.budgetUsd,
			});
		}
	}

	private parseOrchestrateSlashCommand(text: string): ParsedOrchestrateCommand | undefined {
		const args = this.parseSlashArgs(text).slice(1);
		let mode: OrchestrationMode | undefined;
		let agents: number | undefined;
		let maxParallel: number | undefined;
		let profile: AgentProfileName | undefined;
		let profiles: AgentProfileName[] | undefined;
		let cwds: string[] | undefined;
		let locks: string[] | undefined;
		let isolation: "none" | "worktree" | undefined;
		let dependencies: Array<{ agent: number; dependsOn: number[] }> | undefined;
		const taskParts: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--parallel") {
				mode = "parallel";
				continue;
			}
			if (arg === "--sequential") {
				mode = "sequential";
				continue;
			}
			if (arg === "--agents") {
				const value = args[index + 1];
				const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ORCHESTRATION_AGENTS) {
					this.showWarning(`Invalid --agents value (expected 1..${MAX_ORCHESTRATION_AGENTS}).`);
					return undefined;
				}
				agents = parsed;
				index += 1;
				continue;
			}
			if (arg === "--max-parallel") {
				const value = args[index + 1];
				const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ORCHESTRATION_PARALLEL) {
					this.showWarning(`Invalid --max-parallel value (expected 1..${MAX_ORCHESTRATION_PARALLEL}).`);
					return undefined;
				}
				maxParallel = parsed;
				index += 1;
				continue;
			}
			if (arg === "--profile") {
				const value = args[index + 1];
				if (!value || !isValidProfileName(value)) {
					this.showWarning(`Invalid --profile value: ${value ?? "(missing)"}`);
					return undefined;
				}
				profile = value;
				index += 1;
				continue;
			}
			if (arg === "--profiles") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --profiles.");
					return undefined;
				}
				const parsedProfiles = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				if (parsedProfiles.length === 0 || parsedProfiles.some((item) => !isValidProfileName(item))) {
					this.showWarning(`Invalid --profiles value: ${value}`);
					return undefined;
				}
				profiles = parsedProfiles as AgentProfileName[];
				index += 1;
				continue;
			}
			if (arg === "--cwd") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --cwd.");
					return undefined;
				}
				cwds = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				index += 1;
				continue;
			}
			if (arg === "--locks") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --locks.");
					return undefined;
				}
				locks = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				index += 1;
				continue;
			}
			if (arg === "--worktree") {
				isolation = "worktree";
				continue;
			}
			if (arg === "--depends") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --depends.");
					return undefined;
				}
				const parsedDeps: Array<{ agent: number; dependsOn: number[] }> = [];
				const edges = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				for (const edge of edges) {
					const [left, right] = edge.split(">");
					const agent = Number.parseInt((left ?? "").trim(), 10);
					const dependency = Number.parseInt((right ?? "").trim(), 10);
					if (!Number.isInteger(agent) || !Number.isInteger(dependency) || agent < 1 || dependency < 1) {
						this.showWarning(`Invalid dependency edge: ${edge}. Expected format like 2>1,3>2`);
						return undefined;
					}
					const existing = parsedDeps.find((entry) => entry.agent === agent);
					if (existing) {
						existing.dependsOn.push(dependency);
					} else {
						parsedDeps.push({ agent, dependsOn: [dependency] });
					}
				}
				dependencies = parsedDeps.map((entry) => ({
					agent: entry.agent,
					dependsOn: [...new Set(entry.dependsOn)].sort((a, b) => a - b),
				}));
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /orchestrate: ${arg}`);
				this.showWarning(
					"Usage: /orchestrate (--parallel|--sequential) --agents N [--max-parallel N] [--profile <name>|--profiles p1,p2] [--cwd p1,p2] [--locks l1,l2] [--worktree] [--depends 2>1,3>2] <task>",
				);
				return undefined;
			}
			taskParts.push(arg);
		}

		const task = taskParts.join(" ").trim();
		if (!mode || !agents || !task) {
			this.showWarning(
				"Usage: /orchestrate (--parallel|--sequential) --agents N [--max-parallel N] [--profile <name>|--profiles p1,p2] [--cwd p1,p2] [--locks l1,l2] [--worktree] [--depends 2>1,3>2] <task>",
			);
			return undefined;
		}
		if (profile && profiles) {
			this.showWarning("Use either --profile or --profiles, not both.");
			return undefined;
		}
		if (mode === "sequential" && maxParallel !== undefined) {
			this.showWarning("--max-parallel is only valid with --parallel mode.");
			return undefined;
		}
		if (maxParallel !== undefined && maxParallel > agents) {
			maxParallel = agents;
		}
		if (profiles && profiles.length < agents) {
			this.showWarning("--profiles count must be >= --agents or omitted.");
			return undefined;
		}
		if (cwds && cwds.length < agents) {
			this.showWarning("--cwd list count must be >= --agents or omitted.");
			return undefined;
		}
		if (locks && locks.length < agents) {
			this.showWarning("--locks list count must be >= --agents or omitted.");
			return undefined;
		}
		if (dependencies) {
			for (const dep of dependencies) {
				if (dep.agent > agents || dep.dependsOn.some((target) => target > agents || target === dep.agent)) {
					this.showWarning("Dependency graph references invalid agent indexes.");
					return undefined;
				}
			}
			if (hasDependencyCycle(agents, dependencies)) {
				this.showWarning("Dependency graph contains a cycle. Use a DAG for --depends.");
				return undefined;
			}
		}

		return {
			mode,
			agents,
			maxParallel,
			profile,
			profiles,
			cwds,
			locks,
			isolation,
			dependencies,
			task,
		};
	}

	private async handleOrchestrateSlashCommand(text: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /orchestrate while the agent is processing a request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /orchestrate while compaction is running.");
			return;
		}

		const rawArgs = this.parseSlashArgs(text).slice(1);
		if (rawArgs.includes("--swarm")) {
			this.showWarning("`/orchestrate --swarm` was removed to avoid ambiguity. Use `/swarm` commands directly.");
			this.showCommandTextBlock("Swarm Usage", this.getSwarmHelpText());
			return;
		}

		const parsed = this.parseOrchestrateSlashCommand(text);
		if (!parsed) {
			return;
		}
		const swarmRecommendation = this.buildSwarmRecommendationFromOrchestrate(parsed);
		if (swarmRecommendation.recommend) {
			this.showWarning(
				`This task looks complex/risky for legacy /orchestrate (${swarmRecommendation.reasons.join(
					"; ",
				)}). Consider ${swarmRecommendation.command}.`,
			);
		}

		const currentCwd = this.sessionManager.getCwd();
		const assignments: string[] = [];
		const assignmentRecords: Array<{ profile: string; cwd: string; lockKey?: string; dependsOn: number[] }> = [];
		for (let index = 0; index < parsed.agents; index++) {
			const assignmentProfile =
				parsed.profiles?.[index] ?? parsed.profile ?? (this.activeProfileName || "full");
			const assignmentCwd = parsed.cwds?.[index] ?? ".";
			const assignmentLock = parsed.locks?.[index];
			const dependsOn = parsed.dependencies?.find((entry) => entry.agent === index + 1)?.dependsOn ?? [];
			const resolvedCwd = path.resolve(currentCwd, assignmentCwd);
			assignmentRecords.push({
				profile: assignmentProfile,
				cwd: resolvedCwd,
				lockKey: assignmentLock,
				dependsOn,
			});
			assignments.push(
				`- agent ${index + 1}: profile=${assignmentProfile} cwd=${resolvedCwd}${assignmentLock ? ` lock_key=${assignmentLock}` : ""
				}${parsed.isolation === "worktree" ? " isolation=worktree" : ""}${dependsOn.length > 0 ? ` depends_on=${dependsOn.join("|")}` : ""
				}`,
			);
		}
		const teamRun = createTeamRun({
			cwd: currentCwd,
			mode: parsed.mode,
			agents: parsed.agents,
			maxParallel: parsed.maxParallel,
			task: parsed.task,
			assignments: assignmentRecords,
		});
		const runAssignments = teamRun.tasks.map(
			(task, index) => `${assignments[index]} run_id=${teamRun.runId} task_id=${task.id}`,
		);
		const taskCallHints = teamRun.tasks.map((task, index) => {
			const assignment = assignmentRecords[index];
			return `- task_call_${index + 1}: description="agent ${index + 1} execution" profile="${assignment.profile}" cwd="${assignment.cwd}" run_id="${teamRun.runId}" task_id="${task.id}"${assignment.lockKey ? ` lock_key="${assignment.lockKey}"` : ""
				}${parsed.isolation === "worktree" ? ' isolation="worktree"' : ""}`;
		});

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				theme.bold(theme.fg("accent", "◆ ")) + theme.bold("/orchestrate") + theme.fg("muted", ` ${currentCwd}`),
				1,
				0,
			),
		);
		this.ui.requestRender();

		const payload = [
			`<orchestrate run_id="${teamRun.runId}" mode="${parsed.mode}" agents="${parsed.agents}"${parsed.maxParallel ? ` max_parallel="${parsed.maxParallel}"` : ""
			}>`,
			...runAssignments,
			"required_task_calls:",
			...taskCallHints,
			`task: ${parsed.task}`,
			"constraints:",
				"- use task tool for every agent assignment",
				"- for parallel mode, emit all independent task calls in one assistant response",
				"- in parallel mode, use parallel tool-call style (<use_parallel_tool_calls>)",
				"- when assignment lines include depends_on, still emit one task call per assignment; runtime enforces dependency gating",
				"- keep required orchestration task calls in foreground; do not set background=true unless user explicitly requested detached async runs",
			"- do not poll .iosm/subagents/background via bash/read during orchestration; wait for task results and then synthesize",
			"- include run_id and task_id from each assignment in the task tool arguments",
			"- keep each agent in its assigned cwd",
			"- avoid edit collisions; if two write-capable agents target same area, serialize those writes",
			"- aggregate outputs into one concise final synthesis",
			"</orchestrate>",
		].join("\n");

		await this.session.prompt(payload, {
			expandPromptTemplates: false,
			source: "interactive",
		});
	}

	private async handleAgentsSlashCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const asJson = args.includes("--json");
		const cwd = this.sessionManager.getCwd();
		const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
		const profiles = getProfileNames().map((name) => getAgentProfile(name));

		if (asJson) {
			this.showCommandJsonBlock("Agents", {
				profiles: profiles.map((profile) => ({
					name: profile.name,
					description: profile.description,
					tools: profile.tools,
					thinkingLevel: profile.thinkingLevel,
				})),
				customAgents: loaded.agents.map((agent) => ({
					name: agent.name,
					description: agent.description,
					profile: agent.profile,
					tools: agent.tools,
					disallowedTools: agent.disallowedTools,
					background: agent.background,
					cwd: agent.cwd,
					sourcePath: agent.sourcePath,
					sourceScope: agent.sourceScope,
				})),
				allCustomAgents: loaded.allAgents.map((agent) => ({
					name: agent.name,
					description: agent.description,
					profile: agent.profile,
					tools: agent.tools,
					disallowedTools: agent.disallowedTools,
					background: agent.background,
					cwd: agent.cwd,
					sourcePath: agent.sourcePath,
					sourceScope: agent.sourceScope,
					effective: agent.effective,
					overriddenByPath: agent.overriddenByPath,
				})),
				overrides: loaded.overrides,
				diagnostics: loaded.diagnostics,
			});
			return;
		}

		const options = [
			"Browse existing agents",
			"Use agent via @mention",
			"Create new agent with AI",
			"Edit existing agent file",
			"Delete agent file",
			"Show source precedence",
			"Show agents as text",
		];
		const selected = await this.showExtensionSelector("/agents", options);
		if (!selected) return;

		if (selected === "Show agents as text") {
			this.showCommandTextBlock("Agents", this.buildAgentsTextReport(profiles, loaded));
			return;
		}

		if (selected === "Create new agent with AI") {
			await this.createAgentWithAi();
			return;
		}

		if (selected === "Show source precedence") {
			this.showCommandTextBlock("Agent Source Precedence", this.buildAgentPrecedenceReport(loaded));
			return;
		}

		if (selected === "Use agent via @mention") {
			const chosen = await this.selectAgentRecord(
				loaded,
				"/agents: use @mention",
				loaded.agents,
				(agent) => this.formatAgentChoice(agent),
			);
			if (!chosen) return;
			this.insertAgentMention(chosen.name);
			return;
		}

		if (selected === "Edit existing agent file") {
			const editableAgents = loaded.allAgents.filter((agent) => agent.sourceScope !== "builtin");
			if (editableAgents.length === 0) {
				this.showStatus("No editable custom agent files found. Built-in system agents are read-only.");
				return;
			}
			const chosen = await this.selectAgentRecord(
				loaded,
				"/agents: edit file",
				editableAgents,
				(agent) => this.formatAgentChoice(agent, { includeScope: true, includeStatus: true }),
			);
			if (!chosen) return;
			await this.editAgentFile(chosen);
			return;
		}

		if (selected === "Delete agent file") {
			const deletableAgents = loaded.allAgents.filter((agent) => agent.sourceScope !== "builtin");
			if (deletableAgents.length === 0) {
				this.showStatus("No deletable custom agent files found. Built-in system agents are read-only.");
				return;
			}
			const chosen = await this.selectAgentRecord(
				loaded,
				"/agents: delete file",
				deletableAgents,
				(agent) => this.formatAgentChoice(agent, { includeScope: true, includeStatus: true }),
			);
			if (!chosen) return;
			await this.deleteAgentFile(chosen);
			return;
		}

		const chosen = await this.selectAgentRecord(
			loaded,
			"/agents: details",
			loaded.agents,
			(agent) => this.formatAgentChoice(agent, { includeScope: true }),
		);
		if (!chosen) return;
		this.showCommandTextBlock("Agent Details", this.buildAgentDetailReport(chosen, loaded));
	}

	private formatAgentChoice(
		agent: CustomSubagentEntry,
		options?: { includeScope?: boolean; includeStatus?: boolean },
	): string {
		const suffixParts: string[] = [];
		if (options?.includeScope) {
			suffixParts.push(agent.sourceScope);
		}
		if (options?.includeStatus) {
			suffixParts.push(agent.effective ? "active" : "shadowed");
		}
		const suffix = suffixParts.length > 0 ? ` [${suffixParts.join(", ")}]` : "";
		return `${agent.name} — ${agent.description}${suffix}`;
	}

	private async selectAgentRecord(
		loaded: ReturnType<typeof loadCustomSubagents>,
		title: string,
		candidates: CustomSubagentEntry[],
		labelBuilder: (agent: CustomSubagentEntry) => string,
	): Promise<CustomSubagentEntry | undefined> {
		if (candidates.length === 0) {
			this.showStatus("No custom agents found in .iosm/agents or global agents directory.");
			return undefined;
		}
		const options = candidates.map((agent, index) => `${index + 1}. ${labelBuilder(agent)}`);
		const picked = await this.showExtensionSelector(title, options);
		if (!picked) return undefined;
		const index = options.indexOf(picked);
		return index >= 0 ? candidates[index] : undefined;
	}

	private insertAgentMention(name: string): void {
		const current = this.editor.getText().trim();
		this.editor.setText(current ? `${current} @${name} ` : `@${name} `);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
		this.showStatus(`Inserted @${name} into editor.`);
	}

	private buildAgentsTextReport(
		profiles: Array<ReturnType<typeof getAgentProfile>>,
		loaded: ReturnType<typeof loadCustomSubagents>,
	): string {
		const lines: string[] = [];
		lines.push("Built-in Profiles:");
		for (const profile of profiles) {
			lines.push(
				`- ${profile.name}: ${profile.description} · thinking=${profile.thinkingLevel} · tools=${profile.tools.join(", ")}`,
			);
		}
		lines.push("");
		lines.push(`Active Agents (${loaded.agents.length}):`);
		if (loaded.agents.length === 0) {
			lines.push("- none");
		} else {
			for (const agent of loaded.agents) {
				lines.push(
					`- ${agent.name}: ${agent.description} · profile=${agent.profile ?? "-"} · background=${agent.background ? "true" : "false"} · source=${agent.sourceScope}`,
				);
				lines.push(
					`  tools=${agent.tools?.join(", ") ?? "-"} · disallowed=${agent.disallowedTools?.join(", ") ?? "-"} · cwd=${agent.cwd ?? "-"} · path=${agent.sourcePath}`,
				);
			}
		}

		if (loaded.overrides.length > 0) {
			lines.push("");
			lines.push("Overrides:");
			for (const override of loaded.overrides) {
				lines.push(
					`- ${override.name}: ${override.winnerScope} (${override.winnerPath}) overrides ${override.overriddenScope} (${override.overriddenPath})`,
				);
			}
		}

		if (loaded.diagnostics.length > 0) {
			lines.push("");
			lines.push("Diagnostics:");
			for (const item of loaded.diagnostics) {
				lines.push(`- ${item.path}: ${item.message}`);
			}
		}
		return lines.join("\n");
	}

	private buildAgentPrecedenceReport(loaded: ReturnType<typeof loadCustomSubagents>): string {
		const lines: string[] = [];
		lines.push(`Active definitions: ${loaded.agents.length}`);
		lines.push(`All discovered definitions: ${loaded.allAgents.length}`);
		lines.push("");
		lines.push("Resolution order:");
		lines.push("- project (.iosm/agents) overrides global (~/.iosm/agent/agents)");
		lines.push("- global overrides built-in system agents shipped with CLI");
		lines.push("- within the same scope, later file path wins deterministically");
		lines.push("");
		if (loaded.overrides.length === 0) {
			lines.push("Overrides:");
			lines.push("- none");
		} else {
			lines.push("Overrides:");
			for (const override of loaded.overrides) {
				lines.push(
					`- ${override.name}: ${override.winnerScope} winner=${override.winnerPath} shadowed=${override.overriddenPath}`,
				);
			}
		}
		lines.push("");
		lines.push("All definitions:");
		for (const agent of loaded.allAgents) {
			lines.push(
				`- ${agent.name} [${agent.sourceScope}] ${agent.effective ? "active" : `shadowed by ${agent.overriddenByPath ?? "unknown"}`}`,
			);
			lines.push(`  ${agent.sourcePath}`);
		}
		return lines.join("\n");
	}

	private buildAgentDetailReport(
		agent: CustomSubagentEntry,
		loaded: ReturnType<typeof loadCustomSubagents>,
	): string {
		const overridden = loaded.allAgents.filter(
			(item) => item.name === agent.name && item.sourcePath !== agent.sourcePath,
		);
		const detailLines = [
			`${agent.name}: ${agent.description}`,
			`profile=${agent.profile ?? "-"}`,
			`background=${agent.background ? "true" : "false"}`,
			`source_scope=${agent.sourceScope}`,
			`status=${agent.effective ? "active" : "shadowed"}`,
			`tools=${agent.tools?.join(", ") ?? "-"}`,
			`disallowed=${agent.disallowedTools?.join(", ") ?? "-"}`,
			`cwd=${agent.cwd ?? "-"}`,
			`path=${agent.sourcePath}`,
		];
		if (agent.overriddenByPath) {
			detailLines.push(`overridden_by=${agent.overriddenByPath}`);
		}
		if (overridden.length > 0) {
			detailLines.push("", "Alternative definitions:");
			for (const entry of overridden) {
				detailLines.push(
					`- ${entry.sourceScope}: ${entry.sourcePath}${entry.effective ? " (active)" : " (shadowed)"}`,
				);
			}
		}
		detailLines.push("", "Usage: @agent_name <task>");
		return detailLines.join("\n");
	}

	private async editAgentFile(agent: CustomSubagentEntry): Promise<void> {
		if (!fs.existsSync(agent.sourcePath)) {
			this.showWarning(`Agent file not found: ${agent.sourcePath}`);
			return;
		}
		const current = fs.readFileSync(agent.sourcePath, "utf8");
		const edited = await this.showExtensionEditor(
			`Edit agent file: ${agent.name} (${agent.sourceScope})`,
			current,
		);
		if (edited === undefined) {
			return;
		}
		const normalized = edited.replace(/\r\n/g, "\n").trim();
		if (!normalized) {
			this.showWarning("Agent file cannot be empty.");
			return;
		}
		fs.writeFileSync(agent.sourcePath, `${normalized}\n`, "utf8");
		this.showStatus(`Updated agent: ${agent.sourcePath}`);
	}

	private async deleteAgentFile(agent: CustomSubagentEntry): Promise<void> {
		if (!fs.existsSync(agent.sourcePath)) {
			this.showWarning(`Agent file not found: ${agent.sourcePath}`);
			return;
		}
		const confirmed = await this.showExtensionConfirm(
			"Delete agent file?",
			`${agent.name} (${agent.sourceScope})\n${agent.sourcePath}`,
		);
		if (!confirmed) {
			this.showStatus("Agent deletion cancelled.");
			return;
		}
		fs.rmSync(agent.sourcePath, { force: true });
		this.showStatus(`Deleted agent file: ${agent.sourcePath}`);
	}

	private extractAssistantText(message: AssistantMessage): string {
		const parts: string[] = [];
		for (const content of message.content) {
			if (content.type === "text" && content.text.trim()) {
				parts.push(content.text.trim());
			}
		}
		return parts.join("\n\n").trim();
	}

	private extractFirstJsonObject(text: string): string | undefined {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		if (fenced?.[1]) {
			return fenced[1].trim();
		}
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return text.slice(start, end + 1);
		}
		return undefined;
	}

	private sanitizeAgentFileName(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "")
			.slice(0, 80);
	}

	private async createAgentWithAi(): Promise<void> {
		if (this.session.isStreaming || this.session.isCompacting || this.iosmAutomationRun || this.iosmVerificationSession) {
			this.showWarning("Cannot create agent while another run is active.");
			return;
		}
		const userSpec = await this.showExtensionInput(
			"Describe what the new agent should do",
			"e.g. agent that reviews migrations and proposes rollback-safe SQL",
		);
		if (!userSpec || !userSpec.trim()) {
			return;
		}

		const generationPrompt = [
			"You are generating a custom IOSM subagent specification.",
			"Return ONLY a single JSON object and no additional text.",
			'Allowed JSON keys: name, description, profile, tools, disallowed_tools, system_prompt, cwd, background, instructions.',
			'profile must be one of: full, plan, iosm, meta, explore, iosm_analyst, iosm_verifier, cycle_planner.',
			"name must be short snake/kebab case, suitable for @mention.",
			"tools/disallowed_tools must be arrays of tool names when present.",
			"instructions must be a concise markdown body for the agent file.",
			"Follow prompt best practices:",
			"- Define explicit Role and Goal.",
			"- Define Scope boundaries (in-scope and out-of-scope).",
			"- Define required Workflow/Checklist steps.",
			"- Define strict Output format/sections.",
			"- Define uncertainty policy: ask for missing critical data instead of guessing.",
			"- Keep instructions concrete and testable; avoid vague phrasing.",
			"Prefer composition over broad power: default to read-oriented profiles unless write access is required.",
			"Built-in system agents already exist and can be extended by user agents:",
			"- codebase_auditor",
			"- system_error_analyst",
			"- iosm_change_executor",
			"- iosm_postchange_verifier",
			"- qa_test_engineer",
			"- test_failure_triager",
			"- meta_orchestrator",
			"",
			`User request: ${userSpec.trim()}`,
		].join("\n");

		await this.session.prompt(generationPrompt, {
			expandPromptTemplates: false,
			skipIosmAutopilot: true,
			skipOrchestrationDirective: true,
			source: "interactive",
		});

		const assistant = this.getLastAssistantMessage();
		if (!assistant || assistant.stopReason === "aborted" || assistant.stopReason === "error") {
			this.showWarning("Agent generation did not complete.");
			return;
		}
		const rawText = this.extractAssistantText(assistant);
		const jsonCandidate = this.extractFirstJsonObject(rawText);
		if (!jsonCandidate) {
			this.showWarning("Could not parse generated agent JSON.");
			return;
		}

		type GeneratedAgentSpec = {
			name?: unknown;
			description?: unknown;
			profile?: unknown;
			tools?: unknown;
			disallowed_tools?: unknown;
			system_prompt?: unknown;
			cwd?: unknown;
			background?: unknown;
			instructions?: unknown;
		};

		let parsed: GeneratedAgentSpec;
		try {
			parsed = JSON.parse(jsonCandidate) as GeneratedAgentSpec;
		} catch {
			this.showWarning("Generated JSON is invalid.");
			return;
		}

		const nameRaw = typeof parsed.name === "string" ? parsed.name.trim() : "";
		const fileName = this.sanitizeAgentFileName(nameRaw || "agent");
		if (!fileName) {
			this.showWarning("Generated agent name is empty.");
			return;
		}
		const description = typeof parsed.description === "string" ? parsed.description.trim() : `Custom agent ${fileName}`;
		const profile =
			typeof parsed.profile === "string" && isValidProfileName(parsed.profile) ? parsed.profile : "explore";
		const tools = Array.isArray(parsed.tools)
			? parsed.tools.map((item) => String(item).trim()).filter(Boolean)
			: undefined;
		const disallowedTools = Array.isArray(parsed.disallowed_tools)
			? parsed.disallowed_tools.map((item) => String(item).trim()).filter(Boolean)
			: undefined;
		const systemPrompt = typeof parsed.system_prompt === "string" ? parsed.system_prompt.trim() : undefined;
		const cwdField = typeof parsed.cwd === "string" ? parsed.cwd.trim() : undefined;
		const background = parsed.background === true;
		const instructions =
			typeof parsed.instructions === "string" && parsed.instructions.trim().length > 0
				? parsed.instructions.trim()
				: `Follow user instructions for ${description}.`;

		const frontmatter: string[] = [
			"---",
			`name: ${JSON.stringify(fileName)}`,
			`description: ${JSON.stringify(description)}`,
			`profile: ${profile}`,
		];
		if (tools && tools.length > 0) {
			frontmatter.push(`tools: [${tools.map((item) => JSON.stringify(item)).join(", ")}]`);
		}
		if (disallowedTools && disallowedTools.length > 0) {
			frontmatter.push(`disallowed_tools: [${disallowedTools.map((item) => JSON.stringify(item)).join(", ")}]`);
		}
		if (systemPrompt) {
			frontmatter.push(`system_prompt: ${JSON.stringify(systemPrompt)}`);
		}
		if (cwdField) {
			frontmatter.push(`cwd: ${JSON.stringify(cwdField)}`);
		}
		if (background) {
			frontmatter.push("background: true");
		}
		frontmatter.push("---", "", instructions, "");

		const agentsDir = path.join(this.sessionManager.getCwd(), ".iosm", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const targetPath = path.join(agentsDir, `${fileName}.md`);
		if (fs.existsSync(targetPath)) {
			const overwrite = await this.showExtensionConfirm(
				"Overwrite existing agent?",
				`${targetPath} already exists.`,
			);
			if (!overwrite) {
				this.showStatus("Agent creation cancelled.");
				return;
			}
		}
		fs.writeFileSync(targetPath, frontmatter.join("\n"), "utf8");
		// Refresh autocomplete so the newly-created agent is immediately available in @ suggestions.
		this.setupAutocomplete(this.fdPath);
		this.showStatus(`Created agent: ${targetPath}`);

		const insertMention = await this.showExtensionConfirm(
			"Insert mention?",
			`Insert @${fileName} into the editor now?`,
		);
		if (insertMention) {
			const current = this.editor.getText().trim();
			this.editor.setText(current ? `${current} @${fileName} ` : `@${fileName} `);
			this.ui.requestRender();
		}
	}

	private handleSubagentRunsSlashCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const limitRaw = args[0];
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			this.showWarning("Usage: /subagent-runs [limit: 1..200]");
			return;
		}

		const cwd = this.sessionManager.getCwd();
		const runs = listSubagentRuns(cwd, limit);
		if (runs.length === 0) {
			this.showStatus("No subagent runs found.");
			return;
		}

		const lines = runs.map((run, index) => {
			const created = run.createdAt ? ` · ${run.createdAt}` : "";
			const profile = run.profile ? ` · ${run.profile}` : "";
			const agent = run.agent ? ` · agent=${run.agent}` : "";
			const cwdPart = run.cwd ? ` · cwd=${run.cwd}` : "";
			const desc = run.description ? `\n  ${run.description}` : "";
			return `${index + 1}. ${run.runId}${profile}${agent}${cwdPart}${created}${desc}`;
		});
		this.showCommandTextBlock("Subagent Runs", lines.join("\n"));
	}

	private async handleSubagentResumeSlashCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const cwd = this.sessionManager.getCwd();
		let runId = args[0];
		let extraInstructions = args.slice(1).join(" ").trim();

		if (!runId) {
			const runs = listSubagentRuns(cwd, 20);
			if (runs.length === 0) {
				this.showStatus("No subagent runs found.");
				return;
			}
			const options = runs.map((run, index) => {
				const created = run.createdAt ? ` · ${run.createdAt}` : "";
				const profile = run.profile ? ` · ${run.profile}` : "";
				const agent = run.agent ? ` · agent=${run.agent}` : "";
				const desc = run.description ? ` · ${run.description}` : "";
				return `${index + 1}. ${run.runId}${profile}${agent}${created}${desc}`;
			});
			const picked = await this.showExtensionSelector("/subagent-resume: select run", options);
			if (!picked) {
				this.showStatus("Subagent resume cancelled.");
				return;
			}
			const selectedIndex = options.indexOf(picked);
			const selectedRun = selectedIndex >= 0 ? runs[selectedIndex] : undefined;
			if (!selectedRun) {
				this.showWarning("Selected subagent run is no longer available.");
				return;
			}
			runId = selectedRun.runId;

			const enteredInstructions = await this.showExtensionInput(
				"/subagent-resume: extra instructions (optional)",
				"leave blank to continue as-is",
			);
			if (enteredInstructions === undefined) {
				this.showStatus("Subagent resume cancelled.");
				return;
			}
			extraInstructions = enteredInstructions.trim();
		}

		const run = getSubagentRun(cwd, runId);
		if (!run) {
			this.showWarning(`Subagent run not found: ${runId}`);
			return;
		}
		const outputTail = (run.output ?? "").slice(-6000);
		const resumePrompt = [
			"<resume_subagent_run>",
			`run_id: ${run.runId}`,
			`profile: ${run.profile ?? "full"}`,
			`agent: ${run.agent ?? ""}`,
			`cwd: ${run.cwd ?? cwd}`,
			`lock_key: ${run.lockKey ?? ""}`,
			"Use the task tool to continue this workstream from the previous output context.",
			"",
			"Previous output (tail):",
			outputTail || "(empty)",
			"",
			extraInstructions ? `Additional instructions:\n${extraInstructions}\n` : "",
			"</resume_subagent_run>",
		]
			.filter(Boolean)
			.join("\n");

		await this.session.prompt(resumePrompt, {
			expandPromptTemplates: false,
			source: "interactive",
		});
	}

	private handleTeamRunsSlashCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const limitRaw = args[0];
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			this.showWarning("Usage: /team-runs [limit: 1..200]");
			return;
		}
		const cwd = this.sessionManager.getCwd();
		const runs = listTeamRuns(cwd, limit);
		if (runs.length === 0) {
			this.showStatus("No team runs found.");
			return;
		}

		const lines = runs.map((run, index) => {
			const done = run.tasks.filter((task) => task.status === "done").length;
			const errored = run.tasks.filter((task) => task.status === "error").length;
			return `${index + 1}. ${run.runId} · ${run.mode} · ${done}/${run.tasks.length} done · ${errored} error · ${run.createdAt}`;
		});
		this.showCommandTextBlock("Team Runs", lines.join("\n"));
	}

	private async handleTeamStatusSlashCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const cwd = this.sessionManager.getCwd();
		let runId = args[0];

		if (!runId) {
			const runs = listTeamRuns(cwd, 20);
			if (runs.length === 0) {
				this.showStatus("No team runs found.");
				return;
			}
			const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
			if (canShowInteractiveSelector) {
				const options = runs.map((run, index) => {
					const done = run.tasks.filter((task) => task.status === "done").length;
					const errored = run.tasks.filter((task) => task.status === "error").length;
					return `${index + 1}. ${run.runId} · ${run.mode} · ${done}/${run.tasks.length} done · ${errored} error · ${run.createdAt}`;
				});
				const selection = await this.showExtensionSelector("/team-status: select run", options);
				if (!selection) {
					this.showStatus("Team status cancelled.");
					return;
				}
				const selectedIndex = options.indexOf(selection);
				const selectedRun = selectedIndex >= 0 ? runs[selectedIndex] : undefined;
				if (!selectedRun) {
					this.showWarning("Selected team run is no longer available.");
					return;
				}
				runId = selectedRun.runId;
			} else {
				runId = runs[0]?.runId;
			}
		}
		if (!runId) {
			this.showWarning("No team run selected.");
			return;
		}
		const run = getTeamRun(cwd, runId);
		if (!run) {
			this.showWarning(`Team run not found: ${runId}`);
			return;
		}
		const lines = [
			`Run: ${run.runId}`,
			`Created: ${run.createdAt}`,
			`Mode: ${run.mode}`,
			`Agents: ${run.agents}`,
			`Max parallel: ${run.maxParallel ?? "n/a"}`,
			`Task: ${run.task}`,
			"",
			"Assignments:",
			...run.tasks.map((task) => {
				const deps = task.dependsOn.length > 0 ? task.dependsOn.join("|") : "-";
				return `- ${task.id}: status=${task.status} profile=${task.profile} cwd=${task.cwd}${task.lockKey ? ` lock=${task.lockKey}` : ""
					} depends_on=${deps}`;
			}),
		];
		this.showCommandTextBlock("Team Status", lines.join("\n"));
	}

	private showIosmAutomationSummaryCard(input: {
		status: IosmAutomationLoopStatus;
		targetIndex: number;
		maxIterations: number;
		iterationsCompleted: number;
		initialSnapshot: IosmMetricSnapshot;
		finalSnapshot: IosmMetricSnapshot;
		cycleId?: string;
		cycleDecision?: IosmDecision;
		error?: string;
		guidePath?: string;
	}): void {
		const resultLabel =
			input.status === "stabilized"
				? "stabilized"
				: input.status === "threshold_reached"
					? "requested threshold reached"
					: input.status === "cancelled"
						? "cancelled by user"
						: input.status === "max_iterations"
							? "iteration budget exhausted"
							: "failed";
		const deltaLines = summarizeMetricDelta(input.initialSnapshot, input.finalSnapshot);
		const remainingPriorities = buildIosmPriorityChecklist(input.finalSnapshot.metrics, 3)
			.map(
				(item, index) =>
					`${index + 1}. ${item.metric}=${item.value === null ? "n/a" : item.value.toFixed(3)} — ${item.action}`,
			)
			.join("\n");

		const lines = [
			`Result: ${resultLabel}`,
			`Target index: ${input.targetIndex.toFixed(3)}`,
			`Iterations completed: ${input.iterationsCompleted}/${input.maxIterations}`,
			`Cycle: ${input.cycleId ?? "unknown"}`,
			`Decision: ${input.cycleDecision ?? "unknown"}`,
			"",
			`Before: ${formatMetricSnapshot(input.initialSnapshot)}`,
			`After:  ${formatMetricSnapshot(input.finalSnapshot)}`,
			"",
			"Metric delta:",
			...(deltaLines.length > 0 ? deltaLines.map((line) => `- ${line}`) : ["- no metric movement detected"]),
			"",
			"Remaining priorities:",
			remainingPriorities,
		];

		if (input.guidePath) {
			lines.push("", `Guide: ${input.guidePath}`);
		}

		if (input.error) {
			lines.push("", `Error: ${input.error}`);
		}

		this.showCommandTextBlock("IOSM Automation", lines.join("\n"));
	}

	private async handleIosmAutomationSlashCommand(text: string): Promise<void> {
		if (this.activeProfileName !== "iosm") {
			this.showWarning("`/iosm` is available only in IOSM profile. Switch profile to `iosm` (Shift+Tab).");
			return;
		}
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /iosm while the agent is processing a request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /iosm while compaction is running.");
			return;
		}
		if (this.iosmAutomationRun) {
			this.showWarning("IOSM automation is already running.");
			return;
		}
		if (this.iosmVerificationSession) {
			this.showWarning("Cannot run /iosm while IOSM verification is running.");
			return;
		}

		const parsed = this.parseIosmAutomationSlashCommand(text);
		if (!parsed) {
			return;
		}

		const cwd = this.sessionManager.getCwd();
		const explicitTarget = parsed.targetIndex !== undefined;
		try {
			const { config: existingConfig } = loadIosmConfig(cwd);
			if (!existingConfig.iosm.automation.allow_agents) {
				this.showWarning("IOSM automation is disabled by iosm.automation.allow_agents=false.");
				return;
			}
		} catch {
			// Uninitialized workspaces are allowed; /iosm will bootstrap them first.
		}
		let targetIndex = parsed.targetIndex;
		let maxIterations = parsed.maxIterations;
		let initialSnapshot: IosmMetricSnapshot | undefined;
		let finalSnapshot: IosmMetricSnapshot | undefined;
		let cycleId: string | undefined;
		let cycleDecision: IosmDecision | undefined;
		let guidePath: string | undefined;
		let currentGoals: string[] = [];
		let criticalityProfile: ReturnType<typeof loadIosmConfig>["config"]["iosm"]["metadata"]["criticality_profile"] | undefined;
		let approvalRequirements: string[] = [];
		let errorMessage: string | undefined;
		let status: IosmAutomationLoopStatus = "failed";

		this.iosmAutomationRun = {
			cancelRequested: false,
			targetIndex,
			maxIterations,
			iterationsCompleted: 0,
		};
		const automationRun = this.iosmAutomationRun;

		try {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(theme.bold(theme.fg("accent", "◆ ")) + theme.bold("/iosm") + theme.fg("muted", ` ${cwd}`), 1, 0),
			);
			this.ui.requestRender();

			const initialRefresh = await this.runIosmRefreshPass({
				cwd,
				force: parsed.forceInit,
				agentVerify: true,
			});
			const { config } = loadIosmConfig(cwd);
			const settings = resolveIosmAutomationSettings(config, {
				targetIndex: parsed.targetIndex,
				maxIterations: parsed.maxIterations,
			});
			if (!config.iosm.automation.allow_agents) {
				errorMessage = "IOSM automation is disabled by iosm.automation.allow_agents=false.";
				status = "failed";
				return;
			}
			targetIndex = settings.targetIndex;
			maxIterations = settings.maxIterations;
			automationRun.targetIndex = targetIndex;
			automationRun.maxIterations = maxIterations;
			criticalityProfile = config.iosm.metadata.criticality_profile;
			approvalRequirements = config.iosm.automation.human_approval_required_for;

			initialSnapshot = initialRefresh.snapshot;
			finalSnapshot = initialRefresh.snapshot;
			cycleId = initialRefresh.initResult.cycle?.cycleId;
			cycleDecision = initialRefresh.cycleDecision;
			guidePath = initialRefresh.guidePath;
			currentGoals = initialRefresh.initResult.analysis.goals;

			this.showProgressLine(
				`  Target IOSM index: ${targetIndex.toFixed(3)} · iteration budget: ${maxIterations}`,
			);
			this.showProgressLine(`  Current snapshot: ${formatMetricSnapshot(initialSnapshot)}`);

			if (!initialRefresh.verification?.completed) {
				if (initialRefresh.verification?.cancelled || automationRun.cancelRequested) {
					status = "cancelled";
					return;
				}
				errorMessage =
					initialRefresh.verification?.error ??
					initialRefresh.verification?.skippedReason ??
					"IOSM verification did not complete.";
				status = "failed";
				return;
			}

			const initialProgress = evaluateIosmAutomationProgress({
				snapshot: finalSnapshot,
				targetIndex,
				cycleDecision,
				explicitTarget,
			});
			if (initialProgress.failed) {
				errorMessage = "IOSM verifier marked the current cycle as FAIL.";
				status = "failed";
				return;
			}

			if ((!explicitTarget && initialProgress.stabilized) || initialProgress.targetSatisfied) {
				status = initialProgress.stabilized ? "stabilized" : "threshold_reached";
				return;
			}

			for (let iteration = 1; iteration <= maxIterations; iteration++) {
				if (automationRun.cancelRequested) {
					status = "cancelled";
					break;
				}

				if (explicitTarget && cycleDecision === "STOP" && !hasReachedIosmTarget(finalSnapshot, targetIndex)) {
					const previousCycleId = cycleId;
					this.showProgressLine("  Current cycle stabilized below the requested threshold; opening a fresh cycle.");
					const rollover = await this.runIosmRefreshPass({
						cwd,
						force: false,
						agentVerify: true,
					});
					finalSnapshot = rollover.snapshot;
					cycleId = rollover.initResult.cycle?.cycleId ?? cycleId;
					cycleDecision = rollover.cycleDecision;
					guidePath = rollover.guidePath;
					currentGoals = rollover.initResult.analysis.goals;

					if (!rollover.verification?.completed) {
						if (rollover.verification?.cancelled || automationRun.cancelRequested) {
							status = "cancelled";
							break;
						}
						errorMessage =
							rollover.verification?.error ??
							rollover.verification?.skippedReason ??
							"IOSM verification did not complete.";
						status = "failed";
						break;
					}

					const rolloverProgress = evaluateIosmAutomationProgress({
						snapshot: finalSnapshot,
						targetIndex,
						cycleDecision,
						explicitTarget,
					});
					if (rolloverProgress.failed) {
						errorMessage = "IOSM verifier marked the new cycle as FAIL.";
						status = "failed";
						break;
					}
					if (rolloverProgress.targetSatisfied) {
						status = rolloverProgress.stabilized ? "stabilized" : "threshold_reached";
						break;
					}
					if (previousCycleId === cycleId && rolloverProgress.stabilized) {
						errorMessage = "IOSM automation could not advance to a fresh cycle after stabilization.";
						status = "failed";
						break;
					}
				}

				const priorities = buildIosmPriorityChecklist(finalSnapshot.metrics, 3);
				this.showProgressLine(
					`  Iteration ${iteration}/${maxIterations}: improving from ${finalSnapshot.iosm_index === null ? "n/a" : finalSnapshot.iosm_index.toFixed(3)} toward ${targetIndex.toFixed(3)}`,
				);
				const iterationPromptTimeoutMs = 300_000;
				let iterationTimeout: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						this.session.prompt(
							buildIosmAutomationPrompt({
								rootDir: cwd,
								cycleId,
								targetIndex,
								iteration,
								maxIterations,
								snapshot: finalSnapshot,
								goals: currentGoals,
								priorities,
								currentDecision: cycleDecision,
								criticalityProfile,
								approvalRequirements,
							}),
							{
								expandPromptTemplates: false,
								skipIosmAutopilot: true,
								source: "interactive",
							},
						),
						new Promise<never>((_resolve, reject) => {
							iterationTimeout = setTimeout(() => {
								reject(
									new Error(
										`/iosm iteration ${iteration} timed out after ${Math.round(iterationPromptTimeoutMs / 1000)}s.`,
									),
								);
							}, iterationPromptTimeoutMs);
						}),
					]);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes("timed out")) {
						try {
							if (this.session.isStreaming) {
								await this.session.abort();
							}
						} catch {
							// best effort
						}
					}
					throw error;
				} finally {
					if (iterationTimeout) {
						clearTimeout(iterationTimeout);
					}
				}

				const lastAssistant = this.getLastAssistantMessage();
				if (lastAssistant?.stopReason === "aborted") {
					automationRun.cancelRequested = true;
					status = "cancelled";
					break;
				}
				if (lastAssistant?.stopReason === "error") {
					errorMessage = lastAssistant.errorMessage ?? "IOSM improvement turn failed.";
					status = "failed";
					break;
				}
				if (automationRun.cancelRequested) {
					status = "cancelled";
					break;
				}

				const refreshed = await this.runIosmRefreshPass({
					cwd,
					force: false,
					agentVerify: true,
				});
				finalSnapshot = refreshed.snapshot;
				cycleId = refreshed.initResult.cycle?.cycleId ?? cycleId;
				cycleDecision = refreshed.cycleDecision;
				guidePath = refreshed.guidePath;
				currentGoals = refreshed.initResult.analysis.goals;

				if (!refreshed.verification?.completed) {
					if (refreshed.verification?.cancelled || automationRun.cancelRequested) {
						status = "cancelled";
						break;
					}
					errorMessage =
						refreshed.verification?.error ??
						refreshed.verification?.skippedReason ??
						"IOSM verification did not complete.";
					status = "failed";
					break;
				}

				automationRun.iterationsCompleted = iteration;
				this.showProgressLine(`  Verified snapshot: ${formatMetricSnapshot(finalSnapshot)}`);

				const progress = evaluateIosmAutomationProgress({
					snapshot: finalSnapshot,
					targetIndex,
					cycleDecision,
					explicitTarget,
				});
				if (progress.failed) {
					errorMessage = "IOSM verifier marked the cycle as FAIL.";
					status = "failed";
					break;
				}
				if ((!explicitTarget && progress.stabilized) || progress.targetSatisfied) {
					status = progress.stabilized ? "stabilized" : "threshold_reached";
					break;
				}

				if (iteration === maxIterations) {
					status = "max_iterations";
				}
			}
		} catch (error: unknown) {
			errorMessage = error instanceof Error ? error.message : String(error);
			status = automationRun.cancelRequested ? "cancelled" : "failed";
		} finally {
			const iterationsCompleted = automationRun.iterationsCompleted;
			const resolvedTargetIndex = targetIndex;
			const resolvedMaxIterations = maxIterations;
			this.iosmAutomationRun = undefined;

			if (
				initialSnapshot &&
				finalSnapshot &&
				resolvedTargetIndex !== undefined &&
				resolvedMaxIterations !== undefined
			) {
				this.showIosmAutomationSummaryCard({
					status,
					targetIndex: resolvedTargetIndex,
					maxIterations: resolvedMaxIterations,
					iterationsCompleted,
					initialSnapshot,
					finalSnapshot,
					cycleId,
					cycleDecision,
					error: errorMessage,
					guidePath,
				});
			} else if (errorMessage) {
				this.showError(`IOSM automation failed: ${errorMessage}`);
			}
		}
	}

	private buildStandardInitPlaybook(cwd: string, generatedBody?: string): string {
		if (generatedBody && generatedBody.trim().length > 0) {
			const trimmed = generatedBody.trim();
			return trimmed.startsWith("# AGENTS.md") ? trimmed : `# AGENTS.md\n\n${trimmed}`;
		}

		const packageJsonPath = path.join(cwd, "package.json");
		let packageName: string | undefined;
		let scriptsSection = "";
		try {
			if (fs.existsSync(packageJsonPath)) {
				const raw = fs.readFileSync(packageJsonPath, "utf8");
				const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
				if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
					packageName = parsed.name.trim();
				}
				if (parsed.scripts && typeof parsed.scripts === "object") {
					const entries = Object.entries(parsed.scripts).slice(0, 8);
					if (entries.length > 0) {
						scriptsSection = entries.map(([name, cmd]) => `  - \`npm run ${name}\`: \`${cmd}\``).join("\n");
					}
				}
			}
		} catch {
			// Keep template generation resilient even if package.json is malformed.
		}

		const keyFiles = ["README.md", "package.json", "tsconfig.json", ".env.example", "docker-compose.yml"]
			.filter((name) => fs.existsSync(path.join(cwd, name)))
			.map((name) => `- \`${name}\``)
			.join("\n");

		return [
			"# AGENTS.md",
			"",
			"This workspace is initialized in standard (non-IOSM) mode.",
			packageName ? `\n## Project\n- Name: \`${packageName}\`` : "",
			"",
			"## Role",
			"- Act as a pragmatic engineering agent.",
			"- Inspect relevant files first, then implement changes with minimal blast radius.",
			"- Verify changes with targeted checks/tests.",
			"",
			"## Project Startup",
			scriptsSection.length > 0
				? "- Use these project scripts first:\n" + scriptsSection
				: "- Define and document run/test/build commands here after initial setup.",
			"",
			"## Key Files",
			keyFiles.length > 0 ? keyFiles : "- Add key entrypoints and config files for quick onboarding.",
			"",
			"## Working Rules",
			"- Keep responses concise and concrete.",
			"- Prefer explicit file references and commands.",
			"- Use subagents when user explicitly requests delegation or parallelization.",
			"",
			"## Custom Agents",
			"- Put custom agent specs under `.iosm/agents/*.md`.",
			"- Use `@agent_name` in chat to target a custom agent explicitly.",
			"",
			"## Notes",
			"- Switch to profile `iosm` to enable IOSM methodology, `/iosm`, and IOSM artifact lifecycle.",
			"",
		].join("\n");
	}

	private async generateStandardAgentsGuideWithAgent(
		cwd: string,
		onEvent?: (event: AgentSessionEvent) => void,
	): Promise<{
		content: string;
		toolCallsStarted: number;
		toolCallsCompleted: number;
		assistantMessages: number;
		attempts: number;
	}> {
		const model = this.session.model;
		if (!model) {
			throw new Error("No model selected. Use /model first.");
		}

		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(getAuthPath());
		const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			authStorage,
			modelRegistry,
			resourceLoader,
			model,
			profile: "plan",
			enableTaskTool: false,
		});

		const existingAgentsPath = path.join(cwd, "AGENTS.md");
		const existingAgentsRaw = fs.existsSync(existingAgentsPath) ? fs.readFileSync(existingAgentsPath, "utf8") : "";
		const maxExistingChars = 12_000;
		const existingAgentsSnippet =
			existingAgentsRaw.length > maxExistingChars
				? `${existingAgentsRaw.slice(0, maxExistingChars)}\n\n<!-- truncated: ${existingAgentsRaw.length - maxExistingChars} chars omitted -->`
				: existingAgentsRaw;

		const chunks: string[] = [];
		let toolCallsStarted = 0;
		let toolCallsCompleted = 0;
		let assistantMessages = 0;
		const unsubscribe = session.subscribe((event) => {
			onEvent?.(event);
			if (event.type === "tool_execution_start") {
				toolCallsStarted += 1;
				return;
			}
			if (event.type === "tool_execution_end") {
				toolCallsCompleted += 1;
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				assistantMessages += 1;
				for (const part of event.message.content) {
					if (part.type === "text" && part.text.trim()) {
						chunks.push(part.text.trim());
					}
				}
			}
		});

		const prompt = [
			"Create AGENTS.md for this repository after inspecting the real project files.",
			existingAgentsSnippet.trim().length > 0
				? "An AGENTS.md already exists: preserve useful guidance, fill missing sections, and update stale parts."
				: "No AGENTS.md exists yet: create a complete first version.",
			"",
			"Requirements:",
			"- Explore repository structure and key files before writing.",
			"- You MUST call repository-inspection tools (ls/find/read/grep/bash) before final output.",
			"- Output ONLY final AGENTS.md content in markdown (no code fences, no commentary).",
			"- Include practical sections:",
			"  1) Project Overview",
			"  2) Stack and Runtime",
			"  3) Setup / Run / Test commands",
			"  4) Repository Map (important directories/files)",
			"  5) Development Workflow and Conventions",
			"  6) Troubleshooting / Pitfalls",
			"  7) Quick Task Playbooks (common tasks and where to edit)",
			"- Keep it concise but actionable.",
			"- Use concrete commands and file paths from this repository.",
			"- If information is unknown, say 'Unknown' instead of guessing.",
			existingAgentsSnippet.trim().length > 0 ? "" : undefined,
			existingAgentsSnippet.trim().length > 0 ? "Existing AGENTS.md:" : undefined,
			existingAgentsSnippet.trim().length > 0 ? "<existing_agents_md>" : undefined,
			existingAgentsSnippet.trim().length > 0 ? existingAgentsSnippet : undefined,
			existingAgentsSnippet.trim().length > 0 ? "</existing_agents_md>" : undefined,
		].join("\n");

		const strictRetryPrompt = [
			"Retry with strict validation:",
			"- First, inspect the repository using tools (ls/find/read/grep/bash).",
			"- Then output ONLY final AGENTS.md markdown.",
			"- Do not include commentary, plans, or fences.",
		].join("\n");

		try {
			let attempts = 0;
			let latestText = "";
			let latestAttemptToolCalls = 0;

			const runAttempt = async (attemptPrompt: string): Promise<{ text: string; toolCalls: number }> => {
				const chunkStart = chunks.length;
				const toolStart = toolCallsStarted;
				await session.prompt(attemptPrompt, { skipIosmAutopilot: true });
				const text = chunks.slice(chunkStart).join("\n\n").trim();
				return {
					text,
					toolCalls: Math.max(0, toolCallsStarted - toolStart),
				};
			};

			attempts += 1;
			const firstAttempt = await runAttempt(prompt);
			latestText = firstAttempt.text;
			latestAttemptToolCalls = firstAttempt.toolCalls;

			if (!latestText || latestAttemptToolCalls === 0) {
				attempts += 1;
				const secondAttempt = await runAttempt(strictRetryPrompt);
				latestText = secondAttempt.text;
				latestAttemptToolCalls = secondAttempt.toolCalls;
			}

			if (!latestText) {
				throw new Error("Agent returned empty AGENTS.md draft.");
			}
			if (latestAttemptToolCalls === 0) {
				throw new Error("Agent did not inspect repository files (0 tool calls).");
			}

			return {
				content: latestText,
				toolCallsStarted,
				toolCallsCompleted,
				assistantMessages,
				attempts,
			};
		} finally {
			unsubscribe();
			session.dispose();
		}
	}

	private async handleStandardInitSlashCommand(options: {
		cwd: string;
		force: boolean;
		agentVerify: boolean;
	}): Promise<void> {
		const playbookPath = path.join(options.cwd, "AGENTS.md");
		const agentsDir = path.join(options.cwd, ".iosm", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		const existed = fs.existsSync(playbookPath);
		this.showProgressLine(
			existed
				? "  Scanning repository and updating existing AGENTS.md with agent..."
				: "  Scanning repository and generating AGENTS.md with agent...",
		);
		const generated = await this.generateStandardAgentsGuideWithAgent(
			options.cwd,
			this.createIosmVerificationEventBridge({
				loaderMessage: `Initializing workspace... (${appKey(this.keybindings, "interrupt")} to interrupt)`,
			}),
		);
		fs.writeFileSync(playbookPath, this.buildStandardInitPlaybook(options.cwd, generated.content), "utf8");
		this.showCommandTextBlock(
			"Init (Standard Mode)",
			[
				`Profile: ${this.activeProfileName}`,
				`AGENTS.md: ${existed ? "updated" : "created"}`,
				`Generator: agent-driven repository scan (${generated.toolCallsStarted} tool calls, ${generated.assistantMessages} assistant messages, ${generated.attempts} attempt${generated.attempts > 1 ? "s" : ""})`,
				options.force && existed
					? "Mode: force overwrite requested."
					: "Mode: standard overwrite (existing guidance merged by agent when applicable).",
				`.iosm/agents: ready`,
				options.agentVerify
					? "Agent verification skipped in standard mode (available in profile `iosm`)."
					: "Verification: disabled.",
			].join("\n"),
		);
	}

	private async handleIosmInitSlashCommand(text: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /init while the agent is processing a request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /init while compaction is running.");
			return;
		}
		if (this.iosmAutomationRun) {
			this.showWarning("Cannot run /init while IOSM automation is running.");
			return;
		}
		if (this.iosmVerificationSession) {
			this.showWarning("Cannot run /init while IOSM verification is already running.");
			return;
		}

		const args = this.parseSlashArgs(text).slice(1);
		let force = false;
		let agentVerify = true;
		let targetDir: string | undefined;

		for (const arg of args) {
			if (arg === "-f" || arg === "--force") {
				force = true;
				continue;
			}
			if (arg === "--agent-verify") {
				agentVerify = true;
				continue;
			}
			if (arg === "--no-agent-verify" || arg === "--static-only") {
				agentVerify = false;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /init: ${arg}`);
				this.showWarning("Usage: /init [path] [--force] [--no-agent-verify]");
				return;
			}
			if (!targetDir) {
				targetDir = arg;
				continue;
			}
			this.showWarning(`Unexpected argument for /init: ${arg}`);
			this.showWarning("Usage: /init [path] [--force] [--no-agent-verify]");
			return;
		}

		try {
			const cwd = path.resolve(this.sessionManager.getCwd(), targetDir ?? ".");
			if (this.activeProfileName !== "iosm") {
				await this.handleStandardInitSlashCommand({
					cwd,
					force,
					agentVerify,
				});
				return;
			}

			// Show init header in chat
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					theme.bold(theme.fg("accent", "◆ ")) + theme.bold("/init") + theme.fg("muted", ` ${cwd}`),
					1,
					0,
				),
			);
			this.ui.requestRender();

			const result = await initIosmWorkspace({ cwd, force });

			if (result.cycle?.reusedExistingCycle) {
				this.showProgressLine(`  Reusing existing cycle: ${result.cycle.cycleId}`);
			} else if (result.cycle) {
				this.showProgressLine(
					`  Analyzed ${result.analysis.files_analyzed} files (${result.analysis.source_file_count} src · ${result.analysis.test_file_count} tests · ${result.analysis.doc_file_count} docs)`,
				);
				this.showProgressLine(`  Created cycle: ${result.cycle.cycleId}`);
			}

			let verification: IosmInitVerificationSummary | undefined;
			if (agentVerify) {
				verification = await this.runIosmInitAgentVerification(
					result,
					cwd,
					this.createIosmVerificationEventBridge(),
				);
			}

			const currentSnapshot = this.resolveIosmSnapshot(result, verification);

			const checklist = buildIosmPriorityChecklist(currentSnapshot.metrics, 3);
			const guidePath = verification?.guidePath ?? getIosmGuidePath(result.rootDir);

			// Render rich summary card
			this.showIosmInitSummaryCard(result, currentSnapshot, checklist, guidePath, verification, agentVerify);
		} catch (error: unknown) {
			this.showError(
				`Failed to initialize IOSM workspace: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private showIosmInitSummaryCard(
		result: IosmInitResult,
		snapshot: IosmMetricSnapshot,
		checklist: ReturnType<typeof buildIosmPriorityChecklist>,
		guidePath: string,
		verification: IosmInitVerificationSummary | undefined,
		agentVerify: boolean,
	): void {
		const source = verification?.completed ? "verified" : "heuristic";
		const cycleId = result.cycle?.cycleId ?? "—";
		const home = process.env.HOME ?? "";

		const shortPath = (p: string): string =>
			home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;

		const metricBar = (value: number | null): string => {
			if (value === null) return "n/a ";
			const filled = Math.round(value * 8);
			return "█".repeat(filled) + "░".repeat(8 - filled) + ` ${value.toFixed(2)}`;
		};

		const statusIcon = (value: number | null): string => {
			if (value === null) return "?";
			if (value < 0.55) return "⚠";
			if (value < 0.75) return "~";
			return "✓";
		};

		const metrics = snapshot.metrics;
		const metricOrder: Array<keyof typeof metrics> = [
			"semantic",
			"logic",
			"performance",
			"simplicity",
			"modularity",
			"flow",
		];

		const metricRows = metricOrder
			.map((m) => {
				const v = metrics[m];
				const icon = statusIcon(v);
				const bar = metricBar(v);
				return `| ${icon} | ${m.padEnd(11)} | ${bar} |`;
			})
			.join("\n");

		const iosmIdx =
			snapshot.iosm_index !== null && snapshot.iosm_index !== undefined
				? snapshot.iosm_index.toFixed(3)
				: "n/a";
		const conf =
			snapshot.decision_confidence !== null && snapshot.decision_confidence !== undefined
				? snapshot.decision_confidence.toFixed(2)
				: "n/a";

		const priorityLines = checklist
			.map(
				(item, i) =>
					`${i + 1}. **${item.metric}** \`${item.value === null ? "n/a" : item.value.toFixed(2)}\` — ${item.action}`,
			)
			.join("\n");

		const goals =
			result.analysis.goals.length > 0 ? result.analysis.goals.map((g) => `- ${g}`).join("\n") : "- (none detected)";

		const fileStats = `${result.analysis.files_analyzed} total · ${result.analysis.source_file_count} src · ${result.analysis.test_file_count} tests · ${result.analysis.doc_file_count} docs`;

		const verifyStatus = !agentVerify
			? "_skipped (--no-agent-verify)_"
			: verification?.completed
				? `✓ completed (${verification.toolCalls ?? 0} tool calls)`
				: verification?.cancelled
					? "⚠ cancelled by user"
					: verification?.skippedReason
						? `⚠ skipped: ${verification.skippedReason}`
						: verification?.error
							? `✗ failed: ${verification.error}`
							: "_not run_";

		const md = `## IOSM workspace initialized

**Project:** \`${shortPath(result.rootDir)}\`
**Files:** ${fileStats}
**Cycle:** \`${cycleId}\`
**Assessment:** ${source}   **Verification:** ${verifyStatus}

### Detected goals
${goals}

### Metric scores

|   | Metric      | Score            |
|---|-------------|------------------|
${metricRows}

**IOSM-Index:** \`${iosmIdx}\`   **Confidence:** \`${conf}\`

### Top priorities this cycle

${priorityLines}

### Key workspace files

- \`IOSM.md\` — agent playbook (auto-loaded as context each session)
- \`iosm.yaml\` — cycle configuration${result.cycle ? `\n- \`.iosm/cycles/${cycleId}/cycle-report.json\`` : ""}
- \`${shortPath(guidePath)}\`

### Next steps

Re-read \`IOSM.md\`, then start a session describing which priority to tackle first.
The agent will automatically receive IOSM context on every turn.`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(md, 1, 0, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	private handleIosmCycleListSlashCommand(): void {
		if (!this.requireIosmMode("/cycle-list")) return;
		try {
			const cycles = listIosmCycles(this.sessionManager.getCwd());
			if (cycles.length === 0) {
				this.showStatus("No IOSM cycles found.");
				return;
			}

			const lines: string[] = [];
			for (const cycle of cycles) {
				const goals = cycle.goals.length > 0 ? cycle.goals.join("; ") : "no goals recorded";
				lines.push(`${cycle.cycleId}  ${cycle.status}  ${cycle.decision}`);
				lines.push(`  ${goals}`);
			}
			this.showCommandTextBlock("IOSM Cycles", lines.join("\n"));
		} catch (error: unknown) {
			this.showError(`Failed to list IOSM cycles: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleIosmCyclePlanSlashCommand(text: string): Promise<void> {
		if (!this.requireIosmMode("/cycle-plan")) return;
		const args = this.parseSlashArgs(text).slice(1);
		let force = false;
		let cycleId: string | undefined;
		const goals: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "-f" || arg === "--force") {
				force = true;
				continue;
			}
			if (arg === "--id") {
				if (index + 1 >= args.length) {
					this.showWarning('Missing value for "--id".');
					this.showWarning('Usage: /cycle-plan [--id <cycle-id>] [--force] "goal one" "goal two"');
					return;
				}
				cycleId = args[index + 1];
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /cycle-plan: ${arg}`);
				this.showWarning('Usage: /cycle-plan [--id <cycle-id>] [--force] "goal one" "goal two"');
				return;
			}
			goals.push(arg);
		}

		if (goals.length === 0) {
			this.showWarning('Usage: /cycle-plan [--id <cycle-id>] [--force] "goal one" "goal two"');
			return;
		}

		try {
			const planned = planIosmCycle({
				cwd: this.sessionManager.getCwd(),
				goals,
				force,
				cycleId,
			});
			this.showCommandTextBlock(
				"IOSM Cycle Plan",
				[
					`Planned IOSM cycle ${planned.cycleId}`,
					`  ${planned.cycleDir}`,
					`  baseline: ${planned.baselineReportPath}`,
					`  hypotheses: ${planned.hypothesesPath}`,
					`  report: ${planned.reportPath}`,
				].join("\n"),
			);
		} catch (error: unknown) {
			this.showError(`Failed to plan IOSM cycle: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private formatIosmCycleSelectionOption(index: number, cycle: ReturnType<typeof listIosmCycles>[number]): string {
		const goals = cycle.goals.length > 0 ? cycle.goals.join("; ") : "no goals recorded";
		return `${index}. ${cycle.cycleId} · ${cycle.status} · ${cycle.decision} · ${goals}`;
	}

	private async selectIosmCycleId(commandName: "/cycle-report" | "/cycle-status"): Promise<string | undefined> {
		const cycles = listIosmCycles(this.sessionManager.getCwd());
		if (cycles.length === 0) {
			this.showStatus("No IOSM cycles found.");
			return undefined;
		}
		const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
		if (!canShowInteractiveSelector) {
			return cycles[0]?.cycleId;
		}
		const options = cycles.map((cycle, index) => this.formatIosmCycleSelectionOption(index + 1, cycle));
		const selected = await this.showExtensionSelector(`${commandName}: select cycle`, options);
		if (!selected) {
			this.showStatus(`${commandName} cancelled.`);
			return undefined;
		}
		const selectedIndex = options.indexOf(selected);
		const cycle = selectedIndex >= 0 ? cycles[selectedIndex] : undefined;
		if (!cycle) {
			this.showWarning("Selected cycle is no longer available.");
			return undefined;
		}
		return cycle.cycleId;
	}

	private async handleIosmCycleReportSlashCommand(text: string): Promise<void> {
		if (!this.requireIosmMode("/cycle-report")) return;
		const args = this.parseSlashArgs(text).slice(1);
		if (args.some((arg) => arg.startsWith("-"))) {
			this.showWarning("Usage: /cycle-report [cycle-id]");
			return;
		}
		if (args.length > 1) {
			this.showWarning("Usage: /cycle-report [cycle-id]");
			return;
		}

		try {
			let cycleId: string | undefined = args[0];
			if (!cycleId) {
				cycleId = await this.selectIosmCycleId("/cycle-report");
				if (!cycleId) {
					return;
				}
			}
			const report = readIosmCycleReport(this.sessionManager.getCwd(), cycleId);
			this.showCommandJsonBlock("IOSM Cycle Report", report);
		} catch (error: unknown) {
			this.showError(`Failed to read IOSM cycle report: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleIosmCycleStatusSlashCommand(text: string): Promise<void> {
		if (!this.requireIosmMode("/cycle-status")) return;
		const args = this.parseSlashArgs(text).slice(1);
		if (args.some((arg) => arg.startsWith("-"))) {
			this.showWarning("Usage: /cycle-status [cycle-id]");
			return;
		}
		if (args.length > 1) {
			this.showWarning("Usage: /cycle-status [cycle-id]");
			return;
		}

		try {
			let cycleId: string | undefined = args[0];
			if (!cycleId) {
				cycleId = await this.selectIosmCycleId("/cycle-status");
				if (!cycleId) {
					return;
				}
			}
			const status = inspectIosmCycle(this.sessionManager.getCwd(), cycleId);
			const guardrails =
				status.guardrailsPass === null ? "pending" : status.guardrailsPass ? "pass" : "fail";
			const lines: string[] = [
				`Cycle: ${status.cycleId}`,
				`Status: ${status.status}`,
				`Decision: ${status.decision}`,
				`Report: ${status.reportPath}`,
				`Capacity: ${status.capacityPass ? "pass" : "fail"}`,
				`Guardrails: ${guardrails}`,
				`Report Complete: ${status.reportComplete ? "yes" : "no"}`,
				`Learning Closed: ${status.learningClosed ? "yes" : "no"}`,
				`History Recorded: ${status.historyRecorded ? "yes" : "no"}`,
			];

			if (status.blockingIssues.length > 0) {
				lines.push("", "Blocking Issues:");
				for (const issue of status.blockingIssues) {
					lines.push(`  - ${issue}`);
				}
			}
			if (status.warnings.length > 0) {
				lines.push("", "Warnings:");
				for (const warning of status.warnings) {
					lines.push(`  - ${warning}`);
				}
			}

			this.showCommandTextBlock("IOSM Cycle Status", lines.join("\n"));
		} catch (error: unknown) {
			this.showError(`Failed to inspect IOSM cycle: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const loader = new BorderedLoader(this.ui, theme, "Reloading extensions, skills, prompts, themes...", {
			cancellable: false,
		});
		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			if (this.mcpRuntime) {
				await this.mcpRuntime.refresh();
				this.syncMcpToolsWithSession();
				const mcpErrors = this.mcpRuntime.getErrors();
				if (mcpErrors.length > 0) {
					this.showWarning(
						`MCP config warning: ${mcpErrors[0]}${mcpErrors.length > 1 ? ` (+${mcpErrors.length - 1} more)` : ""}`,
					);
				}
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocomplete(this.fdPath);
			const runner = this.session.extensionRunner;
			if (runner) {
				this.setupExtensionShortcuts(runner);
			}
			this.rebuildChatFromMessages();
			dismissLoader(this.editor as Component);
			this.showLoadedResources({
				extensionPaths: runner?.getExtensionPaths() ?? [],
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded extensions, skills, prompts, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		if (args.length > 1) {
			this.showWarning("Usage: /export [output-path]");
			return;
		}
		let outputPath: string | undefined = args[0];
		const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
		if (!outputPath && canShowInteractiveSelector) {
			const enteredPath = await this.showExtensionInput(
				"/export: output path (optional)",
				"Leave empty for default export file name",
			);
			if (enteredPath === undefined) {
				this.showStatus("Export cancelled");
				return;
			}
			const normalized = enteredPath.trim();
			outputPath = normalized.length > 0 ? normalized : undefined;
		}

		if (outputPath && fs.existsSync(outputPath) && canShowInteractiveSelector) {
			const overwrite = await this.showExtensionConfirm("Overwrite existing export file?", outputPath);
			if (!overwrite) {
				this.showStatus("Export cancelled");
				return;
			}
		}

		try {
			const filePath = await this.session.exportToHtml(outputPath);
			this.showStatus(`Session exported to: ${filePath}`);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private handleCopyCommand(): void {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.sessionManager.appendSessionInfo(name);
		this.updateTerminalTitle();
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
					.reverse()
					.map((e) => e.content)
					.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Capitalize keybinding for display (e.g., "ctrl+c" -> "Ctrl+C").
	 */
	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("+"),
			)
			.join("/");
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppAction): string {
		return this.capitalizeKey(appKey(this.keybindings, action));
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: EditorAction): string {
		return this.capitalizeKey(editorKey(action));
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorWordLeft = this.getEditorKeyDisplay("cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("jumpBackward");
		const pageUp = this.getEditorKeyDisplay("pageUp");
		const pageDown = this.getEditorKeyDisplay("pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("submit");
		const newLine = this.getEditorKeyDisplay("newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("yank");
		const yankPop = this.getEditorKeyDisplay("yankPop");
		const undo = this.getEditorKeyDisplay("undo");
		const tab = this.getEditorKeyDisplay("tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("interrupt");
		const clear = this.getAppKeyDisplay("clear");
		const exit = this.getAppKeyDisplay("exit");
		const suspend = this.getAppKeyDisplay("suspend");
		const cycleProfile = this.getAppKeyDisplay("cycleProfile");
		const cycleThinkingLevel = this.getAppKeyDisplay("cycleThinkingLevel");
		const cycleModelForward = this.getAppKeyDisplay("cycleModelForward");
		const selectModel = this.getAppKeyDisplay("selectModel");
		const expandTools = this.getAppKeyDisplay("expandTools");
		const toggleThinking = this.getAppKeyDisplay("toggleThinking");
		const externalEditor = this.getAppKeyDisplay("externalEditor");
		const steer = this.getAppKeyDisplay("steer");
		const followUp = this.getAppKeyDisplay("followUp");
		const dequeue = this.getAppKeyDisplay("dequeue");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`Arrow keys\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleProfile}\` | Cycle agent profile |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${steer}\` | Queue steer message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`Ctrl+V\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner) {
			const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
			if (shortcuts.size > 0) {
				hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
				for (const [key, shortcut] of shortcuts) {
					const description = shortcut.description ?? shortcut.extensionPath;
					const keyDisplay = key.replace(/\b\w/g, (c) => c.toUpperCase());
					hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
				}
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		this.contractService.clear("session");

		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// New session via session (emits extension session events)
		await this.session.newSession();

		// Clear UI state
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.syncRuntimePromptSuffix();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
		this.refreshBuiltInHeader();
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: process.cwd(),
			})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		await this.executeCompaction(customInstructions, false);
	}

	private async executeCompaction(customInstructions?: string, isAuto = false): Promise<CompactionResult | undefined> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Set up escape handler during compaction
		const originalOnEscape = this.defaultEditor.onEscape;
		this.defaultEditor.onEscape = () => {
			void this.interruptCurrentWork();
		};

		// Show compacting status
		this.chatContainer.addChild(new Spacer(1));
		const cancelHint = `(${appKey(this.keybindings, "interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.statusContainer.addChild(compactingLoader);
		this.ui.requestRender();

		let result: CompactionResult | undefined;

		try {
			result = await this.session.compact(customInstructions);

			// Rebuild UI
			this.rebuildChatFromMessages();

			// Add compaction component at bottom so user sees it without scrolling
			const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
			this.addMessageToChat(msg);

			this.footer.invalidate();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) {
				this.showError("Compaction cancelled");
			} else {
				this.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.statusContainer.clear();
			this.defaultEditor.onEscape = originalOnEscape;
		}
		void this.flushCompactionQueue({ willRetry: false });
		return result;
	}

	stop(): void {
		this.clearSubagentElapsedTimer();
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}

import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import { getAgentDir, getDocsPath } from "../config.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ExtensionRunner, LoadExtensionsResult, ToolDefinition } from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { loadModelsDevProviderCatalog, type ModelsDevProviderCatalogInfo } from "./models-dev-provider-catalog.js";
import { ModelRegistry, type ProviderConfigInput } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import type { ResourceLoader } from "./resource-loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import type { SharedMemoryContext } from "./shared-memory.js";
import { loadCustomSubagents, resolveCustomSubagentReference } from "./subagents.js";
import { time } from "./timings.js";
import { createSharedMemoryReadTool, createSharedMemoryWriteTool } from "./tools/shared-memory.js";
import { patchAgentForParallelTaskExecution } from "./parallel-task-agent.js";
import {
	allTools,
	astGrepTool,
	bashTool,
	codingTools,
	combyTool,
	createAstGrepTool,
	createBashTool,
	createCodingTools,
	createCombyTool,
	createEditTool,
	createFetchTool,
	createWebSearchTool,
	createFdTool,
	createFindTool,
	createFsOpsTool,
	createGrepTool,
	createGitReadTool,
	createGitWriteTool,
	createJqTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createRgTool,
	createSedTool,
	createSemgrepTool,
	createSemanticSearchTool,
	createTaskTool,
	createToolsFromNames,
	createWriteTool,
	editTool,
	fetchTool,
	webSearchTool,
	fdTool,
	findTool,
	fsOpsTool,
	grepTool,
	gitReadTool,
	gitWriteTool,
	jqTool,
	lsTool,
	readOnlyTools,
	readTool,
	rgTool,
	sedTool,
	semanticSearchTool,
	semgrepTool,
	todoReadTool,
	todoWriteTool,
	type TaskToolProgress,
	type TaskToolProgressPhase,
	type Tool,
	type ToolName,
	yqTool,
	createYqTool,
	writeTool,
} from "./tools/index.js";
import { getAgentProfile, type AgentProfileName } from "./agent-profiles.js";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.iosm/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: new ModelRegistry(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Require explicit model selection by the user; disables automatic model fallback/selection for new sessions. */
	requireExplicitModelSelection?: boolean;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/** Built-in tools to use. Default: active profile tools (profile defaults to "full"). */
	tools?: Tool[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];
	/** Enable the interactive ask_user clarification tool. Best used in interactive or RPC sessions. */
	enableAskUserTool?: boolean;

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;

	/**
	 * Agent profile name. Overrides tools and thinkingLevel with profile defaults.
	 * Profiles: explore, plan, iosm_analyst, iosm_verifier, cycle_planner, meta, full (default).
	 */
	profile?: AgentProfileName | string;

	/**
	 * Whether to register the Task tool (subagent spawning).
	 * Default: true for interactive/print sessions; false for subagent sessions to avoid recursion.
	 */
	enableTaskTool?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

export function collectSubagentRenderableText(message: {
	role: string;
	content: unknown;
	display?: boolean;
}): string[] {
	if (message.role === "assistant") {
		if (!Array.isArray(message.content)) return [];
		return message.content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text.trim())
			.filter((text) => text.length > 0);
	}

	if (message.role === "custom" && message.display !== false) {
		if (typeof message.content === "string") {
			const text = message.content.trim();
			return text.length > 0 ? [text] : [];
		}
		if (Array.isArray(message.content)) {
			return message.content
				.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
				.map((part) => part.text.trim())
				.filter((text) => text.length > 0);
		}
	}

	return [];
}

// Re-exports

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandLocation,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.js";
export type { PromptTemplate } from "./prompt-templates.js";
export type { Skill } from "./skills.js";
export type { Tool } from "./tools/index.js";

	export {
		createAskUserTool,
		// Pre-built tools (use process.cwd())
		readTool,
		bashTool,
		editTool,
		writeTool,
		grepTool,
		findTool,
		lsTool,
		rgTool,
		fdTool,
		astGrepTool,
		combyTool,
		jqTool,
		yqTool,
		semgrepTool,
		sedTool,
		semanticSearchTool,
		fetchTool,
		webSearchTool,
		gitReadTool,
		gitWriteTool,
		fsOpsTool,
		codingTools,
		readOnlyTools,
		allTools as allBuiltInTools,
		// Tool factories (for custom cwd)
		createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createFetchTool,
	createWebSearchTool,
		createWriteTool,
		createGrepTool,
		createFindTool,
	createGitReadTool,
	createGitWriteTool,
	createFsOpsTool,
		createLsTool,
		createRgTool,
		createFdTool,
		createAstGrepTool,
		createCombyTool,
		createJqTool,
		createYqTool,
		createSemgrepTool,
		createSedTool,
		createSemanticSearchTool,
	};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function resolveModelBySpecifier(
	modelRegistry: ModelRegistry,
	specifier: string,
	preferredProvider?: string,
): Model<any> | undefined {
	const raw = specifier.trim();
	if (!raw) return undefined;
	const slash = raw.indexOf("/");
	if (slash > 0 && slash < raw.length - 1) {
		const provider = raw.slice(0, slash);
		const modelId = raw.slice(slash + 1);
		return modelRegistry.find(provider, modelId);
	}

	const all = modelRegistry.getAll().filter((candidate) => candidate.id === raw);
	if (all.length === 0) return undefined;
	if (preferredProvider) {
		const preferred = all.find((candidate) => candidate.provider === preferredProvider);
		if (preferred) return preferred;
	}
	return all[0];
}

function resolveModelsDevApi(modelNpm?: string): Api {
	const npm = modelNpm?.toLowerCase() ?? "";
	if (npm.includes("anthropic")) return "anthropic-messages";
	if (npm.includes("google-vertex")) return "google-vertex";
	if (npm.includes("google")) return "google-generative-ai";
	if (npm.includes("amazon-bedrock")) return "bedrock-converse-stream";
	if (npm.includes("mistral")) return "mistral-conversations";
	if (npm.includes("@ai-sdk/openai") && !npm.includes("compatible")) return "openai-responses";
	return "openai-completions";
}

function buildModelsDevProviderConfig(providerInfo: ModelsDevProviderCatalogInfo): ProviderConfigInput | undefined {
	const baseUrl = providerInfo.api ?? providerInfo.models.find((model) => !!model.api)?.api;
	if (!baseUrl) return undefined;
	if (providerInfo.models.length === 0) return undefined;

	const models: NonNullable<ProviderConfigInput["models"]> = providerInfo.models.map((model) => ({
		id: model.id,
		name: model.name,
		api: resolveModelsDevApi(model.npm ?? providerInfo.npm),
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

async function hydrateProviderModelFromModelsDev(
	modelRegistry: ModelRegistry,
	providerId: string,
	modelId: string,
): Promise<void> {
	if (modelRegistry.find(providerId, modelId)) return;
	try {
		const catalog = await loadModelsDevProviderCatalog();
		const providerInfo = catalog.get(providerId);
		if (!providerInfo) return;

		const config = buildModelsDevProviderConfig(providerInfo);
		if (!config) return;

		modelRegistry.registerProvider(providerId, config);
	} catch {
		// Best-effort hydration only; keep startup resilient when catalog/network is unavailable.
	}
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@mariozechner/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: [readTool, bashTool],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const contextProfile = options.profile?.toString().toLowerCase() === "iosm" ? "iosm" : "standard";
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd);

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, contextProfile });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;
	const requireExplicitModelSelection = options.requireExplicitModelSelection === true;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		await hydrateProviderModelFromModelsDev(modelRegistry, existingSession.model.provider, existingSession.model.modelId);
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && (await modelRegistry.getApiKey(restoredModel))) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel unless explicit selection is required.
	if (!model && !requireExplicitModelSelection) {
		const defaultProvider = settingsManager.getDefaultProvider();
		const defaultModelId = settingsManager.getDefaultModel();
		if (defaultProvider && defaultModelId) {
			await hydrateProviderModelFromModelsDev(
				modelRegistry,
				defaultProvider,
				defaultModelId,
			);
		}
		const result = await findInitialModel({
			scopedModels: options.scopedModels ?? [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	} else if (!model && requireExplicitModelSelection && !hasExistingSession) {
		modelFallbackMessage = "No model selected. Choose one with /model or pass --provider and --model.";
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	// Apply agent profile: default to "full" when no explicit profile is provided.
	// This keeps runtime tool availability aligned with UI/profile badges.
	const profile = getAgentProfile(options.profile);
	if (profile.name !== "full") {
		// Profile overrides thinking level only when caller did not explicitly pass one
		if (options.thinkingLevel === undefined && !hasExistingSession) {
			thinkingLevel = profile.thinkingLevel;
			// Re-clamp to model capabilities
			if (!model || !model.reasoning) {
				thinkingLevel = "off";
			}
		}
	}

	const enableTaskTool = options.enableTaskTool !== false; // default true
	const profileToolNames: string[] = [...profile.tools, ...(enableTaskTool ? ["task"] : []), "todo_write", "todo_read"].filter(
		(n) => n === "task" || n in allTools,
	);

	const initialActiveToolNames: string[] = options.tools
		? options.tools.map((t) => t.name).filter((n) => n === "task" || n in allTools)
		: profileToolNames;

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
		getApiKey: async (provider) => {
			// Use the provider argument from the in-flight request;
			// agent.state.model may already be switched mid-turn.
			const resolvedProvider = provider || agent.state.model?.provider;
			if (!resolvedProvider) {
				throw new Error("No model selected");
			}
			const key = await modelRegistry.getApiKeyForProvider(resolvedProvider);
			if (!key) {
				const model = agent.state.model;
				const isOAuth = model && modelRegistry.isUsingOAuth(model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${resolvedProvider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${resolvedProvider}' to re-authenticate.`,
					);
				}
				throw new Error(
					`No API key found for "${resolvedProvider}". ` +
						`Set an API key environment variable or run '/login ${resolvedProvider}'.`,
				);
			}
			return key;
		},
	});
	patchAgentForParallelTaskExecution(agent);

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.replaceMessages(existingSession.messages);
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// Build Task tool SubagentRunner — spawns isolated sub-sessions without circular imports
	const taskToolRunner = enableTaskTool
			? async (runnerOptions: {
				systemPrompt: string;
				profileName?: string;
				tools: string[];
				prompt: string;
				cwd: string;
				modelOverride?: string;
				sharedMemoryContext?: SharedMemoryContext;
				signal?: AbortSignal;
				onProgress?: (progress: TaskToolProgress) => void;
			}): Promise<
				string | { output: string; sessionId?: string; stats?: { toolCallsStarted: number; toolCallsCompleted: number; assistantMessages: number } }
			> => {
				let subModel = model;
				if (runnerOptions.modelOverride) {
					const resolved = resolveModelBySpecifier(
						modelRegistry,
						runnerOptions.modelOverride,
						model?.provider,
					);
					if (!resolved) {
						throw new Error(`Unknown model override: ${runnerOptions.modelOverride}`);
					}
					if (!(await modelRegistry.getApiKey(resolved))) {
						throw new Error(`No API key available for model override: ${resolved.provider}/${resolved.id}`);
					}
					subModel = resolved;
				}
				const sharedMemoryTools: ToolDefinition[] | undefined = runnerOptions.sharedMemoryContext
					? [
							createSharedMemoryWriteTool(runnerOptions.sharedMemoryContext) as unknown as ToolDefinition,
							createSharedMemoryReadTool(runnerOptions.sharedMemoryContext) as unknown as ToolDefinition,
						]
					: undefined;
				const { session: sub } = await createAgentSession({
					cwd: runnerOptions.cwd,
					agentDir,
					authStorage,
					modelRegistry,
					model: subModel,
					profile: runnerOptions.profileName,
					tools: createToolsFromNames(runnerOptions.cwd, runnerOptions.tools, {
						semantic: { authStorage, agentDir },
					}),
					customTools: sharedMemoryTools,
					sessionManager: SessionManager.inMemory(),
					settingsManager,
					enableTaskTool: false, // prevent recursive subagent spawning
				});

				// Apply profile system prompt by appending it to the base after session init
				if (runnerOptions.systemPrompt) {
					const base = sub.agent.state.systemPrompt;
					sub.agent.setSystemPrompt(
						base ? `${base}\n\n${runnerOptions.systemPrompt}` : runnerOptions.systemPrompt,
					);
				}

				// Collect all assistant text from the sub-session
				const chunks: string[] = [];
				const abortSubagent = (): void => {
					void sub.abort();
				};
				if (runnerOptions.signal?.aborted) {
					abortSubagent();
					throw new Error("Operation aborted");
				}
				runnerOptions.signal?.addEventListener("abort", abortSubagent, { once: true });
				const progressState = {
					toolCallsStarted: 0,
					toolCallsCompleted: 0,
					assistantMessages: 0,
					activeTool: undefined as string | undefined,
				};
				const displayFallbackChunks: string[] = [];
				const trimInline = (value: string, max = 60): string => {
					const compact = value.trim().replace(/\s+/g, " ");
					return compact.length > max ? `${compact.slice(0, Math.max(1, max - 3))}...` : compact;
				};
				const summarizeToolTarget = (toolName: string, args: unknown): string => {
					if (!args || typeof args !== "object") return `running ${toolName}`;
					const record = args as Record<string, unknown>;
					const filePath =
						typeof record.file_path === "string"
							? record.file_path
							: typeof record.path === "string"
								? record.path
								: undefined;
					if (filePath) {
						return `running ${toolName} (${trimInline(filePath, 50)})`;
					}
					const command =
						typeof record.command === "string"
							? record.command
							: typeof record.cmd === "string"
								? record.cmd
								: undefined;
					if (command) {
						return `running ${toolName} (${trimInline(command, 50)})`;
					}
					return `running ${toolName}`;
				};
				const emitProgress = (phase: TaskToolProgressPhase, message: string, activeTool?: string): void => {
					progressState.activeTool = activeTool;
					runnerOptions.onProgress?.({
						kind: "subagent_progress",
						phase,
						message,
						cwd: runnerOptions.cwd,
						activeTool: progressState.activeTool,
						toolCallsStarted: progressState.toolCallsStarted,
						toolCallsCompleted: progressState.toolCallsCompleted,
						assistantMessages: progressState.assistantMessages,
					});
				};
				emitProgress("starting", "booting subagent", undefined);

				try {
					sub.subscribe((event) => {
						if (event.type === "message_end" && event.message.role === "assistant") {
							progressState.assistantMessages += 1;
							chunks.push(...collectSubagentRenderableText(event.message));
							if (chunks.length > 0) {
								emitProgress("responding", "drafting response", undefined);
							}
						}
						if (event.type === "message_end" && event.message.role === "custom") {
							displayFallbackChunks.push(...collectSubagentRenderableText(event.message));
						}
						if (event.type === "tool_execution_start") {
							progressState.toolCallsStarted += 1;
							const toolName = event.toolName ?? "tool";
							emitProgress("running", summarizeToolTarget(toolName, event.args), toolName);
						}
						if (event.type === "tool_execution_end") {
							progressState.toolCallsCompleted += 1;
							const toolName = event.toolName ?? "tool";
							const nextActive = progressState.activeTool === toolName ? undefined : progressState.activeTool;
							emitProgress("running", `completed ${toolName}`, nextActive);
						}
					});

					await sub.prompt(runnerOptions.prompt, { skipIosmAutopilot: true });
					if (runnerOptions.signal?.aborted) {
						throw new Error("Operation aborted");
					}
					emitProgress("responding", "finalizing response", undefined);
					const sessionId = sub.sessionManager.getSessionId();
					const outputChunks = chunks.length > 0 ? chunks : displayFallbackChunks;
					return {
						output: outputChunks.join("\n\n"),
						sessionId,
						stats: {
							toolCallsStarted: progressState.toolCallsStarted,
							toolCallsCompleted: progressState.toolCallsCompleted,
							assistantMessages: progressState.assistantMessages,
						},
					};
				} finally {
					runnerOptions.signal?.removeEventListener("abort", abortSubagent);
					sub.dispose();
				}
			}
		: undefined;

	let sessionRef: AgentSession | undefined;
	const initialCustomSubagents = loadCustomSubagents({ cwd, agentDir });
	for (const diagnostic of initialCustomSubagents.diagnostics) {
		console.warn(`Warning: invalid subagent ${diagnostic.path}: ${diagnostic.message}`);
	}
	const taskTool = taskToolRunner
		? createTaskTool(cwd, taskToolRunner, {
				resolveCustomSubagent: (name) => {
					// Resolve against live on-disk definitions so newly created agents
					// are immediately callable in the same interactive session.
					const current = loadCustomSubagents({ cwd, agentDir });
					const resolvedName = resolveCustomSubagentReference(name, current.agents);
					return resolvedName ? current.agents.find((agent) => agent.name === resolvedName) : undefined;
				},
				availableCustomSubagents: initialCustomSubagents.agents.map((agent) => agent.name),
				availableCustomSubagentHints: initialCustomSubagents.agents.map((agent) => ({
					name: agent.name,
					description: agent.description,
				})),
				getMetaMessages: () => sessionRef?.getMetaMessages() ?? [],
				hostProfileName: profile?.name,
				getHostProfileName: () => sessionRef?.profileName ?? profile?.name,
			})
			: undefined;

	// Wire in ask_user, task tool, and any caller-supplied custom tools
	const baseCustomTools: ToolDefinition[] = [
		...(options.customTools ?? []).filter(
			(t) => t.name !== "ask_user" && t.name !== "task",
		),
		...(taskTool ? [taskTool as unknown as ToolDefinition] : []),
	];

	const customTools: ToolDefinition[] | undefined = options.enableAskUserTool
		? [
				...baseCustomTools.filter((tool) => tool.name !== "ask_user"),
				createAskUserTool() as unknown as ToolDefinition,
			]
		: baseCustomTools.length > 0
			? baseCustomTools
			: options.customTools;

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools,
		modelRegistry,
		initialActiveToolNames,
		extensionRunnerRef,
		systemPromptSuffix: profile?.systemPromptAppend || undefined,
		iosmAutopilotEnabled: profile?.name === "iosm",
		profileName: profile?.name,
	});
	sessionRef = session;
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}

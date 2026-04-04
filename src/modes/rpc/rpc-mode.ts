/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import * as readline from "readline";
import type { AgentSession } from "../../core/agent-session.js";
import { dispatchBuiltinSlashCommand } from "../../core/command-dispatcher.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import type { ToolPermissionRequest } from "../../core/tools/index.js";
import { type Theme, theme } from "../interactive/theme/theme.js";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcRequiresConfirmationEvent,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// Re-export types for consumers
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcRequiresConfirmationEvent,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.js";

// ============================================================================
// Input validation
// ============================================================================

/** All valid RPC command type strings */
const VALID_RPC_COMMAND_TYPES = new Set<string>([
	"prompt", "steer", "follow_up", "abort", "new_session",
	"get_state",
	"set_model", "cycle_model", "get_available_models",
	"set_thinking_level", "cycle_thinking_level",
	"set_permission_mode", "get_permission_mode",
	"set_steering_mode", "set_follow_up_mode",
	"compact", "set_auto_compaction",
	"set_auto_retry", "abort_retry",
	"bash", "abort_bash",
	"get_session_stats", "export_html", "switch_session", "fork",
	"get_fork_messages", "get_last_assistant_text", "set_session_name",
	"get_messages", "get_commands", "get_builtin_commands", "run_builtin_command",
]);

/** Fields that must be strings for specific command types */
const REQUIRED_STRING_FIELDS: Partial<Record<string, string[]>> = {
	prompt: ["message"],
	steer: ["message"],
	follow_up: ["message"],
	set_model: ["provider", "modelId"],
	set_thinking_level: ["level"],
	set_permission_mode: ["mode"],
	set_steering_mode: ["mode"],
	set_follow_up_mode: ["mode"],
	bash: ["command"],
	switch_session: ["sessionPath"],
	fork: ["entryId"],
	set_session_name: ["name"],
	run_builtin_command: ["commandText"],
};

/** Fields that must be booleans for specific command types */
const REQUIRED_BOOLEAN_FIELDS: Partial<Record<string, string[]>> = {
	set_auto_compaction: ["enabled"],
	set_auto_retry: ["enabled"],
};

/**
 * Validates a parsed RPC command object at runtime.
 * Returns an error string if invalid, undefined if valid.
 */
function validateRpcCommand(parsed: unknown): string | undefined {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return "Command must be a JSON object.";
	}

	const obj = parsed as Record<string, unknown>;
	const type = obj.type;

	if (typeof type !== "string" || !type) {
		return 'Command must have a string "type" field.';
	}

	if (!VALID_RPC_COMMAND_TYPES.has(type)) {
		return `Unknown command type: "${type}".`;
	}

	for (const field of REQUIRED_STRING_FIELDS[type] ?? []) {
		if (typeof obj[field] !== "string") {
			return `Command "${type}" requires a string field "${field}".`;
		}
	}

	for (const field of REQUIRED_BOOLEAN_FIELDS[type] ?? []) {
		if (typeof obj[field] !== "boolean") {
			return `Command "${type}" requires a boolean field "${field}".`;
		}
	}

	return undefined;
}

const DANGEROUS_TOOL_NAMES = new Set(["bash", "edit", "write", "git_write", "fs_ops", "db_run"]);

function matchesPermissionRule(rule: string, request: ToolPermissionRequest): boolean {
	const [ruleToolRaw, ...rest] = rule.split(":");
	const ruleTool = (ruleToolRaw ?? "").trim();
	const ruleNeedle = rest.join(":").trim().toLowerCase();
	const toolMatches = !ruleTool || ruleTool === "*" || ruleTool === request.toolName;
	if (!toolMatches) return false;
	return !ruleNeedle || request.summary.toLowerCase().includes(ruleNeedle);
}

function buildPermissionPromptLabel(request: ToolPermissionRequest): string {
	const tierLabel = request.requiredPermission ? ` [${request.requiredPermission}]` : "";
	const sourceLabel = request.toolSource === "extension" ? " extension" : "";
	return `${request.toolName}${tierLabel}${sourceLabel}: ${request.summary}`;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(session: AgentSession): Promise<never> {
	const output = (obj: RpcResponse | RpcExtensionUIRequest | RpcRequiresConfirmationEvent | object) => {
		console.log(JSON.stringify(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Shutdown request flag
	let shutdownRequested = false;

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
		requestId?: string,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = requestId ?? crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	async function requestToolPermissionFromHost(request: ToolPermissionRequest): Promise<boolean> {
		const id = crypto.randomUUID();
		const title = "Permission required";
		const message = buildPermissionPromptLabel(request);
		output({
			type: "requires_confirmation",
			id,
			message,
			request,
		} satisfies RpcRequiresConfirmationEvent);

		return createDialogPromise(
			{ timeout: 5 * 60 * 1000 },
			false,
			{ method: "confirm_permission", title, message, request, timeout: 5 * 60 * 1000 },
			(response) => ("cancelled" in response && response.cancelled ? false : "confirmed" in response ? response.confirmed : false),
			id,
		);
	}

	session.setToolPermissionHandler(async (request) => {
		const denyRules = session.settingsManager.getPermissionDenyRules();
		for (const rule of denyRules) {
			if (matchesPermissionRule(rule, request)) {
				return false;
			}
		}

		const allowRules = session.settingsManager.getPermissionAllowRules();
		for (const rule of allowRules) {
			if (matchesPermissionRule(rule, request)) {
				return true;
			}
		}

		const mode = session.settingsManager.getPermissionMode();
		if (mode === "yolo") {
			return true;
		}

		// Non-destructive tools stay non-interactive in RPC mode.
		if (!DANGEROUS_TOOL_NAMES.has(request.toolName)) {
			return true;
		}

		if (mode === "auto") {
			// Keep parity with interactive defaults: edit/write are auto-approved.
			if (request.toolName === "edit" || request.toolName === "write") {
				return true;
			}
		}

		return requestToolPermissionFromHost(request);
	});

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	// Set up extensions with RPC-based UI context
	await session.bindExtensions({
		uiContext: createExtensionUIContext(),
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => {
				// Delegate to AgentSession (handles setup + agent state sync)
				const success = await session.newSession(options);
				return { cancelled: !success };
			},
			fork: async (entryId) => {
				const result = await session.fork(entryId);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath) => {
				const success = await session.switchSession(sessionPath);
				return { cancelled: !success };
			},
			reload: async () => {
				await session.reload();
			},
		},
		shutdownHandler: () => {
			shutdownRequested = true;
		},
		onError: (err) => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
	});

	// Output all agent events as JSON
	session.subscribe((event) => {
		output(event);
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
					})
					.catch((e) => output(error(id, "prompt", e.message)));
				return success(id, "prompt");
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const cancelled = !(await session.newSession(options));
				return success(id, "new_session", { cancelled });
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					permissionMode: session.settingsManager.getPermissionMode(),
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "set_permission_mode": {
				session.settingsManager.setPermissionMode(command.mode);
				return success(id, "set_permission_mode", { mode: session.settingsManager.getPermissionMode() });
			}

			case "get_permission_mode": {
				return success(id, "get_permission_mode", { mode: session.settingsManager.getPermissionMode() });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const cancelled = !(await session.switchSession(command.sessionPath));
				return success(id, "switch_session", { cancelled });
			}

			case "fork": {
				const result = await session.fork(command.entryId);
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				// Extension commands
				for (const { command, extensionPath } of session.extensionRunner?.getRegisteredCommandsWithPaths() ?? []) {
					commands.push({
						name: command.name,
						description: command.description,
						source: "extension",
						path: extensionPath,
					});
				}

				// Prompt templates (source is always "user" | "project" | "path" in coding-agent)
				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						location: template.source as RpcSlashCommand["location"],
						path: template.filePath,
					});
				}

				// Skills (source is always "user" | "project" | "path" in coding-agent)
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						location: skill.source as RpcSlashCommand["location"],
						path: skill.filePath,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "get_builtin_commands": {
				return success(id, "get_builtin_commands", {
					commands: BUILTIN_SLASH_COMMANDS.map((command) => ({
						name: command.name,
						description: command.description,
					})),
				});
			}

			case "run_builtin_command": {
				const result = await dispatchBuiltinSlashCommand(command.commandText, {
					session,
					settingsManager: session.settingsManager,
				});
				return success(id, "run_builtin_command", result);
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;

		const currentRunner = session.extensionRunner;
		if (currentRunner?.hasHandlers("session_shutdown")) {
			await currentRunner.emit({ type: "session_shutdown" });
		}

		// Close readline interface to stop waiting for input
		rl.close();
		process.exit(0);
	}

	// Listen for JSON input
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});

	rl.on("line", async (line: string) => {
		try {
			const parsed = JSON.parse(line);

			// Handle extension UI responses
			if (parsed.type === "extension_ui_response") {
				const response = parsed as RpcExtensionUIResponse;
				const pending = pendingExtensionRequests.get(response.id);
				if (pending) {
					pendingExtensionRequests.delete(response.id);
					pending.resolve(response);
				}
				return;
			}

			// Validate regular commands before processing
			const validationError = validateRpcCommand(parsed);
			if (validationError) {
				output(error(undefined, "parse", validationError));
				return;
			}

			const command = parsed as RpcCommand;
			const response = await handleCommand(command);
			output(response);

			// Check for deferred shutdown request (idle between commands)
			await checkShutdownRequested();
		} catch (e: any) {
			output(error(undefined, "parse", `Failed to parse command: ${e.message}`));
		}
	});

	// Keep process alive forever
	return new Promise(() => {});
}

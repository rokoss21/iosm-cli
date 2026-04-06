import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { marked, type Token, type Tokens } from "marked";
import { setTimeout as sleepTimeout } from "node:timers/promises";
import { APP_NAME, VERSION } from "../../config.js";
import type { BuiltinCommandResult } from "../../core/command-dispatcher.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import { RpcClient } from "../rpc/rpc-client.js";
import {
	TelegramBotApi,
	type TelegramCallbackQuery,
	type TelegramChatId,
	type TelegramInlineKeyboardMarkup,
	type TelegramReplyKeyboardMarkup,
	type TelegramUpdate,
} from "./telegram-api.js";
import { TelegramPollingStateStore } from "./polling-state.js";
import { TelegramPromptQueue } from "./prompt-queue.js";
import type {
	RpcBuiltinSlashCommand,
	RpcExtensionUIRequest,
	RpcRequiresConfirmationEvent,
	RpcSessionState,
	RpcSlashCommand,
} from "../rpc/rpc-types.js";

export interface TelegramBridgeModeOptions {
	/**
	 * Original CLI argv (without node/script prefixes). Used to forward model/profile/session args to RPC child.
	 */
	rawArgs: string[];
	/** Loaded settings manager for telegram settings and runtime updates. */
	settingsManager: SettingsManager;
	/** Optional explicit cli path for RPC child. Defaults to current process argv[1]. */
	cliPath?: string;
	/** Optional cwd override for RPC child. */
	cwd?: string;
}

interface ActiveTurnState {
	turnId: number;
	chatId: TelegramChatId;
	prompt: string;
	startedAt: number;
	statusMessageId: number;
	phase: string;
	lastTool?: string;
	aborted: boolean;
	statusEditPending: boolean;
	statusEditTimer?: NodeJS.Timeout;
	statusEditInFlight?: Promise<void>;
	lastStatusEditAt: number;
	lastAssistantTurnText?: string;
}

interface PendingConfirmation {
	chatId: TelegramChatId;
	requestId: string;
	label: string;
	groupKey: string;
}

interface CommandCatalogEntry {
	name: string;
	description?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
	commandText: string;
}

type CommandMenuView = "main" | "all";

interface ModelCatalogEntry {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

type HubView = "compact" | "details";

const COMMANDS_PAGE_SIZE = 8;
const COMMAND_MENU_TTL_MS = 5 * 60 * 1000;
const MODELS_PAGE_SIZE = 8;
const MODEL_MENU_TTL_MS = 2 * 60 * 1000;
const TELEGRAM_SAFE_TEXT_CHUNK = 3500;
const INPUT_BUTTON_HUB = "🧭 Hub";
const INPUT_BUTTON_START = "▶️ Start";
const INPUT_BUTTON_NEW = "🆕 New";
const INPUT_BUTTON_COMMANDS = "⚡ Cmd";
const INPUT_BUTTON_HELP = "❓ Help";
const INPUT_BUTTON_ABORT = "⛔ Abort";
const INPUT_BUTTON_STOP = "🛑 Stop";
const MAIN_COMMAND_MENU: CommandCatalogEntry[] = [
	{
		name: "model",
		description: "Choose active model",
		source: "builtin",
		commandText: "/model",
	},
	{
		name: "status",
		description: "Show control hub status",
		source: "builtin",
		commandText: "/status",
	},
	{
		name: "new",
		description: "Start a new session",
		source: "builtin",
		commandText: "/new",
	},
	{
		name: "abort",
		description: "Abort active task",
		source: "builtin",
		commandText: "/abort",
	},
	{
		name: "permissions",
		description: "Show permission mode",
		source: "builtin",
		commandText: "/permissions status",
	},
	{
		name: "yolo",
		description: "Show YOLO mode",
		source: "builtin",
		commandText: "/yolo status",
	},
	{
		name: "help",
		description: "Show command help",
		source: "builtin",
		commandText: "/help",
	},
	{
		name: "stop",
		description: "Stop bridge and cancel active work",
		source: "builtin",
		commandText: "/stop",
	},
];

export async function runTelegramBridgeMode(options: TelegramBridgeModeOptions): Promise<never> {
	const mode = new TelegramBridgeRuntime(options);
	await mode.run();
	// run() loops forever unless it throws; keep Promise<never> contract explicit.
	return new Promise(() => {});
}

class TelegramBridgeRuntime {
	private readonly settingsManager: SettingsManager;
	private readonly bot: TelegramBotApi;
	private readonly botToken: string;
	private readonly allowedUserIds: Set<number>;
	private readonly statusEditThrottleMs: number;
	private readonly maxSummaryChars: number;
	private readonly rpcClient: RpcClient;
	private readonly pollingTraceEnabled: boolean;
	private readonly pollingBackoffInitialMs: number;
	private readonly pollingBackoffMaxMs: number;
	private readonly statusEditNetworkRetryMs: number;
	private readonly promptQueue = new TelegramPromptQueue();
	private readonly pollingState: TelegramPollingStateStore;
	private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
	private readonly pendingConfirmationGroupIdsByKey = new Map<string, Set<string>>();
	private readonly commandCatalogByChat = new Map<TelegramChatId, { updatedAt: number; entries: CommandCatalogEntry[] }>();
	private readonly modelCatalogByChat = new Map<TelegramChatId, { updatedAt: number; entries: ModelCatalogEntry[] }>();
	private readonly hubMessageIdByChat = new Map<TelegramChatId, number>();
	private readonly hubViewByChat = new Map<TelegramChatId, HubView>();
	private readonly inputMenuEnabledByChat = new Set<TelegramChatId>();
	private nextUpdateOffset: number;
	private nextTurnId = 1;
	private activeTurn: ActiveTurnState | undefined;
	private activeSessionState: RpcSessionState | undefined;
	private lastAuthorizedChatId: TelegramChatId | undefined;
	private rpcConnected = false;
	private bridgeStopped = false;
	private pollingRetryDelayMs = 0;

	constructor(private readonly options: TelegramBridgeModeOptions) {
		this.settingsManager = options.settingsManager;
		const telegramSettings = this.settingsManager.getTelegramSettings();
		if (!telegramSettings.enabled) {
			throw new Error("Telegram bridge is disabled in settings (telegram.enabled=false).");
		}
		if (!telegramSettings.botToken) {
			throw new Error("Telegram bridge requires settings.telegram.botToken.");
		}
		if (telegramSettings.allowedUserIds.length === 0) {
			throw new Error("Telegram bridge requires at least one allowed user ID in settings.telegram.allowedUserIds.");
		}
		if (telegramSettings.transport !== "long-polling") {
			throw new Error(`Unsupported telegram transport: ${telegramSettings.transport}`);
		}

		this.botToken = telegramSettings.botToken;
		this.bot = new TelegramBotApi(telegramSettings.botToken, undefined, {
			max429Retries: telegramSettings.retry.apiMax429Retries,
			maxNetworkRetries: telegramSettings.retry.apiMaxNetworkRetries,
			networkBackoffInitialMs: telegramSettings.retry.apiNetworkBackoffInitialMs,
			networkBackoffMaxMs: telegramSettings.retry.apiNetworkBackoffMaxMs,
		});
		this.allowedUserIds = new Set(telegramSettings.allowedUserIds);
		this.statusEditThrottleMs = telegramSettings.chatDefaults.statusEditThrottleMs;
		this.maxSummaryChars = telegramSettings.chatDefaults.maxSummaryChars;
		this.pollingBackoffInitialMs = telegramSettings.retry.pollingBackoffInitialMs;
		this.pollingBackoffMaxMs = telegramSettings.retry.pollingBackoffMaxMs;
		this.statusEditNetworkRetryMs = telegramSettings.retry.statusEditNetworkRetryMs;
		this.pollingRetryDelayMs = this.pollingBackoffInitialMs;
		const envTrace = /^(1|true|yes|on)$/i.test(process.env.IOSM_TELEGRAM_POLLING_TRACE ?? "");
		this.pollingTraceEnabled = telegramSettings.debug.pollingTrace || envTrace;
		this.pollingState = new TelegramPollingStateStore();
		this.nextUpdateOffset = this.pollingState.loadOffset(this.botToken);
		this.rpcClient = new RpcClient({
			cliPath: options.cliPath,
			cwd: options.cwd,
			args: this.buildRpcForwardedArgs(options.rawArgs),
		});
	}

	async run(): Promise<void> {
		const me = await this.bot.getMe();
		await this.startRpc();
		console.log(`[telegram] bridge online as @${me.username ?? "unknown"} (${me.id})`);
		if (this.pollingTraceEnabled) {
			console.log("[telegram] polling trace enabled");
		}
		if (this.nextUpdateOffset > 0) {
			this.tracePolling(`restored offset=${this.nextUpdateOffset}`);
		}

		const shutdown = async (signal: string) => {
			console.log(`[telegram] received ${signal}, stopping bridge...`);
			this.persistPollingOffset();
			try {
				await this.rpcClient.stop();
			} finally {
				process.exit(0);
			}
		};
		process.once("SIGINT", () => {
			void shutdown("SIGINT");
		});
		process.once("SIGTERM", () => {
			void shutdown("SIGTERM");
		});

		this.rpcClient.onEvent((event) => {
			void this.onRpcEvent(event).catch((error) => {
				console.error(`[telegram] rpc event handler error: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
		this.rpcClient.onExtensionUIRequest((request) => {
			void this.onRpcExtensionUiRequest(request).catch((error) => {
				console.error(`[telegram] rpc extension ui handler error: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
		this.rpcClient.onRequiresConfirmation((event) => {
			void this.onRpcConfirmationRequest(event).catch((error) => {
				console.error(
					`[telegram] rpc confirmation handler error: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		});

		// Keep polling forever.
		for (;;) {
			try {
				const pollStartedAt = Date.now();
				const offsetBeforePoll = this.nextUpdateOffset;
				this.tracePolling(`getUpdates start offset=${offsetBeforePoll} timeout=25`);
				const updates = await this.bot.getUpdates(this.nextUpdateOffset, 25);
				this.tracePolling(
					`getUpdates ok offset=${offsetBeforePoll} updates=${updates.length} elapsed=${Date.now() - pollStartedAt}ms`,
				);
				this.pollingRetryDelayMs = this.pollingBackoffInitialMs;
				let offsetChanged = false;
				for (const update of updates) {
					const prevOffset = this.nextUpdateOffset;
					this.tracePolling(`update recv id=${update.update_id} ${this.describeUpdate(update)}`);
					await this.handleUpdate(update);
					this.nextUpdateOffset = Math.max(this.nextUpdateOffset, update.update_id + 1);
					offsetChanged = offsetChanged || this.nextUpdateOffset !== prevOffset;
					this.tracePolling(`update done id=${update.update_id} offset=${prevOffset}->${this.nextUpdateOffset}`);
				}
				if (offsetChanged) {
					this.persistPollingOffset();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const transient = this.isTransientNetworkError(error);
				const waitMs = transient ? this.pollingRetryDelayMs : this.pollingBackoffInitialMs;
				console.error(
					`[telegram] polling error: ${message}${transient ? ` (retry in ${Math.ceil(waitMs / 1000)}s)` : ""}`,
				);
				this.tracePolling(`polling exception transient=${transient} wait=${waitMs}ms`);
				await sleepTimeout(waitMs);
				this.pollingRetryDelayMs = transient
					? Math.min(this.pollingRetryDelayMs * 2, this.pollingBackoffMaxMs)
					: this.pollingBackoffInitialMs;
			}
		}
	}

	private buildRpcForwardedArgs(rawArgs: string[]): string[] {
		const forwarded: string[] = [];
		for (let i = 0; i < rawArgs.length; i++) {
			const arg = rawArgs[i];
			if (i === 0 && arg === "telegram") continue;
			if (arg === "--mode") {
				// RPC mode is enforced by RpcClient; ignore any caller-provided mode.
				i += 1;
				continue;
			}
			forwarded.push(arg);
		}
		return this.injectTelegramRuntimePrompt(forwarded);
	}

	private injectTelegramRuntimePrompt(args: string[]): string[] {
		const runtimePrompt = this.buildTelegramRuntimePrompt();
		if (!runtimePrompt) return args;

		const promptArg = "--append-system-prompt";
		const index = args.findIndex((arg) => arg === promptArg);
		if (index >= 0 && index + 1 < args.length) {
			const existing = args[index + 1] ?? "";
			args[index + 1] = existing.trim().length > 0 ? `${existing}\n\n${runtimePrompt}` : runtimePrompt;
			return args;
		}

		args.push(promptArg, runtimePrompt);
		return args;
	}

	private buildTelegramRuntimePrompt(): string {
		const lines: string[] = [
			"Telegram bridge runtime constraints:",
			"- Keep responses concise and structured; avoid unnecessary long prose.",
			"- Prefer specialized tools (read/rg/find/ls/git_read/test_run/lint_run/typecheck_run) over huge generic shell scans.",
			"- For repository-wide search, exclude high-noise directories by default (node_modules, .git, dist, build, coverage, .next).",
			"- For outputs likely to be very large, provide a compact summary first and save full artifacts to files.",
		];

		if (process.platform === "win32") {
			lines.push(
				"- Runtime shell on Windows may pass through bash/cmd/powershell adapters; avoid fragile one-liners with heavy nested escaping.",
				"- For complex PowerShell or cmd logic, write a temporary .ps1/.cmd script file and execute the script path instead of inline quoting.",
				"- If a command fails due to quoting/escaping, switch to script-file execution path immediately rather than retrying the same inline command.",
			);
		}

		return lines.join("\n");
	}

	private async startRpc(): Promise<void> {
		try {
			await this.rpcClient.start();
			this.activeSessionState = await this.rpcClient.getState();
			this.rpcConnected = true;
		} catch (error) {
			this.rpcConnected = false;
			throw new Error(`Failed to start RPC child: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async restartRpc(): Promise<void> {
		await this.rpcClient.stop();
		await this.startRpc();
	}

	private async ensureRpcConnected(): Promise<void> {
		if (this.rpcConnected) return;
		await this.restartRpc();
	}

	private persistPollingOffset(): void {
		this.pollingState.saveOffset(this.botToken, this.nextUpdateOffset);
	}

	private isAuthorizedUser(userId: number | undefined): userId is number {
		return typeof userId === "number" && this.allowedUserIds.has(userId);
	}

	private tracePolling(message: string): void {
		if (!this.pollingTraceEnabled) return;
		console.log(`[telegram][poll] ${message}`);
	}

	private clipForLog(value: string | undefined, limit = 80): string {
		if (!value) return "";
		const normalized = value.replace(/\s+/g, " ").trim();
		if (normalized.length <= limit) return normalized;
		return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
	}

	private describeUpdate(update: TelegramUpdate): string {
		if (update.callback_query) {
			const callback = update.callback_query;
			const chatId = callback.message?.chat.id;
			const userId = callback.from?.id;
			const data = this.clipForLog(callback.data, 96);
			return `callback chat=${chatId ?? "?"} user=${userId ?? "?"} id=${callback.id} data="${data}"`;
		}
		if (update.message) {
			const message = update.message;
			const userId = message.from?.id;
			const text = this.clipForLog(message.text, 96);
			return `message chat=${message.chat.id} user=${userId ?? "?"} message_id=${message.message_id} text="${text}"`;
		}
		return "unknown update payload";
	}

	private buildInputMenuKeyboard(stopped = this.bridgeStopped): TelegramReplyKeyboardMarkup {
		if (stopped) {
			return {
				keyboard: [[{ text: INPUT_BUTTON_HUB }, { text: INPUT_BUTTON_START }], [{ text: INPUT_BUTTON_HELP }]],
				resize_keyboard: true,
				is_persistent: true,
				input_field_placeholder: "Bridge stopped. Tap Start to resume",
			};
		}
		return {
			keyboard: [
				[{ text: INPUT_BUTTON_HUB }, { text: INPUT_BUTTON_NEW }, { text: INPUT_BUTTON_COMMANDS }],
				[{ text: INPUT_BUTTON_HELP }, { text: INPUT_BUTTON_ABORT }, { text: INPUT_BUTTON_STOP }],
			],
			resize_keyboard: true,
			is_persistent: true,
			input_field_placeholder: "Write a task or pick an action",
		};
	}

	private async ensureInputMenu(chatId: TelegramChatId, force = false): Promise<void> {
		if (!force && this.inputMenuEnabledByChat.has(chatId)) return;
		const notice = force ? "Quick actions updated ↓" : "Quick actions ready ↓";
		await this.bot.sendMessage(chatId, notice, {
			replyMarkup: this.buildInputMenuKeyboard(),
			disableNotification: true,
		});
		this.inputMenuEnabledByChat.add(chatId);
	}

	private normalizeInputActionText(text: string): string {
		return text
			.normalize("NFKC")
			.replace(/\uFE0F/g, "")
			.toLowerCase()
			.replace(/[^\p{Letter}\p{Number} ]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private mapInputMenuAction(text: string): string | undefined {
		const normalized = this.normalizeInputActionText(text);
		switch (normalized) {
			case "start":
			case "resume":
			case "старт":
			case "запуск":
				return "/start";
			case "hub":
			case "status":
			case "хаб":
			case "статус":
				return "/status";
			case "new":
			case "new session":
			case "новая":
			case "новая сессия":
			case "новый":
				return "/new";
			case "cmd":
			case "command":
			case "commands":
			case "команда":
			case "команды":
				return "/commands";
			case "help":
			case "помощь":
			case "хелп":
				return "/help";
			case "abort":
			case "cancel":
			case "прервать":
			case "отмена":
				return "/abort";
			case "stop":
			case "стоп":
				return "/stop";
		}
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_START)) return "/start";
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_HUB)) return "/status";
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_NEW)) return "/new";
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_COMMANDS)) return "/commands";
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_HELP)) return "/help";
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_ABORT)) return "/abort";
		if (normalized === this.normalizeInputActionText(INPUT_BUTTON_STOP)) return "/stop";
		return undefined;
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		if (update.callback_query) {
			this.tracePolling(`dispatch callback id=${update.callback_query.id}`);
			await this.handleCallbackQuery(update.callback_query);
			return;
		}
		if (!update.message?.text) {
			this.tracePolling(`skip update id=${update.update_id} reason=no-text-message`);
			return;
		}

		const message = update.message;
		const userId = message.from?.id;
		if (!this.isAuthorizedUser(userId)) {
			console.warn(
				`[telegram] unauthorized message ignored (user=${userId ?? "unknown"}, chat=${message.chat.id})`,
			);
			this.tracePolling(`reject message chat=${message.chat.id} user=${userId ?? "?"} reason=unauthorized`);
			return;
		}

		this.lastAuthorizedChatId = message.chat.id;
		const text = (message.text ?? "").trim();
		if (text.length === 0) {
			this.tracePolling(`skip message chat=${message.chat.id} message_id=${message.message_id} reason=empty-text`);
			return;
		}
		if (!this.inputMenuEnabledByChat.has(message.chat.id)) {
			await this.ensureInputMenu(message.chat.id);
			this.tracePolling(`input menu initialized chat=${message.chat.id}`);
		}

		const quickActionCommand = this.mapInputMenuAction(text);
		if (quickActionCommand) {
			this.tracePolling(`quick action chat=${message.chat.id} command=${quickActionCommand}`);
			await this.handleCommandMessage(message.chat.id, quickActionCommand);
			return;
		}

		if (text.startsWith("/")) {
			this.tracePolling(`slash command chat=${message.chat.id} command=${this.clipForLog(text, 64)}`);
			await this.handleCommandMessage(message.chat.id, text);
			return;
		}

		if (this.bridgeStopped) {
			await this.bot.sendMessage(message.chat.id, "Bridge is stopped. Use /start to resume.");
			this.tracePolling(`prompt blocked chat=${message.chat.id} reason=bridge-stopped`);
			return;
		}

		this.tracePolling(`enqueue prompt chat=${message.chat.id} size_before=${this.promptQueue.size}`);
		await this.enqueuePrompt(message.chat.id, text);
	}

	private async handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
		const userId = callback.from?.id;
		if (!this.isAuthorizedUser(userId)) {
			await this.bot.answerCallbackQuery(callback.id, "Unauthorized");
			console.warn(`[telegram] unauthorized callback ignored (user=${userId ?? "unknown"})`);
			this.tracePolling(`reject callback id=${callback.id} user=${userId ?? "?"} reason=unauthorized`);
			return;
		}

		const data = callback.data?.trim();
		if (!data) {
			this.tracePolling(`skip callback id=${callback.id} reason=empty-data`);
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}
		this.tracePolling(`callback route id=${callback.id} data=${this.clipForLog(data, 80)}`);

		if (data.startsWith("confirm:")) {
			const [, requestId, decision] = data.split(":");
			if (!requestId || (decision !== "yes" && decision !== "no")) {
				await this.bot.answerCallbackQuery(callback.id, "Invalid confirmation payload");
				return;
			}
			const confirmed = decision === "yes";
			const pending = this.pendingConfirmations.get(requestId);
			this.tracePolling(`confirmation callback id=${callback.id} request=${requestId} decision=${decision}`);
			await this.respondConfirmation(requestId, confirmed);
			const confirmChatId = callback.message?.chat.id;
			const confirmMessageId = callback.message?.message_id;
			if (confirmChatId && typeof confirmMessageId === "number") {
				await this.updateConfirmationDecisionMessage(confirmChatId, confirmMessageId, confirmed, pending?.label);
				await this.moveLiveStatusToBottom(confirmChatId);
			}
			await this.bot.answerCallbackQuery(callback.id, confirmed ? "Approved" : "Denied");
			return;
		}

		if (data.startsWith("hub:")) {
			this.tracePolling(`hub callback id=${callback.id} action=${data.slice(4)}`);
			await this.bot.answerCallbackQuery(callback.id);
			await this.handleHubAction(callback.message?.chat.id, data.slice(4));
			return;
		}

		if (data.startsWith("live:")) {
			this.tracePolling(`live callback id=${callback.id} action=${data.slice(5)}`);
			await this.handleLiveAction(callback, data);
			return;
		}

		if (data.startsWith("cmd:")) {
			this.tracePolling(`cmd callback id=${callback.id}`);
			await this.handleCommandMenuCallback(callback, data);
			return;
		}

		if (data.startsWith("model:")) {
			this.tracePolling(`model callback id=${callback.id}`);
			await this.handleModelMenuCallback(callback, data);
			return;
		}

		await this.bot.answerCallbackQuery(callback.id);
	}

	private async handleHubAction(chatId: TelegramChatId | undefined, action: string): Promise<void> {
		if (!chatId) return;
		const stoppedSafeActions = new Set(["status", "refresh", "details", "compact", "start", "help"]);
		if (this.bridgeStopped && !stoppedSafeActions.has(action)) {
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			return;
		}
		switch (action) {
			case "start":
				await this.handleCommandMessage(chatId, "/start");
				return;
			case "help":
				await this.sendHelp(chatId);
				return;
			case "prompt":
				await this.bot.sendMessage(chatId, "Send any text to start a task.");
				return;
			case "commands":
				await this.sendCommandMenu(chatId, 0, { view: "main", refreshCatalog: false });
				return;
			case "new": {
				await this.runNewSession(chatId);
				return;
			}
			case "permissions":
				await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true, view: "details" });
				return;
			case "toggle_mode":
				await this.togglePermissionMode(chatId);
				return;
			case "model":
				await this.sendModelMenu(chatId, 0, { refreshCatalog: true });
				return;
			case "status":
			case "refresh":
				await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
				return;
			case "details":
				await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true, view: "details" });
				return;
			case "compact":
				await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true, view: "compact" });
				return;
			case "abort":
				await this.abortActiveTurn(chatId);
				return;
			case "stop":
				await this.stopBridge(chatId);
				return;
			default:
				await this.bot.sendMessage(chatId, "Action is not implemented yet in Telegram bridge.");
		}
	}

	private async runNewSession(chatId: TelegramChatId): Promise<void> {
		const handled = await this.runBuiltinCommand(chatId, "/new");
		if (!handled) {
			await this.enqueuePrompt(chatId, "/new");
		}
	}

	private async switchMenuMessageToHub(chatId: TelegramChatId, messageId?: number): Promise<void> {
		if (messageId) {
			this.hubMessageIdByChat.set(chatId, messageId);
		}
		await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
	}

	private async clearInlineKeyboard(chatId: TelegramChatId, messageId: number): Promise<void> {
		try {
			await this.bot.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
		} catch {
			// Best-effort cleanup of stale buttons.
		}
	}

	private buildConfirmationResolvedText(confirmed: boolean, label?: string): string {
		const status = confirmed ? "✅ Allowed" : "❌ Denied";
		if (!label) return status;
		const lines = label
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		const detail = lines.find((line) => !/^permission required$/i.test(line)) ?? lines[0];
		if (!detail) return status;
		const clipped = detail.length > 120 ? `${detail.slice(0, 119)}…` : detail;
		return `${status}\n${clipped}`;
	}

	private async updateConfirmationDecisionMessage(
		chatId: TelegramChatId,
		messageId: number,
		confirmed: boolean,
		label?: string,
	): Promise<void> {
		const text = this.buildConfirmationResolvedText(confirmed, label);
		try {
			await this.bot.editMessageText(chatId, messageId, text, {
				replyMarkup: { inline_keyboard: [] },
			});
		} catch {
			await this.clearInlineKeyboard(chatId, messageId);
		}
	}

	private async moveLiveStatusToBottom(chatId: TelegramChatId): Promise<void> {
		const turn = this.activeTurn;
		if (!turn || turn.chatId !== chatId) return;
		const previousStatusId = turn.statusMessageId;
		try {
			const fresh = await this.bot.sendMessage(chatId, this.formatLiveStatus());
			turn.statusMessageId = fresh.message_id;
			turn.lastStatusEditAt = Date.now();
			if (previousStatusId !== fresh.message_id) {
				await this.bot.deleteMessage(chatId, previousStatusId).catch(() => {});
			}
		} catch {
			// Best-effort relocation; keep existing status message on failure.
		}
	}

	private async handleLiveAction(callback: TelegramCallbackQuery, data: string): Promise<void> {
		const chatId = callback.message?.chat.id;
		if (!chatId) {
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}
		const [, action] = data.split(":");
		if (!action) {
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}
		if (this.bridgeStopped && action !== "hub") {
			await this.bot.answerCallbackQuery(callback.id, "Bridge is stopped");
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			return;
		}

		if (action === "hub") {
			await this.bot.answerCallbackQuery(callback.id);
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			return;
		}
		if (action === "commands") {
			await this.bot.answerCallbackQuery(callback.id);
			await this.sendCommandMenu(chatId, 0, { view: "main", refreshCatalog: false });
			return;
		}
		if (action === "model") {
			await this.bot.answerCallbackQuery(callback.id);
			await this.sendModelMenu(chatId, 0, { refreshCatalog: true });
			return;
		}
		if (action === "new") {
			await this.bot.answerCallbackQuery(callback.id, "New session");
			await this.runNewSession(chatId);
			return;
		}
		if (action === "abort") {
			await this.bot.answerCallbackQuery(callback.id, "Aborting...");
			await this.abortActiveTurn(chatId);
			return;
		}
		if (action === "stop") {
			await this.bot.answerCallbackQuery(callback.id, "Stopping...");
			await this.stopBridge(chatId);
			return;
		}

		await this.bot.answerCallbackQuery(callback.id);
	}

	private async handleCommandMessage(chatId: TelegramChatId, text: string): Promise<void> {
		const [commandRaw, ...rest] = text.split(/\s+/);
		const command = (commandRaw.toLowerCase().split("@")[0] ?? commandRaw.toLowerCase()).trim();

		if (command === "/start") {
			this.bridgeStopped = false;
			await this.sendStart(chatId);
			return;
		}
		if (command === "/help") {
			await this.sendHelp(chatId);
			return;
		}
		if (command === "/menu") {
			await this.ensureInputMenu(chatId, true);
			return;
		}
		if (command === "/status") {
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			return;
		}
		if (command === "/stop") {
			await this.stopBridge(chatId);
			return;
		}
		if (this.bridgeStopped) {
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			await this.ensureInputMenu(chatId, true);
			return;
		}
		if (command === "/commands") {
			await this.sendCommandMenu(chatId, 0, { view: "main", refreshCatalog: false });
			return;
		}
		if (command === "/abort") {
			await this.abortActiveTurn(chatId);
			return;
		}
		if (command === "/yolo") {
			await this.handleYoloCommand(chatId, rest);
			return;
		}
		if (command === "/model" && rest.join(" ").trim().length === 0) {
			await this.sendModelMenu(chatId, 0, { refreshCatalog: true });
			return;
		}

		const handled = await this.runBuiltinCommand(chatId, text);
		if (handled) {
			return;
		}

		// Fallback to raw slash prompt to support extension/prompt-template/skill slash commands.
		await this.enqueuePrompt(chatId, text);
	}

	private async runBuiltinCommand(chatId: TelegramChatId, commandText: string): Promise<boolean> {
		try {
			await this.ensureRpcConnected();
			const result = await this.rpcClient.runBuiltinCommand(commandText);
			this.rpcConnected = true;
			if (!result.handled) {
				return false;
			}
			await this.sendBuiltinCommandResult(chatId, result);
			return true;
		} catch (error) {
			this.rpcConnected = false;
			await this.bot.sendMessage(chatId, `Command failed: ${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
	}

	private async sendBuiltinCommandResult(chatId: TelegramChatId, result: BuiltinCommandResult): Promise<void> {
		if (result.message) {
			const prefix = result.level === "error" ? "Error: " : result.level === "warning" ? "Warning: " : "";
			await this.bot.sendMessage(chatId, `${prefix}${result.message}`);
		}
		if (result.text) {
			await this.sendFinalOutput(chatId, result.text);
		}
		if (result.filePath) {
			await this.bot.sendMessage(chatId, `File: ${result.filePath}`);
		}
	}

	private async sendStart(chatId: TelegramChatId): Promise<void> {
		await this.sendStatusCard(chatId, {
			header: `Control Hub · ${APP_NAME} v${VERSION}`,
			includeKeyboard: true,
			preferEditHub: false,
		});
		await this.ensureInputMenu(chatId, true);
	}

	private async sendHelp(chatId: TelegramChatId): Promise<void> {
		const help = [
			"IOSM Telegram · Quick Guide",
			"",
			"What the agent can do",
			"- Analyze your codebase and explain behavior",
			"- Create/edit files and refactor code",
			"- Run shell commands, investigate failures, fix tests",
			"- Work with git changes and repository context",
			"- Prepare concise result summaries",
			"",
			"Tools the agent uses",
			"- Shell tools: bash/zsh commands for diagnostics and automation",
			"- Code tools: search (rg), read/edit files, refactor project code",
			"- Validation tools: run tests, linters, build checks",
			"- Git tools: inspect diffs/status, create safe code changes",
			"- In ASK mode, dangerous tool actions require Allow/Deny",
			"",
			"How to ask",
			"- Write a plain task: what to do + where + expected output",
			"- Example: \"Find why tests fail and fix them\"",
			"- Example: \"Find large files and propose safe cleanup\"",
			"",
			"Quick buttons",
			"- 🧭 Hub: current status/model/mode",
			"- ⚡ Cmd: command/action center",
			"- 🆕 New: start a new session",
			"- ⛔ Abort: stop current task",
			"- 🛑 Stop: stop bridge",
			"",
			"Models and permissions",
			"- /model: choose model",
			"- ASK mode: dangerous actions require Allow/Deny",
			"- /yolo on|off|status: confirmation mode control",
			"",
			"Useful commands",
			"/status  /commands  /model  /menu  /help",
			"",
			"Telegram bridge notes",
			"- Very large outputs are summarized in chat; full output is attached as a file when needed",
			"- For heavy audits/scans, ask the agent to write scripts/files and run them instead of one huge inline shell command",
			process.platform === "win32"
				? "- Windows tip: for complex shell quoting, ask for .ps1/.cmd script execution instead of inline escaped commands"
				: "- Keep scans focused (target paths/patterns) to avoid noisy output and network retries",
			"",
			"Tip: phrase tasks like \"do X, verify Y, report result\".",
		].join("\n");
		await this.bot.sendMessage(chatId, help);
	}

	private buildDefaultCommandText(name: string): string {
		const lower = name.toLowerCase();
		switch (lower) {
			case "permissions":
				return "/permissions status";
			case "yolo":
				return "/yolo status";
			case "checkpoint":
				return "/checkpoint list";
			case "rollback":
				return "/rollback list";
			case "tree":
				return "/tree list";
			default:
				return `/${name}`;
		}
	}

	private mapBuiltinCommands(commands: RpcBuiltinSlashCommand[]): CommandCatalogEntry[] {
		return commands.map((command) => ({
			name: command.name,
			description: command.description,
			source: "builtin" as const,
			commandText: this.buildDefaultCommandText(command.name),
		}));
	}

	private mapExternalCommands(commands: RpcSlashCommand[]): CommandCatalogEntry[] {
		return commands.map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			commandText: `/${command.name}`,
		}));
	}

	private getLocalBridgeCommands(): CommandCatalogEntry[] {
		return [
			{
				name: "commands",
				description: "Open paged command buttons",
				source: "builtin",
				commandText: "/commands",
			},
			{
				name: "model",
				description: "Open model picker",
				source: "builtin",
				commandText: "/model",
			},
			{
				name: "status",
				description: "Show runtime status",
				source: "builtin",
				commandText: "/status",
			},
			{
				name: "abort",
				description: "Abort active task",
				source: "builtin",
				commandText: "/abort",
			},
			{
				name: "stop",
				description: "Stop bridge and cancel active work",
				source: "builtin",
				commandText: "/stop",
			},
		];
	}

	private commandButtonLabel(entry: CommandCatalogEntry, view: CommandMenuView): string {
		if (view === "all") {
			const raw = entry.commandText.startsWith("/") ? entry.commandText : `/${entry.name}`;
			return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
		}
		const key = entry.commandText.toLowerCase();
		switch (key) {
			case "/model":
				return "🤖 Model";
			case "/status":
				return "🔄 Status";
			case "/new":
				return "🆕 New";
			case "/abort":
				return "⛔ Abort";
			case "/permissions status":
				return "🛡 Mode";
			case "/yolo status":
				return "⚠️ YOLO";
			case "/help":
				return "❓ Help";
			case "/stop":
				return "🛑 Stop";
			default:
				return entry.commandText;
		}
	}

	private async getCommandCatalog(chatId: TelegramChatId, refreshCatalog: boolean): Promise<CommandCatalogEntry[]> {
		const cached = this.commandCatalogByChat.get(chatId);
		const now = Date.now();
		if (!refreshCatalog && cached && now - cached.updatedAt < COMMAND_MENU_TTL_MS) {
			return cached.entries;
		}

		await this.ensureRpcConnected();
		const [builtin, dynamic] = await Promise.all([
			this.rpcClient.getBuiltinCommands(),
			this.rpcClient.getCommands(),
		]);
		this.rpcConnected = true;

		const entries: CommandCatalogEntry[] = [];
		const seen = new Set<string>();
		for (const entry of this.getLocalBridgeCommands()) {
			const key = entry.commandText;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push(entry);
		}
		for (const entry of this.mapBuiltinCommands(builtin)) {
			const key = entry.commandText;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push(entry);
		}

		const dynamicEntries = this.mapExternalCommands(dynamic).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of dynamicEntries) {
			const key = entry.commandText;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push(entry);
		}

		this.commandCatalogByChat.set(chatId, { updatedAt: now, entries });
		return entries;
	}

	private buildCommandMenuKeyboard(
		entries: CommandCatalogEntry[],
		page: number,
		view: CommandMenuView,
	): TelegramInlineKeyboardMarkup {
		const pageCount = Math.max(1, Math.ceil(entries.length / COMMANDS_PAGE_SIZE));
		const normalizedPage = Math.max(0, Math.min(page, pageCount - 1));
		const start = normalizedPage * COMMANDS_PAGE_SIZE;
		const pageEntries = entries.slice(start, start + COMMANDS_PAGE_SIZE);

		const commandRows: Array<Array<{ text: string; callback_data: string }>> = [];
		for (let index = 0; index < pageEntries.length; index += 2) {
			const left = pageEntries[index];
			const right = pageEntries[index + 1];
			const row: Array<{ text: string; callback_data: string }> = [];
			if (left) {
				row.push({
					text: this.commandButtonLabel(left, view),
					callback_data: `cmd:run:${view}:${start + index}`,
				});
			}
			if (right) {
				row.push({
					text: this.commandButtonLabel(right, view),
					callback_data: `cmd:run:${view}:${start + index + 1}`,
				});
			}
			if (row.length > 0) {
				commandRows.push(row);
			}
		}

		const navRow: Array<{ text: string; callback_data: string }> = [];
		navRow.push({
			text: normalizedPage > 0 ? "◀ Prev" : "·",
			callback_data: normalizedPage > 0 ? `cmd:page:${view}:${normalizedPage - 1}` : "cmd:noop",
		});
		navRow.push({
			text: `${normalizedPage + 1}/${pageCount}`,
			callback_data: "cmd:noop",
		});
		navRow.push({
			text: normalizedPage < pageCount - 1 ? "Next ▶" : "·",
			callback_data: normalizedPage < pageCount - 1 ? `cmd:page:${view}:${normalizedPage + 1}` : "cmd:noop",
		});

		return {
			inline_keyboard: [
				...commandRows,
				navRow,
				[
					{
						text: view === "main" ? "All Commands" : "Main Commands",
						callback_data: `cmd:view:${view === "main" ? "all" : "main"}:0`,
					},
					{
						text: "Refresh",
						callback_data: view === "all" ? `cmd:refresh:${view}:${normalizedPage}` : `cmd:view:${view}:0`,
					},
				],
				[
					{ text: "Hub", callback_data: "cmd:hub" },
					{ text: "Close", callback_data: "cmd:close" },
				],
			],
		};
	}

	private async sendCommandMenu(
		chatId: TelegramChatId,
		page: number,
		options?: { messageId?: number; refreshCatalog?: boolean; view?: CommandMenuView },
	): Promise<void> {
		let entries: CommandCatalogEntry[] = [];
		const view = options?.view ?? "main";
		try {
			entries = view === "main" ? MAIN_COMMAND_MENU : await this.getCommandCatalog(chatId, options?.refreshCatalog === true);
		} catch (error) {
			this.rpcConnected = false;
			await this.bot.sendMessage(chatId, `Failed to load commands: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		const pageCount = Math.max(1, Math.ceil(entries.length / COMMANDS_PAGE_SIZE));
		const normalizedPage = Math.max(0, Math.min(page, pageCount - 1));
		const header = [
			`Command Center · ${APP_NAME}`,
			`${view === "main" ? "Main Actions" : "All Commands"} · ${normalizedPage + 1}/${pageCount}`,
			`${entries.length} items`,
		].join("\n");
		const keyboard = this.buildCommandMenuKeyboard(entries, normalizedPage, view);

		if (options?.messageId) {
			try {
				await this.bot.editMessageText(chatId, options.messageId, header, { replyMarkup: keyboard });
				return;
			} catch {
				// Fallback below: send a new message if editing failed.
			}
		}
		await this.bot.sendMessage(chatId, header, { replyMarkup: keyboard });
	}

	private async handleCommandMenuCallback(callback: TelegramCallbackQuery, data: string): Promise<void> {
		const chatId = callback.message?.chat.id;
		const messageId = callback.message?.message_id;
		if (!chatId) {
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}

		const parts = data.split(":");
		const action = parts[1] ?? "";
		const rawView = parts[2];
		let view: CommandMenuView = rawView === "all" ? "all" : "main";
		let value = parts[3];
		// Backward compatibility with older callback payloads: cmd:<action>:<value>.
		if ((action === "page" || action === "refresh" || action === "run") && parts.length === 3) {
			view = "main";
			value = parts[2];
		}
		if (action === "noop") {
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}
		if (action === "close") {
			await this.bot.answerCallbackQuery(callback.id, "Hub");
			await this.switchMenuMessageToHub(chatId, messageId);
			return;
		}
		if (action === "hub") {
			await this.bot.answerCallbackQuery(callback.id, "Hub");
			await this.switchMenuMessageToHub(chatId, messageId);
			return;
		}
		if (this.bridgeStopped) {
			await this.bot.answerCallbackQuery(callback.id, "Bridge is stopped");
			await this.switchMenuMessageToHub(chatId, messageId);
			return;
		}
		if (action === "view") {
			const page = Number.parseInt(value ?? "0", 10);
			await this.bot.answerCallbackQuery(callback.id);
			await this.sendCommandMenu(chatId, Number.isFinite(page) ? page : 0, {
				messageId,
				view,
				refreshCatalog: view === "all",
			});
			return;
		}
		if (action === "page" || action === "refresh") {
			const page = Number.parseInt(value ?? "0", 10);
			await this.bot.answerCallbackQuery(callback.id);
			await this.sendCommandMenu(chatId, Number.isFinite(page) ? page : 0, {
				messageId,
				view,
				refreshCatalog: action === "refresh",
			});
			return;
		}
		if (action === "run") {
			const index = Number.parseInt(value ?? "-1", 10);
			let entries: CommandCatalogEntry[] = [];
			if (view === "main") {
				entries = MAIN_COMMAND_MENU;
			} else {
				try {
					entries = await this.getCommandCatalog(chatId, false);
				} catch (error) {
					this.rpcConnected = false;
					await this.bot.answerCallbackQuery(callback.id, "Failed to load command catalog");
					await this.bot.sendMessage(
						chatId,
						`Failed to load commands: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}
			}
			const entry = Number.isFinite(index) ? entries[index] : undefined;
			if (!entry) {
				await this.bot.answerCallbackQuery(callback.id, "Command list expired. Refresh.");
				return;
			}
			if (entry.commandText === "/model") {
				await this.bot.answerCallbackQuery(callback.id, "Open model picker");
				await this.sendModelMenu(chatId, 0, { refreshCatalog: true });
				return;
			}
			if (entry.commandText === "/status") {
				await this.bot.answerCallbackQuery(callback.id);
				await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
				return;
			}
			if (entry.commandText === "/help") {
				await this.bot.answerCallbackQuery(callback.id);
				await this.sendHelp(chatId);
				return;
			}
			if (entry.commandText === "/abort") {
				await this.bot.answerCallbackQuery(callback.id, "Abort signal sent");
				await this.abortActiveTurn(chatId);
				return;
			}
			if (entry.commandText.startsWith("/yolo")) {
				await this.bot.answerCallbackQuery(callback.id);
				const parts = entry.commandText.split(/\s+/).slice(1);
				await this.handleYoloCommand(chatId, parts);
				return;
			}
			if (entry.commandText === "/stop") {
				await this.bot.answerCallbackQuery(callback.id, "Stopping bridge");
				await this.stopBridge(chatId);
				return;
			}
			if (entry.commandText === "/commands") {
				await this.bot.answerCallbackQuery(callback.id);
				await this.sendCommandMenu(chatId, 0, { view: "main", refreshCatalog: false });
				return;
			}
			await this.bot.answerCallbackQuery(callback.id, `Run ${entry.commandText}`);
			const handled = await this.runBuiltinCommand(chatId, entry.commandText);
			if (!handled) {
				await this.enqueuePrompt(chatId, entry.commandText);
			}
			return;
		}

		await this.bot.answerCallbackQuery(callback.id);
	}

	private modelKey(model: { provider: string; id: string } | undefined): string | undefined {
		if (!model) return undefined;
		return `${model.provider}/${model.id}`;
	}

	private async getModelCatalog(chatId: TelegramChatId, refreshCatalog: boolean): Promise<ModelCatalogEntry[]> {
		const cached = this.modelCatalogByChat.get(chatId);
		const now = Date.now();
		if (!refreshCatalog && cached && now - cached.updatedAt < MODEL_MENU_TTL_MS) {
			return cached.entries;
		}

		await this.ensureRpcConnected();
		const entries = (await this.rpcClient.getAvailableModels())
			.map((model) => ({
				provider: model.provider,
				id: model.id,
				contextWindow: model.contextWindow,
				reasoning: model.reasoning,
			}))
			.sort((a, b) => this.modelKey(a)!.localeCompare(this.modelKey(b)!));
		this.rpcConnected = true;
		this.modelCatalogByChat.set(chatId, { updatedAt: now, entries });
		return entries;
	}

	private buildModelMenuKeyboard(
		entries: ModelCatalogEntry[],
		page: number,
		currentModelKey: string | undefined,
	): TelegramInlineKeyboardMarkup {
		const pageCount = Math.max(1, Math.ceil(entries.length / MODELS_PAGE_SIZE));
		const normalizedPage = Math.max(0, Math.min(page, pageCount - 1));
		const start = normalizedPage * MODELS_PAGE_SIZE;
		const pageEntries = entries.slice(start, start + MODELS_PAGE_SIZE);

		const modelRows = pageEntries.map((entry, index) => {
			const key = this.modelKey(entry);
			const selectedPrefix = key === currentModelKey ? "✅ " : "";
			return [
				{
					text: `${selectedPrefix}${entry.provider}/${entry.id}`,
					callback_data: `model:set:${start + index}`,
				},
			];
		});

		const navRow: Array<{ text: string; callback_data: string }> = [];
		navRow.push({
			text: normalizedPage > 0 ? "◀ Prev" : "·",
			callback_data: normalizedPage > 0 ? `model:page:${normalizedPage - 1}` : "model:noop",
		});
		navRow.push({
			text: `${normalizedPage + 1}/${pageCount}`,
			callback_data: "model:noop",
		});
		navRow.push({
			text: normalizedPage < pageCount - 1 ? "Next ▶" : "·",
			callback_data: normalizedPage < pageCount - 1 ? `model:page:${normalizedPage + 1}` : "model:noop",
		});

		return {
			inline_keyboard: [
				...modelRows,
				navRow,
				[
					{ text: "Cycle", callback_data: "model:cycle" },
					{ text: "Refresh", callback_data: `model:refresh:${normalizedPage}` },
				],
				[
					{ text: "Hub", callback_data: "model:hub" },
					{ text: "Close", callback_data: "model:close" },
				],
			],
		};
	}

	private async sendModelMenu(
		chatId: TelegramChatId,
		page: number,
		options?: { messageId?: number; refreshCatalog?: boolean },
	): Promise<void> {
		if (this.bridgeStopped) {
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			return;
		}

		let entries: ModelCatalogEntry[] = [];
		try {
			entries = await this.getModelCatalog(chatId, options?.refreshCatalog === true);
			this.activeSessionState = await this.rpcClient.getState();
			this.rpcConnected = true;
		} catch (error) {
			this.rpcConnected = false;
			await this.bot.sendMessage(chatId, `Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		if (entries.length === 0) {
			await this.bot.sendMessage(chatId, "No models available. Configure models in settings and retry.");
			return;
		}

		const currentModelKey = this.modelKey(this.activeSessionState?.model);
		const pageCount = Math.max(1, Math.ceil(entries.length / MODELS_PAGE_SIZE));
		const normalizedPage = Math.max(0, Math.min(page, pageCount - 1));
		const header = [
			"Model Picker",
			`Current: ${currentModelKey ?? "not selected"}`,
			`Available: ${entries.length}`,
			`Page: ${normalizedPage + 1}/${pageCount}`,
		].join("\n");
		const keyboard = this.buildModelMenuKeyboard(entries, normalizedPage, currentModelKey);

		if (options?.messageId) {
			try {
				await this.bot.editMessageText(chatId, options.messageId, header, { replyMarkup: keyboard });
				return;
			} catch {
				// Fallback to sending a fresh message.
			}
		}
		await this.bot.sendMessage(chatId, header, { replyMarkup: keyboard });
	}

	private async handleModelMenuCallback(callback: TelegramCallbackQuery, data: string): Promise<void> {
		const chatId = callback.message?.chat.id;
		const messageId = callback.message?.message_id;
		if (!chatId) {
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}

		const [, action, value] = data.split(":");
		if (action === "noop") {
			await this.bot.answerCallbackQuery(callback.id);
			return;
		}
		if (action === "close") {
			await this.bot.answerCallbackQuery(callback.id, "Hub");
			await this.switchMenuMessageToHub(chatId, messageId);
			return;
		}
		if (action === "hub") {
			await this.bot.answerCallbackQuery(callback.id, "Hub");
			await this.switchMenuMessageToHub(chatId, messageId);
			return;
		}

		if (this.bridgeStopped) {
			await this.bot.answerCallbackQuery(callback.id, "Bridge is stopped");
			await this.switchMenuMessageToHub(chatId, messageId);
			return;
		}

		if (action === "page" || action === "refresh") {
			const page = Number.parseInt(value ?? "0", 10);
			await this.bot.answerCallbackQuery(callback.id);
			await this.sendModelMenu(chatId, Number.isFinite(page) ? page : 0, {
				messageId,
				refreshCatalog: action === "refresh",
			});
			return;
		}

		if (action === "cycle") {
			try {
				await this.ensureRpcConnected();
				const cycled = await this.rpcClient.cycleModel();
				this.activeSessionState = await this.rpcClient.getState();
				this.rpcConnected = true;
				await this.bot.answerCallbackQuery(
					callback.id,
					cycled ? `Model: ${cycled.model.provider}/${cycled.model.id}` : "No model candidates",
				);
				await this.sendModelMenu(chatId, 0, { messageId, refreshCatalog: false });
			} catch (error) {
				this.rpcConnected = false;
				await this.bot.answerCallbackQuery(callback.id, "Failed to cycle model");
				await this.bot.sendMessage(chatId, `Failed to cycle model: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		if (action === "set") {
			const index = Number.parseInt(value ?? "-1", 10);
			let entries: ModelCatalogEntry[] = [];
			try {
				entries = await this.getModelCatalog(chatId, false);
			} catch (error) {
				this.rpcConnected = false;
				await this.bot.answerCallbackQuery(callback.id, "Model list expired. Refresh.");
				await this.bot.sendMessage(chatId, `Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}

			const entry = Number.isFinite(index) ? entries[index] : undefined;
			if (!entry) {
				await this.bot.answerCallbackQuery(callback.id, "Model list expired. Refresh.");
				return;
			}

			try {
				await this.ensureRpcConnected();
				await this.rpcClient.setModel(entry.provider, entry.id);
				this.activeSessionState = await this.rpcClient.getState();
				this.rpcConnected = true;
				await this.bot.answerCallbackQuery(callback.id, `Selected ${entry.provider}/${entry.id}`);
				await this.sendModelMenu(chatId, Math.floor(index / MODELS_PAGE_SIZE), { messageId, refreshCatalog: false });
				await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			} catch (error) {
				this.rpcConnected = false;
				await this.bot.answerCallbackQuery(callback.id, "Failed to set model");
				await this.bot.sendMessage(chatId, `Failed to set model: ${error instanceof Error ? error.message : String(error)}`);
			}
			return;
		}

		await this.bot.answerCallbackQuery(callback.id);
	}

	private async stopBridge(chatId: TelegramChatId): Promise<void> {
		if (this.bridgeStopped && !this.activeTurn && this.promptQueue.size === 0 && !this.rpcConnected) {
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
			await this.ensureInputMenu(chatId, true);
			return;
		}

		const droppedQueue = this.promptQueue.clear();
		this.bridgeStopped = true;
		this.commandCatalogByChat.clear();
		this.modelCatalogByChat.clear();

		this.clearPendingConfirmations(true);

		const active = this.activeTurn;
		if (active?.statusEditTimer) {
			clearTimeout(active.statusEditTimer);
		}
		this.activeTurn = undefined;
		if (active) {
			if (active.statusEditInFlight) {
				try {
					await active.statusEditInFlight;
				} catch {
					// Best-effort; proceed with stop status.
				}
			}
			try {
				await this.bot.editMessageText(active.chatId, active.statusMessageId, "⛔ done (stopped)");
			} catch {
				// Best-effort status close.
			}
			if (active.chatId !== chatId) {
				await this.bot.sendMessage(active.chatId, "Bridge stopped. Active task cancelled.");
			}
		}

		try {
			await this.rpcClient.stop();
		} catch (error) {
			console.warn(`[telegram] rpc stop failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.rpcConnected = false;
		}

		const parts = ["Bridge stopped."];
		if (active) {
			parts.push("Active task cancelled.");
		}
		if (droppedQueue > 0) {
			parts.push(`Dropped queued tasks: ${droppedQueue}.`);
		}
		parts.push("Use /start to resume.");
		await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
		await this.ensureInputMenu(chatId, true);
		await this.bot.sendMessage(chatId, parts.join(" "));
	}

	private formatConnectionStatus(): string {
		if (this.bridgeStopped) return "⛔ stopped";
		if (!this.rpcConnected) return "🟥 disconnected";
		if (this.activeTurn) return "🟩 connected";
		return "🟦 idle";
	}

	private formatPermissionShort(mode: "ask" | "auto" | "yolo" | undefined): string {
		if (mode === "yolo") return "YOLO";
		if (mode === "auto") return "AUTO";
		return "ASK";
	}

	private formatPermissionButton(mode: "ask" | "auto" | "yolo" | undefined): string {
		if (mode === "yolo") return "⚠️ YOLO";
		if (mode === "auto") return "🤖 AUTO";
		return "🛡 ASK";
	}

	private formatModelShort(model: string, maxLen = 42): string {
		if (model.length <= maxLen) return model;
		return `${model.slice(0, maxLen - 1)}…`;
	}

	private formatSessionShort(sessionName: string | undefined, sessionId: string | undefined): string {
		if (sessionName && sessionName.trim().length > 0) return this.formatModelShort(sessionName.trim(), 24);
		if (!sessionId || sessionId.trim().length === 0) return "unknown";
		const value = sessionId.trim();
		if (value.length <= 14) return value;
		return `${value.slice(0, 8)}…${value.slice(-4)}`;
	}

	private formatCompactTurn(): string {
		if (!this.activeTurn) return "idle";
		const elapsed = Math.max(0, Math.floor((Date.now() - this.activeTurn.startedAt) / 1000));
		const phase = this.formatStatusPhase(this.activeTurn.phase);
		return `${phase} ${elapsed}s`;
	}

	private buildHubKeyboard(mode: "ask" | "auto" | "yolo" | undefined, view: HubView): TelegramInlineKeyboardMarkup {
		if (this.bridgeStopped) {
			return {
				inline_keyboard: [
					[
						{ text: "▶️ Start", callback_data: "hub:start" },
						{ text: "🔄 Refresh", callback_data: "hub:refresh" },
					],
					[{ text: "❓ Help", callback_data: "hub:help" }],
				],
			};
		}
		const detailsToggle =
			view === "details"
				? { text: "◀ Compact", callback_data: "hub:compact" }
				: { text: "ℹ️ Details", callback_data: "hub:details" };
		return {
			inline_keyboard: [
				[
					{ text: "🆕 New", callback_data: "hub:new" },
					{ text: "⚡ Cmd", callback_data: "hub:commands" },
					{ text: "🤖 Model", callback_data: "hub:model" },
				],
				[
					{ text: this.formatPermissionButton(mode), callback_data: "hub:toggle_mode" },
					{ text: "🔄 Refresh", callback_data: "hub:refresh" },
					detailsToggle,
				],
				[
					{ text: "⛔ Abort", callback_data: "hub:abort" },
					{ text: "🛑 Stop", callback_data: "hub:stop" },
				],
			],
		};
	}

	private async sendStatusCard(
		chatId: TelegramChatId,
		options?: { header?: string; includeKeyboard?: boolean; preferEditHub?: boolean; view?: HubView },
	): Promise<void> {
		if (!this.bridgeStopped) {
			try {
				await this.ensureRpcConnected();
				this.activeSessionState = await this.rpcClient.getState();
				this.rpcConnected = true;
			} catch (error) {
				this.rpcConnected = false;
				await this.bot.sendMessage(
					chatId,
					`Status unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
		}

		const state = this.activeSessionState;
		const model = state?.model ? `${state.model.provider}/${state.model.id}` : "not selected";
		const queueSize = this.promptQueue.size;
		const mcpState = "RPC child";
		const permissionMode = state?.permissionMode ?? "ask";
		const resolvedView = options?.view ?? this.hubViewByChat.get(chatId) ?? "compact";
		this.hubViewByChat.set(chatId, resolvedView);

		const header = options?.header ?? "Control Hub";
		const compactText = [
			header,
			`${this.formatConnectionStatus()} · ${this.formatPermissionShort(permissionMode)} · q${queueSize} · ${this.formatCompactTurn()}`,
			`🤖 ${this.formatModelShort(model)}`,
			`💬 ${this.formatSessionShort(state?.sessionName, state?.sessionId)}`,
		].join("\n");
		const detailsText = [
			`${header} · Details`,
			`Connection: ${this.formatConnectionStatus()}`,
			`Mode: ${permissionMode}`,
			`Model: ${model}`,
			`Session: ${state?.sessionName ?? state?.sessionId ?? "unknown"}`,
			`Turn: ${this.activeTurn ? `${this.activeTurn.phase} (${Math.floor((Date.now() - this.activeTurn.startedAt) / 1000)}s)` : "idle"}`,
			`Queue: ${queueSize}`,
			`MCP: ${mcpState}`,
			"Telegram: active",
		].join("\n");
		const text = resolvedView === "details" ? detailsText : compactText;
		const keyboard = options?.includeKeyboard ? this.buildHubKeyboard(permissionMode, resolvedView) : undefined;

		if (options?.includeKeyboard && options.preferEditHub) {
			const hubMessageId = this.hubMessageIdByChat.get(chatId);
			if (hubMessageId) {
				try {
					await this.bot.editMessageText(chatId, hubMessageId, text, { replyMarkup: keyboard });
					return;
				} catch {
					// Fallback below: send a fresh hub card if original message is gone.
				}
			}
		}

		const message = await this.bot.sendMessage(chatId, text, { replyMarkup: keyboard });
		if (options?.includeKeyboard) {
			this.hubMessageIdByChat.set(chatId, message.message_id);
		}
	}

	private async togglePermissionMode(chatId: TelegramChatId): Promise<void> {
		try {
			await this.ensureRpcConnected();
			const current = await this.rpcClient.getPermissionMode();
			const next = current === "yolo" ? "ask" : "yolo";
			await this.rpcClient.setPermissionMode(next);
			this.activeSessionState = await this.rpcClient.getState();
			this.rpcConnected = true;
			await this.sendStatusCard(chatId, { includeKeyboard: true, preferEditHub: true });
		} catch (error) {
			this.rpcConnected = false;
			await this.bot.sendMessage(chatId, `Failed to switch mode: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleYoloCommand(chatId: TelegramChatId, args: string[]): Promise<void> {
		const desired = args[0]?.toLowerCase();
		try {
			await this.ensureRpcConnected();
			if (!desired || desired === "status") {
				const mode = await this.rpcClient.getPermissionMode();
				await this.bot.sendMessage(chatId, `YOLO mode: ${mode === "yolo" ? "ON" : "OFF"} (${mode})`);
				return;
			}
			if (desired === "on") {
				await this.rpcClient.setPermissionMode("yolo");
				await this.bot.sendMessage(chatId, "YOLO mode: ON (tool confirmations disabled).");
				return;
			}
			if (desired === "off") {
				await this.rpcClient.setPermissionMode("ask");
				await this.bot.sendMessage(chatId, "YOLO mode: OFF (tool confirmations enabled).");
				return;
			}
			await this.bot.sendMessage(chatId, "Usage: /yolo [on|off|status]");
		} catch (error) {
			this.rpcConnected = false;
			await this.bot.sendMessage(chatId, `Failed to update mode: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async abortActiveTurn(chatId: TelegramChatId): Promise<void> {
		if (!this.activeTurn) {
			await this.bot.sendMessage(chatId, "No active task.");
			return;
		}
		this.tracePolling(`abort requested chat=${chatId} turn=${this.activeTurn.turnId}`);
		try {
			await this.ensureRpcConnected();
			this.activeTurn.aborted = true;
			await this.rpcClient.abort();
			await this.bot.sendMessage(chatId, "Abort signal sent.");
		} catch (error) {
			this.rpcConnected = false;
			await this.bot.sendMessage(chatId, `Abort failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async enqueuePrompt(chatId: TelegramChatId, text: string): Promise<void> {
		if (!this.activeTurn) {
			this.tracePolling(`start immediately chat=${chatId} queue=0`);
			await this.startTurn(chatId, text);
			return;
		}
		const queued = this.promptQueue.enqueue(chatId, text);
		this.tracePolling(`queued chat=${chatId} chat_queue=${queued.chatSize} total_queue=${queued.totalSize}`);
		await this.bot.sendMessage(chatId, `⏸ queued · ${queued.totalSize}`);
		void this.editLiveStatus();
	}

	private async startTurn(chatId: TelegramChatId, text: string): Promise<void> {
		// Avoid carrying stale confirmation group state into a fresh turn.
		this.clearPendingConfirmations(true);
		const statusMessage = await this.bot.sendMessage(chatId, this.formatStartingStatus(text));
		this.activeTurn = {
			turnId: this.nextTurnId++,
			chatId,
			prompt: text,
			startedAt: Date.now(),
			statusMessageId: statusMessage.message_id,
			phase: "starting",
			aborted: false,
			statusEditPending: false,
			lastStatusEditAt: 0,
		};
		this.tracePolling(`turn start turn=${this.activeTurn.turnId} chat=${chatId} queue=${this.promptQueue.size}`);
		try {
			await this.ensureRpcConnected();
			await this.rpcClient.prompt(text);
			this.rpcConnected = true;
			await this.editLiveStatus(true);
		} catch (error) {
			this.rpcConnected = false;
			await this.finishTurn({
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onRpcEvent(event: AgentEvent): Promise<void> {
		if (!this.activeTurn) return;
		if (this.pollingTraceEnabled) {
			const maybeTool = (event as { toolName?: string }).toolName;
			this.tracePolling(`rpc event turn=${this.activeTurn.turnId} type=${event.type}${maybeTool ? ` tool=${maybeTool}` : ""}`);
		}
		const rpcResponseEvent = event as unknown as { type?: string; success?: boolean; error?: string; command?: string; id?: string };
		if (rpcResponseEvent.type === "response" && rpcResponseEvent.success === false) {
			const reason = rpcResponseEvent.error?.trim() || "RPC prompt failed";
			this.tracePolling(
				`rpc response error turn=${this.activeTurn.turnId} command=${rpcResponseEvent.command ?? "unknown"} id=${
					rpcResponseEvent.id ?? "unknown"
				} reason=${this.clipForLog(reason, 120)}`,
			);
			await this.finishTurn({ error: reason });
			return;
		}

		switch (event.type) {
			case "turn_start":
				this.activeTurn.phase = "running";
				break;
			case "tool_execution_start": {
				const toolEvent = event as { toolName?: string };
				this.activeTurn.phase = "tool";
				this.activeTurn.lastTool = toolEvent.toolName;
				break;
			}
			case "tool_execution_update": {
				const toolEvent = event as { toolName?: string };
				this.activeTurn.phase = "tool";
				this.activeTurn.lastTool = toolEvent.toolName ?? this.activeTurn.lastTool;
				break;
			}
			case "message_end": {
				const directText = this.extractAssistantTextFromTurnEnd(event as AgentEvent);
				if (directText) {
					this.activeTurn.lastAssistantTurnText = directText;
				}
				break;
			}
			case "turn_end": {
				const turnEnd = event as AgentEvent;
				const directText = this.extractAssistantTextFromTurnEnd(turnEnd);
					if (directText) {
						// Keep as fallback in case getLastAssistantText is empty.
						this.activeTurn.lastAssistantTurnText = directText;
						this.activeTurn.phase = "finalizing";
					}
					break;
				}
			case "agent_end":
				await this.finishTurn();
				return;
			default:
				break;
		}

		await this.editLiveStatus();
	}

	private async onRpcExtensionUiRequest(request: RpcExtensionUIRequest): Promise<void> {
		if (request.method === "confirm_permission" || request.method === "confirm") {
			const chatId = this.activeTurn?.chatId ?? this.lastAuthorizedChatId;
			if (!chatId) {
				this.rpcClient.respondExtensionUi({ type: "extension_ui_response", id: request.id, confirmed: false });
				return;
			}
			const label = `${request.title}\n${request.message}`;
			const groupKey =
				request.method === "confirm_permission"
					? this.buildPermissionGroupKey(chatId, request.request)
					: this.buildGenericConfirmationGroupKey(chatId, label);
			await this.queueConfirmationPrompt(chatId, request.id, label, groupKey);
			return;
		}

		if (request.method === "notify") {
			const chatId = this.activeTurn?.chatId ?? this.lastAuthorizedChatId;
			if (chatId) {
				await this.bot.sendMessage(chatId, request.message);
			}
			return;
		}

		// Unsupported interactive extension methods in telegram v1: cancel by default.
		this.rpcClient.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
	}

	private async onRpcConfirmationRequest(event: RpcRequiresConfirmationEvent): Promise<void> {
		const chatId = this.activeTurn?.chatId ?? this.lastAuthorizedChatId;
		if (!chatId) {
			this.rpcClient.respondExtensionUi({ type: "extension_ui_response", id: event.id, confirmed: false });
			return;
		}
		const groupKey = this.buildPermissionGroupKey(chatId, event.request);
		await this.queueConfirmationPrompt(chatId, event.id, event.message, groupKey);
	}

	private buildPermissionGroupKey(chatId: TelegramChatId, request: RpcRequiresConfirmationEvent["request"]): string {
		const requiredPermission = request.requiredPermission ?? "unknown";
		const toolSource = request.toolSource ?? "unknown";
		const inputJson = JSON.stringify(request.input ?? {});
		return `${chatId}|perm|${request.toolName}|${requiredPermission}|${toolSource}|${request.summary}|${request.cwd}|${inputJson}`;
	}

	private buildGenericConfirmationGroupKey(chatId: TelegramChatId, label: string): string {
		const normalized = label.replace(/\s+/g, " ").trim();
		return `${chatId}|confirm|${normalized}`;
	}

	private denyConfirmation(requestId: string): void {
		try {
			this.rpcClient.respondExtensionUi({ type: "extension_ui_response", id: requestId, confirmed: false });
		} catch {
			// Best-effort when RPC is disconnected or request no longer exists.
		}
	}

	private clearPendingConfirmations(respondDeny = false): void {
		if (respondDeny) {
			for (const requestId of this.pendingConfirmations.keys()) {
				this.denyConfirmation(requestId);
			}
		}
		this.pendingConfirmations.clear();
		this.pendingConfirmationGroupIdsByKey.clear();
	}

	private async queueConfirmationPrompt(
		chatId: TelegramChatId,
		requestId: string,
		label: string,
		groupKey: string,
	): Promise<void> {
		if (this.pendingConfirmations.has(requestId)) {
			return;
		}

		const existing = this.pendingConfirmationGroupIdsByKey.get(groupKey);
		if (existing) {
			existing.add(requestId);
			this.pendingConfirmations.set(requestId, { chatId, requestId, label, groupKey });
			if (this.activeTurn) {
				this.activeTurn.phase = "awaiting confirmation";
				await this.editLiveStatus(true);
			}
			return;
		}

		const ids = new Set<string>([requestId]);
		this.pendingConfirmationGroupIdsByKey.set(groupKey, ids);
		this.pendingConfirmations.set(requestId, { chatId, requestId, label, groupKey });
		try {
			await this.bot.sendMessage(chatId, label, {
				replyMarkup: {
					inline_keyboard: [
						[
							{ text: "Allow", callback_data: `confirm:${requestId}:yes` },
							{ text: "Deny", callback_data: `confirm:${requestId}:no` },
						],
					],
				},
			});
		} catch (error) {
			// Prompt could not be delivered; deny immediately to avoid deadlocking the turn.
			this.pendingConfirmations.delete(requestId);
			this.pendingConfirmationGroupIdsByKey.delete(groupKey);
			this.denyConfirmation(requestId);
			console.warn(
				`[telegram] confirmation prompt delivery failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (this.activeTurn) {
				this.activeTurn.phase = "permission denied";
				await this.editLiveStatus(true);
			}
			return;
		}
		if (this.activeTurn) {
			this.activeTurn.phase = "awaiting confirmation";
			await this.editLiveStatus(true);
		}
	}

	private async respondConfirmation(requestId: string, confirmed: boolean): Promise<void> {
		const pending = this.pendingConfirmations.get(requestId);
		if (!pending) return;

		const groupedIds = this.pendingConfirmationGroupIdsByKey.get(pending.groupKey);
		const ids = groupedIds && groupedIds.size > 0 ? Array.from(groupedIds) : [requestId];
		for (const id of ids) {
			this.pendingConfirmations.delete(id);
			try {
				this.rpcClient.respondExtensionUi({ type: "extension_ui_response", id, confirmed });
			} catch {
				// Best-effort for duplicated request IDs from different streams.
			}
		}
		this.pendingConfirmationGroupIdsByKey.delete(pending.groupKey);

		if (this.activeTurn) {
			this.activeTurn.phase = confirmed ? "running" : "permission denied";
			await this.editLiveStatus(true);
		}
	}

	private extractAssistantTextFromTurnEnd(event: AgentEvent): string | undefined {
		const messageEvent = event as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
		const message = messageEvent.message;
		if (!message || message.role !== "assistant") return undefined;
		const content = Array.isArray(message.content) ? message.content : [];
		const textParts = content
			.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text.trim())
			.filter((part) => part.length > 0);
		if (textParts.length === 0) return undefined;
		return textParts.join("\n\n");
	}

	private escapeTelegramHtml(text: string): string {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	private escapeTelegramHtmlAttribute(text: string): string {
		return this.escapeTelegramHtml(text).replace(/"/g, "&quot;");
	}

	private stripHtmlTags(text: string): string {
		return text.replace(/<[^>]*>/g, "");
	}

	private normalizeTelegramText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	}

	private renderMarkdownInlineTokens(tokens: Token[] | undefined): string {
		if (!tokens || tokens.length === 0) return "";
		let output = "";
		for (const token of tokens) {
			switch (token.type) {
				case "strong":
					output += `<b>${this.renderMarkdownInlineTokens(token.tokens)}</b>`;
					break;
				case "em":
					output += `<i>${this.renderMarkdownInlineTokens(token.tokens)}</i>`;
					break;
				case "del":
					output += `<s>${this.renderMarkdownInlineTokens(token.tokens)}</s>`;
					break;
				case "codespan":
					output += `<code>${this.escapeTelegramHtml(token.text)}</code>`;
					break;
				case "br":
					output += "\n";
					break;
				case "link": {
					const labelRaw = this.renderMarkdownInlineTokens(token.tokens);
					const label = labelRaw.length > 0 ? labelRaw : this.escapeTelegramHtml(token.text ?? token.href);
					const href = token.href?.trim();
					if (href && /^(https?:\/\/|mailto:|tg:\/\/)/i.test(href)) {
						output += `<a href="${this.escapeTelegramHtmlAttribute(href)}">${label}</a>`;
					} else if (href) {
						output += `${label} (${this.escapeTelegramHtml(href)})`;
					} else {
						output += label;
					}
					break;
				}
				case "image": {
					const captionRaw = token.text?.trim();
					const caption = captionRaw && captionRaw.length > 0 ? captionRaw : "image";
					const href = token.href?.trim();
					if (href && /^https?:\/\//i.test(href)) {
						output += `🖼 <a href="${this.escapeTelegramHtmlAttribute(href)}">${this.escapeTelegramHtml(caption)}</a>`;
					} else {
						output += `🖼 ${this.escapeTelegramHtml(caption)}`;
					}
					break;
				}
				case "text":
					if (Array.isArray(token.tokens) && token.tokens.length > 0) {
						output += this.renderMarkdownInlineTokens(token.tokens);
					} else {
						output += this.escapeTelegramHtml(token.text);
					}
					break;
				case "escape":
					output += this.escapeTelegramHtml(token.text);
					break;
				case "html": {
					const htmlText = this.stripHtmlTags(token.text ?? token.raw ?? "");
					if (htmlText.length > 0) {
						output += this.escapeTelegramHtml(htmlText);
					}
					break;
				}
				default:
					if ("tokens" in token && Array.isArray(token.tokens)) {
						output += this.renderMarkdownInlineTokens(token.tokens);
					} else if ("text" in token && typeof token.text === "string") {
						output += this.escapeTelegramHtml(token.text);
					} else if ("raw" in token && typeof token.raw === "string") {
						output += this.escapeTelegramHtml(token.raw);
					}
			}
		}
		return output;
	}

	private renderMarkdownTableCell(cell: Tokens.TableCell): string {
		const rendered = this.renderMarkdownInlineTokens(cell.tokens);
		return rendered.replace(/\s+/g, " ").trim();
	}

	private renderMarkdownBlockTokens(tokens: Token[] | undefined, listDepth = 0): string {
		if (!tokens || tokens.length === 0) return "";
		let output = "";
		for (const token of tokens) {
			switch (token.type) {
				case "space":
					output += "\n";
					break;
				case "heading":
					output += `<b>${this.renderMarkdownInlineTokens(token.tokens)}</b>\n`;
					break;
				case "paragraph":
					output += `${this.renderMarkdownInlineTokens(token.tokens)}\n`;
					break;
				case "text":
					if (Array.isArray(token.tokens) && token.tokens.length > 0) {
						output += `${this.renderMarkdownInlineTokens(token.tokens)}\n`;
					} else {
						output += `${this.escapeTelegramHtml(token.text)}\n`;
					}
					break;
				case "code":
					output += `<pre>${this.escapeTelegramHtml(token.text.replace(/\r\n/g, "\n"))}</pre>\n`;
					break;
				case "blockquote": {
					const rawQuote = this.normalizeTelegramText(this.renderMarkdownBlockTokens(token.tokens, listDepth));
					if (rawQuote.length > 0) {
						const quoted = rawQuote
							.split("\n")
							.map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
							.join("\n");
						output += `${quoted}\n`;
					}
					break;
				}
				case "list": {
					const baseIndent = "  ".repeat(listDepth);
					const start = token.ordered && typeof token.start === "number" ? token.start : 1;
					token.items.forEach((item: Tokens.ListItem, index: number) => {
						const marker = token.ordered ? `${start + index}.` : "•";
						const renderedItem = this.normalizeTelegramText(this.renderMarkdownBlockTokens(item.tokens, listDepth + 1));
						const fallback = this.escapeTelegramHtml(item.text ?? "");
						const body = renderedItem.length > 0 ? renderedItem : fallback;
						const lines = body.split("\n");
						const firstLine = lines.shift() ?? "";
						output += `${baseIndent}${marker} ${firstLine}\n`;
						for (const line of lines) {
							if (line.trim().length === 0) {
								output += "\n";
							} else {
								output += `${baseIndent}   ${line}\n`;
							}
						}
					});
					output += "\n";
					break;
				}
				case "hr":
					output += "────────\n";
					break;
				case "table": {
					const headerLine = token.header
						.map((cell: Tokens.TableCell) => this.renderMarkdownTableCell(cell))
						.join(" | ")
						.trim();
					if (headerLine.length > 0) {
						output += `${headerLine}\n`;
					}
					for (const row of token.rows) {
						const rowLine = row
							.map((cell: Tokens.TableCell) => this.renderMarkdownTableCell(cell))
							.join(" | ")
							.trim();
						if (rowLine.length > 0) {
							output += `${rowLine}\n`;
						}
					}
					output += "\n";
					break;
				}
				case "html": {
					const htmlText = this.stripHtmlTags(token.text ?? token.raw ?? "").trim();
					if (htmlText.length > 0) {
						output += `${this.escapeTelegramHtml(htmlText)}\n`;
					}
					break;
				}
				default:
					if ("tokens" in token && Array.isArray(token.tokens)) {
						output += `${this.renderMarkdownBlockTokens(token.tokens, listDepth)}\n`;
					} else if ("text" in token && typeof token.text === "string") {
						output += `${this.escapeTelegramHtml(token.text)}\n`;
					} else if ("raw" in token && typeof token.raw === "string") {
						output += `${this.escapeTelegramHtml(token.raw)}\n`;
					}
			}
		}
		return output;
	}

	private markdownToTelegramHtml(markdown: string): string {
		if (!markdown || markdown.trim().length === 0) return "";
		const tokens = marked.lexer(markdown, { gfm: true, breaks: true }) as Token[];
		const rendered = this.renderMarkdownBlockTokens(tokens);
		return this.normalizeTelegramText(rendered);
	}

	private markdownToTelegramPlainText(markdown: string): string {
		const html = this.markdownToTelegramHtml(markdown);
		return this.normalizeTelegramText(
			html
				.replace(/<a [^>]*>([\s\S]*?)<\/a>/gi, "$1")
				.replace(/<\/?(b|i|s|u|code|pre)>/gi, "")
				.replace(/&quot;/g, "\"")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&"),
		);
	}

	private splitTelegramText(text: string, chunkSize = TELEGRAM_SAFE_TEXT_CHUNK): string[] {
		const normalized = this.normalizeTelegramText(text);
		if (normalized.length <= chunkSize) return [normalized];
		const chunks: string[] = [];
		let start = 0;
		while (start < normalized.length) {
			let end = Math.min(start + chunkSize, normalized.length);
			if (end < normalized.length) {
				const window = normalized.slice(start, end);
				const splitAt =
					Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")) || -1;
				if (splitAt > 0) {
					end = start + splitAt;
				}
			}
			const chunk = normalized.slice(start, end).trim();
			if (chunk.length > 0) {
				chunks.push(chunk);
			}
			start = end;
		}
		return chunks.length > 0 ? chunks : [normalized];
	}

	private async sendRichMessage(chatId: TelegramChatId, text: string): Promise<void> {
		const html = this.markdownToTelegramHtml(text);
		if (!html || html.length === 0) {
			for (const chunk of this.splitTelegramText(text)) {
				await this.bot.sendMessage(chatId, chunk);
			}
			return;
		}
		if (html.length > TELEGRAM_SAFE_TEXT_CHUNK) {
			const plainLong = this.markdownToTelegramPlainText(text);
			for (const chunk of this.splitTelegramText(plainLong.length > 0 ? plainLong : text)) {
				await this.bot.sendMessage(chatId, chunk);
			}
			return;
		}
		try {
			await this.bot.sendMessage(chatId, html, { parseMode: "HTML" });
		} catch {
			const plain = this.markdownToTelegramPlainText(text);
			for (const chunk of this.splitTelegramText(plain.length > 0 ? plain : text)) {
				await this.bot.sendMessage(chatId, chunk);
			}
		}
	}

	private formatStatusPhase(phase: string): string {
		const lower = phase.toLowerCase();
		if (lower.includes("awaiting")) return "confirm";
		if (lower.includes("tool")) return "tool";
		if (lower.includes("final")) return "final";
		if (lower.includes("start")) return "start";
		if (lower.includes("permission denied")) return "denied";
		if (lower.includes("running")) return "run";
		return lower.replace(/\s+/g, "-");
	}

	private formatPromptPreview(prompt: string, limit = 100): string {
		const cleaned = prompt.replace(/\s+/g, " ").trim();
		if (cleaned.length <= limit) return cleaned;
		return `${cleaned.slice(0, limit - 1)}…`;
	}

	private statusSpinnerFrame(elapsedMs: number): string {
		const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		return frames[Math.floor(elapsedMs / 250) % frames.length] ?? "⠋";
	}

	private statusPulseFrame(elapsedMs: number): string {
		const frames = ["◼···", "◼•··", "◼••·", "◼•••", "◼••·", "◼•··"];
		return frames[Math.floor(elapsedMs / 280) % frames.length] ?? "◼···";
	}

	private statusDotsFrame(elapsedMs: number): string {
		const frames = [".", "..", "..."];
		return frames[Math.floor(elapsedMs / 420) % frames.length] ?? ".";
	}

	private statusActivityLabel(turn: ActiveTurnState | undefined): string {
		if (!turn) return "idle";
		const phase = turn.phase.toLowerCase();
		if (phase.includes("awaiting")) return "awaiting confirm";
		if (phase.includes("tool")) {
			const tool = turn.lastTool?.trim();
			if (tool && tool.length > 0) {
				const shortTool = tool.length > 18 ? `${tool.slice(0, 17)}…` : tool;
				return `tool:${shortTool}`;
			}
			return "tool:running";
		}
		if (phase.includes("final")) return "finalizing";
		if (phase.includes("start")) return "starting";
		if (phase.includes("denied")) return "permission denied";
		return "working";
	}

	private formatToolBadge(toolName: string | undefined): string {
		if (!toolName) return "";
		const compact = toolName.trim().replace(/\s+/g, " ");
		const clipped = compact.length > 18 ? `${compact.slice(0, 17)}…` : compact;
		return ` · ${clipped}`;
	}

	private formatStartingStatus(prompt: string): string {
		return [`⏳ ${APP_NAME} · start · 0s · q${this.promptQueue.size}`, `“${this.formatPromptPreview(prompt, 56)}”`].join("\n");
	}

	private isStatusMessageInvalidError(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return (
			message.includes("message_id_invalid") ||
			message.includes("message to edit not found") ||
			message.includes("message can't be edited")
		);
	}

	private extractTelegramRetryAfterMs(error: unknown): number | undefined {
		const message = error instanceof Error ? error.message : String(error);
		const match = /retry after\s+(\d+)/i.exec(message);
		if (!match) return undefined;
		const seconds = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
		return seconds * 1000;
	}

	private isTransientNetworkError(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return (
			message.includes("fetch failed") ||
			message.includes("network") ||
			message.includes("econnreset") ||
			message.includes("etimedout") ||
			message.includes("enotfound") ||
			message.includes("eai_again") ||
			message.includes("socket hang up") ||
			message.includes("connection reset") ||
			message.includes("timeout")
		);
	}

	private scheduleStatusEditRetry(turnId: number, retryAfterMs: number): void {
		if (!this.activeTurn || this.activeTurn.turnId !== turnId) return;
		if (this.activeTurn.statusEditPending) return;
		this.activeTurn.statusEditPending = true;
		this.activeTurn.statusEditTimer = setTimeout(() => {
			if (this.activeTurn && this.activeTurn.turnId === turnId) {
				this.activeTurn.statusEditPending = false;
				void this.editLiveStatus(true);
			}
		}, retryAfterMs);
	}

	private async recreateLiveStatusMessage(target: ActiveTurnState, statusText: string): Promise<boolean> {
		// Status message may be removed by user or become invalid in Telegram storage.
		// Recreate it and continue editing against the new message_id.
		if (!this.activeTurn || this.activeTurn.turnId !== target.turnId) return false;
		try {
			const fresh = await this.bot.sendMessage(target.chatId, statusText, {
				replyMarkup: { inline_keyboard: [] },
			});
			target.statusMessageId = fresh.message_id;
			target.lastStatusEditAt = Date.now();
			return true;
		} catch (error) {
			console.warn(
				`[telegram] status recreation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private formatLiveStatus(turn: ActiveTurnState | undefined = this.activeTurn): string {
		if (!turn) return "No active task.";
		const elapsedMs = Date.now() - turn.startedAt;
		const elapsed = `${Math.floor(elapsedMs / 1000)}s`;
		const spinner = this.statusSpinnerFrame(elapsedMs);
		const pulse = this.statusPulseFrame(elapsedMs);
		const phaseLabel = this.formatStatusPhase(turn.phase);
		const toolSegment = this.formatToolBadge(turn.lastTool);
		const activity = this.statusActivityLabel(turn);
		return [
			`${spinner} ${APP_NAME} · ${phaseLabel}${toolSegment} · ${elapsed} · q${this.promptQueue.size}`,
			`${pulse} ${activity}`,
			`“${this.formatPromptPreview(turn.prompt, 56)}”`,
		].join("\n");
	}

	private async editLiveStatus(force = false): Promise<void> {
		if (!this.activeTurn) return;
		if (this.activeTurn.statusEditPending) return;
		const turnId = this.activeTurn.turnId;
		const now = Date.now();
		const effectiveThrottleMs = this.statusEditThrottleMs;
		const waitMs = this.activeTurn.lastStatusEditAt + effectiveThrottleMs - now;
		if (!force && waitMs > 0) {
			this.activeTurn.statusEditPending = true;
			this.activeTurn.statusEditTimer = setTimeout(() => {
				if (this.activeTurn && this.activeTurn.turnId === turnId) {
					this.activeTurn.statusEditPending = false;
					void this.editLiveStatus(true);
				}
			}, waitMs);
			return;
		}

		const target = this.activeTurn;
		const statusText = this.formatLiveStatus(target);
		const editPromise = this.bot
			.editMessageText(target.chatId, target.statusMessageId, statusText, {
					replyMarkup: { inline_keyboard: [] },
				})
			.then(() => {
				target.lastStatusEditAt = Date.now();
			})
			.catch(async (error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				// Ignore no-op edit errors and transient "message is not modified".
				if (!message.toLowerCase().includes("message is not modified")) {
					if (this.isTransientNetworkError(error)) {
						const retryMs = Math.max(this.statusEditNetworkRetryMs, effectiveThrottleMs);
						console.warn(`[telegram] status edit network failure, retrying in ${Math.ceil(retryMs / 1000)}s`);
						this.scheduleStatusEditRetry(turnId, retryMs);
						return;
					}
					const retryAfterMs = this.extractTelegramRetryAfterMs(error);
					if (retryAfterMs) {
						console.warn(`[telegram] status edit rate-limited, retrying in ${Math.ceil(retryAfterMs / 1000)}s`);
						this.scheduleStatusEditRetry(turnId, retryAfterMs);
						return;
					}
					if (this.isStatusMessageInvalidError(error)) {
						const recovered = await this.recreateLiveStatusMessage(target, statusText);
						if (recovered) return;
					}
					console.warn(`[telegram] status edit failed: ${message}`);
				}
			})
			.finally(() => {
				if (target.statusEditInFlight === editPromise) {
					target.statusEditInFlight = undefined;
				}
			});
		target.statusEditInFlight = editPromise;
		await editPromise;
	}

	private async finishTurn(options?: { error?: string }): Promise<void> {
		const finishedTurn = this.activeTurn;
		if (!finishedTurn) return;
		this.activeTurn = undefined;
		// Always flush confirmation state at turn boundary to avoid stale groups across turns.
		this.clearPendingConfirmations(true);
		if (finishedTurn.statusEditTimer) {
			clearTimeout(finishedTurn.statusEditTimer);
		}
		finishedTurn.statusEditPending = false;
		if (finishedTurn.statusEditInFlight) {
			try {
				await finishedTurn.statusEditInFlight;
			} catch {
				// Best-effort; still continue to final status update.
			}
		}

		let finalText: string | null = null;
		if (!options?.error) {
			try {
				finalText = await this.rpcClient.getLastAssistantText();
				this.rpcConnected = true;
			} catch (error) {
				this.rpcConnected = false;
				options = {
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
		if (!options?.error && (!finalText || finalText.trim().length === 0) && finishedTurn.lastAssistantTurnText) {
			finalText = finishedTurn.lastAssistantTurnText;
		}

		const statusLabel = options?.error
			? `❌ error · ${Math.floor((Date.now() - finishedTurn.startedAt) / 1000)}s\n${this.formatPromptPreview(options.error, 96)}`
			: finishedTurn.aborted
				? `⛔ aborted · ${Math.floor((Date.now() - finishedTurn.startedAt) / 1000)}s`
				: `✅ done · ${Math.floor((Date.now() - finishedTurn.startedAt) / 1000)}s`;
		try {
			await this.bot.editMessageText(finishedTurn.chatId, finishedTurn.statusMessageId, statusLabel, {
				replyMarkup: { inline_keyboard: [] },
			});
		} catch (error) {
			// Best-effort, but recover from invalid status message ids to avoid losing final state.
			if (this.isStatusMessageInvalidError(error)) {
				await this.bot.sendMessage(finishedTurn.chatId, statusLabel).catch(() => {});
			}
		}

		try {
			if (options?.error) {
				await this.bot.sendMessage(finishedTurn.chatId, `Task failed: ${options.error}`);
			} else if (finalText && finalText.trim().length > 0) {
				await this.sendFinalOutput(finishedTurn.chatId, finalText);
			} else if (!finishedTurn.aborted) {
				await this.bot.sendMessage(finishedTurn.chatId, "Task completed with no assistant text output.");
			}
		} catch (error) {
			console.warn(`[telegram] final output delivery failed: ${error instanceof Error ? error.message : String(error)}`);
			try {
				await this.bot.sendMessage(
					finishedTurn.chatId,
					"Task completed, but delivery failed. Retry /status or rerun the task.",
				);
			} catch (fallbackError) {
				console.warn(
					`[telegram] final output fallback delivery failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
				);
			}
		}

		await this.drainQueue();
	}

	private async sendFinalOutput(chatId: TelegramChatId, finalText: string): Promise<void> {
		if (finalText.length <= this.maxSummaryChars) {
			await this.sendRichMessage(chatId, finalText);
			return;
		}
		const summary = `${finalText.slice(0, this.maxSummaryChars).trimEnd()}\n\n[output truncated in chat]`;
		await this.sendRichMessage(chatId, summary);
		await this.bot.sendTextDocument(chatId, "iosm-output.txt", finalText, "Full output");
	}

	private async drainQueue(): Promise<void> {
		if (this.activeTurn) return;
		const next = this.promptQueue.dequeue();
		if (!next) return;
		this.tracePolling(`dequeue next chat=${next.chatId} queue_remaining=${this.promptQueue.size}`);
		await this.startTurn(next.chatId, next.text);
	}
}

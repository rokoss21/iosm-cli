import { setTimeout as sleepTimeout } from "node:timers/promises";

export type TelegramChatId = number;

export interface TelegramUser {
	id: number;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
}

export interface TelegramMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	data?: string;
	message?: TelegramMessage;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramApiEnvelope<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

export interface TelegramInlineKeyboardMarkup {
	inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramReplyKeyboardMarkup {
	keyboard: Array<Array<{ text: string }>>;
	resize_keyboard?: boolean;
	is_persistent?: boolean;
	one_time_keyboard?: boolean;
	input_field_placeholder?: string;
}

export type TelegramReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;

const TELEGRAM_API_MAX_429_RETRIES = 4;
const TELEGRAM_API_MAX_NETWORK_RETRIES = 3;
const TELEGRAM_API_NETWORK_BACKOFF_INITIAL_MS = 1500;
const TELEGRAM_NETWORK_BACKOFF_MAX_MS = 30_000;

interface TelegramBotApiDependencies {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

export interface TelegramBotApiRetryOptions {
	max429Retries?: number;
	maxNetworkRetries?: number;
	networkBackoffInitialMs?: number;
	networkBackoffMaxMs?: number;
}

export class TelegramBotApi {
	private outboundSerial: Promise<void> = Promise.resolve();
	private readonly fetchImpl: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly max429Retries: number;
	private readonly maxNetworkRetries: number;
	private readonly networkBackoffInitialMs: number;
	private readonly networkBackoffMaxMs: number;

	constructor(
		private readonly token: string,
		deps?: TelegramBotApiDependencies,
		retryOptions?: TelegramBotApiRetryOptions,
	) {
		this.fetchImpl = deps?.fetchImpl ?? fetch;
		this.sleep = deps?.sleep ?? ((ms: number) => sleepTimeout(ms).then(() => undefined));
		this.max429Retries = clampInteger(retryOptions?.max429Retries, 0, 20, TELEGRAM_API_MAX_429_RETRIES);
		this.maxNetworkRetries = clampInteger(retryOptions?.maxNetworkRetries, 0, 20, TELEGRAM_API_MAX_NETWORK_RETRIES);
		this.networkBackoffInitialMs = clampInteger(
			retryOptions?.networkBackoffInitialMs,
			250,
			120000,
			TELEGRAM_API_NETWORK_BACKOFF_INITIAL_MS,
		);
		const maxBackoffCandidate = clampInteger(
			retryOptions?.networkBackoffMaxMs,
			500,
			300000,
			TELEGRAM_NETWORK_BACKOFF_MAX_MS,
		);
		this.networkBackoffMaxMs = Math.max(this.networkBackoffInitialMs, maxBackoffCandidate);
	}

	private get endpoint(): string {
		return `https://api.telegram.org/bot${this.token}`;
	}

	async getMe(): Promise<{ id: number; username?: string }> {
		return this.call("getMe", {});
	}

	async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
		return this.call(
			"getUpdates",
			{
				offset,
				timeout: timeoutSeconds,
				allowed_updates: ["message", "callback_query"],
			},
			{ retryNetwork: false },
		);
	}

	async sendMessage(
		chatId: TelegramChatId,
		text: string,
		options?: {
			replyMarkup?: TelegramReplyMarkup;
			disableNotification?: boolean;
			parseMode?: "HTML";
		},
	): Promise<TelegramMessage> {
		return this.enqueueOutbound(() =>
			this.call("sendMessage", {
				chat_id: chatId,
				text,
				reply_markup: options?.replyMarkup,
				disable_notification: options?.disableNotification ?? false,
				parse_mode: options?.parseMode,
			}),
		);
	}

	async editMessageText(
		chatId: TelegramChatId,
		messageId: number,
		text: string,
		options?: { replyMarkup?: TelegramInlineKeyboardMarkup },
	): Promise<TelegramMessage | boolean> {
		return this.enqueueOutbound(() =>
			this.call("editMessageText", {
				chat_id: chatId,
				message_id: messageId,
				text,
				reply_markup: options?.replyMarkup,
			}),
		);
	}

	async editMessageReplyMarkup(
		chatId: TelegramChatId,
		messageId: number,
		replyMarkup?: TelegramInlineKeyboardMarkup,
	): Promise<TelegramMessage | boolean> {
		return this.enqueueOutbound(() =>
			this.call("editMessageReplyMarkup", {
				chat_id: chatId,
				message_id: messageId,
				reply_markup: replyMarkup,
			}),
		);
	}

	async deleteMessage(chatId: TelegramChatId, messageId: number): Promise<boolean> {
		return this.enqueueOutbound(() =>
			this.call("deleteMessage", {
				chat_id: chatId,
				message_id: messageId,
			}),
		);
	}

	async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
		try {
			return await this.call("answerCallbackQuery", {
				callback_query_id: callbackQueryId,
				text,
				show_alert: false,
			});
		} catch (error) {
			if (this.isExpiredCallbackError(error)) {
				console.warn(
					`[telegram] answerCallbackQuery ignored stale query: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				return false;
			}
			throw error;
		}
	}

	async sendTextDocument(chatId: TelegramChatId, filename: string, content: string, caption?: string): Promise<TelegramMessage> {
		const form = new FormData();
		form.set("chat_id", String(chatId));
		if (caption) {
			form.set("caption", caption);
		}
		form.set("document", new Blob([content], { type: "text/plain" }), filename);
		return this.enqueueOutbound(() => this.callMultipart("sendDocument", form));
	}

	private enqueueOutbound<T>(task: () => Promise<T>): Promise<T> {
		const scheduled = this.outboundSerial.then(task, task);
		this.outboundSerial = scheduled.then(
			() => undefined,
			() => undefined,
		);
		return scheduled;
	}

	private isTransientNetworkErrorMessage(message: string): boolean {
		const lower = message.toLowerCase();
		return (
			lower.includes("fetch failed") ||
			lower.includes("network") ||
			lower.includes("econnreset") ||
			lower.includes("etimedout") ||
			lower.includes("enotfound") ||
			lower.includes("eai_again") ||
			lower.includes("socket hang up") ||
			lower.includes("connection reset") ||
			lower.includes("timeout")
		);
	}

	private networkRetryDelayMs(attempt: number): number {
		return Math.min(
			this.networkBackoffMaxMs,
			this.networkBackoffInitialMs * Math.pow(2, Math.max(0, attempt)),
		);
	}

	private async call<T>(
		method: string,
		payload: Record<string, unknown>,
		options?: { retryNetwork?: boolean },
	): Promise<T> {
		const retryNetwork = options?.retryNetwork ?? true;
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.endpoint}/${method}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify(payload),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (retryNetwork && this.isTransientNetworkErrorMessage(message) && attempt < this.maxNetworkRetries) {
					const retryMs = this.networkRetryDelayMs(attempt);
					console.warn(
						`[telegram] ${method} network failure, retrying in ${Math.ceil(retryMs / 1000)}s (${attempt + 1}/${this.maxNetworkRetries})`,
					);
					await this.sleep(retryMs);
					continue;
				}
				throw new Error(`Telegram API ${method} request failed: ${message}`);
			}
			const envelope = await this.readEnvelope<T>(response);
			if (response.ok && envelope.ok && envelope.result !== undefined) {
				return envelope.result;
			}
			const errorCode = envelope.error_code ?? response.status;
			const retryAfterMs = this.extractRetryAfterMs(response, envelope.description);
			if (errorCode === 429 && retryAfterMs !== undefined && attempt < this.max429Retries) {
				console.warn(
					`[telegram] ${method} rate-limited, retrying in ${Math.ceil(retryAfterMs / 1000)}s (${attempt + 1}/${this.max429Retries})`,
				);
				await this.sleep(retryAfterMs);
				continue;
			}
			if ((errorCode >= 500 || errorCode === 408) && retryNetwork && attempt < this.maxNetworkRetries) {
				const retryMs = this.networkRetryDelayMs(attempt);
				console.warn(
					`[telegram] ${method} server error (${errorCode}), retrying in ${Math.ceil(retryMs / 1000)}s (${attempt + 1}/${this.maxNetworkRetries})`,
				);
				await this.sleep(retryMs);
				continue;
			}
			throw new Error(`Telegram API ${method} failed: ${envelope.description ?? response.statusText} (${errorCode})`);
		}
	}

	private async callMultipart<T>(method: string, form: FormData): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			let response: Response;
			try {
				response = await this.fetchImpl(`${this.endpoint}/${method}`, {
					method: "POST",
					body: form,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (this.isTransientNetworkErrorMessage(message) && attempt < this.maxNetworkRetries) {
					const retryMs = this.networkRetryDelayMs(attempt);
					console.warn(
						`[telegram] ${method} network failure, retrying in ${Math.ceil(retryMs / 1000)}s (${attempt + 1}/${this.maxNetworkRetries})`,
					);
					await this.sleep(retryMs);
					continue;
				}
				throw new Error(`Telegram API ${method} request failed: ${message}`);
			}
			const envelope = await this.readEnvelope<T>(response);
			if (response.ok && envelope.ok && envelope.result !== undefined) {
				return envelope.result;
			}
			const errorCode = envelope.error_code ?? response.status;
			const retryAfterMs = this.extractRetryAfterMs(response, envelope.description);
			if (errorCode === 429 && retryAfterMs !== undefined && attempt < this.max429Retries) {
				console.warn(
					`[telegram] ${method} rate-limited, retrying in ${Math.ceil(retryAfterMs / 1000)}s (${attempt + 1}/${this.max429Retries})`,
				);
				await this.sleep(retryAfterMs);
				continue;
			}
			if ((errorCode >= 500 || errorCode === 408) && attempt < this.maxNetworkRetries) {
				const retryMs = this.networkRetryDelayMs(attempt);
				console.warn(
					`[telegram] ${method} server error (${errorCode}), retrying in ${Math.ceil(retryMs / 1000)}s (${attempt + 1}/${this.maxNetworkRetries})`,
				);
				await this.sleep(retryMs);
				continue;
			}
			throw new Error(`Telegram API ${method} failed: ${envelope.description ?? response.statusText} (${errorCode})`);
		}
	}

	private async readEnvelope<T>(response: Response): Promise<TelegramApiEnvelope<T>> {
		try {
			return (await response.json()) as TelegramApiEnvelope<T>;
		} catch {
			return {
				ok: false,
				description: response.statusText,
				error_code: response.status,
			};
		}
	}

	private extractRetryAfterMs(response: Response, description: string | undefined): number | undefined {
		const headerValue = response.headers.get("retry-after");
		if (headerValue) {
			const headerSeconds = Number.parseInt(headerValue, 10);
			if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
				return headerSeconds * 1000;
			}
		}
		if (!description) return undefined;
		const match = /retry after\s+(\d+)/i.exec(description);
		if (!match) return undefined;
		const seconds = Number.parseInt(match[1] ?? "", 10);
		if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
		return seconds * 1000;
	}

	private isExpiredCallbackError(error: unknown): boolean {
		const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
		return (
			message.includes("query is too old") ||
			message.includes("query id is invalid") ||
			message.includes("query_id_invalid")
		);
	}
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

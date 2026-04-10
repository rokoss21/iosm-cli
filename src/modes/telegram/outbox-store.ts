import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";

const OUTBOX_SCHEMA_VERSION = 1;

export interface TelegramOutboxSendMessagePayload {
	chatId: number;
	text: string;
	options?: {
		replyMarkup?: unknown;
		disableNotification?: boolean;
		parseMode?: "HTML";
	};
}

export interface TelegramOutboxSendTextDocumentPayload {
	chatId: number;
	filename: string;
	content: string;
	caption?: string;
}

export type TelegramOutboxOperation = "sendMessage" | "sendTextDocument";

export interface TelegramOutboxEntryBase {
	version: typeof OUTBOX_SCHEMA_VERSION;
	id: string;
	operation: TelegramOutboxOperation;
	createdAt: string;
	updatedAt: string;
	attempts: number;
	lastError?: string;
}

export interface TelegramOutboxSendMessageEntry extends TelegramOutboxEntryBase {
	operation: "sendMessage";
	payload: TelegramOutboxSendMessagePayload;
}

export interface TelegramOutboxSendTextDocumentEntry extends TelegramOutboxEntryBase {
	operation: "sendTextDocument";
	payload: TelegramOutboxSendTextDocumentPayload;
}

export type TelegramOutboxEntry = TelegramOutboxSendMessageEntry | TelegramOutboxSendTextDocumentEntry;

export interface TelegramOutboxStats {
	pending: number;
	failed: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function parseTelegramOutboxEntry(value: unknown): TelegramOutboxEntry | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.version !== OUTBOX_SCHEMA_VERSION) return undefined;
	if (typeof value.id !== "string" || value.id.trim().length === 0) return undefined;
	if (typeof value.createdAt !== "string" || value.createdAt.trim().length === 0) return undefined;
	if (typeof value.updatedAt !== "string" || value.updatedAt.trim().length === 0) return undefined;
	if (!Number.isInteger(value.attempts) || (value.attempts as number) < 0) return undefined;
	if (value.lastError !== undefined && typeof value.lastError !== "string") return undefined;

	if (value.operation === "sendMessage") {
		if (!isPlainObject(value.payload)) return undefined;
		if (!Number.isInteger(value.payload.chatId)) return undefined;
		if (typeof value.payload.text !== "string") return undefined;
		if (value.payload.options !== undefined && !isPlainObject(value.payload.options)) return undefined;
		let normalizedOptions: TelegramOutboxSendMessagePayload["options"];
		if (isPlainObject(value.payload.options)) {
			const options = value.payload.options;
			if (options.disableNotification !== undefined && typeof options.disableNotification !== "boolean") return undefined;
			if (options.parseMode !== undefined && options.parseMode !== "HTML") return undefined;
			normalizedOptions = {
				replyMarkup: options.replyMarkup,
				disableNotification: options.disableNotification as boolean | undefined,
				parseMode: options.parseMode as "HTML" | undefined,
			};
		}
		return {
			version: OUTBOX_SCHEMA_VERSION,
			id: value.id,
			operation: "sendMessage",
			payload: {
				chatId: value.payload.chatId as number,
				text: value.payload.text,
				options: normalizedOptions,
			},
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			attempts: value.attempts as number,
			lastError: value.lastError as string | undefined,
		};
	}

	if (value.operation === "sendTextDocument") {
		if (!isPlainObject(value.payload)) return undefined;
		if (!Number.isInteger(value.payload.chatId)) return undefined;
		if (typeof value.payload.filename !== "string" || value.payload.filename.length === 0) return undefined;
		if (typeof value.payload.content !== "string") return undefined;
		if (value.payload.caption !== undefined && typeof value.payload.caption !== "string") return undefined;
		return {
			version: OUTBOX_SCHEMA_VERSION,
			id: value.id,
			operation: "sendTextDocument",
			payload: {
				chatId: value.payload.chatId as number,
				filename: value.payload.filename,
				content: value.payload.content,
				caption: value.payload.caption as string | undefined,
			},
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			attempts: value.attempts as number,
			lastError: value.lastError as string | undefined,
		};
	}

	return undefined;
}

function comparePendingEntries(left: TelegramOutboxEntry, right: TelegramOutboxEntry): number {
	const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
	if (byCreatedAt !== 0) return byCreatedAt;
	return left.id.localeCompare(right.id);
}

export class TelegramOutboxStore {
	private readonly pendingDir: string;

	constructor(agentDir = getAgentDir()) {
		this.pendingDir = join(agentDir, "telegram", "outbox", "pending");
	}

	enqueueMessage(payload: TelegramOutboxSendMessagePayload): TelegramOutboxSendMessageEntry {
		const now = new Date().toISOString();
		const entry: TelegramOutboxSendMessageEntry = {
			version: OUTBOX_SCHEMA_VERSION,
			id: this.createEntryId(),
			operation: "sendMessage",
			payload: {
				chatId: payload.chatId,
				text: payload.text,
				options: payload.options
					? {
							replyMarkup: payload.options.replyMarkup,
							disableNotification: payload.options.disableNotification,
							parseMode: payload.options.parseMode,
					  }
					: undefined,
			},
			createdAt: now,
			updatedAt: now,
			attempts: 0,
		};
		this.writeEntry(entry);
		return entry;
	}

	enqueueTextDocument(payload: TelegramOutboxSendTextDocumentPayload): TelegramOutboxSendTextDocumentEntry {
		const now = new Date().toISOString();
		const entry: TelegramOutboxSendTextDocumentEntry = {
			version: OUTBOX_SCHEMA_VERSION,
			id: this.createEntryId(),
			operation: "sendTextDocument",
			payload: {
				chatId: payload.chatId,
				filename: payload.filename,
				content: payload.content,
				caption: payload.caption,
			},
			createdAt: now,
			updatedAt: now,
			attempts: 0,
		};
		this.writeEntry(entry);
		return entry;
	}

	listPending(): TelegramOutboxEntry[] {
		if (!existsSync(this.pendingDir)) return [];

		let names: string[];
		try {
			names = readdirSync(this.pendingDir)
				.filter((name) => name.endsWith(".json"))
				.sort((left, right) => left.localeCompare(right));
		} catch {
			return [];
		}

		const entries: TelegramOutboxEntry[] = [];
		for (const name of names) {
			const path = join(this.pendingDir, name);
			try {
				const raw = readFileSync(path, "utf8");
				const parsed = parseTelegramOutboxEntry(JSON.parse(raw));
				if (!parsed) {
					console.warn(`[telegram] outbox: skipping invalid entry ${name}`);
					continue;
				}
				entries.push(parsed);
			} catch (error) {
				console.warn(
					`[telegram] outbox: failed to read entry ${name}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return entries.sort(comparePendingEntries);
	}

	getStats(): TelegramOutboxStats {
		const pendingEntries = this.listPending();
		return {
			pending: pendingEntries.length,
			failed: pendingEntries.reduce((count, entry) => (entry.attempts > 0 ? count + 1 : count), 0),
		};
	}

	ack(entryId: string): void {
		const path = this.entryPath(entryId);
		rmSync(path, { force: true });
	}

	noteFailure(entryId: string, error: unknown): void {
		const existing = this.readEntry(entryId);
		if (!existing) return;
		const now = new Date().toISOString();
		const next: TelegramOutboxEntry = {
			...existing,
			attempts: existing.attempts + 1,
			updatedAt: now,
			lastError: normalizeErrorMessage(error),
		};
		this.writeEntry(next);
	}

	private entryPath(entryId: string): string {
		return join(this.pendingDir, `${entryId}.json`);
	}

	private readEntry(entryId: string): TelegramOutboxEntry | undefined {
		const path = this.entryPath(entryId);
		if (!existsSync(path)) return undefined;
		try {
			const raw = readFileSync(path, "utf8");
			return parseTelegramOutboxEntry(JSON.parse(raw));
		} catch {
			return undefined;
		}
	}

	private writeEntry(entry: TelegramOutboxEntry): void {
		mkdirSync(this.pendingDir, { recursive: true });
		const finalPath = this.entryPath(entry.id);
		const tmpPath = join(
			this.pendingDir,
			`.tmp.${process.pid}.${entry.id}.${Math.random().toString(36).slice(2, 10)}.json`,
		);
		writeFileSync(tmpPath, JSON.stringify(entry, null, 2), { encoding: "utf8" });
		renameSync(tmpPath, finalPath);
	}

	private createEntryId(): string {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const candidate = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			if (!existsSync(this.entryPath(candidate))) {
				return candidate;
			}
		}
		return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	}
}

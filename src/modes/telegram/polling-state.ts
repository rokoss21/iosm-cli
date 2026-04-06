import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "../../config.js";

interface TelegramPollingStateRecord {
	offset: number;
	updatedAt: string;
}

interface TelegramPollingStateFile {
	version: 1;
	bots: Record<string, TelegramPollingStateRecord>;
}

const POLLING_STATE_SCHEMA_VERSION = 1;

function createEmptyState(): TelegramPollingStateFile {
	return {
		version: POLLING_STATE_SCHEMA_VERSION,
		bots: {},
	};
}

function normalizeOffset(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.floor(value);
}

export class TelegramPollingStateStore {
	private readonly filePath: string;

	constructor(agentDir = getAgentDir()) {
		this.filePath = join(agentDir, "telegram", "polling-state.json");
	}

	loadOffset(botToken: string): number {
		const key = this.hashToken(botToken);
		const state = this.readState();
		return normalizeOffset(state.bots[key]?.offset);
	}

	saveOffset(botToken: string, offset: number): void {
		const normalizedOffset = normalizeOffset(offset);
		const key = this.hashToken(botToken);
		const state = this.readState();
		state.bots[key] = {
			offset: normalizedOffset,
			updatedAt: new Date().toISOString(),
		};
		this.writeState(state);
	}

	private hashToken(botToken: string): string {
		return createHash("sha256").update(botToken).digest("hex").slice(0, 24);
	}

	private readState(): TelegramPollingStateFile {
		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<TelegramPollingStateFile>;
			if (!parsed || parsed.version !== POLLING_STATE_SCHEMA_VERSION || typeof parsed.bots !== "object") {
				return createEmptyState();
			}
			const normalizedBots: Record<string, TelegramPollingStateRecord> = {};
			for (const [botKey, value] of Object.entries(parsed.bots)) {
				const offset = normalizeOffset((value as { offset?: unknown })?.offset);
				const updatedAtRaw = (value as { updatedAt?: unknown })?.updatedAt;
				const updatedAt =
					typeof updatedAtRaw === "string" && updatedAtRaw.length > 0 ? updatedAtRaw : new Date().toISOString();
				normalizedBots[botKey] = { offset, updatedAt };
			}
			return {
				version: POLLING_STATE_SCHEMA_VERSION,
				bots: normalizedBots,
			};
		} catch {
			return createEmptyState();
		}
	}

	private writeState(state: TelegramPollingStateFile): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(state, null, 2), { encoding: "utf8" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[telegram] failed to persist polling state: ${message}`);
		}
	}
}

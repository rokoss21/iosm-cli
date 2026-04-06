import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramPollingStateStore } from "../src/modes/telegram/polling-state.js";

describe("TelegramPollingStateStore", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns zero offset when state file is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-state-"));
		dirs.push(root);
		const store = new TelegramPollingStateStore(root);
		expect(store.loadOffset("token-a")).toBe(0);
	});

	it("persists and restores offsets per bot token", () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-state-"));
		dirs.push(root);
		const store = new TelegramPollingStateStore(root);
		store.saveOffset("token-a", 101);
		store.saveOffset("token-b", 202);

		const reloaded = new TelegramPollingStateStore(root);
		expect(reloaded.loadOffset("token-a")).toBe(101);
		expect(reloaded.loadOffset("token-b")).toBe(202);
		expect(reloaded.loadOffset("token-c")).toBe(0);
	});

	it("handles corrupted state file gracefully", () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-state-"));
		dirs.push(root);
		const filePath = join(root, "telegram", "polling-state.json");
		mkdirSync(join(root, "telegram"), { recursive: true });
		writeFileSync(filePath, "{not json", "utf8");
		const store = new TelegramPollingStateStore(root);

		expect(store.loadOffset("token-a")).toBe(0);
		store.saveOffset("token-a", 77);

		const raw = readFileSync(filePath, "utf8");
		expect(raw).toContain("\"version\": 1");
		expect(new TelegramPollingStateStore(root).loadOffset("token-a")).toBe(77);
	});
});

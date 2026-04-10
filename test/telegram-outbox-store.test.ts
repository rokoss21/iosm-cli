import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramOutboxStore } from "../src/modes/telegram/outbox-store.js";

describe("TelegramOutboxStore", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists and acknowledges queued entries", () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-outbox-"));
		dirs.push(root);
		const store = new TelegramOutboxStore(root);

		const messageEntry = store.enqueueMessage({
			chatId: 1,
			text: "hello",
		});
		const documentEntry = store.enqueueTextDocument({
			chatId: 2,
			filename: "note.txt",
			content: "payload",
			caption: "caption",
		});

		const pending = store.listPending();
		expect(pending).toHaveLength(2);
		expect(pending.some((entry) => entry.id === messageEntry.id)).toBe(true);
		expect(pending.some((entry) => entry.id === documentEntry.id)).toBe(true);
		expect(store.getStats()).toEqual({ pending: 2, failed: 0 });

		store.ack(messageEntry.id);
		const remaining = store.listPending();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.id).toBe(documentEntry.id);
		expect(store.getStats()).toEqual({ pending: 1, failed: 0 });
	});

	it("tracks failed delivery attempts", () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-outbox-"));
		dirs.push(root);
		const store = new TelegramOutboxStore(root);

		const entry = store.enqueueMessage({
			chatId: 99,
			text: "boom",
		});
		store.noteFailure(entry.id, new Error("network unstable"));

		const pending = store.listPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.attempts).toBe(1);
		expect(pending[0]?.lastError).toContain("network unstable");
		expect(store.getStats()).toEqual({ pending: 1, failed: 1 });
	});
});

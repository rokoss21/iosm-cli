import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramBotApi } from "../src/modes/telegram/telegram-api.js";
import { TelegramOutboxStore } from "../src/modes/telegram/outbox-store.js";

function okResponse<T>(result: T): Response {
	return new Response(JSON.stringify({ ok: true, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function failResponse(status: number, description: string): Response {
	return new Response(
		JSON.stringify({
			ok: false,
			error_code: status,
			description,
		}),
		{
			status,
			headers: { "content-type": "application/json" },
		},
	);
}

describe("TelegramBotApi", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retries rate-limited responses using retry_after", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(failResponse(429, "Too Many Requests: retry after 2"))
			.mockResolvedValueOnce(
				okResponse({
					message_id: 1,
					chat: { id: 10, type: "private" },
					date: 1,
					text: "ok",
				}),
			);
		const api = new TelegramBotApi("test-token", { fetchImpl, sleep });

		const result = await api.sendMessage(10, "hello");
		expect(result.message_id).toBe(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(2000);
	});

	it("retries transient network failures for outbound calls", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(
				okResponse({
					message_id: 2,
					chat: { id: 20, type: "private" },
					date: 1,
					text: "ok",
				}),
			);
		const api = new TelegramBotApi("test-token", { fetchImpl, sleep });

		const result = await api.sendMessage(20, "hello");
		expect(result.message_id).toBe(2);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(1500);
	});

	it("does not retry network failures for getUpdates polling requests", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("fetch failed"));
		const api = new TelegramBotApi("test-token", { fetchImpl, sleep });

		await expect(api.getUpdates(0, 25)).rejects.toThrow(/request failed/i);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("serializes outbound requests to avoid concurrent burst", async () => {
		const sleep = vi.fn(async (_ms: number) => {});
		let callCount = 0;
		let resolveFirst: ((response: Response) => void) | undefined;
		const firstPromise = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
			callCount += 1;
			if (callCount === 1) {
				return firstPromise;
			}
			return okResponse({
				message_id: 100 + callCount,
				chat: { id: 42, type: "private" },
				date: 1,
				text: "ok",
			});
		});

		const api = new TelegramBotApi("test-token", { fetchImpl, sleep });
		const p1 = api.sendMessage(42, "first");
		const p2 = api.sendMessage(42, "second");

		await Promise.resolve();
		expect(callCount).toBe(1);

		resolveFirst?.(
			okResponse({
				message_id: 101,
				chat: { id: 42, type: "private" },
				date: 1,
				text: "ok",
			}),
		);

		await expect(p1).resolves.toMatchObject({ message_id: 101 });
		await expect(p2).resolves.toMatchObject({ message_id: 102 });
		expect(callCount).toBe(2);
	});

	it("replays pending outbox entries on startup", async () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-outbox-"));
		dirs.push(root);
		const outboxStore = new TelegramOutboxStore(root);
		outboxStore.enqueueMessage({
			chatId: 77,
			text: "recover-me",
		});

		const sleep = vi.fn(async (_ms: number) => {});
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			okResponse({
				message_id: 501,
				chat: { id: 77, type: "private" },
				date: 1,
				text: "recover-me",
			}),
		);
		const api = new TelegramBotApi("test-token", { fetchImpl, sleep, outboxStore });

		const replay = await api.replayOutbox();
		expect(replay.replayed).toBe(1);
		expect(replay.failed).toBe(0);
		expect(replay.remaining).toBe(0);
		expect(outboxStore.listPending()).toHaveLength(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("keeps outbox entry when outbound send fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "iosm-telegram-outbox-"));
		dirs.push(root);
		const outboxStore = new TelegramOutboxStore(root);

		const sleep = vi.fn(async (_ms: number) => {});
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("fetch failed"));
		const api = new TelegramBotApi("test-token", { fetchImpl, sleep, outboxStore });

		await expect(api.sendMessage(10, "will-fail")).rejects.toThrow(/request failed/i);
		const pending = outboxStore.listPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.operation).toBe("sendMessage");
		expect(pending[0]?.attempts).toBeGreaterThanOrEqual(1);
	});
});

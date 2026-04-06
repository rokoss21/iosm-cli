import { describe, expect, it, vi } from "vitest";
import { TelegramBotApi } from "../src/modes/telegram/telegram-api.js";

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
});

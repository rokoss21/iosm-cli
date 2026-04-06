import { describe, expect, it } from "vitest";
import { TelegramPromptQueue } from "../src/modes/telegram/prompt-queue.js";

describe("TelegramPromptQueue", () => {
	it("drains prompts in round-robin order across chats", () => {
		const queue = new TelegramPromptQueue();
		queue.enqueue(100, "a1");
		queue.enqueue(100, "a2");
		queue.enqueue(200, "b1");
		queue.enqueue(300, "c1");

		expect(queue.dequeue()?.text).toBe("a1");
		expect(queue.dequeue()?.text).toBe("b1");
		expect(queue.dequeue()?.text).toBe("c1");
		expect(queue.dequeue()?.text).toBe("a2");
		expect(queue.dequeue()).toBeUndefined();
	});

	it("tracks per-chat and total queue size", () => {
		const queue = new TelegramPromptQueue();
		expect(queue.size).toBe(0);
		expect(queue.sizeForChat(1)).toBe(0);

		queue.enqueue(1, "hello");
		queue.enqueue(2, "world");
		queue.enqueue(1, "again");
		expect(queue.size).toBe(3);
		expect(queue.sizeForChat(1)).toBe(2);
		expect(queue.sizeForChat(2)).toBe(1);

		queue.dequeue();
		expect(queue.size).toBe(2);
	});

	it("clears queued prompts and returns dropped count", () => {
		const queue = new TelegramPromptQueue();
		queue.enqueue(1, "one");
		queue.enqueue(2, "two");
		queue.enqueue(2, "three");
		expect(queue.clear()).toBe(3);
		expect(queue.size).toBe(0);
		expect(queue.dequeue()).toBeUndefined();
	});
});

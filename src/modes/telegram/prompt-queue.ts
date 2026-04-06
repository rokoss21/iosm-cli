export interface TelegramQueuedPrompt {
	chatId: number;
	text: string;
	enqueuedAt: number;
}

export interface TelegramQueueEnqueueResult {
	totalSize: number;
	chatSize: number;
}

/**
 * Fair prompt queue for Telegram bridge.
 * Prompts are stored per chat and drained in round-robin order.
 */
export class TelegramPromptQueue {
	private readonly chatQueues = new Map<number, TelegramQueuedPrompt[]>();
	private readonly chatOrder: number[] = [];
	private totalSize = 0;

	get size(): number {
		return this.totalSize;
	}

	sizeForChat(chatId: number): number {
		return this.chatQueues.get(chatId)?.length ?? 0;
	}

	enqueue(chatId: number, text: string): TelegramQueueEnqueueResult {
		let queue = this.chatQueues.get(chatId);
		if (!queue) {
			queue = [];
			this.chatQueues.set(chatId, queue);
			this.chatOrder.push(chatId);
		}
		queue.push({
			chatId,
			text,
			enqueuedAt: Date.now(),
		});
		this.totalSize += 1;
		return {
			totalSize: this.totalSize,
			chatSize: queue.length,
		};
	}

	dequeue(): TelegramQueuedPrompt | undefined {
		while (this.chatOrder.length > 0) {
			const chatId = this.chatOrder.shift();
			if (typeof chatId !== "number") continue;
			const queue = this.chatQueues.get(chatId);
			if (!queue || queue.length === 0) {
				this.chatQueues.delete(chatId);
				continue;
			}
			const next = queue.shift();
			if (!next) {
				this.chatQueues.delete(chatId);
				continue;
			}
			this.totalSize = Math.max(0, this.totalSize - 1);
			if (queue.length > 0) {
				this.chatOrder.push(chatId);
			} else {
				this.chatQueues.delete(chatId);
			}
			return next;
		}
		return undefined;
	}

	clear(): number {
		const dropped = this.totalSize;
		this.chatQueues.clear();
		this.chatOrder.length = 0;
		this.totalSize = 0;
		return dropped;
	}
}

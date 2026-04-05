import { describe, expect, it } from "vitest";
import { UnifiedExecManager } from "../src/core/unified-exec.js";

describe("UnifiedExecManager", () => {
	it("returns completed output for short commands", async () => {
		const manager = new UnifiedExecManager();
		try {
			const result = await manager.execCommand({
				command: "printf 'hello\\n'",
				yieldTimeMs: 300,
			});
			expect(result.running).toBe(false);
			expect(result.sessionId).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("hello");
		} finally {
			manager.dispose();
		}
	});

	it("supports resumable stdin writes for long-running commands", async () => {
		const manager = new UnifiedExecManager();
		try {
			const first = await manager.execCommand({
				command: "read line; printf 'got:%s\\n' \"$line\"",
				yieldTimeMs: 200,
			});

			expect(first.running).toBe(true);
			expect(typeof first.sessionId).toBe("number");

			const second = await manager.writeStdin({
				sessionId: first.sessionId!,
				chars: "world\n",
				yieldTimeMs: 1000,
			});
			expect(second.running).toBe(false);
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("got:world");
		} finally {
			manager.dispose();
		}
	});

	it("throws on unknown session ids", async () => {
		const manager = new UnifiedExecManager();
		try {
			await expect(
				manager.writeStdin({
					sessionId: 424242,
					chars: "noop\n",
				}),
			).rejects.toThrow(/session not found/i);
		} finally {
			manager.dispose();
		}
	});

	it("supports tty exec sessions when available", async () => {
		if (process.platform === "win32") {
			return;
		}
		const manager = new UnifiedExecManager();
		try {
			const first = await manager.execCommand({
				command: "read line; printf 'tty:%s\\n' \"$line\"",
				tty: true,
				yieldTimeMs: 200,
			});
			expect(first.running).toBe(true);
			expect(typeof first.sessionId).toBe("number");

			const second = await manager.writeStdin({
				sessionId: first.sessionId!,
				chars: "pty-world\n",
				yieldTimeMs: 1500,
			});
			expect(second.running).toBe(false);
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("tty:pty-world");
		} finally {
			manager.dispose();
		}
	});
});

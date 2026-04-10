import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestSession, type TestSessionContext } from "./utilities.js";

describe("agent-session system prompt memoization", () => {
	const contexts: TestSessionContext[] = [];

	afterEach(() => {
		while (contexts.length > 0) {
			contexts.pop()?.cleanup();
		}
	});

	it("reuses system prompt rebuild output for identical signatures", () => {
		const context = createTestSession({ inMemory: true });
		contexts.push(context);
		const { session } = context;
		session.enableSessionTrace();

		session.setSystemPromptSuffix("memoized-suffix");
		session.setSystemPromptSuffix("memoized-suffix");

		const tracePath = session.sessionTracePath;
		expect(typeof tracePath).toBe("string");
		expect(tracePath && existsSync(tracePath)).toBe(true);

		const lines = readFileSync(tracePath!, "utf8")
			.split(/\n+/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const cacheEvents = lines.filter((entry) => entry.type === "system_prompt_rebuild_cache");
		expect(cacheEvents.some((entry) => entry.cache === "miss")).toBe(true);
		expect(cacheEvents.some((entry) => entry.cache === "hit")).toBe(true);
	});
});

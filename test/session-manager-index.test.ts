import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("SessionManager listAll index", () => {
	let root: string;
	let agentDir: string;
	let workspaceDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "iosm-session-index-"));
		agentDir = join(root, "agent");
		workspaceDir = join(root, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("writes and refreshes listAll index when session files change", async () => {
		const session = SessionManager.create(workspaceDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage({ role: "assistant", content: "hi", timestamp: 2 });

		const firstList = await SessionManager.listAll();
		expect(firstList.length).toBeGreaterThan(0);
		const first = firstList.find((item) => item.id === session.getSessionId());
		expect(first).toBeDefined();
		expect(first?.messageCount).toBe(2);

		session.appendMessage({ role: "user", content: "follow-up", timestamp: 3 });
		const secondList = await SessionManager.listAll();
		const second = secondList.find((item) => item.id === session.getSessionId());
		expect(second).toBeDefined();
		expect(second?.messageCount).toBe(3);
		expect(second?.allMessagesText).toContain("follow-up");
	});
});

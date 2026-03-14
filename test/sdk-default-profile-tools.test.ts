import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("createAgentSession default profile tools", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("enables full profile tools by default when --profile is not provided", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
		});

		const active = session.getActiveToolNames();
		expect(active).toContain("semantic_search");
		expect(active).toContain("rg");
		expect(active).toContain("fd");
		expect(active).toContain("ast_grep");
		expect(active).toContain("fetch");
		expect(active).toContain("git_read");
		expect(active).toContain("fs_ops");
	});
});

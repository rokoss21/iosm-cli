import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel, type Message } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm, INTERNAL_UI_META_CUSTOM_TYPE } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession meta orchestration directive", () => {
	let tempDir: string;
	let session: AgentSession;
	let capturedMessages: Message[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-meta-directive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "meta-directive-fixture", private: true }), "utf8");
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		capturedMessages = [];
	});

	function createSession(profileName: "meta" | "full"): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async (_model, context) => {
				capturedMessages = [...context.messages];
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			iosmAutopilotEnabled: false,
			profileName,
		});

		return session;
	}

	it("injects meta orchestration directive for standard meta prompts", async () => {
		createSession("meta");

		await session.prompt("добавь интересную фичу", {
			expandPromptTemplates: false,
		});

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("[META_ORCHESTRATION_DIRECTIVE]"),
				}),
			]),
		);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("multiple top-level `task` calls"),
				}),
			]),
		);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("main emphasis of meta mode is parallelism"),
				}),
			]),
		);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("DO NOT orchestrate and DO NOT call `task`"),
				}),
			]),
		);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("Delegates are `task` calls only"),
				}),
			]),
		);
	});

	it("stores hidden orchestration metadata with a display alias for meta prompts", async () => {
		createSession("meta");

		await session.prompt("добавь интересную фичу", {
			expandPromptTemplates: false,
		});

		const internalMessage = session.messages.find(
			(message) => message.role === "custom" && message.customType === INTERNAL_UI_META_CUSTOM_TYPE,
		);
		expect(internalMessage).toBeDefined();
		expect(internalMessage?.role).toBe("custom");
		if (internalMessage?.role !== "custom") return;

		expect(internalMessage.display).toBe(false);
		expect(internalMessage.details).toMatchObject({
			kind: "orchestration_context",
			displayText: "добавь интересную фичу",
		});
		expect((internalMessage.details as { rawPrompt?: string }).rawPrompt).toContain(
			"[META_ORCHESTRATION_DIRECTIVE]",
		);
	});

	it("does not inject meta directive for full profile", async () => {
		createSession("full");

		await session.prompt("добавь интересную фичу", {
			expandPromptTemplates: false,
		});

		expect(capturedMessages).toHaveLength(1);
		const textParts =
			capturedMessages[0]?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text) ?? [];
		expect(textParts.join("\n")).not.toContain("[META_ORCHESTRATION_DIRECTIVE]");
	});

	it("skips meta directive when orchestration injection is disabled", async () => {
		createSession("meta");

		await session.prompt("добавь интересную фичу", {
			expandPromptTemplates: false,
			skipOrchestrationDirective: true,
		});

		expect(capturedMessages).toHaveLength(1);
		const textParts =
			capturedMessages[0]?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text) ?? [];
		expect(textParts.join("\n")).not.toContain("[META_ORCHESTRATION_DIRECTIVE]");
	});

	it("applies meta directive after runtime profile switch", async () => {
		createSession("full");
		session.setProfileName("meta");

		await session.prompt("добавь интересную фичу", {
			expandPromptTemplates: false,
		});

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("[META_ORCHESTRATION_DIRECTIVE]"),
				}),
			]),
		);
	});

	it("parses explicit orchestrate contracts with single-quoted attributes", async () => {
		createSession("full");
		const contractText = [
			"<orchestrate mode='parallel' agents='2' max_parallel='2'>",
			"- agent 1: profile=explore cwd=/tmp/a",
			"- agent 2: profile=plan cwd=/tmp/b",
			"task: audit codebase",
			"</orchestrate>",
		].join("\n");

		await session.prompt(contractText, {
			expandPromptTemplates: false,
		});

		expect(capturedMessages).toHaveLength(1);
		const textParts =
			capturedMessages[0]?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text) ?? [];
		const merged = textParts.join("\n");
		expect(merged).toContain("[ORCHESTRATION_DIRECTIVE]");
		expect(merged).toContain("Execution mode: parallel.");
		expect(merged).toContain("Requested subagent count: 2.");
		expect(merged).toContain("Max parallel workers: 2.");
	});
});

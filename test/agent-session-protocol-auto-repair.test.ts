import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel, type Message } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
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

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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

function extractUserText(message: Message): string {
	if (message.role !== "user") return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("AgentSession prompt protocol auto-repair", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-protocol-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "protocol-repair-fixture", private: true }), "utf8");
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("auto-repairs one prompt when assistant emits pseudo tool markup in thinking", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;
		const promptTexts: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async (_model, context) => {
				streamCalls += 1;
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				promptTexts.push(lastUser ? extractUserText(lastUser) : "");

				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage([]) });
					if (streamCalls === 1) {
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([
								{
									type: "thinking",
									thinking:
										"<tool_call>\n<function=db_run>\n<parameter=action>query</parameter>\n<parameter=statement>SELECT 1</parameter>\n</function>\n</tool_call>",
								} as unknown as AssistantMessage["content"][number],
							]),
						});
						return;
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "done" }]),
					});
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
		});

		await session.prompt("проверь db", { skipIosmAutopilot: true });

		expect(streamCalls).toBe(2);
		expect(promptTexts[0]).toContain("проверь db");
		expect(promptTexts[1]).toContain("[TOOL_PROTOCOL_CORRECTION]");
		expect(promptTexts[1]).toContain("<original_user_request>");
		expect(promptTexts[1]).toContain("проверь db");
	});

	it("does not auto-repair for inline explanatory pseudo-call mentions in plain text", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;
		const promptTexts: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async (_model, context) => {
				streamCalls += 1;
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				promptTexts.push(lastUser ? extractUserText(lastUser) : "");

				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage([]) });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([
							{
								type: "text",
								text: "Причина: raw <tool_call>/<function=...> markup в прошлой попытке. Сейчас продолжаю нормально.",
							},
						]),
					});
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
		});

		await session.prompt("объясни причину", { skipIosmAutopilot: true });

		expect(streamCalls).toBe(1);
		expect(promptTexts).toHaveLength(1);
	});

	it("auto-repairs one prompt when assistant silently stops with empty output", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;
		const promptTexts: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async (_model, context) => {
				streamCalls += 1;
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				promptTexts.push(lastUser ? extractUserText(lastUser) : "");

					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: createAssistantMessage([]) });
						if (streamCalls === 1) {
							stream.push({
								type: "done",
								reason: "stop",
								message: createAssistantMessage([
									{
										type: "thinking",
										thinking: "Продолжаю работу",
									} as unknown as AssistantMessage["content"][number],
								]),
							});
							return;
						}
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "recovered" }]),
					});
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
		});

		await session.prompt("продолжай", { skipIosmAutopilot: true });

		expect(streamCalls).toBe(2);
		expect(promptTexts[0]).toContain("продолжай");
		expect(promptTexts[1]).toContain("[ASSISTANT_STALL_RECOVERY]");
		expect(promptTexts[1]).toContain("<original_user_request>");
		expect(promptTexts[1]).toContain("продолжай");
	});

	it("auto-repairs again when first correction still ends with silent stop", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;
		const promptTexts: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async (_model, context) => {
				streamCalls += 1;
				const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
				promptTexts.push(lastUser ? extractUserText(lastUser) : "");

				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage([]) });
					if (streamCalls === 1) {
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([
								{
									type: "thinking",
									thinking:
										"<tool_call>\n<function=db_run>\n<parameter=action>query</parameter>\n<parameter=statement>SELECT 1</parameter>\n</function>\n</tool_call>",
								} as unknown as AssistantMessage["content"][number],
							]),
						});
						return;
					}
					if (streamCalls === 2) {
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([
								{
									type: "thinking",
									thinking: "[Output truncated.",
								} as unknown as AssistantMessage["content"][number],
							]),
						});
						return;
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "final-ok" }]),
					});
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
		});

		await session.prompt("продолжай глубже", { skipIosmAutopilot: true });

		expect(streamCalls).toBe(3);
		expect(promptTexts[1]).toContain("[TOOL_PROTOCOL_CORRECTION]");
		expect(promptTexts[2]).toContain("[ASSISTANT_STALL_RECOVERY]");
		expect(promptTexts[2]).toContain("продолжай глубже");
	});

	it("does not auto-repair when skipProtocolAutoRepair is set", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let streamCalls = 0;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async () => {
				streamCalls += 1;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage([]) });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([
							{
								type: "thinking",
								thinking:
									"<tool_call>\n<function=db_run>\n<parameter=action>query</parameter>\n<parameter=statement>SELECT 1</parameter>\n</function>\n</tool_call>",
							} as unknown as AssistantMessage["content"][number],
						]),
					});
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
		});

		await session.prompt("проверь db", {
			skipIosmAutopilot: true,
			skipProtocolAutoRepair: true,
		});

		expect(streamCalls).toBe(1);
	});

	it("applies additive system prompt per turn without leaking into the next prompt", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const seenSystemPrompts: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage([]) });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage([{ type: "text", text: "ok" }]),
					});
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
		});

		const sessionWithRunner = session as unknown as {
			_extensionRunner?: {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: { type: string }) => Promise<void>;
				emitInput: (
					text: string,
					images: unknown,
					source: "interactive" | "rpc" | "extension",
				) => Promise<{ action: "continue" }>;
				emitBeforeAgentStart: (prompt: string, images: unknown, systemPrompt: string) => Promise<undefined>;
			};
		};
		sessionWithRunner._extensionRunner = {
			hasHandlers: () => false,
			emit: async () => {},
			emitInput: async () => ({ action: "continue" }),
			emitBeforeAgentStart: async (_prompt, _images, systemPrompt) => {
				seenSystemPrompts.push(systemPrompt);
				return undefined;
			},
		};

		await session.prompt("turn 1", {
			skipIosmAutopilot: true,
			additiveSystemPrompt: "<runtime_agent_context agent=\"security_auditor\">Overlay</runtime_agent_context>",
		});
		await session.prompt("turn 2", { skipIosmAutopilot: true });

		expect(seenSystemPrompts).toHaveLength(2);
		expect(seenSystemPrompts[0]).toContain("<runtime_agent_context agent=\"security_auditor\">");
		expect(seenSystemPrompts[1]).not.toContain("<runtime_agent_context agent=\"security_auditor\">");
	});
});

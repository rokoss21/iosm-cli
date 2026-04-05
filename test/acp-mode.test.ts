import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { runAcpMode } from "../src/modes/acp/acp-mode.js";

type JsonRpcMessage = Record<string, unknown>;

interface AcpHarness {
	send: (message: JsonRpcMessage) => void;
	waitFor: (predicate: (message: JsonRpcMessage) => boolean, timeoutMs?: number) => Promise<JsonRpcMessage>;
	waitForExit: () => Promise<void>;
	stop: () => Promise<void>;
}

function createSessionStub(
	overrides: Partial<{
		prompt: AgentSession["prompt"];
	}> = {},
): AgentSession {
	const settingsManager = {
		getPermissionMode: () => "ask" as const,
		getPermissionDenyRules: () => [] as string[],
		getPermissionAllowRules: () => [] as string[],
		getPermissionExtensionToolEnforcement: () => false,
	};

	const stub: Partial<AgentSession> = {
		settingsManager: settingsManager as AgentSession["settingsManager"],
		sessionId: "acp-test-session",
		sessionFile: "/tmp/acp-test-session.jsonl",
		model: null,
		thinkingLevel: "off",
		isStreaming: false,
		setToolPermissionHandler: () => {},
		subscribe: () => () => {},
		prompt: overrides.prompt ?? (async () => {}),
		steer: async () => {},
		followUp: async () => {},
		abort: async () => {},
	};
	return stub as AgentSession;
}

async function startHarness(session: AgentSession): Promise<AcpHarness> {
	const input = new PassThrough();
	const outputMessages: JsonRpcMessage[] = [];
	let exited = false;
	let resolveExit!: () => void;
	const exitPromise = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});

	void runAcpMode(session, {
		io: {
			input,
			output: (message) => {
				outputMessages.push(message as JsonRpcMessage);
			},
			onProcessExit: () => {},
			requestExit: () => {
				if (exited) return;
				exited = true;
				resolveExit();
			},
		},
	});

	const waitFor = async (
		predicate: (message: JsonRpcMessage) => boolean,
		timeoutMs = 2_000,
	): Promise<JsonRpcMessage> => {
		const start = Date.now();
		while (Date.now() - start <= timeoutMs) {
			const hit = outputMessages.find(predicate);
			if (hit) return hit;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Timed out waiting for ACP output");
	};

	const send = (message: JsonRpcMessage): void => {
		input.write(`${JSON.stringify(message)}\n`);
	};

	const stop = async (): Promise<void> => {
		if (!exited) {
			send({ jsonrpc: "2.0", id: "shutdown", method: "acp.shutdown" });
			await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
		}
		input.end();
	};

	return {
		send,
		waitFor,
		waitForExit: () => exitPromise,
		stop,
	};
}

describe("ACP mode protocol", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0, cleanups.length)) {
			await cleanup();
		}
	});

	it("returns handshake capabilities and acknowledges shutdown before exit", async () => {
		const harness = await startHarness(createSessionStub());
		cleanups.push(() => harness.stop());

		harness.send({ jsonrpc: "2.0", id: 1, method: "acp.handshake" });
		const handshake = await harness.waitFor((message) => message.id === 1);
		expect(handshake.result).toMatchObject({
			protocolVersion: "1.0",
			capabilities: {
				execSessions: true,
				backCompatRpc: true,
			},
		});

		harness.send({ jsonrpc: "2.0", id: 2, method: "acp.shutdown" });
		const shutdownAck = await harness.waitFor((message) => message.id === 2);
		expect(shutdownAck.result).toEqual({ ok: true });
		await harness.waitForExit();
	});

	it("emits acp.event error when acp.session.prompt fails asynchronously", async () => {
		const harness = await startHarness(
			createSessionStub({
				prompt: async () => {
					throw new Error("simulated prompt failure");
				},
			}),
		);
		cleanups.push(() => harness.stop());

		harness.send({
			jsonrpc: "2.0",
			id: "prompt-1",
			method: "acp.session.prompt",
			params: { message: "hello" },
		});

		const promptAck = await harness.waitFor((message) => message.id === "prompt-1");
		expect(promptAck.result).toEqual({ accepted: true });

		const errorEvent = await harness.waitFor(
			(message) =>
				message.method === "acp.event" &&
				(message.params as Record<string, unknown>)?.source === "acp.session.prompt" &&
				(message.params as Record<string, unknown>)?.type === "error",
		);
		const params = errorEvent.params as Record<string, unknown>;
		expect(params.message).toContain("simulated prompt failure");
	});

	it("supports acp.exec.command and validates invalid params", async () => {
		const harness = await startHarness(createSessionStub());
		cleanups.push(() => harness.stop());

		harness.send({
			jsonrpc: "2.0",
			id: "exec-ok",
			method: "acp.exec.command",
			params: { command: "printf hello" },
		});
		const execResult = await harness.waitFor((message) => message.id === "exec-ok");
		expect(execResult.result).toMatchObject({
			running: false,
		});
		const execPayload = execResult.result as Record<string, unknown>;
		expect(String(execPayload.output)).toContain("hello");

		if (process.platform !== "win32") {
			harness.send({
				jsonrpc: "2.0",
				id: "exec-tty",
				method: "acp.exec.command",
				params: { command: "printf tty", tty: true },
			});
			const execTtyResult = await harness.waitFor((message) => message.id === "exec-tty");
			expect(execTtyResult.result).toMatchObject({ running: false });
		}

		harness.send({
			jsonrpc: "2.0",
			id: "exec-bad",
			method: "acp.exec.command",
			params: {},
		});
		const execError = await harness.waitFor((message) => message.id === "exec-bad");
		expect(execError.error).toMatchObject({
			code: -32602,
		});
	});
});

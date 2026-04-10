import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolPermissionRequest } from "../src/core/tools/permissions.js";
import { createTestSession, type TestSessionContext } from "./utilities.js";

interface ProcessAgentEventHarness {
	_processAgentEvent: (event: unknown) => Promise<void>;
}

interface ToolPermissionHarness extends ProcessAgentEventHarness {
	_evaluateToolPermission: (request: ToolPermissionRequest) => Promise<boolean>;
}

describe("agent-session runtime guard telemetry", () => {
	const contexts: TestSessionContext[] = [];

	afterEach(() => {
		while (contexts.length > 0) {
			contexts.pop()?.cleanup();
		}
	});

	it("emits read-loop and edit-chain warnings with per-turn reset", async () => {
		const context = createTestSession({ inMemory: true });
		contexts.push(context);
		const { session } = context;
		session.enableSessionTrace();

		const processEvent = (session as unknown as ProcessAgentEventHarness)._processAgentEvent.bind(session);

		await processEvent({ type: "turn_start" });
		for (let i = 0; i < 4; i += 1) {
			await processEvent({
				type: "tool_execution_start",
				toolCallId: `read-a-${i}`,
				toolName: "read",
				args: { path: "src/core/agent-session.ts" },
			});
		}
		for (let i = 0; i < 6; i += 1) {
			await processEvent({
				type: "tool_execution_start",
				toolCallId: `edit-a-${i}`,
				toolName: "edit",
				args: { path: "README.md" },
			});
		}

		await processEvent({ type: "turn_start" });
		for (let i = 0; i < 4; i += 1) {
			await processEvent({
				type: "tool_execution_start",
				toolCallId: `read-b-${i}`,
				toolName: "read",
				args: { path: "src/core/agent-session.ts" },
			});
		}

		const tracePath = session.sessionTracePath;
		expect(typeof tracePath).toBe("string");
		expect(tracePath && existsSync(tracePath)).toBe(true);

		const entries = readFileSync(tracePath!, "utf8")
			.split(/\n+/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		const warnings = entries.filter((entry) => entry.type === "runtime_guard_warning");
		const readWarnings = warnings.filter((entry) => entry.guard === "read_loop");
		const editWarnings = warnings.filter((entry) => entry.guard === "edit_chain");

		expect(readWarnings).toHaveLength(2);
		expect(readWarnings.every((entry) => entry.readsForPath === 4)).toBe(true);
		expect(readWarnings.every((entry) => typeof entry.path === "string")).toBe(true);

		expect(editWarnings).toHaveLength(1);
		expect(editWarnings[0]?.mutatingEditCalls).toBe(6);
	});

	it("emits write-over-large-existing-file warning once per path per turn", async () => {
		const context = createTestSession({ inMemory: true });
		contexts.push(context);
		const { session, tempDir } = context;
		session.enableSessionTrace();

		const processEvent = (session as unknown as ProcessAgentEventHarness)._processAgentEvent.bind(session);
		const relativePath = "tmp/large-existing.ts";
		const absolutePath = `${tempDir}/${relativePath}`;
		const existing = Array.from({ length: 260 }, (_, idx) => `const line_${idx} = ${idx};`).join("\n");
		mkdirSync(`${tempDir}/tmp`, { recursive: true });
		writeFileSync(absolutePath, existing, "utf8");

		await processEvent({ type: "turn_start" });
		await processEvent({
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			args: { path: relativePath, content: `${existing}\n// changed` },
		});
		await processEvent({
			type: "tool_execution_start",
			toolCallId: "write-2",
			toolName: "write",
			args: { path: relativePath, content: `${existing}\n// changed again` },
		});

		const tracePath = session.sessionTracePath;
		expect(typeof tracePath).toBe("string");
		expect(tracePath && existsSync(tracePath)).toBe(true);

		const entries = readFileSync(tracePath!, "utf8")
			.split(/\n+/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		const writeWarnings = entries.filter(
			(entry) => entry.type === "runtime_guard_warning" && entry.guard === "write_over_large_existing_file",
		);
		expect(writeWarnings).toHaveLength(1);
		expect(writeWarnings[0]?.path).toBe(absolutePath.replace(/\\/g, "/"));
		expect((writeWarnings[0]?.existingLineCount as number | undefined) ?? 0).toBeGreaterThanOrEqual(200);
	});

	it("warns (but allows) mutate calls without prior read when guard mode is warn", async () => {
		const context = createTestSession({
			inMemory: true,
			settingsOverrides: {
				executionGuards: {
					readBeforeMutateMode: "warn",
				},
			},
		});
		contexts.push(context);
		const { session } = context;
		session.enableSessionTrace();
		const harness = session as unknown as ToolPermissionHarness;

		const allowed = await harness._evaluateToolPermission({
			toolName: "edit",
			cwd: context.tempDir,
			input: { path: "src/example.ts", oldTextLength: 3, newTextLength: 4 },
			summary: "src/example.ts",
		});
		expect(allowed).toBe(true);

		const entries = readFileSync(session.sessionTracePath!, "utf8")
			.split(/\n+/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const warnings = entries.filter(
			(entry) => entry.type === "runtime_guard_warning" && entry.guard === "read_before_mutate",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.mode).toBe("warn");
	});

	it("enforces read-before-mutate in enforce mode and allows after read", async () => {
		const context = createTestSession({
			inMemory: true,
			settingsOverrides: {
				executionGuards: {
					readBeforeMutateMode: "enforce",
				},
			},
		});
		contexts.push(context);
		const { session } = context;
		const harness = session as unknown as ToolPermissionHarness;

		await expect(
			harness._evaluateToolPermission({
				toolName: "edit",
				cwd: context.tempDir,
				input: { path: "src/example.ts", oldTextLength: 3, newTextLength: 4 },
				summary: "src/example.ts",
			}),
		).rejects.toThrow(/Read-before-mutate guard blocked edit/i);

		await harness._processAgentEvent({ type: "turn_start" });
		await harness._processAgentEvent({
			type: "tool_execution_start",
			toolCallId: "read-before-edit",
			toolName: "read",
			args: { path: "src/example.ts" },
		});

		await expect(
			harness._evaluateToolPermission({
				toolName: "edit",
				cwd: context.tempDir,
				input: { path: "src/example.ts", oldTextLength: 3, newTextLength: 4 },
				summary: "src/example.ts",
			}),
		).resolves.toBe(true);
	});

	it("enforces repeated-failure loop breaker for identical tool input", async () => {
		const context = createTestSession({
			inMemory: true,
			settingsOverrides: {
				executionGuards: {
					repeatedFailureMode: "enforce",
					repeatedFailureLimit: 2,
				},
			},
		});
		contexts.push(context);
		const { session } = context;
		const harness = session as unknown as ToolPermissionHarness;
		await harness._processAgentEvent({ type: "turn_start" });

		for (let attempt = 1; attempt <= 2; attempt += 1) {
			await harness._processAgentEvent({
				type: "tool_execution_start",
				toolCallId: `bash-fail-${attempt}`,
				toolName: "bash",
				args: { command: "npm test", timeout: 30000, run_in_background: false },
			});
			await harness._processAgentEvent({
				type: "tool_execution_end",
				toolCallId: `bash-fail-${attempt}`,
				toolName: "bash",
				result: { content: [{ type: "text", text: "failed" }] },
				isError: true,
			});
		}

		await expect(
			harness._evaluateToolPermission({
				toolName: "bash",
				cwd: context.tempDir,
				input: { command: "npm test", timeout: 30000, run_in_background: false },
				summary: "npm test",
			}),
		).rejects.toThrow(/Repeated-failure guard blocked bash/i);
	});

	it("emits bash misroute warning when specialized tools are active", async () => {
		const context = createTestSession({
			inMemory: true,
			settingsOverrides: {
				executionGuards: {
					misrouteMode: "warn",
				},
			},
		});
		contexts.push(context);
		const { session } = context;
		session.enableSessionTrace();
		const harness = session as unknown as ToolPermissionHarness;
		await harness._processAgentEvent({ type: "turn_start" });
		await harness._processAgentEvent({
			type: "tool_execution_start",
			toolCallId: "bash-cat-1",
			toolName: "bash",
			args: { command: "cat README.md" },
		});

		const entries = readFileSync(session.sessionTracePath!, "utf8")
			.split(/\n+/)
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const warnings = entries.filter(
			(entry) => entry.type === "runtime_guard_warning" && entry.guard === "misroute_tool_selection",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.preferredTool).toBe("read");
		expect(warnings[0]?.command).toBe("cat");
	});
});

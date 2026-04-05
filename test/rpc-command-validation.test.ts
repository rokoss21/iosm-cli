import { describe, expect, it } from "vitest";
import { validateRpcCommand } from "../src/modes/rpc/rpc-mode.js";

describe("rpc command validation", () => {
	it("rejects non-string exec_command cwd", () => {
		const err = validateRpcCommand({
			type: "exec_command",
			command: "echo hello",
			cwd: 42,
		});
		expect(err).toContain('expects "cwd" to be a string');
	});

	it("rejects non-string write_stdin chars", () => {
		const err = validateRpcCommand({
			type: "write_stdin",
			sessionId: 1,
			chars: 123,
		});
		expect(err).toContain('expects "chars" to be a string');
	});

	it("accepts valid optional string fields", () => {
		const execErr = validateRpcCommand({
			type: "exec_command",
			command: "echo hello",
			cwd: "/tmp",
			shell: "/bin/zsh",
		});
		const stdinErr = validateRpcCommand({
			type: "write_stdin",
			sessionId: 1,
			chars: "q",
		});
		expect(execErr).toBeUndefined();
		expect(stdinErr).toBeUndefined();
	});

	it("rejects non-boolean exec_command tty", () => {
		const err = validateRpcCommand({
			type: "exec_command",
			command: "echo hello",
			tty: "yes",
		});
		expect(err).toContain('expects "tty" to be a boolean');
	});

	it("validates request_permissions scope", () => {
		const invalid = validateRpcCommand({
			type: "request_permissions",
			request: {
				toolName: "bash",
				cwd: "/tmp",
				input: {},
				summary: "echo hi",
			},
			scope: "forever",
		});
		expect(invalid).toContain('expects "scope" to be one of');

		const valid = validateRpcCommand({
			type: "request_permissions",
			request: {
				toolName: "bash",
				cwd: "/tmp",
				input: {},
				summary: "echo hi",
			},
			scope: "turn",
		});
		expect(valid).toBeUndefined();
	});
});

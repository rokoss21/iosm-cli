import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import stripAnsi from "strip-ansi";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../utils/shell.js";

const DEFAULT_YIELD_TIME_MS = 1000;
const MAX_YIELD_TIME_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const MAX_OUTPUT_CHARS = 250_000;
const MAX_PENDING_OUTPUT_CHARS = 1_000_000;
const FINISHED_SESSION_TTL_MS = 5 * 60_000;
const EXIT_GRACE_TIME_MS = 75;
const DEFAULT_PTY_BRIDGE_BIN = "python3";

const PYTHON_PTY_BRIDGE_SCRIPT = String.raw`import os
import pty
import select
import subprocess
import sys

if len(sys.argv) < 2:
	print("pty bridge requires shell command arguments", file=sys.stderr)
	sys.exit(2)

command = sys.argv[1:]
master_fd, slave_fd = pty.openpty()
child = subprocess.Popen(command, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd)
os.close(slave_fd)

stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()
stdin_open = True

while True:
	readers = [master_fd]
	if stdin_open:
		readers.append(stdin_fd)
	readable, _, _ = select.select(readers, [], [], 0.05)

	if master_fd in readable:
		try:
			chunk = os.read(master_fd, 4096)
		except OSError:
			chunk = b""
		if chunk:
			os.write(stdout_fd, chunk)

	if stdin_open and stdin_fd in readable:
		input_chunk = os.read(stdin_fd, 4096)
		if input_chunk:
			os.write(master_fd, input_chunk)
		else:
			stdin_open = False

	if child.poll() is not None:
		while True:
			try:
				chunk = os.read(master_fd, 4096)
			except OSError:
				chunk = b""
			if not chunk:
				break
			os.write(stdout_fd, chunk)
		break

sys.exit(child.returncode if child.returncode is not None else 0)`;

export interface UnifiedExecRunInput {
	command: string;
	cwd?: string;
	tty?: boolean;
	shell?: string;
	login?: boolean;
	yieldTimeMs?: number;
	maxOutputChars?: number;
}

export interface UnifiedExecWriteInput {
	sessionId: number;
	chars?: string;
	yieldTimeMs?: number;
	maxOutputChars?: number;
}

export interface UnifiedExecPollResult {
	output: string;
	running: boolean;
	sessionId?: number;
	exitCode?: number | null;
}

interface UnifiedExecSession {
	id: number;
	child: ChildProcess;
	usesPty: boolean;
	pendingOutput: string[];
	pendingChars: number;
	running: boolean;
	exitCode: number | null;
	waiters: Set<() => void>;
	cleanupTimer?: NodeJS.Timeout;
}

function normalizeYieldTimeMs(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_YIELD_TIME_MS;
	return Math.max(0, Math.min(MAX_YIELD_TIME_MS, Math.floor(value)));
}

function normalizeMaxOutputChars(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_MAX_OUTPUT_CHARS;
	return Math.max(1, Math.min(MAX_OUTPUT_CHARS, Math.floor(value)));
}

export class UnifiedExecManager {
	private sessions = new Map<number, UnifiedExecSession>();
	private nextSessionId = 1;

	async execCommand(input: UnifiedExecRunInput): Promise<UnifiedExecPollResult> {
		const command = input.command?.trim();
		if (!command) {
			throw new Error("exec_command requires a non-empty command.");
		}

		const session = this.createSession(command, input);
		await this.waitForUpdate(session, normalizeYieldTimeMs(input.yieldTimeMs));
		await this.waitForExitGrace(session);
		return this.buildPollResult(session, normalizeMaxOutputChars(input.maxOutputChars));
	}

	async writeStdin(input: UnifiedExecWriteInput): Promise<UnifiedExecPollResult> {
		const session = this.sessions.get(input.sessionId);
		if (!session) {
			throw new Error(`exec session not found: ${input.sessionId}`);
		}

		if (input.chars && session.running) {
			try {
				session.child.stdin?.write(input.chars);
			} catch (error) {
				throw new Error(`Failed to write to exec session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		await this.waitForUpdate(session, normalizeYieldTimeMs(input.yieldTimeMs));
		await this.waitForExitGrace(session);
		return this.buildPollResult(session, normalizeMaxOutputChars(input.maxOutputChars));
	}

	dispose(): void {
		for (const session of this.sessions.values()) {
			if (session.cleanupTimer) {
				clearTimeout(session.cleanupTimer);
				session.cleanupTimer = undefined;
			}
			if (session.running && session.child.pid) {
				killProcessTree(session.child.pid);
			}
			session.waiters.clear();
		}
		this.sessions.clear();
	}

	private createSession(command: string, input: UnifiedExecRunInput): UnifiedExecSession {
		const invocation = this.resolveInvocation(command, input);
		const child = spawn(invocation.command, invocation.args, {
			cwd: input.cwd ? resolve(input.cwd) : undefined,
			env: getShellEnv(),
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const session: UnifiedExecSession = {
			id: this.nextSessionId++,
			child,
			usesPty: invocation.usesPty,
			pendingOutput: [],
			pendingChars: 0,
			running: true,
			exitCode: null,
			waiters: new Set(),
		};
		this.sessions.set(session.id, session);

		const stdoutDecoder = new TextDecoder();
		const stderrDecoder = new TextDecoder();
		const pushOutput = (raw: Buffer, decoder: InstanceType<typeof TextDecoder>): void => {
			let text = sanitizeBinaryOutput(stripAnsi(decoder.decode(raw, { stream: true }))).replace(/\r/g, "");
			if (session.usesPty) {
				text = text.replace(/\^D\x08\x08/g, "");
			}
			if (!text) return;
			this.appendOutput(session, text);
		};

		child.stdout?.on("data", (raw: Buffer) => pushOutput(raw, stdoutDecoder));
		child.stderr?.on("data", (raw: Buffer) => pushOutput(raw, stderrDecoder));
		child.on("error", (error) => {
			this.appendOutput(session, `\n[exec error] ${error.message}\n`);
		});
		child.on("close", (code) => {
			session.running = false;
			session.exitCode = code ?? null;
			this.notify(session);
			session.cleanupTimer = setTimeout(() => {
				this.sessions.delete(session.id);
			}, FINISHED_SESSION_TTL_MS);
			session.cleanupTimer.unref();
		});

		return session;
	}

	private appendOutput(session: UnifiedExecSession, chunk: string): void {
		session.pendingOutput.push(chunk);
		session.pendingChars += chunk.length;
		while (session.pendingChars > MAX_PENDING_OUTPUT_CHARS && session.pendingOutput.length > 1) {
			const removed = session.pendingOutput.shift();
			if (!removed) break;
			session.pendingChars -= removed.length;
		}
		this.notify(session);
	}

	private notify(session: UnifiedExecSession): void {
		if (session.waiters.size === 0) return;
		const waiters = Array.from(session.waiters);
		session.waiters.clear();
		for (const resolveWaiter of waiters) {
			resolveWaiter();
		}
	}

	private async waitForUpdate(session: UnifiedExecSession, timeoutMs: number): Promise<void> {
		if (!session.running || session.pendingChars > 0 || timeoutMs <= 0) {
			return;
		}
		await new Promise<void>((resolveWait) => {
			const onUpdate = () => {
				if (timer) clearTimeout(timer);
				resolveWait();
			};
			const timer = setTimeout(() => {
				session.waiters.delete(onUpdate);
				resolveWait();
			}, timeoutMs);
			session.waiters.add(onUpdate);
		});
	}

	private async waitForExitGrace(session: UnifiedExecSession): Promise<void> {
		if (!session.running) return;
		await this.waitForClose(session, EXIT_GRACE_TIME_MS);
	}

	private async waitForClose(session: UnifiedExecSession, timeoutMs: number): Promise<void> {
		if (!session.running || timeoutMs <= 0) return;
		await new Promise<void>((resolveWait) => {
			const onUpdate = () => {
				if (!session.running) {
					if (timer) clearTimeout(timer);
					session.waiters.delete(onUpdate);
					resolveWait();
				}
			};
			const timer = setTimeout(() => {
				session.waiters.delete(onUpdate);
				resolveWait();
			}, timeoutMs);
			session.waiters.add(onUpdate);
		});
	}

	private drainOutput(session: UnifiedExecSession, maxOutputChars: number): string {
		const combined = session.pendingOutput.join("");
		session.pendingOutput = [];
		session.pendingChars = 0;
		if (combined.length <= maxOutputChars) return combined;
		return combined.slice(combined.length - maxOutputChars);
	}

	private buildPollResult(session: UnifiedExecSession, maxOutputChars: number): UnifiedExecPollResult {
		const output = this.drainOutput(session, maxOutputChars);
		if (session.running) {
			return {
				output,
				running: true,
				sessionId: session.id,
			};
		}
		if (session.cleanupTimer) {
			clearTimeout(session.cleanupTimer);
			session.cleanupTimer = undefined;
		}
		this.sessions.delete(session.id);
		return {
			output,
			running: false,
			exitCode: session.exitCode,
		};
	}

	private resolveInvocation(
		command: string,
		input: UnifiedExecRunInput,
	): { command: string; args: string[]; usesPty: boolean } {
		const shellConfig = getShellConfig();
		const shell = typeof input.shell === "string" && input.shell.trim().length > 0 ? input.shell.trim() : shellConfig.shell;
		const shellArgs = this.buildShellArgs(command, input.login, shellConfig.args);

		if (!input.tty) {
			return {
				command: shell,
				args: shellArgs,
				usesPty: false,
			};
		}

		if (process.platform === "win32") {
			throw new Error("exec_command tty=true is not supported on Windows.");
		}

		const ptyBridgeBin = process.env.IOSM_EXEC_PTY_BRIDGE_BIN?.trim() || DEFAULT_PTY_BRIDGE_BIN;
		return {
			command: ptyBridgeBin,
			args: ["-u", "-c", PYTHON_PTY_BRIDGE_SCRIPT, shell, ...shellArgs],
			usesPty: true,
		};
	}

	private buildShellArgs(command: string, login: boolean | undefined, defaultArgs: string[]): string[] {
		if (login === true) {
			return ["-l", "-c", command];
		}
		if (login === false) {
			return ["-c", command];
		}
		return [...defaultArgs, command];
	}
}

import { spawn, spawnSync } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

const gitReadSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("blame")],
		{ description: "Git action: status | diff | log | blame." },
	),
	path: Type.Optional(Type.String({ description: "Repository working directory (default: current directory)." })),
	file: Type.Optional(Type.String({ description: "Optional file path for diff/log, required for blame." })),
	base: Type.Optional(Type.String({ description: "Optional base ref/commit for diff." })),
	head: Type.Optional(Type.String({ description: "Optional head ref/commit for diff (requires base)." })),
	staged: Type.Optional(Type.Boolean({ description: "For diff action: compare staged changes." })),
	context: Type.Optional(Type.Number({ description: "For diff action: unified context lines (default: 3)." })),
	porcelain: Type.Optional(
		Type.Boolean({
			description: "For status action: use short porcelain format with branch (default: true).",
		}),
	),
	untracked: Type.Optional(Type.Boolean({ description: "For status action: include untracked files (default: true)." })),
	limit: Type.Optional(Type.Number({ description: "For log action: max entries (default: 20, max: 200)." })),
	since: Type.Optional(Type.String({ description: "For log action: git --since value (e.g. '2 weeks ago')." })),
	ref: Type.Optional(Type.String({ description: "For blame action: optional ref/commit." })),
	line_start: Type.Optional(Type.Number({ description: "For blame action: range start line (1-indexed)." })),
	line_end: Type.Optional(Type.Number({ description: "For blame action: range end line (1-indexed)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)." })),
});

export type GitReadToolInput = Static<typeof gitReadSchema>;

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 200;
const MAX_CAPTURE_BYTES = 512 * 1024;

interface RunCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	captureTruncated: boolean;
}

export interface GitReadToolDetails {
	action: "status" | "diff" | "log" | "blame";
	command: string;
	args: string[];
	cwd: string;
	exitCode: number;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

export interface GitReadToolOptions {
	commandExists?: (command: string) => boolean;
	runCommand?: (
		args: string[],
		cwd: string,
		timeoutMs: number,
		signal?: AbortSignal,
	) => Promise<RunCommandResult>;
}

function commandExists(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "pipe" });
		const err = result.error as NodeJS.ErrnoException | undefined;
		return !err || err.code !== "ENOENT";
	} catch {
		return false;
	}
}

function normalizePositiveInt(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive number.`);
	}
	return value;
}

function runGitCommand(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RunCommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutChunks: Buffer[] = [];
		let stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let captureTruncated = false;
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		const captureChunk = (
			chunk: Buffer,
			chunks: Buffer[],
			currentBytes: number,
		): { nextBytes: number; truncated: boolean } => {
			if (currentBytes >= MAX_CAPTURE_BYTES) {
				return { nextBytes: currentBytes, truncated: true };
			}
			const remaining = MAX_CAPTURE_BYTES - currentBytes;
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				return { nextBytes: currentBytes + chunk.length, truncated: false };
			}
			chunks.push(chunk.subarray(0, remaining));
			return { nextBytes: MAX_CAPTURE_BYTES, truncated: true };
		};

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, Math.max(1000, timeoutMs));

		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk: Buffer) => {
			const captured = captureChunk(chunk, stdoutChunks, stdoutBytes);
			stdoutBytes = captured.nextBytes;
			captureTruncated = captureTruncated || captured.truncated;
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const captured = captureChunk(chunk, stderrChunks, stderrBytes);
			stderrBytes = captured.nextBytes;
			captureTruncated = captureTruncated || captured.truncated;
		});

		child.on("error", (error) => {
			cleanup();
			settle(() => reject(new Error(`Failed to run git: ${error.message}`)));
		});

		child.on("close", (code) => {
			cleanup();
			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			if (timedOut) {
				settle(() => reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`)));
				return;
			}
			settle(() =>
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? -1,
					captureTruncated,
				}),
			);
		});
	});
}

function buildStatusArgs(input: GitReadToolInput): string[] {
	const porcelain = input.porcelain ?? true;
	const includeUntracked = input.untracked ?? true;
	const args = ["status"];
	if (porcelain) {
		args.push("--short", "--branch");
	}
	if (!includeUntracked) {
		args.push("--untracked-files=no");
	}
	return args;
}

function buildDiffArgs(input: GitReadToolInput): string[] {
	if (input.head && !input.base) {
		throw new Error("git_read diff requires base when head is provided.");
	}
	const context = normalizePositiveInt(input.context, 3, "context");
	const args = ["diff", "--no-color", `--unified=${context}`];
	if (input.staged) {
		args.push("--staged");
	}
	if (input.base && input.head) {
		args.push(`${input.base}..${input.head}`);
	} else if (input.base) {
		args.push(input.base);
	}
	if (input.file) {
		args.push("--", input.file);
	}
	return args;
}

function buildLogArgs(input: GitReadToolInput): string[] {
	const limit = Math.min(MAX_LOG_LIMIT, normalizePositiveInt(input.limit, DEFAULT_LOG_LIMIT, "limit"));
	const args = [
		"log",
		"--no-color",
		`--max-count=${limit}`,
		"--date=iso",
		"--pretty=format:%H%x09%ad%x09%an%x09%s",
	];
	if (input.since) {
		args.push(`--since=${input.since}`);
	}
	if (input.file) {
		args.push("--", input.file);
	}
	return args;
}

function buildBlameArgs(input: GitReadToolInput): string[] {
	if (!input.file) {
		throw new Error("git_read blame requires file.");
	}
	const hasLineStart = input.line_start !== undefined;
	const hasLineEnd = input.line_end !== undefined;
	if (hasLineStart !== hasLineEnd) {
		throw new Error("git_read blame requires both line_start and line_end when specifying a range.");
	}
	const args = ["blame", "--line-porcelain"];
	if (input.ref) {
		args.push(input.ref);
	}
	if (hasLineStart && hasLineEnd) {
		const lineStart = normalizePositiveInt(input.line_start, 1, "line_start");
		const lineEnd = normalizePositiveInt(input.line_end, 1, "line_end");
		if (lineEnd < lineStart) {
			throw new Error("line_end must be greater than or equal to line_start.");
		}
		args.push("-L", `${lineStart},${lineEnd}`);
	}
	args.push("--", input.file);
	return args;
}

function buildGitArgs(input: GitReadToolInput): string[] {
	if (input.action === "status") return buildStatusArgs(input);
	if (input.action === "diff") return buildDiffArgs(input);
	if (input.action === "log") return buildLogArgs(input);
	return buildBlameArgs(input);
}

export function createGitReadTool(cwd: string, options?: GitReadToolOptions): AgentTool<typeof gitReadSchema> {
	const hasCommand = options?.commandExists ?? commandExists;
	const runCommand = options?.runCommand ?? runGitCommand;

	return {
		name: "git_read",
		label: "git_read",
		description:
			"Structured read-only git introspection. Actions: status | diff | log | blame. Uses safe argv execution without shell interpolation.",
		parameters: gitReadSchema,
		execute: async (_toolCallId: string, input: GitReadToolInput, signal?: AbortSignal) => {
			if (!hasCommand("git")) {
				throw new Error("git command is not available.");
			}

			const repoCwd = resolveToCwd(input.path || ".", cwd);
			const args = buildGitArgs(input);
			const timeoutSeconds = normalizePositiveInt(input.timeout, DEFAULT_TIMEOUT_SECONDS, "timeout");
			const result = await runCommand(args, repoCwd, timeoutSeconds * 1000, signal);

			if (result.exitCode !== 0) {
				const errorText =
					result.stderr.trim() || result.stdout.trim() || `git_read ${input.action} failed with exit code ${result.exitCode}`;
				throw new Error(errorText);
			}

			let output = result.stdout.trimEnd();
			if (!output && result.stderr.trim().length > 0) {
				output = result.stderr.trimEnd();
			}
			if (!output) {
				output = "No output";
			}

			const truncation = truncateHead(output);
			let finalOutput = truncation.content;
			const notices: string[] = [];

			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`);
			}
			if (result.captureTruncated) {
				notices.push(`capture limit reached (${formatSize(MAX_CAPTURE_BYTES)})`);
			}
			if (notices.length > 0) {
				finalOutput += `\n\n[${notices.join(". ")} · showing up to ${DEFAULT_MAX_LINES} lines]`;
			}

			const details: GitReadToolDetails = {
				action: input.action,
				command: "git",
				args,
				cwd: repoCwd,
				exitCode: result.exitCode,
				captureTruncated: result.captureTruncated || undefined,
				truncation: truncation.truncated ? truncation : undefined,
			};

			return {
				content: [{ type: "text", text: finalOutput }],
				details,
			};
		},
	};
}

export const gitReadTool = createGitReadTool(process.cwd());

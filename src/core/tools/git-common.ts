import { spawn, spawnSync } from "node:child_process";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

export const DEFAULT_GIT_TIMEOUT_SECONDS = 30;
export const MAX_GIT_CAPTURE_BYTES = 512 * 1024;

export interface RunGitCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	captureTruncated: boolean;
}

export interface GitCommandExecutionOptions {
	env?: NodeJS.ProcessEnv;
}

export type GitCommandExists = (command: string) => boolean;

export type RunGitCommand = (
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	executionOptions?: GitCommandExecutionOptions,
) => Promise<RunGitCommandResult>;

export interface GitCommandOptions {
	commandExists?: GitCommandExists;
	runCommand?: RunGitCommand;
}

export interface GitRunSummary {
	output: string;
	captureTruncated: boolean;
	truncation?: TruncationResult;
	exitCode: number;
}

export interface GitRunParams {
	toolName: string;
	action: string;
	args: string[];
	cwd: string;
	timeoutSeconds: number;
	runCommand: RunGitCommand;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
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

function runGitCommand(
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	executionOptions?: GitCommandExecutionOptions,
): Promise<RunGitCommandResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: executionOptions?.env ? { ...process.env, ...executionOptions.env } : process.env,
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
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
			if (currentBytes >= MAX_GIT_CAPTURE_BYTES) {
				return { nextBytes: currentBytes, truncated: true };
			}
			const remaining = MAX_GIT_CAPTURE_BYTES - currentBytes;
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				return { nextBytes: currentBytes + chunk.length, truncated: false };
			}
			chunks.push(chunk.subarray(0, remaining));
			return { nextBytes: MAX_GIT_CAPTURE_BYTES, truncated: true };
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

export function resolveGitCommandOptions(options?: GitCommandOptions): {
	hasCommand: GitCommandExists;
	runCommand: RunGitCommand;
} {
	return {
		hasCommand: options?.commandExists ?? commandExists,
		runCommand: options?.runCommand ?? runGitCommand,
	};
}

export function normalizePositiveInt(raw: number | undefined, fallback: number, field: string): number {
	if (raw === undefined) return fallback;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} must be a positive number.`);
	}
	return value;
}

export function normalizeRefLike(raw: string | undefined, field: string): string | undefined {
	if (raw === undefined) return undefined;
	const normalized = raw.trim();
	if (normalized.length === 0) {
		throw new Error(`${field} must not be empty.`);
	}
	if (normalized.startsWith("-")) {
		throw new Error(`${field} must not start with '-'.`);
	}
	return normalized;
}

export function requireRefLike(raw: string | undefined, field: string): string {
	const normalized = normalizeRefLike(raw, field);
	if (!normalized) {
		throw new Error(`${field} is required.`);
	}
	return normalized;
}

export function normalizeRequiredString(raw: string | undefined, field: string): string {
	const value = raw?.trim();
	if (!value) {
		throw new Error(`${field} is required.`);
	}
	return value;
}

export function normalizeFiles(files: string[] | undefined, field: string): string[] {
	if (!files || files.length === 0) {
		throw new Error(`${field} is required.`);
	}
	const normalized = files
		.map((file) => file.trim())
		.filter((file) => file.length > 0);
	if (normalized.length === 0) {
		throw new Error(`${field} must include at least one non-empty path.`);
	}
	return normalized;
}

export async function runGitAndFormatOutput(params: GitRunParams): Promise<GitRunSummary> {
	const result = await params.runCommand(params.args, params.cwd, params.timeoutSeconds * 1000, params.signal, {
		env: params.env,
	});

	if (result.exitCode !== 0) {
		const errorText = result.stderr.trim() || result.stdout.trim() || `${params.toolName} ${params.action} failed with exit code ${result.exitCode}`;
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
		notices.push(`capture limit reached (${formatSize(MAX_GIT_CAPTURE_BYTES)})`);
	}
	if (notices.length > 0) {
		finalOutput += `\n\n[${notices.join(". ")} · showing up to ${DEFAULT_MAX_LINES} lines]`;
	}

	return {
		output: finalOutput,
		captureTruncated: result.captureTruncated,
		truncation: truncation.truncated ? truncation : undefined,
		exitCode: result.exitCode,
	};
}

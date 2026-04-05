import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { isSandboxEnabledFromEnv, wrapCommandWithSandbox } from "../sandbox/executor.js";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "./truncate.js";

export const DEFAULT_VERIFICATION_CAPTURE_BYTES = 512 * 1024;

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageJsonInfo {
	path: string;
	raw: Record<string, unknown>;
	scripts: Record<string, string>;
}

export interface VerificationCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	captureTruncated: boolean;
	durationMs: number;
}

export interface VerificationOutputFormat {
	text: string;
	truncation?: TruncationResult;
}

export interface RunVerificationCommandInput {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
}

export interface VerificationBatchItem extends RunVerificationCommandInput {
	key?: string;
}

export interface VerificationBatchResult {
	key?: string;
	input: VerificationBatchItem;
	result: VerificationCommandResult;
}

function captureChunk(
	chunk: Buffer,
	chunks: Buffer[],
	currentBytes: number,
	maxCaptureBytes: number,
): { nextBytes: number; truncated: boolean } {
	if (currentBytes >= maxCaptureBytes) {
		return { nextBytes: currentBytes, truncated: true };
	}
	const remaining = maxCaptureBytes - currentBytes;
	if (chunk.length <= remaining) {
		chunks.push(chunk);
		return { nextBytes: currentBytes + chunk.length, truncated: false };
	}
	chunks.push(chunk.subarray(0, remaining));
	return { nextBytes: maxCaptureBytes, truncated: true };
}

export function commandExists(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], { stdio: "pipe" });
		const err = result.error as NodeJS.ErrnoException | undefined;
		return !err || err.code !== "ENOENT";
	} catch {
		return false;
	}
}

export function resolveCommandCandidate(candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		if (commandExists(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export function detectPackageManager(cwd: string): PackageManager {
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
	if (existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "npm-shrinkwrap.json"))) return "npm";
	return "npm";
}

export function readPackageJson(cwd: string): PackageJsonInfo | undefined {
	const packageJsonPath = join(cwd, "package.json");
	if (!existsSync(packageJsonPath)) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse package.json at ${packageJsonPath}: ${message}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error(`package.json at ${packageJsonPath} must contain a JSON object.`);
	}

	const raw = parsed as Record<string, unknown>;
	const scriptsRaw = raw.scripts;
	const scripts: Record<string, string> = {};
	if (scriptsRaw && typeof scriptsRaw === "object") {
		for (const [key, value] of Object.entries(scriptsRaw as Record<string, unknown>)) {
			if (typeof value === "string") {
				scripts[key] = value;
			}
		}
	}

	return { path: packageJsonPath, raw, scripts };
}

export function resolvePackageManagerRunInvocation(
	packageManager: PackageManager,
	script: string,
	scriptArgs: string[],
): { command: string; args: string[] } {
	if (packageManager === "npm") {
		return {
			command: "npm",
			args: scriptArgs.length > 0 ? ["run", script, "--", ...scriptArgs] : ["run", script],
		};
	}
	if (packageManager === "pnpm") {
		return {
			command: "pnpm",
			args: scriptArgs.length > 0 ? ["run", script, "--", ...scriptArgs] : ["run", script],
		};
	}
	if (packageManager === "yarn") {
		return {
			command: "yarn",
			args: ["run", script, ...scriptArgs],
		};
	}
	return {
		command: "bun",
		args: ["run", script, ...scriptArgs],
	};
}

export function resolvePackageManagerExecInvocation(
	packageManager: PackageManager,
	binary: string,
	binaryArgs: string[],
): { command: string; args: string[] } {
	if (packageManager === "npm") {
		return { command: "npm", args: ["exec", "--", binary, ...binaryArgs] };
	}
	if (packageManager === "pnpm") {
		return { command: "pnpm", args: ["exec", binary, ...binaryArgs] };
	}
	if (packageManager === "yarn") {
		return { command: "yarn", args: ["exec", binary, ...binaryArgs] };
	}
	if (commandExists("bunx")) {
		return { command: "bunx", args: [binary, ...binaryArgs] };
	}
	return { command: "bun", args: ["x", binary, ...binaryArgs] };
}

export function ensureCommandOrThrow(command: string, hint?: string): void {
	if (commandExists(command)) {
		return;
	}
	const message = hint ? `${hint}` : `Command "${command}" is not available in PATH.`;
	throw new Error(message);
}

export async function runVerificationCommand(input: RunVerificationCommandInput): Promise<VerificationCommandResult> {
	return new Promise((resolve, reject) => {
		if (input.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const startedAt = Date.now();
		let wrapped;
		try {
			wrapped = wrapCommandWithSandbox({
				command: input.command,
				args: input.args,
				cwd: input.cwd,
				enabled: isSandboxEnabledFromEnv(),
			});
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const child = spawn(wrapped.command, wrapped.args, {
			cwd: input.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: input.env ? { ...process.env, ...input.env } : process.env,
		});

		let stdoutBytes = 0;
		let stderrBytes = 0;
		let captureTruncated = false;
		let timedOut = false;
		let aborted = false;
		let settled = false;

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];

		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, Math.max(1_000, input.timeoutMs));

		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		input.signal?.addEventListener("abort", onAbort, { once: true });

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			input.signal?.removeEventListener("abort", onAbort);
		};

		child.stdout.on("data", (chunk: Buffer) => {
			const captured = captureChunk(chunk, stdoutChunks, stdoutBytes, DEFAULT_VERIFICATION_CAPTURE_BYTES);
			stdoutBytes = captured.nextBytes;
			captureTruncated = captureTruncated || captured.truncated;
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const captured = captureChunk(chunk, stderrChunks, stderrBytes, DEFAULT_VERIFICATION_CAPTURE_BYTES);
			stderrBytes = captured.nextBytes;
			captureTruncated = captureTruncated || captured.truncated;
		});

		if (input.stdin !== undefined) {
			child.stdin.write(input.stdin);
		}
		child.stdin.end();

		child.on("error", (error) => {
			cleanup();
			settle(() => reject(new Error(`Failed to run ${input.command}: ${error.message}`)));
		});

		child.on("close", (code) => {
			cleanup();
			if (aborted) {
				settle(() => reject(new Error("Operation aborted")));
				return;
			}
			if (timedOut) {
				settle(() => reject(new Error(`Command timed out after ${Math.round(input.timeoutMs / 1000)}s`)));
				return;
			}

			settle(() =>
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					exitCode: code ?? -1,
					captureTruncated,
					durationMs: Date.now() - startedAt,
				}),
			);
		});
	});
}

export async function runVerificationCommandBatch(items: VerificationBatchItem[]): Promise<VerificationBatchResult[]> {
	const results: VerificationBatchResult[] = [];
	for (const item of items) {
		const result = await runVerificationCommand(item);
		results.push({
			key: item.key,
			input: item,
			result,
		});
	}
	return results;
}

export function formatVerificationOutput(
	stdout: string,
	stderr: string,
	captureTruncated: boolean,
	emptyOutputMessage: string,
): VerificationOutputFormat {
	let output = stdout.trimEnd();
	if (!output && stderr.trim().length > 0) {
		output = stderr.trimEnd();
	}
	if (!output) {
		output = emptyOutputMessage;
	}

	const truncation = truncateHead(output);
	let text = truncation.content;
	const notices: string[] = [];
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} output limit reached`);
	}
	if (captureTruncated) {
		notices.push(`capture limit reached (${formatSize(DEFAULT_VERIFICATION_CAPTURE_BYTES)})`);
	}
	if (notices.length > 0) {
		text += `\n\n[${notices.join(". ")} · showing up to ${DEFAULT_MAX_LINES} lines]`;
	}

	return {
		text,
		truncation: truncation.truncated ? truncation : undefined,
	};
}

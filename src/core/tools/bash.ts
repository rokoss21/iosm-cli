import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import stripAnsi from "strip-ansi";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../../utils/shell.js";
import { startBackgroundProcess } from "../background-processes.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";
import type { ToolPermissionGuard } from "./permissions.js";

/**
 * Generate a unique temp file path for bash output
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `iosm-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	run_in_background: Type.Optional(
		Type.Boolean({ description: "Run command in detached background mode and return task id immediately" }),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	backgroundTaskId?: string;
	backgroundStatusPath?: string;
	backgroundLogPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (e.g., SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command - The command to execute
	 * @param cwd - Working directory
	 * @param options - Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Default bash operations using local shell
 */
const defaultBashOperations: BashOperations = {
	exec: (command, cwd, { onData, signal, timeout, env }) => {
		return new Promise((resolve, reject) => {
			const { shell, args } = getShellConfig();

			if (!existsSync(cwd)) {
				reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
				return;
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: true,
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;

			// Set timeout if provided
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeout * 1000);
			}

			// Stream stdout and stderr
			if (child.stdout) {
				child.stdout.on("data", onData);
			}
			if (child.stderr) {
				child.stderr.on("data", onData);
			}

			// Handle shell spawn errors
			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				reject(err);
			});

			// Handle abort signal - kill entire process tree
			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// Handle process exit
			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);

				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}

				if (timedOut) {
					reject(new Error(`timeout:${timeout}`));
					return;
				}

				resolve({ exitCode: code });
			});
		});
	},
};

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function sanitizeBashChunk(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = {
		command,
		cwd,
		env: { ...getShellEnv() },
	};

	if (!spawnHook) return baseContext;

	const modified = spawnHook(baseContext);

	if (modified.command !== baseContext.command) {
		process.stderr.write(
			`[iosm] Extension modified bash command:\n  before: ${baseContext.command}\n  after:  ${modified.command}\n`,
		);
	}
	if (modified.cwd !== baseContext.cwd) {
		process.stderr.write(`[iosm] Extension modified bash cwd: ${baseContext.cwd} → ${modified.cwd}\n`);
	}

	return modified;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (e.g., "shopt -s expand_aliases" for alias support) */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Optional permission guard executed before command starts */
	permissionGuard?: ToolPermissionGuard;
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const ops = options?.operations ?? defaultBashOperations;
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const permissionGuard = options?.permissionGuard;

	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		execute: async (
			_toolCallId: string,
			{ command, timeout, run_in_background }: { command: string; timeout?: number; run_in_background?: boolean },
			signal?: AbortSignal,
			onUpdate?,
		) => {
			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "bash",
					cwd,
					input: { command, timeout, run_in_background },
					summary: command.trim().slice(0, 200),
				});
				if (!allowed) {
					throw new Error("Permission denied for bash command.");
				}
			}

			// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			if (run_in_background) {
				if (ops !== defaultBashOperations) {
					throw new Error("Background bash is not supported with custom execution operations.");
				}
				const background = startBackgroundProcess({
					rootCwd: cwd,
					cwd: spawnContext.cwd,
					command: spawnContext.command,
					source: "tool",
				});
				return {
					content: [
						{
							type: "text",
							text: `Started background process ${background.id} (pid ${background.pid}). Use /bg status ${background.id}, /bg logs ${background.id}, or /bg stop ${background.id}.`,
						},
					],
					details: {
						backgroundTaskId: background.id,
						backgroundStatusPath: background.metaPath,
						backgroundLogPath: background.logPath,
					},
				};
			}

			return new Promise((resolve, reject) => {
				// We'll stream to a temp file if output gets large
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				let totalBytes = 0;

				const decoder = new TextDecoder();
				// Keep a rolling buffer of recent sanitized output
				const chunks: string[] = [];
				let rollingOutput = "";
				let chunksBytes = 0;
				// Keep more than we need so we have enough context for tail truncation
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				const pushText = (text: string) => {
					if (!text) {
						return;
					}

					// Start writing to temp file once we exceed the threshold
					if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
						tempFilePath = getTempFilePath();
						tempFileStream = createWriteStream(tempFilePath);
						// Write all buffered chunks to the file
						for (const chunk of chunks) {
							tempFileStream.write(chunk);
						}
					}

					// Write to temp file if we have one
					if (tempFileStream) {
						tempFileStream.write(text);
					}

					// Keep rolling buffer of recent data
					chunks.push(text);
					rollingOutput += text;
					chunksBytes += Buffer.byteLength(text, "utf-8");

					// Trim old chunks if buffer is too large
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= Buffer.byteLength(removed, "utf-8");
						rollingOutput = rollingOutput.slice(removed.length);
					}

					// Stream partial output to callback (truncated rolling buffer)
					if (onUpdate) {
						const truncation = truncateTail(rollingOutput);
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					pushText(sanitizeBashChunk(decoder.decode(data, { stream: true })));
				};

				const flushDecoder = () => {
					pushText(sanitizeBashChunk(decoder.decode()));
				};

				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					.then(({ exitCode }) => {
						flushDecoder();

						// Close temp file stream
						if (tempFileStream) {
							tempFileStream.end();
						}

						// Apply tail truncation
						const truncation = truncateTail(rollingOutput);
						let outputText = truncation.content || "(no output)";

						// Build details with truncation info
						let details: BashToolDetails | undefined;

						if (truncation.truncated) {
							details = {
								truncation,
								fullOutputPath: tempFilePath,
							};

							// Build actionable notice
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;

							if (truncation.lastLinePartial) {
								// Edge case: last line alone > 30KB
								const lastLineSize = formatSize(
									Buffer.byteLength(rollingOutput.split("\n").pop() || "", "utf-8"),
								);
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}

						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: Error) => {
						flushDecoder();

						// Close temp file stream
						if (tempFileStream) {
							tempFileStream.end();
						}

						let output = rollingOutput;

						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							reject(err);
						}
					});
			});
		},
	};
}

/** Default bash tool using process.cwd() - for backwards compatibility */
export const bashTool = createBashTool(process.cwd());

import { spawn } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ToolPermissionGuard } from "./permissions.js";

const applyPatchSchema = Type.Object({
	patch: Type.String({
		description:
			"Patch text in apply_patch format. Must start with '*** Begin Patch' and end with '*** End Patch'.",
	}),
});

export type ApplyPatchToolInput = Static<typeof applyPatchSchema>;

export interface ApplyPatchToolDetails {
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
}

export interface ApplyPatchOperations {
	applyPatch: (cwd: string, patch: string) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

export interface ApplyPatchToolOptions {
	operations?: ApplyPatchOperations;
	permissionGuard?: ToolPermissionGuard;
}

function requireFilename(prefix: string, line: string): void {
	const value = line.slice(prefix.length).trim();
	if (!value) {
		throw new Error(`Invalid apply_patch format: "${prefix}" requires a non-empty filename.`);
	}
}

function isHunkStart(line: string): boolean {
	return (
		line.startsWith("*** Add File: ") ||
		line.startsWith("*** Delete File: ") ||
		line.startsWith("*** Update File: ")
	);
}

function validateApplyPatchGrammar(patch: string): void {
	const lines = patch.replace(/\r/g, "").split("\n");
	let index = 0;

	const lineAt = () => lines[index] ?? "";
	const isEndPatch = (line: string) => line === "*** End Patch";
	const atBoundary = (line: string) => isEndPatch(line) || isHunkStart(line);

	if (lineAt() !== "*** Begin Patch") {
		throw new Error("Invalid apply_patch format: first line must be '*** Begin Patch'.");
	}
	index += 1;

	let seenHunk = false;
	while (index < lines.length) {
		const line = lineAt();
		if (isEndPatch(line)) {
			index += 1;
			break;
		}
		if (line.startsWith("*** Add File: ")) {
			seenHunk = true;
			requireFilename("*** Add File: ", line);
			index += 1;
			let addCount = 0;
			while (index < lines.length && !atBoundary(lineAt())) {
				if (!lineAt().startsWith("+")) {
					throw new Error("Invalid apply_patch format: add hunk lines must start with '+'.");
				}
				addCount += 1;
				index += 1;
			}
			if (addCount === 0) {
				throw new Error("Invalid apply_patch format: add hunk requires at least one '+' line.");
			}
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			seenHunk = true;
			requireFilename("*** Delete File: ", line);
			index += 1;
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			seenHunk = true;
			requireFilename("*** Update File: ", line);
			index += 1;
			if (lineAt().startsWith("*** Move to: ")) {
				requireFilename("*** Move to: ", lineAt());
				index += 1;
			}
			while (index < lines.length && !atBoundary(lineAt())) {
				const current = lineAt();
				if (current === "*** End of File") {
					index += 1;
					continue;
				}
				if (current === "@@" || current.startsWith("@@ ")) {
					index += 1;
					continue;
				}
				const prefix = current[0];
				if (prefix === "+" || prefix === "-" || prefix === " ") {
					index += 1;
					continue;
				}
				throw new Error("Invalid apply_patch format: update hunk has an invalid change line.");
			}
			continue;
		}
		throw new Error("Invalid apply_patch format: expected hunk header or '*** End Patch'.");
	}

	if (!seenHunk) {
		throw new Error("Invalid apply_patch format: expected at least one hunk.");
	}

	const rest = lines.slice(index).filter((line) => line.length > 0);
	if (rest.length > 0) {
		throw new Error("Invalid apply_patch format: unexpected content after '*** End Patch'.");
	}
}

const defaultApplyPatchOperations: ApplyPatchOperations = {
	applyPatch: async (cwd, patch) => {
		const bin = process.env.IOSM_APPLY_PATCH_BIN?.trim() || "apply_patch";
		return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
			const child = spawn(bin, [], {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});

			child.on("error", (error) => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(
						new Error(
							`apply_patch binary not found. Install it or set IOSM_APPLY_PATCH_BIN to a valid executable path.`,
						),
					);
					return;
				}
				reject(error);
			});

			child.on("close", (code) => {
				resolve({ stdout, stderr, exitCode: code });
			});

			child.stdin?.end(patch);
		});
	},
};

export function createApplyPatchTool(cwd: string, options?: ApplyPatchToolOptions): AgentTool<typeof applyPatchSchema> {
	const operations = options?.operations ?? defaultApplyPatchOperations;
	const permissionGuard = options?.permissionGuard;

	return {
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Apply multi-file patches with strict apply_patch grammar. Use this for deterministic bulk edits and file add/delete/move operations.",
		parameters: applyPatchSchema,
		execute: async (_toolCallId: string, input: ApplyPatchToolInput) => {
			const patch = input.patch ?? "";
			validateApplyPatchGrammar(patch);

			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "apply_patch",
					cwd,
					input: { patchLength: patch.length },
					summary: "apply structured patch",
					requiredPermission: "workspace-write",
				});
				if (!allowed) {
					throw new Error("Permission denied for apply_patch.");
				}
			}

			const result = await operations.applyPatch(cwd, patch);
			if (result.exitCode !== 0) {
				const combined = `${result.stdout}${result.stderr}`.trim();
				throw new Error(
					combined.length > 0 ? `apply_patch failed (exit ${result.exitCode}): ${combined}` : `apply_patch failed (exit ${result.exitCode}).`,
				);
			}

			const text = result.stdout.trim() || result.stderr.trim() || "Patch applied successfully.";
			return {
				content: [{ type: "text", text }],
				details: {
					stdout: result.stdout || undefined,
					stderr: result.stderr || undefined,
					exitCode: result.exitCode,
				} satisfies ApplyPatchToolDetails,
			};
		},
	};
}

export const applyPatchTool = createApplyPatchTool(process.cwd());

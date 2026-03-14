import { cp as fsCopy, mkdir as fsMkdir, rename as fsRename, rm as fsRm, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import type { ToolPermissionGuard } from "./permissions.js";

const fsOpsSchema = Type.Object({
	action: Type.Union([Type.Literal("mkdir"), Type.Literal("move"), Type.Literal("copy"), Type.Literal("delete")], {
		description: "Filesystem operation: mkdir | move | copy | delete.",
	}),
	path: Type.Optional(Type.String({ description: "Target path for mkdir/delete actions." })),
	from: Type.Optional(Type.String({ description: "Source path for move/copy actions." })),
	to: Type.Optional(Type.String({ description: "Destination path for move/copy actions." })),
	recursive: Type.Optional(
		Type.Boolean({
			description:
				"Enable recursive behavior (required for deleting/copying directories). mkdir defaults to recursive=true.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Allow replacement/no-op safety escapes. Required to overwrite destinations or ignore missing delete target.",
		}),
	),
});

export type FsOpsToolInput = Static<typeof fsOpsSchema>;

export interface FsOpsToolDetails {
	action: "mkdir" | "move" | "copy" | "delete";
	resolvedPath?: string;
	resolvedFrom?: string;
	resolvedTo?: string;
	recursive?: boolean;
	force?: boolean;
	exdevFallback?: boolean;
	noop?: boolean;
}

interface FsOpsOperations {
	mkdir(path: string, options: { recursive: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	copy(from: string, to: string, options: { recursive: boolean; force: boolean }): Promise<void>;
	remove(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
	stat(path: string): Promise<{ isDirectory: () => boolean }>;
}

const defaultOps: FsOpsOperations = {
	mkdir: (path, options) => fsMkdir(path, options).then(() => {}),
	rename: (from, to) => fsRename(from, to),
	copy: (from, to, options) => fsCopy(from, to, options).then(() => {}),
	remove: (path, options) => fsRm(path, options).then(() => {}),
	stat: (path) => fsStat(path),
};

export interface FsOpsToolOptions {
	operations?: FsOpsOperations;
	permissionGuard?: ToolPermissionGuard;
}

function ensureNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
}

async function pathExists(ops: FsOpsOperations, path: string): Promise<boolean> {
	try {
		await ops.stat(path);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

export function createFsOpsTool(cwd: string, options?: FsOpsToolOptions): AgentTool<typeof fsOpsSchema> {
	const ops = options?.operations ?? defaultOps;
	const permissionGuard = options?.permissionGuard;

	return {
		name: "fs_ops",
		label: "fs_ops",
		description:
			"Structured filesystem mutations: mkdir, move, copy, delete. Uses explicit recursive/force safety flags for destructive operations.",
		parameters: fsOpsSchema,
		execute: async (_toolCallId: string, input: FsOpsToolInput, signal?: AbortSignal) => {
			ensureNotAborted(signal);
			const action = input.action;
			const recursive = input.recursive ?? (action === "mkdir");
			const force = input.force ?? false;

			const summary =
				action === "move" || action === "copy"
					? `${action} ${input.from ?? "(missing from)"} -> ${input.to ?? "(missing to)"}`
					: `${action} ${input.path ?? "(missing path)"}`;

			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "fs_ops",
					cwd,
					input: {
						action,
						path: input.path,
						from: input.from,
						to: input.to,
						recursive,
						force,
					},
					summary,
				});
				if (!allowed) {
					throw new Error("Permission denied for fs_ops operation.");
				}
			}

			if (action === "mkdir") {
				if (!input.path) {
					throw new Error("fs_ops mkdir requires path.");
				}
				const resolvedPath = resolveToCwd(input.path, cwd);
				await ops.mkdir(resolvedPath, { recursive });
				return {
					content: [{ type: "text", text: `Created directory: ${input.path}` }],
					details: {
						action,
						resolvedPath,
						recursive,
						force,
					} as FsOpsToolDetails,
				};
			}

			if (action === "delete") {
				if (!input.path) {
					throw new Error("fs_ops delete requires path.");
				}
				const resolvedPath = resolveToCwd(input.path, cwd);
				const exists = await pathExists(ops, resolvedPath);
				if (!exists) {
					if (!force) {
						throw new Error(`Path not found: ${input.path}`);
					}
					return {
						content: [{ type: "text", text: `Skipped delete (path missing): ${input.path}` }],
						details: {
							action,
							resolvedPath,
							recursive,
							force,
							noop: true,
						} as FsOpsToolDetails,
					};
				}

				const sourceStat = await ops.stat(resolvedPath);
				if (sourceStat.isDirectory() && !recursive) {
					throw new Error("Deleting a directory requires recursive=true.");
				}

				ensureNotAborted(signal);
				await ops.remove(resolvedPath, {
					recursive: sourceStat.isDirectory(),
					force: false,
				});

				return {
					content: [{ type: "text", text: `Deleted: ${input.path}` }],
					details: {
						action,
						resolvedPath,
						recursive,
						force,
					} as FsOpsToolDetails,
				};
			}

			if (!input.from || !input.to) {
				throw new Error(`fs_ops ${action} requires both from and to.`);
			}

			const resolvedFrom = resolveToCwd(input.from, cwd);
			const resolvedTo = resolveToCwd(input.to, cwd);
			const sourceExists = await pathExists(ops, resolvedFrom);
			if (!sourceExists) {
				throw new Error(`Source path not found: ${input.from}`);
			}
			const destinationExists = await pathExists(ops, resolvedTo);
			if (destinationExists && !force) {
				throw new Error(`Destination already exists: ${input.to}. Pass force=true to replace.`);
			}
			if (destinationExists && force) {
				ensureNotAborted(signal);
				await ops.remove(resolvedTo, { recursive: true, force: true });
			}

			const sourceStat = await ops.stat(resolvedFrom);
			const sourceIsDirectory = sourceStat.isDirectory();
			if (action === "copy" && sourceIsDirectory && !recursive) {
				throw new Error("Copying a directory requires recursive=true.");
			}

			if (action === "copy") {
				ensureNotAborted(signal);
				await ops.copy(resolvedFrom, resolvedTo, {
					recursive: sourceIsDirectory,
					force,
				});
				return {
					content: [{ type: "text", text: `Copied: ${input.from} -> ${input.to}` }],
					details: {
						action,
						resolvedFrom,
						resolvedTo,
						recursive,
						force,
					} as FsOpsToolDetails,
				};
			}

			let exdevFallback = false;
			try {
				ensureNotAborted(signal);
				await ops.rename(resolvedFrom, resolvedTo);
			} catch (error: any) {
				if (error?.code !== "EXDEV") {
					throw error;
				}
				exdevFallback = true;
				ensureNotAborted(signal);
				await ops.copy(resolvedFrom, resolvedTo, {
					recursive: sourceIsDirectory,
					force: true,
				});
				await ops.remove(resolvedFrom, {
					recursive: sourceIsDirectory,
					force: false,
				});
			}

			return {
				content: [{ type: "text", text: `Moved: ${input.from} -> ${input.to}` }],
				details: {
					action,
					resolvedFrom,
					resolvedTo,
					recursive,
					force,
					exdevFallback: exdevFallback || undefined,
				} as FsOpsToolDetails,
			};
		},
	};
}

export const fsOpsTool = createFsOpsTool(process.cwd());

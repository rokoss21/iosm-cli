import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { resolveToCwd } from "./path-utils.js";
import type { ToolPermissionGuard } from "./permissions.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
	overwriteExisting: Type.Optional(
		Type.Boolean({
			description:
				"Allow replacing an existing file. Defaults to false. Use only for intentional full-file rewrites.",
		}),
	),
	rewriteReason: Type.Optional(
		Type.String({
			description:
				"Brief reason for intentional full-file rewrite. Required when overwriteExisting=true for an existing file.",
		}),
	),
});

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (e.g., SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory (recursively) */
	mkdir: (dir: string) => Promise<void>;
	/** Check whether a path exists */
	exists?: (absolutePath: string) => Promise<boolean>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
	exists: async (path) => {
		try {
			await fsAccess(path, constants.F_OK);
			return true;
		} catch (error: any) {
			if (error?.code === "ENOENT") return false;
			throw error;
		}
	},
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** Optional permission guard executed before writing */
	permissionGuard?: ToolPermissionGuard;
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	const ops = options?.operations ?? defaultWriteOperations;
	const permissionGuard = options?.permissionGuard;

	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates new files by default. Overwriting an existing file requires overwriteExisting=true with rewriteReason for intentional full-file rewrites. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{
				path,
				content,
				overwriteExisting = false,
				rewriteReason,
			}: {
				path: string;
				content: string;
				overwriteExisting?: boolean;
				rewriteReason?: string;
			},
			signal?: AbortSignal,
		) => {
			const normalizedRewriteReason = rewriteReason?.trim() || undefined;
			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "write",
					cwd,
					input: {
						path,
						contentLength: content.length,
						overwriteExisting,
						rewriteReason: normalizedRewriteReason,
					},
					summary: path,
				});
				if (!allowed) {
					throw new Error("Permission denied for write operation.");
				}
			}

			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);

			return new Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined }>(
				(resolve, reject) => {
					// Check if already aborted
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}

					let aborted = false;

					// Set up abort handler
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};

					if (signal) {
						signal.addEventListener("abort", onAbort, { once: true });
					}

					// Perform the write operation
					(async () => {
						try {
							const existsFn = ops.exists ?? defaultWriteOperations.exists!;
							const fileExists = await existsFn(absolutePath);
							if (fileExists && !overwriteExisting) {
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}
								reject(
									new Error(
										`Refusing to overwrite existing file: ${path}. Use edit/apply_patch for targeted changes. If this is an intentional full rewrite, retry write with overwriteExisting=true and rewriteReason.`,
									),
								);
								return;
							}

							if (fileExists && overwriteExisting && !normalizedRewriteReason) {
								if (signal) {
									signal.removeEventListener("abort", onAbort);
								}
								reject(
									new Error(
										`overwriteExisting=true requires rewriteReason when rewriting existing file: ${path}.`,
									),
								);
								return;
							}

							// Create parent directories if needed
							await ops.mkdir(dir);

							// Check if aborted before writing
							if (aborted) {
								return;
							}

							// Write the file
							await ops.writeFile(absolutePath, content);

							// Check if aborted after writing
							if (aborted) {
								return;
							}

							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							resolve({
								content: [
									{
										type: "text",
										text: fileExists
											? `Successfully overwrote ${content.length} bytes in ${path}`
											: `Successfully wrote ${content.length} bytes to ${path}`,
									},
								],
								details: undefined,
							});
						} catch (error: any) {
							// Clean up abort handler
							if (signal) {
								signal.removeEventListener("abort", onAbort);
							}

							if (!aborted) {
								reject(error);
							}
						}
					})();
				},
			);
		},
	};
}

/** Default write tool using process.cwd() - for backwards compatibility */
export const writeTool = createWriteTool(process.cwd());

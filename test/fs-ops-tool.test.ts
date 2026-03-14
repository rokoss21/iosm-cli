import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsOpsTool } from "../src/core/tools/fs-ops.js";

function makeTempDir(prefix: string): string {
	return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

describe("fs_ops tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = makeTempDir("iosm-fs-ops");
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (testDir) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("creates directories recursively by default and remains idempotent", async () => {
		const tool = createFsOpsTool(testDir);
		const result = await tool.execute("fs-ops-1", {
			action: "mkdir",
			path: "a/b/c",
		});
		const result2 = await tool.execute("fs-ops-1b", {
			action: "mkdir",
			path: "a/b/c",
		});

		expect(getText(result)).toContain("Created directory");
		expect(getText(result2)).toContain("Created directory");
		expect(existsSync(join(testDir, "a", "b", "c"))).toBe(true);
	});

	it("requires recursive=true to delete directories", async () => {
		const dirPath = join(testDir, "to-delete");
		mkdirSync(dirPath, { recursive: true });
		const tool = createFsOpsTool(testDir);

		await expect(
			tool.execute("fs-ops-2", {
				action: "delete",
				path: "to-delete",
				recursive: false,
			}),
		).rejects.toThrow(/requires recursive=true/i);
	});

	it("treats missing delete target as no-op when force=true", async () => {
		const tool = createFsOpsTool(testDir);
		const result = await tool.execute("fs-ops-3", {
			action: "delete",
			path: "missing.txt",
			force: true,
		});

		expect(getText(result)).toContain("Skipped delete");
		expect(result.details?.noop).toBe(true);
	});

	it("protects copy destination without force", async () => {
		writeFileSync(join(testDir, "source.txt"), "source");
		writeFileSync(join(testDir, "target.txt"), "target");
		const tool = createFsOpsTool(testDir);

		await expect(
			tool.execute("fs-ops-4", {
				action: "copy",
				from: "source.txt",
				to: "target.txt",
			}),
		).rejects.toThrow(/Destination already exists/i);

		const result = await tool.execute("fs-ops-5", {
			action: "copy",
			from: "source.txt",
			to: "target.txt",
			force: true,
		});
		expect(getText(result)).toContain("Copied");
		expect(readFileSync(join(testDir, "target.txt"), "utf-8")).toBe("source");
	});

	it("moves files and removes source", async () => {
		writeFileSync(join(testDir, "from.txt"), "payload");
		const tool = createFsOpsTool(testDir);
		const result = await tool.execute("fs-ops-6", {
			action: "move",
			from: "from.txt",
			to: "to.txt",
		});

		expect(getText(result)).toContain("Moved");
		expect(existsSync(join(testDir, "from.txt"))).toBe(false);
		expect(readFileSync(join(testDir, "to.txt"), "utf-8")).toBe("payload");
	});

	it("requires recursive=true when copying a directory", async () => {
		mkdirSync(join(testDir, "dir-src"), { recursive: true });
		writeFileSync(join(testDir, "dir-src", "file.txt"), "x");
		const tool = createFsOpsTool(testDir);

		await expect(
			tool.execute("fs-ops-7", {
				action: "copy",
				from: "dir-src",
				to: "dir-dest",
				recursive: false,
			}),
		).rejects.toThrow(/requires recursive=true/i);
	});

	it("uses EXDEV fallback for move when rename fails cross-device", async () => {
		const copy = vi.fn(async () => {});
		const remove = vi.fn(async () => {});
		const rename = vi.fn(async () => {
			const err = new Error("cross-device") as NodeJS.ErrnoException;
			err.code = "EXDEV";
			throw err;
		});
		const stat = vi.fn(async (path: string) => {
			if (path.endsWith("b.txt")) {
				const err = new Error("missing") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return { isDirectory: () => false };
		});
		const tool = createFsOpsTool(process.cwd(), {
			operations: {
				mkdir: async () => {},
				rename,
				copy,
				remove,
				stat,
			},
		});

		const result = await tool.execute("fs-ops-8", {
			action: "move",
			from: "a.txt",
			to: "b.txt",
		});

		expect(rename).toHaveBeenCalledTimes(1);
		expect(copy).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(result.details?.exdevFallback).toBe(true);
	});

	it("honors permission guard", async () => {
		const tool = createFsOpsTool(testDir, {
			permissionGuard: async () => false,
		});

		await expect(
			tool.execute("fs-ops-9", {
				action: "mkdir",
				path: "blocked",
			}),
		).rejects.toThrow(/Permission denied/i);
	});
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitReadTool } from "../src/core/tools/git-read.js";

function makeTempDir(prefix: string): string {
	return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, stdio: "pipe" });
	if (result.status !== 0) {
		throw new Error(result.stderr.toString("utf-8") || `git ${args.join(" ")} failed`);
	}
	return result.stdout.toString("utf-8").trim();
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

describe("git_read tool", () => {
	let repoDir: string;
	let nonRepoDir: string;

	beforeEach(() => {
		repoDir = makeTempDir("iosm-git-read-repo");
		nonRepoDir = makeTempDir("iosm-git-read-non-repo");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(nonRepoDir, { recursive: true });

		runGit(repoDir, ["init"]);
		runGit(repoDir, ["config", "user.name", "Test User"]);
		runGit(repoDir, ["config", "user.email", "test@example.com"]);

		writeFileSync(join(repoDir, "app.txt"), "line 1\nline 2\nline 3\n");
		runGit(repoDir, ["add", "app.txt"]);
		runGit(repoDir, ["commit", "-m", "initial commit"]);

		writeFileSync(join(repoDir, "app.txt"), "line 1\nline two changed\nline 3\n");
	});

	afterEach(() => {
		if (repoDir) rmSync(repoDir, { recursive: true, force: true });
		if (nonRepoDir) rmSync(nonRepoDir, { recursive: true, force: true });
	});

	it("returns status output", async () => {
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-1", { action: "status" });
		const output = getText(result);

		expect(output).toContain("##");
		expect(output).toContain("app.txt");
	});

	it("returns diff output for modified file", async () => {
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-2", { action: "diff", file: "app.txt" });
		const output = getText(result);

		expect(output).toContain("-line 2");
		expect(output).toContain("+line two changed");
	});

	it("returns log output with configured limit", async () => {
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-3", { action: "log", limit: 1 });
		const output = getText(result);

		expect(output).toContain("initial commit");
	});

	it("returns show output using default HEAD ref", async () => {
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-show-1", { action: "show", file: "app.txt" });
		const output = getText(result);

		expect(output).toContain("initial commit");
		expect(output).toContain("line 2");
	});

	it("returns branch_list output", async () => {
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-branch-list-1", { action: "branch_list" });
		const output = getText(result);

		expect(output).toContain("*");
	});

	it("returns remote_list output in verbose mode by default", async () => {
		runGit(repoDir, ["remote", "add", "origin", "https://example.com/test/repo.git"]);
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-remote-list-1", { action: "remote_list" });
		const output = getText(result);

		expect(output).toContain("origin");
		expect(output).toContain("https://example.com/test/repo.git");
	});

	it("returns rev_parse output and supports short hashes", async () => {
		const expected = runGit(repoDir, ["rev-parse", "--short", "HEAD"]);
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-rev-parse-1", { action: "rev_parse", short: true });
		const output = getText(result);

		expect(output.trim()).toBe(expected);
	});

	it("returns blame output for specific file", async () => {
		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-4", { action: "blame", file: "app.txt", line_start: 1, line_end: 2 });
		const output = getText(result);

		expect(output).toContain("author Test User");
		expect(output).toContain("line 1");
	});

	it("validates action-specific parameters", async () => {
		const tool = createGitReadTool(repoDir);
		await expect(
			tool.execute("git-read-5", {
				action: "diff",
				head: "HEAD",
			}),
		).rejects.toThrow(/requires base when head is provided/i);
	});

	it("validates ref-like parameters", async () => {
		const tool = createGitReadTool(repoDir);
		await expect(
			tool.execute("git-read-invalid-ref-1", {
				action: "show",
				ref: "-bad-ref",
			}),
		).rejects.toThrow(/must not start with '-'/i);
	});

	it("fails outside a git repository", async () => {
		const tool = createGitReadTool(nonRepoDir);
		await expect(tool.execute("git-read-6", { action: "status" })).rejects.toThrow(/not a git repository/i);
	});

	it("applies output truncation for very large responses", async () => {
		const largeLines = Array.from({ length: 8000 }, (_, index) => `line-${index}`);
		writeFileSync(join(repoDir, "huge.txt"), `${largeLines.join("\n")}\n`);
		runGit(repoDir, ["add", "huge.txt"]);
		runGit(repoDir, ["commit", "-m", "add huge file"]);

		const tool = createGitReadTool(repoDir);
		const result = await tool.execute("git-read-7", {
			action: "blame",
			file: "huge.txt",
		});
		const output = getText(result);

		expect(output).toContain("output limit reached");
		expect(result.details?.truncation?.truncated).toBe(true);
	});
});

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitWriteTool } from "../src/core/tools/git-write.js";

function makeTempDir(prefix: string): string {
	return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, stdio: "pipe" });
	if (result.status !== 0) {
		throw new Error(result.stderr.toString("utf-8") || `git ${args.join(" ")} failed`);
	}
	return result.stdout.toString("utf-8").trimEnd();
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

describe("git_write tool", () => {
	let repoDir: string;
	let otherRepoDir: string;

	beforeEach(() => {
		repoDir = makeTempDir("iosm-git-write-repo");
		otherRepoDir = makeTempDir("iosm-git-write-other-repo");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(otherRepoDir, { recursive: true });

		runGit(repoDir, ["init"]);
		runGit(repoDir, ["config", "user.name", "Test User"]);
		runGit(repoDir, ["config", "user.email", "test@example.com"]);
		writeFileSync(join(repoDir, "app.txt"), "line 1\nline 2\n");
		runGit(repoDir, ["add", "app.txt"]);
		runGit(repoDir, ["commit", "-m", "initial commit"]);
		writeFileSync(join(repoDir, "app.txt"), "line 1\nline two changed\n");

		runGit(otherRepoDir, ["init"]);
		runGit(otherRepoDir, ["config", "user.name", "Test User"]);
		runGit(otherRepoDir, ["config", "user.email", "test@example.com"]);
		writeFileSync(join(otherRepoDir, "other.txt"), "other\n");
		runGit(otherRepoDir, ["add", "other.txt"]);
		runGit(otherRepoDir, ["commit", "-m", "other initial"]);
	});

	afterEach(() => {
		if (repoDir) rmSync(repoDir, { recursive: true, force: true });
		if (otherRepoDir) rmSync(otherRepoDir, { recursive: true, force: true });
	});

	it("stages files with add(files)", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-add-1", {
			action: "add",
			files: ["app.txt"],
		});
		const status = runGit(repoDir, ["status", "--short"]);

		expect(status).toContain("M  app.txt");
	});

	it("validates add mode exclusivity", async () => {
		const tool = createGitWriteTool(repoDir);
		await expect(
			tool.execute("git-write-add-invalid-1", {
				action: "add",
			}),
		).rejects.toThrow(/requires exactly one mode/i);

		await expect(
			tool.execute("git-write-add-invalid-2", {
				action: "add",
				all: true,
				update: true,
			}),
		).rejects.toThrow(/requires exactly one mode/i);
	});

	it("restores staged file entries with restore(staged=true)", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-restore-setup", {
			action: "add",
			files: ["app.txt"],
		});
		await tool.execute("git-write-restore-1", {
			action: "restore",
			files: ["app.txt"],
			staged: true,
		});
		const status = runGit(repoDir, ["status", "--short"]);

		expect(status).toContain(" M app.txt");
		expect(status).not.toContain("M  app.txt");
	});

	it("supports reset_index for unstage workflow", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-reset-setup", {
			action: "add",
			files: ["app.txt"],
		});
		await tool.execute("git-write-reset-1", {
			action: "reset_index",
			files: ["app.txt"],
		});
		const status = runGit(repoDir, ["status", "--short"]);

		expect(status).toContain(" M app.txt");
		expect(status).not.toContain("M  app.txt");
	});

	it("creates commits with commit(message)", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-commit-setup", {
			action: "add",
			files: ["app.txt"],
		});
		await tool.execute("git-write-commit-1", {
			action: "commit",
			message: "apply app change",
		});
		const latestMessage = runGit(repoDir, ["log", "-1", "--pretty=%s"]);

		expect(latestMessage).toBe("apply app change");
	});

	it("creates and switches branches", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-branch-create-1", {
			action: "branch_create",
			branch: "feature/safe-core",
		});
		await tool.execute("git-write-switch-1", {
			action: "switch",
			branch: "feature/safe-core",
		});
		const currentBranch = runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);

		expect(currentBranch).toBe("feature/safe-core");
	});

	it("supports stash_push, stash_list, stash_apply and stash_drop", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-stash-push-1", {
			action: "stash_push",
			message: "temp change",
		});
		const statusAfterPush = runGit(repoDir, ["status", "--short"]);
		expect(statusAfterPush).toBe("");

		const listResult = await tool.execute("git-write-stash-list-1", {
			action: "stash_list",
			limit: 5,
		});
		expect(getText(listResult)).toContain("temp change");

		await tool.execute("git-write-stash-apply-1", {
			action: "stash_apply",
		});
		const statusAfterApply = runGit(repoDir, ["status", "--short"]);
		expect(statusAfterApply).toContain(" M app.txt");

		await tool.execute("git-write-stash-drop-1", {
			action: "stash_drop",
		});
		const stashCount = Number(runGit(repoDir, ["stash", "list"]).split("\n").filter(Boolean).length);
		expect(stashCount).toBe(0);
	});

	it("supports stash_pop", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-stash-pop-setup", {
			action: "stash_push",
			message: "pop change",
		});
		await tool.execute("git-write-stash-pop-1", {
			action: "stash_pop",
		});
		const status = runGit(repoDir, ["status", "--short"]);
		const remainingStashes = runGit(repoDir, ["stash", "list"]);

		expect(status).toContain(" M app.txt");
		expect(remainingStashes).toBe("");
	});

	it("validates ref-like values", async () => {
		const tool = createGitWriteTool(repoDir);
		await expect(
			tool.execute("git-write-invalid-ref-1", {
				action: "switch",
				branch: "-bad",
			}),
		).rejects.toThrow(/must not start with '-'/i);
	});

	it("honors permission guard", async () => {
		const tool = createGitWriteTool(repoDir, {
			permissionGuard: async () => false,
		});

		await expect(
			tool.execute("git-write-permission-1", {
				action: "add",
				files: ["app.txt"],
			}),
		).rejects.toThrow(/Permission denied/i);
	});

	it("supports path for working with another local repository", async () => {
		const tool = createGitWriteTool(repoDir);
		await tool.execute("git-write-other-path-1", {
			action: "commit",
			path: otherRepoDir,
			message: "empty checkpoint",
			allow_empty: true,
		});
		const latest = runGit(otherRepoDir, ["log", "-1", "--pretty=%s"]);

		expect(latest).toBe("empty checkpoint");
	});

	it("rejects network actions when github-tools network access is disabled", async () => {
		const tool = createGitWriteTool(repoDir);
		await expect(
			tool.execute("git-write-network-disabled-1", {
				action: "push",
				remote: "origin",
			}),
		).rejects.toThrow(/network actions are disabled/i);
	});

	it("builds fetch args and network env when enabled", async () => {
		const runCommand = vi.fn(async () => ({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			captureTruncated: false,
		}));
		const tool = createGitWriteTool(repoDir, {
			commandExists: () => true,
			runCommand,
			resolveRuntimeConfig: () => ({ networkEnabled: true }),
		});

		await tool.execute("git-write-fetch-args-1", {
			action: "fetch",
			remote: "origin",
			prune: true,
			tags: true,
		});

		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(runCommand.mock.calls[0]?.[0]).toEqual(["fetch", "--prune", "--tags", "origin"]);
		expect(runCommand.mock.calls[0]?.[4]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("injects github token for network actions without exposing it in args", async () => {
		const runCommand = vi.fn(async () => ({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			captureTruncated: false,
		}));
		const tool = createGitWriteTool(repoDir, {
			commandExists: () => true,
			runCommand,
			resolveRuntimeConfig: () => ({ networkEnabled: true }),
			resolveGithubToken: () => "ghp_test_token",
		});

		await tool.execute("git-write-token-env-1", {
			action: "pull",
			remote: "origin",
			branch: "main",
		});

		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(runCommand.mock.calls[0]?.[0]).toEqual(["pull", "--ff-only", "origin", "main"]);
		const env = runCommand.mock.calls[0]?.[4]?.env;
		expect(env?.GIT_CONFIG_COUNT).toBeDefined();
		expect(env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
		expect(env?.GIT_CONFIG_VALUE_0).toContain("AUTHORIZATION: basic ");
		expect(env?.GIT_CONFIG_VALUE_0).not.toContain("ghp_test_token");
	});

	it("supports push action when network mode is enabled", async () => {
		const runCommand = vi.fn(async () => ({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			captureTruncated: false,
		}));
		const tool = createGitWriteTool(repoDir, {
			commandExists: () => true,
			runCommand,
			resolveRuntimeConfig: () => ({ networkEnabled: true }),
		});

		await tool.execute("git-write-push-1", {
			action: "push",
			remote: "origin",
			branch: "main",
			set_upstream: true,
		});

		expect(runCommand.mock.calls[0]?.[0]).toEqual(["push", "--set-upstream", "origin", "main"]);
	});

	it("validates network action ref-like parameters", async () => {
		const tool = createGitWriteTool(repoDir, {
			resolveRuntimeConfig: () => ({ networkEnabled: true }),
		});
		await expect(
			tool.execute("git-write-invalid-remote-1", {
				action: "fetch",
				remote: "-origin",
			}),
		).rejects.toThrow(/must not start with '-'/i);
	});

	it("rejects unknown write actions", async () => {
		const tool = createGitWriteTool(repoDir);
		await expect(
			tool.execute("git-write-unknown-1", {
				action: "merge" as any,
			}),
		).rejects.toThrow(/Unsupported git_write action/i);
	});
});

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_GIT_TIMEOUT_SECONDS,
	normalizeFiles,
	normalizePositiveInt,
	normalizeRefLike,
	normalizeRequiredString,
	requireRefLike,
	resolveGitCommandOptions,
	runGitAndFormatOutput,
	type GitCommandOptions,
} from "./git-common.js";
import type { ToolPermissionGuard } from "./permissions.js";
import type { TruncationResult } from "./truncate.js";

const gitWriteSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("restore"),
			Type.Literal("reset_index"),
			Type.Literal("commit"),
			Type.Literal("switch"),
			Type.Literal("branch_create"),
			Type.Literal("fetch"),
			Type.Literal("pull"),
			Type.Literal("push"),
			Type.Literal("stash_push"),
			Type.Literal("stash_pop"),
			Type.Literal("stash_apply"),
			Type.Literal("stash_drop"),
			Type.Literal("stash_list"),
		],
		{
			description:
				"Git write action: add | restore | reset_index | commit | switch | branch_create | fetch | pull | push | stash_push | stash_pop | stash_apply | stash_drop | stash_list.",
		},
	),
	path: Type.Optional(Type.String({ description: "Repository working directory (default: current directory)." })),
	all: Type.Optional(Type.Boolean({ description: "For add action: stage all tracked and untracked changes." })),
	update: Type.Optional(Type.Boolean({ description: "For add action: stage modified/deleted tracked files." })),
	files: Type.Optional(Type.Array(Type.String(), { description: "For add/restore/reset_index action: file paths." })),
	staged: Type.Optional(Type.Boolean({ description: "For restore action: restore index instead of working tree." })),
	source: Type.Optional(Type.String({ description: "For restore action: source ref (e.g., HEAD)." })),
	ref: Type.Optional(Type.String({ description: "For reset_index action: reference commit (default: HEAD)." })),
	message: Type.Optional(Type.String({ description: "For commit/stash_push action: message." })),
	allow_empty: Type.Optional(Type.Boolean({ description: "For commit action: allow empty commit." })),
	branch: Type.Optional(Type.String({ description: "For switch/branch_create action: branch name." })),
	start_point: Type.Optional(Type.String({ description: "For branch_create action: start point (default: HEAD)." })),
	remote: Type.Optional(Type.String({ description: "For fetch/pull/push action: remote name (default: origin)." })),
	ff_only: Type.Optional(Type.Boolean({ description: "For pull action: require fast-forward merge (default: true)." })),
	prune: Type.Optional(Type.Boolean({ description: "For fetch action: prune deleted remote refs." })),
	set_upstream: Type.Optional(Type.Boolean({ description: "For push action: set upstream for branch." })),
	tags: Type.Optional(Type.Boolean({ description: "For fetch/push action: include tags." })),
	include_untracked: Type.Optional(
		Type.Boolean({ description: "For stash_push action: include untracked files." }),
	),
	keep_index: Type.Optional(Type.Boolean({ description: "For stash_push action: keep index unchanged." })),
	stash_ref: Type.Optional(
		Type.String({ description: "For stash_pop/stash_apply/stash_drop action: stash ref (default: stash@{0})." }),
	),
	limit: Type.Optional(Type.Number({ description: "For stash_list action: max entries (default: 20, max: 200)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)." })),
});

export type GitWriteToolInput = Static<typeof gitWriteSchema>;

const DEFAULT_STASH_LIST_LIMIT = 20;
const MAX_STASH_LIST_LIMIT = 200;
const DEFAULT_REMOTE = "origin";
const DEFAULT_GIT_WRITE_NETWORK_ENABLED = false;

type GitWriteAction = GitWriteToolInput["action"];

export interface GitWriteToolDetails {
	action: GitWriteAction;
	command: string;
	args: string[];
	cwd: string;
	exitCode: number;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

export interface GitWriteRuntimeConfig {
	networkEnabled: boolean;
}

export interface GitWriteToolOptions extends GitCommandOptions {
	permissionGuard?: ToolPermissionGuard;
	resolveRuntimeConfig?: () => Partial<GitWriteRuntimeConfig> | GitWriteRuntimeConfig;
	resolveGithubToken?: () => string | undefined;
}

function normalizeGitWriteRuntimeConfig(
	config: Partial<GitWriteRuntimeConfig> | GitWriteRuntimeConfig | undefined,
): GitWriteRuntimeConfig {
	return {
		networkEnabled:
			typeof config?.networkEnabled === "boolean"
				? config.networkEnabled
				: DEFAULT_GIT_WRITE_NETWORK_ENABLED,
	};
}

function buildAddArgs(input: GitWriteToolInput): string[] {
	const useAll = input.all === true;
	const useUpdate = input.update === true;
	const hasFiles = (input.files?.length ?? 0) > 0;
	const modeCount = (useAll ? 1 : 0) + (useUpdate ? 1 : 0) + (hasFiles ? 1 : 0);
	if (modeCount !== 1) {
		throw new Error("git_write add requires exactly one mode: all=true, update=true, or files[].");
	}
	const args = ["add"];
	if (useAll) {
		args.push("--all");
		return args;
	}
	if (useUpdate) {
		args.push("--update");
		return args;
	}
	const files = normalizeFiles(input.files, "files");
	args.push("--", ...files);
	return args;
}

function buildRestoreArgs(input: GitWriteToolInput): string[] {
	const files = normalizeFiles(input.files, "files");
	const args = ["restore"];
	if (input.staged) {
		args.push("--staged");
	}
	const source = normalizeRefLike(input.source, "source");
	if (source) {
		args.push(`--source=${source}`);
	}
	args.push("--", ...files);
	return args;
}

function buildResetIndexArgs(input: GitWriteToolInput): string[] {
	const files = normalizeFiles(input.files, "files");
	const ref = requireRefLike(input.ref ?? "HEAD", "ref");
	return ["reset", ref, "--", ...files];
}

function buildCommitArgs(input: GitWriteToolInput): string[] {
	const message = normalizeRequiredString(input.message, "message");
	const args = ["commit", "-m", message];
	if (input.allow_empty) {
		args.push("--allow-empty");
	}
	return args;
}

function buildSwitchArgs(input: GitWriteToolInput): string[] {
	const branch = requireRefLike(input.branch, "branch");
	return ["switch", branch];
}

function buildBranchCreateArgs(input: GitWriteToolInput): string[] {
	const branch = requireRefLike(input.branch, "branch");
	const startPoint = requireRefLike(input.start_point ?? "HEAD", "start_point");
	return ["branch", branch, startPoint];
}

function buildFetchArgs(input: GitWriteToolInput): string[] {
	const remote = requireRefLike(input.remote ?? DEFAULT_REMOTE, "remote");
	const args = ["fetch"];
	if (input.prune) {
		args.push("--prune");
	}
	if (input.tags) {
		args.push("--tags");
	}
	args.push(remote);
	return args;
}

function buildPullArgs(input: GitWriteToolInput): string[] {
	const remote = requireRefLike(input.remote ?? DEFAULT_REMOTE, "remote");
	const args = ["pull"];
	if (input.ff_only ?? true) {
		args.push("--ff-only");
	}
	args.push(remote);
	const branch = normalizeRefLike(input.branch, "branch");
	if (branch) {
		args.push(branch);
	}
	return args;
}

function buildPushArgs(input: GitWriteToolInput): string[] {
	const remote = requireRefLike(input.remote ?? DEFAULT_REMOTE, "remote");
	const args = ["push"];
	if (input.set_upstream) {
		args.push("--set-upstream");
	}
	if (input.tags) {
		args.push("--tags");
	}
	args.push(remote);
	const branch = normalizeRefLike(input.branch, "branch");
	if (branch) {
		args.push(branch);
	}
	return args;
}

function buildStashPushArgs(input: GitWriteToolInput): string[] {
	const args = ["stash", "push"];
	if (input.include_untracked) {
		args.push("--include-untracked");
	}
	if (input.keep_index) {
		args.push("--keep-index");
	}
	if (input.message !== undefined) {
		const message = normalizeRequiredString(input.message, "message");
		args.push("-m", message);
	}
	return args;
}

function buildStashEntryActionArgs(input: GitWriteToolInput, action: "pop" | "apply" | "drop"): string[] {
	const stashRef = requireRefLike(input.stash_ref ?? "stash@{0}", "stash_ref");
	return ["stash", action, stashRef];
}

function buildStashListArgs(input: GitWriteToolInput): string[] {
	const limit = Math.min(MAX_STASH_LIST_LIMIT, normalizePositiveInt(input.limit, DEFAULT_STASH_LIST_LIMIT, "limit"));
	return ["stash", "list", `--max-count=${limit}`, "--date=iso", "--pretty=format:%gd%x09%H%x09%ad%x09%s"];
}

function buildGitWriteArgs(input: GitWriteToolInput): string[] {
	switch (input.action) {
		case "add":
			return buildAddArgs(input);
		case "restore":
			return buildRestoreArgs(input);
		case "reset_index":
			return buildResetIndexArgs(input);
		case "commit":
			return buildCommitArgs(input);
		case "switch":
			return buildSwitchArgs(input);
		case "branch_create":
			return buildBranchCreateArgs(input);
		case "fetch":
			return buildFetchArgs(input);
		case "pull":
			return buildPullArgs(input);
		case "push":
			return buildPushArgs(input);
		case "stash_push":
			return buildStashPushArgs(input);
		case "stash_pop":
			return buildStashEntryActionArgs(input, "pop");
		case "stash_apply":
			return buildStashEntryActionArgs(input, "apply");
		case "stash_drop":
			return buildStashEntryActionArgs(input, "drop");
		case "stash_list":
			return buildStashListArgs(input);
		default:
			throw new Error(`Unsupported git_write action: ${(input as { action: string }).action}`);
	}
}

function isNetworkAction(action: GitWriteAction): boolean {
	return action === "fetch" || action === "pull" || action === "push";
}

function buildGitNetworkEnv(githubToken: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		GIT_TERMINAL_PROMPT: "0",
	};

	const token = githubToken?.trim();
	if (!token) {
		return env;
	}

	const basic = Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64");
	const existingCountRaw = process.env.GIT_CONFIG_COUNT;
	const existingCountParsed = existingCountRaw ? Number.parseInt(existingCountRaw, 10) : Number.NaN;
	const existingCount = Number.isFinite(existingCountParsed) && existingCountParsed >= 0 ? existingCountParsed : 0;
	const keyIndex = existingCount;

	env.GIT_CONFIG_COUNT = String(existingCount + 1);
	env[`GIT_CONFIG_KEY_${keyIndex}`] = "http.https://github.com/.extraheader";
	env[`GIT_CONFIG_VALUE_${keyIndex}`] = `AUTHORIZATION: basic ${basic}`;
	return env;
}

export function createGitWriteTool(cwd: string, options?: GitWriteToolOptions): AgentTool<typeof gitWriteSchema> {
	const { hasCommand, runCommand } = resolveGitCommandOptions(options);
	const permissionGuard = options?.permissionGuard;
	const resolveRuntimeConfig = options?.resolveRuntimeConfig;
	const resolveGithubToken = options?.resolveGithubToken;

	return {
		name: "git_write",
		label: "git_write",
		description:
			"Structured git mutation tool. Actions: add, restore, reset_index, commit, switch, branch_create, fetch, pull, push, stash_push, stash_pop, stash_apply, stash_drop, stash_list. Network actions are disabled by default and require explicit runtime enablement.",
		parameters: gitWriteSchema,
		execute: async (_toolCallId: string, input: GitWriteToolInput, signal?: AbortSignal) => {
			if (!hasCommand("git")) {
				throw new Error("git command is not available.");
			}

			const runtimeConfig = normalizeGitWriteRuntimeConfig(resolveRuntimeConfig?.());
			const networkAction = isNetworkAction(input.action);
			if (networkAction && !runtimeConfig.networkEnabled) {
				throw new Error("git_write network actions are disabled. Enable Github tools network access in settings.");
			}

			const repoCwd = resolveToCwd(input.path || ".", cwd);
			const args = buildGitWriteArgs(input);
			const timeoutSeconds = normalizePositiveInt(input.timeout, DEFAULT_GIT_TIMEOUT_SECONDS, "timeout");
			const env = networkAction ? buildGitNetworkEnv(resolveGithubToken?.()) : undefined;

				if (permissionGuard) {
					const allowed = await permissionGuard({
						toolName: "git_write",
						cwd,
						input: {
							action: input.action,
							path: input.path,
							repoCwd,
							args,
							timeoutSeconds,
							networkAction,
						},
						summary: `git ${args.join(" ")}`,
					});
					if (!allowed) {
						throw new Error("Permission denied for git_write operation.");
					}
				}

			const result = await runGitAndFormatOutput({
				toolName: "git_write",
				action: input.action,
				args,
				cwd: repoCwd,
				timeoutSeconds,
				runCommand,
				signal,
				env,
			});

			const details: GitWriteToolDetails = {
				action: input.action,
				command: "git",
				args,
				cwd: repoCwd,
				exitCode: result.exitCode,
				captureTruncated: result.captureTruncated || undefined,
				truncation: result.truncation,
			};

			return {
				content: [{ type: "text", text: result.output }],
				details,
			};
		},
	};
}

export const gitWriteTool = createGitWriteTool(process.cwd());

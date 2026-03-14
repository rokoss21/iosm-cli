import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import {
	DEFAULT_GIT_TIMEOUT_SECONDS,
	normalizePositiveInt,
	normalizeRefLike,
	requireRefLike,
	resolveGitCommandOptions,
	runGitAndFormatOutput,
	type GitCommandOptions,
} from "./git-common.js";
import type { TruncationResult } from "./truncate.js";

const gitReadSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("diff"),
			Type.Literal("log"),
			Type.Literal("blame"),
			Type.Literal("show"),
			Type.Literal("branch_list"),
			Type.Literal("remote_list"),
			Type.Literal("rev_parse"),
		],
		{ description: "Git action: status | diff | log | blame | show | branch_list | remote_list | rev_parse." },
	),
	path: Type.Optional(Type.String({ description: "Repository working directory (default: current directory)." })),
	file: Type.Optional(Type.String({ description: "Optional file path for diff/log/show, required for blame." })),
	base: Type.Optional(Type.String({ description: "Optional base ref/commit for diff." })),
	head: Type.Optional(Type.String({ description: "Optional head ref/commit for diff (requires base)." })),
	staged: Type.Optional(Type.Boolean({ description: "For diff action: compare staged changes." })),
	context: Type.Optional(Type.Number({ description: "For diff action: unified context lines (default: 3)." })),
	porcelain: Type.Optional(
		Type.Boolean({
			description: "For status action: use short porcelain format with branch (default: true).",
		}),
	),
	untracked: Type.Optional(Type.Boolean({ description: "For status action: include untracked files (default: true)." })),
	limit: Type.Optional(Type.Number({ description: "For log action: max entries (default: 20, max: 200)." })),
	since: Type.Optional(Type.String({ description: "For log action: git --since value (e.g. '2 weeks ago')." })),
	ref: Type.Optional(Type.String({ description: "For blame/show action: optional ref/commit (show defaults to HEAD)." })),
	line_start: Type.Optional(Type.Number({ description: "For blame action: range start line (1-indexed)." })),
	line_end: Type.Optional(Type.Number({ description: "For blame action: range end line (1-indexed)." })),
	all: Type.Optional(Type.Boolean({ description: "For branch_list action: include remote branches (default: true)." })),
	verbose: Type.Optional(
		Type.Boolean({
			description: "For branch_list/remote_list action: include verbose output (branch_list default: false, remote_list default: true).",
		}),
	),
	target: Type.Optional(Type.String({ description: "For rev_parse action: ref/commit to resolve (default: HEAD)." })),
	short: Type.Optional(Type.Boolean({ description: "For rev_parse action: output short hash (default: false)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)." })),
});

export type GitReadToolInput = Static<typeof gitReadSchema>;

const DEFAULT_LOG_LIMIT = 20;
const MAX_LOG_LIMIT = 200;

type GitReadAction = GitReadToolInput["action"];

export interface GitReadToolDetails {
	action: GitReadAction;
	command: string;
	args: string[];
	cwd: string;
	exitCode: number;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

export interface GitReadToolOptions extends GitCommandOptions {}

function buildStatusArgs(input: GitReadToolInput): string[] {
	const porcelain = input.porcelain ?? true;
	const includeUntracked = input.untracked ?? true;
	const args = ["status"];
	if (porcelain) {
		args.push("--short", "--branch");
	}
	if (!includeUntracked) {
		args.push("--untracked-files=no");
	}
	return args;
}

function buildDiffArgs(input: GitReadToolInput): string[] {
	if (input.head && !input.base) {
		throw new Error("git_read diff requires base when head is provided.");
	}
	const context = normalizePositiveInt(input.context, 3, "context");
	const base = normalizeRefLike(input.base, "base");
	const head = normalizeRefLike(input.head, "head");
	const args = ["diff", "--no-color", `--unified=${context}`];
	if (input.staged) {
		args.push("--staged");
	}
	if (base && head) {
		args.push(`${base}..${head}`);
	} else if (base) {
		args.push(base);
	}
	if (input.file) {
		args.push("--", input.file);
	}
	return args;
}

function buildLogArgs(input: GitReadToolInput): string[] {
	const limit = Math.min(MAX_LOG_LIMIT, normalizePositiveInt(input.limit, DEFAULT_LOG_LIMIT, "limit"));
	const args = [
		"log",
		"--no-color",
		`--max-count=${limit}`,
		"--date=iso",
		"--pretty=format:%H%x09%ad%x09%an%x09%s",
	];
	if (input.since) {
		args.push(`--since=${input.since}`);
	}
	if (input.file) {
		args.push("--", input.file);
	}
	return args;
}

function buildBlameArgs(input: GitReadToolInput): string[] {
	if (!input.file) {
		throw new Error("git_read blame requires file.");
	}
	const hasLineStart = input.line_start !== undefined;
	const hasLineEnd = input.line_end !== undefined;
	if (hasLineStart !== hasLineEnd) {
		throw new Error("git_read blame requires both line_start and line_end when specifying a range.");
	}
	const args = ["blame", "--line-porcelain"];
	const ref = normalizeRefLike(input.ref, "ref");
	if (ref) {
		args.push(ref);
	}
	if (hasLineStart && hasLineEnd) {
		const lineStart = normalizePositiveInt(input.line_start, 1, "line_start");
		const lineEnd = normalizePositiveInt(input.line_end, 1, "line_end");
		if (lineEnd < lineStart) {
			throw new Error("line_end must be greater than or equal to line_start.");
		}
		args.push("-L", `${lineStart},${lineEnd}`);
	}
	args.push("--", input.file);
	return args;
}

function buildShowArgs(input: GitReadToolInput): string[] {
	const ref = requireRefLike(input.ref ?? "HEAD", "ref");
	const args = ["show", "--no-color", ref];
	if (input.file) {
		args.push("--", input.file);
	}
	return args;
}

function buildBranchListArgs(input: GitReadToolInput): string[] {
	const includeAll = input.all ?? true;
	const verbose = input.verbose ?? false;
	const args = ["branch", "--list"];
	if (includeAll) {
		args.push("--all");
	}
	if (verbose) {
		args.push("--verbose");
	}
	return args;
}

function buildRemoteListArgs(input: GitReadToolInput): string[] {
	const verbose = input.verbose ?? true;
	const args = ["remote"];
	if (verbose) {
		args.push("-v");
	}
	return args;
}

function buildRevParseArgs(input: GitReadToolInput): string[] {
	const target = requireRefLike(input.target ?? "HEAD", "target");
	const args = ["rev-parse"];
	if (input.short) {
		args.push("--short");
	}
	args.push(target);
	return args;
}

function buildGitReadArgs(input: GitReadToolInput): string[] {
	switch (input.action) {
		case "status":
			return buildStatusArgs(input);
		case "diff":
			return buildDiffArgs(input);
		case "log":
			return buildLogArgs(input);
		case "blame":
			return buildBlameArgs(input);
		case "show":
			return buildShowArgs(input);
		case "branch_list":
			return buildBranchListArgs(input);
		case "remote_list":
			return buildRemoteListArgs(input);
		case "rev_parse":
			return buildRevParseArgs(input);
		default:
			throw new Error(`Unsupported git_read action: ${(input as { action: string }).action}`);
	}
}

export function createGitReadTool(cwd: string, options?: GitReadToolOptions): AgentTool<typeof gitReadSchema> {
	const { hasCommand, runCommand } = resolveGitCommandOptions(options);

	return {
		name: "git_read",
		label: "git_read",
		description:
			"Structured read-only git introspection. Actions: status | diff | log | blame | show | branch_list | remote_list | rev_parse. Uses safe argv execution without shell interpolation.",
		parameters: gitReadSchema,
		execute: async (_toolCallId: string, input: GitReadToolInput, signal?: AbortSignal) => {
			if (!hasCommand("git")) {
				throw new Error("git command is not available.");
			}

			const repoCwd = resolveToCwd(input.path || ".", cwd);
			const args = buildGitReadArgs(input);
			const timeoutSeconds = normalizePositiveInt(input.timeout, DEFAULT_GIT_TIMEOUT_SECONDS, "timeout");
			const result = await runGitAndFormatOutput({
				toolName: "git_read",
				action: input.action,
				args,
				cwd: repoCwd,
				timeoutSeconds,
				runCommand,
				signal,
			});

			const details: GitReadToolDetails = {
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

export const gitReadTool = createGitReadTool(process.cwd());

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import type { TruncationResult } from "./truncate.js";
import {
	type PackageManager,
	commandExists,
	detectPackageManager,
	ensureCommandOrThrow,
	formatVerificationOutput,
	getCommandExistsCacheStatsSnapshot,
	readPackageJson,
	resolvePackageManagerExecInvocation,
	resolvePackageManagerRunInvocation,
	runVerificationCommandBatch,
	type VerificationBatchMode,
} from "./verification-runner.js";

const typecheckRunSchema = Type.Object({
	runner: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("npm"),
				Type.Literal("pnpm"),
				Type.Literal("yarn"),
				Type.Literal("bun"),
				Type.Literal("tsc"),
				Type.Literal("vue_tsc"),
				Type.Literal("pyright"),
				Type.Literal("mypy"),
			],
			{
				description: "Typecheck runner: auto | npm | pnpm | yarn | bun | tsc | vue_tsc | pyright | mypy",
			},
		),
	),
	script: Type.Optional(
		Type.String({
			description: "Package script for npm/pnpm/yarn/bun runners (default: typecheck).",
		}),
	),
	targets: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional explicit typecheck targets (files/directories/globs).",
		}),
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional CLI args forwarded to each selected typecheck runner.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Working directory for typecheck execution (default: current directory)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 600)." })),
});

export type TypecheckRunToolInput = Static<typeof typecheckRunSchema>;
export type TypecheckRunRunner =
	| "auto"
	| "npm"
	| "pnpm"
	| "yarn"
	| "bun"
	| "tsc"
	| "vue_tsc"
	| "pyright"
	| "mypy";
export type TypecheckRunStatus = "passed" | "failed" | "no_files" | "error";

type ResolvedTypecheckRunner = Exclude<TypecheckRunRunner, "auto">;

interface ResolvedTypecheckCommand {
	resolvedRunner: ResolvedTypecheckRunner;
	command: string;
	args: string[];
}

export interface TypecheckRunItemDetails {
	resolvedRunner: ResolvedTypecheckRunner;
	resolvedCommand: string;
	resolvedArgs: string[];
	exitCode: number;
	status: TypecheckRunStatus;
	durationMs: number;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

export interface TypecheckRunToolDetails {
	status: TypecheckRunStatus;
	cwd: string;
	durationMs: number;
	runs: TypecheckRunItemDetails[];
	aggregateExitCode: number;
	batchMode: VerificationBatchMode;
	maxParallel?: number;
	commandChecks?: {
		checks: number;
		cacheHits: number;
		cacheMisses: number;
		pathInvalidations: number;
	};
}

export const DEFAULT_TYPECHECK_RUN_TIMEOUT_SECONDS = 600;
const DEFAULT_TYPECHECK_BATCH_MAX_PARALLEL = 4;
const MIN_TYPECHECK_BATCH_MAX_PARALLEL = 1;
const MAX_TYPECHECK_BATCH_MAX_PARALLEL = 16;

export interface TypecheckRunToolOptions {
	resolveBatchMode?: () => VerificationBatchMode;
	resolveMaxParallel?: () => number;
}

function normalizeTypecheckBatchMaxParallel(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_TYPECHECK_BATCH_MAX_PARALLEL;
	const parsed = Math.floor(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_TYPECHECK_BATCH_MAX_PARALLEL;
	return Math.max(MIN_TYPECHECK_BATCH_MAX_PARALLEL, Math.min(MAX_TYPECHECK_BATCH_MAX_PARALLEL, parsed));
}

function normalizeTimeoutSeconds(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_TYPECHECK_RUN_TIMEOUT_SECONDS;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("timeout must be a positive number.");
	}
	return value;
}

function normalizeStringArray(raw: string[] | undefined): string[] {
	return (raw ?? []).map((item) => String(item));
}

function normalizeOptionalScriptName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const script = raw.trim();
	if (!script) {
		throw new Error("script must not be empty.");
	}
	return script;
}

function hasAnyFile(cwd: string, fileNames: string[]): boolean {
	return fileNames.some((name) => existsSync(join(cwd, name)));
}

function pyprojectContains(cwd: string, marker: string): boolean {
	const pyprojectPath = join(cwd, "pyproject.toml");
	if (!existsSync(pyprojectPath)) return false;
	try {
		const content = readFileSync(pyprojectPath, "utf-8");
		return content.includes(marker);
	} catch {
		return false;
	}
}

function packageHasDependency(packageJson: ReturnType<typeof readPackageJson>, dependency: string): boolean {
	if (!packageJson) return false;
	const raw = packageJson.raw as {
		dependencies?: Record<string, unknown>;
		devDependencies?: Record<string, unknown>;
		optionalDependencies?: Record<string, unknown>;
		peerDependencies?: Record<string, unknown>;
	};
	return Boolean(
		raw.dependencies?.[dependency] ??
			raw.devDependencies?.[dependency] ??
			raw.optionalDependencies?.[dependency] ??
			raw.peerDependencies?.[dependency],
	);
}

function scriptsContainToken(packageJson: ReturnType<typeof readPackageJson>, token: string): boolean {
	if (!packageJson) return false;
	return Object.values(packageJson.scripts).some((value) => value.includes(token));
}

function hasTypeScriptMarkers(cwd: string, packageJson: ReturnType<typeof readPackageJson>): boolean {
	if (
		hasAnyFile(cwd, [
			"tsconfig.json",
			"tsconfig.base.json",
			"tsconfig.app.json",
			"tsconfig.build.json",
			"tsconfig.node.json",
		])
	) {
		return true;
	}
	return packageHasDependency(packageJson, "typescript") || scriptsContainToken(packageJson, "tsc");
}

function hasVueTypeScriptMarkers(cwd: string, packageJson: ReturnType<typeof readPackageJson>): boolean {
	if (hasAnyFile(cwd, ["tsconfig.vue.json", "vue-tsc.config.ts", "vue-tsc.config.js"])) {
		return true;
	}
	return packageHasDependency(packageJson, "vue-tsc") || scriptsContainToken(packageJson, "vue-tsc");
}

function hasPyrightMarkers(cwd: string): boolean {
	return existsSync(join(cwd, "pyrightconfig.json")) || pyprojectContains(cwd, "[tool.pyright]");
}

function hasMypyMarkers(cwd: string): boolean {
	return hasAnyFile(cwd, ["mypy.ini", ".mypy.ini"]) || pyprojectContains(cwd, "[tool.mypy]");
}

function assertPackageManagerAvailable(packageManager: PackageManager): void {
	if (packageManager === "bun") {
		ensureCommandOrThrow("bun", 'Command "bun" is required for bun-based typecheck execution.');
		return;
	}
	ensureCommandOrThrow(packageManager, `Command "${packageManager}" is required for typecheck execution.`);
}

function resolveScriptCommand(
	packageManager: PackageManager,
	script: string,
	args: string[],
	targets: string[],
): ResolvedTypecheckCommand {
	assertPackageManagerAvailable(packageManager);
	const invocation = resolvePackageManagerRunInvocation(packageManager, script, [...args, ...targets]);
	return {
		resolvedRunner: packageManager,
		command: invocation.command,
		args: invocation.args,
	};
}

function resolvePackageExecRunner(
	cwd: string,
	binary: "tsc" | "vue-tsc" | "pyright",
	resolvedRunner: "tsc" | "vue_tsc" | "pyright",
	args: string[],
	targets: string[],
): ResolvedTypecheckCommand {
	const packageManager = detectPackageManager(cwd);
	assertPackageManagerAvailable(packageManager);
	const invocation = resolvePackageManagerExecInvocation(packageManager, binary, [...args, ...targets]);
	ensureCommandOrThrow(
		invocation.command,
		`Command "${invocation.command}" is required to run ${binary}. Install ${packageManager} tooling first.`,
	);
	return {
		resolvedRunner,
		command: invocation.command,
		args: invocation.args,
	};
}

function resolveMypyRunner(args: string[], targets: string[]): ResolvedTypecheckCommand {
	const positionalTargets = targets.length > 0 ? targets : ["."];
	if (commandExists("python3")) {
		return {
			resolvedRunner: "mypy",
			command: "python3",
			args: ["-m", "mypy", ...args, ...positionalTargets],
		};
	}
	if (commandExists("mypy")) {
		return {
			resolvedRunner: "mypy",
			command: "mypy",
			args: [...args, ...positionalTargets],
		};
	}
	throw new Error('No mypy runtime found. Install python3 + mypy or expose "mypy" in PATH.');
}

function uniqueByRunner(commands: ResolvedTypecheckCommand[]): ResolvedTypecheckCommand[] {
	const seen = new Set<ResolvedTypecheckRunner>();
	const result: ResolvedTypecheckCommand[] = [];
	for (const command of commands) {
		if (seen.has(command.resolvedRunner)) continue;
		seen.add(command.resolvedRunner);
		result.push(command);
	}
	return result;
}

function resolveAutoCommands(input: {
	cwd: string;
	script?: string;
	args: string[];
	targets: string[];
}): ResolvedTypecheckCommand[] {
	const packageJson = readPackageJson(input.cwd);
	const commands: ResolvedTypecheckCommand[] = [];
	const packageManager = detectPackageManager(input.cwd);

	const scriptCandidates = input.script ? [input.script] : ["typecheck", "check:types", "types"];
	if (packageJson) {
		const selectedScript = scriptCandidates.find((candidate) => Boolean(packageJson.scripts[candidate]));
		if (selectedScript) {
			commands.push(resolveScriptCommand(packageManager, selectedScript, input.args, input.targets));
		}
	}

	if (hasTypeScriptMarkers(input.cwd, packageJson)) {
		commands.push(resolvePackageExecRunner(input.cwd, "tsc", "tsc", input.args, input.targets));
	}

	if (hasVueTypeScriptMarkers(input.cwd, packageJson)) {
		commands.push(resolvePackageExecRunner(input.cwd, "vue-tsc", "vue_tsc", input.args, input.targets));
	}

	if (hasPyrightMarkers(input.cwd)) {
		commands.push(resolvePackageExecRunner(input.cwd, "pyright", "pyright", input.args, input.targets));
	}

	if (hasMypyMarkers(input.cwd)) {
		commands.push(resolveMypyRunner(input.args, input.targets));
	}

	const unique = uniqueByRunner(commands);
	if (unique.length === 0) {
		throw new Error(
			"Unable to auto-detect typecheck runners. Expected package.json typecheck scripts, TS configs/dependencies, or Python pyright/mypy markers.",
		);
	}
	return unique;
}

function resolveSingleCommand(input: {
	cwd: string;
	runner: ResolvedTypecheckRunner;
	script: string;
	args: string[];
	targets: string[];
}): ResolvedTypecheckCommand {
	if (input.runner === "npm" || input.runner === "pnpm" || input.runner === "yarn" || input.runner === "bun") {
		const packageJson = readPackageJson(input.cwd);
		if (!packageJson) {
			throw new Error(`package.json is required to run ${input.runner} scripts.`);
		}
		if (!packageJson.scripts[input.script]) {
			throw new Error(`Script "${input.script}" is not defined in package.json.`);
		}
		return resolveScriptCommand(input.runner, input.script, input.args, input.targets);
	}

	if (input.runner === "tsc") {
		return resolvePackageExecRunner(input.cwd, "tsc", "tsc", input.args, input.targets);
	}
	if (input.runner === "vue_tsc") {
		return resolvePackageExecRunner(input.cwd, "vue-tsc", "vue_tsc", input.args, input.targets);
	}
	if (input.runner === "pyright") {
		return resolvePackageExecRunner(input.cwd, "pyright", "pyright", input.args, input.targets);
	}
	return resolveMypyRunner(input.args, input.targets);
}

function indicatesNoFiles(output: string): boolean {
	return /No inputs were found in config file|No source files found|0 source files/i.test(output);
}

function mapTypecheckStatus(exitCode: number, output: string): TypecheckRunStatus {
	if (indicatesNoFiles(output)) return "no_files";
	if (exitCode === 0) return "passed";
	if (exitCode === 1) return "failed";
	return "error";
}

function aggregateStatus(statuses: TypecheckRunStatus[]): TypecheckRunStatus {
	if (statuses.length === 0) return "error";
	if (statuses.includes("error")) return "error";
	if (statuses.includes("failed")) return "failed";
	if (statuses.every((status) => status === "no_files")) return "no_files";
	return "passed";
}

function resolveAggregateExitCode(status: TypecheckRunStatus, runs: TypecheckRunItemDetails[]): number {
	if (status === "passed") return 0;
	const nonZero = runs.find((run) => run.exitCode !== 0);
	if (nonZero) return nonZero.exitCode;
	const first = runs[0];
	return first ? first.exitCode : -1;
}

function renderSummary(details: TypecheckRunToolDetails, outputs: Array<{ runner: string; text: string }>): string {
	const lines: string[] = [
		`typecheck_run status: ${details.status}`,
		`cwd: ${details.cwd}`,
		`batch_mode: ${details.batchMode}`,
		`runs: ${details.runs.length}`,
		`aggregate_exit_code: ${details.aggregateExitCode}`,
		`duration_ms: ${details.durationMs}`,
	];
	if (details.maxParallel !== undefined) {
		lines.push(`max_parallel: ${details.maxParallel}`);
	}
	if (details.commandChecks) {
		lines.push(
			`command_checks: total=${details.commandChecks.checks}, cache_hits=${details.commandChecks.cacheHits}, cache_misses=${details.commandChecks.cacheMisses}, path_invalidations=${details.commandChecks.pathInvalidations}`,
		);
	}

	for (let index = 0; index < details.runs.length; index += 1) {
		const run = details.runs[index];
		const output = outputs[index];
		const argsText = run.resolvedArgs.length > 0 ? ` ${run.resolvedArgs.join(" ")}` : "";
		lines.push("");
		lines.push(
			`[${index + 1}] ${run.resolvedRunner} status=${run.status} exit_code=${run.exitCode} duration_ms=${run.durationMs}`,
		);
		lines.push(`command: ${run.resolvedCommand}${argsText}`);
		lines.push(output?.text ?? "No typecheck output");
	}

	return lines.join("\n");
}

export function createTypecheckRunTool(cwd: string, options?: TypecheckRunToolOptions): AgentTool<typeof typecheckRunSchema> {
	return {
		name: "typecheck_run",
		label: "typecheck_run",
		description:
			"Structured typecheck execution for TS/Python stacks with auto detection across package scripts, tsc/vue-tsc, pyright, and mypy. Returns normalized status without throwing on ordinary typecheck failures.",
		parameters: typecheckRunSchema,
		execute: async (_toolCallId: string, input: TypecheckRunToolInput, signal?: AbortSignal) => {
			const executionCwd = resolveToCwd(input.path || ".", cwd);
			const timeoutSeconds = normalizeTimeoutSeconds(input.timeout);
			const args = normalizeStringArray(input.args);
			const targets = normalizeStringArray(input.targets);
			const runner = input.runner ?? "auto";
			const script = normalizeOptionalScriptName(input.script) ?? "typecheck";

			const commandStatsBefore = getCommandExistsCacheStatsSnapshot();
			const commands =
				runner === "auto"
					? resolveAutoCommands({
						cwd: executionCwd,
						script: normalizeOptionalScriptName(input.script),
						args,
						targets,
					})
					: [
						resolveSingleCommand({
							cwd: executionCwd,
							runner,
							script,
							args,
							targets,
						}),
					];

			const startedAt = Date.now();
			const configuredBatchMode = options?.resolveBatchMode?.() ?? "sequential";
			const canParallelizeAutoBatch = runner === "auto" && commands.length > 1 && configuredBatchMode === "parallel";
			const selectedBatchMode: VerificationBatchMode = canParallelizeAutoBatch ? "parallel" : "sequential";
			const selectedMaxParallel = canParallelizeAutoBatch
				? normalizeTypecheckBatchMaxParallel(options?.resolveMaxParallel?.())
				: undefined;

			const batch = await runVerificationCommandBatch(
				commands.map((command, index) => ({
					key: `${command.resolvedRunner}-${index}`,
					command: command.command,
					args: command.args,
					cwd: executionCwd,
					timeoutMs: timeoutSeconds * 1000,
					signal,
				})),
				{
					mode: selectedBatchMode,
					maxParallel: selectedMaxParallel,
				},
			);
			const durationMs = Date.now() - startedAt;
			const commandStatsAfter = getCommandExistsCacheStatsSnapshot();
			const commandChecksDelta = {
				checks: Math.max(0, commandStatsAfter.checks - commandStatsBefore.checks),
				cacheHits: Math.max(0, commandStatsAfter.cacheHits - commandStatsBefore.cacheHits),
				cacheMisses: Math.max(0, commandStatsAfter.cacheMisses - commandStatsBefore.cacheMisses),
				pathInvalidations: Math.max(0, commandStatsAfter.pathInvalidations - commandStatsBefore.pathInvalidations),
			};

			const runDetails: TypecheckRunItemDetails[] = [];
			const renderedOutputs: Array<{ runner: string; text: string }> = [];
			for (let index = 0; index < batch.length; index += 1) {
				const resolved = commands[index];
				const entry = batch[index];
				const rawOutput = `${entry.result.stdout}\n${entry.result.stderr}`;
				const status = mapTypecheckStatus(entry.result.exitCode, rawOutput);
				const formatted = formatVerificationOutput(
					entry.result.stdout,
					entry.result.stderr,
					entry.result.captureTruncated,
					"No typecheck output",
				);

				runDetails.push({
					resolvedRunner: resolved?.resolvedRunner ?? "tsc",
					resolvedCommand: resolved?.command ?? entry.input.command,
					resolvedArgs: resolved?.args ?? entry.input.args,
					exitCode: entry.result.exitCode,
					status,
					durationMs: entry.result.durationMs,
					captureTruncated: entry.result.captureTruncated || undefined,
					truncation: formatted.truncation,
				});
				renderedOutputs.push({
					runner: resolved?.resolvedRunner ?? "tsc",
					text: formatted.text,
				});
			}

			const status = aggregateStatus(runDetails.map((run) => run.status));
			const details: TypecheckRunToolDetails = {
				status,
				cwd: executionCwd,
				durationMs,
				runs: runDetails,
				aggregateExitCode: resolveAggregateExitCode(status, runDetails),
				batchMode: selectedBatchMode,
				maxParallel: selectedMaxParallel,
				commandChecks: commandChecksDelta.checks > 0 ? commandChecksDelta : undefined,
			};

			return {
				content: [{ type: "text", text: renderSummary(details, renderedOutputs) }],
				details,
			};
		},
	};
}

export const typecheckRunTool = createTypecheckRunTool(process.cwd());

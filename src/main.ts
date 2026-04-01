/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { type Api, type AssistantMessage, type ImageContent, supportsXhigh } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "readline";
import { type Args, parseArgs, printHelp } from "./cli/args.js";
import { selectConfig } from "./cli/config-selector.js";
import { processFileArguments } from "./cli/file-processor.js";
import { listModels } from "./cli/list-models.js";
import { selectSession } from "./cli/session-picker.js";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_OFFLINE,
	ENV_SESSION_TRACE,
	ENV_SESSION_TRACE_DIR,
	ENV_SKIP_VERSION_CHECK,
	getAgentDir,
	getModelsPath,
	getSessionTracePath,
	isSessionTraceEnabled,
	isTruthyEnvFlag,
	VERSION,
} from "./config.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { LoadExtensionsResult } from "./core/extensions/index.js";
import { KeybindingsManager } from "./core/keybindings.js";
import { type ProviderConfigInput, ModelRegistry } from "./core/model-registry.js";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { loadModelsDevProviderCatalog, type ModelsDevProviderCatalogInfo } from "./core/models-dev-provider-catalog.js";
import {
	getMcpCommandHelp,
	getMergedServerByName,
	loadMergedMcpConfig,
	McpRuntime,
	parseMcpAddCommand,
	parseMcpTargetCommand,
} from "./core/mcp/index.js";
import {
	getSemanticCommandHelp,
	parseSemanticCliCommand,
	SemanticConfigMissingError,
	SemanticIndexRequiredError,
	SemanticRebuildRequiredError,
	SemanticSearchRuntime,
	type SemanticIndexOperationResult,
	type SemanticQueryResult,
	type SemanticStatusResult,
} from "./core/semantic/index.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { DefaultResourceLoader } from "./core/resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "./core/sdk.js";
import { getProfileNames, isValidProfileName } from "./core/agent-profiles.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, time } from "./core/timings.js";
import { allTools } from "./core/tools/index.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import {
	buildIosmAgentVerificationPrompt,
	buildIosmGuideAuthoringPrompt,
	buildIosmPriorityChecklist,
	createMetricSnapshot,
	extractAssistantText,
	formatMetricSnapshot,
	getIosmGuidePath,
	initIosmWorkspace,
	inspectIosmCycle,
	listIosmCycles,
	planIosmCycle,
	readIosmCycleReport,
	recordIosmCycleHistory,
	normalizeIosmGuideMarkdown,
	writeIosmGuideDocument,
	type IosmInitResult,
	type IosmMetricSnapshot,
} from "./iosm/index.js";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function resolveModelsDevApi(modelNpm?: string): Api {
	const npm = modelNpm?.toLowerCase() ?? "";
	if (npm.includes("anthropic")) return "anthropic-messages";
	if (npm.includes("google-vertex")) return "google-vertex";
	if (npm.includes("google")) return "google-generative-ai";
	if (npm.includes("amazon-bedrock")) return "bedrock-converse-stream";
	if (npm.includes("mistral")) return "mistral-conversations";
	if (npm.includes("@ai-sdk/openai") && !npm.includes("compatible")) return "openai-responses";
	return "openai-completions";
}

function buildModelsDevProviderConfig(providerInfo: ModelsDevProviderCatalogInfo): ProviderConfigInput | undefined {
	const baseUrl = providerInfo.api ?? providerInfo.models.find((model) => !!model.api)?.api;
	if (!baseUrl) return undefined;
	if (providerInfo.models.length === 0) return undefined;

	const models: NonNullable<ProviderConfigInput["models"]> = providerInfo.models.map((model) => ({
		id: model.id,
		name: model.name,
		api: resolveModelsDevApi(model.npm ?? providerInfo.npm),
		reasoning: model.reasoning,
		input: [...model.input],
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: Object.keys(model.headers).length > 0 ? model.headers : undefined,
	}));

	return {
		baseUrl,
		models,
	};
}

function isProviderConfiguredInModelsJson(providerId: string, modelsPath: string): boolean {
	if (!existsSync(modelsPath)) return false;
	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers?: unknown };
		const providers = parsed?.providers;
		if (!providers || typeof providers !== "object" || Array.isArray(providers)) return false;
		return Object.prototype.hasOwnProperty.call(providers, providerId);
	} catch {
		return false;
	}
}

async function hydrateAuthenticatedProviderModelsOnStartup(modelRegistry: ModelRegistry): Promise<void> {
	if (isTruthyEnvFlag(process.env[ENV_OFFLINE]) || isTruthyEnvFlag(process.env.PI_OFFLINE)) return;

	const providersToRefresh = new Set<string>(modelRegistry.authStorage.list());
	for (const model of modelRegistry.getAll()) {
		if (modelRegistry.authStorage.hasAuth(model.provider)) {
			providersToRefresh.add(model.provider);
		}
	}
	if (providersToRefresh.size === 0) return;

	const modelsPath = getModelsPath();
	let catalog: ReadonlyMap<string, ModelsDevProviderCatalogInfo>;
	try {
		catalog = await loadModelsDevProviderCatalog();
	} catch {
		return;
	}

	for (const providerId of providersToRefresh) {
		if (isProviderConfiguredInModelsJson(providerId, modelsPath)) {
			continue;
		}
		const providerInfo = catalog.get(providerId);
		if (!providerInfo) continue;
		const config = buildModelsDevProviderConfig(providerInfo);
		if (!config) continue;
		try {
			modelRegistry.registerProvider(providerId, config);
		} catch {
			// Best effort only.
		}
	}
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

type PackageCommand = "install" | "remove" | "update" | "list";

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	local: boolean;
	help: boolean;
	invalidOption?: string;
}

interface IosmInitCommandOptions {
	targetDir?: string;
	force: boolean;
	agentVerify: boolean;
	help: boolean;
	invalidOption?: string;
	extraArg?: string;
}

function applySessionTraceCliOverrides(args: string[]): void {
	let sessionTraceEnabled = false;
	let sessionTraceDir: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--session-trace") {
			sessionTraceEnabled = true;
			continue;
		}
		if (arg === "--session-trace-dir" && index + 1 < args.length) {
			sessionTraceDir = resolve(args[index + 1]);
			index += 1;
		}
	}

	if (sessionTraceEnabled) {
		process.env[ENV_SESSION_TRACE] = "1";
		process.env.PI_SESSION_TRACE = "1";
	}

	if (sessionTraceDir) {
		process.env[ENV_SESSION_TRACE_DIR] = sessionTraceDir;
		process.env.PI_SESSION_TRACE_DIR = sessionTraceDir;
	}
}

type IosmCycleCommand =
	| { kind: "help" }
	| { kind: "list" }
	| { kind: "plan"; goals: string[]; force: boolean; cycleId?: string }
	| { kind: "report"; cycleId?: string }
	| { kind: "status"; cycleId?: string };

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (${CONFIG_DIR_NAME}/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.

Options:
  -l, --local    Remove from project settings (${CONFIG_DIR_NAME}/settings.json)

Example:
  ${APP_NAME} remove npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update installed packages.
If <source> is provided, only that package is updated.
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "install" && command !== "remove" && command !== "update" && command !== "list") {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		}
	}

	return { command, source, local, help, invalidOption };
}

async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.install(source!, { local: options.local });
				packageManager.addSourceToSettings(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				await packageManager.remove(source!, { local: options.local });
				const removed = packageManager.removeSourceFromSettings(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const globalSettings = settingsManager.getGlobalSettings();
				const projectSettings = settingsManager.getProjectSettings();
				const globalPackages = globalSettings.packages ?? [];
				const projectPackages = projectSettings.packages ?? [];

				if (globalPackages.length === 0 && projectPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof globalPackages)[number], scope: "user" | "project") => {
					const source = typeof pkg === "string" ? pkg : pkg.source;
					const filtered = typeof pkg === "object";
					const display = filtered ? `${source} (filtered)` : source;
					console.log(`  ${display}`);
					const path = packageManager.getInstalledPath(source, scope);
					if (path) {
						console.log(chalk.dim(`    ${path}`));
					}
				};

				if (globalPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of globalPackages) {
						formatPackage(pkg, "user");
					}
				}

				if (projectPackages.length > 0) {
					if (globalPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg, "project");
					}
				}

				return true;
			}

			case "update":
				await packageManager.update(source);
				if (source) {
					console.log(chalk.green(`Updated ${source}`));
				} else {
					console.log(chalk.green("Updated packages"));
				}
				return true;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

interface IosmInitAgentVerificationResult {
	completed: boolean;
	skippedReason?: string;
	error?: string;
	current?: IosmMetricSnapshot;
	historyPath?: string;
	tracePath?: string;
	guidePath?: string;
	toolCalls?: number;
}

function getLastAssistantMessage(sessionMessages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = sessionMessages.length - 1; index >= 0; index--) {
		const message = sessionMessages[index];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

async function runIosmInitAgentVerification(
	targetDir: string,
	result: IosmInitResult,
): Promise<IosmInitAgentVerificationResult> {
	if (!result.cycle) {
		return {
			completed: false,
			skippedReason: "No cycle scaffold was available for verification.",
		};
	}

	const cycleId = result.cycle.cycleId;
	// Always enable full trace for this one-shot verifier session.
	process.env[ENV_SESSION_TRACE] = "1";
	process.env.PI_SESSION_TRACE = "1";

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(targetDir, agentDir);
	reportSettingsErrors(settingsManager, "iosm init verify");
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
	await hydrateAuthenticatedProviderModelsOnStartup(modelRegistry);
	const resourceLoader = new DefaultResourceLoader({
		cwd: targetDir,
		agentDir,
		settingsManager,
		contextProfile: "iosm",
		noExtensions: true,
	});
	await resourceLoader.reload();

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: targetDir,
		sessionManager: SessionManager.inMemory(),
		settingsManager,
		authStorage,
		modelRegistry,
		resourceLoader,
	});
	let toolExecutions = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "tool_execution_start") {
			return;
		}
		toolExecutions += 1;
		if (event.toolName === "bash") {
			const commandRaw =
				event.args && typeof event.args === "object" && "command" in event.args
					? String((event.args as { command?: unknown }).command ?? "")
					: "";
			const preview = commandRaw.replace(/\s+/g, " ").trim().slice(0, 68);
			console.log(
				chalk.dim(
					`verify> bash #${toolExecutions}${preview ? ` ${preview}${commandRaw.length > 68 ? "..." : ""}` : ""}`,
				),
			);
			return;
		}
		console.log(chalk.dim(`verify> ${event.toolName} #${toolExecutions}`));
	});

	try {
		if (!session.model) {
			return {
				completed: false,
				skippedReason:
					modelFallbackMessage ??
					"No model available for agent verification. Configure /login or an API key, then re-run init.",
			};
		}

		const verificationPrompt = buildIosmAgentVerificationPrompt(result);
		const timeoutMs = 180_000;
		const startedAt = Date.now();
		const heartbeatMs = 10_000;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
		try {
			console.log(chalk.dim("verify> waiting for model response..."));
			heartbeatHandle = setInterval(() => {
				const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
				if (toolExecutions === 0) {
					console.log(chalk.dim(`verify> waiting for model response... ${elapsedSec}s`));
					return;
				}
				console.log(chalk.dim(`verify> running... ${elapsedSec}s, tool calls=${toolExecutions}`));
			}, heartbeatMs);
			await Promise.race([
				session.prompt(verificationPrompt, {
					expandPromptTemplates: false,
					skipIosmAutopilot: true,
					source: "interactive",
				}),
				new Promise<never>((_resolve, reject) => {
					timeoutHandle = setTimeout(() => {
						reject(new Error(`Verifier timeout after ${Math.round(timeoutMs / 1000)}s.`));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			if (heartbeatHandle) {
				clearInterval(heartbeatHandle);
			}
		}

		const lastAssistant = getLastAssistantMessage(session.state.messages);
		if (
			lastAssistant &&
			(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
		) {
			return {
				completed: false,
				error: lastAssistant.errorMessage ?? `Verifier finished with ${lastAssistant.stopReason}.`,
				tracePath:
					session.sessionTracePath ??
					(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
			};
		}

		let authoredGuide: string | undefined;
		try {
			console.log(chalk.dim("verify> authoring IOSM.md from repository evidence..."));
			await session.prompt(buildIosmGuideAuthoringPrompt(result), {
				expandPromptTemplates: false,
				skipIosmAutopilot: true,
				source: "interactive",
			});
			const guideAssistant = getLastAssistantMessage(session.state.messages);
			const guideText = extractAssistantText(guideAssistant);
			const normalizedGuide = normalizeIosmGuideMarkdown(guideText);
			if (normalizedGuide.trim().length > 0) {
				authoredGuide = normalizedGuide;
			}
		} catch {
			console.log(chalk.dim("verify> IOSM.md authoring failed; using structured fallback"));
		}

		let current: IosmMetricSnapshot | undefined;
		let guidePath: string | undefined;
		try {
			const report = readIosmCycleReport(targetDir, cycleId);
			current = createMetricSnapshot(report);
			if (authoredGuide) {
				guidePath = getIosmGuidePath(targetDir);
				writeFileSync(guidePath, authoredGuide, "utf8");
			} else {
				guidePath = writeIosmGuideDocument(
					{
						rootDir: targetDir,
						cycleId,
						assessmentSource: "verified",
						metrics: report.metrics,
						iosmIndex: report.iosm_index,
						decisionConfidence: report.decision_confidence,
						goals: report.goals,
						filesAnalyzed: result.analysis.files_analyzed,
						sourceFileCount: result.analysis.source_file_count,
						testFileCount: result.analysis.test_file_count,
						docFileCount: result.analysis.doc_file_count,
					},
					true,
				).path;
			}
		} catch {
			current = undefined;
			guidePath = undefined;
		}

		let historyPath: string | undefined;
		try {
			const history = recordIosmCycleHistory(targetDir, cycleId);
			historyPath = history.historyPath;
		} catch {
			historyPath = undefined;
		}

			return {
				completed: true,
				current,
				historyPath,
				guidePath,
				toolCalls: toolExecutions,
				tracePath:
					session.sessionTracePath ??
					(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
			};
	} catch (error: unknown) {
		return {
			completed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		unsubscribe();
		session.dispose();
	}
}

function printIosmInitHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} init [path] [--force] [--no-agent-verify]

Initialize IOSM workspace, analyze the project, run verification, and maintain IOSM.md playbook/checklist.

Options:
  -f, --force            Overwrite scaffold files if they already exist
  --agent-verify         Force post-init agent verification (default)
  --no-agent-verify      Skip post-init agent verification and keep static baseline only

Examples:
  ${APP_NAME} init
  ${APP_NAME} init .
  ${APP_NAME} init ../service-a --force
  ${APP_NAME} init --no-agent-verify
`);
}

function parseIosmInitCommand(args: string[]): IosmInitCommandOptions | undefined {
	const [command, ...rest] = args;
	if (command !== "init") {
		return undefined;
	}

	let targetDir: string | undefined;
	let force = false;
	let agentVerify = true;
	let help = false;
	let invalidOption: string | undefined;
	let extraArg: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-f" || arg === "--force") {
			force = true;
			continue;
		}

		if (arg === "--agent-verify") {
			agentVerify = true;
			continue;
		}

		if (arg === "--no-agent-verify" || arg === "--static-only") {
			agentVerify = false;
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!targetDir) {
			targetDir = arg;
			continue;
		}

		extraArg = extraArg ?? arg;
	}

	return { targetDir, force, agentVerify, help, invalidOption, extraArg };
}

async function handleIosmInitCommand(args: string[]): Promise<boolean> {
	const options = parseIosmInitCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printIosmInitHelp();
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "init".`));
		console.error(chalk.dim(`Use "${APP_NAME} init --help".`));
		process.exitCode = 1;
		return true;
	}

	if (options.extraArg) {
		console.error(chalk.red(`Unexpected argument "${options.extraArg}" for "init".`));
		console.error(chalk.dim(`Use "${APP_NAME} init --help".`));
		process.exitCode = 1;
		return true;
	}

	const targetDir = resolve(options.targetDir ?? process.cwd());
	const result = await initIosmWorkspace({ cwd: targetDir, force: options.force });

	console.log(chalk.green(`Initialized IOSM workspace at ${result.rootDir}`));
	console.log(
		chalk.dim(
			`Analyzed ${result.analysis.files_analyzed} files (${result.analysis.source_file_count} source, ${result.analysis.test_file_count} tests, ${result.analysis.doc_file_count} docs)`,
		),
	);
	if (options.agentVerify) {
		console.log(chalk.dim("Initial heuristic baseline captured (internal)."));
	} else {
		console.log(
			chalk.dim(
				`Heuristic metrics (verification skipped): ${Object.entries(result.analysis.metrics)
					.map(([metric, value]) => `${metric}=${value === null ? "n/a" : value.toFixed(3)}`)
					.join(", ")}`,
			),
		);
	}
	console.log(chalk.dim(`Goals: ${result.analysis.goals.join(" | ")}`));

	if (result.cycle) {
		const cycleLine = result.cycle.reusedExistingCycle
			? `Using existing cycle ${result.cycle.cycleId}`
			: `Seeded cycle ${result.cycle.cycleId}`;
		console.log(chalk.dim(cycleLine));
	}

	let verification: IosmInitAgentVerificationResult | undefined;
	if (options.agentVerify) {
		console.log(chalk.dim("\nRunning post-init agent verification pass..."));
		verification = await runIosmInitAgentVerification(targetDir, result);

		if (verification.completed) {
			console.log(chalk.green("Agent verification completed."));
			if (verification.current) {
				console.log(chalk.dim(`Current IOSM snapshot: ${formatMetricSnapshot(verification.current)}`));
			}
			if (verification.historyPath) {
				console.log(chalk.dim(`Metrics history updated: ${verification.historyPath}`));
			}
			if (verification.guidePath) {
				console.log(chalk.dim(`Playbook updated: ${verification.guidePath}`));
			}
			if (verification.toolCalls !== undefined) {
				console.log(chalk.dim(`Verifier activity: ${verification.toolCalls} tool calls`));
			}
			if (verification.tracePath) {
				console.log(chalk.dim(`Session trace: ${verification.tracePath}`));
			}
		} else if (verification.skippedReason) {
			console.log(chalk.yellow(`Agent verification skipped: ${verification.skippedReason}`));
		} else if (verification.error) {
			console.log(chalk.red(`Agent verification failed: ${verification.error}`));
		}
	}

	let currentSnapshot: IosmMetricSnapshot | undefined = verification?.current;
	if (!currentSnapshot && result.cycle) {
		try {
			currentSnapshot = createMetricSnapshot(readIosmCycleReport(targetDir, result.cycle.cycleId));
		} catch {
			currentSnapshot = undefined;
		}
	}
	currentSnapshot ??= {
		metrics: result.analysis.metrics,
		iosm_index: null,
		decision_confidence: null,
	};
	const checklist = buildIosmPriorityChecklist(currentSnapshot.metrics, 3);
	const guidePath = verification?.guidePath ?? getIosmGuidePath(result.rootDir);
	console.log(chalk.bold("\nInit report:"));
	console.log(`  project: ${result.rootDir}`);
	console.log(
		`  metrics: ${formatMetricSnapshot(currentSnapshot)}`,
	);
	console.log("  top priorities:");
	for (const [index, item] of checklist.entries()) {
		console.log(`    ${index + 1}. ${item.title} (${item.value === null ? "n/a" : item.value.toFixed(3)}) -> ${item.action}`);
	}
	console.log("  key files:");
	console.log(`    playbook: ${guidePath}`);
	console.log(`    iosm config: ${result.rootDir}/iosm.yaml`);
	if (result.cycle) {
		console.log(`    cycle report: ${result.cycle.reportPath}`);
		console.log(`    baseline report: ${result.cycle.baselineReportPath}`);
	}

	if (result.created.length > 0) {
		console.log(chalk.bold("\nCreated:"));
		for (const filePath of result.created) {
			console.log(`  ${filePath}`);
		}
	}
	if (result.overwritten.length > 0) {
		console.log(chalk.bold("\nOverwritten:"));
		for (const filePath of result.overwritten) {
			console.log(`  ${filePath}`);
		}
	}
	if (result.skipped.length > 0) {
		console.log(chalk.bold("\nSkipped:"));
		for (const filePath of result.skipped) {
			console.log(`  ${filePath}`);
		}
	}

	return true;
}

function printIosmCycleHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} cycle list
  ${APP_NAME} cycle plan [--id <cycle-id>] [--force] <goal...>
  ${APP_NAME} cycle report [cycle-id]
  ${APP_NAME} cycle status [cycle-id]

Subcommands:
  list               List known IOSM cycles
  plan               Create a new cycle scaffold with baseline, hypotheses, and report templates
  report             Print a synchronized cycle report as JSON (latest by default)
  status             Show a human-readable completeness and gate summary for a cycle

Examples:
  ${APP_NAME} cycle list
  ${APP_NAME} cycle plan "reduce checkout latency" "remove redundant admin API"
  ${APP_NAME} cycle plan --id iosm-2026-03-06-001 --force "stabilize worker retries"
  ${APP_NAME} cycle report
  ${APP_NAME} cycle report iosm-2026-03-06-001
  ${APP_NAME} cycle status
`);
}

function parseIosmCycleCommand(args: string[]): IosmCycleCommand | undefined {
	const [command, subcommand, ...rest] = args;
	if (command !== "cycle") {
		return undefined;
	}

	if (!subcommand || subcommand === "-h" || subcommand === "--help") {
		return { kind: "help" };
	}

	if (subcommand === "list") {
		if (rest.some((arg) => arg === "-h" || arg === "--help")) {
			return { kind: "help" };
		}
		if (rest.length > 0) {
			throw new Error(`Unexpected arguments for "cycle list": ${rest.join(" ")}`);
		}
		return { kind: "list" };
	}

	if (subcommand === "plan") {
		let force = false;
		let cycleId: string | undefined;
		const goals: string[] = [];

		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index];
			if (arg === "-h" || arg === "--help") {
				return { kind: "help" };
			}
			if (arg === "-f" || arg === "--force") {
				force = true;
				continue;
			}
			if (arg === "--id") {
				if (index + 1 >= rest.length) {
					throw new Error('Missing value for "--id".');
				}
				cycleId = rest[index + 1];
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				throw new Error(`Unknown option for "cycle plan": ${arg}`);
			}
			goals.push(arg);
		}

		return { kind: "plan", goals, force, cycleId };
	}

	if (subcommand === "report") {
		let cycleId: string | undefined;
		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index];
			if (arg === "-h" || arg === "--help") {
				return { kind: "help" };
			}
			if (arg.startsWith("-")) {
				throw new Error(`Unknown option for "cycle report": ${arg}`);
			}
			if (!cycleId) {
				cycleId = arg;
				continue;
			}
			throw new Error(`Unexpected argument for "cycle report": ${arg}`);
		}

		return { kind: "report", cycleId };
	}

	if (subcommand === "status") {
		let cycleId: string | undefined;
		for (let index = 0; index < rest.length; index++) {
			const arg = rest[index];
			if (arg === "-h" || arg === "--help") {
				return { kind: "help" };
			}
			if (arg.startsWith("-")) {
				throw new Error(`Unknown option for "cycle status": ${arg}`);
			}
			if (!cycleId) {
				cycleId = arg;
				continue;
			}
			throw new Error(`Unexpected argument for "cycle status": ${arg}`);
		}

		return { kind: "status", cycleId };
	}

	throw new Error(`Unknown cycle subcommand: ${subcommand}`);
}

function printIosmCycleStatus(cycleId: string, status: ReturnType<typeof inspectIosmCycle>): void {
	console.log(`${chalk.bold("Cycle:")} ${cycleId}`);
	console.log(`${chalk.bold("Status:")} ${status.status}`);
	console.log(`${chalk.bold("Decision:")} ${status.decision}`);
	console.log(`${chalk.bold("Report:")} ${status.reportPath}`);
	console.log(`${chalk.bold("Capacity:")} ${status.capacityPass ? "pass" : "fail"}`);
	console.log(
		`${chalk.bold("Guardrails:")} ${
			status.guardrailsPass === null ? "pending" : status.guardrailsPass ? "pass" : "fail"
		}`,
	);
	console.log(`${chalk.bold("Report Complete:")} ${status.reportComplete ? "yes" : "no"}`);
	console.log(`${chalk.bold("Learning Closed:")} ${status.learningClosed ? "yes" : "no"}`);
	console.log(`${chalk.bold("History Recorded:")} ${status.historyRecorded ? "yes" : "no"}`);

	if (status.blockingIssues.length > 0) {
		console.log(chalk.bold("\nBlocking Issues:"));
		for (const issue of status.blockingIssues) {
			console.log(`  - ${issue}`);
		}
	}

	if (status.warnings.length > 0) {
		console.log(chalk.bold("\nWarnings:"));
		for (const warning of status.warnings) {
			console.log(`  - ${warning}`);
		}
	}
}

async function handleIosmCycleCommand(args: string[]): Promise<boolean> {
	let command: IosmCycleCommand | undefined;
	try {
		command = parseIosmCycleCommand(args);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Invalid cycle command";
		console.error(chalk.red(message));
		console.error(chalk.dim(`Use "${APP_NAME} cycle --help".`));
		process.exitCode = 1;
		return true;
	}

	if (!command) {
		return false;
	}

	if (command.kind === "help") {
		printIosmCycleHelp();
		return true;
	}

	try {
		switch (command.kind) {
			case "list": {
				const cycles = listIosmCycles();
				if (cycles.length === 0) {
					console.log(chalk.dim("No IOSM cycles found."));
					return true;
				}

				for (const cycle of cycles) {
					const goals = cycle.goals.length > 0 ? cycle.goals.join("; ") : "no goals recorded";
					console.log(`${cycle.cycleId}  ${cycle.status}  ${cycle.decision}`);
					console.log(chalk.dim(`  ${goals}`));
				}
				return true;
			}

			case "plan": {
				const planned = planIosmCycle({
					goals: command.goals,
					force: command.force,
					cycleId: command.cycleId,
				});
				console.log(chalk.green(`Planned IOSM cycle ${planned.cycleId}`));
				console.log(`  ${planned.cycleDir}`);
				console.log(chalk.dim(`  baseline: ${planned.baselineReportPath}`));
				console.log(chalk.dim(`  hypotheses: ${planned.hypothesesPath}`));
				console.log(chalk.dim(`  report: ${planned.reportPath}`));
				return true;
			}

			case "report": {
				const report = readIosmCycleReport(process.cwd(), command.cycleId);
				console.log(JSON.stringify(report, null, 2));
				return true;
			}

			case "status": {
				const status = inspectIosmCycle(process.cwd(), command.cycleId);
				printIosmCycleStatus(status.cycleId, status);
				return true;
			}

			default:
				return false;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Cycle command failed";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return {};
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });

	let initialMessage: string;
	if (parsed.messages.length > 0) {
		initialMessage = text + parsed.messages[0];
		parsed.messages.shift();
	} else {
		initialMessage = text;
	}

	return {
		initialMessage,
		initialImages: images.length > 0 ? images : undefined,
	};
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, use as-is
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: sessionArg };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

async function createSessionManager(parsed: Args, cwd: string): Promise<SessionManager | undefined> {
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, parsed.sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, parsed.sessionDir);

			case "global": {
				// Session found in different project - ask user if they want to fork
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return SessionManager.forkFrom(resolved.path, cwd, parsed.sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}
	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
): { options: CreateAgentSessionOptions; cliThinkingFromModel: boolean } {
	const options: CreateAgentSessionOptions = {};
	let cliThinkingFromModel = false;

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
		});
		if (resolved.warning) {
			console.warn(chalk.yellow(`Warning: ${resolved.warning}`));
		}
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		// --no-tools: start with no built-in tools
		// --tools can still add specific ones back
		if (parsed.tools && parsed.tools.length > 0) {
			options.tools = parsed.tools.map((name) => allTools[name]);
		} else {
			options.tools = [];
		}
	} else if (parsed.tools) {
		options.tools = parsed.tools.map((name) => allTools[name]);
	}

	// Agent profile: --profile overrides tool set and thinking level
	// --plan is shorthand for --profile plan
	if (parsed.plan && !parsed.profile) {
		options.profile = "plan";
	} else if (parsed.profile) {
		if (!isValidProfileName(parsed.profile)) {
			console.error(
				chalk.yellow(
					`Warning: Unknown profile "${parsed.profile}". Valid profiles: ${getProfileNames().join(", ")}`,
				),
			);
		} else {
			options.profile = parsed.profile;
		}
	}

	return { options, cliThinkingFromModel };
}

async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

function printMcpConfigWarnings(errors: string[]): void {
	for (const error of errors) {
		console.error(chalk.yellow(`Warning: ${error}`));
	}
}

function formatMcpServerLine(server: ReturnType<typeof loadMergedMcpConfig>["servers"][number]): string {
	const state = server.enabled ? "enabled" : "disabled";
	const endpoint =
		server.transport === "stdio"
			? `${server.command ?? "(missing command)"}${server.args.length > 0 ? ` ${server.args.join(" ")}` : ""}`
			: server.url ?? "(missing url)";
	return `${chalk.bold(server.name)} (${server.scope}, ${server.transport}, ${state})\n  ${chalk.dim(endpoint)}`;
}

async function handleMcpCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mcp") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const subcommand = args[1] ?? "list";
	const rest = args.slice(2);
	const printHelp = () => console.log(getMcpCommandHelp(`${APP_NAME} mcp`));

	if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
		printHelp();
		return true;
	}

	if (subcommand === "list") {
		const merged = loadMergedMcpConfig(cwd, agentDir);
		printMcpConfigWarnings(merged.errors);
		if (merged.servers.length === 0) {
			console.log(chalk.dim("No MCP servers configured. Use `iosm mcp add ...`."));
			return true;
		}
		for (const server of merged.servers) {
			console.log(formatMcpServerLine(server));
		}
		return true;
	}

	if (subcommand === "get") {
		const parsed = parseMcpTargetCommand(rest, "all");
		if (!parsed.ok) {
			if ("help" in parsed) {
				printHelp();
				return true;
			}
			console.error(chalk.red(parsed.error));
			process.exitCode = 1;
			return true;
		}

		const server = getMergedServerByName(parsed.value.name, cwd, agentDir);
		if (!server) {
			console.error(chalk.red(`MCP server "${parsed.value.name}" not found.`));
			process.exitCode = 1;
			return true;
		}

		console.log(JSON.stringify(server, null, 2));
		return true;
	}

	const runtime = new McpRuntime({
		cwd,
		agentDir,
		clientName: APP_NAME,
		clientVersion: VERSION,
	});

	try {
		if (subcommand === "add") {
			const parsed = parseMcpAddCommand(rest);
			if (!parsed.ok) {
				if ("help" in parsed) {
					printHelp();
					return true;
				}
				console.error(chalk.red(parsed.error));
				process.exitCode = 1;
				return true;
			}

			const path = await runtime.addServer(parsed.value.name, parsed.value.scope, parsed.value.config);
			const status = runtime.getServer(parsed.value.name);
			console.log(chalk.green(`Added MCP server "${parsed.value.name}" to ${parsed.value.scope} scope.`));
			console.log(chalk.dim(`Config: ${path}`));
			if (status?.state === "connected") {
				console.log(chalk.dim(`Connected: ${status.toolCount} tool(s)`));
			} else if (status?.state === "error") {
				console.log(chalk.yellow(`Connection warning: ${status.error ?? "unknown error"}`));
			}
			printMcpConfigWarnings(runtime.getErrors());
			return true;
		}

		if (subcommand === "remove") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					printHelp();
					return true;
				}
				console.error(chalk.red(parsed.error));
				process.exitCode = 1;
				return true;
			}

			const removed = await runtime.removeServer(parsed.value.name, parsed.value.scope);
			if (removed.length === 0) {
				console.error(chalk.red(`MCP server "${parsed.value.name}" not found.`));
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green(`Removed MCP server "${parsed.value.name}" from ${removed.join(", ")} scope.`));
			printMcpConfigWarnings(runtime.getErrors());
			return true;
		}

		if (subcommand === "enable" || subcommand === "disable") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					printHelp();
					return true;
				}
				console.error(chalk.red(parsed.error));
				process.exitCode = 1;
				return true;
			}

			const enabled = subcommand === "enable";
			let updatedScope: "project" | "user" | undefined;
			if (parsed.value.scope === "all") {
				updatedScope =
					(await runtime.setServerEnabled(parsed.value.name, enabled, "project")) ??
					(await runtime.setServerEnabled(parsed.value.name, enabled, "user"));
			} else {
				updatedScope = await runtime.setServerEnabled(parsed.value.name, enabled, parsed.value.scope);
			}

			if (!updatedScope) {
				console.error(chalk.red(`MCP server "${parsed.value.name}" not found.`));
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green(`${enabled ? "Enabled" : "Disabled"} MCP server "${parsed.value.name}" (${updatedScope}).`));
			printMcpConfigWarnings(runtime.getErrors());
			return true;
		}

		if (subcommand === "tools") {
			await runtime.refresh();
			printMcpConfigWarnings(runtime.getErrors());
			const serverName = rest[0];
			const statuses = runtime.getServers();
			const targets = serverName ? statuses.filter((server) => server.name === serverName) : statuses;
			if (targets.length === 0) {
				console.error(chalk.red(serverName ? `MCP server "${serverName}" not found.` : "No MCP servers configured."));
				process.exitCode = 1;
				return true;
			}

			for (const server of targets) {
				console.log(chalk.bold(`${server.name} (${server.state})`));
				if (server.state !== "connected") {
					console.log(chalk.dim(`  ${server.error ?? "not connected"}`));
					continue;
				}
				if (server.tools.length === 0) {
					console.log(chalk.dim("  No tools exposed."));
					continue;
				}
				for (const tool of server.tools) {
					const aliasSuffix = tool.name === tool.exposedName ? "" : ` -> ${tool.exposedName}`;
					console.log(`  - ${tool.name}${aliasSuffix}`);
				}
			}
			return true;
		}

		if (subcommand === "test") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					printHelp();
					return true;
				}
				console.error(chalk.red(parsed.error));
				process.exitCode = 1;
				return true;
			}

			await runtime.refresh();
			printMcpConfigWarnings(runtime.getErrors());
			const status = runtime.getServer(parsed.value.name);
			if (!status) {
				console.error(chalk.red(`MCP server "${parsed.value.name}" not found.`));
				process.exitCode = 1;
				return true;
			}
			if (status.state !== "connected") {
				console.error(chalk.red(`MCP server "${parsed.value.name}" failed: ${status.error ?? "unknown error"}`));
				process.exitCode = 1;
				return true;
			}
			console.log(chalk.green(`MCP server "${parsed.value.name}" is connected (${status.toolCount} tool(s)).`));
			return true;
		}

		console.error(chalk.red(`Unknown MCP subcommand "${subcommand}".`));
		printHelp();
		process.exitCode = 1;
		return true;
	} finally {
		await runtime.dispose();
	}
}

function printSemanticConfigMissing(error: SemanticConfigMissingError): void {
	console.error(chalk.yellow("Semantic search is not configured."));
	console.error(chalk.dim(`User config: ${error.userConfigPath}`));
	console.error(chalk.dim(`Project config: ${error.projectConfigPath}`));
	console.error(chalk.dim("Run /semantic setup in interactive mode, or create one of the config files."));
}

function printSemanticStatus(status: SemanticStatusResult): void {
	console.log(chalk.bold("Semantic search status"));
	console.log(`configured: ${status.configured ? "yes" : "no"}`);
	console.log(`enabled: ${status.enabled ? "yes" : "no"}`);
	console.log(`auto_index: ${status.autoIndex ? "on" : "off"}`);
	console.log(`indexed: ${status.indexed ? "yes" : "no"}`);
	console.log(`stale: ${status.stale ? `yes${status.staleReason ? ` (${status.staleReason})` : ""}` : "no"}`);
	if (status.provider) console.log(`provider: ${status.provider}`);
	if (status.model) console.log(`model: ${status.model}`);
	console.log(`files: ${status.files}`);
	console.log(`chunks: ${status.chunks}`);
	if (status.dimension !== undefined) console.log(`dimension: ${status.dimension}`);
	if (status.ageSeconds !== undefined) console.log(`age_seconds: ${status.ageSeconds}`);
	console.log(`index_path: ${status.indexPath}`);
	console.log(`config_user: ${status.configPathUser}`);
	console.log(`config_project: ${status.configPathProject}`);
	if (!status.configured) {
		console.log(chalk.dim("Hint: /semantic setup (interactive) or create semantic config JSON manually."));
	}
}

function printSemanticIndexResult(result: SemanticIndexOperationResult): void {
	console.log(chalk.green(`${result.action} completed.`));
	console.log(`processed_files: ${result.processedFiles}`);
	console.log(`reused_files: ${result.reusedFiles}`);
	console.log(`new_files: ${result.newFiles}`);
	console.log(`changed_files: ${result.changedFiles}`);
	console.log(`removed_files: ${result.removedFiles}`);
	console.log(`chunks: ${result.chunks}`);
	console.log(`dimension: ${result.dimension}`);
	console.log(`duration_ms: ${result.durationMs}`);
	console.log(`built_at: ${result.builtAt}`);
	console.log(`index_path: ${result.indexPath}`);
}

function printSemanticQueryResult(result: SemanticQueryResult): void {
	console.log(chalk.bold(`Semantic query: ${result.query}`));
	console.log(`top_k: ${result.topK}`);
	console.log(`auto_refreshed: ${result.autoRefreshed ? "yes" : "no"}`);
	if (result.hits.length === 0) {
		console.log(chalk.dim("No semantic matches found."));
		return;
	}
	for (let index = 0; index < result.hits.length; index++) {
		const hit = result.hits[index]!;
		console.log(
			`${index + 1}. score=${hit.score.toFixed(4)} ${hit.path}:${hit.lineStart}-${hit.lineEnd}\n   ${hit.snippet}`,
		);
	}
}

async function handleSemanticCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "semantic") {
		return false;
	}

	const parsed = parseSemanticCliCommand(args.slice(1));
	if (!parsed.ok) {
		console.error(chalk.red(parsed.error));
		console.error(chalk.dim(`Use "${APP_NAME} semantic help".`));
		process.exitCode = 1;
		return true;
	}

	if (parsed.value.kind === "help") {
		console.log(getSemanticCommandHelp(`${APP_NAME} semantic`));
		return true;
	}

	const runtime = new SemanticSearchRuntime({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		authStorage: AuthStorage.create(),
	});

	try {
		if (parsed.value.kind === "status") {
			const status = await runtime.status();
			printSemanticStatus(status);
			return true;
		}

		if (parsed.value.kind === "index") {
			const result = await runtime.index();
			printSemanticIndexResult(result);
			return true;
		}

		if (parsed.value.kind === "rebuild") {
			const result = await runtime.rebuild();
			printSemanticIndexResult(result);
			return true;
		}

		const result = await runtime.query(parsed.value.query, parsed.value.topK);
		printSemanticQueryResult(result);
		return true;
	} catch (error) {
		if (error instanceof SemanticConfigMissingError) {
			printSemanticConfigMissing(error);
			process.exitCode = 1;
			return true;
		}
		if (error instanceof SemanticRebuildRequiredError) {
			console.error(chalk.yellow(error.message));
			console.error(chalk.dim(`Run "${APP_NAME} semantic rebuild".`));
			process.exitCode = 1;
			return true;
		}
		if (error instanceof SemanticIndexRequiredError) {
			console.error(chalk.yellow(error.message));
			console.error(chalk.dim(`Run "${APP_NAME} semantic index" or enable auto-indexing in "/semantic".`));
			process.exitCode = 1;
			return true;
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Semantic command failed: ${message}`));
		process.exitCode = 1;
		return true;
	}
}

export async function main(args: string[]) {
	applySessionTraceCliOverrides(args);

	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env[ENV_OFFLINE]) || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env[ENV_OFFLINE] = "1";
		process.env[ENV_SKIP_VERSION_CHECK] = "1";
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (await handleIosmInitCommand(args)) {
		return;
	}

	if (await handleIosmCycleCommand(args)) {
		return;
	}

	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleMcpCommand(args)) {
		return;
	}

	if (await handleSemanticCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());

	// First pass: parse args to get --extension paths
	const firstPass = parseArgs(args);
	const firstPassProfile = firstPass.profile ?? (firstPass.plan ? "plan" : "full");
	const contextProfile = firstPassProfile.toLowerCase() === "iosm" ? "iosm" : "standard";

	// Early load extensions to discover their CLI flags
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "startup");
	const authStorage = AuthStorage.create();
	const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
	await hydrateAuthenticatedProviderModelsOnStartup(modelRegistry);

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		contextProfile,
		additionalExtensionPaths: firstPass.extensions,
		additionalSkillPaths: firstPass.skills,
		additionalPromptTemplatePaths: firstPass.promptTemplates,
		additionalThemePaths: firstPass.themes,
		noExtensions: firstPass.noExtensions,
		noSkills: firstPass.noSkills,
		noPromptTemplates: firstPass.noPromptTemplates,
		noThemes: firstPass.noThemes,
		systemPrompt: firstPass.systemPrompt,
		appendSystemPrompt: firstPass.appendSystemPrompt,
	});
	await resourceLoader.reload();
	time("resourceLoader.reload");

	const extensionsResult: LoadExtensionsResult = resourceLoader.getExtensions();
	for (const { path, error } of extensionsResult.errors) {
		console.error(chalk.red(`Failed to load extension "${path}": ${error}`));
	}

	// Apply pending provider registrations from extensions immediately
	// so they're available for model resolution before AgentSession is created
	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];

	const extensionFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const ext of extensionsResult.extensions) {
		for (const [name, flag] of ext.flags) {
			extensionFlags.set(name, { type: flag.type });
		}
	}

	// Second pass: parse args with extension flags
	const parsed = parseArgs(args, extensionFlags);

	// Pass flag values to extensions via runtime
	for (const [name, value] of parsed.unknownFlags) {
		extensionsResult.runtime.flagValues.set(name, value);
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.help) {
		printHelp();
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	if (parsed.mode !== "rpc") {
		const stdinContent = await readPipedStdin();
		if (stdinContent !== undefined) {
			// Force print mode since interactive mode requires a TTY for keyboard input
			parsed.print = true;
			// Prepend stdin content to messages
			parsed.messages.unshift(stdinContent);
		}
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize());
	const isInteractive = !parsed.print && parsed.mode === undefined;
	const mode = parsed.mode || "text";
	initTheme(settingsManager.getTheme(), isInteractive);

	// Show deprecation warnings in interactive mode
	if (isInteractive && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
	}

	// Create session manager based on CLI flags
	let sessionManager = await createSessionManager(parsed, cwd);

	// Handle --resume: show session picker
	if (parsed.resume) {
		// Initialize keybindings so session picker respects user config
		KeybindingsManager.create();

		const selectedPath = await selectSession(
			(onProgress) => SessionManager.list(cwd, parsed.sessionDir, onProgress),
			SessionManager.listAll,
		);
		if (!selectedPath) {
			console.log(chalk.dim("No session selected"));
			stopThemeWatcher();
			process.exit(0);
		}
		sessionManager = SessionManager.open(selectedPath);
	}

	const { options: sessionOptions, cliThinkingFromModel } = buildSessionOptions(
		parsed,
		scopedModels,
		sessionManager,
		modelRegistry,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.resourceLoader = resourceLoader;
	sessionOptions.enableAskUserTool = isInteractive || mode === "rpc";

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsed.apiKey) {
		if (!sessionOptions.model) {
			console.error(
				chalk.red("--api-key requires a model to be specified via --model (optionally with --provider)"),
			);
			process.exit(1);
		}
		authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
	}

	let mcpRuntime: McpRuntime | undefined;
	try {
		mcpRuntime = new McpRuntime({
			cwd,
			agentDir,
			clientName: APP_NAME,
			clientVersion: VERSION,
		});
		await mcpRuntime.refresh();
		printMcpConfigWarnings(mcpRuntime.getErrors());
		const mcpTools = mcpRuntime.getToolDefinitions();
		if (mcpTools.length > 0) {
			sessionOptions.customTools = [...(sessionOptions.customTools ?? []), ...mcpTools];
		}

		const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);

		if (!isInteractive && !session.model) {
			console.error(chalk.red("No model selected."));
			console.error(chalk.yellow("\nSelect one explicitly:"));
			console.error(`  ${APP_NAME} --provider <provider> --model <model-id> ...`);
			console.error(`  ${APP_NAME} --model <provider/model-id> ...`);
			console.error(chalk.yellow("\nFor interactive mode, launch and choose with /model."));
			console.error(chalk.dim(`Configured models file: ${getModelsPath()}`));
			process.exit(1);
		}

		// Clamp thinking level to model capabilities for CLI-provided thinking levels.
		// This covers both --thinking <level> and --model <pattern>:<thinking>.
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (session.model && cliThinkingOverride) {
			let effectiveThinking = session.thinkingLevel;
			if (!session.model.reasoning) {
				effectiveThinking = "off";
			} else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
				effectiveThinking = "high";
			}
			if (effectiveThinking !== session.thinkingLevel) {
				session.setThinkingLevel(effectiveThinking);
			}
		}

		if (mode === "rpc") {
			await runRpcMode(session);
		} else if (isInteractive) {
			if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
				const modelList = scopedModels
					.map((sm) => {
						const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
						return `${sm.model.id}${thinkingStr}`;
					})
					.join(", ");
				console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
			}

			printTimings();
			const mode = new InteractiveMode(session, {
				migratedProviders,
				modelFallbackMessage,
				initialMessage,
				initialImages,
				initialMessages: parsed.messages,
				verbose: parsed.verbose,
				planMode: parsed.plan,
				profile: sessionOptions.profile,
				mcpRuntime,
			});
			await mode.run();
		} else {
			await runPrintMode(session, {
				mode,
				messages: parsed.messages,
				initialMessage,
				initialImages,
			});
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
		}
	} finally {
		await mcpRuntime?.dispose();
	}
}

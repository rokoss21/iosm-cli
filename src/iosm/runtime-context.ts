import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectIosmCycle, listIosmCycles, planIosmCycle, readIosmCycleReport } from "./cycle.js";
import { findIosmRootDir } from "./config.js";
import { initIosmWorkspace } from "./init.js";
import { getIosmGuidePath } from "./paths.js";

export interface IosmRuntimeDirectiveInput {
	userGoal: string;
	cwd: string;
	rootDir?: string;
	playbookPath?: string;
	shouldOrchestrate: boolean;
	autoInitialized: boolean;
	autoPlannedCycleId?: string;
	activeCycleId?: string;
	cycleStatusSummary?: string;
	metricSnapshot?: string;
	iosmIndex?: number | null;
	decisionConfidence?: number | null;
	runtimeError?: string;
}

export function isLikelyIosmOperationalPrompt(text: string): boolean {
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/[!?.]+$/g, "");
	if (!normalized) {
		return false;
	}

	const lightweightMessages = new Set([
		"hi",
		"hello",
		"hey",
		"thanks",
		"thank you",
		"ok",
		"okay",
		"ага",
		"да",
		"нет",
		"ок",
		"понял",
		"привет",
		"здравствуйте",
		"спасибо",
	]);
	if (lightweightMessages.has(normalized)) {
		return false;
	}

	const words = normalized.split(/\s+/).filter(Boolean);
	if (words.length <= 1 && normalized.length < 12) {
		return false;
	}
	return true;
}

function isLikelyProjectWorkspace(cwd: string): boolean {
	const markers = [
		".git",
		"package.json",
		"pyproject.toml",
		"go.mod",
		"Cargo.toml",
		"pom.xml",
		"build.gradle",
		"Gemfile",
		"requirements.txt",
		"Makefile",
	];
	return markers.some((marker) => existsSync(join(cwd, marker)));
}

function resolveAutoInitTargetDir(startDir: string): string | undefined {
	let currentDir = resolve(startDir);
	for (;;) {
		if (isLikelyProjectWorkspace(currentDir)) {
			return currentDir;
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}
		currentDir = parentDir;
	}
}

export function normalizeIosmGoalFromPrompt(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= 220) {
		return compact;
	}
	return `${compact.slice(0, 217).trimEnd()}...`;
}

export function buildIosmRuntimeDirective(input: IosmRuntimeDirectiveInput): string {
	const lines: string[] = [
		"[IOSM runtime context for next turn]",
		`cwd: ${input.cwd}`,
		`iosm_root: ${input.rootDir ?? "none"}`,
		`iosm_playbook: ${input.playbookPath ?? "none"}`,
		`request_goal: ${input.userGoal}`,
		`actionable_request: ${input.shouldOrchestrate ? "yes" : "no"}`,
		`auto_initialized_this_turn: ${input.autoInitialized ? "yes" : "no"}`,
		`active_cycle_id: ${input.activeCycleId ?? "none"}`,
		`auto_planned_cycle_id: ${input.autoPlannedCycleId ?? "none"}`,
		`cycle_status: ${input.cycleStatusSummary ?? "unknown"}`,
		`cycle_metrics: ${input.metricSnapshot ?? "unknown"}`,
		`iosm_index: ${input.iosmIndex === undefined || input.iosmIndex === null ? "n/a" : input.iosmIndex.toFixed(3)}`,
		`decision_confidence: ${
			input.decisionConfidence === undefined || input.decisionConfidence === null
				? "n/a"
				: input.decisionConfidence.toFixed(3)
		}`,
	];

	if (input.runtimeError) {
		lines.push(`runtime_error: ${input.runtimeError}`);
	}

	lines.push(
		"MUST behavior:",
		"- The IOSM runtime data above is internal execution context. Do not surface it to the user unless they ask for IOSM specifics or it is needed to explain a decision or blocker.",
		"- Behave like a professional, direct engineering agent in user-facing replies.",
		"- For actionable engineering requests, use IOSM order internally: Improve -> Optimize -> Shrink -> Modularize.",
		"- Explain outcomes in normal engineering language: what you inspected, what you changed, what you verified, and any remaining risk or blocker.",
		"- Do not volunteer IOSM metrics, indices, confidence scores, phase names, or artifact details unless they are explicitly requested or materially relevant.",
		"- Mention IOSM artifacts only when they changed, affect the implementation, or the user asked about them.",
		"- Do not behave as a generic assistant: inspect project/code/artifacts first, then execute changes.",
		"- Read IOSM.md playbook first on actionable turns and keep its checklist synchronized.",
		"- If IOSM files were scaffolded, refine iosm.yaml, cycle scope, and hypotheses from the real project/task before deep implementation.",
		"- Keep IOSM artifacts synchronized with implementation changes (cycle report, hypotheses, phase reports, and metric/guardrail evidence placeholders).",
		"- Do not start with docs lookup unless explicitly requested or blocked.",
		"- Begin substantive work with a short execution plan, then carry it through without unnecessary back-and-forth.",
		"- Prefer targeted repository reads/searches over broad listings and keep tool output bounded.",
		"- IOSM Execution Contract: prefer minimal, surgical edits and explicit evidence over broad rewrites.",
		"- IOSM Execution Contract: for existing files, default to edit/apply_patch; use write only for new files or intentional full rewrites.",
		"- IOSM Execution Contract: if an existing file must be fully rewritten, make that intent explicit (overwriteExisting=true + rewriteReason).",
		"- IOSM Execution Contract: preserve unrelated user modifications and do not revert them unless explicitly requested.",
		"- After edits, run the smallest meaningful verification and report the exact check that passed or failed.",
		"- Do not declare completion without evidence; if verification was not possible, say so explicitly.",
	);

	if (!input.shouldOrchestrate) {
		lines.push(
			"- Current message is conversational/lightweight: answer normally and briefly; do not force IOSM framing or artifact churn.",
		);
	}

	return lines.join("\n");
}

export async function prepareIosmRuntimeContext(cwd: string, userInput: string): Promise<IosmRuntimeDirectiveInput> {
	const shouldOrchestrate = isLikelyIosmOperationalPrompt(userInput);
	const userGoal = normalizeIosmGoalFromPrompt(userInput);

	let rootDir = findIosmRootDir(cwd);
	let playbookPath: string | undefined;
	let autoInitialized = false;
	let autoPlannedCycleId: string | undefined;
	let activeCycleId: string | undefined;
	let cycleStatusSummary: string | undefined;
	let metricSnapshot: string | undefined;
	let iosmIndex: number | null | undefined;
	let decisionConfidence: number | null | undefined;
	let runtimeError: string | undefined;

	try {
		if (!rootDir && shouldOrchestrate) {
			const autoInitDir = resolveAutoInitTargetDir(cwd);
			if (autoInitDir) {
				const initResult = await initIosmWorkspace({ cwd: autoInitDir });
				rootDir = initResult.rootDir;
				autoInitialized = true;
			}
		}

		if (rootDir) {
			playbookPath = getIosmGuidePath(rootDir);
			const cycles = listIosmCycles(rootDir);
			if (cycles.length > 0) {
				activeCycleId = cycles[0].cycleId;
			}

			if (shouldOrchestrate && (cycles.length === 0 || cycles[0].status !== "active")) {
				const planned = planIosmCycle({
					cwd: rootDir,
					goals: [userGoal],
				});
				autoPlannedCycleId = planned.cycleId;
				activeCycleId = planned.cycleId;
			}

			if (activeCycleId) {
				const status = inspectIosmCycle(rootDir, activeCycleId);
				cycleStatusSummary = `${status.status}; decision=${status.decision}; report_complete=${status.reportComplete ? "yes" : "no"}; blocking=${status.blockingIssues.length}; warnings=${status.warnings.length}`;
				const report = readIosmCycleReport(rootDir, activeCycleId);
				metricSnapshot = Object.entries(report.metrics)
					.map(([metric, value]) => `${metric}=${value === null ? "n/a" : value.toFixed(3)}`)
					.join(", ");
				iosmIndex = report.iosm_index;
				decisionConfidence = report.decision_confidence;
			}
		}
	} catch (error: unknown) {
		runtimeError = error instanceof Error ? error.message : String(error);
	}

	return {
		userGoal,
		cwd,
		rootDir,
		playbookPath,
		shouldOrchestrate,
		autoInitialized,
		autoPlannedCycleId,
		activeCycleId,
		cycleStatusSummary,
		metricSnapshot,
		iosmIndex,
		decisionConfidence,
		runtimeError,
	};
}

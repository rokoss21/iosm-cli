import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IOSM_METRICS } from "./metrics.js";
import { getIosmGuidePath } from "./paths.js";
import type { IosmMetric, IosmMetricRecord } from "./types.js";

const METRIC_TITLES: Record<IosmMetric, string> = {
	semantic: "Semantic",
	logic: "Logic",
	performance: "Performance",
	simplicity: "Simplicity",
	modularity: "Modularity",
	flow: "Flow",
};

const METRIC_ACTIONS: Record<IosmMetric, string> = {
	semantic: "Clarify glossary/domain language and improve docs for public APIs.",
	logic: "Add or fix automated tests for critical paths and invariants.",
	performance: "Add runtime measurements/benchmarks and enforce SLO budgets.",
	simplicity: "Reduce complexity in large files/functions and simplify API surface.",
	modularity: "Split boundaries and reduce coupling between modules.",
	flow: "Establish VCS + CI/CD workflow and a repeatable release cadence.",
};

function formatMetricValue(value: number | null | undefined): string {
	return value === undefined || value === null ? "n/a" : value.toFixed(3);
}

function metricStatus(value: number | null): string {
	if (value === null) {
		return "unknown";
	}
	if (value < 0.55) {
		return "critical";
	}
	if (value < 0.75) {
		return "watch";
	}
	return "stable";
}

function metricSortScore(value: number | null): number {
	return value === null ? -1 : value;
}

export interface IosmPriorityChecklistItem {
	metric: IosmMetric;
	value: number | null;
	title: string;
	action: string;
}

export interface IosmGuideDocumentInput {
	rootDir: string;
	cycleId?: string;
	assessmentSource: "heuristic" | "verified";
	metrics: IosmMetricRecord<number | null>;
	iosmIndex?: number | null;
	decisionConfidence?: number | null;
	goals?: string[];
	filesAnalyzed?: number;
	sourceFileCount?: number;
	testFileCount?: number;
	docFileCount?: number;
	tracePath?: string;
	historyPath?: string;
}

export interface IosmGuideWriteResult {
	path: string;
	existed: boolean;
	written: boolean;
}

export interface AgentsGuideDocumentInput {
	rootDir: string;
	cycleId?: string;
	assessmentSource: "heuristic" | "verified";
	iosmIndex?: number | null;
	decisionConfidence?: number | null;
	goals?: string[];
	filesAnalyzed?: number;
	sourceFileCount?: number;
	testFileCount?: number;
	docFileCount?: number;
}

const AGENTS_MANAGED_START = "<!-- iosm-init:managed:start -->";
const AGENTS_MANAGED_END = "<!-- iosm-init:managed:end -->";

function upsertManagedBlock(content: string, startMarker: string, endMarker: string, block: string): string {
	const startIndex = content.indexOf(startMarker);
	const endIndex = content.indexOf(endMarker);
	if (startIndex >= 0 && endIndex > startIndex) {
		const suffixStart = endIndex + endMarker.length;
		const prefix = content.slice(0, startIndex).trimEnd();
		const suffix = content.slice(suffixStart).trimStart();
		if (!suffix) {
			return `${prefix}\n\n${block}\n`;
		}
		return `${prefix}\n\n${block}\n\n${suffix}\n`;
	}
	return `${content.trimEnd()}\n\n${block}\n`;
}

export function buildIosmPriorityChecklist(
	metrics: IosmMetricRecord<number | null>,
	limit: number = 3,
): IosmPriorityChecklistItem[] {
	return IOSM_METRICS.map((metric) => ({
		metric,
		value: metrics[metric],
		title: METRIC_TITLES[metric],
		action: METRIC_ACTIONS[metric],
	}))
		.sort((left, right) => metricSortScore(left.value) - metricSortScore(right.value))
		.slice(0, Math.max(1, Math.min(limit, IOSM_METRICS.length)));
}

export function buildIosmGuideDocument(input: IosmGuideDocumentInput): string {
	const nowIso = new Date().toISOString();
	const goals = input.goals ?? [];

	// Build sorted metrics table (worst-first)
	const sortedMetrics = IOSM_METRICS.slice().sort(
		(a, b) => metricSortScore(input.metrics[a]) - metricSortScore(input.metrics[b]),
	);

	// Priority actions: top 3 worst metrics
	const priorities = buildIosmPriorityChecklist(input.metrics, 3);

	const lines: string[] = [
		"# IOSM.md",
		"",
		"This file provides IOSM operational context to the agent for this project.",
		`Updated: ${nowIso}`,
		"",
		"## Project Status",
		`- Root: ${input.rootDir}`,
		`- Active cycle: ${input.cycleId ?? "none"}`,
		`- IOSM-Index: ${formatMetricValue(input.iosmIndex)} (Confidence: ${formatMetricValue(input.decisionConfidence)})`,
		`- Assessment: ${input.assessmentSource} · Files analyzed: ${input.filesAnalyzed ?? "n/a"}`,
		"",
		"## Metric Scores",
		"| Metric | Score | Status | Priority Action |",
		"|--------|-------|--------|-----------------|",
	];

	for (const metric of sortedMetrics) {
		lines.push(
			`| ${METRIC_TITLES[metric]} | ${formatMetricValue(input.metrics[metric])} | ${metricStatus(input.metrics[metric])} | ${METRIC_ACTIONS[metric]} |`,
		);
	}

	lines.push("", "## Priority Actions (this cycle)");
	for (const [index, item] of priorities.entries()) {
		lines.push(
			`${index + 1}. **${item.title} (${formatMetricValue(item.value)} — ${metricStatus(item.value)})**: ${item.action}`,
		);
	}

	if (goals.length > 0) {
		lines.push("", "## Active Goals");
		for (const goal of goals) {
			lines.push(`- ${goal}`);
		}
	}

	lines.push(
		"",
		"## IOSM Workspace",
		`- Config: \`iosm.yaml\``,
		`- Metrics history: \`.iosm/metrics-history.jsonl\``,
	);

	if (input.cycleId) {
		lines.push(
			`- Current cycle: \`.iosm/cycles/${input.cycleId}/\``,
			`  - Baseline: \`baseline-report.json\``,
			`  - Hypotheses: \`hypotheses.json\``,
			`  - Phase reports: \`phase-reports/improve.json\` etc.`,
		);
	}

	lines.push(
		`- Invariants: \`.iosm/invariants.yaml\``,
		`- Contracts: \`.iosm/contracts.yaml\``,
		`- Decision log: \`.iosm/decision-log.md\``,
		`- Pattern library: \`.iosm/pattern-library.md\``,
	);

	lines.push(
		"",
		"## Agent Contract",
		"- At the start of each engineering turn: re-read this file and the active cycle report.",
		"- After each meaningful change: update metric evidence, hypotheses outcome, and phase report.",
		"- Gate progression requires evidence, not just code changes.",
		"- Phases run in order: Improve → Optimize → Shrink → Modularize.",
		"- Quality gates: gate_I (improve), gate_O (optimize), gate_S (shrink), gate_M (modularize).",
	);

	return `${lines.join("\n")}\n`;
}

export function buildAgentsGuideDocument(input: AgentsGuideDocumentInput, existingContent?: string): string {
	const nowIso = new Date().toISOString();
	const goals = input.goals ?? [];
	const projectName = basename(input.rootDir);
	const filesSummary = `${input.filesAnalyzed ?? "n/a"} total · ${input.sourceFileCount ?? "n/a"} src · ${input.testFileCount ?? "n/a"} tests · ${input.docFileCount ?? "n/a"} docs`;

	const managedBlock = [
		AGENTS_MANAGED_START,
		"## IOSM Sync (managed)",
		`- Updated: ${nowIso}`,
		`- Assessment: ${input.assessmentSource}`,
		`- Active cycle: ${input.cycleId ?? "none"}`,
		`- IOSM-Index: ${formatMetricValue(input.iosmIndex)} (confidence: ${formatMetricValue(input.decisionConfidence)})`,
		`- Files analyzed: ${filesSummary}`,
		"",
		"### Current focus",
		...(goals.length > 0 ? goals.map((goal) => `- ${goal}`) : ["- Unknown"]),
		"",
		"### Notes",
		"- This section is auto-updated by `iosm init`/`/init`.",
		"- Keep project-specific contributor/agent rules outside this block.",
		AGENTS_MANAGED_END,
	].join("\n");

	const normalizedExisting = existingContent?.trim();
	if (normalizedExisting && normalizedExisting.length > 0) {
		return upsertManagedBlock(normalizedExisting, AGENTS_MANAGED_START, AGENTS_MANAGED_END, managedBlock);
	}

	const lines = [
		"# AGENTS.md",
		"",
		"This file captures practical collaboration rules for human and AI agents in this repository.",
		"",
		"## Project",
		`- Name: ${projectName}`,
		`- Root: ${input.rootDir}`,
		"",
		"## Working Agreement",
		"- Inspect relevant files before editing.",
		"- Keep edits minimal and verify with targeted checks.",
		"- Prefer explicit commands and absolute file paths in reports.",
		"",
		managedBlock,
	];
	return `${lines.join("\n")}\n`;
}

export function writeIosmGuideDocument(
	input: IosmGuideDocumentInput,
	overwrite: boolean,
): IosmGuideWriteResult {
	const filePath = getIosmGuidePath(input.rootDir);
	const existed = existsSync(filePath);
	if (existed && !overwrite) {
		return { path: filePath, existed, written: false };
	}
	writeFileSync(filePath, buildIosmGuideDocument(input), "utf8");
	return { path: filePath, existed, written: true };
}

export function writeAgentsGuideDocument(
	input: AgentsGuideDocumentInput,
	overwrite: boolean,
): IosmGuideWriteResult {
	const filePath = join(input.rootDir, "AGENTS.md");
	const existed = existsSync(filePath);
	if (existed && !overwrite) {
		return { path: filePath, existed, written: false };
	}

	const existingContent = existed ? readFileSync(filePath, "utf8") : undefined;
	writeFileSync(filePath, buildAgentsGuideDocument(input, existingContent), "utf8");
	return { path: filePath, existed, written: true };
}

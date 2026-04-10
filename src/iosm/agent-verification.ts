import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { IosmInitResult } from "./init.js";
import { IOSM_METRICS } from "./metrics.js";
import type { IosmCycleReport, IosmMetricRecord } from "./types.js";

export interface IosmMetricSnapshot {
	metrics: IosmMetricRecord<number | null>;
	iosm_index: number | null;
	decision_confidence: number | null;
}

function formatMetricValue(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(3);
}

export function createMetricSnapshot(
	report: Pick<IosmCycleReport, "metrics" | "iosm_index" | "decision_confidence">,
): IosmMetricSnapshot {
	return {
		metrics: report.metrics,
		iosm_index: report.iosm_index,
		decision_confidence: report.decision_confidence,
	};
}

export function formatMetricSnapshot(snapshot: IosmMetricSnapshot): string {
	const metricLine = IOSM_METRICS.map((metric) => `${metric}=${formatMetricValue(snapshot.metrics[metric])}`).join(", ");
	return `${metricLine}, iosm_index=${formatMetricValue(snapshot.iosm_index)}, confidence=${formatMetricValue(snapshot.decision_confidence)}`;
}

export function summarizeMetricDelta(before?: IosmMetricSnapshot, after?: IosmMetricSnapshot): string[] {
	if (!before || !after) {
		return [];
	}

	const lines: string[] = [];
	for (const metric of IOSM_METRICS) {
		const left = before.metrics[metric];
		const right = after.metrics[metric];
		if (left === right) {
			continue;
		}
		lines.push(`${metric}: ${formatMetricValue(left)} -> ${formatMetricValue(right)}`);
	}

	if (before.iosm_index !== after.iosm_index) {
		lines.push(`iosm_index: ${formatMetricValue(before.iosm_index)} -> ${formatMetricValue(after.iosm_index)}`);
	}

	if (before.decision_confidence !== after.decision_confidence) {
		lines.push(
			`decision_confidence: ${formatMetricValue(before.decision_confidence)} -> ${formatMetricValue(after.decision_confidence)}`,
		);
	}

	return lines;
}

export function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) {
		return "";
	}

	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

export function buildIosmAgentVerificationPrompt(initResult: IosmInitResult): string {
	const cycleId = initResult.cycle?.cycleId ?? "unknown-cycle";
	const cycleReportPath =
		initResult.cycle?.reportPath ??
		`${initResult.rootDir}/.iosm/cycles/${cycleId}/cycle-report.json`;
	const baselineReportPath =
		initResult.cycle?.baselineReportPath ??
		`${initResult.rootDir}/.iosm/cycles/${cycleId}/baseline-report.json`;
	const metricsLine = IOSM_METRICS.map(
		(metric) => `${metric}=${formatMetricValue(initResult.analysis.metrics[metric])}`,
	).join(", ");
	const goalsLine = initResult.analysis.goals.length > 0 ? initResult.analysis.goals.join(" | ") : "none";
	const rawGroups = Object.keys(initResult.analysis.raw_measurements).sort();
	const rawGroupsLine = rawGroups.length > 0 ? rawGroups.join(", ") : "none";

	return [
		"You are running an IOSM post-init verification pass.",
		`Repository root: ${initResult.rootDir}`,
		`Cycle id: ${cycleId}`,
		"",
		"Objective:",
		"- Verify and refine IOSM metrics using concrete repository evidence.",
		"- Correct IOSM artifacts so baseline is not heuristic-only.",
		"",
		"Required workflow:",
		"1. Read current IOSM artifacts:",
		`   - ${cycleReportPath}`,
		`   - ${baselineReportPath}`,
		`   - ${initResult.rootDir}/.iosm/decision-log.md`,
		`   - ${initResult.rootDir}/.iosm/pattern-library.md`,
		`   - ${initResult.rootDir}/IOSM.md`,
		"2. Collect evidence with deterministic repository checks (bash/read tools, rg/find/stat/cat).",
		"3. Update only existing .iosm artifacts in this pass. Do not modify product source code.",
		`4. Update ${cycleReportPath} (do not create alternate files like report.json).`,
		"5. Ensure cycle report fields are fully populated and consistent:",
		"   metrics, metric_confidences, metric_tiers, raw_measurements, iosm_index, decision_confidence.",
		"6. Keep confidence conservative unless evidence is concrete and reproducible.",
		`7. Validate JSON after edits: python3 -m json.tool ${cycleReportPath} >/dev/null`,
			"8. Keep checks focused and bounded: avoid full repository listings and cap command output with head/tail/wc.",
			"9. Do not run dependency installation commands (pip/npm/cargo install); this pass must remain non-mutating outside .iosm files.",
			"10. If a command fails, adjust once and proceed; do not loop on the same failing probe.",
			"11. Keep IOSM.md aligned with verified priorities, checklist, and artifact links.",
			"12. IOSM Execution Contract: keep modifications surgical; avoid full-file rewrites when a targeted edit/apply_patch can satisfy the requirement.",
			"13. IOSM Execution Contract: if you must rewrite an existing file, declare intent explicitly (overwriteExisting=true + rewriteReason).",
			"14. IOSM Execution Contract: preserve unrelated repository changes; do not discard edits outside the current verification scope.",
			"",
		"Baseline from static init (must be verified, can be corrected):",
		`- metrics: ${metricsLine}`,
		`- goals: ${goalsLine}`,
		`- raw measurement groups: ${rawGroupsLine}`,
		"",
		"Final response requirements:",
		"- Output current values only (no before/after deltas).",
		"- Provide one compact line with semantic, logic, performance, simplicity, modularity, flow, iosm_index, decision_confidence.",
		"- Then provide at most 3 risks with numeric evidence.",
	].join("\n");
}

export function buildIosmGuideAuthoringPrompt(initResult: IosmInitResult): string {
	const cycleId = initResult.cycle?.cycleId ?? "unknown-cycle";
	const cycleReportPath =
		initResult.cycle?.reportPath ??
		`${initResult.rootDir}/.iosm/cycles/${cycleId}/cycle-report.json`;
	const baselineReportPath =
		initResult.cycle?.baselineReportPath ??
		`${initResult.rootDir}/.iosm/cycles/${cycleId}/baseline-report.json`;

	return [
		"You are authoring IOSM.md for this repository after init verification.",
		`Repository root: ${initResult.rootDir}`,
		`Cycle id: ${cycleId}`,
		"",
		"Required workflow:",
		"1. Inspect repository structure and key runtime/build/test files.",
		"2. Read IOSM artifacts and metrics first:",
		`   - ${cycleReportPath}`,
		`   - ${baselineReportPath}`,
		`   - ${initResult.rootDir}/iosm.yaml`,
		`   - ${initResult.rootDir}/.iosm/decision-log.md`,
		`   - ${initResult.rootDir}/.iosm/pattern-library.md`,
		"3. Produce a practical IOSM.md that is operational for daily engineering work.",
		"",
		"Output requirements:",
		"- Output ONLY markdown for IOSM.md (no code fences, no commentary).",
		"- Start with heading '# IOSM.md'.",
		"- Include sections:",
		"  - Project Snapshot",
		"  - IOSM Metrics and Priorities (with current metric values)",
		"  - Stack / Run / Test Commands",
		"  - Repository Map (important paths)",
		"  - IOSM Workspace and Artifact Paths",
		"  - Agent Operating Contract (I->O->S->M, gates, evidence rules)",
		"  - Current Cycle Focus",
		"- Keep text concise, concrete, and file-path-driven.",
		"- If unknown, write 'Unknown' explicitly.",
	].join("\n");
}

export function normalizeIosmGuideMarkdown(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	return trimmed.startsWith("# IOSM.md") ? `${trimmed}\n` : `# IOSM.md\n\n${trimmed}\n`;
}

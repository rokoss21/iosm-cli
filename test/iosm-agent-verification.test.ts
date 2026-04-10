import { describe, expect, it } from "vitest";
import {
	buildIosmAgentVerificationPrompt,
	createMetricSnapshot,
	extractAssistantText,
	formatMetricSnapshot,
	summarizeMetricDelta,
} from "../src/iosm/agent-verification.js";
import { createMetricRecord } from "../src/iosm/metrics.js";
import type { IosmInitResult } from "../src/iosm/init.js";

function createInitFixture(): IosmInitResult {
	return {
		rootDir: "/tmp/iosm-project",
		created: [],
		overwritten: [],
		skipped: [],
		analysis: {
			generated_at: "2026-03-06T00:00:00.000Z",
			files_analyzed: 42,
			source_file_count: 20,
			test_file_count: 10,
			doc_file_count: 4,
			top_languages: [{ language: "TypeScript", files: 20, lines: 1000 }],
			cycle_scope: {
				modules: ["src/core"],
				services: [],
				domains: ["billing"],
				contracts: [],
				rationale: "test",
			},
			detected_contracts: [],
			source_systems: ["npm"],
			goals: ["Improve logic confidence"],
			raw_measurements: { logic: { invariant_pass_rate: 0.7 } },
			metrics: {
				semantic: 0.8,
				logic: 0.7,
				performance: 0.75,
				simplicity: 0.6,
				modularity: 0.55,
				flow: 0.65,
			},
			metric_confidences: createMetricRecord(() => 0.8),
			metric_tiers: createMetricRecord(() => "B"),
		},
		cycle: {
			cycleId: "iosm-2026-03-06-001",
			cycleDir: "/tmp/iosm-project/.iosm/cycles/iosm-2026-03-06-001",
			reportPath: "/tmp/iosm-project/.iosm/cycles/iosm-2026-03-06-001/cycle-report.json",
			baselineReportPath: "/tmp/iosm-project/.iosm/cycles/iosm-2026-03-06-001/baseline-report.json",
			hypothesesPath: "/tmp/iosm-project/.iosm/cycles/iosm-2026-03-06-001/hypotheses.json",
			reusedExistingCycle: false,
		},
	};
}

describe("iosm agent verification helpers", () => {
	it("formats and compares metric snapshots", () => {
		const before = createMetricSnapshot({
			metrics: {
				semantic: 0.8,
				logic: 0.7,
				performance: 0.75,
				simplicity: 0.6,
				modularity: 0.55,
				flow: 0.65,
			},
			iosm_index: 0.678,
			decision_confidence: 0.71,
		});
		const after = createMetricSnapshot({
			metrics: {
				semantic: 0.81,
				logic: 0.72,
				performance: 0.75,
				simplicity: 0.58,
				modularity: 0.57,
				flow: 0.7,
			},
			iosm_index: 0.692,
			decision_confidence: 0.75,
		});

		const line = formatMetricSnapshot(before);
		expect(line).toContain("semantic=0.800");
		expect(line).toContain("iosm_index=0.678");

		const deltas = summarizeMetricDelta(before, after);
		expect(deltas).toContain("semantic: 0.800 -> 0.810");
		expect(deltas).toContain("logic: 0.700 -> 0.720");
		expect(deltas).toContain("simplicity: 0.600 -> 0.580");
		expect(deltas).toContain("decision_confidence: 0.710 -> 0.750");
	});

	it("builds verification prompt and extracts assistant text", () => {
		const initResult = createInitFixture();
		const prompt = buildIosmAgentVerificationPrompt(initResult);
			expect(prompt).toContain("Repository root: /tmp/iosm-project");
			expect(prompt).toContain("Cycle id: iosm-2026-03-06-001");
			expect(prompt).toContain("metrics: semantic=0.800, logic=0.700");
			expect(prompt).toContain("IOSM Execution Contract: keep modifications surgical");
			expect(prompt).toContain("overwriteExisting=true + rewriteReason");
			expect(prompt).toContain("IOSM Execution Contract: preserve unrelated repository changes");

		const summary = extractAssistantText({
			role: "assistant",
			content: [
				{ type: "text", text: "Metric updates applied." },
				{ type: "text", text: "Main risk: low async test coverage." },
			],
			timestamp: Date.now(),
			stopReason: "stop",
		} as never);
		expect(summary).toContain("Metric updates applied.");
		expect(summary).toContain("Main risk: low async test coverage.");
	});
});

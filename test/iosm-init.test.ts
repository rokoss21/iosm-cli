import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initIosmWorkspace, listIosmCycles, readIosmCycleReport } from "../src/iosm/index.js";
import type { IosmBaselineReport } from "../src/iosm/types.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createProjectFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "iosm-init-"));
	tempDirs.push(dir);

	mkdirSync(join(dir, "src", "auth"), { recursive: true });
	mkdirSync(join(dir, "test"), { recursive: true });
	mkdirSync(join(dir, "docs"), { recursive: true });
	mkdirSync(join(dir, "contracts"), { recursive: true });

	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify(
			{
				name: "fixture-service",
				private: true,
				dependencies: {
					express: "^4.21.0",
				},
				devDependencies: {
					vitest: "^3.2.4",
					typescript: "^5.9.2",
				},
			},
			null,
			2,
		),
		"utf8",
	);
	writeFileSync(
		join(dir, "src", "auth", "service.ts"),
		[
			"export function authenticate(token: string): boolean {",
			"\tif (token.length < 10) {",
			"\t\treturn false;",
			"\t}",
			"\treturn token.startsWith(\"tok_\");",
			"}",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(dir, "test", "service.test.ts"),
		[
			"import { describe, expect, it } from \"vitest\";",
			"import { authenticate } from \"../src/auth/service.js\";",
			"",
			"describe(\"authenticate\", () => {",
			"\tit(\"accepts tokens with prefix\", () => {",
			"\t\texpect(authenticate(\"tok_123456789\")).toBe(true);",
			"\t});",
			"});",
		].join("\n"),
		"utf8",
	);
	writeFileSync(join(dir, "docs", "architecture.md"), "# Architecture\n\nAuth module boundary.", "utf8");
	writeFileSync(
		join(dir, "contracts", "openapi.yaml"),
		"openapi: 3.0.0\ninfo:\n  title: Fixture API\n  version: 1.0.0\n",
		"utf8",
	);

	return dir;
}

describe("iosm init smart analysis", () => {
	it("analyzes project and seeds IOSM artifacts with baseline metrics", async () => {
		const projectDir = createProjectFixture();
		const result = await initIosmWorkspace({ cwd: projectDir });

		expect(result.analysis.files_analyzed).toBeGreaterThan(0);
		expect(result.analysis.source_file_count).toBeGreaterThan(0);
		expect(result.analysis.metrics.semantic).not.toBeNull();
		expect(result.analysis.metrics.logic).not.toBeNull();
		expect(result.analysis.metric_confidences.logic).toBeGreaterThan(0);
		expect(result.analysis.goals.length).toBeGreaterThan(0);

		expect(result.cycle).toBeDefined();
		expect(result.cycle?.cycleId).toMatch(/^iosm-/);

		const cycles = listIosmCycles(projectDir);
		expect(cycles.length).toBe(1);

		const report = readIosmCycleReport(projectDir, result.cycle!.cycleId);
		expect(report.status).toBe("active");
		expect(report.cycle_scope.modules.length + report.cycle_scope.services.length + report.cycle_scope.domains.length).toBeGreaterThan(0);
		expect(report.metrics.semantic).not.toBeNull();
		expect(report.metric_confidences.performance).toBeGreaterThan(0);
		expect(report.metric_tiers.semantic).not.toBeNull();

		const baseline = JSON.parse(readFileSync(result.cycle!.baselineReportPath, "utf8")) as IosmBaselineReport;
		expect(baseline.baseline_metrics.values.logic).not.toBeNull();
		expect((baseline.baseline_metrics.raw_measurements as Record<string, unknown>).logic).toBeDefined();

		const invariantsYaml = readFileSync(join(projectDir, ".iosm", "invariants.yaml"), "utf8");
		const contractsYaml = readFileSync(join(projectDir, ".iosm", "contracts.yaml"), "utf8");
		const playbook = readFileSync(join(projectDir, "IOSM.md"), "utf8");
		const agentsGuide = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
		const metricsHistory = readFileSync(join(projectDir, ".iosm", "metrics-history.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { cycle_id?: string });
		expect(invariantsYaml).toContain("invariants:");
		expect(contractsYaml).toContain("contracts:");
		expect(playbook).toContain("# IOSM.md");
		expect(playbook).toContain("## Priority Actions");
		expect(playbook).toContain("## IOSM Workspace");
		expect(agentsGuide).toContain("# AGENTS.md");
		expect(agentsGuide).toContain("## IOSM Sync (managed)");
		expect(metricsHistory.length).toBe(1);
		expect(metricsHistory[0].cycle_id).toBe(result.cycle?.cycleId);
	});

	it("reuses existing cycle on repeated init without force", async () => {
		const projectDir = createProjectFixture();
		const first = await initIosmWorkspace({ cwd: projectDir });
		const second = await initIosmWorkspace({ cwd: projectDir });

		expect(first.cycle).toBeDefined();
		expect(second.cycle).toBeDefined();
		expect(second.cycle?.reusedExistingCycle).toBe(true);
		expect(second.cycle?.cycleId).toBe(first.cycle?.cycleId);
		const agentsGuide = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
		expect(agentsGuide).toContain(`- Active cycle: ${first.cycle?.cycleId}`);
		expect((agentsGuide.match(/<!-- iosm-init:managed:start -->/g) ?? []).length).toBe(1);

		const cycles = listIosmCycles(projectDir);
		expect(cycles.length).toBe(1);
	});

	it("opens a fresh cycle after the latest cycle is marked failed", async () => {
		const projectDir = createProjectFixture();
		const first = await initIosmWorkspace({ cwd: projectDir });
		const firstReportPath = first.cycle!.reportPath;
		const failedReport = JSON.parse(readFileSync(firstReportPath, "utf8")) as { status?: string };
		failedReport.status = "failed";
		writeFileSync(firstReportPath, `${JSON.stringify(failedReport, null, 2)}\n`, "utf8");

		const second = await initIosmWorkspace({ cwd: projectDir });

		expect(second.cycle).toBeDefined();
		expect(second.cycle?.reusedExistingCycle).toBe(false);
		expect(second.cycle?.cycleId).not.toBe(first.cycle?.cycleId);
		const agentsGuide = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
		expect(agentsGuide).toContain(`- Active cycle: ${second.cycle?.cycleId}`);
		expect(agentsGuide).not.toContain(`- Active cycle: ${first.cycle?.cycleId}`);

		const cycles = listIosmCycles(projectDir);
		expect(cycles.length).toBe(2);
		expect(cycles[0].cycleId).toBe(second.cycle?.cycleId);
		expect(cycles[1].cycleId).toBe(first.cycle?.cycleId);
	});
});

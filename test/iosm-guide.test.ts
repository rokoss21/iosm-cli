import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIosmPriorityChecklist, writeAgentsGuideDocument, writeIosmGuideDocument } from "../src/iosm/guide.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("iosm guide", () => {
	it("builds priorities from weakest metrics first", () => {
		const checklist = buildIosmPriorityChecklist(
			{
				semantic: 0.8,
				logic: 0.41,
				performance: 0.5,
				simplicity: 0.91,
				modularity: 0.63,
				flow: 0.2,
			},
			3,
		);

		expect(checklist.length).toBe(3);
		expect(checklist[0].metric).toBe("flow");
		expect(checklist[1].metric).toBe("logic");
		expect(checklist[2].metric).toBe("performance");
	});

	it("writes IOSM.md playbook with links and checklist", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-guide-"));
		tempDirs.push(dir);

		const write = writeIosmGuideDocument(
			{
				rootDir: dir,
				cycleId: "iosm-2026-03-06-001",
				assessmentSource: "verified",
				metrics: {
					semantic: 0.7,
					logic: 0.4,
					performance: 0.5,
					simplicity: 0.8,
					modularity: 0.72,
					flow: 0.3,
				},
				iosmIndex: 0.57,
				decisionConfidence: 0.66,
				goals: ["Improve test coverage", "Enable CI"],
				filesAnalyzed: 25,
				sourceFileCount: 16,
				testFileCount: 0,
				docFileCount: 2,
				tracePath: "/tmp/trace.jsonl",
			},
			true,
		);

		expect(write.written).toBe(true);
		const content = readFileSync(write.path, "utf8");
		expect(content).toContain("# IOSM.md");
		expect(content).toContain("## Priority Actions");
		expect(content).toContain("## IOSM Workspace");
		expect(content).toContain("iosm-2026-03-06-001");
		expect(content).toContain("re-read this file");
	});

	it("creates and updates AGENTS.md managed IOSM sync block", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-agents-guide-"));
		tempDirs.push(dir);

		const first = writeAgentsGuideDocument(
			{
				rootDir: dir,
				cycleId: "iosm-2026-03-06-001",
				assessmentSource: "heuristic",
				iosmIndex: 0.42,
				decisionConfidence: 0.71,
				goals: ["Reduce auth complexity"],
				filesAnalyzed: 20,
				sourceFileCount: 12,
				testFileCount: 5,
				docFileCount: 3,
			},
			true,
		);
		expect(first.written).toBe(true);
		const initialContent = readFileSync(first.path, "utf8");
		expect(initialContent).toContain("# AGENTS.md");
		expect(initialContent).toContain("<!-- iosm-init:managed:start -->");
		expect(initialContent).toContain("Reduce auth complexity");

		const second = writeAgentsGuideDocument(
			{
				rootDir: dir,
				cycleId: "iosm-2026-03-06-002",
				assessmentSource: "verified",
				iosmIndex: 0.88,
				decisionConfidence: 0.92,
				goals: ["Stabilize release workflow"],
				filesAnalyzed: 35,
				sourceFileCount: 21,
				testFileCount: 9,
				docFileCount: 5,
			},
			true,
		);
		expect(second.written).toBe(true);
		const updatedContent = readFileSync(second.path, "utf8");
		expect(updatedContent).toContain("iosm-2026-03-06-002");
		expect(updatedContent).toContain("Stabilize release workflow");
		expect(updatedContent).not.toContain("Reduce auth complexity");
		expect((updatedContent.match(/<!-- iosm-init:managed:start -->/g) ?? []).length).toBe(1);
		expect((updatedContent.match(/<!-- iosm-init:managed:end -->/g) ?? []).length).toBe(1);
	});

	it("normalizes lowercase agents.md to AGENTS.md on write", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-agents-case-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "agents.md"), "# legacy\n", "utf8");

		const write = writeAgentsGuideDocument(
			{
				rootDir: dir,
				cycleId: "iosm-2026-03-06-003",
				assessmentSource: "verified",
				iosmIndex: 0.91,
				decisionConfidence: 0.93,
				goals: ["Case normalization"],
				filesAnalyzed: 10,
				sourceFileCount: 7,
				testFileCount: 2,
				docFileCount: 1,
			},
			true,
		);

		expect(write.path).toBe(join(dir, "AGENTS.md"));
		const entries = readdirSync(dir);
		expect(entries).toContain("AGENTS.md");
		expect(entries).not.toContain("agents.md");
	});

	it("normalizes lowercase iosm.md to IOSM.md on write", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-playbook-case-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "iosm.md"), "# legacy\n", "utf8");

		const write = writeIosmGuideDocument(
			{
				rootDir: dir,
				cycleId: "iosm-2026-03-06-004",
				assessmentSource: "verified",
				metrics: {
					semantic: 0.8,
					logic: 0.82,
					performance: 0.79,
					simplicity: 0.77,
					modularity: 0.76,
					flow: 0.81,
				},
				iosmIndex: 0.79,
				decisionConfidence: 0.88,
				goals: ["Case normalization"],
				filesAnalyzed: 11,
				sourceFileCount: 8,
				testFileCount: 2,
				docFileCount: 1,
			},
			true,
		);

		expect(write.path).toBe(join(dir, "IOSM.md"));
		const entries = readdirSync(dir);
		expect(entries).toContain("IOSM.md");
		expect(entries).not.toContain("iosm.md");
	});
});

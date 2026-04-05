import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { SubagentMessageComponent } from "../src/modes/interactive/components/subagent-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("SubagentMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders running status with concise live metadata", () => {
		const component = new SubagentMessageComponent({
			description: "Improve board UX",
			profile: "full",
			status: "running",
			phase: "running read",
			phaseState: "running",
			cwd: "/tmp/minesweeper",
			agent: "codebase_auditor",
			activeTool: "read",
			toolCallsStarted: 2,
			toolCallsCompleted: 1,
			assistantMessages: 1,
			durationMs: 65_000,
			delegateIndex: 1,
			delegateTotal: 2,
			delegateDescription: "Patch vuln",
			delegateProfile: "explore",
			delegateItems: [
				{ index: 1, description: "Patch vuln", profile: "explore", status: "running" },
				{ index: 2, description: "Audit UX", profile: "plan", status: "pending" },
			],
		});

		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("[subagent:codebase_auditor]");
		expect(rendered).toContain("Improve board UX");
		expect(rendered).toContain("running read");
		expect(rendered).toContain("@ /tmp/minesweeper");
		expect(rendered).toContain("tool read");
		expect(rendered).toContain("tools 1/2");
		expect(rendered).toContain("msgs 1");
		expect(rendered).toContain("elapsed 01:05");
		expect(rendered).toContain("delegates 0/2 done, 1 running, 1 pending");
		expect(rendered).toContain("Patch vuln");
		expect(rendered).toContain("(explore)");
		expect(rendered).toContain("delegates");
		expect(rendered).toContain("├─ [>] #1 Patch vuln (explore)");
		expect(rendered).toContain("└─ [ ] #2 Audit UX (plan)");
	});

	it("renders done status with queue and tool counters", () => {
		const component = new SubagentMessageComponent({
			description: "Improve board UX",
			profile: "full",
			status: "running",
		});

		component.update({
			description: "Improve board UX",
			profile: "full",
			status: "done",
			outputLength: 1536,
			durationMs: 1234,
			waitMs: 250,
			toolCallsStarted: 3,
			toolCallsCompleted: 3,
			delegatedTasks: 5,
			delegatedSucceeded: 2,
			delegatedFailed: 1,
		});

		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("1.5KB");
		expect(rendered).toContain("1.2s");
		expect(rendered).toContain("tools 3/3");
		expect(rendered).toContain("delegates 2/5 done");
		expect(rendered).toContain("1 failed");
		expect(rendered).toContain("queue 250ms");
	});

	it("renders full delegate list for large orchestrations", () => {
		const component = new SubagentMessageComponent({
			description: "Run parallel audit",
			profile: "full",
			status: "running",
			phase: "running",
			delegateItems: [
				{ index: 1, description: "Task 1", profile: "explore", status: "done" },
				{ index: 2, description: "Task 2", profile: "explore", status: "pending" },
				{ index: 3, description: "Task 3", profile: "explore", status: "done" },
				{ index: 4, description: "Task 4", profile: "explore", status: "running" },
				{ index: 5, description: "Task 5", profile: "plan", status: "failed" },
				{ index: 6, description: "Task 6", profile: "explore", status: "pending" },
				{ index: 7, description: "Task 7", profile: "plan", status: "done" },
			],
		});

		const rendered = stripAnsi(component.render(160).join("\n"));
		expect(rendered).toContain("delegates 3/7 done, 1 failed, 1 running, 2 pending");
		expect(rendered).toContain("├─ [x] #1 Task 1 (explore)");
		expect(rendered).toContain("├─ [ ] #2 Task 2 (explore)");
		expect(rendered).toContain("├─ [>] #4 Task 4 (explore)");
		expect(rendered).toContain("├─ [!] #5 Task 5 (plan)");
		expect(rendered).toContain("└─ [x] #7 Task 7 (plan)");
		expect(rendered).not.toContain("hidden");
	});
});

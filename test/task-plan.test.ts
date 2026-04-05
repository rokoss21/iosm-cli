import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm, INTERNAL_UI_META_CUSTOM_TYPE } from "../src/core/messages.js";
import {
	coerceTaskPlanSnapshot,
	extractTaskPlanFromAssistantMessage,
	extractTaskPlanFromText,
	formatTaskPlanMessageContent,
	isTaskPlanSnapshot,
	taskPlanSignature,
	TASK_PLAN_CUSTOM_TYPE,
	type TaskPlanSnapshot,
} from "../src/core/task-plan.js";

describe("task plan parser", () => {
	it("extracts and removes task_plan blocks from assistant text", () => {
		const extracted = extractTaskPlanFromText(
			[
				"Prep context",
				"<task_plan complexity=\"complex\">",
				"- [in_progress] Inspect runtime hooks",
				"- [pending] Implement parser",
				"- [done] Add regression tests",
				"</task_plan>",
				"Ready to implement",
			].join("\n"),
		);

		expect(extracted.cleanedText).toContain("Prep context");
		expect(extracted.cleanedText).toContain("Ready to implement");
		expect(extracted.cleanedText).not.toContain("<task_plan");
		expect(extracted.planSnapshots).toHaveLength(1);
		expect(extracted.planSnapshots[0]).toMatchObject({
			totalSteps: 3,
			completedSteps: 1,
			currentStepIndex: 0,
		});
	});

	it("supports task_plan_update blocks with fallback pending status", () => {
		const extracted = extractTaskPlanFromText(
			[
				"<task_plan_update>",
				"1. Harden prompt contract",
				"2. Add UI plan card",
				"</task_plan_update>",
			].join("\n"),
		);

		expect(extracted.planSnapshots).toHaveLength(1);
		expect(extracted.planSnapshots[0].steps).toEqual([
			{ status: "pending", title: "Harden prompt contract" },
			{ status: "pending", title: "Add UI plan card" },
		]);
		expect(extracted.planSnapshots[0].currentStepIndex).toBe(0);
	});

	it("sanitizes assistant messages and returns the latest snapshot", () => {
		const assistant = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: [
						"Planning update",
						"<task_plan complexity=\"complex\">",
						"- [done] Scan repo",
						"- [in_progress] Add parser",
						"</task_plan>",
					].join("\n"),
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as const;

		const extracted = extractTaskPlanFromAssistantMessage(assistant);
		expect(extracted.changed).toBe(true);
		expect(extracted.sanitizedMessage.content[0]).toMatchObject({
			type: "text",
		});
		expect((extracted.sanitizedMessage.content[0] as { text: string }).text).not.toContain("<task_plan");
		expect(extracted.planSnapshot).toBeDefined();
		expect(extracted.planSnapshot?.currentStepIndex).toBe(1);
	});
});

describe("task plan helpers", () => {
	const snapshot: TaskPlanSnapshot = {
		complexity: "complex",
		steps: [
			{ status: "done", title: "Inspect codebase" },
			{ status: "in_progress", title: "Implement parser" },
			{ status: "pending", title: "Run tests" },
		],
		currentStepIndex: 1,
		completedSteps: 1,
		totalSteps: 3,
	};

	it("creates deterministic signatures", () => {
		expect(taskPlanSignature(snapshot)).toBe("done:Inspect codebase||in_progress:Implement parser||pending:Run tests");
	});

	it("formats compact task-plan content", () => {
		const formatted = formatTaskPlanMessageContent(snapshot);
		expect(formatted).toContain("Execution plan (1/3 complete)");
		expect(formatted).toContain("Current: Implement parser");
		expect(formatted).toContain("2. [in_progress] Implement parser");
	});

	it("validates task plan snapshots", () => {
		expect(isTaskPlanSnapshot(snapshot)).toBe(true);
		expect(isTaskPlanSnapshot({ foo: "bar" })).toBe(false);
	});

	it("coerces relaxed task plan payloads", () => {
		const coerced = coerceTaskPlanSnapshot({
			tasks: [
				{ subject: "Inspect runtime", status: "completed" },
				{ step: "Implement UI", current: true },
			],
		});

		expect(coerced).toEqual({
			complexity: "complex",
			steps: [
				{ title: "Inspect runtime", status: "done" },
				{ title: "Implement UI", status: "in_progress" },
			],
			currentStepIndex: 1,
			completedSteps: 1,
			totalSteps: 2,
		});
	});

	it("coerces json string payloads", () => {
		const coerced = coerceTaskPlanSnapshot(
			JSON.stringify({
				plan: [
					{ title: "Scan repo", status: "done" },
					{ title: "Ship patch", status: "pending" },
				],
			}),
		);

		expect(coerced?.steps).toHaveLength(2);
		expect(coerced?.currentStepIndex).toBe(1);
		expect(coerced?.completedSteps).toBe(1);
	});
});

describe("convertToLlm filtering", () => {
	it("skips task-plan custom messages from model context", () => {
		const messages = [
			{
				role: "custom",
				customType: TASK_PLAN_CUSTOM_TYPE,
				content: "Execution plan (1/3 complete)",
				display: true,
				timestamp: Date.now(),
			},
			{
				role: "user",
				content: [{ type: "text", text: "Continue" }],
				timestamp: Date.now(),
			},
		] as AgentMessage[];

		const llm = convertToLlm(messages);
		expect(llm).toHaveLength(1);
		expect(llm[0].role).toBe("user");
		expect(llm[0].content).toEqual([{ type: "text", text: "Continue" }]);
	});

	it("skips internal ui metadata custom messages from model context", () => {
		const messages = [
			{
				role: "custom",
				customType: INTERNAL_UI_META_CUSTOM_TYPE,
				content: "",
				display: false,
				details: {
					kind: "orchestration_context",
					rawPrompt: "<orchestrate ...>",
					displayText: "improve seo",
				},
				timestamp: Date.now(),
			},
			{
				role: "user",
				content: [{ type: "text", text: "Continue" }],
				timestamp: Date.now(),
			},
		] as AgentMessage[];

		const llm = convertToLlm(messages);
		expect(llm).toHaveLength(1);
		expect(llm[0].role).toBe("user");
		expect(llm[0].content).toEqual([{ type: "text", text: "Continue" }]);
	});
});

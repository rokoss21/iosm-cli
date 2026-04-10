import { describe, expect, it, vi } from "vitest";
import { createAskUserTool } from "../src/core/ask-user-tool.js";

describe("ask_user tool", () => {
	it("returns the selected option when the user chooses from provided options", async () => {
		const tool = createAskUserTool();
		const select = vi.fn(async () => "Option B");
		const input = vi.fn(async () => undefined);

		const result = await tool.execute(
			"tool-call-1",
			{
				title: "Architecture decision",
				question: "Which cache strategy should we use?",
				options: ["Option A", "Option B", "Option B"],
				context: "This choice affects invalidation semantics.",
			},
			undefined,
			undefined,
			{ ui: { select, input } } as any,
		);

		expect(select).toHaveBeenCalledWith(
			"Architecture decision\nWhich cache strategy should we use?\n\nContext:\nThis choice affects invalidation semantics.",
			["Option A", "Option B", "Other (type custom answer)"],
			{ timeout: 45_000 },
		);
		expect(input).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({
			status: "answered",
			answer: "Option B",
			answerType: "option",
			options: ["Option A", "Option B"],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Answer: Option B"),
		});
	});

	it("falls back to freeform input when the user selects the custom-answer option", async () => {
		const tool = createAskUserTool();
		const select = vi.fn(async () => "Other (type custom answer)");
		const input = vi.fn(async () => "Introduce an adapter boundary first");

		const result = await tool.execute(
			"tool-call-2",
			{
				title: "Refactor approach",
				question: "How aggressive should the first pass be?",
				options: ["Conservative", "Moderate"],
			},
			undefined,
			undefined,
			{ ui: { select, input } } as any,
		);

		expect(result.details).toMatchObject({
			status: "answered",
			answer: "Introduce an adapter boundary first",
			answerType: "custom",
		});
		expect(input).toHaveBeenCalledWith(
			"Refactor approach\nHow aggressive should the first pass be?",
			"Type your answer",
			{ timeout: 45_000 },
		);
	});

	it("supports direct freeform questions without predefined options", async () => {
		const tool = createAskUserTool();
		const input = vi.fn(async () => "Prefer a separate service package");

		const result = await tool.execute(
			"tool-call-3",
			{
				title: "Boundaries",
				question: "What package layout do you prefer?",
				allowCustomAnswer: true,
				placeholder: "Describe your preferred layout",
			},
			undefined,
			undefined,
			{ ui: { select: vi.fn(async () => undefined), input } } as any,
		);

		expect(result.details).toMatchObject({
			status: "answered",
			answer: "Prefer a separate service package",
			answerType: "input",
		});
		expect(input).toHaveBeenCalledWith(
			"Boundaries\nWhat package layout do you prefer?",
			"Describe your preferred layout",
			{ timeout: 45_000 },
		);
	});

	it("returns a cancelled result when the user dismisses the dialog", async () => {
		const tool = createAskUserTool();

		const result = await tool.execute(
			"tool-call-4",
			{
				title: "Deployment choice",
				question: "Pick a deployment strategy.",
				options: ["Blue/green", "Canary"],
				allowCustomAnswer: false,
			},
			undefined,
			undefined,
			{ ui: { select: vi.fn(async () => undefined), input: vi.fn(async () => undefined) } } as any,
		);

		expect(result.details).toMatchObject({
			status: "cancelled",
			title: "Deployment choice",
			question: "Pick a deployment strategy.",
			options: ["Blue/green", "Canary"],
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("User clarification was cancelled."),
		});
	});

	it("supports custom timeout override", async () => {
		const tool = createAskUserTool();
		const select = vi.fn(async () => undefined);

		await tool.execute(
			"tool-call-5",
			{
				title: "Timeout check",
				question: "Use explicit timeout?",
				options: ["Yes", "No"],
				timeoutMs: 12_345,
			},
			undefined,
			undefined,
			{ ui: { select, input: vi.fn(async () => undefined) } } as any,
		);

		expect(select).toHaveBeenCalledWith(
			"Timeout check\nUse explicit timeout?",
			["Yes", "No", "Other (type custom answer)"],
			{ timeout: 12_345 },
		);
	});
});

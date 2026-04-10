import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "./extensions/index.js";

const CUSTOM_ANSWER_LABEL = "Other (type custom answer)";
const DEFAULT_ASK_USER_TIMEOUT_MS = 45_000;
const MIN_ASK_USER_TIMEOUT_MS = 1_000;
const MAX_ASK_USER_TIMEOUT_MS = 300_000;

export const askUserToolParameters = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 120 }),
	question: Type.String({ minLength: 1, maxLength: 2000 }),
	options: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
			minItems: 1,
			maxItems: 6,
		}),
	),
	allowCustomAnswer: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.String({ maxLength: 2000 })),
	placeholder: Type.Optional(Type.String({ maxLength: 160 })),
	timeoutMs: Type.Optional(
		Type.Number({
			minimum: MIN_ASK_USER_TIMEOUT_MS,
			maximum: MAX_ASK_USER_TIMEOUT_MS,
			description:
				"Optional dialog timeout in milliseconds. Defaults to 45000ms; when timeout expires, ask_user returns cancelled.",
		}),
	),
});

export type AskUserToolInput = Static<typeof askUserToolParameters>;

export interface AskUserToolDetails {
	status: "answered" | "cancelled";
	answer?: string;
	answerType?: "option" | "custom" | "input";
	title: string;
	question: string;
	context?: string;
	options?: string[];
}

function normalizeOptions(options: string[] | undefined): string[] {
	if (!options) {
		return [];
	}

	const unique = new Set<string>();
	for (const option of options) {
		const normalized = option.trim();
		if (normalized.length > 0 && normalized !== CUSTOM_ANSWER_LABEL) {
			unique.add(normalized);
		}
	}

	return Array.from(unique);
}

function buildPromptBody(input: Pick<AskUserToolInput, "question" | "context">): string {
	if (!input.context?.trim()) {
		return input.question;
	}

	return `${input.question}\n\nContext:\n${input.context.trim()}`;
}

function buildDialogTitle(input: Pick<AskUserToolInput, "title" | "question" | "context">): string {
	return `${input.title}\n${buildPromptBody(input)}`;
}

function normalizeDialogTimeout(timeoutMs: unknown): number {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
		return DEFAULT_ASK_USER_TIMEOUT_MS;
	}
	const rounded = Math.floor(timeoutMs);
	return Math.max(MIN_ASK_USER_TIMEOUT_MS, Math.min(MAX_ASK_USER_TIMEOUT_MS, rounded));
}

function buildAnsweredResult(
	input: AskUserToolInput,
	answer: string,
	answerType: AskUserToolDetails["answerType"],
	options: string[],
): AgentToolResult<AskUserToolDetails> {
	const lines = [
		"User clarification received.",
		`Title: ${input.title}`,
		`Question: ${input.question}`,
		`Answer: ${answer}`,
		`Answer type: ${answerType}`,
	];

	if (input.context?.trim()) {
		lines.push(`Context: ${input.context.trim()}`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			status: "answered",
			answer,
			answerType,
			title: input.title,
			question: input.question,
			context: input.context?.trim() || undefined,
			options,
		},
	};
}

function buildCancelledResult(
	input: AskUserToolInput,
	options: string[],
): AgentToolResult<AskUserToolDetails> {
	const lines = [
		"User clarification was cancelled.",
		`Title: ${input.title}`,
		`Question: ${input.question}`,
	];

	if (input.context?.trim()) {
		lines.push(`Context: ${input.context.trim()}`);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			status: "cancelled",
			title: input.title,
			question: input.question,
			context: input.context?.trim() || undefined,
			options,
		},
	};
}

export function createAskUserTool(): ToolDefinition<typeof askUserToolParameters, AskUserToolDetails> {
	return {
		name: "ask_user",
		label: "Ask User",
		description: "Ask the user a blocking product or architecture question and wait for the answer.",
		promptSnippet: "Ask the user a targeted clarification question with options and optional freeform answer.",
		promptGuidelines: [
			"Use ask_user only for blocking product or architecture ambiguities that would materially change implementation.",
			"When a safe conservative assumption is available, proceed without ask_user and state the assumption explicitly.",
			"Offer 2-5 concise options when possible and allow a custom answer unless the choice is naturally fixed.",
			"After ask_user returns, continue the task in the same turn using the user's answer.",
		],
		parameters: askUserToolParameters,
		execute: async (_toolCallId, input, _signal, _onUpdate, ctx) => {
			const options = normalizeOptions(input.options);
			const allowCustomAnswer = input.allowCustomAnswer ?? true;
			const timeout = normalizeDialogTimeout(input.timeoutMs);
			const dialogTitle = buildDialogTitle(input);

			if (options.length > 0) {
				const selectorOptions = allowCustomAnswer ? [...options, CUSTOM_ANSWER_LABEL] : options;
				const selection = await ctx.ui.select(dialogTitle, selectorOptions, { timeout });
				if (selection === undefined) {
					return buildCancelledResult(input, options);
				}

				if (selection !== CUSTOM_ANSWER_LABEL) {
					return buildAnsweredResult(input, selection, "option", options);
				}
			}

			const customAnswer = await ctx.ui.input(dialogTitle, input.placeholder ?? "Type your answer", {
				timeout,
			});
			const normalizedAnswer = customAnswer?.trim();
			if (!normalizedAnswer) {
				return buildCancelledResult(input, options);
			}

			return buildAnsweredResult(input, normalizedAnswer, options.length > 0 ? "custom" : "input", options);
		},
	};
}

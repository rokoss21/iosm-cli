import type { AssistantMessage } from "@mariozechner/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Internal chain of thought goes here." },
			{ type: "text", text: "Final visible answer." },
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
	};
}

function createToolOnlyAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }],
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
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("collapses reasoning blocks by default and keeps final text visible", () => {
		const component = new AssistantMessageComponent(createAssistantMessage(), false);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("Reasoning: Internal chain of thought goes here.");
		expect(rendered).toContain("to expand");
		expect(rendered).toContain("Final visible answer.");
		expect(rendered).not.toContain("Reasoning hidden");
	});

	it("shows full reasoning when expanded", () => {
		const component = new AssistantMessageComponent(createAssistantMessage(), false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("Internal chain of thought goes here.");
		expect(rendered).toContain("Final visible answer.");
		expect(rendered).not.toContain("Reasoning:");
	});

	it("keeps reasoning hidden with thinking toggle even when expanded", () => {
		const component = new AssistantMessageComponent(createAssistantMessage(), false);
		component.setExpanded(true);
		component.setHideThinkingBlock(true);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("Final visible answer.");
		expect(rendered).not.toContain("Internal chain of thought goes here.");
	});

	it("shows streaming spinner in collapsed reasoning mode", () => {
		const component = new AssistantMessageComponent(createAssistantMessage(), false);
		component.setStreaming(true);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toMatch(/Thinking [\\\-|\/]: Internal chain of thought goes here\./);
		expect(rendered).toContain("to expand");
	});

	it("renders assistant window frame for normal text responses", () => {
		const component = new AssistantMessageComponent(createAssistantMessage(), false);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).toContain("IOSM Agent");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("╮");
		expect(rendered).toContain("╰");
		expect(rendered).toContain("╯");
		expect(rendered).toContain("│");
	});

	it("does not render empty assistant frame for tool-only messages", () => {
		const component = new AssistantMessageComponent(createToolOnlyAssistantMessage(), false);
		const rendered = stripAnsi(component.render(120).join("\n"));

		expect(rendered).not.toContain("IOSM Agent");
		expect(rendered).not.toContain("╭");
		expect(rendered).not.toContain("╰");
	});
});

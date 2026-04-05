import { visibleWidth } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import stripAnsi from "strip-ansi";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		modelRegistry: {
			isUsingOAuth: () => false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number, options?: { swarmBusy?: boolean }): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		getSwarmBusy: () => options?.swarmBusy ?? false,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows provider/model in the right-side status text", () => {
		const session = createSession({
			sessionName: "",
			modelId: "claude-sonnet-4-6",
			provider: "anthropic",
			reasoning: true,
			thinkingLevel: "off",
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(160);
		const statsLine = stripAnsi(lines[1] ?? "");
		expect(statsLine).toContain("anthropic/claude-sonnet-4-6");
	});

	it("renders plan profile badge once and in lowercase", () => {
		const session = createSession({ sessionName: "", modelId: "gpt-5", provider: "openai" });
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setPlanMode(true);
		footer.setActiveProfile("plan");

		const lines = footer.render(160);
		const statsLine = stripAnsi(lines[1] ?? "");
		const planBadgeMatches = statsLine.match(/\[plan\]/g) ?? [];
		expect(planBadgeMatches.length).toBe(1);
		expect(statsLine).not.toContain("[PLAN]");
	});

	it("shows working status when swarm run is active", () => {
		const session = createSession({ sessionName: "", modelId: "gpt-5", provider: "openai" });
		const footer = new FooterComponent(session, createFooterData(1, { swarmBusy: true }));

		const lines = footer.render(160);
		const statsLine = stripAnsi(lines[1] ?? "");
		expect(statsLine).toContain("[working]");
		expect(statsLine).not.toContain("[ready]");
	});

	it("renders single-line compact footer mode", () => {
		const session = createSession({
			sessionName: "",
			modelId: "claude-sonnet-4-6",
			provider: "anthropic",
			reasoning: true,
			thinkingLevel: "low",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));
		footer.setCompactModeEnabled(true);

		const lines = footer.render(160);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(160);
		const compactLine = stripAnsi(lines[0] ?? "");
		expect(compactLine).toContain("anthropic/claude-sonnet-4-6");
		expect(compactLine).toContain("ctx 12.3%/200k (auto)");
	});
});

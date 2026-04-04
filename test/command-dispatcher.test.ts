import { describe, expect, it, vi } from "vitest";
import { dispatchBuiltinSlashCommand } from "../src/core/command-dispatcher.js";
import { SettingsManager } from "../src/core/settings-manager.js";

function createContext() {
	const settingsManager = SettingsManager.inMemory();
	const modelA = { provider: "openai", id: "gpt-5.4", contextWindow: 200_000, reasoning: true } as any;
	const modelB = { provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000, reasoning: true } as any;
	const entries: any[] = [
		{
			type: "message",
			id: "leaf-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: "hello from root" },
		},
	];
	const leafState = { id: "leaf-1" as string | null };

	const state = {
		model: modelA as any,
		sessionName: "initial",
	};

	const session = {
		isStreaming: false,
		isCompacting: false,
		pendingMessageCount: 0,
		sessionId: "session-1",
		sessionName: "initial",
		get model() {
			return state.model;
		},
		modelRegistry: {
			getAvailable: vi.fn(async () => [modelA, modelB]),
			authStorage: {
				logout: vi.fn(),
			},
		},
		setModel: vi.fn(async (model: any) => {
			state.model = model;
		}),
		cycleModel: vi.fn(async () => ({ model: modelB, thinkingLevel: "medium", isScoped: false })),
		abort: vi.fn(async () => {}),
		newSession: vi.fn(async () => true),
		switchSession: vi.fn(async () => true),
		fork: vi.fn(async (entryId: string) => ({ selectedText: `selected:${entryId}`, cancelled: false })),
		navigateTree: vi.fn(async (entryId: string) => ({ cancelled: false, editorText: `editor:${entryId}` })),
		compact: vi.fn(async () => ({
			summary: "compacted summary",
			firstKeptEntryId: "leaf-1",
			tokensBefore: 1234,
		})),
		reload: vi.fn(async () => {}),
		getSessionStats: vi.fn(() => ({
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
			userMessages: 2,
			assistantMessages: 3,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 7,
			tokens: {
				input: 100,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				total: 300,
			},
			cost: 0.1234,
		})),
		setSessionName: vi.fn((name: string) => {
			state.sessionName = name;
		}),
		getLastAssistantText: vi.fn(() => "last assistant message"),
		exportToHtml: vi.fn(async (outputPath?: string) => outputPath ?? "/tmp/export.html"),
		sessionManager: {
			getTree: vi.fn(() => [
				{
					entry: entries[0],
					children: [],
				},
			]),
			getLeafId: vi.fn(() => leafState.id),
			getEntries: vi.fn(() => entries),
			getEntry: vi.fn((id: string) => entries.find((entry) => entry.id === id)),
			appendLabelChange: vi.fn((targetId: string, label: string | undefined) => {
				const next = {
					type: "label",
					id: `label-${entries.length + 1}`,
					parentId: targetId,
					timestamp: new Date().toISOString(),
					targetId,
					label,
				};
				entries.push(next);
				return next.id;
			}),
		},
	} as any;

	return { session, settingsManager };
}

describe("dispatchBuiltinSlashCommand", () => {
	it("handles yolo toggles and status", async () => {
		const context = createContext();

		const on = await dispatchBuiltinSlashCommand("/yolo on", context as any);
		expect(on.handled).toBe(true);
		expect(on.message).toContain("ON");
		expect(context.settingsManager.getPermissionMode()).toBe("yolo");

		const status = await dispatchBuiltinSlashCommand("/yolo status", context as any);
		expect(status.handled).toBe(true);
		expect(status.message).toContain("ON");

		const off = await dispatchBuiltinSlashCommand("/yolo off", context as any);
		expect(off.handled).toBe(true);
		expect(context.settingsManager.getPermissionMode()).toBe("ask");
	});

	it("handles permissions allow add/list/remove", async () => {
		const context = createContext();

		const add = await dispatchBuiltinSlashCommand("/permissions allow add bash:git status", context as any);
		expect(add.handled).toBe(true);
		expect(context.settingsManager.getPermissionAllowRules()).toContain("bash:git status");

		const list = await dispatchBuiltinSlashCommand("/permissions allow list", context as any);
		expect(list.handled).toBe(true);
		expect(list.text).toContain("bash:git status");

		const remove = await dispatchBuiltinSlashCommand("/permissions allow remove bash:git status", context as any);
		expect(remove.handled).toBe(true);
		expect(context.settingsManager.getPermissionAllowRules()).toEqual([]);
	});

	it("handles session, name, copy, and export commands", async () => {
		const context = createContext();

		const sessionResult = await dispatchBuiltinSlashCommand("/session", context as any);
		expect(sessionResult.handled).toBe(true);
		expect(sessionResult.text).toContain("Session Info");

		const nameResult = await dispatchBuiltinSlashCommand("/name release-prep", context as any);
		expect(nameResult.handled).toBe(true);
		expect(context.session.setSessionName).toHaveBeenCalledWith("release-prep");

		const copyResult = await dispatchBuiltinSlashCommand("/copy", context as any);
		expect(copyResult.handled).toBe(true);
		expect(copyResult.text).toBe("last assistant message");

		const exportResult = await dispatchBuiltinSlashCommand("/export /tmp/out.html", context as any);
		expect(exportResult.handled).toBe(true);
		expect(exportResult.filePath).toBe("/tmp/out.html");
	});

	it("handles model set and cycle", async () => {
		const context = createContext();

		const setResult = await dispatchBuiltinSlashCommand("/model anthropic/claude-sonnet-4-5", context as any);
		expect(setResult.handled).toBe(true);
		expect(context.session.setModel).toHaveBeenCalled();

		const cycleResult = await dispatchBuiltinSlashCommand("/model cycle", context as any);
		expect(cycleResult.handled).toBe(true);
		expect(cycleResult.message).toContain("thinking");
	});

	it("handles status, resume, and fork commands", async () => {
		const context = createContext();

		const status = await dispatchBuiltinSlashCommand("/status", context as any);
		expect(status.handled).toBe(true);
		expect(status.text).toContain("Model:");

		const resume = await dispatchBuiltinSlashCommand("/resume /tmp/session.jsonl", context as any);
		expect(resume.handled).toBe(true);
		expect(context.session.switchSession).toHaveBeenCalledWith("/tmp/session.jsonl");

		const fork = await dispatchBuiltinSlashCommand("/fork entry-42", context as any);
		expect(fork.handled).toBe(true);
		expect(fork.text).toBe("selected:entry-42");
	});

	it("handles compact and reload commands", async () => {
		const context = createContext();

		const compact = await dispatchBuiltinSlashCommand("/compact", context as any);
		expect(compact.handled).toBe(true);
		expect(compact.message).toContain("Compaction complete");
		expect(context.session.compact).toHaveBeenCalled();

		const reload = await dispatchBuiltinSlashCommand("/reload", context as any);
		expect(reload.handled).toBe(true);
		expect(reload.message).toContain("Reloaded");
		expect(context.session.reload).toHaveBeenCalled();
	});

	it("handles tree list and tree navigation", async () => {
		const context = createContext();

		const list = await dispatchBuiltinSlashCommand("/tree", context as any);
		expect(list.handled).toBe(true);
		expect(list.text).toContain("Current leaf:");

		const navigate = await dispatchBuiltinSlashCommand("/tree leaf-1", context as any);
		expect(navigate.handled).toBe(true);
		expect(context.session.navigateTree).toHaveBeenCalledWith("leaf-1", { summarize: false });
	});

	it("handles checkpoint and rollback commands", async () => {
		const context = createContext();

		const checkpoint = await dispatchBuiltinSlashCommand("/checkpoint before-refactor", context as any);
		expect(checkpoint.handled).toBe(true);
		expect(checkpoint.message).toContain("Checkpoint saved");

		const rollback = await dispatchBuiltinSlashCommand("/rollback before-refactor", context as any);
		expect(rollback.handled).toBe(true);
		expect(rollback.message).toContain("Rolled back");
	});

	it("handles changelog, login warning, and logout", async () => {
		const context = createContext();

		const changelog = await dispatchBuiltinSlashCommand("/changelog", context as any);
		expect(changelog.handled).toBe(true);
		expect(typeof changelog.text).toBe("string");

		const login = await dispatchBuiltinSlashCommand("/login", context as any);
		expect(login.handled).toBe(true);
		expect(login.level).toBe("warning");

		const logout = await dispatchBuiltinSlashCommand("/logout openai", context as any);
		expect(logout.handled).toBe(true);
		expect(context.session.modelRegistry.authStorage.logout).toHaveBeenCalledWith("openai");
	});

	it("returns unhandled for unknown slash command", async () => {
		const context = createContext();
		const result = await dispatchBuiltinSlashCommand("/unknown-cmd", context as any);
		expect(result.handled).toBe(false);
	});
});

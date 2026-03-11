import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, visibleWidth } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createTeamRun } from "../src/core/agent-teams.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderLastLine(container: Container, width = 120): string {
	const last = container.children[container.children.length - 1];
	if (!last) return "";
	return last.render(width).join("\n");
}

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.showStatus", () => {
	beforeAll(() => {
		// showStatus uses the global theme instance
		initTheme("dark");
	});

	test("coalesces immediately-sequential status messages", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_ONE");

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// second status updates the previous line instead of appending
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
		expect(renderLastLine(fakeThis.chatContainer)).not.toContain("STATUS_ONE");
	});

	test("appends a new status line if something else was added in between", () => {
		const fakeThis: any = {
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			lastStatusSpacer: undefined,
			lastStatusText: undefined,
		};

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_ONE");
		expect(fakeThis.chatContainer.children).toHaveLength(2);

		// Something else gets added to the chat in between status updates
		fakeThis.chatContainer.addChild({ render: () => ["OTHER"], invalidate: () => { } });
		expect(fakeThis.chatContainer.children).toHaveLength(3);

		(InteractiveMode as any).prototype.showStatus.call(fakeThis, "STATUS_TWO");
		// adds spacer + text
		expect(fakeThis.chatContainer.children).toHaveLength(5);
		expect(renderLastLine(fakeThis.chatContainer)).toContain("STATUS_TWO");
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	test("keeps rendered resource lines within terminal width", () => {
		const width = 70;
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.options = { verbose: true };
		fakeThis.ui = { terminal: { columns: width } };
		fakeThis.chatContainer = new Container();
		fakeThis.activeProfileName = "full";
		fakeThis.formatDisplayPath = (value: string) => value;
		fakeThis.session = {
			settingsManager: {
				getQuietStartup: () => false,
			},
			promptTemplates: [
				{
					name: "ultra-think-with-very-long-command-name-for-resource-panel-width-test",
				},
			],
			resourceLoader: {
				getPathMetadata: () => ({ paths: [] }),
				getSkills: () => ({
					skills: [
						{
							filePath:
								"/Users/deus21/.codex/skills/custom/really-really-really-long-skill-name/SKILL.md",
						},
					],
					diagnostics: [],
				}),
				getPrompts: () => ({ prompts: [], diagnostics: [] }),
				getThemes: () => ({ themes: [], diagnostics: [] }),
				getExtensions: () => ({ errors: [] }),
				getAgentsFiles: () => ({
					agentsFiles: [
						{
							path: "/Users/deus21/Desktop/Projects/iosm-cli/super-long-folder-name-with-extra-details/AGENTS.md",
						},
					],
				}),
			},
		};

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensionPaths: [
				"/Users/deus21/Desktop/Projects/iosm-cli/extensions/very-long-extension-package-name-for-width-check",
			],
			force: true,
		});

		const rendered = renderAll(fakeThis.chatContainer, width);
		for (const line of rendered.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("InteractiveMode.setWorkingMessage", () => {
	test("updates the active loader message and requests a render", () => {
		const setMessage = vi.fn();
		const fakeThis: any = {
			loadingAnimation: { setMessage },
			defaultWorkingMessage: "Working...",
			keybindings: KeybindingsManager.create(),
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setWorkingMessage.call(fakeThis, "Verifying workspace");

		expect(setMessage).toHaveBeenCalledWith("Verifying workspace");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("queues the message when no loader is active yet", () => {
		const fakeThis: any = {
			loadingAnimation: undefined,
			pendingWorkingMessage: undefined,
			defaultWorkingMessage: "Working...",
			keybindings: KeybindingsManager.create(),
			ui: { requestRender: vi.fn() },
		};

		(InteractiveMode as any).prototype.setWorkingMessage.call(fakeThis, "Waiting for model response");

		expect(fakeThis.pendingWorkingMessage).toBe("Waiting for model response");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode.createExtensionUIContext setTheme", () => {
	test("persists theme changes to settings manager", () => {
		initTheme("dark");

		let currentTheme = "dark";
		const settingsManager = {
			getTheme: vi.fn(() => currentTheme),
			setTheme: vi.fn((theme: string) => {
				currentTheme = theme;
			}),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("light");

		expect(result.success).toBe(true);
		expect(settingsManager.setTheme).toHaveBeenCalledWith("light");
		expect(currentTheme).toBe("light");
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("does not persist invalid theme names", () => {
		initTheme("dark");

		const settingsManager = {
			getTheme: vi.fn(() => "dark"),
			setTheme: vi.fn(),
		};
		const fakeThis: any = {
			session: { settingsManager },
			settingsManager,
			ui: { requestRender: vi.fn() },
		};

		const uiContext = (InteractiveMode as any).prototype.createExtensionUIContext.call(fakeThis);
		const result = uiContext.setTheme("__missing_theme__");

		expect(result.success).toBe(false);
		expect(settingsManager.setTheme).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.updateTerminalTitle", () => {
	test("uses iosm branding instead of legacy pi title", () => {
		const setTitle = vi.fn();
		const fakeThis: any = {
			ui: { terminal: { setTitle } },
			sessionManager: {
				getSessionName: () => "audit-session",
			},
		};

		(InteractiveMode as any).prototype.updateTerminalTitle.call(fakeThis);

		expect(setTitle).toHaveBeenCalledTimes(1);
		expect(setTitle.mock.calls[0]?.[0]).toContain("iosm - audit-session");
		expect(setTitle.mock.calls[0]?.[0]).not.toContain("π");
	});
});

describe("InteractiveMode.showLoadedResources", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createShowLoadedResourcesThis(options: {
		quietStartup: boolean;
		verbose?: boolean;
		skills?: Array<{ filePath: string }>;
		skillDiagnostics?: Array<{ type: "warning" | "error" | "collision"; message: string }>;
	}) {
		const fakeThis: any = {
			options: { verbose: options.verbose ?? false },
			chatContainer: new Container(),
			settingsManager: {
				getQuietStartup: () => options.quietStartup,
			},
			session: {
				promptTemplates: [],
				extensionRunner: undefined,
				resourceLoader: {
					getPathMetadata: () => new Map(),
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getSkills: () => ({
						skills: options.skills ?? [],
						diagnostics: options.skillDiagnostics ?? [],
					}),
					getPrompts: () => ({ prompts: [], diagnostics: [] }),
					getExtensions: () => ({ errors: [] }),
					getThemes: () => ({ themes: [], diagnostics: [] }),
				},
			},
			formatDisplayPath: (p: string) => p,
			buildScopeGroups: () => [],
			formatScopeGroups: () => "resource-list",
			getShortPath: (p: string) => p,
			formatDiagnostics: () => "diagnostics",
		};

		return fakeThis;
	}

	test("does not show verbose listing on quiet startup during reload", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			extensionPaths: ["/tmp/ext/index.ts"],
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		expect(fakeThis.chatContainer.children).toHaveLength(0);
	});

	test("still shows diagnostics on quiet startup when requested", () => {
		const fakeThis = createShowLoadedResourcesThis({
			quietStartup: true,
			skills: [{ filePath: "/tmp/skill/SKILL.md" }],
			skillDiagnostics: [{ type: "warning", message: "duplicate skill name" }],
		});

		(InteractiveMode as any).prototype.showLoadedResources.call(fakeThis, {
			force: false,
			showDiagnosticsWhenQuiet: true,
		});

		const output = renderAll(fakeThis.chatContainer);
		expect(output).toContain("[Skill conflicts]");
		expect(output).not.toContain("[Skills]");
	});
});

describe("InteractiveMode startup control center", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	function createStartupFakeThis(overrides: {
		profileName: string;
		cwd: string;
		hasModel?: boolean;
	}) {
		return {
			keybindings: KeybindingsManager.create(),
			version: "9.9.9",
			activeProfileName: overrides.profileName,
			sessionManager: {
				getCwd: () => overrides.cwd,
			},
			session: {
				model: overrides.hasModel ? { provider: "test", id: "test-model" } : undefined,
				modelRegistry: {
					getAvailable: () => overrides.hasModel ? [{ id: "test-model" }] : [],
					authStorage: { list: () => overrides.hasModel ? [{ provider: "test" }] : [] },
				},
			},
			mcpRuntime: { getServers: () => [] },
			hasIosmWorkspace: (InteractiveMode as any).prototype.hasIosmWorkspace,
			getMemoryEntryCount: () => 0,
		};
	}

	test("shows standard startup guidance outside iosm profile", () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-startup-"));
		const fakeThis: any = createStartupFakeThis({ profileName: "full", cwd });

		const output = stripAnsi((InteractiveMode as any).prototype.buildStartupHeaderContent.call(fakeThis));
		expect(output).toContain("standard");
		expect(output).toContain("full");
		expect(output).toContain("/model");
	});

	test("shows iosm startup guidance when iosm profile is active", () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-startup-ready-"));
		mkdirSync(join(cwd, ".iosm"));
		const fakeThis: any = createStartupFakeThis({ profileName: "iosm", cwd, hasModel: true });

		const output = stripAnsi((InteractiveMode as any).prototype.buildStartupHeaderContent.call(fakeThis));
		expect(output).toContain("iosm");
		expect(output).toContain("Mode");
		expect(output).toContain("Ready");
	});
});

describe("InteractiveMode.updatePendingMessagesDisplay", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps pending bash components visible while rendering queued message summary", () => {
		const pendingMessagesContainer = new Container();
		const bashComponent = {
			render: () => ["BASH COMPONENT"],
			invalidate: () => { },
		};
		const fakeThis: any = {
			pendingMessagesContainer,
			pendingBashComponents: [bashComponent],
			getAllQueuedMessages: () => ({
				steering: ["Refactor parser internals"],
				followUp: ["Re-run integration tests"],
			}),
			getAppKeyDisplay: () => "Ctrl+Q",
			previewPendingMessage: (InteractiveMode as any).prototype.previewPendingMessage,
		};

		(InteractiveMode as any).prototype.updatePendingMessagesDisplay.call(fakeThis);

		expect(fakeThis.pendingMessagesContainer.children).toContain(bashComponent);
		const output = stripAnsi(renderAll(fakeThis.pendingMessagesContainer));
		expect(output).toContain("Queue 2");
		expect(output).toContain("steer");
		expect(output).toContain("follow-up");
		expect(output).toContain("Pending bash 1");
		expect(output).toContain("BASH COMPONENT");
	});
});

describe("InteractiveMode.interruptCurrentWork", () => {
	test("stops active work, restores queued input, and cancels IOSM automation", async () => {
		const fakeThis: any = {
			session: {
				isStreaming: true,
				isRetrying: true,
				isCompacting: true,
				isBashRunning: true,
				abort: vi.fn(async () => { }),
				abortBash: vi.fn(),
				abortRetry: vi.fn(),
				abortCompaction: vi.fn(),
				abortBranchSummary: vi.fn(),
			},
			iosmAutomationRun: {
				cancelRequested: false,
				iterationsCompleted: 2,
			},
			iosmVerificationSession: {
				abort: vi.fn(async () => { }),
			},
			getAllQueuedMessages: () => ({
				steering: ["queued steer"],
				followUp: ["queued follow-up"],
			}),
			restoreQueuedMessagesToEditor: vi.fn(() => 2),
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		const interrupted = await (InteractiveMode as any).prototype.interruptCurrentWork.call(fakeThis);

		expect(interrupted).toBe(true);
		expect(fakeThis.iosmAutomationRun.cancelRequested).toBe(true);
		expect(fakeThis.restoreQueuedMessagesToEditor).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.abortBash).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.abortRetry).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.abortCompaction).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.abortBranchSummary).toHaveBeenCalledTimes(1);
		expect(fakeThis.session.abort).toHaveBeenCalledTimes(1);
		expect(fakeThis.iosmVerificationSession.abort).toHaveBeenCalledTimes(1);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Stopping IOSM automation...");
	});

	test("returns false when no interruptible work is active", async () => {
		const fakeThis: any = {
			session: {
				isStreaming: false,
				isRetrying: false,
				isCompacting: false,
				isBashRunning: false,
				abort: vi.fn(async () => { }),
				abortBash: vi.fn(),
				abortRetry: vi.fn(),
				abortCompaction: vi.fn(),
				abortBranchSummary: vi.fn(),
			},
			iosmAutomationRun: undefined,
			iosmVerificationSession: undefined,
			getAllQueuedMessages: () => ({
				steering: [],
				followUp: [],
			}),
			restoreQueuedMessagesToEditor: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			showStatus: vi.fn(),
		};

		const interrupted = await (InteractiveMode as any).prototype.interruptCurrentWork.call(fakeThis);

		expect(interrupted).toBe(false);
		expect(fakeThis.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.showMcpSelector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("focuses MCP selector container so cancel keys are handled", () => {
		const showSelector = vi.fn((create: (done: () => void) => { component: unknown; focus: unknown }) => {
			const result = create(() => { });
			expect(result.focus).toBe(result.component);
		});

		const fakeThis: any = {
			mcpRuntime: {
				getServers: () => [],
			},
			showSelector,
			showWarning: vi.fn(),
			ui: { requestRender: vi.fn() },
			editor: { setText: vi.fn() },
			syncMcpToolsWithSession: vi.fn(),
			refreshMcpRuntimeAndSession: vi.fn(async () => { }),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		(InteractiveMode as any).prototype.showMcpSelector.call(fakeThis);

		expect(showSelector).toHaveBeenCalledTimes(1);
	});
});

describe("InteractiveMode checkpoint and rollback", () => {
	test("creates checkpoint on current leaf with auto-generated name", () => {
		const appendLabelChange = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const showCommandTextBlock = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			sessionManager: {
				getLeafId: () => "leaf-1",
				getEntries: () => [],
				appendLabelChange,
			},
		};
		fakeThis.showStatus = showStatus;
		fakeThis.showWarning = showWarning;
		fakeThis.showCommandTextBlock = showCommandTextBlock;

		(InteractiveMode as any).prototype.handleCheckpointCommand.call(fakeThis, "/checkpoint");

		expect(appendLabelChange).toHaveBeenCalledWith("leaf-1", "checkpoint:cp-1");
		expect(showStatus).toHaveBeenCalledWith("Checkpoint saved: cp-1 (leaf-1)");
		expect(showWarning).not.toHaveBeenCalled();
	});

	test("rolls back to latest checkpoint when no selector is provided", async () => {
		const navigateTree = vi.fn(async () => ({ cancelled: false }));
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const showError = vi.fn();
		const renderInitialMessages = vi.fn();
		const clear = vi.fn();
		const setText = vi.fn();

		const targetEntry = {
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: "2026-03-10T10:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
		};
		const labelEntry = {
			type: "label",
			id: "label-1",
			parentId: "msg-1",
			timestamp: "2026-03-10T10:01:00.000Z",
			targetId: "msg-1",
			label: "checkpoint:release-ready",
		};

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			navigateTree,
			sessionManager: {
				getEntries: () => [targetEntry, labelEntry],
				getEntry: (id: string) => (id === "msg-1" ? targetEntry : undefined),
			},
		};
		fakeThis.chatContainer = { clear };
		fakeThis.renderInitialMessages = renderInitialMessages;
		fakeThis.editor = { getText: () => "", setText };
		fakeThis.showStatus = showStatus;
		fakeThis.showWarning = showWarning;
		fakeThis.showError = showError;
		fakeThis.showCommandTextBlock = vi.fn();

		await (InteractiveMode as any).prototype.handleRollbackCommand.call(fakeThis, "/rollback");

		expect(navigateTree).toHaveBeenCalledWith("msg-1", { summarize: false });
		expect(clear).toHaveBeenCalledTimes(1);
		expect(renderInitialMessages).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Rolled back to checkpoint: release-ready");
		expect(showWarning).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode interactive command flows", () => {
	test("selects a team run interactively when /team-status has no id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-team-status-"));
		try {
			const run = createTeamRun({
				cwd,
				mode: "parallel",
				agents: 1,
				task: "run checks",
				assignments: [{ profile: "full", cwd, dependsOn: [] }],
			});
			const showExtensionSelector = vi.fn(async (_title: string, options: string[]) => options[0]);
			const showCommandTextBlock = vi.fn();
			const showStatus = vi.fn();
			const showWarning = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = {
				sessionManager: {
					getCwd: () => cwd,
				},
			};
			fakeThis.ui = {};
			fakeThis.editorContainer = {};
			fakeThis.showExtensionSelector = showExtensionSelector;
			fakeThis.showCommandTextBlock = showCommandTextBlock;
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;

			await (InteractiveMode as any).prototype.handleTeamStatusSlashCommand.call(fakeThis, "/team-status");

			expect(showExtensionSelector).toHaveBeenCalledTimes(1);
			expect(showCommandTextBlock).toHaveBeenCalledWith("Team Status", expect.stringContaining(`Run: ${run.runId}`));
			expect(showStatus).not.toHaveBeenCalledWith("Team status cancelled.");
			expect(showWarning).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("cancels interactive /team-status when selector is dismissed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-team-status-cancel-"));
		try {
			createTeamRun({
				cwd,
				mode: "parallel",
				agents: 1,
				task: "run checks",
				assignments: [{ profile: "full", cwd, dependsOn: [] }],
			});
			const showExtensionSelector = vi.fn(async () => undefined);
			const showCommandTextBlock = vi.fn();
			const showStatus = vi.fn();
			const showWarning = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = {
				sessionManager: {
					getCwd: () => cwd,
				},
			};
			fakeThis.ui = {};
			fakeThis.editorContainer = {};
			fakeThis.showExtensionSelector = showExtensionSelector;
			fakeThis.showCommandTextBlock = showCommandTextBlock;
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;

			await (InteractiveMode as any).prototype.handleTeamStatusSlashCommand.call(fakeThis, "/team-status");

			expect(showStatus).toHaveBeenCalledWith("Team status cancelled.");
			expect(showCommandTextBlock).not.toHaveBeenCalled();
			expect(showWarning).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("runs interactive export wizard and confirms overwrite", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-export-interactive-"));
		try {
			const outputPath = join(cwd, "session-export.html");
			writeFileSync(outputPath, "<html>old</html>", "utf8");
			const exportToHtml = vi.fn(async () => outputPath);
			const showExtensionInput = vi.fn(async () => outputPath);
			const showExtensionConfirm = vi.fn(async () => true);
			const showStatus = vi.fn();
			const showWarning = vi.fn();
			const showError = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = { exportToHtml };
			fakeThis.ui = {};
			fakeThis.editorContainer = {};
			fakeThis.showExtensionInput = showExtensionInput;
			fakeThis.showExtensionConfirm = showExtensionConfirm;
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;
			fakeThis.showError = showError;

			await (InteractiveMode as any).prototype.handleExportCommand.call(fakeThis, "/export");

			expect(showExtensionInput).toHaveBeenCalledTimes(1);
			expect(showExtensionConfirm).toHaveBeenCalledWith("Overwrite existing export file?", outputPath);
			expect(exportToHtml).toHaveBeenCalledWith(outputPath);
			expect(showStatus).toHaveBeenCalledWith(`Session exported to: ${outputPath}`);
			expect(showWarning).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("cancels export when overwrite confirmation is rejected", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-export-cancel-"));
		try {
			const outputPath = join(cwd, "session-export.html");
			writeFileSync(outputPath, "<html>old</html>", "utf8");
			const exportToHtml = vi.fn(async () => outputPath);
			const showExtensionInput = vi.fn(async () => outputPath);
			const showExtensionConfirm = vi.fn(async () => false);
			const showStatus = vi.fn();
			const showWarning = vi.fn();
			const showError = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = { exportToHtml };
			fakeThis.ui = {};
			fakeThis.editorContainer = {};
			fakeThis.showExtensionInput = showExtensionInput;
			fakeThis.showExtensionConfirm = showExtensionConfirm;
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;
			fakeThis.showError = showError;

			await (InteractiveMode as any).prototype.handleExportCommand.call(fakeThis, "/export");

			expect(showExtensionConfirm).toHaveBeenCalledWith("Overwrite existing export file?", outputPath);
			expect(showStatus).toHaveBeenCalledWith("Export cancelled");
			expect(exportToHtml).not.toHaveBeenCalled();
			expect(showWarning).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode OpenRouter login flow", () => {
	test("saves OpenRouter API key and opens model selector", async () => {
		const authStorage = AuthStorage.inMemory();
		const refresh = vi.fn();
		const showExtensionConfirm = vi.fn(async () => true);
		const showExtensionInput = vi.fn(async () => "  sk-or-v1-test-key  ");
		const updateAvailableProviderCount = vi.fn(async () => { });
		const showModelSelector = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			modelRegistry: {
				authStorage,
				refresh,
			},
		};
		fakeThis.showExtensionConfirm = showExtensionConfirm;
		fakeThis.showExtensionInput = showExtensionInput;
		fakeThis.updateAvailableProviderCount = updateAvailableProviderCount;
		fakeThis.showModelSelector = showModelSelector;
		fakeThis.showStatus = showStatus;
		fakeThis.showWarning = showWarning;
		fakeThis.getProviderDisplayName = (InteractiveMode as any).prototype.getProviderDisplayName.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleOpenRouterApiKeyLogin.call(fakeThis);

		expect(authStorage.get("openrouter")).toEqual({ type: "api_key", key: "sk-or-v1-test-key" });
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(updateAvailableProviderCount).toHaveBeenCalledTimes(1);
		expect(showModelSelector).toHaveBeenCalledWith("openrouter");
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("OpenRouter API key saved"));
		expect(showWarning).not.toHaveBeenCalled();
	});

	test("cancels OpenRouter API key overwrite when user rejects confirmation", async () => {
		const authStorage = AuthStorage.inMemory({
			openrouter: { type: "api_key", key: "old-key" },
		});
		const refresh = vi.fn();
		const showExtensionConfirm = vi.fn(async () => false);
		const showExtensionInput = vi.fn(async () => "sk-or-v1-new");
		const updateAvailableProviderCount = vi.fn(async () => { });
		const showModelSelector = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			modelRegistry: {
				authStorage,
				refresh,
			},
		};
		fakeThis.showExtensionConfirm = showExtensionConfirm;
		fakeThis.showExtensionInput = showExtensionInput;
		fakeThis.updateAvailableProviderCount = updateAvailableProviderCount;
		fakeThis.showModelSelector = showModelSelector;
		fakeThis.showStatus = showStatus;
		fakeThis.showWarning = showWarning;
		fakeThis.getProviderDisplayName = (InteractiveMode as any).prototype.getProviderDisplayName.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleOpenRouterApiKeyLogin.call(fakeThis);

		expect(showExtensionConfirm).toHaveBeenCalledTimes(1);
		expect(showExtensionInput).not.toHaveBeenCalled();
		expect(authStorage.get("openrouter")).toEqual({ type: "api_key", key: "old-key" });
		expect(refresh).not.toHaveBeenCalled();
		expect(updateAvailableProviderCount).not.toHaveBeenCalled();
		expect(showModelSelector).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("OpenRouter login cancelled.");
		expect(showWarning).not.toHaveBeenCalled();
	});

	test("shows warning when OpenRouter API key input is empty", async () => {
		const authStorage = AuthStorage.inMemory();
		const refresh = vi.fn();
		const showExtensionConfirm = vi.fn(async () => true);
		const showExtensionInput = vi.fn(async () => "   ");
		const updateAvailableProviderCount = vi.fn(async () => { });
		const showModelSelector = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			modelRegistry: {
				authStorage,
				refresh,
			},
		};
		fakeThis.showExtensionConfirm = showExtensionConfirm;
		fakeThis.showExtensionInput = showExtensionInput;
		fakeThis.updateAvailableProviderCount = updateAvailableProviderCount;
		fakeThis.showModelSelector = showModelSelector;
		fakeThis.showStatus = showStatus;
		fakeThis.showWarning = showWarning;
		fakeThis.getProviderDisplayName = (InteractiveMode as any).prototype.getProviderDisplayName.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleOpenRouterApiKeyLogin.call(fakeThis);

		expect(authStorage.get("openrouter")).toBeUndefined();
		expect(refresh).not.toHaveBeenCalled();
		expect(updateAvailableProviderCount).not.toHaveBeenCalled();
		expect(showModelSelector).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("OpenRouter API key cannot be empty.");
	});
});

describe("InteractiveMode models.dev API-key provider hydration", () => {
	test("registers models.dev provider models after API-key login", async () => {
		const authStorage = AuthStorage.inMemory();
		const registeredModels: Array<{ provider: string; id: string }> = [];
		const registerProvider = vi.fn((providerId: string, config: { models?: Array<{ id: string }> }) => {
			for (const model of config.models ?? []) {
				registeredModels.push({ provider: providerId, id: model.id });
			}
		});
		const getAll = vi.fn(() => registeredModels);
		const updateAvailableProviderCount = vi.fn(async () => { });
		const showModelProviderSelector = vi.fn(async () => { });
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const showExtensionInput = vi.fn(async () => "z-key-123");
		const showExtensionConfirm = vi.fn(async () => true);

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			modelRegistry: {
				authStorage,
				getAll,
				registerProvider,
			},
		};
		fakeThis.updateAvailableProviderCount = updateAvailableProviderCount;
		fakeThis.showModelProviderSelector = showModelProviderSelector;
		fakeThis.showStatus = showStatus;
		fakeThis.showWarning = showWarning;
		fakeThis.showExtensionInput = showExtensionInput;
		fakeThis.showExtensionConfirm = showExtensionConfirm;
		fakeThis.getProviderDisplayName = (InteractiveMode as any).prototype.getProviderDisplayName.bind(fakeThis);
		fakeThis.modelsDevProviderCatalogById = new Map([
			[
				"zai-coding-plan",
				{
					id: "zai-coding-plan",
					name: "Z.AI Coding Plan",
					env: ["ZHIPU_API_KEY"],
					api: "https://api.z.ai/api/coding/paas/v4",
					npm: "@ai-sdk/openai-compatible",
					models: [
						{
							id: "glm-5",
							name: "GLM-5",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 8192,
							headers: {},
							api: "https://api.z.ai/api/coding/paas/v4",
							npm: "@ai-sdk/openai-compatible",
						},
					],
				},
			],
		]);
		fakeThis.refreshModelsDevProviderCatalog = vi.fn(async () => { });

		await (InteractiveMode as any).prototype.handleApiKeyLogin.call(fakeThis, "zai-coding-plan", {
			providerName: "Z.AI Coding Plan",
		});

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(registerProvider).toHaveBeenCalledWith(
			"zai-coding-plan",
			expect.objectContaining({
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
				models: [expect.objectContaining({ id: "glm-5", api: "openai-completions" })],
			}),
		);
		expect(updateAvailableProviderCount).toHaveBeenCalledTimes(1);
		expect(showModelProviderSelector).toHaveBeenCalledWith("zai-coding-plan");
		expect(showWarning).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("API key saved"));
		expect(authStorage.get("zai-coding-plan")).toEqual({ type: "api_key", key: "z-key-123" });
	});
});

describe("InteractiveMode startup model restoration", () => {
	test("restores saved default model after provider hydration", async () => {
		const restoredModel = { provider: "zai-coding-plan", id: "glm-5" };
		const setModel = vi.fn();
		const hydrateProviderModelsFromModelsDev = vi.fn(async () => true);
		const hasRegisteredProviderModels = vi.fn(() => false);
		const find = vi.fn(() => restoredModel);
		const getApiKey = vi.fn(async () => "z-key-123");

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			model: undefined,
			agent: { setModel },
			settingsManager: {
				getDefaultProvider: () => "zai-coding-plan",
				getDefaultModel: () => "glm-5",
			},
			modelRegistry: {
				find,
				getApiKey,
			},
		};
		fakeThis.hydrateProviderModelsFromModelsDev = hydrateProviderModelsFromModelsDev;
		fakeThis.hasRegisteredProviderModels = hasRegisteredProviderModels;

		await (InteractiveMode as any).prototype.restoreSavedModelSelectionOnStartup.call(fakeThis);

		expect(hasRegisteredProviderModels).toHaveBeenCalledWith("zai-coding-plan");
		expect(hydrateProviderModelsFromModelsDev).toHaveBeenCalledWith("zai-coding-plan");
		expect(find).toHaveBeenCalledWith("zai-coding-plan", "glm-5");
		expect(getApiKey).toHaveBeenCalledWith(restoredModel);
		expect(setModel).toHaveBeenCalledWith(restoredModel);
	});

	test("does not override model when session already has active model", async () => {
		const setModel = vi.fn();
		const hydrateProviderModelsFromModelsDev = vi.fn(async () => true);
		const hasRegisteredProviderModels = vi.fn(() => false);

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			model: { provider: "openai", id: "gpt-5" },
			agent: { setModel },
			settingsManager: {
				getDefaultProvider: () => "zai-coding-plan",
				getDefaultModel: () => "glm-5",
			},
			modelRegistry: {
				find: vi.fn(),
				getApiKey: vi.fn(),
			},
		};
		fakeThis.hydrateProviderModelsFromModelsDev = hydrateProviderModelsFromModelsDev;
		fakeThis.hasRegisteredProviderModels = hasRegisteredProviderModels;

		await (InteractiveMode as any).prototype.restoreSavedModelSelectionOnStartup.call(fakeThis);

		expect(hydrateProviderModelsFromModelsDev).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
	});

	test("skips restore when saved model has no API key", async () => {
		const restoredModel = { provider: "zai-coding-plan", id: "glm-5" };
		const setModel = vi.fn();
		const find = vi.fn(() => restoredModel);
		const getApiKey = vi.fn(async () => undefined);

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.session = {
			model: undefined,
			agent: { setModel },
			settingsManager: {
				getDefaultProvider: () => "zai-coding-plan",
				getDefaultModel: () => "glm-5",
			},
			modelRegistry: {
				find,
				getApiKey,
			},
		};
		fakeThis.hydrateProviderModelsFromModelsDev = vi.fn(async () => true);
		fakeThis.hasRegisteredProviderModels = vi.fn(() => true);

		await (InteractiveMode as any).prototype.restoreSavedModelSelectionOnStartup.call(fakeThis);

		expect(find).toHaveBeenCalledWith("zai-coding-plan", "glm-5");
		expect(getApiKey).toHaveBeenCalledWith(restoredModel);
		expect(setModel).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode doctor command", () => {
	test("includes external CLI tool status block in JSON report", async () => {
		const showCommandJsonBlock = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.getHookPolicySummary = () => undefined;
		fakeThis.activeProfileName = "full";
		fakeThis.permissionMode = "ask";
		fakeThis.permissionAllowRules = [];
		fakeThis.permissionDenyRules = [];
		Object.defineProperty(fakeThis, "sessionManager", {
			value: {
				getCwd: () => process.cwd(),
				getSessionFile: () => null,
			},
			configurable: true,
		});
		fakeThis.session = {
			model: undefined,
			modelRegistry: {
				getAll: () => [],
				getAvailable: () => [],
				getError: () => null,
				authStorage: {
					list: () => [],
					hasAuth: () => false,
				},
			},
			resourceLoader: {
				getExtensions: () => ({ errors: [] }),
				getSkills: () => ({ diagnostics: [] }),
				getPrompts: () => ({ diagnostics: [] }),
				getThemes: () => ({ diagnostics: [] }),
			},
		};
		fakeThis.mcpRuntime = undefined;
		fakeThis.contractService = {
			getState: () => ({
				projectPath: join(process.cwd(), ".iosm", "contract.json"),
				hasProjectFile: false,
				project: {},
				sessionOverlay: {},
				effective: {},
			}),
			getProjectPath: () => join(process.cwd(), ".iosm", "contract.json"),
		};
		fakeThis.singularService = {
			getAnalysesRoot: () => join(process.cwd(), ".iosm", "singular"),
		};
		fakeThis.showCommandJsonBlock = showCommandJsonBlock;
		fakeThis.showCommandTextBlock = vi.fn();
		fakeThis.runDoctorInteractiveFixes = vi.fn();

		await (InteractiveMode as any).prototype.handleDoctorCommand.call(fakeThis, "/doctor --json");

		expect(showCommandJsonBlock).toHaveBeenCalledTimes(1);
		expect(showCommandJsonBlock).toHaveBeenCalledWith(
			"Doctor Report",
			expect.objectContaining({
				externalCliTools: expect.any(Array),
				checks: expect.any(Array),
			}),
		);

		const payload = showCommandJsonBlock.mock.calls[0]?.[1] as {
			externalCliTools: Array<{ tool: string }>;
			checks: Array<{ label: string }>;
		};
		expect(payload.externalCliTools.map((tool) => tool.tool)).toEqual(
			expect.arrayContaining(["rg", "fd", "ast_grep", "comby", "jq", "yq", "semgrep", "sed"]),
		);
		expect(payload.checks.some((check) => check.label === "CLI toolchain")).toBe(true);
	});
});

describe("OAuthSelectorComponent login providers", () => {
	test("shows OpenRouter API key option in login selector", () => {
		initTheme("dark");
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent("login", authStorage, () => { }, () => { });

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("OpenRouter");
		expect(rendered).toContain("API key");
	});

	test("renders injected API key providers in login selector", () => {
		initTheme("dark");
		const authStorage = AuthStorage.inMemory();
		const selector = new OAuthSelectorComponent(
			"login",
			authStorage,
			() => { },
			() => { },
			[
				{ id: "openrouter", name: "OpenRouter", kind: "api_key" },
				{ id: "deepseek", name: "DeepSeek", kind: "api_key" },
			],
		);

		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain("OpenRouter");
		expect(rendered).toContain("DeepSeek");
		expect(rendered).toContain("API key");
	});

	test("limits visible rows and allows filtering in long provider lists", () => {
		initTheme("dark");
		const authStorage = AuthStorage.inMemory();
		const manyProviders = Array.from({ length: 25 }, (_, i) => {
			const index = String(i + 1).padStart(2, "0");
			return { id: `provider-${index}`, name: `Provider ${index}`, kind: "api_key" as const };
		});
		const selector = new OAuthSelectorComponent("login", authStorage, () => { }, () => { }, manyProviders);

		const initialRendered = stripAnsi(selector.render(120).join("\n"));
		expect(initialRendered).toContain("Provider 01");
		expect(initialRendered).not.toContain("Provider 25");

		for (const ch of "provider 25") {
			selector.handleInput(ch);
		}
		const filteredRendered = stripAnsi(selector.render(120).join("\n"));
		expect(filteredRendered).toContain("Provider 25");
		expect(filteredRendered).not.toContain("Provider 01");
	});
});

describe("InteractiveMode memory command", () => {
	test("adds memory entry via shorthand and writes project memory.md", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-memory-project-"));
		try {
			const reload = vi.fn(async () => { });
			const showStatus = vi.fn();
			const showWarning = vi.fn();
			const showError = vi.fn();
			const showCommandTextBlock = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = {
				reload,
				sessionManager: {
					getCwd: () => cwd,
				},
			};
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;
			fakeThis.showError = showError;
			fakeThis.showCommandTextBlock = showCommandTextBlock;

			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory project starts via PM2");

			const memoryPath = join(cwd, ".iosm", "memory.md");
			const content = readFileSync(memoryPath, "utf8");
			expect(content).toContain("iosm-memory:start");
			expect(content).toContain("project starts via PM2");
			expect(reload).toHaveBeenCalledTimes(1);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Memory saved (project) #1"));
			expect(showWarning).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("removes memory entry by index", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-memory-rm-"));
		try {
			const reload = vi.fn(async () => { });
			const showStatus = vi.fn();
			const showWarning = vi.fn();
			const showError = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = {
				reload,
				sessionManager: {
					getCwd: () => cwd,
				},
			};
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;
			fakeThis.showError = showError;
			fakeThis.showCommandTextBlock = vi.fn();

			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory add first note");
			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory add second note");
			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory rm 1");

			const memoryPath = join(cwd, ".iosm", "memory.md");
			const content = readFileSync(memoryPath, "utf8");
			expect(content).not.toContain("first note");
			expect(content).toContain("second note");
			expect(reload).toHaveBeenCalledTimes(3);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Removed memory #1 (project)"));
			expect(showWarning).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("updates memory entry by index", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-memory-edit-"));
		try {
			const reload = vi.fn(async () => { });
			const showStatus = vi.fn();
			const showWarning = vi.fn();
			const showError = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = {
				reload,
				sessionManager: {
					getCwd: () => cwd,
				},
			};
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;
			fakeThis.showError = showError;
			fakeThis.showCommandTextBlock = vi.fn();
			fakeThis.showExtensionEditor = vi.fn(async () => "first note updated");

			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory add first note");
			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory add second note");
			await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory edit 1");

			const memoryPath = join(cwd, ".iosm", "memory.md");
			const content = readFileSync(memoryPath, "utf8");
			expect(content).toContain("first note updated");
			expect(content).toContain("second note");
			expect(content).not.toContain("first note\n");
			expect(reload).toHaveBeenCalledTimes(3);
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Updated memory #1 (project)"));
			expect(showWarning).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("opens memory interactive manager when no subcommand is provided", async () => {
		const runMemoryInteractiveMenu = vi.fn(async () => { });
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.runMemoryInteractiveMenu = runMemoryInteractiveMenu;
		fakeThis.showWarning = vi.fn();
		fakeThis.parseMemoryScopeOptions = (InteractiveMode as any).prototype.parseMemoryScopeOptions;
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs;

		await (InteractiveMode as any).prototype.handleMemoryCommand.call(fakeThis, "/memory");

		expect(runMemoryInteractiveMenu).toHaveBeenCalledWith("project");
	});

	test("writes to user memory when --scope user is provided", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-memory-user-cwd-"));
		const agentDir = mkdtempSync(join(tmpdir(), "iosm-memory-agent-"));
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		try {
			process.env[ENV_AGENT_DIR] = agentDir;
			const reload = vi.fn(async () => { });
			const showStatus = vi.fn();
			const showWarning = vi.fn();
			const showError = vi.fn();

			const fakeThis: any = Object.create((InteractiveMode as any).prototype);
			fakeThis.session = {
				reload,
				sessionManager: {
					getCwd: () => cwd,
				},
			};
			fakeThis.showStatus = showStatus;
			fakeThis.showWarning = showWarning;
			fakeThis.showError = showError;
			fakeThis.showCommandTextBlock = vi.fn();

			await (InteractiveMode as any).prototype.handleMemoryCommand.call(
				fakeThis,
				"/memory --scope user global deployment uses PM2",
			);

			const memoryPath = join(agentDir, "memory.md");
			const content = readFileSync(memoryPath, "utf8");
			expect(content).toContain("global deployment uses PM2");
			expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Memory saved (user) #1"));
			expect(showWarning).not.toHaveBeenCalled();
			expect(showError).not.toHaveBeenCalled();
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = originalAgentDir;
			}
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode semantic command", () => {
	test("shows semantic help in command block", async () => {
		const showCommandTextBlock = vi.fn();
		const showWarning = vi.fn();
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.showCommandTextBlock = showCommandTextBlock;
		fakeThis.showWarning = showWarning;
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleSemanticCommand.call(fakeThis, "/semantic help");

		expect(showWarning).not.toHaveBeenCalled();
		expect(showCommandTextBlock).toHaveBeenCalledWith(
			"Semantic Help",
			expect.stringContaining("/semantic auto-index"),
		);
	});

	test("warns when /semantic query has no query text", async () => {
		const showWarning = vi.fn();
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.showWarning = showWarning;
		fakeThis.showCommandTextBlock = vi.fn();
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleSemanticCommand.call(fakeThis, "/semantic query --top-k 8");

		expect(showWarning).toHaveBeenCalledWith("Usage: /semantic query <text> [--top-k N]");
	});

	test("parses /semantic auto-index on and forwards to updater", async () => {
		const updateSemanticAutoIndexSetting = vi.fn();
		const showWarning = vi.fn();
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.updateSemanticAutoIndexSetting = updateSemanticAutoIndexSetting;
		fakeThis.showWarning = showWarning;
		fakeThis.showCommandTextBlock = vi.fn();
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs.bind(fakeThis);
		fakeThis.parseSemanticScopeOptions = (InteractiveMode as any).prototype.parseSemanticScopeOptions.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleSemanticCommand.call(
			fakeThis,
			"/semantic auto-index on --scope project",
		);

		expect(showWarning).not.toHaveBeenCalled();
		expect(updateSemanticAutoIndexSetting).toHaveBeenCalledWith({
			scope: "project",
			value: true,
		});
	});
});

describe("InteractiveMode contract/singular commands", () => {
	test("shows contract help in command block", async () => {
		const showCommandTextBlock = vi.fn();
		const showWarning = vi.fn();
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.showCommandTextBlock = showCommandTextBlock;
		fakeThis.showWarning = showWarning;
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleContractCommand.call(fakeThis, "/contract help");

		expect(showWarning).not.toHaveBeenCalled();
		expect(showCommandTextBlock).toHaveBeenCalledWith(
			"Contract Help",
			expect.stringContaining("/contract edit --scope"),
		);
	});

	test("routes /singular request to analyzer", async () => {
		const runSingularAnalysis = vi.fn();
		const showWarning = vi.fn();
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.runSingularAnalysis = runSingularAnalysis;
		fakeThis.showCommandTextBlock = vi.fn();
		fakeThis.showWarning = showWarning;
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleSingularCommand.call(fakeThis, "/singular добавить личный кабинет");

		expect(runSingularAnalysis).toHaveBeenCalledWith("добавить личный кабинет");
		expect(showWarning).not.toHaveBeenCalled();
	});

	test("shows /singular help in command block", async () => {
		const showCommandTextBlock = vi.fn();
		const showWarning = vi.fn();
		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.runSingularAnalysis = vi.fn();
		fakeThis.showCommandTextBlock = showCommandTextBlock;
		fakeThis.showWarning = showWarning;
		fakeThis.parseSlashArgs = (InteractiveMode as any).prototype.parseSlashArgs.bind(fakeThis);

		await (InteractiveMode as any).prototype.handleSingularCommand.call(fakeThis, "/singular help");

		expect(showWarning).not.toHaveBeenCalled();
		expect(showCommandTextBlock).toHaveBeenCalledWith("Singular Help", expect.stringContaining("/singular <feature request>"));
	});

	test("runSingularAnalysis merges agent feasibility output and saves final analysis", async () => {
		const baseline = {
			runId: "2026-03-11-090000",
			request: "add account dashboard",
			generatedAt: "2026-03-11T09:00:00.000Z",
			scannedFiles: 120,
			sourceFiles: 80,
			testFiles: 20,
			matchedFiles: ["src/account/profile.ts"],
			baselineComplexity: "medium",
			baselineBlastRadius: "medium",
			recommendation: "implement_incrementally",
			recommendationReason: "Baseline",
			contractSignals: [],
			options: [
				{
					id: "1",
					title: "Incremental MVP",
					summary: "Ship minimal scope",
					complexity: "medium",
					blast_radius: "medium",
					suggested_files: ["src/account/profile.ts"],
					plan: ["add endpoint"],
					pros: ["fast"],
					cons: ["partial"],
				},
				{
					id: "2",
					title: "Full implementation",
					summary: "Ship full scope",
					complexity: "high",
					blast_radius: "high",
					suggested_files: ["src/**/*"],
					plan: ["refactor"],
					pros: ["complete"],
					cons: ["risky"],
				},
				{
					id: "3",
					title: "Defer",
					summary: "Do not implement now",
					complexity: "low",
					blast_radius: "low",
					suggested_files: [],
					plan: ["prepare design"],
					pros: ["safe"],
					cons: ["delay"],
				},
			],
		};

		const enriched = {
			...baseline,
			recommendation: "implement_now",
			recommendationReason: "Agent validated low rollout risk for current sprint.",
		};

		const singularService = {
			analyze: vi.fn(async () => baseline),
			saveAnalysis: vi.fn(),
		};
		const runSingularAgentFeasibilityPass = vi.fn(async () => enriched);
		const promptSingularDecision = vi.fn(async () => {});
		const showCommandTextBlock = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.contractService = { getState: () => ({ effective: {} }) };
		fakeThis.singularService = singularService;
		fakeThis.runWithExtensionLoader = vi.fn(async (_message: string, task: () => Promise<unknown>) => task());
		fakeThis.session = { model: { provider: "openai", id: "gpt-5" } };
		fakeThis.runSingularAgentFeasibilityPass = runSingularAgentFeasibilityPass;
		fakeThis.promptSingularDecision = promptSingularDecision;
		fakeThis.formatSingularRunReport = (InteractiveMode as any).prototype.formatSingularRunReport.bind(fakeThis);
		fakeThis.showStatus = vi.fn();
		fakeThis.showWarning = vi.fn();
		fakeThis.showError = vi.fn();
		fakeThis.showCommandTextBlock = showCommandTextBlock;

		await (InteractiveMode as any).prototype.runSingularAnalysis.call(fakeThis, "add account dashboard");

		expect(singularService.analyze).toHaveBeenCalledWith({
			request: "add account dashboard",
			autosave: false,
			contract: {},
		});
		expect(runSingularAgentFeasibilityPass).toHaveBeenCalledWith(
			"add account dashboard",
			baseline,
			{},
			expect.objectContaining({
				scaleMode: "small",
				semanticStatusLine: "optional_for_small_repo",
			}),
		);
		expect(singularService.saveAnalysis).toHaveBeenCalledWith(enriched);
		expect(showCommandTextBlock).toHaveBeenCalledWith("Singular Analysis", expect.stringContaining("recommendation: implement_now"));
		expect(promptSingularDecision).toHaveBeenCalledWith(enriched);
	});

	test("runSingularAnalysis falls back to baseline when no model is selected", async () => {
		const baseline = {
			runId: "2026-03-11-090100",
			request: "add account dashboard",
			generatedAt: "2026-03-11T09:01:00.000Z",
			scannedFiles: 110,
			sourceFiles: 70,
			testFiles: 18,
			matchedFiles: [],
			baselineComplexity: "medium",
			baselineBlastRadius: "low",
			recommendation: "implement_incrementally",
			recommendationReason: "Baseline",
			contractSignals: [],
			options: [
				{
					id: "1",
					title: "Incremental MVP",
					summary: "Ship minimal scope",
					complexity: "medium",
					blast_radius: "medium",
					suggested_files: [],
					plan: ["add endpoint"],
					pros: ["fast"],
					cons: ["partial"],
				},
				{
					id: "2",
					title: "Full implementation",
					summary: "Ship full scope",
					complexity: "high",
					blast_radius: "high",
					suggested_files: [],
					plan: ["refactor"],
					pros: ["complete"],
					cons: ["risky"],
				},
				{
					id: "3",
					title: "Defer",
					summary: "Do not implement now",
					complexity: "low",
					blast_radius: "low",
					suggested_files: [],
					plan: ["prepare design"],
					pros: ["safe"],
					cons: ["delay"],
				},
			],
		};

		const singularService = {
			analyze: vi.fn(async () => baseline),
			saveAnalysis: vi.fn(),
		};
		const runSingularAgentFeasibilityPass = vi.fn();
		const showWarning = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.contractService = { getState: () => ({ effective: {} }) };
		fakeThis.singularService = singularService;
		fakeThis.runWithExtensionLoader = vi.fn(async (_message: string, task: () => Promise<unknown>) => task());
		fakeThis.session = { model: undefined };
		fakeThis.runSingularAgentFeasibilityPass = runSingularAgentFeasibilityPass;
		fakeThis.promptSingularDecision = vi.fn(async () => {});
		fakeThis.formatSingularRunReport = (InteractiveMode as any).prototype.formatSingularRunReport.bind(fakeThis);
		fakeThis.showStatus = vi.fn();
		fakeThis.showWarning = showWarning;
		fakeThis.showError = vi.fn();
		fakeThis.showCommandTextBlock = vi.fn();

		await (InteractiveMode as any).prototype.runSingularAnalysis.call(fakeThis, "add account dashboard");

		expect(runSingularAgentFeasibilityPass).not.toHaveBeenCalled();
		expect(singularService.saveAnalysis).toHaveBeenCalledWith(baseline);
		expect(showWarning).toHaveBeenCalledWith(
			expect.stringContaining("No model selected. /singular used heuristic analysis only."),
		);
	});

	test("promptSingularDecision allows swarm start when defer recommendation exists but user picks non-defer option", async () => {
		const result = {
			runId: "2026-03-11-091500",
			request: "split session handling from token validation",
			generatedAt: "2026-03-11T09:15:00.000Z",
			scannedFiles: 220,
			sourceFiles: 130,
			testFiles: 32,
			matchedFiles: ["src/auth/token.ts"],
			baselineComplexity: "medium",
			baselineBlastRadius: "medium",
			recommendation: "defer",
			recommendationReason: "Overall risk is high right now.",
			contractSignals: [],
			options: [
				{
					id: "1",
					title: "Phased extraction",
					summary: "Extract in two safe phases",
					complexity: "medium",
					blast_radius: "medium",
					suggested_files: ["src/auth/token.ts", "src/auth/session.ts"],
					plan: ["extract token module", "move session handling"],
					pros: ["safe rollout"],
					cons: ["requires sequencing"],
				},
				{
					id: "2",
					title: "Full refactor",
					summary: "Single pass refactor",
					complexity: "high",
					blast_radius: "high",
					suggested_files: ["src/auth/**"],
					plan: ["big-bang refactor"],
					pros: ["faster end state"],
					cons: ["higher risk"],
				},
				{
					id: "3",
					title: "Defer",
					summary: "Postpone",
					complexity: "low",
					blast_radius: "low",
					suggested_files: [],
					plan: ["capture RFC"],
					pros: ["no immediate risk"],
					cons: ["delay value"],
				},
			],
		};

		const showExtensionSelector = vi
			.fn<(...args: unknown[]) => Promise<string | undefined>>()
			.mockResolvedValueOnce("Option 1: Phased extraction [risk=medium]")
			.mockResolvedValueOnce("Start with Swarm (Recommended)");
		const runSwarmFromSingular = vi.fn(async () => {});
		const showStatus = vi.fn();
		const editorSetText = vi.fn();

		const fakeThis: any = Object.create((InteractiveMode as any).prototype);
		fakeThis.showExtensionSelector = showExtensionSelector;
		fakeThis.showCommandTextBlock = vi.fn();
		fakeThis.showStatus = showStatus;
		fakeThis.runSwarmFromSingular = runSwarmFromSingular;
		fakeThis.editor = { setText: editorSetText };
		fakeThis.singularLastEffectiveContract = {};
		fakeThis.buildSingularExecutionDraft = vi.fn(() => "draft");
		fakeThis.resolveRecommendedSingularOptionId = (InteractiveMode as any).prototype.resolveRecommendedSingularOptionId.bind(fakeThis);

		await (InteractiveMode as any).prototype.promptSingularDecision.call(fakeThis, result);

		expect(runSwarmFromSingular).toHaveBeenCalledWith({
			runId: "2026-03-11-091500",
			option: 1,
		});
		expect(editorSetText).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalledWith("Singular: defer option selected, implementation postponed.");
	});
});

describe("InteractiveMode.promptWithTaskFallback", () => {
	test("routes @agent capability questions without task orchestration", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "iosm-agent-mention-"));
		try {
			const agentsDir = join(tempDir, ".iosm", "agents");
			mkdirSync(agentsDir, { recursive: true });
			writeFileSync(
				join(agentsDir, "analyst.md"),
				[
					"---",
					"name: analyst",
					"description: Analyze project state",
					"profile: full",
					"---",
					"",
					"You analyze project state and explain findings.",
					"",
				].join("\n"),
			);

			const prompt = vi.fn(async () => { });
			const fakeThis: any = {
				sessionManager: { getCwd: () => tempDir },
				session: { prompt },
				activeProfileName: "full",
				resolveMentionedAgent: vi.fn(() => "analyst"),
				isCapabilityQuery: vi.fn(() => true),
			};

			await (InteractiveMode as any).prototype.promptWithTaskFallback.call(fakeThis, "@analyst ?");

			expect(prompt).toHaveBeenCalledTimes(1);
			const [generatedPrompt, options] = prompt.mock.calls[0] as [string, Record<string, unknown>];
			expect(generatedPrompt).toContain("<agent_capability_query>");
			expect(generatedPrompt).toContain("agent_name: analyst");
			expect(generatedPrompt).toContain("user_question: ?");
			expect(generatedPrompt).toContain("Do not run task tool for this query.");
			expect(generatedPrompt).not.toContain("<orchestrate");
			expect(options).toEqual({
				expandPromptTemplates: false,
				source: "interactive",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("wraps @agent work requests into orchestrate contract", async () => {
		const prompt = vi.fn(async () => { });
		const fakeThis: any = {
			sessionManager: { getCwd: () => "/tmp/workspace" },
			session: { prompt },
			activeProfileName: "full",
			resolveMentionedAgent: vi.fn(() => "analyst"),
			isCapabilityQuery: vi.fn(() => false),
		};

		await (InteractiveMode as any).prototype.promptWithTaskFallback.call(fakeThis, "@analyst проверь архитектуру");

		expect(prompt).toHaveBeenCalledTimes(1);
		const [generatedPrompt, options] = prompt.mock.calls[0] as [string, Record<string, unknown>];
		expect(generatedPrompt).toContain("<orchestrate mode=\"sequential\" agents=\"1\">");
		expect(generatedPrompt).toContain("agent=analyst");
		expect(generatedPrompt).toContain('MUST call task tool with agent="analyst"');
		expect(generatedPrompt).toContain("task: проверь архитектуру");
		expect(options).toEqual({
			expandPromptTemplates: false,
			source: "interactive",
		});
	});

	test("uses parallel orchestration defaults for @meta_orchestrator requests", async () => {
		const prompt = vi.fn(async () => { });
		const fakeThis: any = {
			sessionManager: { getCwd: () => "/tmp/workspace" },
			session: { prompt },
			activeProfileName: "full",
			resolveMentionedAgent: vi.fn(() => "meta_orchestrator"),
			isCapabilityQuery: vi.fn(() => false),
		};

		await (InteractiveMode as any).prototype.promptWithTaskFallback.call(
			fakeThis,
			"@meta_orchestrator аудит безопасности backend и auth-модуля",
		);

		expect(prompt).toHaveBeenCalledTimes(1);
		const [generatedPrompt] = prompt.mock.calls[0] as [string];
		expect(generatedPrompt).toContain('<orchestrate mode="parallel" agents="1" max_parallel="20">');
		expect(generatedPrompt).toContain('agent="meta_orchestrator"');
		expect(generatedPrompt).toContain("Include delegate_parallel_hint in the task call.");
		expect(generatedPrompt).toContain("If user explicitly requested an agent count");
		expect(generatedPrompt).toContain("Prefer existing custom agents for delegated work when suitable");
		expect(generatedPrompt).toContain("DELEGATION_IMPOSSIBLE: <reason>");
	});

	test("passes through non-@agent requests unchanged in meta profile", async () => {
		const prompt = vi.fn(async () => { });
		const fakeThis: any = {
			sessionManager: { getCwd: () => "/tmp/workspace" },
			session: { prompt },
			activeProfileName: "meta",
			resolveMentionedAgent: vi.fn(() => undefined),
		};

		await (InteractiveMode as any).prototype.promptWithTaskFallback.call(
			fakeThis,
			"добавь интересную фичу в протокол",
		);

		expect(prompt).toHaveBeenCalledTimes(1);
		const [generatedPrompt, options] = prompt.mock.calls[0] as [string, Record<string, unknown>];
		expect(generatedPrompt).toBe("добавь интересную фичу в протокол");
		expect(options).toBeUndefined();
	});

	test("passes through natural-language parallel request without rewriting user text", async () => {
		const prompt = vi.fn(async () => { });
		const fakeThis: any = {
			session: { prompt },
			resolveMentionedAgent: vi.fn(() => undefined),
		};

		await (InteractiveMode as any).prototype.promptWithTaskFallback.call(
			fakeThis,
			"используй 5 параллельных агентов для аудита безопасности",
		);

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("используй 5 параллельных агентов для аудита безопасности");
	});

	test("passes through non-@agent requests without synthetic orchestration fallback", async () => {
		const prompt = vi.fn(async () => { });
		const fakeThis: any = {
			session: { prompt },
			resolveMentionedAgent: vi.fn(() => undefined),
		};

		await (InteractiveMode as any).prototype.promptWithTaskFallback.call(
			fakeThis,
			"используй субагента для анализа кода",
		);

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt.mock.calls[0]?.[0]).toBe("используй субагента для анализа кода");
	});
});

describe("InteractiveMode.sanitizeAssistantDisplayMessage", () => {
	test("hides orchestration directive and pre-task chatter for task tool messages", () => {
		const fakeThis: any = { activeAssistantOrchestrationContext: true };
		const input: any = {
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "text", text: "Initiating Project Audit\n\n[ORCHESTRATION_DIRECTIVE]\ninternal\n\n" },
				{ type: "toolCall", id: "call_1", name: "task", arguments: { description: "Audit" } },
				{ type: "text", text: "task\n{\n  \"description\": \"Audit\"\n}\n\nDone." },
			],
		};

		const output = (InteractiveMode as any).prototype.sanitizeAssistantDisplayMessage.call(fakeThis, input);
		const textParts = output.content.filter((part: any) => part.type === "text").map((part: any) => part.text);

		expect(textParts[0]).toBe("");
		expect(textParts[1]).toBe("");
	});

	test("returns message as-is when there is no task tool call", () => {
		const fakeThis: any = {};
		const input: any = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Regular response." }],
		};

		const output = (InteractiveMode as any).prototype.sanitizeAssistantDisplayMessage.call(fakeThis, input);
		expect(output).toBe(input);
	});

	test("hides full assistant prose when orchestration context metadata is active", () => {
		const fakeThis: any = { activeAssistantOrchestrationContext: true };
		const input: any = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "Intro\n\n[ORCHESTRATION_DIRECTIVE]\ninternal\n\nDone" }],
		};

		const output = (InteractiveMode as any).prototype.sanitizeAssistantDisplayMessage.call(fakeThis, input);
		const text = output.content[0]?.type === "text" ? output.content[0].text : "";
		expect(text).toBe("");
	});

	test("hides indented orchestration blocks when orchestration context metadata is active", () => {
		const fakeThis: any = { activeAssistantOrchestrationContext: true };
		const input: any = {
			role: "assistant",
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: "Intro\n\n  [ORCHESTRATION_DIRECTIVE]\nThe user explicitly requested subagent orchestration.\nExecution mode: auto.\n\nDone",
				},
			],
		};

		const output = (InteractiveMode as any).prototype.sanitizeAssistantDisplayMessage.call(fakeThis, input);
		const text = output.content[0]?.type === "text" ? output.content[0].text : "";
		expect(text).toBe("");
	});

	test("hides malformed orchestration text when orchestration context metadata is active", () => {
		const fakeThis: any = { activeAssistantOrchestrationContext: true };
		const input: any = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "[ORCHESTRATION_DIRECTIVE]\nExecution mode: auto." }],
		};

		const output = (InteractiveMode as any).prototype.sanitizeAssistantDisplayMessage.call(fakeThis, input);
		const text = output.content[0]?.type === "text" ? output.content[0].text : "";
		expect(text).toBe("");
	});
});

describe("InteractiveMode.getUserMessageText", () => {
	test("renders synthesized internal orchestrate contracts as user-facing request", () => {
		const contractText = [
			'<orchestrate mode="sequential" agents="1">',
			"- agent 1: profile=full cwd=/tmp agent=meta_orchestrator",
			"task: improve seo",
			"constraints:",
			"- user selected a concrete custom agent via @mention",
			'- MUST call task tool with agent="meta_orchestrator"',
			"</orchestrate>",
		].join("\n");
		const fakeThis: any = {
			pendingInternalUserDisplayAliases: [
				{ rawPrompt: contractText, displayText: "@meta_orchestrator improve seo" },
			],
		};
		const input: any = {
			role: "user",
			content: [
				{
					type: "text",
					text: contractText,
				},
			],
		};

		const output = (InteractiveMode as any).prototype.getUserMessageText.call(fakeThis, input);
		expect(output).toBe("@meta_orchestrator improve seo");
	});

	test("keeps normal user messages visible", () => {
		const fakeThis: any = {};
		const input: any = {
			role: "user",
			content: [{ type: "text", text: "@meta_orchestrator improve seo" }],
		};

		const output = (InteractiveMode as any).prototype.getUserMessageText.call(fakeThis, input);
		expect(output).toBe("@meta_orchestrator improve seo");
	});

	test("keeps raw user text when no alias metadata is present", () => {
		const fakeThis: any = {};
		const input: any = {
			role: "user",
			content: [
				{
					type: "text",
					text: "please continue\n\n[ORCHESTRATION_DIRECTIVE]\ninternal details",
				},
			],
		};

		const output = (InteractiveMode as any).prototype.getUserMessageText.call(fakeThis, input);
		expect(output).toBe("please continue\n\n[ORCHESTRATION_DIRECTIVE]\ninternal details");
	});
});

describe("InteractiveMode.buildSwarmRecommendationFromOrchestrate", () => {
	test("recommends /swarm for complex or risky legacy orchestrate tasks", () => {
		const result = (InteractiveMode as any).prototype.buildSwarmRecommendationFromOrchestrate.call({}, {
			mode: "parallel",
			agents: 4,
			maxParallel: 3,
			dependencies: [{ agent: 3, dependsOn: [1, 2] }, { agent: 4, dependsOn: [3] }],
			task: "Refactor auth and migration flow with rollback safety",
		});

		expect(result.recommend).toBe(true);
		expect(result.command).toContain('/swarm run "Refactor auth and migration flow with rollback safety"');
		expect(result.command).toContain("--max-parallel 3");
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	test("does not recommend /swarm for simple orchestrate tasks", () => {
		const result = (InteractiveMode as any).prototype.buildSwarmRecommendationFromOrchestrate.call({}, {
			mode: "sequential",
			agents: 2,
			task: "Update README typo",
		});

		expect(result.recommend).toBe(false);
	});
});

describe("InteractiveMode.handleStandardInitSlashCommand", () => {
	test("updates existing AGENTS.md even without --force", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "iosm-standard-init-"));
		try {
			writeFileSync(join(cwd, "AGENTS.md"), "# AGENTS.md\n\nOld content", "utf8");
			const fakeThis: any = {
				activeProfileName: "full",
				keybindings: KeybindingsManager.create(),
				showProgressLine: vi.fn(),
				showCommandTextBlock: vi.fn(),
				createIosmVerificationEventBridge: vi.fn(() => (_event: any) => { }),
				generateStandardAgentsGuideWithAgent: vi.fn(async () => ({
					content: "# AGENTS.md\n\nUpdated content",
					toolCallsStarted: 5,
					toolCallsCompleted: 5,
					assistantMessages: 2,
					attempts: 1,
				})),
				buildStandardInitPlaybook: (InteractiveMode as any).prototype.buildStandardInitPlaybook,
			};

			await (InteractiveMode as any).prototype.handleStandardInitSlashCommand.call(fakeThis, {
				cwd,
				force: false,
				agentVerify: true,
			});

			const updated = readFileSync(join(cwd, "AGENTS.md"), "utf8");
			expect(updated).toContain("Updated content");
			expect(fakeThis.generateStandardAgentsGuideWithAgent).toHaveBeenCalledTimes(1);
			const summary = fakeThis.showCommandTextBlock.mock.calls[0]?.[1] as string;
			expect(summary).toContain("AGENTS.md: updated");
			expect(summary).toContain("tool calls");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("InteractiveMode.requestToolPermission", () => {
	test("denies execution when a deny rule matches", async () => {
		const fakeThis: any = {
			permissionDenyRules: ["bash:rm -rf"],
			permissionAllowRules: [],
			permissionMode: "ask",
			sessionAllowedToolSignatures: new Set<string>(),
			shadowGuard: { shouldDenyTool: () => false },
			matchesPermissionRule: (InteractiveMode as any).prototype.matchesPermissionRule,
			getToolPermissionSignature: (InteractiveMode as any).prototype.getToolPermissionSignature,
			withPermissionDialogLock: async (fn: () => Promise<boolean>) => fn(),
			showWarning: vi.fn(),
			showExtensionSelector: vi.fn(),
		};

		const allowed = await (InteractiveMode as any).prototype.requestToolPermission.call(fakeThis, {
			toolName: "bash",
			cwd: "/tmp/project",
			input: { command: "rm -rf /tmp/project" },
			summary: "run rm -rf /tmp/project",
		});

		expect(allowed).toBe(false);
		expect(fakeThis.showWarning).toHaveBeenCalledWith("Denied by rule: bash:rm -rf");
		expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
	});

	test("auto mode allows edit/write without prompting", async () => {
		const fakeThis: any = {
			permissionDenyRules: [],
			permissionAllowRules: [],
			permissionMode: "auto",
			sessionAllowedToolSignatures: new Set<string>(),
			shadowGuard: { shouldDenyTool: () => false },
			matchesPermissionRule: (InteractiveMode as any).prototype.matchesPermissionRule,
			getToolPermissionSignature: (InteractiveMode as any).prototype.getToolPermissionSignature,
			withPermissionDialogLock: async (fn: () => Promise<boolean>) => fn(),
			showWarning: vi.fn(),
			showExtensionSelector: vi.fn(),
		};

		const allowed = await (InteractiveMode as any).prototype.requestToolPermission.call(fakeThis, {
			toolName: "write",
			cwd: "/tmp/project",
			input: { path: "README.md" },
			summary: "write README.md",
		});

		expect(allowed).toBe(true);
		expect(fakeThis.showExtensionSelector).not.toHaveBeenCalled();
	});

	test("ask mode can remember command approval for current session", async () => {
		const showExtensionSelector = vi.fn(async () => "Always allow this command (session)");
		const fakeThis: any = {
			permissionDenyRules: [],
			permissionAllowRules: [],
			permissionMode: "ask",
			sessionAllowedToolSignatures: new Set<string>(),
			shadowGuard: { shouldDenyTool: () => false },
			matchesPermissionRule: (InteractiveMode as any).prototype.matchesPermissionRule,
			getToolPermissionSignature: (InteractiveMode as any).prototype.getToolPermissionSignature,
			withPermissionDialogLock: async (fn: () => Promise<boolean>) => fn(),
			showWarning: vi.fn(),
			showExtensionSelector,
		};

		const request = {
			toolName: "bash",
			cwd: "/tmp/project",
			input: { command: "npm test" },
			summary: "run npm test",
		};

		const first = await (InteractiveMode as any).prototype.requestToolPermission.call(fakeThis, request);
		const second = await (InteractiveMode as any).prototype.requestToolPermission.call(fakeThis, request);

		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(showExtensionSelector).toHaveBeenCalledTimes(1);
	});
});

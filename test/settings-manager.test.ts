import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".iosm"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".iosm", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .iosm folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .iosm folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .iosm folder that beforeEach created
			rmSync(join(projectDir, ".iosm"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .iosm folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".iosm"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .iosm folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .iosm folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .iosm folder that beforeEach created
			rmSync(join(projectDir, ".iosm"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .iosm folder should NOT exist yet
			expect(existsSync(join(projectDir, ".iosm"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .iosm folder should exist
			expect(existsSync(join(projectDir, ".iosm"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".iosm", "settings.json"))).toBe(true);
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("webSearch settings", () => {
		it("uses defaults when webSearch block is not set", () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getWebSearchEnabled()).toBe(true);
			expect(manager.getWebSearchProviderMode()).toBe("auto");
			expect(manager.getWebSearchFallbackMode()).toBe("searxng_ddg");
			expect(manager.getWebSearchSafeSearch()).toBe("moderate");
			expect(manager.getWebSearchMaxResults()).toBe(8);
			expect(manager.getWebSearchTimeoutSeconds()).toBe(20);
			expect(manager.getWebSearchTavilyApiKey()).toBeUndefined();
			expect(manager.isWebSearchTavilyApiKeyConfigured()).toBe(false);
			expect(manager.getWebSearchSearxngUrl()).toBeUndefined();
			expect(manager.isWebSearchSearxngUrlConfigured()).toBe(false);
		});

		it("persists webSearch settings and keeps unrelated external edits", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					webSearch: {
						enabled: true,
						maxResults: 8,
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.extensions = ["/tmp/ext.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setWebSearchProviderMode("tavily");
			manager.setWebSearchFallbackMode("searxng_only");
			manager.setWebSearchSafeSearch("strict");
			manager.setWebSearchMaxResults(15);
			manager.setWebSearchTimeoutSeconds(45);
			manager.setWebSearchTavilyApiKey("tvly-test");
			manager.setWebSearchSearxngUrl("https://searx.example");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.extensions).toEqual(["/tmp/ext.ts"]);
			expect(savedSettings.webSearch.providerMode).toBe("tavily");
			expect(savedSettings.webSearch.fallbackMode).toBe("searxng_only");
			expect(savedSettings.webSearch.safeSearch).toBe("strict");
			expect(savedSettings.webSearch.maxResults).toBe(15);
			expect(savedSettings.webSearch.timeoutSeconds).toBe(45);
			expect(savedSettings.webSearch.tavilyApiKey).toBe("tvly-test");
			expect(savedSettings.webSearch.searxngUrl).toBe("https://searx.example");
		});

		it("supports clearing Tavily key and SearXNG URL", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					webSearch: {
						tavilyApiKey: "tvly-test",
						searxngUrl: "https://searx.example",
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.isWebSearchTavilyApiKeyConfigured()).toBe(true);
			expect(manager.isWebSearchSearxngUrlConfigured()).toBe(true);

			manager.setWebSearchTavilyApiKey(undefined);
			manager.setWebSearchSearxngUrl(undefined);
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.webSearch.tavilyApiKey).toBeUndefined();
			expect(savedSettings.webSearch.searxngUrl).toBeUndefined();
			expect(manager.isWebSearchTavilyApiKeyConfigured()).toBe(false);
			expect(manager.isWebSearchSearxngUrlConfigured()).toBe(false);
		});
	});

	describe("githubTools settings", () => {
		it("uses defaults when githubTools block is not set", () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getGithubToolsNetworkEnabled()).toBe(false);
			expect(manager.getGithubToolsToken()).toBeUndefined();
			expect(manager.isGithubToolsTokenConfigured()).toBe(false);
		});

		it("persists githubTools settings and preserves unrelated edits", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					githubTools: {
						networkEnabled: false,
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.extensions = ["/tmp/ext.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setGithubToolsNetworkEnabled(true);
			manager.setGithubToolsToken("ghp_test_123");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.extensions).toEqual(["/tmp/ext.ts"]);
			expect(savedSettings.githubTools.networkEnabled).toBe(true);
			expect(savedSettings.githubTools.token).toBe("ghp_test_123");
		});

		it("supports clearing github token", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					githubTools: {
						token: "ghp_test_123",
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.isGithubToolsTokenConfigured()).toBe(true);

			manager.setGithubToolsToken(undefined);
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.githubTools.token).toBeUndefined();
			expect(manager.isGithubToolsTokenConfigured()).toBe(false);
		});
	});
});

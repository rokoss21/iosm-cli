import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { SettingsSelectorComponent, type SettingsCallbacks, type SettingsConfig } from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createConfig(): SettingsConfig {
	return {
		autoCompact: true,
		showImages: true,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		streamInputMode: "meta",
		transport: "auto",
		thinkingLevel: "medium",
		availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
		currentTheme: "dark",
		availableThemes: ["dark", "light"],
		hideThinkingBlock: false,
		collapseChangelog: true,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 1,
		autocompleteMaxVisible: 10,
		quietStartup: false,
		clearOnShrink: false,
		webSearchEnabled: true,
		webSearchProviderMode: "auto",
		webSearchFallbackMode: "searxng_ddg",
		webSearchSafeSearch: "moderate",
		webSearchMaxResults: 8,
		webSearchTimeoutSeconds: 20,
		webSearchTavilyApiKeyConfigured: false,
		webSearchSearxngUrlConfigured: false,
		githubToolsNetworkEnabled: false,
		githubToolsTokenConfigured: false,
	};
}

function createCallbacks(): SettingsCallbacks {
	const noop = () => {};
	return {
		onAutoCompactChange: noop,
		onShowImagesChange: noop,
		onAutoResizeImagesChange: noop,
		onBlockImagesChange: noop,
		onEnableSkillCommandsChange: noop,
		onSteeringModeChange: noop,
		onFollowUpModeChange: noop,
		onStreamInputModeChange: noop,
		onTransportChange: noop,
		onThinkingLevelChange: noop,
		onThemeChange: noop,
		onThemePreview: noop,
		onHideThinkingBlockChange: noop,
		onCollapseChangelogChange: noop,
		onDoubleEscapeActionChange: noop,
		onTreeFilterModeChange: noop,
		onShowHardwareCursorChange: noop,
		onEditorPaddingXChange: noop,
		onAutocompleteMaxVisibleChange: noop,
		onQuietStartupChange: noop,
		onClearOnShrinkChange: noop,
		onWebSearchEnabledChange: noop,
		onWebSearchProviderModeChange: noop,
		onWebSearchFallbackModeChange: noop,
		onWebSearchSafeSearchChange: noop,
		onWebSearchMaxResultsChange: noop,
		onWebSearchTimeoutSecondsChange: noop,
		onWebSearchTavilyApiKeyAction: async () => "not configured",
		onWebSearchSearxngUrlAction: async () => "not configured",
		onGithubToolsNetworkEnabledChange: noop,
		onGithubToolsTokenAction: async () => "not configured",
		onCancel: noop,
	};
}

describe("SettingsSelectorComponent UI", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows title and quick usage summary", () => {
		const component = new SettingsSelectorComponent(createConfig(), createCallbacks());
		const output = stripAnsi(component.render(120).join("\n"));

		expect(output).toContain("Settings");
		expect(output).toMatch(/\d+ options/);
		expect(output).toContain("search enabled");
		expect(output).toContain("Enter to edit");
		expect(output).toContain("Esc to close");

		for (const char of "websearch") {
			component.getSettingsList().handleInput(char);
		}
		const filtered = stripAnsi(component.render(120).join("\n"));
		expect(filtered).toContain("Web Search Tool");

		const githubComponent = new SettingsSelectorComponent(createConfig(), createCallbacks());
		for (const char of "github") {
			githubComponent.getSettingsList().handleInput(char);
		}
		const githubFiltered = stripAnsi(githubComponent.render(120).join("\n"));
		expect(githubFiltered).toContain("Github tools");
	});
});

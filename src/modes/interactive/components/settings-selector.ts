import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Transport } from "@mariozechner/pi-ai";
import {
	Container,
	getCapabilities,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
};

type WebSearchCredentialAction = "set" | "clear";
type WebSearchCredentialState = "configured" | "not configured";
type GithubCredentialAction = "set" | "clear";
type GithubCredentialState = "configured" | "not configured";

function formatWebSearchCredentialState(configured: boolean): WebSearchCredentialState {
	return configured ? "configured" : "not configured";
}

function formatGithubCredentialState(configured: boolean): GithubCredentialState {
	return configured ? "configured" : "not configured";
}

export interface SettingsConfig {
	autoCompact: boolean;
	showImages: boolean;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	streamInputMode: "steer" | "followUp" | "meta";
	transport: Transport;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	collapseChangelog: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	clearOnShrink: boolean;
	webSearchEnabled: boolean;
	webSearchProviderMode: "auto" | "tavily";
	webSearchFallbackMode: "searxng_ddg" | "searxng_only" | "none";
	webSearchSafeSearch: "off" | "moderate" | "strict";
	webSearchMaxResults: 3 | 5 | 8 | 10 | 15;
	webSearchTimeoutSeconds: 10 | 20 | 30 | 45 | 60;
	webSearchTavilyApiKeyConfigured: boolean;
	webSearchSearxngUrlConfigured: boolean;
	githubToolsNetworkEnabled: boolean;
	githubToolsTokenConfigured: boolean;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onStreamInputModeChange: (mode: "steer" | "followUp" | "meta") => void;
	onTransportChange: (transport: Transport) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onWebSearchEnabledChange: (enabled: boolean) => void;
	onWebSearchProviderModeChange: (mode: "auto" | "tavily") => void;
	onWebSearchFallbackModeChange: (mode: "searxng_ddg" | "searxng_only" | "none") => void;
	onWebSearchSafeSearchChange: (mode: "off" | "moderate" | "strict") => void;
	onWebSearchMaxResultsChange: (maxResults: 3 | 5 | 8 | 10 | 15) => void;
	onWebSearchTimeoutSecondsChange: (timeoutSeconds: 10 | 20 | 30 | 45 | 60) => void;
	onWebSearchTavilyApiKeyAction: (
		action: WebSearchCredentialAction,
	) => WebSearchCredentialState | Promise<WebSearchCredentialState>;
	onWebSearchSearxngUrlAction: (
		action: WebSearchCredentialAction,
	) => WebSearchCredentialState | Promise<WebSearchCredentialState>;
	onGithubToolsNetworkEnabledChange: (enabled: boolean) => void;
	onGithubToolsTokenAction: (
		action: GithubCredentialAction,
	) => GithubCredentialState | Promise<GithubCredentialState>;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(options, Math.min(options.length, 10), getSelectListTheme());

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to apply action · Esc to close menu"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

class WebSearchToolSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks, onCancel: () => void) {
		super();

		const items: SettingItem[] = [
			{
				id: "web-search-enabled",
				label: "Enabled",
				description: "Enable/disable internet discovery via the web_search tool",
				currentValue: config.webSearchEnabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "web-search-provider-mode",
				label: "Provider mode",
				description: "Provider mode for web_search tool",
				currentValue: config.webSearchProviderMode,
				values: ["auto", "tavily"],
			},
			{
				id: "web-search-fallback-mode",
				label: "Fallback mode",
				description: "Fallback policy after Tavily",
				currentValue: config.webSearchFallbackMode,
				values: ["searxng_ddg", "searxng_only", "none"],
			},
			{
				id: "web-search-safe-search",
				label: "Safe search",
				description: "Safe-search policy for providers that support it",
				currentValue: config.webSearchSafeSearch,
				values: ["off", "moderate", "strict"],
			},
			{
				id: "web-search-max-results",
				label: "Max results",
				description: "Default max results for web_search",
				currentValue: String(config.webSearchMaxResults),
				values: ["3", "5", "8", "10", "15"],
			},
			{
				id: "web-search-timeout",
				label: "Timeout (sec)",
				description: "Request timeout for web_search provider chain",
				currentValue: String(config.webSearchTimeoutSeconds),
				values: ["10", "20", "30", "45", "60"],
			},
			{
				id: "web-search-tavily-key",
				label: "Tavily API key",
				description: "Configure Tavily API key stored in settings (plain text on disk).",
				currentValue: formatWebSearchCredentialState(config.webSearchTavilyApiKeyConfigured),
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Web Search Tool · Tavily API key",
						"Set or clear the Tavily API key used by web_search.",
						[
							{ value: "set", label: "Set / replace", description: "Enter Tavily API key" },
							{ value: "clear", label: "Clear", description: "Remove key from settings" },
						],
						"set",
						(value) => {
							const action = value as WebSearchCredentialAction;
							void Promise.resolve(callbacks.onWebSearchTavilyApiKeyAction(action))
								.then((nextState) => done(nextState))
								.catch(() => done(currentValue));
						},
						() => done(),
					),
			},
			{
				id: "web-search-searxng-url",
				label: "SearXNG base URL",
				description: "Configure fallback SearXNG endpoint in settings.",
				currentValue: formatWebSearchCredentialState(config.webSearchSearxngUrlConfigured),
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Web Search Tool · SearXNG base URL",
						"Set or clear a custom SearXNG base URL for fallback.",
						[
							{ value: "set", label: "Set / replace", description: "Enter SearXNG base URL" },
							{ value: "clear", label: "Clear", description: "Remove URL from settings" },
						],
						"set",
						(value) => {
							const action = value as WebSearchCredentialAction;
							void Promise.resolve(callbacks.onWebSearchSearxngUrlAction(action))
								.then((nextState) => done(nextState))
								.catch(() => done(currentValue));
						},
						() => done(),
					),
			},
		];

		this.addChild(new Text(theme.bold(theme.fg("accent", "Web Search Tool")), 0, 0));
		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "web-search-enabled":
						callbacks.onWebSearchEnabledChange(newValue === "true");
						break;
					case "web-search-provider-mode":
						callbacks.onWebSearchProviderModeChange(newValue as "auto" | "tavily");
						break;
					case "web-search-fallback-mode":
						callbacks.onWebSearchFallbackModeChange(newValue as "searxng_ddg" | "searxng_only" | "none");
						break;
					case "web-search-safe-search":
						callbacks.onWebSearchSafeSearchChange(newValue as "off" | "moderate" | "strict");
						break;
					case "web-search-max-results":
						callbacks.onWebSearchMaxResultsChange(parseInt(newValue, 10) as 3 | 5 | 8 | 10 | 15);
						break;
					case "web-search-timeout":
						callbacks.onWebSearchTimeoutSecondsChange(parseInt(newValue, 10) as 10 | 20 | 30 | 45 | 60);
						break;
				}
			},
			onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit setting · / to search · Esc to settings"), 0, 0));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class GithubToolsSubmenu extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks, onCancel: () => void) {
		super();

		const items: SettingItem[] = [
			{
				id: "github-tools-network-enabled",
				label: "Enable network actions",
				description: "Allow git_write network actions (fetch/pull/push)",
				currentValue: config.githubToolsNetworkEnabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "github-tools-token",
				label: "GitHub token",
				description: "Configure GitHub token used for git network operations (plain text on disk).",
				currentValue: formatGithubCredentialState(config.githubToolsTokenConfigured),
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Github tools · Token",
						"Set or clear GitHub token used by git_write network actions.",
						[
							{ value: "set", label: "Set / replace", description: "Enter GitHub token" },
							{ value: "clear", label: "Clear", description: "Remove token from settings" },
						],
						"set",
						(value) => {
							const action = value as GithubCredentialAction;
							void Promise.resolve(callbacks.onGithubToolsTokenAction(action))
								.then((nextState) => done(nextState))
								.catch(() => done(currentValue));
						},
						() => done(),
					),
			},
		];

		this.addChild(new Text(theme.bold(theme.fg("accent", "Github tools")), 0, 0));
		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				if (id === "github-tools-network-enabled") {
					callbacks.onGithubToolsNetworkEnabledChange(newValue === "true");
				}
			},
			onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit setting · / to search · Esc to settings"), 0, 0));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description:
					"Alt+Enter queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "stream-input-mode",
				label: "Stream input mode",
				description:
					"Default Enter behavior while streaming: steer (interrupt), followUp (wait), meta (seamless pivot at next tool boundary).",
				currentValue: config.streamInputMode,
				values: ["meta", "followUp", "steer"],
			},
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "auto"],
			},
			{
				id: "web-search-tool",
				label: "Web Search Tool",
				description: "Open provider, safety, limits, and credentials configuration for web_search.",
				currentValue: config.webSearchEnabled ? "enabled" : "disabled",
				submenu: (_currentValue, done) => new WebSearchToolSubmenu(config, callbacks, () => done()),
			},
			{
				id: "github-tools",
				label: "Github tools",
				description: "Open git network permissions and token configuration for git_write.",
				currentValue: config.githubToolsNetworkEnabled ? "network on" : "network off",
				submenu: (_currentValue, done) => new GithubToolsSubmenu(config, callbacks, () => done()),
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "thinking",
				label: "Thinking level",
				description: "Reasoning depth for thinking-capable models",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking Level",
						"Select reasoning depth for thinking-capable models",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Theme",
						"Select color theme",
						config.availableThemes.map((t) => ({
							value: t,
							label: t,
						})),
						currentValue,
						(value) => {
							callbacks.onThemeChange(value);
							done(value);
						},
						() => {
							// Restore original theme on cancel
							callbacks.onThemePreview?.(currentValue);
							done();
						},
						(value) => {
							// Preview theme on selection change
							callbacks.onThemePreview?.(value);
						},
					),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 2 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Autocomplete max visible toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Add borders
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Settings")), 0, 0));
		this.addChild(new Text(theme.fg("muted", `${items.length} options • search enabled • Enter to edit • Esc to close`), 0, 0));
		this.addChild(new Spacer(1));

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "stream-input-mode":
						callbacks.onStreamInputModeChange(newValue as "steer" | "followUp" | "meta");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		const sep = theme.fg("muted", " · ");
		const usageLine =
			rawKeyHint("↑/↓", "navigate") +
			sep +
			keyHint("selectConfirm", "edit") +
			sep +
			rawKeyHint("/", "search") +
			sep +
			keyHint("selectCancel", "close");
		this.addChild(new Text(usageLine, 0, 0));
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}

import {
	DEFAULT_EDITOR_KEYBINDINGS,
	type EditorAction,
	type EditorKeybindingsConfig,
	EditorKeybindingsManager,
	type KeyId,
	matchesKey,
	setEditorKeybindings,
} from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.js";

/**
 * Application-level actions (coding agent specific).
 */
export type AppAction =
	| "interrupt"
	| "clear"
	| "exit"
	| "suspend"
	| "cycleProfile"
	| "cycleThinkingLevel"
	| "cycleModelForward"
	| "cycleModelBackward"
	| "selectModel"
	| "expandTools"
	| "toggleThinking"
	| "toggleSessionNamedFilter"
	| "externalEditor"
	| "steer"
	| "followUp"
	| "dequeue"
	| "pasteImage"
	| "newSession"
	| "tree"
	| "fork"
	| "resume";

/**
 * All configurable actions.
 */
export type KeyAction = AppAction | EditorAction;

/**
 * Full keybindings configuration (app + editor actions).
 */
export type KeybindingsConfig = {
	[K in KeyAction]?: KeyId | KeyId[];
};

/**
 * Default application keybindings.
 */
export const DEFAULT_APP_KEYBINDINGS: Record<AppAction, KeyId | KeyId[]> = {
	interrupt: "escape",
	clear: "ctrl+c",
	exit: "ctrl+d",
	suspend: process.platform === "win32" ? [] : (["ctrl+z", "alt+z"] as KeyId[]),
	cycleProfile: "shift+tab",
	cycleThinkingLevel: "shift+ctrl+t",
	cycleModelForward: ["ctrl+p", "alt+p"] as KeyId[],
	cycleModelBackward: ["shift+ctrl+p", "alt+shift+p"] as KeyId[],
	selectModel: ["ctrl+l", "alt+l"] as KeyId[],
	expandTools: ["ctrl+o", "alt+o"] as KeyId[],
	toggleThinking: ["ctrl+t", "alt+t"] as KeyId[],
	toggleSessionNamedFilter: "ctrl+n",
	externalEditor: "ctrl+g",
	// ctrl+enter depends on terminal extended key reporting.
	// On macOS terminals without it, ctrl+\ is a reliable fallback.
	steer: process.platform === "darwin" ? (["ctrl+enter", "ctrl+\\"] as KeyId[]) : "ctrl+enter",
	followUp: "alt+enter",
	dequeue: "alt+up",
	pasteImage: process.platform === "win32" ? "alt+v" : "ctrl+v",
	newSession: [],
	tree: [],
	fork: [],
	resume: [],
};

const ACTION_ALIASES: Record<string, KeyAction> = {
	nextmodel: "cycleModelForward",
	previousmodel: "cycleModelBackward",
	openmodelselector: "selectModel",
	toggletooloutput: "expandTools",
	toggletools: "expandTools",
	togglethinkingpanel: "toggleThinking",
	stop: "interrupt",
	cancel: "interrupt",
};

/**
 * All default keybindings (app + editor).
 */
export const DEFAULT_KEYBINDINGS: Required<KeybindingsConfig> = {
	...DEFAULT_EDITOR_KEYBINDINGS,
	...DEFAULT_APP_KEYBINDINGS,
};

// App actions list for type checking
const APP_ACTIONS: AppAction[] = [
	"interrupt",
	"clear",
	"exit",
	"suspend",
	"cycleProfile",
	"cycleThinkingLevel",
	"cycleModelForward",
	"cycleModelBackward",
	"selectModel",
	"expandTools",
	"toggleThinking",
	"toggleSessionNamedFilter",
	"externalEditor",
	"steer",
	"followUp",
	"dequeue",
	"pasteImage",
	"newSession",
	"tree",
	"fork",
	"resume",
];

function isAppAction(action: string): action is AppAction {
	return APP_ACTIONS.includes(action as AppAction);
}

function normalizeActionToken(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeKeyId(value: string): KeyId | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed
		.toLowerCase()
		.replace(/\s+/g, "")
		.replace(/^control\+/, "ctrl+")
		.replace(/\+control\+/g, "+ctrl+")
		.replace(/^option\+/, "alt+")
		.replace(/\+option\+/g, "+alt+")
		.replace(/^return$/, "enter");
	return normalized.length > 0 ? (normalized as KeyId) : undefined;
}

function normalizeKeyValue(value: unknown): KeyId | KeyId[] | undefined {
	if (typeof value === "string") {
		return normalizeKeyId(value);
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const normalized = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => normalizeKeyId(entry))
		.filter((entry): entry is KeyId => !!entry);
	return Array.from(new Set(normalized));
}

function appendKeyValue(
	current: KeyId | KeyId[] | undefined,
	next: KeyId | KeyId[] | undefined,
): KeyId | KeyId[] | undefined {
	if (next === undefined) return current;
	if (current === undefined) return next;
	const currentList = Array.isArray(current) ? current : [current];
	const nextList = Array.isArray(next) ? next : [next];
	return Array.from(new Set([...currentList, ...nextList]));
}

function resolveActionName(candidate: string): KeyAction | undefined {
	const normalized = normalizeActionToken(candidate);
	if (!normalized) return undefined;

	const alias = ACTION_ALIASES[normalized];
	if (alias) return alias;

	const defaultActions = Object.keys(DEFAULT_KEYBINDINGS) as KeyAction[];
	for (const action of defaultActions) {
		if (normalizeActionToken(action) === normalized) {
			return action;
		}
	}
	return undefined;
}

/**
 * Manages all keybindings (app + editor).
 */
export class KeybindingsManager {
	private config: KeybindingsConfig;
	private appActionToKeys: Map<AppAction, KeyId[]>;

	private constructor(config: KeybindingsConfig) {
		this.config = config;
		this.appActionToKeys = new Map();
		this.buildMaps();
	}

	/**
	 * Create from config file and set up editor keybindings.
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const config = KeybindingsManager.loadFromFile(configPath);
		const manager = new KeybindingsManager(config);

		// Set up editor keybindings globally
		// Include both editor actions and expandTools (shared between app and editor)
		const editorConfig: EditorKeybindingsConfig = {};
		for (const [action, keys] of Object.entries(config)) {
			if (!isAppAction(action) || action === "expandTools") {
				editorConfig[action as EditorAction] = keys;
			}
		}
		setEditorKeybindings(new EditorKeybindingsManager(editorConfig));

		return manager;
	}

	/**
	 * Create in-memory.
	 */
	static inMemory(config: KeybindingsConfig = {}): KeybindingsManager {
		return new KeybindingsManager(config);
	}

	private static loadFromFile(path: string): KeybindingsConfig {
		if (!existsSync(path)) return {};
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return {};
			}
			const result: KeybindingsConfig = {};
			for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
				const directAction = resolveActionName(rawKey);
				if (directAction) {
					result[directAction] = appendKeyValue(result[directAction], normalizeKeyValue(rawValue));
					continue;
				}

				// Backward-compatible support for legacy "key -> action" format
				// from older docs/examples.
				if (typeof rawValue === "string") {
					const reversedAction = resolveActionName(rawValue);
					if (reversedAction) {
						result[reversedAction] = appendKeyValue(result[reversedAction], normalizeKeyValue(rawKey));
					}
				}
			}
			return result;
		} catch {
			return {};
		}
	}

	private buildMaps(): void {
		this.appActionToKeys.clear();

		// Set defaults for app actions
		for (const [action, keys] of Object.entries(DEFAULT_APP_KEYBINDINGS)) {
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action as AppAction, [...keyArray]);
		}

		// Override with user config (app actions only)
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys === undefined || !isAppAction(action)) continue;
			const keyArray = Array.isArray(keys) ? keys : [keys];
			this.appActionToKeys.set(action, keyArray);
		}
	}

	/**
	 * Check if input matches an app action.
	 */
	matches(data: string, action: AppAction): boolean {
		const keys = this.appActionToKeys.get(action);
		if (!keys) return false;
		for (const key of keys) {
			if (matchesKey(data, key)) return true;
		}
		return false;
	}

	/**
	 * Get keys bound to an app action.
	 */
	getKeys(action: AppAction): KeyId[] {
		return this.appActionToKeys.get(action) ?? [];
	}

	/**
	 * Get the full effective config.
	 */
	getEffectiveConfig(): Required<KeybindingsConfig> {
		const result = { ...DEFAULT_KEYBINDINGS };
		for (const [action, keys] of Object.entries(this.config)) {
			if (keys !== undefined) {
				(result as KeybindingsConfig)[action as KeyAction] = keys;
			}
		}
		return result;
	}
}

// Re-export for convenience
export type { EditorAction, KeyId };

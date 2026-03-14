import { readOnlyTools } from "./tools/index.js";

const SHADOW_MUTATING_TOOLS = new Set(["edit", "write", "bash", "fs_ops", "task"]);
const SHADOW_SAFE_ADDITIONAL_TOOLS = new Set(["todo_read", "ask_user"]);

export interface ShadowGuardOptions {
	getActiveTools: () => string[];
	getAllTools: () => string[];
	setActiveTools: (toolNames: string[]) => void;
}

export interface ShadowGuardState {
	enabled: boolean;
	strict: boolean;
	blockedTools: string[];
}

function uniqueTools(names: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const name of names) {
		if (!name || seen.has(name)) continue;
		seen.add(name);
		result.push(name);
	}
	return result;
}

export class ShadowGuard {
	private readonly getActiveTools: () => string[];
	private readonly getAllTools: () => string[];
	private readonly setActiveTools: (toolNames: string[]) => void;
	private enabled = false;
	private strict = true;
	private restoreToolNames: string[] = [];

	constructor(options: ShadowGuardOptions) {
		this.getActiveTools = options.getActiveTools;
		this.getAllTools = options.getAllTools;
		this.setActiveTools = options.setActiveTools;
	}

	getState(): ShadowGuardState {
		return {
			enabled: this.enabled,
			strict: this.strict,
			blockedTools: [...SHADOW_MUTATING_TOOLS],
		};
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	getRestoreToolNames(): string[] {
		return [...this.restoreToolNames];
	}

	setRestoreToolNames(toolNames: string[]): void {
		this.restoreToolNames = uniqueTools(toolNames);
	}

	enable(): ShadowGuardState {
		if (!this.enabled) {
			this.restoreToolNames = uniqueTools(this.getActiveTools());
			this.enabled = true;
		}
		this.applyReadOnlyTools();
		return this.getState();
	}

	disable(): ShadowGuardState {
		if (!this.enabled) {
			return this.getState();
		}

		const restore = uniqueTools(this.restoreToolNames);
		if (restore.length > 0) {
			this.setActiveTools(restore);
		}
		this.enabled = false;
		return this.getState();
	}

	reset(): void {
		this.enabled = false;
		this.restoreToolNames = [];
	}

	enforceReadOnlyToolsIfEnabled(): void {
		if (!this.enabled) return;
		this.applyReadOnlyTools();
	}

	shouldDenyTool(toolName: string): boolean {
		return this.enabled && this.strict && SHADOW_MUTATING_TOOLS.has(toolName);
	}

	private applyReadOnlyTools(): void {
		const availableTools = new Set(this.getAllTools());
		const whitelist = new Set<string>([
			...readOnlyTools.map((tool) => tool.name),
			...SHADOW_SAFE_ADDITIONAL_TOOLS,
		]);
		const nextActive = [...availableTools].filter((toolName) => whitelist.has(toolName));
		this.setActiveTools(uniqueTools(nextActive));
	}
}

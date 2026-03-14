import {
	Container,
	type Focusable,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import type { McpServerStatus } from "../../../core/mcp/types.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { rawKeyHint } from "./keybinding-hints.js";

export interface McpSelectorCallbacks {
	onClose: () => void;
	onToggleEnabled: (server: McpServerStatus) => void | Promise<void>;
	onReconnect: (server: McpServerStatus) => void | Promise<void>;
	onRemove: (server: McpServerStatus) => void | Promise<void>;
	onRefresh: () => void | Promise<void>;
	onInsertAddCommand: () => void;
}

export class McpSelectorComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly callbacks: McpSelectorCallbacks;
	private readonly searchInput: Input;
	private readonly listContainer: Container;
	private readonly detailsContainer: Container;
	private allServers: McpServerStatus[] = [];
	private filteredServers: McpServerStatus[] = [];
	private selectedIndex = 0;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(tui: TUI, servers: McpServerStatus[], callbacks: McpSelectorCallbacks) {
		super();
		this.tui = tui;
		this.callbacks = callbacks;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "MCP Servers")), 0, 0));
		const sep = theme.fg("muted", " · ");
		this.addChild(
			new Text(
				`${rawKeyHint("↑/↓", "navigate")}${sep}${rawKeyHint("enter/space", "toggle")}${sep}${rawKeyHint("type", "search")}${sep}${rawKeyHint("esc", "close")}`,
				0,
			),
		);
		this.addChild(
			new Text(
				`${rawKeyHint("r", "reconnect")}${sep}${rawKeyHint("d", "remove")}${sep}${rawKeyHint("a", "add command")}`,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));

		this.detailsContainer = new Container();
		this.addChild(this.detailsContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.setServers(servers);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	setServers(servers: McpServerStatus[]): void {
		this.allServers = [...servers].sort((a, b) => a.name.localeCompare(b.name));
		this.applyFilter(this.searchInput.getValue());
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();
		if (kb.matches(keyData, "selectCancel")) {
			this.callbacks.onClose();
			return;
		}
		if (keyData === "r" || keyData === "R") {
			const selected = this.filteredServers[this.selectedIndex];
			if (selected) {
				void this.callbacks.onReconnect(selected);
			} else {
				void this.callbacks.onRefresh();
			}
			return;
		}
		if (keyData === "d" || keyData === "D") {
			const selected = this.filteredServers[this.selectedIndex];
			if (selected) {
				void this.callbacks.onRemove(selected);
			}
			return;
		}
		if (keyData === "a" || keyData === "A") {
			this.callbacks.onInsertAddCommand();
			return;
		}
		if (kb.matches(keyData, "selectUp")) {
			if (this.filteredServers.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredServers.length - 1 : this.selectedIndex - 1;
			this.updateView();
			return;
		}
		if (kb.matches(keyData, "selectDown")) {
			if (this.filteredServers.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === this.filteredServers.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateView();
			return;
		}
		if (keyData === " " || kb.matches(keyData, "selectConfirm")) {
			const selected = this.filteredServers[this.selectedIndex];
			if (selected) {
				void this.callbacks.onToggleEnabled(selected);
			}
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	private applyFilter(query: string): void {
		this.filteredServers = query
			? fuzzyFilter(this.allServers, query, (server) => `${server.name} ${server.scope} ${server.transport}`)
			: [...this.allServers];
		if (this.filteredServers.length === 0) {
			this.selectedIndex = 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, this.filteredServers.length - 1);
		}
		this.updateView();
	}

	private updateView(): void {
		this.listContainer.clear();
		this.detailsContainer.clear();

		if (this.filteredServers.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No MCP servers found."), 0, 0));
			this.tui.requestRender();
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredServers.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredServers.length);

		for (let index = startIndex; index < endIndex; index++) {
			const server = this.filteredServers[index];
			const selected = index === this.selectedIndex;
			const marker = selected ? theme.fg("accent", "→") : " ";
			const state = this.formatState(server);
			const enabled = server.enabled ? theme.fg("success", "on") : theme.fg("dim", "off");
			const text = `${marker} ${server.name} ${state} ${theme.fg("muted", `[${server.scope}/${server.transport}]`)} ${enabled} ${theme.fg("muted", `tools:${server.toolCount}`)}`;
			this.listContainer.addChild(new Text(text, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredServers.length) {
			this.listContainer.addChild(
				new Text(theme.fg("dim", `(${this.selectedIndex + 1}/${this.filteredServers.length})`), 0, 0),
			);
		}

		const selected = this.filteredServers[this.selectedIndex];
		if (!selected) {
			this.tui.requestRender();
			return;
		}

		this.detailsContainer.addChild(new Text(theme.bold(`Server: ${selected.name}`), 0, 0));
		if (selected.error) {
			this.detailsContainer.addChild(new Text(theme.fg("error", selected.error), 0, 0));
		}
		if (selected.tools.length === 0) {
			this.detailsContainer.addChild(new Text(theme.fg("muted", "No tools."), 0, 0));
			this.tui.requestRender();
			return;
		}

		const maxTools = 8;
		const visibleTools = selected.tools.slice(0, maxTools);
		for (const tool of visibleTools) {
			const aliasSuffix = tool.name === tool.exposedName ? "" : ` -> ${tool.exposedName}`;
			this.detailsContainer.addChild(new Text(`  - ${tool.name}${aliasSuffix}`, 0, 0));
		}
		if (selected.tools.length > maxTools) {
			this.detailsContainer.addChild(
				new Text(theme.fg("dim", `  ... ${selected.tools.length - maxTools} more`), 0, 0),
			);
		}
		this.tui.requestRender();
	}

	private formatState(server: McpServerStatus): string {
		switch (server.state) {
			case "connected":
				return theme.fg("success", "●");
			case "connecting":
				return theme.fg("warning", "◐");
			case "error":
				return theme.fg("error", "✕");
			case "disabled":
			default:
				return theme.fg("dim", "○");
		}
	}
}

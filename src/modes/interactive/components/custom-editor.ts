import { Editor, truncateToWidth, visibleWidth, type EditorOptions, type EditorTheme, type TUI } from "@mariozechner/pi-tui";
import type { AppAction, KeybindingsManager } from "../../../core/keybindings.js";

const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	public actionHandlers: Map<AppAction, () => void> = new Map();
	private plainPasteBuffer = "";
	private plainPasteFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly plainPasteFlushDelayMs = 80;

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppAction, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	private isLikelyUnbracketedPasteChunk(data: string): boolean {
		if (!data) return false;
		// Ignore known escape/control sequences (arrows, alt-combos, etc.)
		if (data.includes("\x1b")) return false;
		// Single Enter key should still submit immediately.
		if (data.length <= 1) return false;
		if (!data.includes("\n") && !data.includes("\r")) return false;
		let hasPrintable = false;
		for (const char of data) {
			if (char === "\n" || char === "\r" || char === "\t") continue;
			if (char.charCodeAt(0) >= 32) {
				hasPrintable = true;
				break;
			}
		}
		return hasPrintable;
	}

	private schedulePlainPasteFlush(): void {
		if (this.plainPasteFlushTimer) {
			clearTimeout(this.plainPasteFlushTimer);
		}
		this.plainPasteFlushTimer = setTimeout(() => {
			this.flushPlainPasteBuffer();
		}, this.plainPasteFlushDelayMs);
	}

	private flushPlainPasteBuffer(): void {
		if (this.plainPasteFlushTimer) {
			clearTimeout(this.plainPasteFlushTimer);
			this.plainPasteFlushTimer = undefined;
		}
		if (!this.plainPasteBuffer) return;
		const payload = this.plainPasteBuffer;
		this.plainPasteBuffer = "";
		super.handleInput(`\x1b[200~${payload}\x1b[201~`);
	}

	private rewritePasteMarker(line: string): string {
		return line.replace(/\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/gi, (_match, id: string, suffix?: string) => {
			return `[Pasted text #${id}${suffix ?? ""}]`;
		});
	}

	private rewriteRenderedLine(line: string, width: number): string {
		const rewritten = this.rewritePasteMarker(line);
		if (rewritten === line) return line;
		if (visibleWidth(rewritten) <= width) return rewritten;
		return truncateToWidth(rewritten, width, "", true);
	}

	private stripAnsiSgr(value: string): string {
		return value.replace(ANSI_SGR_PATTERN, "");
	}

	private isInternalEditorBorder(line: string): boolean {
		const plain = this.stripAnsiSgr(line).trimEnd();
		if (!plain) return false;
		if (/^─+$/.test(plain)) return true;
		return /^─── [↑↓] \d+ more ─*$/.test(plain);
	}

	private splitInternalEditorLayout(lines: string[]): { content: string[]; completion: string[] } {
		if (lines.length === 0) {
			return { content: [""], completion: [] };
		}
		if (lines.length < 3) {
			return { content: lines, completion: [] };
		}

		let bottomBorderIndex = -1;
		for (let i = lines.length - 1; i >= 1; i -= 1) {
			if (this.isInternalEditorBorder(lines[i] ?? "")) {
				bottomBorderIndex = i;
				break;
			}
		}

		if (bottomBorderIndex <= 0) {
			return { content: lines, completion: [] };
		}

		const content = lines.slice(1, bottomBorderIndex);
		const completion = lines.slice(bottomBorderIndex + 1);
		return {
			content: content.length > 0 ? content : [""],
			completion,
		};
	}

	private getInputFrameLabel(): string {
		const text = this.getText().trimStart();
		if (text.startsWith("!")) return "bash !";
		if (text.startsWith("/")) return "command /";
		if (text.startsWith("&")) return "mode &";
		return "input >";
	}

	private renderTopFrame(width: number, label: string, borderFn: (text: string) => string): string {
		const innerWidth = Math.max(0, width - 2);
		const trimmedLabel = label.trim();
		if (!trimmedLabel) {
			return borderFn(`╭${"─".repeat(innerWidth)}╮`);
		}

		let decoratedLabel = ` ${trimmedLabel} `;
		if (visibleWidth(decoratedLabel) >= innerWidth) {
			decoratedLabel = truncateToWidth(decoratedLabel, innerWidth, "");
			return borderFn(`╭${decoratedLabel}╮`);
		}

		const left = Math.max(0, innerWidth - visibleWidth(decoratedLabel));
		return borderFn(`╭${"─".repeat(left)}${decoratedLabel}╮`);
	}

	private wrapFrameLine(line: string, innerWidth: number, borderFn: (text: string) => string): string {
		const truncated = truncateToWidth(line, innerWidth, "");
		const pad = Math.max(0, innerWidth - visibleWidth(truncated));
		return borderFn("│") + " " + truncated + " ".repeat(pad) + " " + borderFn("│");
	}

	override render(width: number): string[] {
		// Fallback to default renderer for extremely narrow layouts.
		if (width < 8) {
			return super.render(width).map((line) => this.rewriteRenderedLine(line, width));
		}

		const safeWidth = Math.max(1, width);
		const frameInnerWidth = Math.max(1, safeWidth - 4); // "│ " + content + " │"
		const rawLines = super.render(frameInnerWidth).map((line) => this.rewriteRenderedLine(line, frameInnerWidth));
		const { content, completion } = this.splitInternalEditorLayout(rawLines);
		const borderFn = this.borderColor;

		const output: string[] = [];
		output.push(this.renderTopFrame(safeWidth, this.getInputFrameLabel(), borderFn));
		for (const line of content) {
			output.push(this.wrapFrameLine(line, frameInnerWidth, borderFn));
		}

		if (completion.length > 0) {
			output.push(borderFn(`├${"─".repeat(Math.max(0, safeWidth - 2))}┤`));
			for (const line of completion) {
				output.push(this.wrapFrameLine(line, frameInnerWidth, borderFn));
			}
		}

		output.push(borderFn(`╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`));
		return output;
	}

	handleInput(data: string): void {
		if (this.isLikelyUnbracketedPasteChunk(data)) {
			this.plainPasteBuffer += data.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			this.schedulePlainPasteFlush();
			return;
		}
		// If we buffered plain paste chunks, flush them before processing the next key.
		if (this.plainPasteBuffer) {
			this.flushPlainPasteBuffer();
		}

		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "interrupt" && action !== "exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}

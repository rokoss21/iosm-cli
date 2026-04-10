import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@mariozechner/pi-tui";
import { editorKey } from "./keybinding-hints.js";
import { MessageWindow } from "./message-window.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const THINKING_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

function toSingleLinePreview(text: string, maxChars = 100): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "";
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getSpinnerFrame(signal: number): string {
	const index = Math.max(0, Math.floor(signal)) % THINKING_SPINNER_FRAMES.length;
	return THINKING_SPINNER_FRAMES[index] ?? "-";
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private messageWindow: MessageWindow;
	private hideThinkingBlock: boolean;
	private messageLabel: string;
	private expanded = false;
	private isStreaming = false;
	private renderEnabled = true;
	private markdownTheme: MarkdownTheme;
	private lastMessage?: AssistantMessage;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		messageLabel = "IOSM Agent",
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.messageLabel = messageLabel.trim() || "IOSM Agent";

		this.addChild(new Spacer(1));

		// Container for message content
		this.contentContainer = new Container();
		this.messageWindow = new MessageWindow(this.contentContainer, {
			label: this.messageLabel,
			lineColor: "borderMuted",
			labelColor: "muted",
			paddingY: 1,
		});
		this.messageWindow.setVisible(false);
		this.addChild(this.messageWindow);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		if (!this.renderEnabled) return [];
		return super.render(width);
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setStreaming(streaming: boolean): void {
		this.isStreaming = streaming;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Clear content container
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		const shouldShowError = !hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error");
		const showFrame = hasVisibleContent || shouldShowError || this.isStreaming;
		this.renderEnabled = showFrame;
		this.messageWindow.setVisible(showFrame);

		if (!showFrame) {
			return;
		}

		this.contentContainer.addChild(new Spacer(1));

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, this.markdownTheme));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else if (!this.expanded) {
					// Collapsed reasoning preview line with short excerpt.
					const preview = toSingleLinePreview(content.thinking, 96);
					const prefix = this.isStreaming ? `Thinking ${getSpinnerFrame(content.thinking.length / 12)}` : "Reasoning";
					const summary =
						preview.length > 0 ? `${prefix}: ${preview}` : this.isStreaming ? `${prefix}...` : "Reasoning hidden";
					const collapsedLabel =
						theme.italic(theme.fg("thinkingText", summary)) +
						theme.fg("dim", ` (${editorKey("expandTools")} to expand)`);
					this.contentContainer.addChild(new Text(collapsedLabel, 1, 0));
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), 1, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Show a live placeholder while streaming before text/thinking arrives.
		if (this.isStreaming && !hasVisibleContent) {
			const spinner = getSpinnerFrame(Date.now() / 160);
			const collapsedLabel =
				theme.italic(theme.fg("thinkingText", `Thinking ${spinner}...`)) +
				(this.hideThinkingBlock || this.expanded
					? ""
					: theme.fg("dim", ` (${editorKey("expandTools")} to expand)`));
			this.contentContainer.addChild(new Text(collapsedLabel, 1, 0));
		}

		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				if (hasVisibleContent) {
					this.contentContainer.addChild(new Spacer(1));
				} else {
					this.contentContainer.addChild(new Spacer(1));
				}
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0));
			}
		}
	}
}

import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ThemeColor } from "../theme/theme.js";
import { theme } from "../theme/theme.js";

interface MessageWindowOptions {
	label?: string;
	lineColor?: ThemeColor;
	labelColor?: ThemeColor;
	paddingY?: number;
}

/**
 * Framed message window with full contour (top/bottom + side lines) and
 * configurable inner vertical padding.
 */
export class MessageWindow implements Component {
	private visible = true;

	constructor(
		private content: Component,
		private options: MessageWindowOptions = {},
	) {}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	invalidate(): void {
		this.content.invalidate();
	}

	render(width: number): string[] {
		if (!this.visible) return [];

		const safeWidth = Math.max(8, width);
		const innerWidth = Math.max(1, safeWidth - 4); // "│ " + content + " │"
		const lineColor = this.options.lineColor ?? "borderMuted";
		const labelColor = this.options.labelColor ?? "accent";
		const paddingY = Math.max(0, this.options.paddingY ?? 0);
		const lineFn = (text: string) => theme.fg(lineColor, text);
		const labelFn = (text: string) => theme.fg(labelColor, text);

		const output: string[] = [];
		output.push(this.renderTopBorder(safeWidth, lineFn, labelFn));

		for (let i = 0; i < paddingY; i++) {
			output.push(this.wrapLine("", innerWidth, lineFn));
		}

		const contentLines = this.content.render(innerWidth);
		const linesToRender = contentLines.length > 0 ? contentLines : [""];
		for (const line of linesToRender) {
			output.push(this.wrapLine(line, innerWidth, lineFn));
		}

		for (let i = 0; i < paddingY; i++) {
			output.push(this.wrapLine("", innerWidth, lineFn));
		}

		output.push(lineFn(`╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`));
		return output;
	}

	private wrapLine(line: string, innerWidth: number, lineFn: (text: string) => string): string {
		const truncated = truncateToWidth(line, innerWidth, "");
		const pad = Math.max(0, innerWidth - visibleWidth(truncated));
		return lineFn("│") + " " + truncated + " ".repeat(pad) + " " + lineFn("│");
	}

	private renderTopBorder(
		width: number,
		lineFn: (text: string) => string,
		labelFn: (text: string) => string,
	): string {
		const innerWidth = Math.max(0, width - 2);
		const rawLabel = (this.options.label ?? "").trim();
		if (!rawLabel) {
			return lineFn(`╭${"─".repeat(innerWidth)}╮`);
		}

		let label = ` ${rawLabel} `;
		if (visibleWidth(label) > innerWidth) {
			label = truncateToWidth(label, innerWidth, "");
		}
		const remaining = Math.max(0, innerWidth - visibleWidth(label));
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return lineFn(`╭${"─".repeat(left)}`) + labelFn(label) + lineFn(`${"─".repeat(right)}╮`);
	}
}

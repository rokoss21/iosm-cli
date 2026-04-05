import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { ThemeColor } from "../theme/theme.js";
import { theme } from "../theme/theme.js";

type BorderPosition = "top" | "bottom";

interface MessageFrameBorderOptions {
	label?: string;
	lineColor?: ThemeColor;
	labelColor?: ThemeColor;
}

/**
 * Border row for message windows (top/bottom) with optional centered label.
 */
export class MessageFrameBorder implements Component {
	private visible = true;

	constructor(
		private position: BorderPosition,
		private options: MessageFrameBorderOptions = {},
	) {}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}

	invalidate(): void {
		// Stateless component
	}

	render(width: number): string[] {
		if (!this.visible) return [];

		const safeWidth = Math.max(2, width);
		const innerWidth = Math.max(0, safeWidth - 2);
		const lineColor = this.options.lineColor ?? "borderMuted";
		const lineFn = (text: string) => theme.fg(lineColor, text);

		if (this.position === "bottom") {
			return [lineFn(`╰${"─".repeat(innerWidth)}╯`)];
		}

		let labelRaw = (this.options.label ?? "").trim();
		if (!labelRaw) {
			return [lineFn(`╭${"─".repeat(innerWidth)}╮`)];
		}

		let label = ` ${labelRaw} `;
		if (visibleWidth(label) > innerWidth) {
			label = truncateToWidth(label, innerWidth, "");
			label = label.trim() ? ` ${label.trim()} ` : "";
			if (visibleWidth(label) > innerWidth) {
				label = truncateToWidth(label, innerWidth, "");
			}
		}
		if (!label.trim()) {
			return [lineFn(`╭${"─".repeat(innerWidth)}╮`)];
		}

		const fill = Math.max(0, innerWidth - visibleWidth(label));
		const left = Math.floor(fill / 2);
		const right = fill - left;
		const labelColor = this.options.labelColor ?? "accent";
		const labelFn = (text: string) => theme.fg(labelColor, text);

		return [lineFn(`╭${"─".repeat(left)}`) + labelFn(label) + lineFn(`${"─".repeat(right)}╮`)];
	}
}

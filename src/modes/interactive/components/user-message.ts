import { Container, Markdown, type MarkdownTheme, Spacer } from "@mariozechner/pi-tui";
import { MessageWindow } from "./message-window.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const MESSAGE_PADDING_X = 2;

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));

		const content = new Container();
		content.addChild(
			new Markdown(text, MESSAGE_PADDING_X, 0, markdownTheme, {
				color: (value: string) => theme.fg("userMessageText", value),
			}),
		);

		this.addChild(
			new MessageWindow(content, {
				label: "you",
				lineColor: "borderAccent",
				labelColor: "accent",
				paddingY: 1,
			}),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END;
		return lines;
	}
}

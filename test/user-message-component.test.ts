import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("UserMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders framed user message window", () => {
		const component = new UserMessageComponent("Привет, мир");
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("╭");
		expect(rendered).toContain("╮");
		expect(rendered).toContain("╰");
		expect(rendered).toContain("╯");
		expect(rendered).toContain("│");
		expect(rendered).toContain("you");
		expect(rendered).toContain("Привет, мир");
	});
});

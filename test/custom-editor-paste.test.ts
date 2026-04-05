import { describe, expect, test, vi, afterEach } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";

const editorTheme: any = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};

function createEditor() {
	const tui: any = {
		requestRender: vi.fn(),
		terminal: { rows: 40 },
	};
	return new CustomEditor(tui, editorTheme, KeybindingsManager.create());
}

describe("CustomEditor large paste UX", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("renders framed input box with contour and label", () => {
		const editor = createEditor();
		editor.setText("hello");

		const rendered = editor.render(60).join("\n");
		expect(rendered).toContain("╭");
		expect(rendered).toContain("╮");
		expect(rendered).toContain("╰");
		expect(rendered).toContain("╯");
		expect(rendered).toContain("│");
		expect(rendered).toContain("input >");
	});

	test("switches frame label for slash and bash modes", () => {
		const editor = createEditor();
		editor.setText("/help");
		expect(editor.render(60).join("\n")).toContain("command /");

		editor.setText("!ls -la");
		expect(editor.render(60).join("\n")).toContain("bash !");
	});

	test("treats unbracketed multiline paste as one paste and submits once", () => {
		vi.useFakeTimers();
		const editor = createEditor();
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;

		const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);
		const rawPaste = lines.join("\r");

		editor.handleInput(rawPaste);
		expect(onSubmit).not.toHaveBeenCalled();

		vi.runAllTimers();
		expect(editor.getText()).toContain("[paste #1 +12 lines]");

		editor.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledTimes(1);
		const submitted = onSubmit.mock.calls[0]?.[0] as string;
		expect(submitted.split("\n")).toHaveLength(12);
		expect(submitted).toContain("line-1");
		expect(submitted).toContain("line-12");
	});

	test("renders compact pasted text marker label in UI", () => {
		vi.useFakeTimers();
		const editor = createEditor();

		const lines = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`);
		editor.handleInput(lines.join("\r"));
		vi.runAllTimers();

		const rendered = editor.render(100).join("\n");
		expect(rendered).toContain("[Pasted text #1 +15 lines]");
		expect(rendered).not.toContain("[paste #1 +15 lines]");
	});

	test("never overflows width when rewritten marker would be too long", () => {
		vi.useFakeTimers();
		const editor = createEditor();

		const lines = Array.from({ length: 15 }, (_, i) => `item-${i + 1}`);
		editor.handleInput(lines.join("\r"));
		vi.runAllTimers();

		expect(() => editor.render(24)).not.toThrow();
	});
});

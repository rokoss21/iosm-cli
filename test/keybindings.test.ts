import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EDITOR_KEYBINDINGS, EditorKeybindingsManager, setEditorKeybindings } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";

describe("KeybindingsManager", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		setEditorKeybindings(new EditorKeybindingsManager(DEFAULT_EDITOR_KEYBINDINGS));
	});

	function createTempAgentDir(config: unknown): string {
		const dir = mkdtempSync(join(tmpdir(), "iosm-keybindings-"));
		tempDirs.push(dir);
		writeFileSync(join(dir, "keybindings.json"), JSON.stringify(config, null, 2), "utf8");
		return dir;
	}

	it("loads action->key format and normalizes key tokens", () => {
		const agentDir = createTempAgentDir({
			cycleModelForward: ["Ctrl+P", " Alt+P "],
			selectModel: "Control+L",
			expandTools: "CTRL+O",
		});

		const manager = KeybindingsManager.create(agentDir);

		expect(manager.getKeys("cycleModelForward")).toEqual(["ctrl+p", "alt+p"]);
		expect(manager.getKeys("selectModel")).toEqual(["ctrl+l"]);
		expect(manager.getKeys("expandTools")).toEqual(["ctrl+o"]);
	});

	it("loads legacy key->action format and resolves action aliases", () => {
		const agentDir = createTempAgentDir({
			"Ctrl+P": "nextModel",
			"Ctrl+Shift+P": "previousModel",
			"Ctrl+L": "openModelSelector",
			"Ctrl+O": "toggleTools",
		});

		const manager = KeybindingsManager.create(agentDir);

		expect(manager.getKeys("cycleModelForward")).toContain("ctrl+p");
		expect(manager.getKeys("cycleModelBackward")).toContain("ctrl+shift+p");
		expect(manager.getKeys("selectModel")).toContain("ctrl+l");
		expect(manager.getKeys("expandTools")).toContain("ctrl+o");
	});

	it("merges mixed keybinding formats for the same action", () => {
		const agentDir = createTempAgentDir({
			cycleModelForward: "ctrl+n",
			"ctrl+p": "nextModel",
		});

		const manager = KeybindingsManager.create(agentDir);

		expect(manager.getKeys("cycleModelForward")).toEqual(["ctrl+n", "ctrl+p"]);
	});

	it("defines platform-aware defaults for problematic terminal combos", () => {
		expect(DEFAULT_APP_KEYBINDINGS.expandTools).toEqual(["ctrl+o", "alt+o"]);
		expect(DEFAULT_APP_KEYBINDINGS.toggleThinking).toEqual(["ctrl+t", "alt+t"]);
		expect(DEFAULT_APP_KEYBINDINGS.cycleModelForward).toEqual(["ctrl+p", "alt+p"]);
		expect(DEFAULT_APP_KEYBINDINGS.selectModel).toEqual(["ctrl+l", "alt+l"]);

		if (process.platform === "win32") {
			expect(DEFAULT_APP_KEYBINDINGS.suspend).toEqual([]);
		} else {
			expect(DEFAULT_APP_KEYBINDINGS.suspend).toEqual(["ctrl+z", "alt+z"]);
		}
	});
});


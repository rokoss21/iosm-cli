import { describe, expect, test } from "vitest";
import { adaptCommandForShell, resolveWindowsCommandAdapter } from "../src/utils/shell.js";

describe("windows shell command adapter", () => {
	test("keeps commands unchanged on non-windows platforms", () => {
		const command = "ls -la";
		expect(resolveWindowsCommandAdapter(command, "linux")).toBe("none");
		expect(adaptCommandForShell(command, "linux")).toBe(command);
	});

	test("routes cmd-style syntax to cmd.exe wrapper", () => {
		const command = "dir %LOCALAPPDATA%\\iosm-cli";
		expect(resolveWindowsCommandAdapter(command, "win32")).toBe("cmd");
		expect(adaptCommandForShell(command, "win32")).toContain("cmd.exe /d /s /c");
	});

	test("routes powershell-style syntax to powershell wrapper", () => {
		const command = "Get-ChildItem $env:LOCALAPPDATA\\iosm-cli";
		expect(resolveWindowsCommandAdapter(command, "win32")).toBe("powershell");
		expect(adaptCommandForShell(command, "win32")).toContain("powershell.exe -NoLogo -NoProfile -NonInteractive");
	});

	test("does not wrap when command already invokes explicit shell", () => {
		const cmdCommand = "cmd.exe /d /s /c dir %LOCALAPPDATA%\\iosm-cli";
		const psCommand = "powershell.exe -Command \"Get-ChildItem\"";
		expect(resolveWindowsCommandAdapter(cmdCommand, "win32")).toBe("none");
		expect(resolveWindowsCommandAdapter(psCommand, "win32")).toBe("none");
		expect(adaptCommandForShell(cmdCommand, "win32")).toBe(cmdCommand);
		expect(adaptCommandForShell(psCommand, "win32")).toBe(psCommand);
	});
});


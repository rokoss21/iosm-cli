import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir, getSettingsPath } from "../config.js";
import { SettingsManager } from "../core/settings-manager.js";

let cachedShellConfig: { shell: string; args: string[] } | null = null;

const WINDOWS_CMD_ENV_PATTERN = /%[A-Za-z_][A-Za-z0-9_]*%/;
const WINDOWS_CMD_BUILTIN_PATTERN =
	/^\s*@?\s*(?:dir|copy|xcopy|move|ren|rename|del|erase|type|set|cls|mkdir|md|rmdir|rd|where)\b/i;
const WINDOWS_DRIVE_PATH_PATTERN = /(?:^|[\s"'`])(?:[A-Za-z]:\\)/;
const WINDOWS_DRIVE_PATH_START_PATTERN = /^\s*[A-Za-z]:\\/;
const WINDOWS_POWERSHELL_ENV_PATTERN = /\$env:[A-Za-z_][A-Za-z0-9_]*/i;
const WINDOWS_POWERSHELL_CMDLET_PATTERN = /^\s*(?:Get|Set|New|Remove|Invoke|Test|Write|Select|Where|ForEach)-[A-Za-z]/i;
const WINDOWS_POWERSHELL_VAR_ASSIGNMENT_PATTERN = /^\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/;
const WINDOWS_EXPLICIT_SHELL_PATTERN = /^\s*(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)\b/i;

export type WindowsCommandAdapter = "none" | "cmd" | "powershell";

function quotePosixShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function encodePowerShellCommand(command: string): string {
	return Buffer.from(command, "utf16le").toString("base64");
}

function getLeadingCommandToken(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return "";
	const match = /^[^\s]+/.exec(trimmed);
	if (!match) return "";
	return match[0]?.replace(/^["']|["']$/g, "").toLowerCase() ?? "";
}

function looksLikeUnixFirstToken(command: string): boolean {
	const token = getLeadingCommandToken(command);
	if (!token) return false;
	const unixLike = new Set([
		"ls",
		"cat",
		"grep",
		"rg",
		"fd",
		"find",
		"pwd",
		"sed",
		"awk",
		"head",
		"tail",
		"wc",
		"sort",
		"uniq",
		"xargs",
		"bash",
		"sh",
		"zsh",
		"node",
		"npm",
		"npx",
		"pnpm",
		"yarn",
		"git",
		"python",
		"python3",
		"pip",
		"make",
		"chmod",
		"cp",
		"mv",
		"rm",
		"echo",
		"touch",
	]);
	return unixLike.has(token);
}

export function resolveWindowsCommandAdapter(
	command: string,
	platform: NodeJS.Platform = process.platform,
): WindowsCommandAdapter {
	if (platform !== "win32") return "none";

	const trimmed = command.trim();
	if (!trimmed) return "none";
	if (WINDOWS_EXPLICIT_SHELL_PATTERN.test(trimmed)) return "none";

	const looksLikePowerShell =
		WINDOWS_POWERSHELL_ENV_PATTERN.test(trimmed) ||
		WINDOWS_POWERSHELL_CMDLET_PATTERN.test(trimmed) ||
		WINDOWS_POWERSHELL_VAR_ASSIGNMENT_PATTERN.test(trimmed);
	if (looksLikePowerShell) return "powershell";

	const looksLikeCmd =
		WINDOWS_CMD_ENV_PATTERN.test(trimmed) ||
		WINDOWS_CMD_BUILTIN_PATTERN.test(trimmed) ||
		(WINDOWS_DRIVE_PATH_START_PATTERN.test(trimmed) ||
			(WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) && !looksLikeUnixFirstToken(trimmed)));
	if (looksLikeCmd) return "cmd";

	return "none";
}

/**
 * On Windows we execute through bash by default. If the incoming command is
 * clearly written for cmd.exe or PowerShell syntax, wrap it in the matching
 * interpreter so users can paste native commands without manual rewriting.
 */
export function adaptCommandForShell(command: string, platform: NodeJS.Platform = process.platform): string {
	const adapter = resolveWindowsCommandAdapter(command, platform);
	if (adapter === "cmd") {
		return `cmd.exe /d /s /c ${quotePosixShellArg(command)}`;
	}
	if (adapter === "powershell") {
		const encoded = encodePowerShellCommand(command);
		return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
	}
	return command;
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], { encoding: "utf-8", timeout: 5000 });
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Get shell configuration based on platform.
 * Resolution order:
 * 1. User-specified shellPath in settings.json
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
export function getShellConfig(): { shell: string; args: string[] } {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	const settings = SettingsManager.create();
	const customShellPath = settings.getShellPath();

	// 1. Check user-specified shell path
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			cachedShellConfig = { shell: customShellPath, args: ["-c"] };
			return cachedShellConfig;
		}
		throw new Error(
			`Custom shell path not found: ${customShellPath}\nPlease update shellPath in ${getSettingsPath()}`,
		);
	}

	if (process.platform === "win32") {
		// 2. Try Git Bash in known locations
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				cachedShellConfig = { shell: path, args: ["-c"] };
				return cachedShellConfig;
			}
		}

		// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)
		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				`  3. Set shellPath in ${getSettingsPath()}\n\n` +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix: try /bin/bash, then bash on PATH, then fallback to sh
	if (existsSync("/bin/bash")) {
		cachedShellConfig = { shell: "/bin/bash", args: ["-c"] };
		return cachedShellConfig;
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
		return cachedShellConfig;
	}

	cachedShellConfig = { shell: "sh", args: ["-c"] };
	return cachedShellConfig;
}

export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
export function sanitizeBinaryOutput(str: string): string {
	// Use Array.from to properly iterate over code points (not code units)
	// This handles surrogate pairs correctly and catches edge cases where
	// codePointAt() might return undefined
	return Array.from(str)
		.filter((char) => {
			// Filter out characters that cause string-width to crash
			// This includes:
			// - Unicode format characters
			// - Lone surrogates (already filtered by Array.from)
			// - Control chars except \t \n \r
			// - Characters with undefined code points

			const code = char.codePointAt(0);

			// Skip if code point is undefined (edge case with invalid strings)
			if (code === undefined) return false;

			// Allow tab, newline, carriage return
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// Filter out control characters (0x00-0x1F, except 0x09, 0x0a, 0x0x0d)
			if (code <= 0x1f) return false;

			// Filter out Unicode format characters
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}

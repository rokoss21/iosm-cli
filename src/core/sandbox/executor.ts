import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const BWRAP_BIN = "bwrap";
const ENV_SANDBOX_ENABLED = "IOSM_SANDBOX_ENABLED";

function bwrapAvailable(): boolean {
	try {
		const result = spawnSync(BWRAP_BIN, ["--version"], { stdio: "pipe" });
		const err = result.error as NodeJS.ErrnoException | undefined;
		return !err || err.code !== "ENOENT";
	} catch {
		return false;
	}
}

export interface SandboxWrapInput {
	command: string;
	args: string[];
	cwd: string;
	enabled: boolean;
}

export interface SandboxWrapResult {
	command: string;
	args: string[];
}

export function isSandboxEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[ENV_SANDBOX_ENABLED];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function wrapCommandWithSandbox(input: SandboxWrapInput): SandboxWrapResult {
	if (!input.enabled) {
		return {
			command: input.command,
			args: [...input.args],
		};
	}

	if (process.platform !== "linux") {
		throw new Error("Sandbox is enabled, but Linux bubblewrap is only supported on Linux in v1.");
	}

	if (!bwrapAvailable()) {
		throw new Error("Sandbox is enabled, but `bwrap` is unavailable. Install bubblewrap or disable sandbox.");
	}

	const workspace = resolve(input.cwd);
	const runtimeTmp = resolve(tmpdir());
	const wrappedArgs = [
		"--die-with-parent",
		"--new-session",
		"--ro-bind",
		"/",
		"/",
		"--bind",
		workspace,
		workspace,
		"--bind",
		runtimeTmp,
		runtimeTmp,
		"--chdir",
		workspace,
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--",
		input.command,
		...input.args,
	];

	return {
		command: BWRAP_BIN,
		args: wrappedArgs,
	};
}

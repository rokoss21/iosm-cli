import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "child_process";
import { adaptCommandForShell, getShellConfig, getShellEnv, killProcessTree } from "../utils/shell.js";

export type BackgroundProcessStatus = "running" | "done" | "error" | "terminated" | "unknown";

interface BackgroundProcessMeta {
	id: string;
	command: string;
	cwd: string;
	rootCwd: string;
	pid: number;
	createdAt: string;
	startedAt: string;
	source?: "interactive" | "tool";
	requestedStopAt?: string;
	logPath: string;
	finishedAtPath: string;
	exitCodePath: string;
}

export interface BackgroundProcessRecord {
	id: string;
	command: string;
	cwd: string;
	rootCwd: string;
	pid: number;
	createdAt: string;
	startedAt: string;
	source?: "interactive" | "tool";
	requestedStopAt?: string;
	logPath: string;
	finishedAtPath: string;
	exitCodePath: string;
	metaPath: string;
	status: BackgroundProcessStatus;
	finishedAt?: string;
	exitCode?: number;
}

export interface StartBackgroundProcessInput {
	rootCwd: string;
	command: string;
	cwd?: string;
	source?: "interactive" | "tool";
}

export interface PruneBackgroundProcessesResult {
	removed: number;
	removedIds: string[];
	skippedRunning: number;
	skippedRecent: number;
	thresholdHours: number;
}

const BACKGROUND_DIR_SEGMENTS = [".iosm", "background", "processes"] as const;
const MAX_LOG_TAIL_BYTES = 256 * 1024;
const BACKGROUND_STOP_FORCE_KILL_DELAY_MS = 1500;
const BACKGROUND_STOP_FALLBACK_EXIT_CODE = 143;

function getProcessesDir(rootCwd: string): string {
	return join(rootCwd, ...BACKGROUND_DIR_SEGMENTS);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM") return true;
		return false;
	}
}

function parseIntegerFile(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return undefined;
		const value = Number.parseInt(raw, 10);
		return Number.isFinite(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function parseTextFile(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8").trim();
		return raw || undefined;
	} catch {
		return undefined;
	}
}

function writeCompletionArtifacts(meta: BackgroundProcessMeta, finishedAt: string, exitCode: number): void {
	writeFileSync(meta.finishedAtPath, `${finishedAt}\n`, "utf8");
	writeFileSync(meta.exitCodePath, `${exitCode}\n`, "utf8");
}

function signalProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	if (process.platform === "win32") {
		// /F is forced kill; omit it for soft terminate attempt.
		const args = signal === "SIGKILL" ? ["/F", "/T", "/PID", String(pid)] : ["/T", "/PID", String(pid)];
		try {
			spawnSync("taskkill", args, { stdio: "ignore", timeout: 5000 });
		} catch {
			// Ignore termination errors (process may already be gone).
		}
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already dead.
		}
	}
}

function scheduleForceKill(pid: number): void {
	const timer = setTimeout(() => {
		if (!isProcessAlive(pid)) return;
		killProcessTree(pid);
	}, BACKGROUND_STOP_FORCE_KILL_DELAY_MS);
	timer.unref();
}

function toRecord(meta: BackgroundProcessMeta, metaPath: string): BackgroundProcessRecord {
	const finishedAt = parseTextFile(meta.finishedAtPath);
	const exitCode = parseIntegerFile(meta.exitCodePath);
	const alive = isProcessAlive(meta.pid);
	let status: BackgroundProcessStatus = "unknown";
	if (!alive && meta.requestedStopAt) {
		status = "terminated";
	} else if (alive) {
		status = "running";
	} else if (finishedAt && typeof exitCode === "number") {
		status = exitCode === 0 ? "done" : "error";
	}

	return {
		id: meta.id,
		command: meta.command,
		cwd: meta.cwd,
		rootCwd: meta.rootCwd,
		pid: meta.pid,
		createdAt: meta.createdAt,
		startedAt: meta.startedAt,
		source: meta.source,
		requestedStopAt: meta.requestedStopAt,
		logPath: meta.logPath,
		finishedAtPath: meta.finishedAtPath,
		exitCodePath: meta.exitCodePath,
		metaPath,
		status,
		finishedAt,
		exitCode,
	};
}

function loadMeta(metaPath: string): BackgroundProcessMeta | undefined {
	try {
		const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<BackgroundProcessMeta>;
		if (
			typeof parsed.id !== "string" ||
			typeof parsed.command !== "string" ||
			typeof parsed.cwd !== "string" ||
			typeof parsed.rootCwd !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.createdAt !== "string" ||
			typeof parsed.startedAt !== "string" ||
			typeof parsed.logPath !== "string" ||
			typeof parsed.finishedAtPath !== "string" ||
			typeof parsed.exitCodePath !== "string"
		) {
			return undefined;
		}
		return {
			id: parsed.id,
			command: parsed.command,
			cwd: parsed.cwd,
			rootCwd: parsed.rootCwd,
			pid: parsed.pid,
			createdAt: parsed.createdAt,
			startedAt: parsed.startedAt,
			source: parsed.source,
			requestedStopAt: parsed.requestedStopAt,
			logPath: parsed.logPath,
			finishedAtPath: parsed.finishedAtPath,
			exitCodePath: parsed.exitCodePath,
		};
	} catch {
		return undefined;
	}
}

function saveMeta(metaPath: string, meta: BackgroundProcessMeta): void {
	writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function readFileTailUtf8(path: string, maxBytes: number): string {
	if (!existsSync(path)) return "";
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		if (size <= 0) return "";
		const readSize = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(readSize);
		readSync(fd, buffer, 0, readSize, size - readSize);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export function startBackgroundProcess(input: StartBackgroundProcessInput): BackgroundProcessRecord {
	const rootCwd = resolve(input.rootCwd);
	const processCwd = resolve(input.cwd ?? rootCwd);
	if (!existsSync(processCwd) || !statSync(processCwd).isDirectory()) {
		throw new Error(`Background process cwd does not exist: ${processCwd}`);
	}

	const processesDir = getProcessesDir(rootCwd);
	mkdirSync(processesDir, { recursive: true });

	const id = `bg_${Date.now()}_${randomBytes(4).toString("hex")}`;
	const logPath = join(processesDir, `${id}.log`);
	const finishedAtPath = join(processesDir, `${id}.finished`);
	const exitCodePath = join(processesDir, `${id}.exitcode`);
	const metaPath = join(processesDir, `${id}.json`);
	const now = new Date().toISOString();

	const { shell, args } = getShellConfig();
	const adaptedCommand = adaptCommandForShell(input.command);
	const wrappedCommand = [
		"(",
		adaptedCommand,
		")",
		"__iosm_bg_exit_code=$?",
		`__iosm_bg_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || node -e 'console.log(new Date().toISOString())')`,
		`printf "%s\\n" "$__iosm_bg_finished_at" > ${shellQuote(finishedAtPath)}`,
		`printf "%s\\n" "$__iosm_bg_exit_code" > ${shellQuote(exitCodePath)}`,
		'exit "$__iosm_bg_exit_code"',
	].join("\n");

	const logFd = openSync(logPath, "a");
	const child = spawn(shell, [...args, wrappedCommand], {
		cwd: processCwd,
		detached: true,
		env: getShellEnv(),
		stdio: ["ignore", logFd, logFd],
	});
	closeSync(logFd);

	if (!child.pid) {
		throw new Error("Failed to start background process: missing pid.");
	}

	child.unref();

	const meta: BackgroundProcessMeta = {
		id,
		command: input.command,
		cwd: processCwd,
		rootCwd,
		pid: child.pid,
		createdAt: now,
		startedAt: now,
		source: input.source,
		logPath,
		finishedAtPath,
		exitCodePath,
	};
	saveMeta(metaPath, meta);
	return toRecord(meta, metaPath);
}

export function listBackgroundProcesses(rootCwd: string, limit = 20): BackgroundProcessRecord[] {
	const dir = getProcessesDir(resolve(rootCwd));
	if (!existsSync(dir)) return [];
	const maxItems = Math.max(1, Math.min(200, Math.floor(limit)));
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(dir, name))
		.sort((a, b) => b.localeCompare(a))
		.slice(0, maxItems);

	const records: BackgroundProcessRecord[] = [];
	for (const metaPath of files) {
		const meta = loadMeta(metaPath);
		if (!meta) continue;
		records.push(toRecord(meta, metaPath));
	}
	return records;
}

export function getBackgroundProcess(rootCwd: string, id: string): BackgroundProcessRecord | undefined {
	const dir = getProcessesDir(resolve(rootCwd));
	const metaPath = join(dir, `${id}.json`);
	if (!existsSync(metaPath)) return undefined;
	const meta = loadMeta(metaPath);
	if (!meta) return undefined;
	return toRecord(meta, metaPath);
}

export function stopBackgroundProcess(rootCwd: string, id: string): BackgroundProcessRecord | undefined {
	const dir = getProcessesDir(resolve(rootCwd));
	const metaPath = join(dir, `${id}.json`);
	const meta = loadMeta(metaPath);
	if (!meta) return undefined;

	const wasAlive = isProcessAlive(meta.pid);
	if (!wasAlive) {
		return toRecord(meta, metaPath);
	}

	meta.requestedStopAt = new Date().toISOString();
	saveMeta(metaPath, meta);

	// Try graceful shutdown first and then enforce a hard kill in the background if needed.
	signalProcessTree(meta.pid, "SIGTERM");
	scheduleForceKill(meta.pid);

	if (isProcessAlive(meta.pid)) {
		return toRecord(meta, metaPath);
	}

	// Process already stopped synchronously; write fallback completion markers if shell did not flush them.
	const hasFinishedAt = existsSync(meta.finishedAtPath);
	const hasExitCode = existsSync(meta.exitCodePath);
	if (!hasFinishedAt || !hasExitCode) {
		writeCompletionArtifacts(meta, new Date().toISOString(), BACKGROUND_STOP_FALLBACK_EXIT_CODE);
	}

	return toRecord(meta, metaPath);
}

export function readBackgroundProcessLogTail(rootCwd: string, id: string, lines = 80): string | undefined {
	const record = getBackgroundProcess(rootCwd, id);
	if (!record) return undefined;
	const maxLines = Math.max(1, Math.min(1000, Math.floor(lines)));
	const tail = readFileTailUtf8(record.logPath, MAX_LOG_TAIL_BYTES);
	if (!tail) return "";
	const chunks = tail.split(/\r?\n/);
	const sliced = chunks.slice(-maxLines);
	return sliced.join("\n").trimEnd();
}

export function pruneBackgroundProcesses(
	rootCwd: string,
	options?: {
		maxAgeHours?: number;
		limit?: number;
	},
): PruneBackgroundProcessesResult {
	const thresholdHoursRaw = options?.maxAgeHours;
	const thresholdHours =
		typeof thresholdHoursRaw === "number" && Number.isFinite(thresholdHoursRaw)
			? Math.max(1, Math.floor(thresholdHoursRaw))
			: 168;
	const limitRaw = options?.limit;
	const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 1000;
	const thresholdMs = thresholdHours * 60 * 60 * 1000;
	const now = Date.now();
	const result: PruneBackgroundProcessesResult = {
		removed: 0,
		removedIds: [],
		skippedRunning: 0,
		skippedRecent: 0,
		thresholdHours,
	};

	const dir = getProcessesDir(resolve(rootCwd));
	if (!existsSync(dir)) return result;

	const metaPaths = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(dir, name))
		.sort((a, b) => b.localeCompare(a))
		.slice(0, limit);

	for (const metaPath of metaPaths) {
		const meta = loadMeta(metaPath);
		if (!meta) continue;
		const record = toRecord(meta, metaPath);
		if (record.status === "running") {
			result.skippedRunning += 1;
			continue;
		}

		const createdAtMs = Date.parse(record.createdAt);
		if (Number.isFinite(createdAtMs) && now - createdAtMs < thresholdMs) {
			result.skippedRecent += 1;
			continue;
		}

		const filesToDelete = [record.metaPath, record.logPath, record.finishedAtPath, record.exitCodePath];
		for (const filePath of filesToDelete) {
			try {
				rmSync(filePath, { force: true });
			} catch {
				// Ignore cleanup errors for best-effort pruning.
			}
		}
		result.removed += 1;
		result.removedIds.push(record.id);
	}

	return result;
}

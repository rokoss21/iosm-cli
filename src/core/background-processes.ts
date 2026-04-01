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
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree } from "../utils/shell.js";

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

const BACKGROUND_DIR_SEGMENTS = [".iosm", "background", "processes"] as const;
const MAX_LOG_TAIL_BYTES = 256 * 1024;

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

function toRecord(meta: BackgroundProcessMeta, metaPath: string): BackgroundProcessRecord {
	const finishedAt = parseTextFile(meta.finishedAtPath);
	const exitCode = parseIntegerFile(meta.exitCodePath);
	const alive = isProcessAlive(meta.pid);
	let status: BackgroundProcessStatus = "unknown";
	if (finishedAt && typeof exitCode === "number") {
		status = exitCode === 0 ? "done" : "error";
	} else if (meta.requestedStopAt && !alive) {
		status = "terminated";
	} else if (alive) {
		status = "running";
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
	const wrappedCommand = [
		input.command,
		"__iosm_bg_exit_code=$?",
		`__iosm_bg_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || node -e 'console.log(new Date().toISOString())')`,
		`printf "%s\\n" "$__iosm_bg_finished_at" > ${shellQuote(finishedAtPath)}`,
		`printf "%s\\n" "$__iosm_bg_exit_code" > ${shellQuote(exitCodePath)}`,
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

	if (isProcessAlive(meta.pid)) {
		killProcessTree(meta.pid);
		meta.requestedStopAt = new Date().toISOString();
		saveMeta(metaPath, meta);
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


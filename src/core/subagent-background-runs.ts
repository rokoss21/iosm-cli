import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type SubagentBackgroundRunStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface SubagentBackgroundRunRecord {
	runId: string;
	status: SubagentBackgroundRunStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	description: string;
	profile: string;
	cwd: string;
	agent?: string;
	model?: string;
	error?: string;
	transcriptPath?: string;
	requestedStopAt?: string;
	logPath: string;
	metaPath: string;
}

export interface WriteSubagentBackgroundRunStatusInput {
	runId: string;
	status: SubagentBackgroundRunStatus;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	description: string;
	profile: string;
	cwd: string;
	agent?: string;
	model?: string;
	error?: string;
	transcriptPath?: string;
	requestedStopAt?: string;
	logPath?: string;
}

export interface PruneSubagentBackgroundRunsResult {
	removed: number;
	removedIds: string[];
	skippedRunning: number;
	skippedRecent: number;
	thresholdHours: number;
}

const BACKGROUND_DIR_SEGMENTS = [".iosm", "subagents", "background"] as const;

const runningControllers = new Map<string, Map<string, AbortController>>();

function isStatus(value: unknown): value is SubagentBackgroundRunStatus {
	return value === "queued" || value === "running" || value === "done" || value === "error" || value === "cancelled";
}

function isTerminalStatus(status: SubagentBackgroundRunStatus): boolean {
	return status === "done" || status === "error" || status === "cancelled";
}

function getRootKey(rootCwd: string): string {
	return resolve(rootCwd).toLowerCase();
}

function getBackgroundDir(rootCwd: string): string {
	return join(resolve(rootCwd), ...BACKGROUND_DIR_SEGMENTS);
}

function getMetaPath(rootCwd: string, runId: string): string {
	return join(getBackgroundDir(rootCwd), `${runId}.json`);
}

export function getSubagentBackgroundRunLogPath(rootCwd: string, runId: string): string {
	return join(getBackgroundDir(rootCwd), `${runId}.log`);
}

function parseRecord(metaPath: string): SubagentBackgroundRunRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SubagentBackgroundRunRecord>;
		if (
			typeof parsed.runId !== "string" ||
			!isStatus(parsed.status) ||
			typeof parsed.createdAt !== "string" ||
			typeof parsed.description !== "string" ||
			typeof parsed.profile !== "string" ||
			typeof parsed.cwd !== "string"
		) {
			return undefined;
		}
		const runId = parsed.runId.trim();
		if (!runId) return undefined;
		return {
			runId,
			status: parsed.status,
			createdAt: parsed.createdAt,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
			finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : undefined,
			description: parsed.description,
			profile: parsed.profile,
			cwd: parsed.cwd,
			agent: typeof parsed.agent === "string" && parsed.agent.trim().length > 0 ? parsed.agent : undefined,
			model: typeof parsed.model === "string" && parsed.model.trim().length > 0 ? parsed.model : undefined,
			error: typeof parsed.error === "string" && parsed.error.trim().length > 0 ? parsed.error : undefined,
			transcriptPath:
				typeof parsed.transcriptPath === "string" && parsed.transcriptPath.trim().length > 0
					? parsed.transcriptPath
					: undefined,
			requestedStopAt:
				typeof parsed.requestedStopAt === "string" && parsed.requestedStopAt.trim().length > 0
					? parsed.requestedStopAt
					: undefined,
			logPath:
				typeof parsed.logPath === "string" && parsed.logPath.trim().length > 0
					? parsed.logPath
					: metaPath.replace(/\.json$/i, ".log"),
			metaPath,
		};
	} catch {
		return undefined;
	}
}

export function getSubagentBackgroundRun(rootCwd: string, runId: string): SubagentBackgroundRunRecord | undefined {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return undefined;
	const metaPath = getMetaPath(rootCwd, normalizedRunId);
	if (!existsSync(metaPath)) return undefined;
	return parseRecord(metaPath);
}

export function listSubagentBackgroundRuns(rootCwd: string, limit = 20): SubagentBackgroundRunRecord[] {
	const dir = getBackgroundDir(rootCwd);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith(".json"))
		.map((name) => join(dir, name))
		.sort((a, b) => b.localeCompare(a))
		.slice(0, Math.max(1, limit));

	const records: SubagentBackgroundRunRecord[] = [];
	for (const file of files) {
		const parsed = parseRecord(file);
		if (parsed) records.push(parsed);
	}
	records.sort((left, right) => {
		const byTime = right.createdAt.localeCompare(left.createdAt);
		if (byTime !== 0) return byTime;
		return right.runId.localeCompare(left.runId);
	});
	return records;
}

export function writeSubagentBackgroundRunStatus(
	rootCwd: string,
	input: WriteSubagentBackgroundRunStatusInput,
): string | undefined {
	try {
		const normalizedRunId = input.runId.trim();
		if (!normalizedRunId) return undefined;
		const dir = getBackgroundDir(rootCwd);
		mkdirSync(dir, { recursive: true });
		const existing = getSubagentBackgroundRun(rootCwd, normalizedRunId);
		const metaPath = getMetaPath(rootCwd, normalizedRunId);
		const logPath = (input.logPath?.trim() || existing?.logPath || getSubagentBackgroundRunLogPath(rootCwd, normalizedRunId)).trim();
		const payload = {
			runId: normalizedRunId,
			status: input.status,
			createdAt: input.createdAt,
			startedAt: input.startedAt,
			finishedAt: input.finishedAt,
			description: input.description,
			profile: input.profile,
			cwd: input.cwd,
			agent: input.agent,
			model: input.model,
			error: input.error,
			transcriptPath: input.transcriptPath,
			requestedStopAt: input.requestedStopAt ?? existing?.requestedStopAt,
			logPath,
		};
		writeFileSync(metaPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		return metaPath;
	} catch {
		return undefined;
	}
}

export function appendSubagentBackgroundRunLog(rootCwd: string, runId: string, message: string): string | undefined {
	try {
		const normalizedRunId = runId.trim();
		if (!normalizedRunId) return undefined;
		const dir = getBackgroundDir(rootCwd);
		mkdirSync(dir, { recursive: true });
		const logPath = getSubagentBackgroundRunLogPath(rootCwd, normalizedRunId);
		const line = `[${new Date().toISOString()}] ${message}\n`;
		appendFileSync(logPath, line, "utf8");
		return logPath;
	} catch {
		return undefined;
	}
}

export function readSubagentBackgroundRunLogTail(rootCwd: string, runId: string, lines = 120): string | undefined {
	const record = getSubagentBackgroundRun(rootCwd, runId);
	if (!record) return undefined;
	const maxLines = Math.max(1, Math.min(1000, Math.floor(lines)));
	if (!existsSync(record.logPath)) return "";
	try {
		const content = readFileSync(record.logPath, "utf8");
		const entries = content.split(/\r?\n/);
		while (entries.length > 0 && entries[entries.length - 1] === "") {
			entries.pop();
		}
		return entries.slice(-maxLines).join("\n");
	} catch {
		return "";
	}
}

export function registerSubagentBackgroundRunController(rootCwd: string, runId: string, controller: AbortController): void {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return;
	const rootKey = getRootKey(rootCwd);
	const byRun = runningControllers.get(rootKey) ?? new Map<string, AbortController>();
	byRun.set(normalizedRunId, controller);
	runningControllers.set(rootKey, byRun);
}

export function unregisterSubagentBackgroundRunController(rootCwd: string, runId: string): void {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return;
	const rootKey = getRootKey(rootCwd);
	const byRun = runningControllers.get(rootKey);
	if (!byRun) return;
	byRun.delete(normalizedRunId);
	if (byRun.size === 0) {
		runningControllers.delete(rootKey);
	}
}

function getController(rootCwd: string, runId: string): AbortController | undefined {
	const rootKey = getRootKey(rootCwd);
	const byRun = runningControllers.get(rootKey);
	if (!byRun) return undefined;
	return byRun.get(runId.trim());
}

export function requestStopSubagentBackgroundRun(
	rootCwd: string,
	runId: string,
): SubagentBackgroundRunRecord | undefined {
	const normalizedRunId = runId.trim();
	if (!normalizedRunId) return undefined;
	const current = getSubagentBackgroundRun(rootCwd, normalizedRunId);
	if (!current) return undefined;
	if (!isTerminalStatus(current.status)) {
		const requestedStopAt = new Date().toISOString();
		writeSubagentBackgroundRunStatus(rootCwd, {
			runId: current.runId,
			status: current.status,
			createdAt: current.createdAt,
			startedAt: current.startedAt,
			finishedAt: current.finishedAt,
			description: current.description,
			profile: current.profile,
			cwd: current.cwd,
			agent: current.agent,
			model: current.model,
			error: current.error,
			transcriptPath: current.transcriptPath,
			requestedStopAt,
			logPath: current.logPath,
		});
		appendSubagentBackgroundRunLog(rootCwd, normalizedRunId, "stop requested");
	}
	const controller = getController(rootCwd, normalizedRunId);
	controller?.abort();
	return getSubagentBackgroundRun(rootCwd, normalizedRunId);
}

export function requestStopAllSubagentBackgroundRuns(rootCwd: string): {
	requested: number;
	requestedIds: string[];
} {
	const records = listSubagentBackgroundRuns(rootCwd, 500).filter((record) => !isTerminalStatus(record.status));
	const requestedIds: string[] = [];
	for (const record of records) {
		const updated = requestStopSubagentBackgroundRun(rootCwd, record.runId);
		if (updated) requestedIds.push(updated.runId);
	}
	return {
		requested: requestedIds.length,
		requestedIds,
	};
}

export function pruneSubagentBackgroundRuns(
	rootCwd: string,
	olderThanHours = 24,
): PruneSubagentBackgroundRunsResult {
	const thresholdHours = Number.isFinite(olderThanHours) ? Math.max(1, Math.floor(olderThanHours)) : 24;
	const thresholdMs = thresholdHours * 60 * 60 * 1000;
	const nowMs = Date.now();
	const records = listSubagentBackgroundRuns(rootCwd, 1000);
	const removedIds: string[] = [];
	let skippedRunning = 0;
	let skippedRecent = 0;

	for (const record of records) {
		if (!isTerminalStatus(record.status)) {
			skippedRunning += 1;
			continue;
		}
		const anchor = Date.parse(record.finishedAt ?? record.createdAt);
		if (!Number.isFinite(anchor) || nowMs - anchor < thresholdMs) {
			skippedRecent += 1;
			continue;
		}
		try {
			rmSync(record.metaPath, { force: true });
			if (record.logPath && existsSync(record.logPath)) {
				rmSync(record.logPath, { force: true });
			}
			removedIds.push(record.runId);
		} catch {
			// best effort
		}
	}

	return {
		removed: removedIds.length,
		removedIds,
		skippedRunning,
		skippedRecent,
		thresholdHours,
	};
}

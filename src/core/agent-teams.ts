import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export type TeamTaskStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface TeamTaskRecord {
	id: string;
	agentIndex: number;
	profile: string;
	cwd: string;
	lockKey?: string;
	dependsOn: string[];
	status: TeamTaskStatus;
}

export interface TeamRunRecord {
	runId: string;
	createdAt: string;
	mode: "parallel" | "sequential";
	agents: number;
	maxParallel?: number;
	task: string;
	tasks: TeamTaskRecord[];
}

function getTeamsDir(cwd: string): string {
	return join(cwd, ".iosm", "subagents", "teams");
}

function getTeamRunPath(cwd: string, runId: string): string {
	return join(getTeamsDir(cwd), `${runId}.json`);
}

type PendingStatusUpdate = {
	input: {
		cwd: string;
		runId: string;
		taskId: string;
		status: TeamTaskStatus;
	};
	attempts: number;
};

const statusUpdateRetryBaseDelayMs = 25;
const statusUpdateRetryMaxDelayMs = 1_000;
const pendingStatusUpdates = new Map<string, PendingStatusUpdate>();
let pendingStatusFlushTimer: ReturnType<typeof setTimeout> | undefined;

function isTerminalStatus(status: TeamTaskStatus): boolean {
	return status === "done" || status === "error" || status === "cancelled";
}

function shouldReplacePendingStatus(current: TeamTaskStatus, next: TeamTaskStatus): boolean {
	if (current === next) return false;
	if (isTerminalStatus(current)) return false;
	if (isTerminalStatus(next)) return true;
	if (current === "running" && next === "pending") return false;
	return true;
}

function pendingStatusKey(input: { cwd: string; runId: string; taskId: string }): string {
	return `${resolve(input.cwd).toLowerCase()}::${input.runId}::${input.taskId}`;
}

function statusRetryDelayMs(attempts: number): number {
	const exponent = Math.min(6, Math.max(0, attempts));
	return Math.min(statusUpdateRetryBaseDelayMs * 2 ** exponent, statusUpdateRetryMaxDelayMs);
}

function schedulePendingStatusFlush(delayMs = statusUpdateRetryBaseDelayMs): void {
	if (pendingStatusFlushTimer) return;
	pendingStatusFlushTimer = setTimeout(() => {
		pendingStatusFlushTimer = undefined;
		flushPendingStatusUpdates();
	}, delayMs);
}

function queuePendingStatusUpdate(input: {
	cwd: string;
	runId: string;
	taskId: string;
	status: TeamTaskStatus;
}): void {
	const key = pendingStatusKey(input);
	const existing = pendingStatusUpdates.get(key);
	if (!existing) {
		pendingStatusUpdates.set(key, { input, attempts: 0 });
		schedulePendingStatusFlush();
		return;
	}
	if (shouldReplacePendingStatus(existing.input.status, input.status)) {
		pendingStatusUpdates.set(key, {
			input,
			attempts: existing.attempts,
		});
	}
	schedulePendingStatusFlush();
}

function flushPendingStatusUpdates(): void {
	if (pendingStatusUpdates.size === 0) return;
	let nextDelayMs = statusUpdateRetryMaxDelayMs;
	for (const [key, pending] of Array.from(pendingStatusUpdates.entries())) {
		const result = tryUpdateTeamTaskStatus(pending.input);
		if (result === "locked") {
			const attempts = pending.attempts + 1;
			pendingStatusUpdates.set(key, {
				input: pending.input,
				attempts,
			});
			nextDelayMs = Math.min(nextDelayMs, statusRetryDelayMs(attempts));
			continue;
		}
		pendingStatusUpdates.delete(key);
	}
	if (pendingStatusUpdates.size > 0) {
		schedulePendingStatusFlush(nextDelayMs);
	}
}

export function createTeamRun(input: {
	cwd: string;
	mode: "parallel" | "sequential";
	agents: number;
	maxParallel?: number;
	task: string;
	assignments: Array<{ profile: string; cwd: string; lockKey?: string; dependsOn: number[] }>;
}): TeamRunRecord {
	const runId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const tasks: TeamTaskRecord[] = input.assignments.map((assignment, index) => {
		const id = `task_${index + 1}`;
		const dependsOn = assignment.dependsOn.map((dep) => `task_${dep}`);
		return {
			id,
			agentIndex: index + 1,
			profile: assignment.profile,
			cwd: assignment.cwd,
			lockKey: assignment.lockKey,
			dependsOn,
			status: "pending",
		};
	});
	const record: TeamRunRecord = {
		runId,
		createdAt: new Date().toISOString(),
		mode: input.mode,
		agents: input.agents,
		maxParallel: input.maxParallel,
		task: input.task,
		tasks,
	};
	mkdirSync(getTeamsDir(input.cwd), { recursive: true });
	writeFileSync(getTeamRunPath(input.cwd, runId), JSON.stringify(record, null, 2), "utf8");
	return record;
}

export function getTeamRun(cwd: string, runId: string): TeamRunRecord | undefined {
	const path = getTeamRunPath(cwd, runId);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TeamRunRecord;
	} catch {
		return undefined;
	}
}

export function listTeamRuns(cwd: string, limit = 20): TeamRunRecord[] {
	const dir = getTeamsDir(cwd);
	if (!existsSync(dir)) return [];
	const names = readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith(".json"))
		.sort()
		.reverse()
		.slice(0, Math.max(1, limit));
	const runs: TeamRunRecord[] = [];
	for (const name of names) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as TeamRunRecord;
			runs.push(parsed);
		} catch {
			// ignore malformed files
		}
	}
	return runs;
}

function tryUpdateTeamTaskStatus(input: {
	cwd: string;
	runId: string;
	taskId: string;
	status: TeamTaskStatus;
}): TeamRunRecord | "locked" | undefined {
	const runPath = getTeamRunPath(input.cwd, input.runId);
	if (!existsSync(runPath)) return undefined;
	let release: (() => void) | undefined;
	try {
		mkdirSync(getTeamsDir(input.cwd), { recursive: true });
		try {
			release = lockfile.lockSync(runPath, { realpath: false });
		} catch (error) {
			const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
			if (code === "ELOCKED") return "locked";
			return undefined;
		}
		if (!release) return undefined;
		const raw = readFileSync(runPath, "utf8");
		const existing = JSON.parse(raw) as TeamRunRecord;
		const nextTasks = existing.tasks.map((task) => (task.id === input.taskId ? { ...task, status: input.status } : task));
		if (!nextTasks.some((task) => task.id === input.taskId)) {
			return undefined;
		}

		const next: TeamRunRecord = {
			...existing,
			tasks: nextTasks,
		};
		writeFileSync(runPath, JSON.stringify(next, null, 2), "utf8");
		return next;
	} catch {
		return undefined;
	} finally {
		release?.();
	}
}

export function updateTeamTaskStatus(input: {
	cwd: string;
	runId: string;
	taskId: string;
	status: TeamTaskStatus;
}): TeamRunRecord | undefined {
	const result = tryUpdateTeamTaskStatus(input);
	if (result === "locked") {
		// Non-blocking reliability path: queue status update for retry instead of dropping lifecycle transitions.
		queuePendingStatusUpdate(input);
		return undefined;
	}
	const key = pendingStatusKey(input);
	if (pendingStatusUpdates.has(key) && result) {
		pendingStatusUpdates.delete(key);
	}
	return result;
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type CheckpointBackend = "shadow-git" | "archive";

export interface FsCheckpointMetadata {
	checkpointId: string;
	checkpointName: string;
	createdAt: string;
	backend: CheckpointBackend;
	rootDir: string;
	snapshotDir: string;
	filesDir: string;
	files: string[];
}

const CHECKPOINT_ROOT_SEGMENTS = [".iosm", "checkpoints", "files"] as const;
const DEFAULT_RETENTION = 20;

function getCheckpointRoot(cwd: string): string {
	return join(cwd, ...CHECKPOINT_ROOT_SEGMENTS);
}

function safeId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

function parseGitTrackedAndUntrackedFiles(cwd: string): string[] {
	const result = spawnSync("git", ["-C", cwd, "ls-files", "-co", "--exclude-standard", "-z"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		throw new Error(`git ls-files failed: ${(result.stderr ?? "").toString().trim() || "unknown error"}`);
	}
	const raw = result.stdout ?? "";
	if (typeof raw !== "string" || raw.length === 0) return [];
	return raw
		.split("\0")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.filter((entry) => !entry.startsWith(".iosm/checkpoints/"));
}

async function walkAllFiles(cwd: string, dir: string = cwd, collector: string[] = []): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git") continue;
		if (entry.name === ".iosm" && resolve(dir, entry.name) === resolve(cwd, ".iosm")) {
			const checkpointsDir = resolve(cwd, ".iosm", "checkpoints");
			if (checkpointsDir.startsWith(resolve(dir, entry.name))) {
				// Continue traversing .iosm, but skip .iosm/checkpoints subtree.
			}
		}
		const full = join(dir, entry.name);
		const rel = relative(cwd, full).replace(/\\/g, "/");
		if (rel.startsWith(".iosm/checkpoints/")) continue;
		if (entry.isDirectory()) {
			await walkAllFiles(cwd, full, collector);
			continue;
		}
		if (entry.isFile()) {
			collector.push(rel);
		}
	}
	return collector;
}

function detectBackend(cwd: string): CheckpointBackend {
	const probe = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (probe.status === 0 && `${probe.stdout}`.trim() === "true") {
		return "shadow-git";
	}
	return "archive";
}

async function copySnapshotFiles(cwd: string, filesDir: string, files: string[]): Promise<void> {
	for (const rel of files) {
		const source = resolve(cwd, rel);
		if (!existsSync(source)) continue;
		const target = resolve(filesDir, rel);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
}

function listCheckpointMetadata(cwd: string): FsCheckpointMetadata[] {
	const root = getCheckpointRoot(cwd);
	if (!existsSync(root)) return [];
	const metadata: FsCheckpointMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const snapshotDir = join(root, entry.name);
		const metadataPath = join(snapshotDir, "metadata.json");
		if (!existsSync(metadataPath)) continue;
		try {
			const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as FsCheckpointMetadata;
			if (!parsed || typeof parsed !== "object") continue;
			metadata.push(parsed);
		} catch {
			continue;
		}
	}
	return metadata.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function cleanupOldSnapshots(cwd: string, retain = DEFAULT_RETENTION): void {
	const all = listCheckpointMetadata(cwd);
	if (all.length <= retain) return;
	const remove = all.slice(0, all.length - retain);
	for (const entry of remove) {
		try {
			rmSync(entry.snapshotDir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup.
		}
	}
}

export async function createFsCheckpointSnapshot(
	cwd: string,
	checkpointName: string,
	checkpointId: string,
): Promise<FsCheckpointMetadata> {
	const root = getCheckpointRoot(cwd);
	ensureDir(root);

	const backend = detectBackend(cwd);
	const now = new Date().toISOString();
	const snapshotId = `${safeId(checkpointName || "checkpoint")}-${Date.now()}-${safeId(checkpointId).slice(0, 16)}`;
	const snapshotDir = join(root, snapshotId);
	const filesDir = join(snapshotDir, "files");
	ensureDir(filesDir);

	const files =
		backend === "shadow-git"
			? parseGitTrackedAndUntrackedFiles(cwd)
			: await walkAllFiles(cwd);
	await copySnapshotFiles(cwd, filesDir, files);

	const metadata: FsCheckpointMetadata = {
		checkpointId,
		checkpointName,
		createdAt: now,
		backend,
		rootDir: cwd,
		snapshotDir,
		filesDir,
		files,
	};
	writeFileSync(join(snapshotDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	cleanupOldSnapshots(cwd, DEFAULT_RETENTION);
	return metadata;
}

function getCurrentFileList(cwd: string, backend: CheckpointBackend): string[] {
	if (backend === "shadow-git") {
		try {
			return parseGitTrackedAndUntrackedFiles(cwd);
		} catch {
			// fall through
		}
	}

	const all: string[] = [];
	const stack = [cwd];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(dir, entry.name);
			const rel = relative(cwd, full).replace(/\\/g, "/");
			if (rel.startsWith(".git/")) continue;
			if (rel.startsWith(".iosm/checkpoints/")) continue;
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile()) {
				all.push(rel);
			}
		}
	}
	return all;
}

export async function restoreFsCheckpointSnapshot(cwd: string, metadata: FsCheckpointMetadata): Promise<void> {
	const snapshotMetadataPath = join(metadata.snapshotDir, "metadata.json");
	if (!existsSync(snapshotMetadataPath)) {
		throw new Error(`Checkpoint snapshot metadata not found: ${snapshotMetadataPath}`);
	}
	const fileSet = new Set(metadata.files);
	const currentFiles = getCurrentFileList(cwd, metadata.backend);

	for (const rel of currentFiles) {
		if (fileSet.has(rel)) continue;
		const path = resolve(cwd, rel);
		if (existsSync(path)) {
			try {
				unlinkSync(path);
			} catch {
				// best effort cleanup before restore
			}
		}
	}

	for (const rel of metadata.files) {
		const source = resolve(metadata.filesDir, rel);
		if (!existsSync(source)) continue;
		const target = resolve(cwd, rel);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(source, target);
	}
}

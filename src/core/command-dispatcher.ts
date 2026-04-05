import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "./agent-session.js";
import { getShareViewerUrl } from "../config.js";
import { createFsCheckpointSnapshot, restoreFsCheckpointSnapshot, type FsCheckpointMetadata } from "./checkpoint/fs-checkpoint.js";
import { getChangelogPath, parseChangelog } from "../utils/changelog.js";
import type { PolicyEngineV2 } from "./policy/index.js";
import type { SettingsManager } from "./settings-manager.js";
import type { SessionEntry, SessionTreeNode } from "./session-manager.js";

export interface BuiltinCommandContext {
	session: AgentSession;
	settingsManager: SettingsManager;
	policyEngine?: PolicyEngineV2;
}

export interface BuiltinCommandResult {
	handled: boolean;
	level?: "status" | "warning" | "error";
	message?: string;
	text?: string;
	filePath?: string;
}

const CHECKPOINT_LABEL_PREFIX = "checkpoint:";

export function parseSlashArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escape = false;

	for (const ch of input.trim()) {
		if (escape) {
			current += ch;
			escape = false;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (escape) {
		current += "\\";
	}
	if (current) {
		args.push(current);
	}

	return args;
}

function formatPermissionStatus(settingsManager: SettingsManager, policyEngine?: PolicyEngineV2): string {
	const mode = settingsManager.getPermissionMode();
	const allowRules = policyEngine?.getLegacyRules("allow") ?? settingsManager.getPermissionAllowRules();
	const denyRules = policyEngine?.getLegacyRules("deny") ?? settingsManager.getPermissionDenyRules();
	return `Permissions: ${mode}${allowRules.length > 0 ? ` · allow rules: ${allowRules.length}` : ""}${denyRules.length > 0 ? ` · deny rules: ${denyRules.length}` : ""}`;
}

function buildSessionStatsText(session: AgentSession): string {
	const stats = session.getSessionStats();
	let info = "Session Info\n\n";
	info += `File: ${stats.sessionFile ?? "(ephemeral)"}\n`;
	info += `ID: ${stats.sessionId}\n\n`;
	info += "Messages\n";
	info += `User: ${stats.userMessages}\n`;
	info += `Assistant: ${stats.assistantMessages}\n`;
	info += `Tool Calls: ${stats.toolCalls}\n`;
	info += `Tool Results: ${stats.toolResults}\n`;
	info += `Total: ${stats.totalMessages}\n\n`;
	info += "Tokens\n";
	info += `Input: ${stats.tokens.input.toLocaleString()}\n`;
	info += `Output: ${stats.tokens.output.toLocaleString()}\n`;
	if (stats.tokens.cacheRead > 0) {
		info += `Cache Read: ${stats.tokens.cacheRead.toLocaleString()}\n`;
	}
	if (stats.tokens.cacheWrite > 0) {
		info += `Cache Write: ${stats.tokens.cacheWrite.toLocaleString()}\n`;
	}
	info += `Total: ${stats.tokens.total.toLocaleString()}\n`;
	if (stats.cost > 0) {
		info += `\nCost\nTotal: ${stats.cost.toFixed(4)}\n`;
	}
	return info.trimEnd();
}

function normalizePermissionRule(rule: string): string | undefined {
	const normalized = rule.trim();
	if (!normalized || !normalized.includes(":")) return undefined;
	return normalized;
}

function extractEntryText(entry: SessionEntry): string {
	if (entry.type === "message") {
		const message = entry.message as { content?: unknown; role?: string; command?: string };
		if (typeof message.command === "string" && message.command.trim().length > 0) {
			return message.command.replace(/\s+/g, " ").trim();
		}
		if (!("content" in message)) {
			return "";
		}
		const content = message.content;
		if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
		if (Array.isArray(content)) {
			return content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
		}
	}
	if (entry.type === "branch_summary" || entry.type === "compaction") {
		return entry.summary.replace(/\s+/g, " ").trim();
	}
	if (entry.type === "label") {
		return entry.label?.trim() ?? "";
	}
	if (entry.type === "session_info") {
		return entry.name?.trim() ?? "";
	}
	if (entry.type === "model_change") {
		return `${entry.provider}/${entry.modelId}`;
	}
	if (entry.type === "thinking_level_change") {
		return entry.thinkingLevel;
	}
	return "";
}

function summarizeEntry(entry: SessionEntry): string {
	const text = extractEntryText(entry);
	if (!text) return "";
	const max = 72;
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function flattenTree(nodes: SessionTreeNode[], depth = 0, lines: string[] = [], currentLeafId: string | null = null): string[] {
	for (const node of nodes) {
		const marker = node.entry.id === currentLeafId ? "*" : " ";
		const indent = "  ".repeat(depth);
		const label = node.label ? ` [${node.label}]` : "";
		const summary = summarizeEntry(node.entry);
		lines.push(
			`${marker} ${indent}${node.entry.id} (${node.entry.type}${label})${summary ? ` - ${summary}` : ""}`,
		);
		flattenTree(node.children, depth + 1, lines, currentLeafId);
	}
	return lines;
}

function buildTreeText(session: AgentSession): string {
	const tree = session.sessionManager.getTree();
	if (tree.length === 0) {
		return "No entries in session.";
	}
	const currentLeafId = session.sessionManager.getLeafId();
	const lines = flattenTree(tree, 0, [], currentLeafId);
	lines.push("");
	lines.push(currentLeafId ? `Current leaf: ${currentLeafId}` : "Current leaf: (root)");
	lines.push("Usage: /tree [list|<entry-id>|goto <entry-id>]");
	return lines.join("\n");
}

interface SessionCheckpoint {
	name: string;
	targetId: string;
	labelEntryId: string;
	timestamp: string;
}

interface CheckpointSnapshotIndex {
	snapshots: Record<string, FsCheckpointMetadata>;
}

function getCheckpointIndexPath(cwd: string): string {
	return join(cwd, ".iosm", "checkpoints", "index.json");
}

function readCheckpointSnapshotIndex(cwd: string): CheckpointSnapshotIndex {
	const path = getCheckpointIndexPath(cwd);
	if (!existsSync(path)) {
		return { snapshots: {} };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<CheckpointSnapshotIndex>;
		const snapshots = parsed.snapshots && typeof parsed.snapshots === "object" ? parsed.snapshots : {};
		return { snapshots: snapshots as Record<string, FsCheckpointMetadata> };
	} catch {
		return { snapshots: {} };
	}
}

function writeCheckpointSnapshotIndex(cwd: string, index: CheckpointSnapshotIndex): void {
	const path = getCheckpointIndexPath(cwd);
	const dir = join(cwd, ".iosm", "checkpoints");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function parseCheckpointNameFromLabel(label: string | undefined): string | undefined {
	if (!label) return undefined;
	if (!label.startsWith(CHECKPOINT_LABEL_PREFIX)) return undefined;
	const name = label.slice(CHECKPOINT_LABEL_PREFIX.length).trim();
	return name.length > 0 ? name : undefined;
}

function buildCheckpointLabel(name: string): string {
	return `${CHECKPOINT_LABEL_PREFIX}${name}`;
}

function normalizeCheckpointName(raw: string): string | undefined {
	const normalized = raw.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	if (normalized.length > 80) return undefined;
	return normalized;
}

function getSessionCheckpoints(session: AgentSession): SessionCheckpoint[] {
	const active = new Map<string, SessionCheckpoint>();
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "label") continue;
		const name = parseCheckpointNameFromLabel(entry.label);
		if (!name) {
			active.delete(entry.targetId);
			continue;
		}
		active.set(entry.targetId, {
			name,
			targetId: entry.targetId,
			labelEntryId: entry.id,
			timestamp: entry.timestamp,
		});
	}
	return [...active.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function buildDefaultCheckpointName(checkpoints: SessionCheckpoint[]): string {
	const used = new Set(checkpoints.map((checkpoint) => checkpoint.name.toLowerCase()));
	let index = 1;
	while (used.has(`cp-${index}`)) {
		index += 1;
	}
	return `cp-${index}`;
}

function formatCheckpointList(session: AgentSession, checkpoints: SessionCheckpoint[]): string {
	if (checkpoints.length === 0) {
		return "No checkpoints yet.\nCreate one with: /checkpoint [name]";
	}
	const newestFirst = [...checkpoints].reverse();
	const lines = newestFirst.map((checkpoint, index) => {
		const target = session.sessionManager.getEntry(checkpoint.targetId);
		const type = target?.type ?? "missing";
		return `${index + 1}. ${checkpoint.name} -> ${checkpoint.targetId} (${type}) @ ${checkpoint.timestamp}`;
	});
	lines.push("");
	lines.push("Usage: /rollback [name|index]");
	return lines.join("\n");
}

async function runCommandCapture(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code, stdout, stderr });
		});
	});
}

export async function dispatchBuiltinSlashCommand(
	text: string,
	context: BuiltinCommandContext,
): Promise<BuiltinCommandResult> {
	if (!text.startsWith("/")) {
		return { handled: false };
	}
	const args = parseSlashArgs(text);
	const commandToken = args[0]?.toLowerCase();
	if (!commandToken?.startsWith("/")) {
		return { handled: false };
	}
	const command = commandToken.slice(1);
	const rest = args.slice(1);
	const { session, settingsManager, policyEngine } = context;
	policyEngine?.refresh();

	if (command === "help") {
		return {
			handled: true,
			level: "status",
			text: [
				"Core commands:",
				"/status /abort /yolo /permissions /model /new /resume /session /name /copy /export /fork",
				"/compact /reload /tree /checkpoint /rollback /changelog /share /logout",
			].join("\n"),
		};
	}

	if (command === "yolo") {
		const value = rest[0]?.toLowerCase();
		if (!value) {
			const nextMode = settingsManager.getPermissionMode() === "yolo" ? "ask" : "yolo";
			settingsManager.setPermissionMode(nextMode);
			return { handled: true, level: "status", message: `YOLO mode: ${nextMode === "yolo" ? "ON" : "OFF"}` };
		}
		if (value === "status") {
			return {
				handled: true,
				level: "status",
				message: `YOLO mode: ${settingsManager.getPermissionMode() === "yolo" ? "ON" : "OFF"}`,
			};
		}
		if (value === "on") {
			settingsManager.setPermissionMode("yolo");
			return { handled: true, level: "status", message: "YOLO mode: ON (tool confirmations disabled)" };
		}
		if (value === "off") {
			settingsManager.setPermissionMode("ask");
			return { handled: true, level: "status", message: "YOLO mode: OFF (tool confirmations enabled)" };
		}
		return { handled: true, level: "warning", message: "Usage: /yolo [on|off|status]" };
	}

	if (command === "permissions") {
		const value = rest[0]?.toLowerCase();
		if (!value || value === "status") {
			return { handled: true, level: "status", message: formatPermissionStatus(settingsManager, policyEngine) };
		}
		if (value === "ask" || value === "auto" || value === "yolo") {
			settingsManager.setPermissionMode(value);
			return { handled: true, level: "status", message: `Permissions: ${value}` };
		}
		if (value === "allow" || value === "deny") {
			const action = rest[1]?.toLowerCase();
			const isAllow = value === "allow";
			let rules = isAllow
				? (policyEngine?.getLegacyRules("allow") ?? settingsManager.getPermissionAllowRules())
				: (policyEngine?.getLegacyRules("deny") ?? settingsManager.getPermissionDenyRules());

			if (action === "list") {
				if (rules.length === 0) {
					return { handled: true, level: "status", message: `Permissions ${value} rules: (empty)` };
				}
				return {
					handled: true,
					level: "status",
					text: rules.map((rule) => `- ${rule}`).join("\n"),
				};
			}

			if (action === "add") {
				const rawRule = rest.slice(2).join(" ");
				const normalizedRule = normalizePermissionRule(rawRule);
				if (!normalizedRule) {
					return { handled: true, level: "warning", message: `Usage: /permissions ${value} add <tool:match>` };
				}
				if (!rules.includes(normalizedRule)) {
					rules = [...rules, normalizedRule];
					if (policyEngine) {
						policyEngine.setLegacyRules(isAllow ? "allow" : "deny", rules);
						policyEngine.refresh();
					} else if (isAllow) {
						settingsManager.setPermissionAllowRules(rules);
					} else {
						settingsManager.setPermissionDenyRules(rules);
					}
				}
				return { handled: true, level: "status", message: `Added ${value} rule: ${normalizedRule}` };
			}

			if (action === "remove") {
				const rawRule = rest.slice(2).join(" ").trim();
				if (!rawRule) {
					return {
						handled: true,
						level: "warning",
						message: `Usage: /permissions ${value} remove <tool:match>`,
					};
				}
				rules = rules.filter((rule) => rule !== rawRule);
				if (policyEngine) {
					policyEngine.setLegacyRules(isAllow ? "allow" : "deny", rules);
					policyEngine.refresh();
				} else if (isAllow) {
					settingsManager.setPermissionAllowRules(rules);
				} else {
					settingsManager.setPermissionDenyRules(rules);
				}
				return { handled: true, level: "status", message: `Removed ${value} rule: ${rawRule}` };
			}

			return { handled: true, level: "warning", message: `Usage: /permissions ${value} [list|add|remove]` };
		}
		return {
			handled: true,
			level: "warning",
			message: "Usage: /permissions [ask|auto|yolo|status|allow|deny]",
		};
	}

	if (command === "abort") {
		await session.abort();
		return { handled: true, level: "status", message: "Abort signal sent." };
	}

	if (command === "compact") {
		const customInstructions = rest.join(" ").trim() || undefined;
		try {
			const result = await session.compact(customInstructions);
			return {
				handled: true,
				level: "status",
				message: `Compaction complete. First kept: ${result.firstKeptEntryId}. Tokens before: ${result.tokensBefore}.`,
				text: result.summary,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				handled: true,
				level: "warning",
				message: `Compaction failed: ${message}`,
			};
		}
	}

	if (command === "status") {
		const model = session.model ? `${session.model.provider}/${session.model.id}` : "not selected";
		const sessionLabel = session.sessionName || session.sessionId || "(unknown)";
		const lines = [
			`Model: ${model}`,
			`Session: ${sessionLabel}`,
			`Streaming: ${session.isStreaming ? "yes" : "no"}`,
			`Compacting: ${session.isCompacting ? "yes" : "no"}`,
			`Queued messages: ${session.pendingMessageCount}`,
			formatPermissionStatus(settingsManager, policyEngine),
		];
		return { handled: true, level: "status", text: lines.join("\n") };
	}

	if (command === "new" || command === "clear") {
		const cancelled = !(await session.newSession());
		return {
			handled: true,
			level: "status",
			message: cancelled ? "New session cancelled." : "Started new session.",
		};
	}

	if (command === "reload") {
		if (session.isStreaming) {
			return { handled: true, level: "warning", message: "Wait for the current response to finish before reloading." };
		}
		if (session.isCompacting) {
			return { handled: true, level: "warning", message: "Wait for compaction to finish before reloading." };
		}
		await session.reload();
		return { handled: true, level: "status", message: "Reloaded extensions, skills, prompts, and themes." };
	}

	if (command === "session") {
		return { handled: true, level: "status", text: buildSessionStatsText(session) };
	}

	if (command === "name") {
		const name = rest.join(" ").trim();
		if (!name) {
			return { handled: true, level: "warning", message: "Usage: /name <session-name>" };
		}
		session.setSessionName(name);
		return { handled: true, level: "status", message: `Session name set: ${name}` };
	}

	if (command === "copy") {
		const textResult = session.getLastAssistantText();
		if (!textResult) {
			return { handled: true, level: "warning", message: "No agent messages to copy yet." };
		}
		return { handled: true, level: "status", text: textResult };
	}

	if (command === "export") {
		const outputPath = rest.length > 0 ? rest.join(" ") : undefined;
		const path = await session.exportToHtml(outputPath);
		return { handled: true, level: "status", message: `Session exported to: ${path}`, filePath: path };
	}

	if (command === "model") {
		const value = rest.join(" ").trim();
		if (!value) {
			const current = session.model;
			if (!current) {
				return { handled: true, level: "warning", message: "No model selected. Usage: /model <provider/model-id>" };
			}
			return {
				handled: true,
				level: "status",
				message: `Current model: ${current.provider}/${current.id}`,
			};
		}
		if (value.toLowerCase() === "cycle") {
			const next = await session.cycleModel();
			if (!next) {
				return { handled: true, level: "warning", message: "No next model available to cycle." };
			}
			return {
				handled: true,
				level: "status",
				message: `Model set: ${next.model.provider}/${next.model.id} (thinking: ${next.thinkingLevel})`,
			};
		}

		const allModels = await session.modelRegistry.getAvailable();
		let selected =
			allModels.find((model) => `${model.provider}/${model.id}`.toLowerCase() === value.toLowerCase()) ??
			allModels.find((model) => model.id.toLowerCase() === value.toLowerCase());

		if (!selected) {
			const asProviderModel = value.split("/");
			if (asProviderModel.length === 2) {
				const provider = asProviderModel[0]?.trim().toLowerCase();
				const modelId = asProviderModel[1]?.trim().toLowerCase();
				selected = allModels.find(
					(model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId,
				);
			}
		}

		if (!selected) {
			return {
				handled: true,
				level: "warning",
				message: `Model not found: ${value}. Use /model <provider/model-id>.`,
			};
		}

		await session.setModel(selected);
		return { handled: true, level: "status", message: `Model set: ${selected.provider}/${selected.id}` };
	}

	if (command === "tree") {
		const action = rest[0]?.toLowerCase();
		if (!action || action === "list" || action === "ls") {
			return { handled: true, level: "status", text: buildTreeText(session) };
		}
		if (action === "help" || action === "-h" || action === "--help") {
			return {
				handled: true,
				level: "status",
				text: "Usage:\n  /tree\n  /tree <entry-id>\n  /tree goto <entry-id>\n  /tree list",
			};
		}

		const targetId = action === "goto" ? rest.slice(1).join(" ").trim() : rest.join(" ").trim();
		if (!targetId) {
			return { handled: true, level: "warning", message: "Usage: /tree [list|<entry-id>|goto <entry-id>]" };
		}

		try {
			const result = await session.navigateTree(targetId, { summarize: false });
			if (result.aborted || result.cancelled) {
				return { handled: true, level: "warning", message: "Tree navigation cancelled." };
			}
			return {
				handled: true,
				level: "status",
				message: `Navigated to: ${targetId}`,
				text: result.editorText,
			};
		} catch (error) {
			return {
				handled: true,
				level: "error",
				message: `Tree navigation failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	if (command === "checkpoint") {
		const subcommand = rest[0]?.toLowerCase();
		const checkpoints = getSessionCheckpoints(session);
		if (subcommand === "list" || subcommand === "ls") {
			return { handled: true, level: "status", text: formatCheckpointList(session, checkpoints) };
		}
		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			return {
				handled: true,
				level: "status",
				text: "Usage:\n  /checkpoint [name]\n  /checkpoint list",
			};
		}

		const leafId = session.sessionManager.getLeafId();
		if (!leafId) {
			return { handled: true, level: "warning", message: "Cannot create checkpoint yet (session has no entries)." };
		}

		const requestedName = rest.join(" ");
		const name = requestedName ? normalizeCheckpointName(requestedName) : buildDefaultCheckpointName(checkpoints);
		if (!name) {
			return { handled: true, level: "warning", message: "Invalid checkpoint name. Use 1-80 visible characters." };
		}

		const labelEntryId = session.sessionManager.appendLabelChange(leafId, buildCheckpointLabel(name));
		try {
			const cwd = typeof session.sessionManager.getCwd === "function" ? session.sessionManager.getCwd() : process.cwd();
			const snapshot = await createFsCheckpointSnapshot(cwd, name, labelEntryId);
			const index = readCheckpointSnapshotIndex(cwd);
			index.snapshots[labelEntryId] = snapshot;
			writeCheckpointSnapshotIndex(cwd, index);
			return {
				handled: true,
				level: "status",
				message: `Checkpoint saved: ${name} (${leafId})`,
				text: `Filesystem snapshot: ${snapshot.backend} @ ${snapshot.snapshotDir}`,
			};
		} catch (error) {
			return {
				handled: true,
				level: "warning",
				message: `Checkpoint label saved, but filesystem snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	if (command === "rollback") {
		const subcommand = rest[0]?.toLowerCase();
		const checkpoints = getSessionCheckpoints(session);
		if (subcommand === "list" || subcommand === "ls") {
			return { handled: true, level: "status", text: formatCheckpointList(session, checkpoints) };
		}
		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			return {
				handled: true,
				level: "status",
				text: "Usage:\n  /rollback\n  /rollback <name>\n  /rollback <index>\n  /rollback list",
			};
		}
		if (checkpoints.length === 0) {
			return { handled: true, level: "warning", message: "No checkpoints available. Create one with /checkpoint." };
		}

		const newestFirst = [...checkpoints].reverse();
		const selector = rest.join(" ").trim();
		let target: SessionCheckpoint | undefined = newestFirst[0];
		if (selector) {
			const numeric = Number.parseInt(selector, 10);
			if (Number.isFinite(numeric) && `${numeric}` === selector) {
				target = newestFirst[numeric - 1];
				if (!target) {
					return { handled: true, level: "warning", message: `Checkpoint index ${numeric} is out of range.` };
				}
			} else {
				target = newestFirst.find((checkpoint) => checkpoint.name === selector);
				if (!target) {
					return { handled: true, level: "warning", message: `Checkpoint "${selector}" not found.` };
				}
			}
		}
		if (!target) {
			return { handled: true, level: "warning", message: "No rollback target selected." };
		}

		try {
			const cwd = typeof session.sessionManager.getCwd === "function" ? session.sessionManager.getCwd() : process.cwd();
			const checkpointIndex = readCheckpointSnapshotIndex(cwd);
			const snapshot = checkpointIndex.snapshots[target.labelEntryId];
			if (snapshot) {
				await restoreFsCheckpointSnapshot(cwd, snapshot);
			}
			const result = await session.navigateTree(target.targetId, { summarize: false });
			if (result.cancelled || result.aborted) {
				return { handled: true, level: "warning", message: "Rollback cancelled." };
			}
			return {
				handled: true,
				level: "status",
				message: `Rolled back to checkpoint: ${target.name}`,
				text: snapshot
					? `${result.editorText}\n\nFilesystem restored from ${snapshot.backend} snapshot.`
					: result.editorText,
			};
		} catch (error) {
			return {
				handled: true,
				level: "error",
				message: `Rollback failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	if (command === "changelog") {
		const entries = parseChangelog(getChangelogPath());
		const changelogText =
			entries.length > 0 ? entries.slice().reverse().map((entry) => entry.content).join("\n\n") : "No changelog entries found.";
		return {
			handled: true,
			level: "status",
			text: changelogText,
		};
	}

	if (command === "share") {
		const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
		if (authResult.status !== 0) {
			return {
				handled: true,
				level: "warning",
				message: "GitHub CLI is not logged in. Run `gh auth login` first.",
			};
		}

		const tmpFile = join(tmpdir(), `iosm-session-${Date.now()}.html`);
		try {
			await session.exportToHtml(tmpFile);
			const result = await runCommandCapture("gh", ["gist", "create", "--public=false", tmpFile]);
			if (result.code !== 0) {
				return {
					handled: true,
					level: "error",
					message: `Failed to create gist: ${result.stderr.trim() || "Unknown error"}`,
				};
			}
			const gistUrl = result.stdout.trim();
			const gistId = gistUrl.split("/").pop();
			if (!gistId) {
				return { handled: true, level: "error", message: "Failed to parse gist ID from gh output." };
			}
			return {
				handled: true,
				level: "status",
				text: `Share URL: ${getShareViewerUrl(gistId)}\nGist: ${gistUrl}`,
			};
		} finally {
			if (existsSync(tmpFile)) {
				rmSync(tmpFile, { force: true });
			}
		}
	}

	if (command === "auth" || command === "login") {
		return {
			handled: true,
			level: "warning",
			message: "Interactive /login flow is not available in Telegram bridge yet. Use local CLI /login, then continue remotely.",
		};
	}

	if (command === "logout") {
		const provider = rest.join(" ").trim() || session.model?.provider;
		if (!provider) {
			return { handled: true, level: "warning", message: "Usage: /logout <provider> (or select a model first)" };
		}
		session.modelRegistry.authStorage.logout(provider);
		return { handled: true, level: "status", message: `Logged out provider: ${provider}` };
	}

	if (command === "resume") {
		const sessionPath = rest.join(" ").trim();
		if (!sessionPath) {
			return { handled: true, level: "warning", message: "Usage: /resume <session-path>" };
		}
		const cancelled = !(await session.switchSession(sessionPath));
		return {
			handled: true,
			level: "status",
			message: cancelled ? "Session switch cancelled." : `Switched session: ${sessionPath}`,
		};
	}

	if (command === "fork") {
		const entryId = rest.join(" ").trim();
		if (!entryId) {
			return { handled: true, level: "warning", message: "Usage: /fork <entry-id>" };
		}
		const result = await session.fork(entryId);
		return {
			handled: true,
			level: result.cancelled ? "warning" : "status",
			message: result.cancelled ? "Fork cancelled." : `Forked from message: ${entryId}`,
			text: result.selectedText,
		};
	}

	return { handled: false };
}

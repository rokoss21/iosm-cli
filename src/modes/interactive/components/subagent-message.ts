import { homedir } from "node:os";
import { Box, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

const MESSAGE_BOX_PADDING_X = 2;
const MESSAGE_BOX_PADDING_Y = 1;

export type SubagentPhaseState = "queued" | "starting" | "running" | "responding";
export type SubagentDelegateStatus = "pending" | "running" | "done" | "failed";

export interface SubagentDelegateItem {
	index: number;
	description: string;
	profile: string;
	status: SubagentDelegateStatus;
}

export interface SubagentInfo {
	/** Human-readable description of the subagent's task, e.g. "Exploring TypeScript files" */
	description: string;
	/** Profile name, e.g. "explore" | "plan" | "fix" */
	profile: string;
	/** Current lifecycle state of the subagent */
	status: "running" | "done" | "error";
	/** Byte length of the subagent's output, populated when status is "done" */
	outputLength?: number;
	/** Wall-clock elapsed time in milliseconds, populated when status is "done" */
	durationMs?: number;
	/** Error message, populated when status is "error" */
	errorMessage?: string;
	/** Current phase summary for in-progress work */
	phase?: string;
	/** Current phase state in the execution timeline */
	phaseState?: SubagentPhaseState;
	/** Effective working directory for the subagent */
	cwd?: string;
	/** Optional custom agent label */
	agent?: string;
	/** Optional lock domain key */
	lockKey?: string;
	/** Isolation mode for this run */
	isolation?: "none" | "worktree";
	/** Current active subagent tool (e.g. read, bash, write) */
	activeTool?: string;
	/** Number of subagent tool calls started */
	toolCallsStarted?: number;
	/** Number of subagent tool calls completed */
	toolCallsCompleted?: number;
	/** Number of assistant messages produced inside subagent */
	assistantMessages?: number;
	/** Queue delay before execution started (ms) */
	waitMs?: number;
	/** Number of delegated child subtasks launched by this subagent */
	delegatedTasks?: number;
	/** Number of delegated child subtasks finished successfully */
	delegatedSucceeded?: number;
	/** Number of delegated child subtasks that failed */
	delegatedFailed?: number;
	/** Currently active delegated subtask index (1-based) */
	delegateIndex?: number;
	/** Total delegated subtasks in the current batch */
	delegateTotal?: number;
	/** Currently active delegated subtask description */
	delegateDescription?: string;
	/** Currently active delegated subtask profile */
	delegateProfile?: string;
	/** Delegate task mini-list with per-item status */
	delegateItems?: SubagentDelegateItem[];
}

type DelegateSummary = {
	total: number;
	done: number;
	failed: number;
	running: number;
	pending: number;
};

/**
 * Format a byte count as a compact human-readable string.
 * Mirrors the formatting conventions used elsewhere in the footer (k/M suffixes).
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format a millisecond duration as a compact human-readable string.
 * Keeps the unit explicit so users can immediately scan the value at a glance.
 */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = ((ms % 60_000) / 1000).toFixed(0);
	return `${minutes}m ${seconds}s`;
}

function formatElapsedClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad2 = (value: number): string => value.toString().padStart(2, "0");
	if (hours > 0) {
		return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
	}
	return `${pad2(minutes)}:${pad2(seconds)}`;
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatToolProgress(started?: number, completed?: number): string | undefined {
	if (typeof started !== "number" || started < 0) return undefined;
	if (typeof completed === "number" && completed >= 0) {
		return `tools ${completed}/${started}`;
	}
	return `tools ${started}`;
}

function formatSubagentBadge(agent?: string): string {
	if (typeof agent !== "string") return "[subagent]";
	const normalized = agent.trim();
	if (!normalized) return "[subagent]";
	return `[subagent:${normalized}]`;
}

function renderRunningStateChip(phaseState?: SubagentPhaseState): string {
	switch (phaseState) {
		case "queued":
			return theme.fg("muted", "[ ] queued");
		case "starting":
			return theme.fg("accent", "[>] starting");
		case "responding":
			return theme.fg("accent", "[>] responding");
		case "running":
		default:
			return theme.fg("accent", "[>] running");
	}
}

function summarizeDelegates(info: SubagentInfo): DelegateSummary | undefined {
	if (Array.isArray(info.delegateItems) && info.delegateItems.length > 0) {
		let done = 0;
		let failed = 0;
		let running = 0;
		let pending = 0;
		for (const item of info.delegateItems) {
			switch (item.status) {
				case "done":
					done += 1;
					break;
				case "failed":
					failed += 1;
					break;
				case "running":
					running += 1;
					break;
				default:
					pending += 1;
					break;
			}
		}
		return { total: info.delegateItems.length, done, failed, running, pending };
	}
	if (typeof info.delegatedTasks === "number" && info.delegatedTasks > 0) {
		const total = info.delegatedTasks;
		const done = typeof info.delegatedSucceeded === "number" ? Math.max(0, info.delegatedSucceeded) : 0;
		const failed = typeof info.delegatedFailed === "number" ? Math.max(0, info.delegatedFailed) : 0;
		const running = Math.max(0, total - done - failed);
		const pending = 0;
		return { total, done, failed, running, pending };
	}
	return undefined;
}

function formatDelegateSummary(summary: DelegateSummary): string {
	const parts: string[] = [`${summary.done}/${summary.total} done`];
	if (summary.failed > 0) {
		parts.push(`${summary.failed} failed`);
	}
	if (summary.running > 0) {
		parts.push(`${summary.running} running`);
	}
	if (summary.pending > 0) {
		parts.push(`${summary.pending} pending`);
	}
	return parts.join(", ");
}

function renderDelegateStatusMarker(status: SubagentDelegateStatus): string {
	switch (status) {
		case "done":
			return theme.fg("success", "[x]");
		case "running":
			return theme.fg("accent", "[>]");
		case "failed":
			return theme.fg("warning", "[!]");
		default:
			return theme.fg("muted", "[ ]");
	}
}

function renderDelegateText(item: SubagentDelegateItem): string {
	const label = `#${item.index} ${item.description} (${item.profile})`;
	const color =
		item.status === "done"
			? "muted"
			: item.status === "running"
				? "customMessageText"
				: item.status === "failed"
					? "warning"
					: "muted";
	return theme.fg(color, label);
}

function selectDelegateItemsForDisplay(items: SubagentDelegateItem[]): {
	visibleItems: SubagentDelegateItem[];
	compacted: boolean;
	hiddenDonePending: number;
	overflow: number;
} {
	return {
		visibleItems: items,
		compacted: false,
		hiddenDonePending: 0,
		overflow: 0,
	};
}

/**
 * Component that surfaces a running or completed subagent (task tool invocation).
 *
 * Visual structure
 * ----------------
 * Line 1 (header):  [subagent] <profile> · <description>
 * Line 2 (status): compact single-line state for scanning
 * running  → [>] running · <phase?> · tools · msgs · elapsed
 * done     → [x] done · <outputSize> · <duration> · tools · queue
 * error    → [!] <errorMessage>
 * Optional context line:
 *   @ <cwd> · tool <active> · iso/worktree · lock
 * Optional delegates section:
 *   delegates <done>/<total> done ...
 *   ├─ [>] #1 <desc> (<profile>)
 *   └─ [ ] #2 <desc> (<profile>)
 *
 * Theming follows the customMessage palette so the block sits visually alongside
 * other agent-injected messages (task plan, skill invocation, custom messages).
 */
export class SubagentMessageComponent extends Box {
	constructor(info: SubagentInfo) {
		super(MESSAGE_BOX_PADDING_X, MESSAGE_BOX_PADDING_Y, (text) => theme.bg("customMessageBg", text));
		this.renderContent(info);
	}

	/**
	 * Replace the rendered content with updated subagent info.
	 * Call this whenever status, outputLength, durationMs, or errorMessage changes.
	 */
	update(info: SubagentInfo): void {
		this.clear();
		this.renderContent(info);
	}

	override invalidate(): void {
		super.invalidate();
	}

	private addInlineParts(parts: string[]): void {
		if (parts.length === 0) return;
		this.addChild(new Text(parts.join(theme.fg("dim", " \u00B7 ")), 0, 0));
	}

	private renderDelegateSection(info: SubagentInfo): void {
		const summary = summarizeDelegates(info);
		if (!summary) return;

		this.addChild(new Text(theme.fg("accent", `delegates ${formatDelegateSummary(summary)}`), 0, 0));

		const activeDelegateIndex =
			typeof info.delegateIndex === "number" && info.delegateIndex > 0 ? Math.floor(info.delegateIndex) : undefined;
		const activeDelegateTotal =
			typeof info.delegateTotal === "number" && info.delegateTotal > 0 ? Math.floor(info.delegateTotal) : undefined;
		const activeDelegateDescription =
			typeof info.delegateDescription === "string" && info.delegateDescription.trim().length > 0
				? info.delegateDescription.trim()
				: undefined;
		const activeDelegateProfile =
			typeof info.delegateProfile === "string" && info.delegateProfile.trim().length > 0
				? info.delegateProfile.trim()
				: undefined;

		if (!Array.isArray(info.delegateItems) || info.delegateItems.length === 0) {
			if (activeDelegateIndex) {
				const activeParts = [
					theme.fg(
						"accent",
						`active #${activeDelegateIndex}${activeDelegateTotal ? `/${activeDelegateTotal}` : ""}`,
					),
				];
				if (activeDelegateDescription) {
					activeParts.push(theme.fg("customMessageText", activeDelegateDescription));
				}
				if (activeDelegateProfile) {
					activeParts.push(theme.fg("muted", `(${activeDelegateProfile})`));
				}
				this.addInlineParts(activeParts);
			}
			return;
		}

		const selected = selectDelegateItemsForDisplay(info.delegateItems);
		const hiddenCount = selected.hiddenDonePending + selected.overflow;
		const rowCount = selected.visibleItems.length + (hiddenCount > 0 ? 1 : 0);

		if (rowCount === 0) {
			this.addChild(new Text(theme.fg("muted", "└─ no active delegates"), 0, 0));
			return;
		}

		for (let index = 0; index < selected.visibleItems.length; index++) {
			const item = selected.visibleItems[index];
			const rowIndex = index;
			const isLastRow = rowIndex === rowCount - 1;
			const branch = theme.fg("dim", isLastRow ? "└─" : "├─");
			const marker = renderDelegateStatusMarker(item.status);
			this.addChild(new Text(`${branch} ${marker} ${renderDelegateText(item)}`, 0, 0));
		}

		if (hiddenCount > 0) {
			const branch = theme.fg("dim", "└─");
			const hiddenParts = [theme.fg("muted", `+${hiddenCount} hidden`)];
			if (selected.hiddenDonePending > 0) {
				hiddenParts.push(theme.fg("muted", `${selected.hiddenDonePending} done/pending`));
			}
			if (selected.overflow > 0) {
				hiddenParts.push(theme.fg("muted", `${selected.overflow} active overflow`));
			}
			this.addChild(new Text(`${branch} ${hiddenParts.join(theme.fg("dim", ", "))}`, 0, 0));
		}
	}

	private renderContent(info: SubagentInfo): void {
		// --- Header line ---
		// [subagent] or [subagent:<agent>] <profile> · <description>
		const label = theme.fg("customMessageLabel", `\x1b[1m${formatSubagentBadge(info.agent)}\x1b[22m`);
		const profileBadge = theme.fg("accent", info.profile);
		const dot = theme.fg("dim", " \u00B7 "); // middle dot separator
		const description = theme.fg("customMessageText", info.description);
		this.addChild(new Text(`${label} ${profileBadge}${dot}${description}`, 0, 0));

		this.addChild(new Spacer(1));

		// --- Status line ---
		switch (info.status) {
			case "running": {
				const statusParts = [renderRunningStateChip(info.phaseState)];
				const phase = info.phase?.trim();
				if (phase && phase.length > 0 && phase !== info.phaseState && phase !== "running") {
					statusParts.push(theme.fg("customMessageText", phase));
				}
				const toolProgress = formatToolProgress(info.toolCallsStarted, info.toolCallsCompleted);
				if (toolProgress) {
					statusParts.push(theme.fg("muted", toolProgress));
				}
				if (typeof info.assistantMessages === "number" && info.assistantMessages > 0) {
					statusParts.push(theme.fg("muted", `msgs ${info.assistantMessages}`));
				}
				if (typeof info.durationMs === "number" && info.durationMs >= 0) {
					statusParts.push(theme.fg("muted", `elapsed ${formatElapsedClock(info.durationMs)}`));
				}
				this.addInlineParts(statusParts);

				const contextParts: string[] = [];
				if (info.cwd) {
					contextParts.push(theme.fg("muted", `@ ${shortenPath(info.cwd)}`));
				}
				if (info.activeTool) {
					contextParts.push(theme.fg("customMessageText", `tool ${info.activeTool}`));
				}
				if (info.isolation && info.isolation !== "none") {
					contextParts.push(theme.fg("muted", `iso ${info.isolation}`));
				}
				if (info.lockKey) {
					contextParts.push(theme.fg("muted", `lock ${info.lockKey}`));
				}
				this.addInlineParts(contextParts);
				this.renderDelegateSection(info);
				break;
			}

			case "done": {
				const parts: string[] = [];
				parts.push(theme.fg("success", "[x] done"));
				if (info.outputLength !== undefined) {
					parts.push(theme.fg("customMessageText", `${formatBytes(info.outputLength)} output`));
				}
				if (info.durationMs !== undefined) {
					parts.push(theme.fg("muted", formatDuration(info.durationMs)));
				}
				const toolProgress = formatToolProgress(info.toolCallsStarted, info.toolCallsCompleted);
				if (toolProgress) {
					parts.push(theme.fg("muted", toolProgress));
				}
				if (typeof info.waitMs === "number" && info.waitMs > 0) {
					parts.push(theme.fg("muted", `queue ${formatDuration(info.waitMs)}`));
				}
				this.addInlineParts(parts);
				this.renderDelegateSection(info);
				break;
			}

			case "error": {
				const cross = theme.fg("error", "[!] error");
				const message = info.errorMessage ? info.errorMessage : "error";
				const errorText = theme.fg("error", message);
				this.addInlineParts([cross, errorText]);
				this.renderDelegateSection(info);
				break;
			}
		}
	}
}

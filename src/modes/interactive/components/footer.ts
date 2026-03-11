import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSession } from "../../../core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts (similar to web-ui)
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function badge(text: string, color: "accent" | "success" | "warning" | "muted"): string {
	return theme.fg("dim", "[") + theme.fg(color, text) + theme.fg("dim", "]");
}

/**
 * Detect IOSM workspace and return a compact status segment.
 * Returns empty string when no IOSM workspace is found.
 */
function getIosmStatus(cwd: string): string {
	const iosmDir = join(cwd, ".iosm");
	if (!existsSync(iosmDir)) return "";

	// Try to find the most recent cycle ID
	let cycleId: string | undefined;
	try {
		const cyclesDir = join(iosmDir, "cycles");
		if (existsSync(cyclesDir)) {
			const entries = readdirSync(cyclesDir).sort();
			if (entries.length > 0) {
				cycleId = entries[entries.length - 1];
			}
		}
	} catch {
		// Ignore read errors
	}

	const label = theme.fg("accent", "iosm");
	const suffix = cycleId ? theme.fg("muted", ` #${cycleId}`) : "";
	return label + suffix;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private planMode = false;
	private activeProfile = "";

	constructor(
		private session: AgentSession,
		private footerData: ReadonlyFooterDataProvider,
	) {}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Toggle plan-mode badge in the status line.
	 * When enabled, a [plan] badge is prepended before the session state badge.
	 */
	setPlanMode(enabled: boolean): void {
		this.planMode = enabled;
	}

	/**
	 * Set the active profile name.
	 * When non-empty, a [profile] badge is shown in the status line so the
	 * operator can always see the current profile, including "full".
	 */
	setActiveProfile(profile: string): void {
		this.activeProfile = profile;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;
		const separator = theme.fg("dim", " • ");

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		const sessionManager = this.session.sessionManager as { getCwd?: () => string };
		const sessionCwd = sessionManager.getCwd?.() ?? process.cwd();

		// Replace home directory with ~
		let pwd = sessionCwd;
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		const statusParts = [];

		const normalizedProfile = this.activeProfile.trim().toLowerCase();

		// Plan-mode badge stays leftmost for quick mode awareness, but avoid duplicate
		// [plan] when active profile already renders as [plan].
		if (this.planMode && normalizedProfile !== "plan") {
			statusParts.push(badge("plan", "accent"));
		}

		// Profile badge is always shown when a profile is set, including "full".
		if (normalizedProfile) {
			statusParts.push(badge(normalizedProfile, "muted"));
		}

		if (this.session.isCompacting) {
			statusParts.push(badge("compacting", "warning"));
		} else if (this.session.isStreaming) {
			statusParts.push(badge("working", "accent"));
		} else {
			statusParts.push(badge("ready", "success"));
		}

		const pendingMessages = this.session.pendingMessageCount ?? 0;
		if (pendingMessages > 0) {
			statusParts.push(badge(`queue ${pendingMessages}`, pendingMessages > 1 ? "warning" : "accent"));
		}

		const retryAttempt = this.session.retryAttempt ?? 0;
		if (retryAttempt > 0) {
			statusParts.push(badge(`retry ${retryAttempt}`, "warning"));
		}

		// Build stats line
		const usageParts = [];
		if (totalInput) usageParts.push(theme.fg("muted", `↑${formatTokens(totalInput)}`));
		if (totalOutput) usageParts.push(theme.fg("muted", `↓${formatTokens(totalOutput)}`));
		if (totalCacheRead) usageParts.push(theme.fg("muted", `R${formatTokens(totalCacheRead)}`));
		if (totalCacheWrite) usageParts.push(theme.fg("muted", `W${formatTokens(totalCacheWrite)}`));

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			usageParts.push(theme.fg("muted", costStr));
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `ctx ?/${formatTokens(contextWindow)}${autoIndicator}`
				: `ctx ${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = theme.fg("muted", contextPercentDisplay);
		}
		usageParts.push(contextPercentStr);

		let statsLeft = [...statusParts, ...usageParts].join(separator);

		// Add provider/model on the right side, plus thinking level if model supports it
		const modelName = state.model ? `${state.model.provider}/${state.model.id}` : "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = state.model ? theme.fg("accent", modelName) : theme.fg("warning", modelName);
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off"
					? `${theme.fg("accent", modelName)}${theme.fg("muted", " • thinking off")}`
					: `${theme.fg("accent", modelName)}${theme.fg("muted", ` • ${thinkingLevel}`)}`;
		}

		const rightSide = rightSideWithoutProvider;

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Build pwd line, optionally with IOSM status segment appended
		const iosmStatus = getIosmStatus(sessionCwd);
		let pwdLine: string;
		if (iosmStatus) {
			// Assemble the IOSM segment (carries its own ANSI color codes)
			const iosmSegment = " [" + iosmStatus + theme.fg("dim", "]");
			const iosmSegmentWidth = visibleWidth(iosmSegment);
			// Truncate pwd portion to leave room for the iosm segment
			const maxPwdWidth = Math.max(0, width - iosmSegmentWidth);
			const dimPwdTruncated = truncateToWidth(theme.fg("dim", pwd), maxPwdWidth, theme.fg("dim", "..."));
			pwdLine = dimPwdTruncated + iosmSegment;
		} else {
			pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		}
		const lines = [pwdLine, statsLine];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}

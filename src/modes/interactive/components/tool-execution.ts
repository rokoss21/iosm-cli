import * as os from "node:os";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import type { ToolDefinition } from "../../../core/extensions/types.js";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "../../../core/tools/edit-diff.js";
import { allTools } from "../../../core/tools/index.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../core/tools/truncate.js";
import { convertToPng } from "../../../utils/image-convert.js";
import { sanitizeBinaryOutput } from "../../../utils/shell.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { renderDiff } from "./diff.js";
import { keyHint } from "./keybinding-hints.js";
import { MessageWindow } from "./message-window.js";
import { truncateToVisualLines } from "./visual-truncate.js";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
const TOOL_BOX_PADDING_X = 2;
const TOOL_BOX_PADDING_Y = 1;
// During partial write tool-call streaming, re-highlight the first N lines fully
// to keep multiline tokenization mostly correct without re-highlighting the full file.
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

/**
 * Convert absolute path to tilde notation if it's in home directory
 */
function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Normalize control characters for terminal preview rendering.
 * Keep tool arguments unchanged, sanitize only display text.
 */
function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/** Safely coerce value to string for display. Returns null if invalid type. */
function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null; // Invalid type
}

type ChecklistStatus = "pending" | "in_progress" | "done" | "blocked";

interface ChecklistItem {
	id?: string;
	title: string;
	status: ChecklistStatus;
	activeForm?: string;
}

function normalizeChecklistStatus(value: unknown): ChecklistStatus {
	if (typeof value !== "string") return "pending";
	const token = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
	switch (token) {
		case "done":
		case "complete":
		case "completed":
		case "success":
		case "checked":
		case "x":
			return "done";
		case "in_progress":
		case "inprogress":
		case "active":
		case "current":
		case "doing":
			return "in_progress";
		case "blocked":
		case "waiting":
		case "on_hold":
		case "paused":
			return "blocked";
		default:
			return "pending";
	}
}

function buildChecklistItem(value: unknown): ChecklistItem | undefined {
	if (typeof value === "string") {
		const title = value.trim();
		if (!title) return undefined;
		return { title, status: "pending" };
	}
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	const title =
		(typeof candidate.subject === "string" && candidate.subject.trim()) ||
		(typeof candidate.title === "string" && candidate.title.trim()) ||
		(typeof candidate.step === "string" && candidate.step.trim()) ||
		(typeof candidate.text === "string" && candidate.text.trim()) ||
		(typeof candidate.description === "string" && candidate.description.trim()) ||
		undefined;
	if (!title) return undefined;

	const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : undefined;
	const activeForm =
		typeof candidate.activeForm === "string" && candidate.activeForm.trim()
			? candidate.activeForm.trim()
			: undefined;

	if (typeof candidate.completed === "boolean") {
		return {
			id,
			title,
			status: candidate.completed ? "done" : "pending",
			activeForm,
		};
	}

	return {
		id,
		title,
		status: normalizeChecklistStatus(candidate.status),
		activeForm,
	};
}

function parseChecklistMarkdown(markdown: string): ChecklistItem[] {
	const lines = markdown
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const items: ChecklistItem[] = [];
	for (const line of lines) {
		const checklistMatch =
			line.match(/^(?:[-*]|\d+[.)])\s*\[([^\]]+)\]\s+(.+)$/) ?? line.match(/^\[([^\]]+)\]\s+(.+)$/);
		if (checklistMatch) {
			const title = checklistMatch[2]?.trim();
			if (!title) continue;
			items.push({
				title,
				status: normalizeChecklistStatus(checklistMatch[1]),
			});
			continue;
		}

		const bulletMatch = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
		if (!bulletMatch) continue;
		const title = bulletMatch[1]?.trim();
		if (!title) continue;
		items.push({
			title,
			status: "pending",
		});
	}
	return items;
}

function extractChecklistItems(value: unknown): ChecklistItem[] {
	if (typeof value === "string") {
		return parseChecklistMarkdown(value);
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((item) => buildChecklistItem(item)).filter((item): item is ChecklistItem => !!item);
}

function countChecklistByStatus(items: ChecklistItem[]): {
	done: number;
	inProgress: number;
	pending: number;
	blocked: number;
} {
	const counts = { done: 0, inProgress: 0, pending: 0, blocked: 0 };
	for (const item of items) {
		if (item.status === "done") {
			counts.done += 1;
			continue;
		}
		if (item.status === "in_progress") {
			counts.inProgress += 1;
			continue;
		}
		if (item.status === "blocked") {
			counts.blocked += 1;
			continue;
		}
		counts.pending += 1;
	}
	return counts;
}

function checklistStatusMarker(status: ChecklistStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "in_progress":
			return "→";
		case "blocked":
			return "!";
		case "pending":
		default:
			return "•";
	}
}

function styleChecklistMarker(status: ChecklistStatus, marker: string): string {
	switch (status) {
		case "done":
			return theme.fg("success", marker);
		case "in_progress":
			return theme.fg("accent", marker);
		case "blocked":
			return theme.fg("warning", marker);
		case "pending":
		default:
			return theme.fg("muted", marker);
	}
}

function checklistStatusLabel(status: ChecklistStatus): string {
	switch (status) {
		case "done":
			return "done";
		case "in_progress":
			return "in progress";
		case "blocked":
			return "blocked";
		case "pending":
		default:
			return "pending";
	}
}

type ToolRenderState = "pending" | "success" | "error";

function hasAnsiEscape(input: string): boolean {
	return /\x1b\[[0-9;]*m/.test(input);
}

function toolBadge(label: string, state: ToolRenderState): string {
	const color = state === "error" ? "error" : state === "success" ? "accent" : "muted";
	return theme.fg("dim", "[") + theme.fg(color, label) + theme.fg("dim", "]");
}

function toolHeader(label: string, subject: string, state: ToolRenderState, meta?: string): string {
	const nestColor = state === "error" ? "error" : state === "success" ? "accent" : "dim";
	const parts = [toolBadge(label, state)];
	if (subject) {
		parts.push(hasAnsiEscape(subject) ? subject : theme.fg("toolTitle", subject));
	}
	if (meta) parts.push(theme.fg("muted", meta));
	return theme.fg(nestColor, "\u23BF ") + parts.join(" ");
}

function expandHint(remaining: number, total?: number): string {
	const totalSuffix = total !== undefined ? `, ${total} total` : "";
	return `${theme.fg("muted", `\n... (${remaining} more lines${totalSuffix},`)} ${keyHint("expandTools", "to expand")})`;
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private frameContent: Container;
	private messageWindow: MessageWindow;
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private toolDefinition?: ToolDefinition;
	private ui: TUI;
	private cwd: string;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Incremental syntax highlighting cache for write tool call args
	private writeHighlightCache?: WriteHighlightCache;
	// When true, this component intentionally renders no lines
	private hideComponent = false;

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.toolDefinition = toolDefinition;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		this.frameContent = new Container();
		this.messageWindow = new MessageWindow(this.frameContent, {
			label: "tool",
			lineColor: "success",
			labelColor: "success",
			paddingY: 1,
		});
		this.addChild(this.messageWindow);

		const noBg = (text: string) => text;
		// Always create both - contentBox for custom tools/bash, contentText for other built-ins
		this.contentBox = new Box(TOOL_BOX_PADDING_X, TOOL_BOX_PADDING_Y, noBg);
		this.contentText = new Text("", TOOL_BOX_PADDING_X, TOOL_BOX_PADDING_Y, noBg);

		this.updateDisplay();
	}

	/**
	 * Check if we should use built-in rendering for this tool.
	 * Returns true if the tool name is a built-in AND either there's no toolDefinition
	 * or the toolDefinition doesn't provide custom renderers.
	 */
	private shouldUseBuiltInRenderer(): boolean {
		const isBuiltInName = this.toolName in allTools;
		const hasCustomRenderers = this.toolDefinition?.renderCall || this.toolDefinition?.renderResult;
		return isBuiltInName && !hasCustomRenderers;
	}

	updateArgs(args: any): void {
		this.args = args;
		if (this.toolName === "write" && this.isPartial) {
			this.updateWriteHighlightCacheIncremental();
		}
		this.updateDisplay();
	}

	private highlightSingleLine(line: string, lang: string): string {
		const highlighted = highlightCode(line, lang);
		return highlighted[0] ?? "";
	}

	private refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
		const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
		if (prefixCount === 0) return;

		const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
		const prefixHighlighted = highlightCode(prefixSource, cache.lang);
		for (let i = 0; i < prefixCount; i++) {
			cache.highlightedLines[i] =
				prefixHighlighted[i] ?? this.highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
		}
	}

	private rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): void {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		const displayContent = normalizeDisplayText(fileContent);
		const normalized = replaceTabs(displayContent);
		this.writeHighlightCache = {
			rawPath,
			lang,
			rawContent: fileContent,
			normalizedLines: normalized.split("\n"),
			highlightedLines: highlightCode(normalized, lang),
		};
	}

	private updateWriteHighlightCacheIncremental(): void {
		const rawPath = str(this.args?.file_path ?? this.args?.path);
		const fileContent = str(this.args?.content);
		if (rawPath === null || fileContent === null) {
			this.writeHighlightCache = undefined;
			return;
		}

		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		if (!lang) {
			this.writeHighlightCache = undefined;
			return;
		}

		if (!this.writeHighlightCache) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		const cache = this.writeHighlightCache;
		if (cache.lang !== lang || cache.rawPath !== rawPath) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (!fileContent.startsWith(cache.rawContent)) {
			this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			return;
		}

		if (fileContent.length === cache.rawContent.length) {
			return;
		}

		const deltaRaw = fileContent.slice(cache.rawContent.length);
		const deltaDisplay = normalizeDisplayText(deltaRaw);
		const deltaNormalized = replaceTabs(deltaDisplay);
		cache.rawContent = fileContent;

		if (cache.normalizedLines.length === 0) {
			cache.normalizedLines.push("");
			cache.highlightedLines.push("");
		}

		const segments = deltaNormalized.split("\n");
		const lastIndex = cache.normalizedLines.length - 1;
		cache.normalizedLines[lastIndex] += segments[0];
		cache.highlightedLines[lastIndex] = this.highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);

		for (let i = 1; i < segments.length; i++) {
			cache.normalizedLines.push(segments[i]);
			cache.highlightedLines.push(this.highlightSingleLine(segments[i], cache.lang));
		}

		this.refreshWriteHighlightPrefix(cache);
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		if (this.toolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = this.args?.path;
		const oldText = this.args?.oldText;
		const newText = this.args?.newText;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText });

		// Skip if we already computed for these exact args
		if (this.editDiffArgsKey === argsKey) return;

		this.editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.cwd).then((result) => {
			// Only update if args haven't changed since we started
			if (this.editDiffArgsKey === argsKey) {
				this.editDiffPreview = result;
				this.updateDisplay();
				this.ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		if (this.toolName === "write" && !isPartial) {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			if (rawPath !== null && fileContent !== null) {
				this.rebuildWriteHighlightCacheFull(rawPath, fileContent);
			}
		}
		this.updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.maybeConvertImagesForKitty();
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		// Only needed for Kitty protocol
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			// Convert async
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		const noBg = (text: string) => text;

		const useBuiltInRenderer = this.shouldUseBuiltInRenderer();
		const usesBoxRenderer = this.toolName === "bash" || !useBuiltInRenderer;
		const primaryComponent = usesBoxRenderer ? this.contentBox : this.contentText;
		let customRendererHasContent = false;
		this.hideComponent = false;

		// Use built-in rendering for built-in tools (or overrides without custom renderers)
		if (useBuiltInRenderer) {
			if (this.toolName === "bash") {
				// Bash uses Box with visual line truncation
				this.contentBox.setBgFn(noBg);
				this.contentBox.clear();
				this.renderBashContent();
			} else {
				// Other built-in tools: use Text directly with caching
				this.contentText.setCustomBgFn(noBg);
				this.contentText.setText(this.formatToolExecution());
			}
		} else if (this.toolDefinition) {
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(noBg);
			this.contentBox.clear();
			let customCallSectionRendered = false;

			// Render call component
			if (this.toolDefinition.renderCall) {
				try {
					const callComponent = this.toolDefinition.renderCall(this.args, theme);
					if (callComponent !== undefined) {
						this.contentBox.addChild(callComponent);
						customRendererHasContent = true;
						customCallSectionRendered = true;
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
					customRendererHasContent = true;
					customCallSectionRendered = true;
				}
			} else {
				// No custom renderCall, show tool name
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0));
				customRendererHasContent = true;
				customCallSectionRendered = true;
			}

			const addSectionSpacer = (): void => {
				if (customCallSectionRendered) {
					this.contentBox.addChild(new Spacer(1));
				}
			};

			// Render result component if we have a result
			if (this.result && this.toolDefinition.renderResult) {
				try {
					const resultComponent = this.toolDefinition.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
					);
					if (resultComponent !== undefined) {
						addSectionSpacer();
						this.contentBox.addChild(resultComponent);
						customRendererHasContent = true;
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						addSectionSpacer();
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
						customRendererHasContent = true;
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					addSectionSpacer();
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					customRendererHasContent = true;
				}
			}
		} else {
			// Unknown tool with no registered definition - show generic fallback
			this.contentText.setCustomBgFn(noBg);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		this.imageComponents = [];
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];
			const caps = getCapabilities();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
						if (caps.images === "kitty" && imageMimeType !== "image/png") {
							continue;
						}

						const spacer = new Spacer(1);
						this.imageSpacers.push(spacer);
						const imageComponent = new Image(
							imageData,
							imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
							{ maxWidthCells: 60 },
						);
						this.imageComponents.push(imageComponent);
					}
				}
			}

		if (!useBuiltInRenderer && this.toolDefinition) {
			this.hideComponent = !customRendererHasContent && this.imageComponents.length === 0;
		}
		this.messageWindow.setVisible(!this.hideComponent);
		if (this.hideComponent) {
			return;
		}

		this.frameContent.clear();
		this.frameContent.addChild(primaryComponent);
		for (let i = 0; i < this.imageComponents.length; i++) {
			const spacer = this.imageSpacers[i];
			const image = this.imageComponents[i];
			if (spacer) this.frameContent.addChild(spacer);
			if (image) this.frameContent.addChild(image);
		}
	}

	/**
	 * Render bash content using visual line truncation (like bash-execution.ts).
	 * Uses compact Claude Code style: one-line header with ⎿ prefix.
	 */
	private renderBashContent(): void {
		const command = str(this.args?.command);
		const timeout = this.args?.timeout as number | undefined;

		// Build the first line of the command (compact display)
		const commandDisplay =
			command === null ? "[invalid arg]" : command ? command.split("\n")[0] : "...";
		const timeoutSuffix = timeout ? ` (timeout ${timeout}s)` : "";

		// Compact one-line header
		let headerText: string;
		if (this.isPartial) {
			headerText = toolHeader("bash", `$ ${commandDisplay}${timeoutSuffix}`, "pending");
		} else if (this.result?.isError) {
			const exitCode = this.result.details?.exitCode ?? 1;
			headerText = toolHeader("bash", `$ ${commandDisplay}`, "error", `(exit ${exitCode})`);
		} else if (this.result) {
			headerText = toolHeader("bash", `$ ${commandDisplay}`, "success", "(exit 0)");
		} else {
			headerText = toolHeader("bash", `$ ${commandDisplay}${timeoutSuffix}`, "pending");
		}

		this.contentBox.addChild(new Text(headerText, 0, 0));

		if (this.result) {
			const output = this.getTextOutput().trim();

			if (output) {
				// Style each line for the output
				const styledOutput = output
					.split("\n")
					.map((line) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					// Show all lines when expanded
					this.contentBox.addChild(new Text(`\n${styledOutput}`, 0, 0));
				} else {
					// Use visual line truncation when collapsed with width-aware caching
					let cachedWidth: number | undefined;
					let cachedLines: string[] | undefined;
					let cachedSkipped: number | undefined;

					this.contentBox.addChild({
						render: (width: number) => {
							if (cachedLines === undefined || cachedWidth !== width) {
								const result = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
								cachedLines = result.visualLines;
								cachedSkipped = result.skippedCount;
								cachedWidth = width;
							}
							if (cachedSkipped && cachedSkipped > 0) {
								const hint = expandHint(cachedSkipped);
								return ["", truncateToWidth(hint, width, "..."), ...cachedLines];
							}
							// Add blank line for spacing (matches expanded case)
							return ["", ...cachedLines];
						},
						invalidate: () => {
							cachedWidth = undefined;
							cachedLines = undefined;
							cachedSkipped = undefined;
						},
					});
				}
			}

			// Truncation warnings
			const truncation = this.result.details?.truncation;
			const fullOutputPath = this.result.details?.fullOutputPath;
			if (truncation?.truncated || fullOutputPath) {
				const warnings: string[] = [];
				if (fullOutputPath) {
					warnings.push(`Full output: ${fullOutputPath}`);
				}
				if (truncation?.truncated) {
					if (truncation.truncatedBy === "lines") {
						warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
					} else {
						warnings.push(
							`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
						);
					}
				}
				this.contentBox.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
			}
		}
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		let output = textBlocks
			.map((c: any) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
		if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text = "";
		const invalidArg = theme.fg("error", "[invalid arg]");

		if (this.toolName === "read") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const shortPath = rawPath !== null ? shortenPath(rawPath) : null;
			const offset = this.args?.offset;
			const limit = this.args?.limit;

			const pathLabel = shortPath === null ? "[invalid arg]" : shortPath || "...";

			// Build range suffix for path
			let rangeSuffix = "";
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				rangeSuffix = `:${startLine}${endLine ? `-${endLine}` : ""}`;
			}

			if (this.isPartial) {
				text = toolHeader("read", pathLabel + rangeSuffix, "pending");
			} else if (this.result?.isError) {
				text = toolHeader("read", pathLabel + rangeSuffix, "error");
			} else if (this.result) {
				const output = this.getTextOutput();
				const lineCount = output ? output.split("\n").length : 0;
				const subject = shortPath === null ? invalidArg : theme.fg("accent", pathLabel + rangeSuffix);
				text = toolHeader("read", subject, "success", `(${lineCount} lines)`);
			} else {
				text = toolHeader("read", pathLabel + rangeSuffix, "pending");
			}

			if (this.result && !this.result.isError) {
				const output = this.getTextOutput();
				const rawPathForLang = str(this.args?.file_path ?? this.args?.path);
				const lang = rawPathForLang ? getLanguageFromPath(rawPathForLang) : undefined;
				const lines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");

				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines
						.map((line: string) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line))))
						.join("\n");
				if (remaining > 0) {
					text += expandHint(remaining, lines.length);
				}

				const truncation = this.result.details?.truncation;
				if (truncation?.truncated) {
					if (truncation.firstLineExceedsLimit) {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`,
							);
					} else if (truncation.truncatedBy === "lines") {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`,
							);
					} else {
						text +=
							"\n" +
							theme.fg(
								"warning",
								`[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`,
							);
					}
				}
			} else if (this.result?.isError) {
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			}
		} else if (this.toolName === "write") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const fileContent = str(this.args?.content);
			const shortPath = rawPath !== null ? shortenPath(rawPath) : null;
			const pathLabel = shortPath === null ? "[invalid arg]" : shortPath || "...";

			if (this.isPartial) {
				text = toolHeader("write", pathLabel, "pending");
			} else if (this.result?.isError) {
				text = toolHeader("write", pathLabel, "error");
			} else if (this.result) {
				// Count lines from args content (what was written)
				const writtenLines = fileContent ? fileContent.split("\n").length : 0;
				const subject = shortPath === null ? invalidArg : theme.fg("accent", pathLabel);
				text = toolHeader("write", subject, "success", `(${writtenLines} lines)`);
			} else {
				text = toolHeader("write", pathLabel, "pending");
			}

			if (fileContent === null) {
				text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
			} else if (fileContent) {
				const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;

				let lines: string[];
				if (lang) {
					const cache = this.writeHighlightCache;
					if (cache && cache.lang === lang && cache.rawPath === rawPath && cache.rawContent === fileContent) {
						lines = cache.highlightedLines;
					} else {
						const displayContent = normalizeDisplayText(fileContent);
						const normalized = replaceTabs(displayContent);
						lines = highlightCode(normalized, lang);
						this.writeHighlightCache = {
							rawPath,
							lang,
							rawContent: fileContent,
							normalizedLines: normalized.split("\n"),
							highlightedLines: lines,
						};
					}
				} else {
					lines = normalizeDisplayText(fileContent).split("\n");
					this.writeHighlightCache = undefined;
				}

				const totalLines = lines.length;
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text +=
					"\n\n" +
					displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n");
				if (remaining > 0) {
					text += expandHint(remaining, totalLines);
				}
			}

			// Show error if tool execution failed
			if (this.result?.isError) {
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			}
		} else if (this.toolName === "edit") {
			const rawPath = str(this.args?.file_path ?? this.args?.path);
			const shortPath = rawPath !== null ? shortenPath(rawPath) : null;
			const pathLabel = shortPath === null ? "[invalid arg]" : shortPath || "...";

			// Compute +X / -Y stats from diff if available
			let diffStats = "";
			const diff = this.result?.details?.diff ?? (this.editDiffPreview && !("error" in this.editDiffPreview) ? (this.editDiffPreview as any).diff : undefined);
			if (diff) {
				const added = (diff.match(/^\+[^+]/mg) || []).length;
				const removed = (diff.match(/^-[^-]/mg) || []).length;
				if (added > 0 || removed > 0) {
					diffStats = `(+${added} / -${removed} lines)`;
				}
			}

			if (this.isPartial) {
				text = toolHeader("edit", pathLabel, "pending");
			} else if (this.result?.isError) {
				text = toolHeader("edit", pathLabel, "error", "(failed)");
			} else if (this.result) {
				const subject = shortPath === null ? invalidArg : theme.fg("accent", pathLabel);
				text = toolHeader("edit", subject, "success", diffStats || undefined);
			} else {
				text = toolHeader("edit", pathLabel, "pending");
			}

			if (this.result?.isError) {
				// Show error from result
				const errorText = this.getTextOutput();
				if (errorText) {
					text += `\n\n${theme.fg("error", errorText)}`;
				}
			} else if (this.result?.details?.diff) {
				// Tool executed successfully - use the diff from result
				text += `\n\n${renderDiff(this.result.details.diff, { filePath: rawPath ?? undefined })}`;
			} else if (this.editDiffPreview) {
				// Use cached diff preview (before tool executes)
				if ("error" in this.editDiffPreview) {
					text += `\n\n${theme.fg("error", this.editDiffPreview.error)}`;
				} else if (this.editDiffPreview.diff) {
					text += `\n\n${renderDiff(this.editDiffPreview.diff, { filePath: rawPath ?? undefined })}`;
				}
			}
		} else if (this.toolName === "ls") {
			const rawPath = str(this.args?.path);
			const shortPath = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const pathLabel = shortPath === null ? "[invalid arg]" : shortPath || ".";

			if (this.isPartial) {
				text = toolHeader("list", pathLabel, "pending");
			} else if (this.result?.isError) {
				text = toolHeader("list", pathLabel, "error");
			} else if (this.result) {
				const output = this.getTextOutput().trim();
				const resultCount = output ? output.split("\n").filter(Boolean).length : 0;
				const subject = shortPath === null ? invalidArg : theme.fg("accent", pathLabel);
				text = toolHeader("list", subject, "success", `(${resultCount} entries)`);
			} else {
				text = toolHeader("list", pathLabel, "pending");
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += expandHint(remaining, lines.length);
					}
				}

				const entryLimit = this.result.details?.entryLimitReached;
				const truncation = this.result.details?.truncation;
				if (entryLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (entryLimit) {
						warnings.push(`${entryLimit} entries limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (this.toolName === "find") {
			const pattern = str(this.args?.pattern);
			const patternLabel = pattern === null ? "[invalid arg]" : pattern || "*";
			const rawPath = str(this.args?.path);
			const shortPath = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const pathLabel = shortPath === null ? "[invalid arg]" : shortPath || ".";
			const subject = `${theme.fg("toolTitle", patternLabel)} ${theme.fg("muted", "in")} ${
				shortPath === null ? invalidArg : theme.fg("accent", pathLabel)
			}`;

			if (this.isPartial) {
				text = toolHeader("find", subject, "pending");
			} else if (this.result?.isError) {
				text = toolHeader("find", subject, "error");
			} else if (this.result) {
				const output = this.getTextOutput().trim();
				const resultCount = output ? output.split("\n").filter(Boolean).length : 0;
				text = toolHeader("find", subject, "success", `(${resultCount} results)`);
			} else {
				text = toolHeader("find", subject, "pending");
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += expandHint(remaining, lines.length);
					}
				}

				const resultLimit = this.result.details?.resultLimitReached;
				const truncation = this.result.details?.truncation;
				if (resultLimit || truncation?.truncated) {
					const warnings: string[] = [];
					if (resultLimit) {
						warnings.push(`${resultLimit} results limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (this.toolName === "grep") {
			const pattern = str(this.args?.pattern);
			const patternLabel = pattern === null ? "[invalid arg]" : pattern || "";
			const rawPath = str(this.args?.path);
			const shortPath = rawPath !== null ? shortenPath(rawPath || ".") : null;
			const glob = str(this.args?.glob);
			const limit = this.args?.limit;
			const locationContext = shortPath !== null ? ` in ${shortPath}` : "";
			const globContext = glob ? ` (${glob})` : "";
			const limitContext = limit !== undefined ? ` limit ${limit}` : "";

			if (this.isPartial) {
				text = toolHeader("grep", patternLabel, "pending", `${locationContext}${globContext}${limitContext}`.trim());
			} else if (this.result?.isError) {
				text = toolHeader("grep", patternLabel, "error", `${locationContext}${globContext}${limitContext}`.trim());
			} else if (this.result) {
				const output = this.getTextOutput().trim();
				const matchCount = output ? output.split("\n").filter(Boolean).length : 0;
				const subject = pattern === null ? invalidArg : theme.fg("accent", patternLabel);
				const metaParts = [`(${matchCount} matches)`];
				if (locationContext || globContext || limitContext) {
					metaParts.push(`${locationContext}${globContext}${limitContext}`.trim());
				}
				text = toolHeader("grep", subject, "success", metaParts.join(" "));
			} else {
				text = toolHeader("grep", patternLabel, "pending", `${locationContext}${globContext}${limitContext}`.trim());
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 15;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += `\n\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
					if (remaining > 0) {
						text += expandHint(remaining, lines.length);
					}
				}

				const matchLimit = this.result.details?.matchLimitReached;
				const truncation = this.result.details?.truncation;
				const linesTruncated = this.result.details?.linesTruncated;
				if (matchLimit || truncation?.truncated || linesTruncated) {
					const warnings: string[] = [];
					if (matchLimit) {
						warnings.push(`${matchLimit} matches limit`);
					}
					if (truncation?.truncated) {
						warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
					}
					if (linesTruncated) {
						warnings.push("some lines truncated");
					}
					text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
				}
			}
		} else if (this.toolName === "todo_write" || this.toolName === "todo_read") {
			const isWrite = this.toolName === "todo_write";
			const details = this.result?.details as Record<string, unknown> | undefined;
			const tasksFromDetails = extractChecklistItems(details?.tasks);
			const tasksFromArgs = isWrite ? extractChecklistItems(this.args?.tasks) : [];
			const tasks = tasksFromDetails.length > 0 ? tasksFromDetails : tasksFromArgs;
			const counts = countChecklistByStatus(tasks);
			const summaryParts: string[] = [];
			if (counts.inProgress > 0) summaryParts.push(`${counts.inProgress} in progress`);
			if (counts.pending > 0) summaryParts.push(`${counts.pending} pending`);
			if (counts.done > 0) summaryParts.push(`${counts.done} done`);
			if (counts.blocked > 0) summaryParts.push(`${counts.blocked} blocked`);
			const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "no tasks";
			const subject = isWrite ? "Update task checklist" : "Read task checklist";

			if (this.isPartial) {
				text = toolHeader("tasks", subject, "pending");
			} else if (this.result?.isError) {
				text = toolHeader("tasks", subject, "error");
			} else if (this.result) {
				text = toolHeader("tasks", theme.fg("accent", subject), "success", `(${tasks.length} total: ${summary})`);
			} else {
				text = toolHeader("tasks", subject, "pending");
			}

			if (tasks.length > 0) {
				const maxLines = this.expanded ? tasks.length : 10;
				const displayTasks = tasks.slice(0, maxLines);
				const remaining = tasks.length - maxLines;
				const lines = displayTasks.map((task) => {
					const marker = styleChecklistMarker(task.status, checklistStatusMarker(task.status));
					const idPrefix = task.id ? `${theme.fg("dim", `[${task.id}]`)} ` : "";
					const label = theme.fg("toolOutput", task.title);
					const statusSuffix = theme.fg("dim", ` (${checklistStatusLabel(task.status)})`);
					const activeSuffix =
						task.status === "in_progress" && task.activeForm ? theme.fg("muted", ` — ${task.activeForm}`) : "";
					return `${marker} ${idPrefix}${label}${statusSuffix}${activeSuffix}`;
				});
				text += `\n\n${lines.join("\n")}`;
				if (remaining > 0) {
					text += expandHint(remaining, tasks.length);
				}
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output && (tasks.length === 0 || this.result.isError)) {
					text += `\n\n${theme.fg(this.result.isError ? "error" : "toolOutput", output)}`;
				}
			}
		} else {
			// Generic tool (shouldn't reach here for custom tools)
			text = theme.fg("toolTitle", theme.bold(this.toolName));

			const content = JSON.stringify(this.args, null, 2);
			text += `\n\n${theme.fg("toolOutput", content)}`;
			const output = this.getTextOutput();
			if (output) {
				text += `\n${theme.fg("toolOutput", output)}`;
			}
		}

		return text;
	}
}

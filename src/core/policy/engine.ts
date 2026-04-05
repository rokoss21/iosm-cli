import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import TOML from "@iarna/toml";
import { minimatch } from "minimatch";
import { CONFIG_DIR_NAME } from "../../config.js";
import type { SettingsManager } from "../settings-manager.js";
import type { ToolPermissionRequest } from "../tools/permissions.js";

export type PolicyEffect = "allow" | "deny" | "ask";
export type PolicyLayer = "admin" | "user" | "workspace" | "default" | "legacy";
export type PolicyToolSource = "builtin" | "extension" | "custom" | "mcp";

export interface PolicyRuleV2 {
	id: string;
	enabled: boolean;
	effect: PolicyEffect;
	priority: number;
	tools: string[];
	toolSource?: PolicyToolSource[];
	mcpName?: string[];
	profiles?: string[];
	cwdGlob?: string[];
	argsPattern?: string;
	checker?: string;
	legacyRule?: string;
}

export interface PolicySource {
	layer: PolicyLayer;
	path?: string;
	rules: PolicyRuleV2[];
	allowedSources: string[];
}

export interface PolicyEvaluationContext {
	profile?: string;
}

export interface PolicyDecision {
	effect: PolicyEffect;
	matched: boolean;
	reason: string;
	rule?: PolicyRuleV2;
	layer?: PolicyLayer;
}

interface ParsedPolicyToml {
	version?: number;
	allowed_sources?: unknown;
	rules?: unknown;
	[key: string]: unknown;
}

interface MutablePolicyToml {
	version: number;
	allowed_sources?: string[];
	rules: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

const DEFAULT_ALLOWED_SOURCES = [
	"registry.npmjs.org",
	"npmjs.org",
	"github.com",
	"gitlab.com",
	"bitbucket.org",
	"api.github.com",
	"raw.githubusercontent.com",
];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function toPolicyToolSourceArray(value: unknown): PolicyToolSource[] | undefined {
	const values = normalizeStringArray(value)
		.map((item) => item.toLowerCase())
		.filter((item): item is PolicyToolSource =>
			item === "builtin" || item === "extension" || item === "custom" || item === "mcp",
		);
	return values.length > 0 ? values : undefined;
}

function asPolicyEffect(value: unknown): PolicyEffect | undefined {
	if (typeof value !== "string") return undefined;
	if (value === "allow" || value === "deny" || value === "ask") return value;
	return undefined;
}

function asFiniteNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	return value;
}

function normalizeRule(raw: unknown, index: number): PolicyRuleV2 | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const effect = asPolicyEffect(obj.effect);
	if (!effect) return undefined;
	const idRaw = typeof obj.id === "string" ? obj.id.trim() : "";
	const id = idRaw.length > 0 ? idRaw : `rule-${index + 1}`;
	const tools = normalizeStringArray(obj.tools);
	const normalizedTools = tools.length > 0 ? tools : ["*"];
	const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
	const priority = Math.trunc(asFiniteNumber(obj.priority, 0));
	const toolSource = toPolicyToolSourceArray(obj.tool_source);
	const mcpName = normalizeStringArray(obj.mcp_name);
	const profiles = normalizeStringArray(obj.profiles);
	const cwdGlob = normalizeStringArray(obj.cwd_glob);
	const argsPattern = typeof obj.args_pattern === "string" && obj.args_pattern.trim().length > 0 ? obj.args_pattern : undefined;
	const checker = typeof obj.checker === "string" && obj.checker.trim().length > 0 ? obj.checker : undefined;
	const legacyRule =
		typeof obj.legacy_rule === "string" && obj.legacy_rule.trim().length > 0 ? obj.legacy_rule.trim() : undefined;

	return {
		id,
		enabled,
		effect,
		priority,
		tools: normalizedTools,
		toolSource,
		mcpName: mcpName.length > 0 ? mcpName : undefined,
		profiles: profiles.length > 0 ? profiles : undefined,
		cwdGlob: cwdGlob.length > 0 ? cwdGlob : undefined,
		argsPattern,
		checker,
		legacyRule,
	};
}

function toTomlRule(rule: PolicyRuleV2): Record<string, unknown> {
	const serialized: Record<string, unknown> = {
		id: rule.id,
		enabled: rule.enabled,
		effect: rule.effect,
		priority: rule.priority,
		tools: [...rule.tools],
	};
	if (rule.toolSource && rule.toolSource.length > 0) serialized.tool_source = [...rule.toolSource];
	if (rule.mcpName && rule.mcpName.length > 0) serialized.mcp_name = [...rule.mcpName];
	if (rule.profiles && rule.profiles.length > 0) serialized.profiles = [...rule.profiles];
	if (rule.cwdGlob && rule.cwdGlob.length > 0) serialized.cwd_glob = [...rule.cwdGlob];
	if (rule.argsPattern) serialized.args_pattern = rule.argsPattern;
	if (rule.checker) serialized.checker = rule.checker;
	if (rule.legacyRule) serialized.legacy_rule = rule.legacyRule;
	return serialized;
}

function parsePolicyToml(content: string): { rules: PolicyRuleV2[]; allowedSources: string[] } {
	const parsed = TOML.parse(content) as ParsedPolicyToml;
	const ruleEntries = Array.isArray(parsed.rules) ? parsed.rules : [];
	const rules: PolicyRuleV2[] = [];
	for (let index = 0; index < ruleEntries.length; index += 1) {
		const normalized = normalizeRule(ruleEntries[index], index);
		if (normalized) {
			rules.push(normalized);
		}
	}
	return {
		rules,
		allowedSources: normalizeStringArray(parsed.allowed_sources),
	};
}

function buildLegacyPolicyRules(settingsManager: SettingsManager): PolicyRuleV2[] {
	const rules: PolicyRuleV2[] = [];

	for (const [index, raw] of settingsManager.getPermissionDenyRules().entries()) {
		const normalized = raw.trim();
		if (!normalized) continue;
		const [toolRaw, ...rest] = normalized.split(":");
		const tool = toolRaw.trim() || "*";
		const needle = rest.join(":").trim();
		rules.push({
			id: `legacy-deny-${index + 1}`,
			enabled: true,
			effect: "deny",
			priority: 1000 - index,
			tools: [tool],
			checker: needle ? `summary_contains:${needle}` : undefined,
			legacyRule: `${tool}:${needle}`,
		});
	}

	for (const [index, raw] of settingsManager.getPermissionAllowRules().entries()) {
		const normalized = raw.trim();
		if (!normalized) continue;
		const [toolRaw, ...rest] = normalized.split(":");
		const tool = toolRaw.trim() || "*";
		const needle = rest.join(":").trim();
		rules.push({
			id: `legacy-allow-${index + 1}`,
			enabled: true,
			effect: "allow",
			priority: 1000 - index,
			tools: [tool],
			checker: needle ? `summary_contains:${needle}` : undefined,
			legacyRule: `${tool}:${needle}`,
		});
	}

	return rules;
}

function loadPolicyFile(path: string): { rules: PolicyRuleV2[]; allowedSources: string[] } {
	if (!existsSync(path)) {
		return { rules: [], allowedSources: [] };
	}
	const content = readFileSync(path, "utf8");
	return parsePolicyToml(content);
}

function normalizePolicyPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function defaultAdminPolicyPath(): string {
	if (process.platform === "win32") {
		return "C:\\ProgramData\\iosm\\policy.toml";
	}
	return "/etc/iosm/policy.toml";
}

function buildDefaultRuleSet(): PolicySource {
	return {
		layer: "default",
		rules: [],
		allowedSources: [...DEFAULT_ALLOWED_SOURCES],
	};
}

function getLayerRank(layer: PolicyLayer): number {
	switch (layer) {
		case "admin":
			return 0;
		case "user":
			return 1;
		case "workspace":
			return 2;
		case "default":
			return 3;
		case "legacy":
			return 4;
	}
}

export class PolicyEngineV2 {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly adminPolicyPath: string;
	private readonly settingsManager: SettingsManager;
	private sources: PolicySource[] = [];

	constructor(options: {
		cwd: string;
		agentDir: string;
		settingsManager: SettingsManager;
		adminPolicyPath?: string;
	}) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.settingsManager = options.settingsManager;
		this.adminPolicyPath = normalizePolicyPath(options.adminPolicyPath ?? defaultAdminPolicyPath());
		this.refresh();
	}

	refresh(): void {
		const userPath = join(this.agentDir, "policy.toml");
		const workspacePath = join(this.cwd, CONFIG_DIR_NAME, "policy.toml");
		const admin = loadPolicyFile(this.adminPolicyPath);
		const user = loadPolicyFile(userPath);
		const workspace = loadPolicyFile(workspacePath);
		const legacyRules = buildLegacyPolicyRules(this.settingsManager);
		this.sources = [
			{ layer: "admin", path: this.adminPolicyPath, rules: admin.rules, allowedSources: admin.allowedSources },
			{ layer: "user", path: userPath, rules: user.rules, allowedSources: user.allowedSources },
			{ layer: "workspace", path: workspacePath, rules: workspace.rules, allowedSources: workspace.allowedSources },
			buildDefaultRuleSet(),
			{ layer: "legacy", rules: legacyRules, allowedSources: [] },
		];
	}

	getSources(): PolicySource[] {
		return this.sources.map((source) => ({
			layer: source.layer,
			path: source.path,
			rules: source.rules.map((rule) => ({ ...rule })),
			allowedSources: [...source.allowedSources],
		}));
	}

	getAllowedSourceHosts(): string[] {
		const merged = new Set<string>();
		for (const source of this.sources) {
			for (const host of source.allowedSources) {
				merged.add(host.toLowerCase());
			}
		}
		return [...merged];
	}

	getLegacyRules(effect: "allow" | "deny"): string[] {
		const values: string[] = [];
		for (const source of this.sources) {
			if (source.layer !== "user") continue;
			for (const rule of source.rules) {
				if (rule.effect !== effect) continue;
				if (rule.legacyRule && rule.legacyRule.trim().length > 0) {
					values.push(rule.legacyRule.trim());
				}
			}
		}
		return values;
	}

	setLegacyRules(effect: "allow" | "deny", rawRules: string[]): void {
		const path = join(this.agentDir, "policy.toml");
		const file = this.readMutablePolicy(path);
		const keep = file.rules
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry }) => {
				const rule = normalizeRule(entry, 0);
				if (!rule) return true;
				if (rule.effect !== effect) return true;
				return !rule.legacyRule;
			})
			.map(({ entry }) => entry);
		const nextRules: Array<Record<string, unknown>> = [...keep];
		let counter = 1;
		for (const raw of rawRules) {
			const normalized = raw.trim();
			if (!normalized || !normalized.includes(":")) continue;
			const [toolRaw, ...rest] = normalized.split(":");
			const tool = toolRaw.trim() || "*";
			const needle = rest.join(":").trim();
			const rule: PolicyRuleV2 = {
				id: `legacy-${effect}-${counter}`,
				enabled: true,
				effect,
				priority: 1000 - counter,
				tools: [tool],
				checker: needle ? `summary_contains:${needle}` : undefined,
				legacyRule: `${tool}:${needle}`,
			};
			nextRules.push(toTomlRule(rule));
			counter += 1;
		}
		file.rules = nextRules;
		this.writeMutablePolicy(path, file);
		this.refresh();
	}

	addLegacyRule(effect: "allow" | "deny", rawRule: string): boolean {
		const normalized = rawRule.trim();
		if (!normalized || !normalized.includes(":")) return false;
		const existing = new Set(this.getLegacyRules(effect));
		if (existing.has(normalized)) return false;
		this.setLegacyRules(effect, [...existing, normalized]);
		return true;
	}

	removeLegacyRule(effect: "allow" | "deny", rawRule: string): boolean {
		const normalized = rawRule.trim();
		if (!normalized) return false;
		const current = this.getLegacyRules(effect);
		const next = current.filter((rule) => rule !== normalized);
		if (next.length === current.length) return false;
		this.setLegacyRules(effect, next);
		return true;
	}

	evaluate(request: ToolPermissionRequest, context: PolicyEvaluationContext = {}): PolicyDecision {
		const decorated: Array<{
			layer: PolicyLayer;
			rule: PolicyRuleV2;
			layerRank: number;
			order: number;
		}> = [];
		let order = 0;
		for (const source of this.sources) {
			for (const rule of source.rules) {
				decorated.push({
					layer: source.layer,
					rule,
					layerRank: getLayerRank(source.layer),
					order: order++,
				});
			}
		}

		decorated.sort((a, b) => {
			if (a.layerRank !== b.layerRank) return a.layerRank - b.layerRank;
			if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
			return a.order - b.order;
		});

		for (const entry of decorated) {
			const rule = entry.rule;
			if (!rule.enabled) continue;
			if (!this.matchesRule(rule, request, context)) continue;
			return {
				effect: rule.effect,
				matched: true,
				reason: `Matched policy rule ${rule.id} (${entry.layer})`,
				rule,
				layer: entry.layer,
			};
		}

		return {
			effect: "ask",
			matched: false,
			reason: "No policy rule matched.",
		};
	}

	private matchesRule(rule: PolicyRuleV2, request: ToolPermissionRequest, context: PolicyEvaluationContext): boolean {
		if (!this.matchesTools(rule, request)) return false;
		if (rule.toolSource && rule.toolSource.length > 0) {
			const source = request.toolSource ?? "builtin";
			if (!rule.toolSource.includes(source)) return false;
		}
		if (rule.mcpName && rule.mcpName.length > 0) {
			const serverName = request.mcpServerName?.trim();
			if (!serverName) return false;
			if (!rule.mcpName.some((candidate) => candidate === "*" || candidate === serverName)) return false;
		}
		if (rule.profiles && rule.profiles.length > 0) {
			const profile = context.profile?.trim();
			if (!profile) return false;
			if (!rule.profiles.some((candidate) => candidate === "*" || candidate === profile)) return false;
		}
		if (rule.cwdGlob && rule.cwdGlob.length > 0) {
			if (!rule.cwdGlob.some((glob) => minimatch(request.cwd, glob, { dot: true }))) return false;
		}
		if (rule.argsPattern && !this.matchesArgsPattern(rule.argsPattern, request)) {
			return false;
		}
		if (rule.checker && !this.matchesChecker(rule.checker, request)) {
			return false;
		}
		return true;
	}

	private matchesTools(rule: PolicyRuleV2, request: ToolPermissionRequest): boolean {
		const toolCandidates = [request.toolName];
		if (request.toolSource === "mcp") {
			if (request.mcpToolName) toolCandidates.push(request.mcpToolName);
		}
		return rule.tools.some((pattern) => {
			if (pattern === "*") return true;
			return toolCandidates.some((toolName) => minimatch(toolName, pattern));
		});
	}

	private matchesArgsPattern(pattern: string, request: ToolPermissionRequest): boolean {
		const haystack = `${request.summary}\n${this.serializeInput(request.input)}`;
		try {
			const regex = new RegExp(pattern, "i");
			return regex.test(haystack);
		} catch {
			return false;
		}
	}

	private matchesChecker(checker: string, request: ToolPermissionRequest): boolean {
		const trimmed = checker.trim();
		if (trimmed.length === 0) return true;
		if (trimmed.startsWith("summary_contains:")) {
			const needle = trimmed.slice("summary_contains:".length).trim().toLowerCase();
			if (!needle) return true;
			return request.summary.toLowerCase().includes(needle);
		}
		if (trimmed.startsWith("summary_regex:")) {
			const pattern = trimmed.slice("summary_regex:".length).trim();
			if (!pattern) return true;
			try {
				return new RegExp(pattern, "i").test(request.summary);
			} catch {
				return false;
			}
		}
		if (trimmed.startsWith("legacy_substring:")) {
			const needle = trimmed.slice("legacy_substring:".length).trim().toLowerCase();
			return !needle || request.summary.toLowerCase().includes(needle);
		}
		if (trimmed.startsWith("tool_exact:")) {
			const expected = trimmed.slice("tool_exact:".length).trim();
			return !expected || request.toolName === expected;
		}
		if (trimmed.startsWith("args_regex:")) {
			const pattern = trimmed.slice("args_regex:".length).trim();
			try {
				return new RegExp(pattern, "i").test(this.serializeInput(request.input));
			} catch {
				return false;
			}
		}
		return false;
	}

	private serializeInput(input: Record<string, unknown>): string {
		try {
			return JSON.stringify(input);
		} catch {
			return "";
		}
	}

	private readMutablePolicy(path: string): MutablePolicyToml {
		if (!existsSync(path)) {
			return {
				version: 2,
				allowed_sources: [...DEFAULT_ALLOWED_SOURCES],
				rules: [],
			};
		}
		const raw = readFileSync(path, "utf8");
		const parsed = TOML.parse(raw) as ParsedPolicyToml;
		const rules = Array.isArray(parsed.rules)
			? parsed.rules.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
			: [];
		return {
			...parsed,
			version: typeof parsed.version === "number" ? parsed.version : 2,
			allowed_sources: normalizeStringArray(parsed.allowed_sources),
			rules,
		};
	}

	private writeMutablePolicy(path: string, file: MutablePolicyToml): void {
		const dir = dirname(path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const content = TOML.stringify(file as Parameters<typeof TOML.stringify>[0]);
		writeFileSync(path, content, "utf8");
	}
}

export interface PermissionEvaluationResult {
	outcome: "allow" | "deny" | "ask";
	decision: PolicyDecision;
	reason: string;
}

const DANGEROUS_TOOL_NAMES = new Set(["bash", "edit", "write", "apply_patch", "git_write", "fs_ops", "db_run"]);

export function evaluatePermissionWithPolicy(
	engine: PolicyEngineV2,
	request: ToolPermissionRequest,
	context: {
		profile?: string;
		runtimeMode: "interactive" | "rpc";
		permissionMode: "ask" | "auto" | "yolo";
		strictExtensionToolEnforcement?: boolean;
	},
): PermissionEvaluationResult {
	const policyDecision = engine.evaluate(request, { profile: context.profile });
	const isMcpRequest = request.toolSource === "mcp";
	const mcpApprovalMode = isMcpRequest ? (request.mcpApprovalMode ?? "auto") : "auto";
	if (policyDecision.effect === "deny") {
		return {
			outcome: "deny",
			decision: policyDecision,
			reason: policyDecision.reason,
		};
	}

	if (isMcpRequest && mcpApprovalMode === "prompt") {
		return {
			outcome: "ask",
			decision: policyDecision,
			reason: "MCP tool approval mode is prompt; confirmation required.",
		};
	}

	if (isMcpRequest && mcpApprovalMode === "approve") {
		if (!request.mcpServerTrusted) {
			return {
				outcome: "ask",
				decision: policyDecision,
				reason: "MCP server is untrusted. approvalMode=approve requires trusted server.",
			};
		}
		return {
			outcome: "allow",
			decision: policyDecision,
			reason:
				policyDecision.effect === "allow"
					? policyDecision.reason
					: "MCP tool approval mode is approve on trusted server.",
		};
	}

	if (policyDecision.effect === "allow") {
		if (isMcpRequest) {
			const explicitMcpRule =
				Boolean(policyDecision.rule?.mcpName && policyDecision.rule.mcpName.length > 0) &&
				Boolean(policyDecision.rule?.tools && policyDecision.rule.tools.some((tool) => tool !== "*"));
			if (!request.mcpServerTrusted) {
				return {
					outcome: "ask",
					decision: policyDecision,
					reason: "MCP server is untrusted. Explicit allow requires trusted server for bypass.",
				};
			}
			if (!explicitMcpRule) {
				return {
					outcome: "ask",
					decision: policyDecision,
					reason: "MCP allow rule is not explicit (mcp_name + specific tool required).",
				};
			}
		}
		return {
			outcome: "allow",
			decision: policyDecision,
			reason: policyDecision.reason,
		};
	}

	if (isMcpRequest) {
		return {
			outcome: "ask",
			decision: policyDecision,
			reason: "MCP calls require explicit allow policy.",
		};
	}

	if (context.strictExtensionToolEnforcement && request.toolSource === "extension" && context.permissionMode === "auto") {
		if (request.requiredPermission === "read-only") {
			return {
				outcome: "allow",
				decision: policyDecision,
				reason: "Auto mode allows read-only extension tools.",
			};
		}
		if (!request.requiredPermission) {
			return {
				outcome: "deny",
				decision: policyDecision,
				reason: "Extension tool lacks requiredPermission metadata.",
			};
		}
	}

	if (context.permissionMode === "yolo") {
		return {
			outcome: "allow",
			decision: policyDecision,
			reason: "Permission mode is yolo.",
		};
	}

	if (
		context.permissionMode === "auto" &&
		(request.toolName === "edit" || request.toolName === "write" || request.toolName === "apply_patch")
	) {
		return {
			outcome: "allow",
			decision: policyDecision,
			reason: "Auto mode allows edit/write/apply_patch.",
		};
	}

	if (context.runtimeMode === "rpc" && !DANGEROUS_TOOL_NAMES.has(request.toolName)) {
		return {
			outcome: "allow",
			decision: policyDecision,
			reason: "RPC mode auto-approves non-dangerous tools.",
		};
	}

	return {
		outcome: "ask",
		decision: policyDecision,
		reason: "No policy allow/deny matched; confirmation required.",
	};
}

export function buildLegacyRulePattern(rawRule: string): string {
	const normalized = rawRule.trim();
	const [toolRaw, ...rest] = normalized.split(":");
	const tool = toolRaw.trim() || "*";
	const needle = rest.join(":").trim();
	const checker = needle.length > 0 ? `summary_contains:${needle}` : "summary_contains:";
	return `${tool}:${checker.replace(/^summary_contains:/, "")}`;
}

export function legacyRuleToChecker(rawRule: string): string | undefined {
	const normalized = rawRule.trim();
	const [, ...rest] = normalized.split(":");
	const needle = rest.join(":").trim();
	if (!needle) return undefined;
	return `summary_contains:${escapeRegExp(needle)}`;
}

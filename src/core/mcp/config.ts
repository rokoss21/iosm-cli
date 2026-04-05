import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
	McpConfigFile,
	McpMergedConfig,
	McpResolvedServerConfig,
	McpResolvedServerToolConfig,
	McpScope,
	McpScopeTarget,
	McpScopedLoadResult,
	McpServerConfig,
	McpServerToolConfig,
	McpTransport,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const VALID_SERVER_NAME = /^[a-zA-Z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function sanitizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
	return [...new Set(normalized.filter((item) => item.length > 0))];
}

function asMcpToolApprovalMode(value: unknown): McpResolvedServerToolConfig["approvalMode"] | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto" || normalized === "prompt" || normalized === "approve") {
		return normalized;
	}
	return undefined;
}

function sanitizeToolsConfig(value: unknown): Record<string, McpServerToolConfig> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, McpServerToolConfig> = {};
	for (const [toolName, rawConfig] of Object.entries(value)) {
		const name = toolName.trim();
		if (!name) continue;
		if (!isRecord(rawConfig)) continue;
		const approvalMode = asMcpToolApprovalMode(rawConfig.approvalMode);
		if (!approvalMode) continue;
		result[name] = { approvalMode };
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeResolvedToolsConfig(
	value: Record<string, McpServerToolConfig> | undefined,
): Record<string, McpResolvedServerToolConfig> {
	const result: Record<string, McpResolvedServerToolConfig> = {};
	if (!value) return result;
	for (const [toolName, config] of Object.entries(value)) {
		const name = toolName.trim();
		if (!name) continue;
		const approvalMode = asMcpToolApprovalMode(config.approvalMode);
		if (!approvalMode) continue;
		result[name] = { approvalMode };
	}
	return result;
}

function sanitizeStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		if (typeof rawValue !== "string") continue;
		result[key] = rawValue;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTimeout(rawTimeout: unknown): number {
	if (typeof rawTimeout !== "number" || Number.isNaN(rawTimeout)) {
		return DEFAULT_TIMEOUT_MS;
	}
	const normalized = Math.floor(rawTimeout);
	if (normalized < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
	if (normalized > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
	return normalized;
}

function isValidTransport(value: unknown): value is McpTransport {
	return value === "stdio" || value === "sse" || value === "http";
}

export function expandEnvTemplate(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, varName, _defaultGroup, defaultValue) => {
		const envValue = env[varName];
		if (envValue !== undefined) return envValue;
		return defaultValue ?? "";
	});
}

export function getMcpConfigPath(scope: McpScope, cwd: string, agentDir: string): string {
	return scope === "project" ? join(cwd, ".mcp.json") : join(agentDir, "mcp.json");
}

function parseMcpConfigFile(path: string): McpConfigFile {
	if (!existsSync(path)) {
		return {};
	}
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`Expected JSON object in ${path}`);
	}

	const result: McpConfigFile = { ...parsed };
	if ("mcpServers" in parsed) {
		if (!isRecord(parsed.mcpServers)) {
			throw new Error(`"mcpServers" must be an object in ${path}`);
		}
		const normalizedServers: Record<string, McpServerConfig> = {};
		for (const [name, server] of Object.entries(parsed.mcpServers)) {
			if (!isRecord(server)) continue;
			normalizedServers[name] = {
				transport: isValidTransport(server.transport) ? server.transport : undefined,
				command: asString(server.command),
				args: sanitizeStringArray(server.args),
				env: sanitizeStringRecord(server.env),
				cwd: asString(server.cwd),
				url: asString(server.url),
				httpUrl: asString(server.httpUrl),
				headers: sanitizeStringRecord(server.headers),
				timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
				enabled: asBoolean(server.enabled),
				trust: asBoolean(server.trust),
				includeTools: sanitizeStringArray(server.includeTools),
				excludeTools: sanitizeStringArray(server.excludeTools),
				tools: sanitizeToolsConfig(server.tools),
			};
		}
		result.mcpServers = normalizedServers;
	}

	return result;
}

export function readScopedMcpConfig(scope: McpScope, cwd: string, agentDir: string): McpScopedLoadResult {
	const path = getMcpConfigPath(scope, cwd, agentDir);
	try {
		return {
			scope,
			path,
			file: parseMcpConfigFile(path),
		};
	} catch (error) {
		return {
			scope,
			path,
			file: {},
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

function resolveScopeBaseDir(scope: McpScope, cwd: string, agentDir: string): string {
	return scope === "project" ? cwd : agentDir;
}

function normalizeServerConfig(
	name: string,
	rawConfig: McpServerConfig,
	scope: McpScope,
	cwd: string,
	agentDir: string,
	env: NodeJS.ProcessEnv,
): McpResolvedServerConfig {
	if (!VALID_SERVER_NAME.test(name)) {
		throw new Error(`Invalid server name "${name}". Use letters, numbers, '.', '_' or '-'.`);
	}

	const baseDir = resolveScopeBaseDir(scope, cwd, agentDir);
	const expandedCommand = rawConfig.command ? expandEnvTemplate(rawConfig.command, env).trim() : undefined;
	const expandedArgs = (rawConfig.args ?? []).map((arg) => expandEnvTemplate(arg, env));
	const expandedEnv = rawConfig.env
		? Object.fromEntries(Object.entries(rawConfig.env).map(([key, value]) => [key, expandEnvTemplate(value, env)]))
		: undefined;
	const expandedHeaders = rawConfig.headers
		? Object.fromEntries(Object.entries(rawConfig.headers).map(([key, value]) => [key, expandEnvTemplate(value, env)]))
		: undefined;
	const expandedUrlRaw = rawConfig.url ?? rawConfig.httpUrl;
	const expandedUrl = expandedUrlRaw ? expandEnvTemplate(expandedUrlRaw, env).trim() : undefined;
	const expandedCwdRaw = rawConfig.cwd ? expandEnvTemplate(rawConfig.cwd, env).trim() : undefined;
	const expandedCwd = expandedCwdRaw
		? isAbsolute(expandedCwdRaw)
			? expandedCwdRaw
			: resolve(baseDir, expandedCwdRaw)
		: undefined;

	let transport: McpTransport;
	if (isValidTransport(rawConfig.transport)) {
		transport = rawConfig.transport;
	} else if (expandedCommand) {
		transport = "stdio";
	} else {
		transport = "http";
	}

	if (transport === "stdio" && !expandedCommand) {
		throw new Error(`Server "${name}": stdio transport requires "command".`);
	}
	if ((transport === "http" || transport === "sse") && !expandedUrl) {
		throw new Error(`Server "${name}": ${transport} transport requires "url".`);
	}

	return {
		name,
		scope,
		transport,
		command: expandedCommand,
		args: expandedArgs,
		env: expandedEnv,
		cwd: expandedCwd,
		url: expandedUrl,
		headers: expandedHeaders,
		timeoutMs: normalizeTimeout(rawConfig.timeoutMs),
		enabled: rawConfig.enabled ?? true,
		trust: rawConfig.trust ?? false,
		includeTools: sanitizeStringArray(rawConfig.includeTools),
		excludeTools: sanitizeStringArray(rawConfig.excludeTools),
		tools: normalizeResolvedToolsConfig(rawConfig.tools),
	};
}

export function loadMergedMcpConfig(
	cwd: string,
	agentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): McpMergedConfig {
	const scoped = [readScopedMcpConfig("user", cwd, agentDir), readScopedMcpConfig("project", cwd, agentDir)];
	const errors: string[] = [];

	for (const entry of scoped) {
		if (entry.error) {
			errors.push(`${entry.scope} config (${entry.path}): ${entry.error.message}`);
		}
	}

	const merged = new Map<string, McpResolvedServerConfig>();
	for (const entry of scoped) {
		const servers = entry.file.mcpServers ?? {};
		for (const [name, config] of Object.entries(servers)) {
			try {
				const normalized = normalizeServerConfig(name, config, entry.scope, cwd, agentDir, env);
				merged.set(name, normalized);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${entry.scope} server "${name}": ${message}`);
			}
		}
	}

	return {
		servers: [...merged.values()],
		errors,
		scoped,
	};
}

function cleanServerConfigForSave(config: McpServerConfig): McpServerConfig {
	const cleaned: McpServerConfig = {};
	if (config.transport) cleaned.transport = config.transport;
	if (config.command) cleaned.command = config.command;
	if (config.args && config.args.length > 0) cleaned.args = [...config.args];
	if (config.env && Object.keys(config.env).length > 0) cleaned.env = { ...config.env };
	if (config.cwd) cleaned.cwd = config.cwd;
	if (config.url) cleaned.url = config.url;
	if (config.httpUrl) cleaned.httpUrl = config.httpUrl;
	if (config.headers && Object.keys(config.headers).length > 0) cleaned.headers = { ...config.headers };
	if (config.timeoutMs !== undefined) cleaned.timeoutMs = config.timeoutMs;
	if (config.enabled !== undefined) cleaned.enabled = config.enabled;
	if (config.trust !== undefined) cleaned.trust = config.trust;
	if (config.includeTools && config.includeTools.length > 0) cleaned.includeTools = [...config.includeTools];
	if (config.excludeTools && config.excludeTools.length > 0) cleaned.excludeTools = [...config.excludeTools];
	if (config.tools) {
		const tools: Record<string, McpServerToolConfig> = {};
		for (const [toolName, toolConfig] of Object.entries(config.tools)) {
			const approvalMode = asMcpToolApprovalMode(toolConfig.approvalMode);
			if (!approvalMode) continue;
			tools[toolName] = { approvalMode };
		}
		if (Object.keys(tools).length > 0) {
			cleaned.tools = tools;
		}
	}
	return cleaned;
}

export function writeScopedMcpConfig(scope: McpScope, file: McpConfigFile, cwd: string, agentDir: string): string {
	const path = getMcpConfigPath(scope, cwd, agentDir);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	return path;
}

function updateScopedMcpConfig(
	scope: McpScope,
	cwd: string,
	agentDir: string,
	updater: (file: McpConfigFile) => McpConfigFile,
): string {
	const loaded = readScopedMcpConfig(scope, cwd, agentDir);
	if (loaded.error) {
		throw new Error(`Cannot update ${scope} MCP config (${loaded.path}): ${loaded.error.message}`);
	}
	return writeScopedMcpConfig(scope, updater(loaded.file), cwd, agentDir);
}

export function upsertScopedMcpServer(
	scope: McpScope,
	name: string,
	server: McpServerConfig,
	cwd: string,
	agentDir: string,
): string {
	if (!VALID_SERVER_NAME.test(name)) {
		throw new Error(`Invalid server name "${name}". Use letters, numbers, '.', '_' or '-'.`);
	}
	return updateScopedMcpConfig(scope, cwd, agentDir, (file) => {
		const next: McpConfigFile = { ...file };
		const servers = { ...(next.mcpServers ?? {}) };
		servers[name] = cleanServerConfigForSave(server);
		next.mcpServers = servers;
		return next;
	});
}

export function removeMcpServer(
	name: string,
	scope: McpScopeTarget,
	cwd: string,
	agentDir: string,
): McpScope[] {
	const scopes: McpScope[] = scope === "all" ? ["project", "user"] : [scope];
	const removedFrom: McpScope[] = [];

	for (const currentScope of scopes) {
		const loaded = readScopedMcpConfig(currentScope, cwd, agentDir);
		if (loaded.error) {
			continue;
		}
		const servers = { ...(loaded.file.mcpServers ?? {}) };
		if (!(name in servers)) {
			continue;
		}
		delete servers[name];
		const next: McpConfigFile = { ...loaded.file, mcpServers: servers };
		writeScopedMcpConfig(currentScope, next, cwd, agentDir);
		removedFrom.push(currentScope);
	}

	return removedFrom;
}

function findServerScopeOrder(name: string, cwd: string, agentDir: string): McpScope[] {
	const order: McpScope[] = [];
	for (const scope of ["project", "user"] as const) {
		const loaded = readScopedMcpConfig(scope, cwd, agentDir);
		if (loaded.error) continue;
		if ((loaded.file.mcpServers ?? {})[name]) {
			order.push(scope);
		}
	}
	return order;
}

export function setMcpServerEnabled(
	name: string,
	enabled: boolean,
	scope: McpScope | "auto",
	cwd: string,
	agentDir: string,
): McpScope | undefined {
	const targetScope =
		scope === "auto"
			? (findServerScopeOrder(name, cwd, agentDir)[0] ?? undefined)
			: scope;
	if (!targetScope) return undefined;

	const loaded = readScopedMcpConfig(targetScope, cwd, agentDir);
	if (loaded.error) {
		throw new Error(`Cannot update ${targetScope} MCP config (${loaded.path}): ${loaded.error.message}`);
	}

	const servers = { ...(loaded.file.mcpServers ?? {}) };
	const existing = servers[name];
	if (!existing) return undefined;
	servers[name] = { ...existing, enabled };
	writeScopedMcpConfig(targetScope, { ...loaded.file, mcpServers: servers }, cwd, agentDir);
	return targetScope;
}

export function getMergedServerByName(name: string, cwd: string, agentDir: string): McpResolvedServerConfig | undefined {
	const merged = loadMergedMcpConfig(cwd, agentDir);
	return merged.servers.find((server) => server.name === name);
}

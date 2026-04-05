import type { McpScope, McpScopeTarget, McpServerConfig, McpTransport } from "./types.js";

export interface ParsedMcpAddCommand {
	name: string;
	scope: McpScope;
	config: McpServerConfig;
}

export interface ParsedMcpTargetCommand {
	name: string;
	scope: McpScopeTarget;
}

export interface McpCommandHelpOptions {
	includeWizard?: boolean;
}

export type ParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string }
	| { ok: false; help: true };

const VALID_TRANSPORTS = new Set<McpTransport>(["stdio", "sse", "http"]);
const VALID_SCOPES = new Set<McpScopeTarget>(["user", "project", "all"]);
const VALID_SERVER_NAME = /^[a-zA-Z0-9._-]+$/;
const VALID_APPROVAL_MODES = new Set(["auto", "prompt", "approve"]);

function parseKeyValue(token: string, flagName: string): { key: string; value: string } | { error: string } {
	const separatorIndex = token.indexOf("=");
	if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
		return { error: `${flagName} expects KEY=VALUE` };
	}
	const key = token.slice(0, separatorIndex).trim();
	const value = token.slice(separatorIndex + 1);
	if (!key) {
		return { error: `${flagName} expects KEY=VALUE` };
	}
	return { key, value };
}

function normalizeScope(value: string): McpScopeTarget | undefined {
	return VALID_SCOPES.has(value as McpScopeTarget) ? (value as McpScopeTarget) : undefined;
}

function normalizeToolApprovalMode(value: string): "auto" | "prompt" | "approve" | undefined {
	const normalized = value.trim().toLowerCase();
	return VALID_APPROVAL_MODES.has(normalized) ? (normalized as "auto" | "prompt" | "approve") : undefined;
}

export function parseMcpTargetCommand(args: string[], defaultScope: McpScopeTarget = "all"): ParseResult<ParsedMcpTargetCommand> {
	if (args.length === 0) {
		return { ok: false, error: "Missing server name." };
	}
	const [name, ...rest] = args;
	if (!VALID_SERVER_NAME.test(name)) {
		return { ok: false, error: `Invalid server name "${name}".` };
	}

	let scope: McpScopeTarget = defaultScope;
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (token === "-h" || token === "--help") {
			return { ok: false, help: true };
		}
		if (token === "--scope") {
			const value = rest[index + 1];
			if (!value) {
				return { ok: false, error: "Missing value for --scope." };
			}
			const normalized = normalizeScope(value);
			if (!normalized) {
				return { ok: false, error: `Invalid scope "${value}". Use user, project, or all.` };
			}
			scope = normalized;
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			return { ok: false, error: `Unknown option ${token}.` };
		}
		return { ok: false, error: `Unexpected argument "${token}".` };
	}

	return { ok: true, value: { name, scope } };
}

export function parseMcpAddCommand(args: string[]): ParseResult<ParsedMcpAddCommand> {
	if (args.length === 0) {
		return { ok: false, error: "Missing server name." };
	}
	if (args[0] === "-h" || args[0] === "--help") {
		return { ok: false, help: true };
	}

	const [name, ...rest] = args;
	if (!VALID_SERVER_NAME.test(name)) {
		return { ok: false, error: `Invalid server name "${name}".` };
	}

	let scope: McpScope = "project";
	let transport: McpTransport | undefined;
	let command: string | undefined;
	let url: string | undefined;
	let cwd: string | undefined;
	let timeoutMs: number | undefined;
	let trust: boolean | undefined;
	let enabled: boolean | undefined;
	const commandArgs: string[] = [];
	const includeTools: string[] = [];
	const excludeTools: string[] = [];
	const toolApprovals: NonNullable<McpServerConfig["tools"]> = {};
	const env: Record<string, string> = {};
	const headers: Record<string, string> = {};
	const positional: string[] = [];

	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (token === "-h" || token === "--help") {
			return { ok: false, help: true };
		}
		if (token === "--scope") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --scope." };
			if (value !== "user" && value !== "project") {
				return { ok: false, error: `Invalid scope "${value}". Use user or project.` };
			}
			scope = value;
			index += 1;
			continue;
		}
		if (token === "--transport") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --transport." };
			if (!VALID_TRANSPORTS.has(value as McpTransport)) {
				return { ok: false, error: `Invalid transport "${value}". Use stdio, sse, or http.` };
			}
			transport = value as McpTransport;
			index += 1;
			continue;
		}
		if (token === "--command") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --command." };
			command = value;
			index += 1;
			continue;
		}
		if (token === "--url" || token === "--http-url") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: `Missing value for ${token}.` };
			url = value;
			index += 1;
			continue;
		}
		if (token === "--cwd") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --cwd." };
			cwd = value;
			index += 1;
			continue;
		}
		if (token === "--arg") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --arg." };
			commandArgs.push(value);
			index += 1;
			continue;
		}
		if (token === "--env") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --env." };
			const parsed = parseKeyValue(value, "--env");
			if ("error" in parsed) return { ok: false, error: parsed.error };
			env[parsed.key] = parsed.value;
			index += 1;
			continue;
		}
		if (token === "--header") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --header." };
			const parsed = parseKeyValue(value, "--header");
			if ("error" in parsed) return { ok: false, error: parsed.error };
			headers[parsed.key] = parsed.value;
			index += 1;
			continue;
		}
		if (token === "--timeout") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --timeout." };
			const parsed = Number.parseInt(value, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return { ok: false, error: "--timeout expects a positive integer (milliseconds)." };
			}
			timeoutMs = parsed;
			index += 1;
			continue;
		}
		if (token === "--trust") {
			trust = true;
			continue;
		}
		if (token === "--no-trust") {
			trust = false;
			continue;
		}
		if (token === "--enable") {
			enabled = true;
			continue;
		}
		if (token === "--disable") {
			enabled = false;
			continue;
		}
		if (token === "--include-tool") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --include-tool." };
			includeTools.push(value);
			index += 1;
			continue;
		}
		if (token === "--exclude-tool") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --exclude-tool." };
			excludeTools.push(value);
			index += 1;
			continue;
		}
		if (token === "--tool-approval") {
			const value = rest[index + 1];
			if (!value) return { ok: false, error: "Missing value for --tool-approval." };
			const parsed = parseKeyValue(value, "--tool-approval");
			if ("error" in parsed) return { ok: false, error: parsed.error };
			const mode = normalizeToolApprovalMode(parsed.value);
			if (!mode) {
				return {
					ok: false,
					error: `Invalid --tool-approval mode "${parsed.value}". Use auto, prompt, or approve.`,
				};
			}
			toolApprovals[parsed.key] = { approvalMode: mode };
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			return { ok: false, error: `Unknown option ${token}.` };
		}
		positional.push(token);
	}

	if (!command && !url && positional.length > 0) {
		command = positional[0];
		commandArgs.push(...positional.slice(1));
	} else if (command && positional.length > 0) {
		commandArgs.push(...positional);
	} else if (!command && !url && positional.length === 0) {
		// noop
	} else if (url && positional.length > 0) {
		return { ok: false, error: `Unexpected positional arguments: ${positional.join(" ")}` };
	}

	const resolvedTransport: McpTransport = transport ?? (command ? "stdio" : "http");
	if (resolvedTransport === "stdio" && !command) {
		return { ok: false, error: "stdio transport requires --command (or positional command)." };
	}
	if ((resolvedTransport === "http" || resolvedTransport === "sse") && !url) {
		return { ok: false, error: `${resolvedTransport} transport requires --url.` };
	}

	const config: McpServerConfig = {
		transport: resolvedTransport,
		command,
		args: commandArgs,
		url,
		cwd,
		timeoutMs,
		trust,
		enabled,
		includeTools: includeTools.length > 0 ? includeTools : undefined,
		excludeTools: excludeTools.length > 0 ? excludeTools : undefined,
		tools: Object.keys(toolApprovals).length > 0 ? toolApprovals : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
	};

	return {
		ok: true,
		value: {
			name,
			scope,
			config,
		},
	};
}

export function getMcpCommandHelp(prefix: string, options: McpCommandHelpOptions = {}): string {
	const cmd = prefix.trim();
	const lines = [
		`Usage:`,
		`  ${cmd} list`,
		`  ${cmd} get <name>`,
		`  ${cmd} add [name] [--scope user|project] [--transport stdio|sse|http]`,
		`  ${cmd} remove <name> [--scope user|project|all]`,
		`  ${cmd} enable <name> [--scope user|project|all]`,
		`  ${cmd} disable <name> [--scope user|project|all]`,
		`  ${cmd} tools [name]`,
		`  ${cmd} test <name>`,
		"",
		`Examples:`,
		`  ${cmd} add filesystem --transport stdio --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg .`,
		`  ${cmd} add github --scope user --transport http --url https://mcp.example.com --header Authorization=Bearer\ \${GITHUB_TOKEN}`,
		`  ${cmd} add github --transport http --url https://mcp.example.com --tool-approval search=prompt`,
		`  ${cmd} disable filesystem --scope project`,
		`  ${cmd} tools`,
	];

	if (options.includeWizard) {
		lines.splice(10, 0, `  ${cmd} add --wizard`);
	}

	return lines.join("\n");
}

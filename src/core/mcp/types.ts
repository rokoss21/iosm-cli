import type { ToolDefinition } from "../extensions/index.js";
import type { McpToolApprovalMode, ToolPermissionRequest } from "../tools/permissions.js";

export type McpScope = "user" | "project";
export type McpScopeTarget = McpScope | "all";
export type McpTransport = "stdio" | "sse" | "http";

export interface McpServerToolConfig {
	approvalMode?: McpToolApprovalMode;
}

export interface McpResolvedServerToolConfig {
	approvalMode: McpToolApprovalMode;
}

export interface McpServerConfig {
	transport?: McpTransport;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	httpUrl?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	enabled?: boolean;
	trust?: boolean;
	includeTools?: string[];
	excludeTools?: string[];
	tools?: Record<string, McpServerToolConfig>;
}

export interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
	[key: string]: unknown;
}

export interface McpResolvedServerConfig {
	name: string;
	scope: McpScope;
	transport: McpTransport;
	command?: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	timeoutMs: number;
	enabled: boolean;
	trust: boolean;
	includeTools: string[];
	excludeTools: string[];
	tools: Record<string, McpResolvedServerToolConfig>;
}

export type McpConnectionState = "disabled" | "connecting" | "connected" | "error";

export interface McpToolDescriptor {
	name: string;
	exposedName: string;
	description?: string;
}

export interface McpServerStatus {
	name: string;
	scope: McpScope;
	transport: McpTransport;
	enabled: boolean;
	state: McpConnectionState;
	error?: string;
	trust: boolean;
	toolCount: number;
	tools: McpToolDescriptor[];
}

export interface McpScopedLoadResult {
	scope: McpScope;
	path: string;
	file: McpConfigFile;
	error?: Error;
}

export interface McpMergedConfig {
	servers: McpResolvedServerConfig[];
	errors: string[];
	scoped: McpScopedLoadResult[];
}

export interface McpToolDefinitionEntry {
	serverName: string;
	sourceToolName: string;
	exposedToolName: string;
	definition: ToolDefinition;
}

export interface McpPermissionDecision {
	allowed: boolean;
	reason?: string;
	effect?: "allow" | "deny" | "ask";
	ruleId?: string;
	policyLayer?: string;
	approvalMode?: McpToolApprovalMode;
}

export interface McpPolicyDecisionTraceEvent {
	serverName: string;
	sourceToolName: string;
	exposedToolName: string;
	allowed: boolean;
	trusted: boolean;
	approvalMode?: McpToolApprovalMode;
	reason?: string;
	effect?: "allow" | "deny" | "ask";
	ruleId?: string;
	policyLayer?: string;
}

export type McpPermissionGuard = (
	request: ToolPermissionRequest,
) => Promise<boolean | McpPermissionDecision> | boolean | McpPermissionDecision;

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { type TSchema, Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/index.js";
import type { ToolPermissionRequest } from "../tools/permissions.js";
import {
	loadMergedMcpConfig,
	removeMcpServer,
	setMcpServerEnabled,
	upsertScopedMcpServer,
} from "./config.js";
import type {
	McpConnectionState,
	McpPermissionDecision,
	McpPermissionGuard,
	McpPolicyDecisionTraceEvent,
	McpResolvedServerConfig,
	McpScope,
	McpScopeTarget,
	McpServerConfig,
	McpServerStatus,
	McpToolDefinitionEntry,
	McpToolDescriptor,
} from "./types.js";

interface RuntimeToolRecord {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	exposedName: string;
	approvalMode: "auto" | "prompt" | "approve";
}

interface RuntimeServerRecord {
	config: McpResolvedServerConfig;
	state: McpConnectionState;
	error?: string;
	client?: Client;
	tools: RuntimeToolRecord[];
}

interface NormalizeResult {
	content: Array<TextContent | ImageContent>;
	isError: boolean;
	errorMessage?: string;
}

export interface McpRuntimeOptions {
	cwd: string;
	agentDir: string;
	clientName: string;
	clientVersion: string;
	onPolicyDecision?: (event: McpPolicyDecisionTraceEvent) => void;
}

export class McpRuntime {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly clientName: string;
	private readonly clientVersion: string;
	private servers = new Map<string, RuntimeServerRecord>();
	private toolDefinitions: McpToolDefinitionEntry[] = [];
	private configErrors: string[] = [];
	private permissionGuard?: McpPermissionGuard;
	private readonly onPolicyDecision?: (event: McpPolicyDecisionTraceEvent) => void;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: McpRuntimeOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.clientName = options.clientName;
		this.clientVersion = options.clientVersion;
		this.onPolicyDecision = options.onPolicyDecision;
	}

	setPermissionGuard(guard?: McpPermissionGuard): void {
		this.permissionGuard = guard;
	}

	getErrors(): string[] {
		return [...this.configErrors];
	}

	getToolDefinitions(): ToolDefinition[] {
		return this.toolDefinitions.map((entry) => entry.definition);
	}

	getServers(): McpServerStatus[] {
		return [...this.servers.entries()].map(([name, record]) => ({
			name,
			scope: record.config.scope,
			transport: record.config.transport,
			enabled: record.config.enabled,
			state: record.state,
			error: record.error,
			trust: record.config.trust,
			toolCount: record.tools.length,
			tools: record.tools.map((tool): McpToolDescriptor => ({
				name: tool.name,
				exposedName: tool.exposedName,
				description: tool.description,
			})),
		}));
	}

	getServer(name: string): McpServerStatus | undefined {
		return this.getServers().find((server) => server.name === name);
	}

	async refresh(): Promise<void> {
		await this.enqueue(async () => {
			await this.disposeClients();
			this.servers.clear();
			this.toolDefinitions = [];

			const merged = loadMergedMcpConfig(this.cwd, this.agentDir);
			this.configErrors = [...merged.errors];

			for (const config of merged.servers) {
				const record: RuntimeServerRecord = {
					config,
					state: config.enabled ? "connecting" : "disabled",
					tools: [],
				};
				this.servers.set(config.name, record);
				if (!config.enabled) {
					continue;
				}
				await this.connectServer(record);
			}

			this.rebuildToolDefinitions();
		});
	}

	async addServer(name: string, scope: McpScope, config: McpServerConfig): Promise<string> {
		const path = upsertScopedMcpServer(scope, name, config, this.cwd, this.agentDir);
		await this.refresh();
		return path;
	}

	async removeServer(name: string, scope: McpScopeTarget): Promise<McpScope[]> {
		const removed = removeMcpServer(name, scope, this.cwd, this.agentDir);
		if (removed.length > 0) {
			await this.refresh();
		}
		return removed;
	}

	async setServerEnabled(name: string, enabled: boolean, scope: McpScope | "auto"): Promise<McpScope | undefined> {
		const updatedScope = setMcpServerEnabled(name, enabled, scope, this.cwd, this.agentDir);
		if (updatedScope) {
			await this.refresh();
		}
		return updatedScope;
	}

	async dispose(): Promise<void> {
		await this.enqueue(async () => {
			await this.disposeClients();
			this.servers.clear();
			this.toolDefinitions = [];
		});
	}

	private async enqueue(task: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(task, task);
		await this.queue;
	}

	private async disposeClients(): Promise<void> {
		const closeOperations: Promise<unknown>[] = [];
		for (const record of this.servers.values()) {
			if (record.client) {
				closeOperations.push(record.client.close().catch(() => undefined));
				record.client = undefined;
			}
		}
		if (closeOperations.length > 0) {
			await Promise.all(closeOperations);
		}
	}

	private async connectServer(record: RuntimeServerRecord): Promise<void> {
		record.state = "connecting";
		record.error = undefined;

		const client = new Client(
			{ name: this.clientName, version: this.clientVersion },
			{ capabilities: {} },
		);

		try {
			const transport = this.createTransport(record.config);
			await this.withTimeout(client.connect(transport), record.config.timeoutMs, `connect ${record.config.name}`);
			const listResult = await this.withTimeout(client.listTools(), record.config.timeoutMs, `list tools ${record.config.name}`);
			const includeSet =
				record.config.includeTools.length > 0 ? new Set(record.config.includeTools.map((item) => item.trim())) : undefined;
			const excludeSet = new Set(record.config.excludeTools.map((item) => item.trim()));
			const tools = listResult.tools
				.filter((tool) => {
					if (includeSet && !includeSet.has(tool.name)) return false;
					if (excludeSet.has(tool.name)) return false;
					return true;
				})
				.map((tool): RuntimeToolRecord => ({
					name: tool.name,
					description: tool.description,
					inputSchema: this.normalizeInputSchema(tool.inputSchema),
					exposedName: tool.name,
					approvalMode: record.config.tools[tool.name]?.approvalMode ?? "auto",
				}));

			record.client = client;
			record.tools = tools;
			record.state = "connected";
		} catch (error) {
			record.state = "error";
			record.error = error instanceof Error ? error.message : String(error);
			record.tools = [];
			await client.close().catch(() => undefined);
		}
	}

	private createTransport(config: McpResolvedServerConfig):
		| StdioClientTransport
		| SSEClientTransport
		| StreamableHTTPClientTransport {
		if (config.transport === "stdio") {
			return new StdioClientTransport({
				command: config.command!,
				args: config.args,
				env: config.env,
				cwd: config.cwd,
				stderr: "pipe",
			});
		}

		if (!config.url) {
			throw new Error(`Server "${config.name}" is missing URL.`);
		}

		if (config.transport === "sse") {
			return new SSEClientTransport(new URL(config.url), {
				requestInit: config.headers ? { headers: config.headers } : undefined,
			});
		}

		return new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: config.headers ? { headers: config.headers } : undefined,
		});
	}

	private normalizeInputSchema(inputSchema: Record<string, unknown> | undefined): Record<string, unknown> {
		if (!inputSchema || inputSchema.type !== "object") {
			return {
				type: "object",
				properties: {},
				additionalProperties: true,
			};
		}
		return inputSchema;
	}

	private rebuildToolDefinitions(): void {
		const allCandidates: Array<{
			serverName: string;
			toolName: string;
			description?: string;
			inputSchema: Record<string, unknown>;
		}> = [];
		for (const [serverName, record] of this.servers.entries()) {
			if (record.state !== "connected") continue;
			for (const tool of record.tools) {
				allCandidates.push({
					serverName,
					toolName: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
				});
			}
		}

		const seenNames = new Set<string>();
		for (const candidate of allCandidates) {
			let exposed = candidate.toolName;
			if (seenNames.has(exposed)) {
				exposed = `${candidate.serverName}__${candidate.toolName}`;
			}
			let suffix = 2;
			while (seenNames.has(exposed)) {
				exposed = `${candidate.serverName}__${candidate.toolName}_${suffix}`;
				suffix += 1;
			}
			seenNames.add(exposed);

			const record = this.servers.get(candidate.serverName);
			if (record) {
				const runtimeTool = record.tools.find((tool) => tool.name === candidate.toolName && tool.exposedName === tool.name);
				if (runtimeTool) {
					runtimeTool.exposedName = exposed;
				}
			}
		}

		const definitions: McpToolDefinitionEntry[] = [];
		for (const [serverName, record] of this.servers.entries()) {
			if (record.state !== "connected") continue;
			for (const tool of record.tools) {
				const exposedName = tool.exposedName;
				const parameters = Type.Unsafe<Record<string, unknown>>(tool.inputSchema as unknown as TSchema);
				const definition: ToolDefinition = {
					name: exposedName,
					label: `${serverName}/${tool.name}`,
					description:
						tool.description && tool.description.trim().length > 0
							? `${tool.description.trim()} (MCP server: ${serverName})`
							: `MCP tool ${tool.name} from server ${serverName}`,
					promptSnippet: `MCP ${serverName}/${tool.name}`,
					parameters,
					execute: async (_toolCallId, params) => {
						const current = this.servers.get(serverName);
						if (!current || current.state !== "connected" || !current.client) {
							throw new Error(`MCP server "${serverName}" is not connected.`);
						}

						if (this.permissionGuard) {
							const summary = this.buildPermissionSummary(serverName, tool.name, params as Record<string, unknown>);
							const request: ToolPermissionRequest = {
								toolName: exposedName,
								cwd: this.cwd,
								input: (params as Record<string, unknown>) ?? {},
								summary,
								requiredPermission: "read-only",
								toolSource: "mcp",
								mcpServerName: serverName,
								mcpToolName: tool.name,
								mcpServerTrusted: current.config.trust,
								mcpApprovalMode: tool.approvalMode,
							};
							const guardResult = await this.permissionGuard(request);
							const normalized: McpPermissionDecision =
								typeof guardResult === "boolean" ? { allowed: guardResult } : guardResult;
							this.onPolicyDecision?.({
								serverName,
								sourceToolName: tool.name,
								exposedToolName: exposedName,
								allowed: normalized.allowed,
								trusted: current.config.trust,
								reason: normalized.reason,
								effect: normalized.effect,
								ruleId: normalized.ruleId,
								policyLayer: normalized.policyLayer,
								approvalMode: tool.approvalMode,
							});
							if (!normalized.allowed) {
								throw new Error(`Permission denied for MCP tool ${serverName}/${tool.name}`);
							}
						}

						const rawResult = await this.withTimeout(
							current.client.callTool({
								name: tool.name,
								arguments: (params as Record<string, unknown>) ?? {},
							}),
							current.config.timeoutMs,
							`${serverName}/${tool.name}`,
						);

						const normalized = this.normalizeToolResult(rawResult);
						if (normalized.isError) {
							throw new Error(
								normalized.errorMessage ?? `MCP tool ${serverName}/${tool.name} returned an error result.`,
							);
						}

						return {
							content: normalized.content,
							details: {
								server: serverName,
								tool: tool.name,
							},
						};
					},
				};

				definitions.push({
					serverName,
					sourceToolName: tool.name,
					exposedToolName: exposedName,
					definition,
				});
			}
		}

		this.toolDefinitions = definitions;
	}

	private buildPermissionSummary(serverName: string, toolName: string, args: Record<string, unknown>): string {
		let argsPreview = "{}";
		try {
			argsPreview = JSON.stringify(args);
		} catch {
			argsPreview = "{...}";
		}
		if (argsPreview.length > 200) {
			argsPreview = `${argsPreview.slice(0, 197)}...`;
		}
		return `MCP ${serverName}/${toolName} ${argsPreview}`;
	}

	private normalizeToolResult(result: unknown): NormalizeResult {
		if (!this.isRecord(result)) {
			return {
				content: [{ type: "text", text: String(result) }],
				isError: false,
			};
		}

		if ("toolResult" in result) {
			return {
				content: [{ type: "text", text: JSON.stringify(result.toolResult, null, 2) }],
				isError: false,
			};
		}

		const rawContent = Array.isArray(result.content) ? result.content : [];
		const content: Array<TextContent | ImageContent> = [];
		for (const item of rawContent) {
			const normalized = this.normalizeContentPart(item);
			if (normalized) {
				content.push(normalized);
			}
		}

		if (result.structuredContent !== undefined) {
			content.push({
				type: "text",
				text: `structuredContent:\n${JSON.stringify(result.structuredContent, null, 2)}`,
			});
		}

		if (content.length === 0) {
			content.push({ type: "text", text: "MCP tool completed with no textual output." });
		}

		const isError = result.isError === true;
		const firstText = content.find((item): item is TextContent => item.type === "text")?.text;
		return {
			content,
			isError,
			errorMessage: isError ? firstText : undefined,
		};
	}

	private normalizeContentPart(item: unknown): TextContent | ImageContent | undefined {
		if (!this.isRecord(item)) {
			return { type: "text", text: String(item) };
		}
		const type = typeof item.type === "string" ? item.type : undefined;
		if (type === "text" && typeof item.text === "string") {
			return { type: "text", text: item.text };
		}
		if (type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			return { type: "image", data: item.data, mimeType: item.mimeType };
		}
		if (type === "audio" && typeof item.mimeType === "string") {
			return { type: "text", text: `Audio content (${item.mimeType}) returned by MCP tool.` };
		}
		if (type === "resource") {
			const resource = this.isRecord(item.resource) ? item.resource : undefined;
			if (!resource) {
				return { type: "text", text: "MCP resource payload returned." };
			}
			const uri = typeof resource.uri === "string" ? resource.uri : "(unknown-uri)";
			if (typeof resource.text === "string") {
				return {
					type: "text",
					text: `Resource ${uri}:\n${resource.text}`,
				};
			}
			return {
				type: "text",
				text: `Resource ${uri} returned (binary or unsupported content).`,
			};
		}
		if (type === "resource_link") {
			const uri = typeof item.uri === "string" ? item.uri : "(unknown-uri)";
			const name = typeof item.name === "string" ? item.name : "resource";
			return {
				type: "text",
				text: `Resource link: ${name} (${uri})`,
			};
		}

		return {
			type: "text",
			text: `MCP output: ${JSON.stringify(item, null, 2)}`,
		};
	}

	private isRecord(value: unknown): value is Record<string, any> {
		return typeof value === "object" && value !== null;
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeoutPromise = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`MCP timeout (${timeoutMs}ms): ${label}`));
				}, timeoutMs);
			});
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}
}

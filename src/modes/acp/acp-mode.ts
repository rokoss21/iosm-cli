import * as crypto from "node:crypto";
import * as readline from "node:readline";
import type { AgentSession } from "../../core/agent-session.js";
import { dispatchBuiltinSlashCommand } from "../../core/command-dispatcher.js";
import type { McpPermissionDecision, McpRuntime } from "../../core/mcp/index.js";
import { evaluatePermissionWithPolicy, type PolicyEngineV2 } from "../../core/policy/index.js";
import {
	type PermissionGrantScope,
	PermissionGrantStore,
	type ToolPermissionRequest,
} from "../../core/tools/index.js";
import { UnifiedExecManager } from "../../core/unified-exec.js";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export interface AcpIoAdapter {
	input: NodeJS.ReadableStream;
	output: (message: unknown) => void;
	onProcessExit: (handler: () => void) => void;
	requestExit: (code?: number) => void;
}

export interface AcpModeOptions {
	policyEngine?: PolicyEngineV2;
	mcpRuntime?: McpRuntime;
	profileName?: string;
	io?: Partial<AcpIoAdapter>;
}

const DANGEROUS_TOOL_NAMES = new Set(["bash", "edit", "write", "apply_patch", "git_write", "fs_ops", "db_run"]);

function normalizePermissionGrantScope(value: unknown): PermissionGrantScope {
	if (value === "turn" || value === "session" || value === "once") {
		return value;
	}
	return "once";
}

function writeJsonLine(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			data,
		},
	};
}

export async function runAcpMode(session: AgentSession, options: AcpModeOptions = {}): Promise<never> {
	const io: AcpIoAdapter = {
		input: options.io?.input ?? process.stdin,
		output: options.io?.output ?? writeJsonLine,
		onProcessExit: options.io?.onProcessExit ?? ((handler) => process.once("exit", handler)),
		requestExit: options.io?.requestExit ?? ((code = 0) => process.exit(code)),
	};
	const execManager = new UnifiedExecManager();
	const pendingPermissions = new Map<string, (decision: { allowed: boolean; scope: PermissionGrantScope }) => void>();
	const permissionGrants = new PermissionGrantStore();
	let shutdownRequested = false;
	let shutdownScheduled = false;

	const evaluateRequest = async (request: ToolPermissionRequest): Promise<McpPermissionDecision> => {
		if (permissionGrants.isAllowed(request)) {
			return { allowed: true, reason: "Allowed by cached turn/session grant.", effect: "allow" };
		}
		options.policyEngine?.refresh();
		if (options.policyEngine) {
			const evaluated = evaluatePermissionWithPolicy(options.policyEngine, request, {
				profile: options.profileName,
				runtimeMode: "rpc",
				permissionMode: session.settingsManager.getPermissionMode(),
				strictExtensionToolEnforcement: session.settingsManager.getPermissionExtensionToolEnforcement(),
			});
			if (evaluated.outcome === "allow") {
				return {
					allowed: true,
					reason: evaluated.reason,
					effect: evaluated.decision.effect,
					ruleId: evaluated.decision.rule?.id,
					policyLayer: evaluated.decision.layer,
				};
			}
			if (evaluated.outcome === "deny") {
				return {
					allowed: false,
					reason: evaluated.reason,
					effect: evaluated.decision.effect,
					ruleId: evaluated.decision.rule?.id,
					policyLayer: evaluated.decision.layer,
				};
			}
		} else {
			const denyRules = session.settingsManager.getPermissionDenyRules();
			for (const rule of denyRules) {
				const [toolRaw, ...needleParts] = rule.split(":");
				const toolName = toolRaw.trim();
				const needle = needleParts.join(":").trim().toLowerCase();
				const toolMatches = !toolName || toolName === "*" || toolName === request.toolName;
				if (toolMatches && (!needle || request.summary.toLowerCase().includes(needle))) {
					return { allowed: false, reason: `Denied by legacy rule: ${rule}`, effect: "deny" };
				}
			}
			const allowRules = session.settingsManager.getPermissionAllowRules();
			for (const rule of allowRules) {
				const [toolRaw, ...needleParts] = rule.split(":");
				const toolName = toolRaw.trim();
				const needle = needleParts.join(":").trim().toLowerCase();
				const toolMatches = !toolName || toolName === "*" || toolName === request.toolName;
				if (toolMatches && (!needle || request.summary.toLowerCase().includes(needle))) {
					return { allowed: true, reason: `Allowed by legacy rule: ${rule}`, effect: "allow" };
				}
			}
			const mode = session.settingsManager.getPermissionMode();
			if (mode === "yolo") {
				return { allowed: true, reason: "Permission mode is yolo.", effect: "allow" };
			}
			if (!DANGEROUS_TOOL_NAMES.has(request.toolName)) {
				return { allowed: true, reason: "ACP mode auto-approves non-dangerous tools.", effect: "allow" };
			}
			if (mode === "auto" && (request.toolName === "edit" || request.toolName === "write" || request.toolName === "apply_patch")) {
				return { allowed: true, reason: "Permission mode auto allows edit/write/apply_patch.", effect: "allow" };
			}
		}

		const permissionId = crypto.randomUUID();
			io.output({
				jsonrpc: "2.0",
				method: "acp.permission.request",
				params: {
					id: permissionId,
					request,
					message: `${request.toolName}: ${request.summary}`,
					timeoutMs: 5 * 60 * 1000,
					scopes: ["once", "turn", "session"],
					defaultScope: "once",
				},
			});

			const decision = await new Promise<{ allowed: boolean; scope: PermissionGrantScope }>((resolve) => {
				const timeout = setTimeout(() => {
					pendingPermissions.delete(permissionId);
					resolve({ allowed: false, scope: "once" });
				}, 5 * 60 * 1000);
				pendingPermissions.set(permissionId, (value) => {
					clearTimeout(timeout);
					resolve(value);
				});
			});
			if (decision.allowed) {
				permissionGrants.allow(request, decision.scope);
			}
			return {
				allowed: decision.allowed,
				reason: decision.allowed ? "Confirmed by ACP client." : "Denied by ACP client.",
				effect: "ask",
			};
		};

	session.setToolPermissionHandler(async (request) => {
		const decision = await evaluateRequest(request);
		return decision.allowed;
	});
	options.mcpRuntime?.setPermissionGuard((request) => evaluateRequest(request));

	session.subscribe((event) => {
		if (event.type === "agent_start") {
			permissionGrants.resetTurn();
		}
		io.output({
			jsonrpc: "2.0",
			method: "acp.event",
			params: event,
		});
	});

	const rl = readline.createInterface({
		input: io.input,
		terminal: false,
	});

	const closeAndExit = () => {
		execManager.dispose();
		rl.close();
		io.requestExit(0);
	};

	const scheduleShutdown = () => {
		if (shutdownScheduled) return;
		shutdownScheduled = true;
		setImmediate(closeAndExit);
	};

	io.onProcessExit(() => {
		execManager.dispose();
	});

	const handle = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
		const id = request.id ?? null;
		switch (request.method) {
			case "acp.handshake":
				return response(id, {
					protocolVersion: "1.0",
					capabilities: {
						streaming: true,
						permissionBridge: true,
						toolEvents: true,
						sessionLifecycle: true,
						backCompatRpc: true,
						execSessions: true,
					},
				});

			case "acp.capabilities":
				return response(id, {
					capabilities: {
						"acp.session.start": true,
						"acp.session.prompt": true,
						"acp.session.steer": true,
						"acp.session.follow_up": true,
						"acp.session.abort": true,
						"acp.session.state": true,
						"acp.command.run_builtin": true,
						"acp.permission.response": true,
						"acp.exec.command": true,
						"acp.exec.write_stdin": true,
					},
				});

			case "acp.session.start":
				return response(id, {
					sessionId: session.sessionId,
					sessionFile: session.sessionFile ?? null,
				});

			case "acp.session.prompt": {
				const message = typeof request.params?.message === "string" ? request.params.message : undefined;
				if (!message) return errorResponse(id, -32602, "Invalid params: message is required.");
				void session
					.prompt(message, {
						source: "rpc",
						streamingBehavior:
							request.params?.streamingBehavior === "steer" || request.params?.streamingBehavior === "followUp"
								? request.params.streamingBehavior
								: undefined,
					})
					.catch((error) => {
						io.output({
							jsonrpc: "2.0",
							method: "acp.event",
							params: {
								type: "error",
								source: "acp.session.prompt",
								message: error instanceof Error ? error.message : String(error),
							},
						});
					});
				return response(id, { accepted: true });
			}

			case "acp.session.steer": {
				const message = typeof request.params?.message === "string" ? request.params.message : undefined;
				if (!message) return errorResponse(id, -32602, "Invalid params: message is required.");
				await session.steer(message);
				return response(id, { accepted: true });
			}

			case "acp.session.follow_up": {
				const message = typeof request.params?.message === "string" ? request.params.message : undefined;
				if (!message) return errorResponse(id, -32602, "Invalid params: message is required.");
				await session.followUp(message);
				return response(id, { accepted: true });
			}

			case "acp.session.abort":
				await session.abort();
				return response(id, { aborted: true });

			case "acp.session.state":
				return response(id, {
					sessionId: session.sessionId,
					sessionFile: session.sessionFile ?? null,
					model: session.model ?? null,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					permissionMode: session.settingsManager.getPermissionMode(),
				});

			case "acp.command.run_builtin": {
				const commandText = typeof request.params?.commandText === "string" ? request.params.commandText : undefined;
				if (!commandText) return errorResponse(id, -32602, "Invalid params: commandText is required.");
				const result = await dispatchBuiltinSlashCommand(commandText, {
					session,
					settingsManager: session.settingsManager,
					policyEngine: options.policyEngine,
				});
				return response(id, result);
			}

				case "acp.exec.command": {
					const command = typeof request.params?.command === "string" ? request.params.command : undefined;
					if (!command) return errorResponse(id, -32602, "Invalid params: command is required.");
					const cwd = typeof request.params?.cwd === "string" ? request.params.cwd : undefined;
					const tty = typeof request.params?.tty === "boolean" ? request.params.tty : undefined;
					const shell = typeof request.params?.shell === "string" ? request.params.shell : undefined;
					const login = typeof request.params?.login === "boolean" ? request.params.login : undefined;
					const yieldTimeMs = typeof request.params?.yieldTimeMs === "number" ? request.params.yieldTimeMs : undefined;
					const maxOutputChars =
						typeof request.params?.maxOutputChars === "number" ? request.params.maxOutputChars : undefined;
					const result = await execManager.execCommand({
						command,
						cwd,
						tty,
						shell,
						login,
						yieldTimeMs,
						maxOutputChars,
					});
				return response(id, result);
			}

			case "acp.exec.write_stdin": {
				const sessionId = typeof request.params?.sessionId === "number" ? request.params.sessionId : undefined;
				if (sessionId === undefined) return errorResponse(id, -32602, "Invalid params: sessionId is required.");
				const chars = typeof request.params?.chars === "string" ? request.params.chars : undefined;
				const yieldTimeMs = typeof request.params?.yieldTimeMs === "number" ? request.params.yieldTimeMs : undefined;
				const maxOutputChars =
					typeof request.params?.maxOutputChars === "number" ? request.params.maxOutputChars : undefined;
				const result = await execManager.writeStdin({
					sessionId,
					chars,
					yieldTimeMs,
					maxOutputChars,
				});
				return response(id, result);
			}

				case "acp.permission.response": {
					const responseId = typeof request.params?.id === "string" ? request.params.id : undefined;
					const allowed = request.params?.allowed === true;
					if (!responseId) return errorResponse(id, -32602, "Invalid params: id is required.");
					const resolver = pendingPermissions.get(responseId);
					if (!resolver) return errorResponse(id, -32602, "Unknown permission request id.");
					pendingPermissions.delete(responseId);
					const scope = normalizePermissionGrantScope(request.params?.scope);
					resolver({ allowed, scope });
					return response(id, { accepted: true });
				}

			case "acp.shutdown":
				shutdownRequested = true;
				return response(id, { ok: true });

			default:
				return errorResponse(id, -32601, "Method not found.", { reason: "capability_not_supported" });
		}
	};

	rl.on("line", async (line) => {
		let parsed: JsonRpcRequest;
		try {
			parsed = JSON.parse(line) as JsonRpcRequest;
		} catch {
			io.output(errorResponse(null, -32700, "Parse error."));
			return;
		}
		if (!parsed || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
			io.output(errorResponse(parsed?.id ?? null, -32600, "Invalid Request."));
			return;
		}
		try {
			const result = await handle(parsed);
			if (result) io.output(result);
			if (shutdownRequested) {
				scheduleShutdown();
			}
		} catch (error) {
			io.output(errorResponse(parsed.id ?? null, -32000, error instanceof Error ? error.message : String(error)));
		}
	});

	return await new Promise<never>(() => {
		// ACP mode is long-running.
	});
}

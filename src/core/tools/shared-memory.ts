import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import {
	readSharedMemory,
	type SharedMemoryContext,
	type SharedMemoryScope,
	type SharedMemoryWriteMode,
	writeSharedMemory,
} from "../shared-memory.js";

type SharedMemoryScopePolicy = "legacy" | "warn" | "enforce";

function resolveSharedMemoryScopePolicy(raw: string | undefined): SharedMemoryScopePolicy {
	const normalized = (raw ?? "").trim().toLowerCase();
	if (normalized === "warn") return "warn";
	if (normalized === "enforce") return "enforce";
	return "legacy";
}

const sharedMemoryScopePolicy = resolveSharedMemoryScopePolicy(process.env.IOSM_SHARED_MEMORY_SCOPE_POLICY);

const sharedMemoryWriteSchema = Type.Object({
	key: Type.String({
		minLength: 1,
		description: "Logical key for shared data within the current run (for example: findings/auth).",
	}),
	value: Type.String({
		description: "Text payload to store.",
	}),
	scope: Type.Optional(
		Type.Union([Type.Literal("run"), Type.Literal("task")], {
			description: "run = visible to all tasks in run_id; task = isolated to current task_id.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("set"), Type.Literal("append")], {
			description: "set replaces value; append concatenates to existing value.",
		}),
	),
	if_version: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Optional CAS guard. Write succeeds only when current version matches this value.",
		}),
	),
});

const sharedMemoryReadSchema = Type.Object({
	key: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Exact key to read. Mutually exclusive with prefix.",
		}),
	),
	prefix: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Prefix filter for keys (for example: findings/).",
		}),
	),
	scope: Type.Optional(
		Type.Union([Type.Literal("run"), Type.Literal("task")], {
			description: "run = visible to all tasks in run_id; task = isolated to current task_id.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Maximum entries to return (default 20).",
		}),
	),
	include_values: Type.Optional(
		Type.Boolean({
			description: "When false (default), returns only metadata (key/version/writer).",
		}),
	),
});

export type SharedMemoryWriteInput = Static<typeof sharedMemoryWriteSchema>;
export type SharedMemoryReadInput = Static<typeof sharedMemoryReadSchema>;

function summarizeSharedMemoryItemForDetails(
	item: {
		key: string;
		scope: SharedMemoryScope;
		version: number;
		updatedAt: string;
		writer: { taskId?: string; delegateId?: string; profile?: string };
		value?: string;
	},
	includeValuePreview: boolean,
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		key: item.key,
		scope: item.scope,
		version: item.version,
		updatedAt: item.updatedAt,
		writer: item.writer,
	};
	if (typeof item.value !== "string") return base;
	const valueLength = item.value.length;
	if (!includeValuePreview) {
		return {
			...base,
			valueLength,
		};
	}
	return {
		...base,
		valueLength,
		valuePreview: item.value.length > 200 ? `${item.value.slice(0, 197)}...` : item.value,
	};
}

function ensureContext(context: SharedMemoryContext): SharedMemoryContext {
	if (!context.runId || !context.runId.trim()) {
		throw new Error("shared memory is unavailable: missing run_id context");
	}
	return context;
}

function summarizeWriter(context: SharedMemoryContext): string {
	const parts = [context.taskId ? `task=${context.taskId}` : undefined, context.delegateId ? `delegate=${context.delegateId}` : undefined]
		.filter((item): item is string => Boolean(item))
		.join(" ");
	return parts.length > 0 ? parts : "root";
}

function resolveScope(input: {
	scope: SharedMemoryScope | undefined;
	context: SharedMemoryContext;
	operation: "read" | "write";
}): { scope: SharedMemoryScope; warning?: string } {
	if (input.scope) return { scope: input.scope };
	if (sharedMemoryScopePolicy === "enforce") {
		throw new Error(
			`shared_memory_${input.operation} requires explicit scope ("run" or "task"). ` +
				`Set IOSM_SHARED_MEMORY_SCOPE_POLICY=legacy to restore implicit defaults.`,
		);
	}
	const shouldWarn = sharedMemoryScopePolicy === "warn" || input.context.profile === "meta";
	if (!shouldWarn) {
		return { scope: "task" };
	}
	return {
		scope: "task",
		warning: `scope omitted -> defaulted to "task" for shared_memory_${input.operation}. Pass explicit scope to avoid ambiguity.`,
	};
}

function normalizeMode(mode: SharedMemoryWriteMode | undefined): SharedMemoryWriteMode {
	return mode ?? "set";
}

export function createSharedMemoryWriteTool(context: SharedMemoryContext): AgentTool<typeof sharedMemoryWriteSchema> {
	return {
		name: "shared_memory_write",
		label: "shared_memory_write",
		description:
			"Write intermediate data into run-scoped shared memory so parallel agents/delegates can exchange state.",
		parameters: sharedMemoryWriteSchema,
		execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal) => {
			const input = params as SharedMemoryWriteInput;
			const ensured = ensureContext(context);
			const scopeResolution = resolveScope({
				scope: input.scope,
				context: ensured,
				operation: "write",
			});
			const result = await writeSharedMemory(ensured, {
				key: input.key,
				value: input.value,
				scope: scopeResolution.scope,
				mode: normalizeMode(input.mode),
				ifVersion: input.if_version,
			}, _signal);
			const warningLine = scopeResolution.warning ? `\nwarning: ${scopeResolution.warning}` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `shared memory updated (${result.scope}:${result.key} v${result.version} by ${summarizeWriter(ensured)})${warningLine}`,
					},
				],
				details: {
					runId: ensured.runId,
					item: summarizeSharedMemoryItemForDetails(result, false),
					scopePolicy: sharedMemoryScopePolicy,
					scopeWarning: scopeResolution.warning,
				},
			};
		},
	};
}

export function createSharedMemoryReadTool(context: SharedMemoryContext): AgentTool<typeof sharedMemoryReadSchema> {
	return {
		name: "shared_memory_read",
		label: "shared_memory_read",
		description:
			"Read intermediate data from run-scoped shared memory (task-local or run-global view).",
		parameters: sharedMemoryReadSchema,
		execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal) => {
			const input = params as SharedMemoryReadInput;
			if (input.key && input.prefix) {
				throw new Error("shared_memory_read accepts either key or prefix, not both");
			}
			const ensured = ensureContext(context);
			const scopeResolution = resolveScope({
				scope: input.scope,
				context: ensured,
				operation: "read",
			});
			const result = await readSharedMemory(ensured, {
				scope: scopeResolution.scope,
				key: input.key,
				prefix: input.prefix,
				limit: input.limit,
				includeValues: input.include_values ?? false,
			}, _signal);
			const header = `shared memory ${result.scope}: ${result.items.length}/${result.totalMatched}`;
			const lines =
				result.items.length === 0
					? ["(no entries)"]
					: result.items.map((item) => {
							const writer = [
								item.writer.taskId ? `task=${item.writer.taskId}` : undefined,
								item.writer.delegateId ? `delegate=${item.writer.delegateId}` : undefined,
								item.writer.profile ? `profile=${item.writer.profile}` : undefined,
							]
								.filter((value): value is string => Boolean(value))
								.join(" ");
							const valuePart =
								item.value === undefined
									? ""
									: ` value=${item.value.length > 80 ? `${item.value.slice(0, 77)}...` : item.value}`;
							return `- ${item.key} v${item.version}${writer ? ` (${writer})` : ""}${valuePart}`;
						});
			if (scopeResolution.warning) {
				lines.unshift(`warning: ${scopeResolution.warning}`);
			}
			return {
				content: [{ type: "text" as const, text: [header, ...lines].join("\n") }],
				details: {
					runId: result.runId,
					scope: result.scope,
					totalMatched: result.totalMatched,
					items: result.items.map((item) => summarizeSharedMemoryItemForDetails(item, input.include_values === true)),
					scopePolicy: sharedMemoryScopePolicy,
					scopeWarning: scopeResolution.warning,
				},
			};
		},
	};
}

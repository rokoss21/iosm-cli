export {
	createAstGrepTool,
	type AstGrepToolInput,
	astGrepTool,
} from "./ast-grep.js";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
} from "./bash.js";
export {
	type CombyToolInput,
	combyTool,
	createCombyTool,
} from "./comby.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createFetchTool,
	type FetchToolDetails,
	type FetchToolInput,
	type FetchToolOptions,
	type FetchMethod,
	type FetchResponseFormat,
	DEFAULT_FETCH_TIMEOUT_SECONDS,
	DEFAULT_FETCH_MAX_BYTES,
	DEFAULT_FETCH_MAX_REDIRECTS,
	getAllowedFetchMethodsForProfile,
	fetchTool,
} from "./fetch.js";
export {
	createWebSearchTool,
	type WebSearchAttemptDetail,
	type WebSearchAttemptStatus,
	type WebSearchFallbackMode,
	type WebSearchProvider,
	type WebSearchProviderMode,
	type WebSearchRuntimeConfig,
	type WebSearchSafeSearch,
	type WebSearchSearchDepth,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
	DEFAULT_WEB_SEARCH_MAX_RESULTS,
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	webSearchTool,
} from "./web-search.js";
export {
	type ExternalCliToolDetails,
	type ExternalCliToolInput,
	type ExternalCliToolOptions,
	createExternalCliTool,
} from "./external-cli.js";
export {
	createFdTool,
	type FdToolInput,
	fdTool,
} from "./fd.js";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
} from "./find.js";
export {
	createFsOpsTool,
	type FsOpsToolDetails,
	type FsOpsToolInput,
	type FsOpsToolOptions,
	fsOpsTool,
} from "./fs-ops.js";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
} from "./grep.js";
export {
	createGitReadTool,
	type GitReadToolDetails,
	type GitReadToolInput,
	type GitReadToolOptions,
	gitReadTool,
} from "./git-read.js";
export {
	createGitWriteTool,
	type GitWriteToolDetails,
	type GitWriteToolInput,
	type GitWriteToolOptions,
	gitWriteTool,
} from "./git-write.js";
export {
	createJqTool,
	type JqToolInput,
	jqTool,
} from "./jq.js";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
} from "./ls.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
export {
	createRgTool,
	type RgToolInput,
	rgTool,
} from "./rg.js";
export {
	createSedTool,
	type SedToolInput,
	sedTool,
} from "./sed.js";
export {
	createSemgrepTool,
	type SemgrepToolInput,
	semgrepTool,
} from "./semgrep.js";
export {
	createSemanticSearchTool,
	type SemanticSearchToolInput,
	type SemanticSearchToolOptions,
	semanticSearchTool,
} from "./semantic-search.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";
export { type ToolPermissionGuard, type ToolPermissionRequest } from "./permissions.js";
export {
	createTodoWriteTool,
	createTodoReadTool,
	todoWriteTool,
	todoReadTool,
	getTaskFilePath,
	type TodoTask,
	type TodoTaskStatus,
	type TodoWriteInput,
	type TodoReadInput,
} from "./todo.js";
export {
	createYqTool,
	type YqToolInput,
	yqTool,
} from "./yq.js";
export {
	createTaskTool,
	type SubagentRunner,
	type TaskToolProgress,
	type TaskToolProgressPhase,
	type TaskToolInput,
	type TaskToolDetails,
} from "./task.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { astGrepTool, createAstGrepTool } from "./ast-grep.js";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { combyTool, createCombyTool } from "./comby.js";
import { createEditTool, type EditToolOptions, editTool } from "./edit.js";
import {
	createFetchTool,
	type FetchToolOptions,
	fetchTool,
	getAllowedFetchMethodsForProfile,
} from "./fetch.js";
import { createWebSearchTool, type WebSearchToolOptions, webSearchTool } from "./web-search.js";
import { createFdTool, fdTool } from "./fd.js";
import { createFindTool, findTool } from "./find.js";
import { createFsOpsTool, type FsOpsToolOptions, fsOpsTool } from "./fs-ops.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createGitReadTool, gitReadTool } from "./git-read.js";
import { createGitWriteTool, type GitWriteToolOptions, gitWriteTool } from "./git-write.js";
import { createJqTool, jqTool } from "./jq.js";
import { createLsTool, lsTool } from "./ls.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createRgTool, rgTool } from "./rg.js";
import { createSedTool, sedTool } from "./sed.js";
import { createSemgrepTool, semgrepTool } from "./semgrep.js";
import {
	createSemanticSearchTool,
	type SemanticSearchToolOptions,
	semanticSearchTool,
} from "./semantic-search.js";
import { createWriteTool, type WriteToolOptions, writeTool } from "./write.js";
import { createYqTool, yqTool } from "./yq.js";
import { todoWriteTool, todoReadTool } from "./todo.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = [readTool, bashTool, editTool, writeTool];

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = [
	readTool,
	grepTool,
	findTool,
	lsTool,
	rgTool,
	fdTool,
	astGrepTool,
	combyTool,
	jqTool,
	yqTool,
	semgrepTool,
	sedTool,
	semanticSearchTool,
	createFetchTool(process.cwd(), {
		resolveAllowedMethods: () => getAllowedFetchMethodsForProfile("plan"),
	}),
	webSearchTool,
	gitReadTool,
];

// All available tools (using process.cwd())
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	rg: rgTool,
	fd: fdTool,
	ast_grep: astGrepTool,
	comby: combyTool,
	jq: jqTool,
	yq: yqTool,
	semgrep: semgrepTool,
	sed: sedTool,
	semantic_search: semanticSearchTool,
	fetch: fetchTool,
	web_search: webSearchTool,
	git_read: gitReadTool,
	git_write: gitWriteTool,
	fs_ops: fsOpsTool,
	todo_write: todoWriteTool,
	todo_read: todoReadTool,
};

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
	/** Options for the edit tool */
	edit?: EditToolOptions;
	/** Options for the write tool */
	write?: WriteToolOptions;
	/** Options for the semantic_search tool */
	semantic?: SemanticSearchToolOptions;
	/** Options for the fetch tool */
	fetch?: FetchToolOptions;
	/** Options for the web_search tool */
	webSearch?: WebSearchToolOptions;
	/** Options for the git_write tool */
	gitWrite?: GitWriteToolOptions;
	/** Options for the fs_ops tool */
	fsOps?: FsOpsToolOptions;
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const fetchOptions: FetchToolOptions = {
		...(options?.fetch ?? {}),
		resolveAllowedMethods:
			options?.fetch?.resolveAllowedMethods ?? (() => getAllowedFetchMethodsForProfile("plan")),
	};

	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd),
		createFindTool(cwd),
		createLsTool(cwd),
		createRgTool(cwd),
		createFdTool(cwd),
		createAstGrepTool(cwd),
		createCombyTool(cwd),
		createJqTool(cwd),
		createYqTool(cwd),
		createSemgrepTool(cwd),
		createSedTool(cwd),
		createSemanticSearchTool(cwd, options?.semantic),
		createFetchTool(cwd, fetchOptions),
		createWebSearchTool(cwd, options?.webSearch),
		createGitReadTool(cwd),
	];
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		rg: createRgTool(cwd),
		fd: createFdTool(cwd),
		ast_grep: createAstGrepTool(cwd),
		comby: createCombyTool(cwd),
		jq: createJqTool(cwd),
		yq: createYqTool(cwd),
		semgrep: createSemgrepTool(cwd),
		sed: createSedTool(cwd),
		semantic_search: createSemanticSearchTool(cwd, options?.semantic),
		fetch: createFetchTool(cwd, options?.fetch),
		web_search: createWebSearchTool(cwd, options?.webSearch),
		git_read: createGitReadTool(cwd),
		git_write: createGitWriteTool(cwd, options?.gitWrite),
		fs_ops: createFsOpsTool(cwd, options?.fsOps),
		todo_write: todoWriteTool,
		todo_read: todoReadTool,
	};
}

/**
 * Create a filtered set of tools from a list of tool names.
 * Used by agent profiles and the Task tool to configure subagent capabilities.
 */
export function createToolsFromNames(cwd: string, names: string[], options?: ToolsOptions): Tool[] {
	const all = createAllTools(cwd, options);
	return names
		.filter((n): n is ToolName => n in all)
		.map((n) => all[n]);
}

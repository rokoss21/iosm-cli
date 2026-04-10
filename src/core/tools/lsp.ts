import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { globSync } from "glob";
import { killProcessTree } from "../../utils/shell.js";
import { resolveReadPath } from "./path-utils.js";
import { commandExists } from "./verification-runner.js";

export type LspLanguage = "typescript" | "javascript" | "python" | "go" | "rust";
type LspServerKind = "typescript" | "python" | "go" | "rust";

type JsonRpcId = number;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: {
		code: number;
		message: string;
	};
}

interface LspServerCommand {
	command: string;
	args: string[];
	installHint: string;
	nodePackageBin?: {
		packageName: string;
		binName: string;
	};
	fallbackCommands?: Array<{
		command: string;
		args?: string[];
	}>;
}

interface ResolvedLspCommand {
	command: string;
	args: string[];
	display: string;
}

interface LspDiagnosticEntry {
	message: string;
	severity: "error" | "warning" | "info" | "hint";
	code?: string;
	source?: string;
	line: number;
	character: number;
	endLine: number;
	endCharacter: number;
}

export interface LspLocation {
	file: string;
	line: number;
	character: number;
	endLine?: number;
	endCharacter?: number;
}

interface LspSymbolEntry {
	name: string;
	kind: string;
	file?: string;
	line?: number;
	character?: number;
	containerName?: string;
}

interface LspRenamePreparation {
	placeholder?: string;
	range: LspLocation;
}

interface LspSessionStatus {
	key: string;
	language: LspLanguage;
	server: string;
	projectRoot: string;
	openDocuments: number;
	cachedDiagnostics: number;
	uptimeSeconds: number;
	idleSeconds: number;
}

export type LspToolExecutionResult =
	| {
			action: "status";
			sessions: LspSessionStatus[];
			supportedLanguages: LspLanguage[];
	  }
	| {
			action: "shutdown";
			stoppedSessions: number;
	  }
	| {
			action: "definition" | "references";
			locations: LspLocation[];
			note?: string;
	  }
	| {
			action: "hover";
			hoverText: string;
			range?: LspLocation;
			note?: string;
	  }
	| {
			action: "document_symbols" | "workspace_symbols";
			symbols: LspSymbolEntry[];
			note?: string;
	  }
	| {
			action: "prepare_rename";
			preparation: LspRenamePreparation | null;
			note?: string;
	  }
	| {
			action: "diagnostics";
			file: string;
			diagnostics: LspDiagnosticEntry[];
	  };

export interface LspToolRuntime {
	execute(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult>;
}

const lspSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("definition"),
			Type.Literal("references"),
			Type.Literal("hover"),
			Type.Literal("document_symbols"),
			Type.Literal("workspace_symbols"),
			Type.Literal("prepare_rename"),
			Type.Literal("diagnostics"),
			Type.Literal("shutdown"),
		],
		{
			description:
				"LSP action: status | definition | references | hover | document_symbols | workspace_symbols | prepare_rename | diagnostics | shutdown",
		},
	),
	file: Type.Optional(Type.String({ description: "File path for file-scoped actions (relative or absolute)." })),
	line: Type.Optional(Type.Number({ minimum: 1, description: "1-indexed line number for position-based actions." })),
	character: Type.Optional(
		Type.Number({ minimum: 1, description: "1-indexed character column for position-based actions." }),
	),
	query: Type.Optional(Type.String({ description: "Symbol query for workspace_symbols action." })),
	include_declaration: Type.Optional(
		Type.Boolean({ description: "For references action: include declaration in results (default: false)." }),
	),
	language: Type.Optional(
		Type.Union([
			Type.Literal("typescript"),
			Type.Literal("javascript"),
			Type.Literal("python"),
			Type.Literal("go"),
			Type.Literal("rust"),
		]),
	),
	limit: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 500,
			description: "Maximum number of entries returned for list-like actions (default: 200).",
		}),
	),
});

export type LspToolInput = Static<typeof lspSchema>;

export interface LspToolDetails {
	result: LspToolExecutionResult;
}

export interface LspToolOptions {
	runtime?: LspToolRuntime;
	requestTimeoutMs?: number;
	idleTimeoutMs?: number;
	serverCommands?: Partial<Record<LspServerKind, LspServerCommand>>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface OpenDocument {
	version: number;
	text: string;
}

interface LspSessionOptions {
	key: string;
	language: LspLanguage;
	command: LspServerCommand;
	projectRoot: string;
	requestTimeoutMs: number;
}

interface LspSessionRecord {
	session: LspSession;
	lastUsedAt: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 12_000;
const DEFAULT_LIMIT = 200;

const DEFAULT_SERVER_COMMANDS: Record<LspServerKind, LspServerCommand> = {
	typescript: {
		command: "typescript-language-server",
		args: ["--stdio"],
		nodePackageBin: {
			packageName: "typescript-language-server",
			binName: "typescript-language-server",
		},
		installHint:
			'Install TypeScript LSP: npm install typescript typescript-language-server (or install globally: npm install -g typescript-language-server typescript).',
	},
	python: {
		command: "pyright-langserver",
		args: ["--stdio"],
		nodePackageBin: {
			packageName: "pyright",
			binName: "pyright-langserver",
		},
		fallbackCommands: [
			{ command: "pylsp" },
			{ command: "python3", args: ["-m", "pylsp"] },
			{ command: "python", args: ["-m", "pylsp"] },
		],
		installHint:
			"Install Python LSP runtime: npm install pyright (recommended) or pip install python-lsp-server and ensure pylsp is available in PATH.",
	},
	go: {
		command: "gopls",
		args: [],
		installHint: "Install Go LSP: go install golang.org/x/tools/gopls@latest",
	},
	rust: {
		command: "rust-analyzer",
		args: [],
		installHint: "Install Rust analyzer and ensure rust-analyzer is in PATH.",
	},
};

const SUPPORTED_LANGUAGES: LspLanguage[] = ["typescript", "javascript", "python", "go", "rust"];

const SYMBOL_KIND_MAP: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

const requireForBins = createRequire(import.meta.url);
const NODE_PACKAGE_BIN_CACHE = new Map<string, string | undefined>();
const WORKSPACE_SYMBOL_SCAN_MAX_FILES = 2_000;
const WORKSPACE_SYMBOL_IGNORE_PATTERNS = [
	"**/.git/**",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/.next/**",
	"**/coverage/**",
	"**/.venv/**",
	"**/venv/**",
	"**/__pycache__/**",
	"**/.iosm/**",
];

const DECLARATION_PATTERNS: Record<LspLanguage, Array<{ regex: RegExp; kind: string; captureGroup: number }>> = {
	typescript: [
		{ regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/, kind: "Function", captureGroup: 1 },
		{ regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, kind: "Class", captureGroup: 1 },
		{ regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, kind: "Interface", captureGroup: 1 },
		{ regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "TypeParameter", captureGroup: 1 },
		{ regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, kind: "Variable", captureGroup: 1 },
	],
	javascript: [
		{ regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/, kind: "Function", captureGroup: 1 },
		{ regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, kind: "Class", captureGroup: 1 },
		{ regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, kind: "Variable", captureGroup: 1 },
	],
	python: [
		{ regex: /^\s*class\s+([A-Za-z_]\w*)\b/, kind: "Class", captureGroup: 1 },
		{ regex: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, kind: "Function", captureGroup: 1 },
		{ regex: /^\s*([A-Za-z_]\w*)\s*=/, kind: "Variable", captureGroup: 1 },
	],
	go: [
		{ regex: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "Function", captureGroup: 1 },
		{ regex: /^\s*type\s+([A-Za-z_]\w*)\b/, kind: "Struct", captureGroup: 1 },
		{ regex: /^\s*(?:const|var)\s+([A-Za-z_]\w*)\b/, kind: "Variable", captureGroup: 1 },
	],
	rust: [
		{ regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/, kind: "Function", captureGroup: 1 },
		{ regex: /^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)\b/, kind: "Struct", captureGroup: 1 },
		{ regex: /^\s*(?:pub\s+)?(?:const|static)\s+([A-Za-z_]\w*)\b/, kind: "Constant", captureGroup: 1 },
	],
};

function getLocalNodeModulesBin(cwd: string, binName: string): string | undefined {
	const suffix = process.platform === "win32" ? ".cmd" : "";
	const localPath = join(cwd, "node_modules", ".bin", `${binName}${suffix}`);
	return existsSync(localPath) ? localPath : undefined;
}

function resolvePackageBinPath(packageName: string, binName: string): string | undefined {
	const cacheKey = `${packageName}:${binName}`;
	if (NODE_PACKAGE_BIN_CACHE.has(cacheKey)) {
		return NODE_PACKAGE_BIN_CACHE.get(cacheKey);
	}

	let resolved: string | undefined;
	try {
		const packageJsonPath = requireForBins.resolve(`${packageName}/package.json`);
		const packageDir = dirname(packageJsonPath);
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const binField = packageJson.bin;
		if (typeof binField === "string") {
			resolved = resolvePath(packageDir, binField);
		} else if (binField && typeof binField === "object" && typeof binField[binName] === "string") {
			resolved = resolvePath(packageDir, binField[binName]);
		}
	} catch {
		resolved = undefined;
	}

	NODE_PACKAGE_BIN_CACHE.set(cacheKey, resolved);
	return resolved;
}

function resolveServerCommand(command: LspServerCommand, cwd: string): ResolvedLspCommand | undefined {
	const base = [{ command: command.command, args: command.args }, ...(command.fallbackCommands ?? [])];

	for (const candidate of base) {
		if (commandExists(candidate.command)) {
			return {
				command: candidate.command,
				args: candidate.args ?? [],
				display: `${candidate.command}${(candidate.args ?? []).length > 0 ? ` ${(candidate.args ?? []).join(" ")}` : ""}`,
			};
		}

		const localBinary = getLocalNodeModulesBin(cwd, candidate.command);
		if (localBinary) {
			return {
				command: localBinary,
				args: candidate.args ?? [],
				display: `${localBinary}${(candidate.args ?? []).length > 0 ? ` ${(candidate.args ?? []).join(" ")}` : ""}`,
			};
		}
	}

	if (command.nodePackageBin) {
		const packageBin = resolvePackageBinPath(command.nodePackageBin.packageName, command.nodePackageBin.binName);
		if (packageBin) {
			return {
				command: process.execPath,
				args: [packageBin, ...command.args],
				display: `${command.nodePackageBin.binName}${command.args.length > 0 ? ` ${command.args.join(" ")}` : ""} (bundled)`,
			};
		}
	}

	return undefined;
}

function getWorkspaceSymbolPatterns(language: LspLanguage): string[] {
	if (language === "typescript") return ["**/*.{ts,tsx,mts,cts}"];
	if (language === "javascript") return ["**/*.{js,jsx,mjs,cjs}"];
	if (language === "python") return ["**/*.{py,pyi}"];
	if (language === "go") return ["**/*.go"];
	return ["**/*.rs"];
}

function isMethodNotSupportedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /\[-?32601\]/.test(message) || /method not found/i.test(message);
}

function extractIdentifierAtPosition(
	filePath: string,
	line: number,
	character: number,
): { name: string; startCharacter: number; endCharacter: number } | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}

	const lines = content.split(/\r?\n/);
	const lineText = lines[line - 1];
	if (lineText === undefined || lineText.length === 0) return undefined;

	const isIdentifier = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);
	let cursor = Math.max(0, Math.min(lineText.length - 1, character - 1));
	if (!isIdentifier(lineText[cursor]) && cursor > 0 && isIdentifier(lineText[cursor - 1])) {
		cursor -= 1;
	}
	if (!isIdentifier(lineText[cursor])) return undefined;

	let start = cursor;
	let end = cursor;
	while (start > 0 && isIdentifier(lineText[start - 1])) start -= 1;
	while (end + 1 < lineText.length && isIdentifier(lineText[end + 1])) end += 1;

	return {
		name: lineText.slice(start, end + 1),
		startCharacter: start + 1,
		endCharacter: end + 2,
	};
}

function fallbackWorkspaceSymbols(
	cwd: string,
	language: LspLanguage,
	query: string,
	limit: number,
): { symbols: LspSymbolEntry[]; scannedFiles: number } {
	const queryLower = query.trim().toLowerCase();
	if (!queryLower) return { symbols: [], scannedFiles: 0 };

	const files = new Set<string>();
	for (const pattern of getWorkspaceSymbolPatterns(language)) {
		const matches = globSync(pattern, {
			cwd,
			absolute: true,
			nodir: true,
			ignore: WORKSPACE_SYMBOL_IGNORE_PATTERNS,
		});
		for (const file of matches) {
			files.add(resolvePath(file));
			if (files.size >= WORKSPACE_SYMBOL_SCAN_MAX_FILES) break;
		}
		if (files.size >= WORKSPACE_SYMBOL_SCAN_MAX_FILES) break;
	}

	const patterns = DECLARATION_PATTERNS[language];
	const symbols: LspSymbolEntry[] = [];
	for (const filePath of files) {
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			for (const pattern of patterns) {
				const match = pattern.regex.exec(line);
				if (!match) continue;
				const symbolName = match[pattern.captureGroup];
				if (!symbolName || !symbolName.toLowerCase().includes(queryLower)) continue;
				symbols.push({
					name: symbolName,
					kind: pattern.kind,
					file: filePath,
					line: index + 1,
					character: Math.max(1, line.indexOf(symbolName) + 1),
				});
				if (symbols.length >= limit) {
					return { symbols, scannedFiles: files.size };
				}
			}
		}
	}

	return { symbols, scannedFiles: files.size };
}

interface PythonImportTarget {
	moduleExpression: string;
	moduleFilePath: string;
	cursorToken: string;
	importedName?: string;
	cursorMode: "statement" | "module" | "importedSymbol";
	modulePosition: {
		line: number;
		character: number;
	};
}

function splitPythonImportItems(raw: string): string[] {
	const normalized = raw
		.replace(/\\\r?\n/g, " ")
		.replace(/\r?\n/g, " ")
		.replace(/[()]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized
		.split(",")
		.map((item) => item.replace(/#.*$/, "").trim())
		.filter((item) => item.length > 0);
}

function parsePythonModuleImportItem(item: string): { moduleExpression: string; alias?: string } | undefined {
	const match = /^([A-Za-z_][\w.]*)\s*(?:as\s+([A-Za-z_]\w*))?$/.exec(item);
	if (!match) return undefined;
	return {
		moduleExpression: match[1],
		alias: match[2],
	};
}

function parsePythonImportedSymbolItem(item: string): { symbolName: string; alias?: string } | undefined {
	const match = /^([A-Za-z_]\w*)\s*(?:as\s+([A-Za-z_]\w*))?$/.exec(item);
	if (!match) return undefined;
	return {
		symbolName: match[1],
		alias: match[2],
	};
}

function tokenMatchesPythonModule(cursorToken: string, moduleExpression: string): boolean {
	if (!cursorToken) return false;
	const cleanModule = moduleExpression.replace(/^\.+/, "");
	if (!cleanModule) return false;
	if (cleanModule === cursorToken) return true;
	return cleanModule.split(".").some((part) => part === cursorToken);
}

function toModulePartsFromPythonFile(filePath: string, projectRoot: string): string[] | undefined {
	const rel = relative(projectRoot, filePath);
	if (!rel || rel.startsWith("..")) return undefined;
	const normalized = rel.replace(/\\/g, "/");
	if (normalized.endsWith("/__init__.py")) {
		const modulePart = normalized.slice(0, -"/__init__.py".length);
		return modulePart ? modulePart.split("/") : [];
	}
	if (normalized.endsWith(".py")) {
		return normalized.slice(0, -".py".length).split("/");
	}
	return undefined;
}

function resolvePythonModuleFile(projectRoot: string, currentFilePath: string, moduleExpression: string): string | undefined {
	const dotMatch = /^(\.+)(.*)$/.exec(moduleExpression);
	const level = dotMatch ? dotMatch[1].length : 0;
	const moduleTail = dotMatch ? dotMatch[2] : moduleExpression;
	const targetParts = moduleTail ? moduleTail.split(".").filter(Boolean) : [];

	const roots: string[] = [];
	if (level > 0) {
		let base = dirname(currentFilePath);
		for (let i = 1; i < level; i += 1) {
			base = dirname(base);
		}
		roots.push(base);
	} else {
		roots.push(dirname(currentFilePath), projectRoot);
	}

	const uniqueRoots = [...new Set(roots.map((value) => resolvePath(value)))];
	for (const root of uniqueRoots) {
		const candidates: string[] = [];
		if (targetParts.length === 0) {
			candidates.push(join(root, "__init__.py"));
		} else {
			candidates.push(join(root, ...targetParts) + ".py");
			candidates.push(join(root, ...targetParts, "__init__.py"));
		}
		for (const candidate of candidates) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	if (level > 0 || targetParts.length === 0) return undefined;

	const targetModule = targetParts.join(".");
	const leaf = targetParts[targetParts.length - 1];
	const fileCandidates = globSync(`**/${leaf}.py`, {
		cwd: projectRoot,
		absolute: true,
		nodir: true,
		ignore: WORKSPACE_SYMBOL_IGNORE_PATTERNS,
	});
	for (const candidate of fileCandidates) {
		const moduleParts = toModulePartsFromPythonFile(candidate, projectRoot);
		if (!moduleParts) continue;
		if (moduleParts.join(".") === targetModule) return resolvePath(candidate);
	}

	const packageCandidates = globSync(`**/${leaf}/__init__.py`, {
		cwd: projectRoot,
		absolute: true,
		nodir: true,
		ignore: WORKSPACE_SYMBOL_IGNORE_PATTERNS,
	});
	for (const candidate of packageCandidates) {
		const moduleParts = toModulePartsFromPythonFile(candidate, projectRoot);
		if (!moduleParts) continue;
		if (moduleParts.join(".") === targetModule) return resolvePath(candidate);
	}

	return undefined;
}

interface PythonImportStatementContext {
	mode: "from" | "import";
	moduleExpression?: string;
	importedRaw: string;
}

interface PythonImportStatementSpan {
	startLine: number;
	endLine: number;
	context: PythonImportStatementContext;
}

function isPythonImportStartLine(lineText: string): boolean {
	return /^\s*(?:from\s+[.\w]+\s+import\b|import\b)/.test(lineText);
}

function pythonParenDelta(lineText: string): number {
	const stripped = lineText.replace(/#.*$/, "");
	let delta = 0;
	for (const ch of stripped) {
		if (ch === "(") delta += 1;
		else if (ch === ")") delta -= 1;
	}
	return delta;
}

function parsePythonImportStatement(statementText: string): PythonImportStatementContext | undefined {
	const compact = statementText
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*$/, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (!compact) return undefined;

	const fromMatch = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(compact);
	if (fromMatch) {
		return {
			mode: "from",
			moduleExpression: fromMatch[1],
			importedRaw: fromMatch[2],
		};
	}

	const importMatch = /^import\s+(.+)$/.exec(compact);
	if (importMatch) {
		return {
			mode: "import",
			importedRaw: importMatch[1],
		};
	}

	return undefined;
}

function findPythonModuleReferencePosition(
	lines: string[],
	startLine: number,
	endLine: number,
	moduleExpression: string,
): { line: number; character: number } {
	const cleanModule = moduleExpression.replace(/^\.+/, "");
	const leaf = cleanModule.split(".").filter(Boolean).at(-1);
	const candidates = [...new Set([moduleExpression, cleanModule, leaf].filter((value): value is string => Boolean(value)))];
	const isBoundary = (char: string | undefined): boolean => !char || !/[A-Za-z0-9_]/.test(char);

	for (let lineIndex = startLine - 1; lineIndex < endLine && lineIndex < lines.length; lineIndex += 1) {
		const lineText = (lines[lineIndex] ?? "").replace(/#.*$/, "");
		for (const candidate of candidates) {
			let offset = lineText.indexOf(candidate);
			while (offset !== -1) {
				const before = lineText[offset - 1];
				const after = lineText[offset + candidate.length];
				if (isBoundary(before) && isBoundary(after)) {
					return {
						line: lineIndex + 1,
						character: offset + 1,
					};
				}
				offset = lineText.indexOf(candidate, offset + 1);
			}
		}
	}

	return {
		line: startLine,
		character: 1,
	};
}

function getPythonImportStatementAtPosition(
	lines: string[],
	line: number,
): PythonImportStatementSpan | undefined {
	const cursorLineIndex = line - 1;
	if (cursorLineIndex < 0 || cursorLineIndex >= lines.length) return undefined;

	let startIndex = cursorLineIndex;
	if (!isPythonImportStartLine(lines[startIndex])) {
		startIndex = -1;
		for (let index = cursorLineIndex - 1; index >= Math.max(0, cursorLineIndex - 40); index -= 1) {
			if (isPythonImportStartLine(lines[index])) {
				startIndex = index;
				break;
			}
			if (lines[index].trim().length === 0) {
				break;
			}
		}
		if (startIndex === -1) return undefined;
	}

	let endIndex = startIndex;
	let parenBalance = pythonParenDelta(lines[startIndex]);
	let trailingSlash = /\\\s*$/.test(lines[startIndex].replace(/#.*$/, ""));

	while (endIndex + 1 < lines.length && (parenBalance > 0 || trailingSlash)) {
		endIndex += 1;
		parenBalance += pythonParenDelta(lines[endIndex]);
		trailingSlash = /\\\s*$/.test(lines[endIndex].replace(/#.*$/, ""));
	}

	if (cursorLineIndex < startIndex || cursorLineIndex > endIndex) return undefined;

	const statementText = lines.slice(startIndex, endIndex + 1).join("\n");
	const parsed = parsePythonImportStatement(statementText);
	if (!parsed) return undefined;

	return {
		startLine: startIndex + 1,
		endLine: endIndex + 1,
		context: parsed,
	};
}

function findPythonImportTargetAtPosition(
	projectRoot: string,
	filePath: string,
	line: number,
	character: number,
): PythonImportTarget | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const lines = content.split(/\r?\n/);
	const statement = getPythonImportStatementAtPosition(lines, line);
	if (!statement) return undefined;

	const identifier = extractIdentifierAtPosition(filePath, line, character);
	const cursorToken = identifier?.name;
	const cursorTokenLower = cursorToken?.toLowerCase();

	if (statement.context.mode === "from" && statement.context.moduleExpression) {
		const moduleExpression = statement.context.moduleExpression;
		const moduleFilePath = resolvePythonModuleFile(projectRoot, filePath, moduleExpression);
		if (!moduleFilePath) return undefined;
		const modulePosition = findPythonModuleReferencePosition(
			lines,
			statement.startLine,
			statement.endLine,
			moduleExpression,
		);

		if (
			!cursorToken ||
			cursorTokenLower === "from" ||
			cursorTokenLower === "import" ||
			cursorTokenLower === "as" ||
			tokenMatchesPythonModule(cursorToken, moduleExpression)
		) {
			const cursorMode =
				!cursorToken || cursorTokenLower === "from" || cursorTokenLower === "import" || cursorTokenLower === "as"
					? "statement"
					: "module";
			return {
				moduleExpression,
				moduleFilePath,
				cursorToken: cursorToken ?? moduleExpression.replace(/^\.+/, ""),
				cursorMode,
				modulePosition,
			};
		}

		for (const item of splitPythonImportItems(statement.context.importedRaw)) {
			const parsed = parsePythonImportedSymbolItem(item);
			if (!parsed) continue;
			if (parsed.symbolName === cursorToken || parsed.alias === cursorToken) {
				return {
					moduleExpression,
					moduleFilePath,
					cursorToken,
					importedName: parsed.symbolName,
					cursorMode: "importedSymbol",
					modulePosition,
				};
			}
		}

		return {
			moduleExpression,
			moduleFilePath,
			cursorToken: cursorToken ?? moduleExpression.replace(/^\.+/, ""),
			cursorMode: "statement",
			modulePosition,
		};
	}

	if (statement.context.mode !== "import") return undefined;
	const moduleItems = splitPythonImportItems(statement.context.importedRaw)
		.map((item) => parsePythonModuleImportItem(item))
		.filter((item): item is { moduleExpression: string; alias?: string } => item !== undefined);
	if (moduleItems.length === 0) return undefined;

	let selectedModule = moduleItems[0];
	let selectedByCursor = false;
	if (cursorToken && cursorTokenLower !== "import" && cursorTokenLower !== "as") {
		for (const item of moduleItems) {
			if (tokenMatchesPythonModule(cursorToken, item.moduleExpression) || item.alias === cursorToken) {
				selectedModule = item;
				selectedByCursor = true;
				break;
			}
		}
	}

	const moduleFilePath = resolvePythonModuleFile(projectRoot, filePath, selectedModule.moduleExpression);
	if (!moduleFilePath) return undefined;
	const modulePosition = findPythonModuleReferencePosition(
		lines,
		statement.startLine,
		statement.endLine,
		selectedModule.moduleExpression,
	);
	return {
		moduleExpression: selectedModule.moduleExpression,
		moduleFilePath,
		cursorToken: cursorToken ?? selectedModule.moduleExpression.split(".").at(-1) ?? selectedModule.moduleExpression,
		cursorMode:
			!cursorToken || cursorTokenLower === "import" || cursorTokenLower === "as"
				? "statement"
				: selectedByCursor
					? "module"
					: "statement",
		modulePosition,
	};
}

function findPythonDeclarationLocation(filePath: string, symbolName: string): LspLocation | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const declarationPatterns = [
		new RegExp(`^\\s*class\\s+${escaped}\\b`),
		new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`),
		new RegExp(`^\\s*${escaped}\\s*=`),
	];

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const lineText = lines[index];
		for (const pattern of declarationPatterns) {
			if (!pattern.test(lineText)) continue;
			return {
				file: filePath,
				line: index + 1,
				character: Math.max(1, lineText.indexOf(symbolName) + 1),
				endLine: index + 1,
				endCharacter: Math.max(1, lineText.indexOf(symbolName) + symbolName.length + 1),
			};
		}
	}
	return undefined;
}

function extractPythonDocstringNearDeclaration(filePath: string, declarationLine: number): string | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const lines = content.split(/\r?\n/);
	let index = Math.max(0, declarationLine);
	while (index < lines.length && lines[index].trim().length === 0) {
		index += 1;
	}
	if (index >= lines.length) return undefined;

	const first = lines[index].trim();
	const delimiter = first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : undefined;
	if (!delimiter) return undefined;

	let doc = first.slice(delimiter.length);
	if (doc.endsWith(delimiter)) {
		doc = doc.slice(0, -delimiter.length);
		return doc.trim() || undefined;
	}

	for (let i = index + 1; i < lines.length; i += 1) {
		const segment = lines[i];
		if (segment.includes(delimiter)) {
			doc += `\n${segment.slice(0, segment.indexOf(delimiter))}`;
			break;
		}
		doc += `\n${segment}`;
		if (doc.length > 1_500) break;
	}

	const trimmed = doc.trim();
	return trimmed || undefined;
}

function fallbackPythonImportDefinition(
	projectRoot: string,
	filePath: string,
	line: number,
	character: number,
): { locations: LspLocation[]; note: string } | undefined {
	const target = findPythonImportTargetAtPosition(projectRoot, filePath, line, character);
	if (!target) return undefined;

	if (target.importedName) {
		const declaration = findPythonDeclarationLocation(target.moduleFilePath, target.importedName);
		if (declaration) {
			return {
				locations: [declaration],
				note: `Fallback definition resolved from Python import target in ${target.moduleFilePath}.`,
			};
		}
	}

	return {
		locations: [
			{
				file: target.moduleFilePath,
				line: 1,
				character: 1,
			},
		],
		note: `Fallback definition resolved module path for import "${target.moduleExpression}".`,
	};
}

function fallbackPythonImportHover(
	projectRoot: string,
	filePath: string,
	line: number,
	character: number,
): { hoverText: string; range?: LspLocation; note: string } | undefined {
	const target = findPythonImportTargetAtPosition(projectRoot, filePath, line, character);
	if (!target) return undefined;

	if (!target.importedName) {
		return {
			hoverText: `Python module: ${target.moduleExpression}\nfile: ${target.moduleFilePath}`,
			range: {
				file: target.moduleFilePath,
				line: 1,
				character: 1,
			},
			note: "Fallback hover used import-module resolution.",
		};
	}

	const declaration = findPythonDeclarationLocation(target.moduleFilePath, target.importedName);
	if (!declaration) {
		return {
			hoverText: `Imported symbol: ${target.importedName}\nmodule: ${target.moduleExpression}\nfile: ${target.moduleFilePath}`,
			note: "Fallback hover resolved symbol source module but could not locate declaration line.",
		};
	}

	let declarationLine = "";
	try {
		const lines = readFileSync(target.moduleFilePath, "utf8").split(/\r?\n/);
		declarationLine = lines[declaration.line - 1]?.trim() ?? "";
	} catch {
		declarationLine = "";
	}
	const doc = extractPythonDocstringNearDeclaration(target.moduleFilePath, declaration.line);
	const hoverSections = [
		declarationLine ? `\`\`\`python\n${declarationLine}\n\`\`\`` : `Imported symbol: ${target.importedName}`,
		`module: ${target.moduleExpression}`,
		`file: ${target.moduleFilePath}`,
		doc ? `docstring:\n${doc}` : "",
	].filter((entry) => entry.length > 0);

	return {
		hoverText: hoverSections.join("\n\n"),
		range: declaration,
		note: "Fallback hover used Python import + declaration lookup.",
	};
}

function resolvePythonImportFallbackTarget(
	projectRoot: string,
	filePath: string,
	line: number,
	character: number,
): PythonImportTarget | undefined {
	return findPythonImportTargetAtPosition(projectRoot, filePath, line, character);
}

function normalizeLimit(rawLimit: number | undefined): number {
	if (!Number.isFinite(rawLimit)) return DEFAULT_LIMIT;
	const value = Math.floor(rawLimit as number);
	if (value < 1) return 1;
	if (value > 500) return 500;
	return value;
}

function normalizePosition(input: LspToolInput): { line: number; character: number } {
	if (!Number.isFinite(input.line) || !Number.isFinite(input.character)) {
		throw new Error("line and character are required for this action.");
	}
	const line = Math.max(1, Math.floor(input.line as number));
	const character = Math.max(1, Math.floor(input.character as number));
	return {
		line,
		character,
	};
}

function inferLanguageFromFile(filePath: string): LspLanguage | undefined {
	const ext = extname(filePath).toLowerCase();
	if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "typescript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
	if ([".py", ".pyi"].includes(ext)) return "python";
	if (ext === ".go") return "go";
	if (ext === ".rs") return "rust";
	return undefined;
}

function inferLanguageId(filePath: string, language: LspLanguage): string {
	const ext = extname(filePath).toLowerCase();
	if (language === "typescript") {
		if (ext === ".tsx") return "typescriptreact";
		return "typescript";
	}
	if (language === "javascript") {
		if (ext === ".jsx") return "javascriptreact";
		return "javascript";
	}
	if (language === "python") return "python";
	if (language === "go") return "go";
	if (language === "rust") return "rust";
	return "plaintext";
}

function resolveServerKind(language: LspLanguage): LspServerKind {
	if (language === "javascript") return "typescript";
	return language;
}

function toFileUri(filePath: string): string {
	return pathToFileURL(filePath).toString();
}

function toDisplayPath(uri: string): string {
	if (uri.startsWith("file:")) {
		try {
			return fileURLToPath(uri);
		} catch {
			return uri;
		}
	}
	return uri;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function normalizeLocationFromUriAndRange(uri: string, range: unknown): LspLocation | undefined {
	const rangeObj = asRecord(range);
	const start = asRecord(rangeObj?.start);
	const end = asRecord(rangeObj?.end);
	if (!start || !end) return undefined;
	const startLine = Number(start.line);
	const startCharacter = Number(start.character);
	const endLine = Number(end.line);
	const endCharacter = Number(end.character);
	if (!Number.isFinite(startLine) || !Number.isFinite(startCharacter)) return undefined;
	return {
		file: toDisplayPath(uri),
		line: Math.floor(startLine) + 1,
		character: Math.floor(startCharacter) + 1,
		endLine: Number.isFinite(endLine) ? Math.floor(endLine) + 1 : undefined,
		endCharacter: Number.isFinite(endCharacter) ? Math.floor(endCharacter) + 1 : undefined,
	};
}

function normalizeLocations(raw: unknown): LspLocation[] {
	const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
	const result: LspLocation[] = [];
	for (const value of values) {
		const record = asRecord(value);
		if (!record) continue;

		if (typeof record.uri === "string" && record.range) {
			const location = normalizeLocationFromUriAndRange(record.uri, record.range);
			if (location) result.push(location);
			continue;
		}

		if (typeof record.targetUri === "string") {
			const location = normalizeLocationFromUriAndRange(
				record.targetUri,
				record.targetSelectionRange ?? record.targetRange,
			);
			if (location) result.push(location);
		}
	}
	return result;
}

function normalizeHoverText(raw: unknown): string {
	const contents = asRecord(raw)?.contents ?? (asRecord(raw)?.value ? raw : undefined);
	if (typeof contents === "string") {
		return contents.trim();
	}

	const collect = (value: unknown): string[] => {
		if (typeof value === "string") {
			const text = value.trim();
			return text ? [text] : [];
		}
		const record = asRecord(value);
		if (!record) return [];
		if (typeof record.value === "string") {
			const text = record.value.trim();
			return text ? [text] : [];
		}
		if (typeof record.language === "string" && typeof record.value === "string") {
			const valueText = record.value.trim();
			return valueText ? [`${record.language}: ${valueText}`] : [];
		}
		return [];
	};

	if (Array.isArray(contents)) {
		const parts = contents.flatMap((item) => collect(item));
		return parts.join("\n\n").trim();
	}
	if (contents !== undefined) {
		return collect(contents).join("\n\n").trim();
	}

	return "";
}

function normalizeSymbolEntry(raw: unknown): LspSymbolEntry | undefined {
	const record = asRecord(raw);
	if (!record || typeof record.name !== "string") return undefined;
	const kindNum = Number(record.kind);
	const kind = SYMBOL_KIND_MAP[kindNum] ?? (Number.isFinite(kindNum) ? `Kind${kindNum}` : "Unknown");

	const locationRecord = asRecord(record.location);
	if (locationRecord && typeof locationRecord.uri === "string") {
		const location = normalizeLocationFromUriAndRange(locationRecord.uri, locationRecord.range);
		return {
			name: record.name,
			kind,
			file: location?.file,
			line: location?.line,
			character: location?.character,
			containerName: typeof record.containerName === "string" ? record.containerName : undefined,
		};
	}

	const range = record.selectionRange ?? record.range;
	if (range) {
		const location = normalizeLocationFromUriAndRange("", range);
		return {
			name: record.name,
			kind,
			line: location?.line,
			character: location?.character,
			containerName: typeof record.containerName === "string" ? record.containerName : undefined,
		};
	}

	return {
		name: record.name,
		kind,
		containerName: typeof record.containerName === "string" ? record.containerName : undefined,
	};
}

function flattenDocumentSymbols(raw: unknown): LspSymbolEntry[] {
	const result: LspSymbolEntry[] = [];
	const visit = (value: unknown) => {
		const entry = normalizeSymbolEntry(value);
		if (entry) result.push(entry);
		const children = asRecord(value)?.children;
		for (const child of asArray(children)) {
			visit(child);
		}
	};
	for (const item of asArray(raw)) {
		visit(item);
	}
	return result;
}

function normalizeDiagnostics(raw: unknown): LspDiagnosticEntry[] {
	const result: LspDiagnosticEntry[] = [];
	for (const item of asArray(raw)) {
		const record = asRecord(item);
		if (!record || typeof record.message !== "string") continue;
		const range = asRecord(record.range);
		const start = asRecord(range?.start);
		const end = asRecord(range?.end);
		const startLine = Number(start?.line);
		const startCharacter = Number(start?.character);
		const endLine = Number(end?.line);
		const endCharacter = Number(end?.character);
		if (!Number.isFinite(startLine) || !Number.isFinite(startCharacter)) continue;

		const severityNum = Number(record.severity);
		const severity: LspDiagnosticEntry["severity"] =
			severityNum === 1 ? "error" : severityNum === 2 ? "warning" : severityNum === 3 ? "info" : "hint";

		result.push({
			message: record.message,
			severity,
			code:
				typeof record.code === "string" || typeof record.code === "number" ? String(record.code) : undefined,
			source: typeof record.source === "string" ? record.source : undefined,
			line: Math.floor(startLine) + 1,
			character: Math.floor(startCharacter) + 1,
			endLine: Number.isFinite(endLine) ? Math.floor(endLine) + 1 : Math.floor(startLine) + 1,
			endCharacter: Number.isFinite(endCharacter) ? Math.floor(endCharacter) + 1 : Math.floor(startCharacter) + 1,
		});
	}
	return result;
}

function formatLocations(title: string, locations: LspLocation[]): string {
	if (locations.length === 0) return `${title}: not found`;
	return [
		`${title}: ${locations.length}`,
		...locations.map((location, index) => `${index + 1}. ${location.file}:${location.line}:${location.character}`),
	].join("\n");
}

function formatSymbols(title: string, symbols: LspSymbolEntry[]): string {
	if (symbols.length === 0) return `${title}: none`;
	return [
		`${title}: ${symbols.length}`,
		...symbols.map((symbol, index) => {
			const location =
				symbol.file && symbol.line && symbol.character
					? ` @ ${symbol.file}:${symbol.line}:${symbol.character}`
					: "";
			const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
			return `${index + 1}. ${symbol.name} [${symbol.kind}]${container}${location}`;
		}),
	].join("\n");
}

function formatDiagnostics(file: string, diagnostics: LspDiagnosticEntry[]): string {
	if (diagnostics.length === 0) return `diagnostics: no issues for ${file}`;
	return [
		`diagnostics: ${diagnostics.length} issue(s) in ${file}`,
		...diagnostics.map(
			(diag, index) =>
				`${index + 1}. ${diag.severity.toUpperCase()} ${diag.line}:${diag.character} ${diag.message}${diag.code ? ` [${diag.code}]` : ""}`,
		),
	].join("\n");
}

function formatStatus(result: Extract<LspToolExecutionResult, { action: "status" }>): string {
	if (result.sessions.length === 0) {
		return `lsp status: no running sessions\nsupported languages: ${result.supportedLanguages.join(", ")}`;
	}
	return [
		`lsp status: ${result.sessions.length} running session(s)`,
		`supported languages: ${result.supportedLanguages.join(", ")}`,
		...result.sessions.map(
			(session, index) =>
				`${index + 1}. ${session.language} (${session.server}) root=${session.projectRoot} docs=${session.openDocuments} diagnostics=${session.cachedDiagnostics} uptime=${session.uptimeSeconds}s idle=${session.idleSeconds}s`,
		),
	].join("\n");
}

function formatLspResult(result: LspToolExecutionResult): string {
	switch (result.action) {
		case "status":
			return formatStatus(result);
		case "shutdown":
			return `lsp shutdown: stopped ${result.stoppedSessions} session(s)`;
		case "definition": {
			const base = formatLocations("definition", result.locations);
			return result.note ? `${base}\nnote: ${result.note}` : base;
		}
		case "references": {
			const base = formatLocations("references", result.locations);
			return result.note ? `${base}\nnote: ${result.note}` : base;
		}
		case "hover": {
			const lines = ["hover:"];
			if (result.range) {
				lines.push(`range: ${result.range.line}:${result.range.character}-${result.range.endLine ?? result.range.line}:${result.range.endCharacter ?? result.range.character}`);
			}
			lines.push(result.hoverText || "(no hover info)");
			if (result.note) lines.push(`note: ${result.note}`);
			return lines.join("\n");
		}
		case "document_symbols":
			return formatSymbols("document symbols", result.symbols);
		case "workspace_symbols": {
			const base = formatSymbols("workspace symbols", result.symbols);
			return result.note ? `${base}\nnote: ${result.note}` : base;
		}
		case "prepare_rename":
			if (!result.preparation) {
				const line = "prepare_rename: symbol cannot be safely renamed here";
				return result.note ? `${line}\nnote: ${result.note}` : line;
			}
			return [
				"prepare_rename: ok",
				`range: ${result.preparation.range.file}:${result.preparation.range.line}:${result.preparation.range.character}`,
				result.preparation.placeholder ? `placeholder: ${result.preparation.placeholder}` : "",
				result.note ? `note: ${result.note}` : "",
			]
				.filter(Boolean)
				.join("\n");
		case "diagnostics":
			return formatDiagnostics(result.file, result.diagnostics);
	}
}

class LspSession {
	private readonly key: string;
	private readonly language: LspLanguage;
	private readonly command: LspServerCommand;
	private readonly projectRoot: string;
	private readonly requestTimeoutMs: number;

	private child: ChildProcessWithoutNullStreams | undefined;
	private startPromise: Promise<void> | undefined;
	private startedAt = Date.now();
	private nextRequestId = 1;
	private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();
	private readonly openDocuments = new Map<string, OpenDocument>();
	private readonly diagnosticsByUri = new Map<string, LspDiagnosticEntry[]>();
	private incomingBuffer = Buffer.alloc(0);
	private expectedContentLength: number | undefined;
	private supportsPullDiagnostics = false;
	private initialized = false;
	private resolvedServerDisplay: string | undefined;

	constructor(options: LspSessionOptions) {
		this.key = options.key;
		this.language = options.language;
		this.command = options.command;
		this.projectRoot = options.projectRoot;
		this.requestTimeoutMs = options.requestTimeoutMs;
	}

	getStatus(now = Date.now()): LspSessionStatus {
		const diagnosticsCount = [...this.diagnosticsByUri.values()].reduce((sum, items) => sum + items.length, 0);
		return {
			key: this.key,
			language: this.language,
			server:
				this.resolvedServerDisplay ??
				`${this.command.command}${this.command.args.length > 0 ? ` ${this.command.args.join(" ")}` : ""}`,
			projectRoot: this.projectRoot,
			openDocuments: this.openDocuments.size,
			cachedDiagnostics: diagnosticsCount,
			uptimeSeconds: Math.max(0, Math.floor((now - this.startedAt) / 1000)),
			idleSeconds: 0,
		};
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.initialized) return;
		if (this.startPromise) return this.startPromise;

		this.startPromise = this.doStart(signal).catch((error) => {
			this.startPromise = undefined;
			throw error;
		});
		return this.startPromise;
	}

	private async doStart(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const resolvedCommand = resolveServerCommand(this.command, this.projectRoot);
		if (!resolvedCommand) {
			throw new Error(
				`No available LSP server command for ${this.language}. Tried "${this.command.command}" and fallbacks. ${this.command.installHint}`,
			);
		}
		this.resolvedServerDisplay = resolvedCommand.display;

		const child = spawn(resolvedCommand.command, resolvedCommand.args, {
			cwd: this.projectRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.startedAt = Date.now();

		child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
		child.stderr.on("data", (_chunk: Buffer) => {
			// Intentionally ignored: stderr is often noisy for LSP servers and not actionable per request.
		});
		child.on("exit", (code, sig) => {
			this.initialized = false;
			this.child = undefined;
			this.rejectAllPending(
				new Error(
					`LSP server exited (${this.resolvedServerDisplay ?? this.command.command}) with code ${code ?? "null"} signal ${sig ?? "none"}.`,
				),
			);
		});

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const onError = (error: Error) => {
				if (settled) return;
				settled = true;
				reject(
					new Error(
						`Failed to start LSP server \"${this.resolvedServerDisplay ?? this.command.command}\": ${error.message}. ${this.command.installHint}`,
					),
				);
			};
			const onSpawn = () => {
				if (settled) return;
				settled = true;
				resolve();
			};
			child.once("error", onError);
			child.once("spawn", onSpawn);
		});

		const initializeResult = await this.sendRequest(
			"initialize",
			{
				processId: process.pid,
				rootUri: toFileUri(this.projectRoot),
				rootPath: this.projectRoot,
				capabilities: {
					workspace: {
						applyEdit: false,
						workspaceEdit: {
							documentChanges: false,
						},
						configuration: true,
					},
					textDocument: {
						hover: {
							contentFormat: ["markdown", "plaintext"],
						},
						definition: {},
						references: {},
						documentSymbol: {
							hierarchicalDocumentSymbolSupport: true,
						},
						rename: {
							prepareSupport: true,
						},
						publishDiagnostics: {
							relatedInformation: true,
						},
					},
				},
				clientInfo: {
					name: "iosm-cli",
					version: "0",
				},
				initializationOptions:
					this.language === "python"
						? {
								python: {
									analysis: {
										autoSearchPaths: true,
										useLibraryCodeForTypes: true,
										diagnosticMode: "workspace",
										extraPaths: [this.projectRoot],
									},
								},
								pylsp: {
									plugins: {
										jedi: {
											extra_paths: [this.projectRoot],
										},
									},
								},
							}
						: undefined,
				workspaceFolders: [
					{
						uri: toFileUri(this.projectRoot),
						name: basename(this.projectRoot),
					},
				],
			},
			STARTUP_TIMEOUT_MS,
			signal,
		);

		const capabilities = asRecord(asRecord(initializeResult)?.capabilities);
		this.supportsPullDiagnostics = !!capabilities?.diagnosticProvider;
		this.sendNotification("initialized", {});
		this.initialized = true;
	}

	private ensureRunning(): ChildProcessWithoutNullStreams {
		if (!this.child || this.child.killed || this.child.exitCode !== null) {
			throw new Error(`LSP server is not running for ${this.language}.`);
		}
		return this.child;
	}

	private sendMessage(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | JsonRpcErrorResponse): void {
		const child = this.ensureRunning();
		const body = JSON.stringify(payload);
		const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
		child.stdin.write(`${header}${body}`, "utf8");
	}

	private sendNotification(method: string, params?: unknown): void {
		this.sendMessage({
			jsonrpc: "2.0",
			method,
			...(params !== undefined ? { params } : {}),
		});
	}

	private sendResponse(id: JsonRpcId, result: unknown): void {
		this.sendMessage({
			jsonrpc: "2.0",
			id,
			result,
		});
	}

	private sendErrorResponse(id: JsonRpcId, code: number, message: string): void {
		this.sendMessage({
			jsonrpc: "2.0",
			id,
			error: { code, message },
		});
	}

	private rejectAllPending(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			if (pending.signal && pending.onAbort) {
				pending.signal.removeEventListener("abort", pending.onAbort);
			}
			pending.reject(error);
			this.pendingRequests.delete(id);
		}
	}

	private formatRpcError(error: unknown): string {
		const record = asRecord(error);
		const code = Number(record?.code);
		const message = typeof record?.message === "string" ? record.message : "Unknown RPC error";
		if (Number.isFinite(code)) {
			return `[${Math.floor(code)}] ${message}`;
		}
		return message;
	}

	private sendRequest(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		this.ensureRunning();
		const id = this.nextRequestId++;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const pending = this.pendingRequests.get(id);
				if (!pending) return;
				this.pendingRequests.delete(id);
				if (pending.signal && pending.onAbort) {
					pending.signal.removeEventListener("abort", pending.onAbort);
				}
				reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`));
			}, timeoutMs);

			const pending: PendingRequest = {
				resolve: (value) => {
					clearTimeout(timeout);
					if (pending.signal && pending.onAbort) {
						pending.signal.removeEventListener("abort", pending.onAbort);
					}
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timeout);
					if (pending.signal && pending.onAbort) {
						pending.signal.removeEventListener("abort", pending.onAbort);
					}
					reject(error);
				},
				timeout,
			};

			if (signal) {
				const onAbort = () => {
					const active = this.pendingRequests.get(id);
					if (!active) return;
					this.pendingRequests.delete(id);
					clearTimeout(active.timeout);
					reject(new Error("Operation aborted"));
				};
				pending.signal = signal;
				pending.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pendingRequests.set(id, pending);
			this.sendMessage({
				jsonrpc: "2.0",
				id,
				method,
				params,
			});
		});
	}

	private handleStdout(chunk: Buffer): void {
		this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);

		while (true) {
			if (!Number.isFinite(this.expectedContentLength)) {
				const headerEnd = this.incomingBuffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;

				const headerText = this.incomingBuffer.slice(0, headerEnd).toString("utf8");
				this.incomingBuffer = this.incomingBuffer.slice(headerEnd + 4);

				const lengthHeader = headerText
					.split(/\r\n/)
					.find((line) => line.toLowerCase().startsWith("content-length:"));
				if (!lengthHeader) {
					this.expectedContentLength = undefined;
					continue;
				}
				const length = Number(lengthHeader.slice("content-length:".length).trim());
				if (!Number.isFinite(length) || length < 0) {
					this.expectedContentLength = undefined;
					continue;
				}
				this.expectedContentLength = length;
			}

			if (this.incomingBuffer.length < (this.expectedContentLength as number)) {
				return;
			}

			const body = this.incomingBuffer.slice(0, this.expectedContentLength as number);
			this.incomingBuffer = this.incomingBuffer.slice(this.expectedContentLength as number);
			this.expectedContentLength = undefined;

			let parsed: unknown;
			try {
				parsed = JSON.parse(body.toString("utf8"));
			} catch {
				continue;
			}
			this.handleRpcMessage(parsed);
		}
	}

	private handleRpcMessage(message: unknown): void {
		const record = asRecord(message);
		if (!record) return;

		const id = Number(record.id);
		const hasResult = Object.prototype.hasOwnProperty.call(record, "result");
		const hasError = Object.prototype.hasOwnProperty.call(record, "error");
		if (Number.isFinite(id) && (hasResult || hasError)) {
			const pending = this.pendingRequests.get(id);
			if (!pending) return;
			this.pendingRequests.delete(id);
			if (hasError) {
				pending.reject(new Error(this.formatRpcError(record.error)));
				return;
			}
			pending.resolve(record.result);
			return;
		}

		if (typeof record.method !== "string") return;
		if (Number.isFinite(id)) {
			this.handleServerRequest(id, record.method, record.params);
			return;
		}
		this.handleServerNotification(record.method, record.params);
	}

	private handleServerNotification(method: string, params: unknown): void {
		if (method !== "textDocument/publishDiagnostics") return;
		const paramsRecord = asRecord(params);
		const uri = typeof paramsRecord?.uri === "string" ? paramsRecord.uri : undefined;
		if (!uri) return;
		const diagnostics = normalizeDiagnostics(paramsRecord?.diagnostics);
		this.diagnosticsByUri.set(uri, diagnostics);
	}

	private resolveWorkspaceConfigurationItem(item: unknown): unknown {
		const itemRecord = asRecord(item);
		const section = typeof itemRecord?.section === "string" ? itemRecord.section : "";
		if (!section) return null;
		if (this.language !== "python") return null;

		const extraPaths = [this.projectRoot];
		if (section === "python") {
			return {
				analysis: {
					autoSearchPaths: true,
					useLibraryCodeForTypes: true,
					diagnosticMode: "workspace",
					extraPaths,
				},
				autoComplete: {
					extraPaths,
				},
			};
		}
		if (section === "python.analysis") {
			return {
				autoSearchPaths: true,
				useLibraryCodeForTypes: true,
				diagnosticMode: "workspace",
				extraPaths,
			};
		}
		if (section === "python.analysis.extraPaths" || section === "python.autoComplete.extraPaths") {
			return extraPaths;
		}
		if (section === "pylsp") {
			return {
				plugins: {
					jedi: {
						extra_paths: extraPaths,
					},
				},
			};
		}
		if (section === "pylsp.plugins.jedi.extra_paths") {
			return extraPaths;
		}
		if (section === "pyright") {
			return {
				python: {
					analysis: {
						autoSearchPaths: true,
						useLibraryCodeForTypes: true,
						diagnosticMode: "workspace",
						extraPaths,
					},
				},
			};
		}
		return null;
	}

	private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
		if (method === "workspace/configuration") {
			const items = asArray(asRecord(params)?.items).map((item) => this.resolveWorkspaceConfigurationItem(item));
			this.sendResponse(id, items);
			return;
		}
		if (method === "workspace/workspaceFolders") {
			this.sendResponse(id, [
				{
					uri: toFileUri(this.projectRoot),
					name: basename(this.projectRoot),
				},
			]);
			return;
		}
		if (
			method === "window/workDoneProgress/create" ||
			method === "client/registerCapability" ||
			method === "client/unregisterCapability"
		) {
			this.sendResponse(id, null);
			return;
		}
		if (method === "workspace/applyEdit") {
			this.sendResponse(id, { applied: false });
			return;
		}
		this.sendErrorResponse(id, -32601, `Method not supported by iosm LSP client: ${method}`);
	}

	async syncDocument(filePath: string, language: LspLanguage): Promise<{ uri: string; filePath: string }> {
		await this.start();
		const absolute = resolvePath(filePath);
		const uri = toFileUri(absolute);
		let text: string;
		try {
			text = readFileSync(absolute, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Unable to read file for LSP sync: ${absolute} (${message})`);
		}

		const languageId = inferLanguageId(absolute, language);
		const current = this.openDocuments.get(uri);
		if (!current) {
			this.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version: 1,
					text,
				},
			});
			this.openDocuments.set(uri, { version: 1, text });
			return { uri, filePath: absolute };
		}

		if (current.text !== text) {
			const nextVersion = current.version + 1;
			this.sendNotification("textDocument/didChange", {
				textDocument: {
					uri,
					version: nextVersion,
				},
				contentChanges: [{ text }],
			});
			this.openDocuments.set(uri, {
				version: nextVersion,
				text,
			});
		}

		return { uri, filePath: absolute };
	}

	async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		await this.start(signal);
		return this.sendRequest(method, params, this.requestTimeoutMs, signal);
	}

	getCachedDiagnostics(uri: string): LspDiagnosticEntry[] {
		return this.diagnosticsByUri.get(uri) ?? [];
	}

	canPullDiagnostics(): boolean {
		return this.supportsPullDiagnostics;
	}

	async stop(): Promise<void> {
		if (!this.child) return;
		const child = this.child;

		if (child.exitCode === null && !child.killed) {
			try {
				await this.sendRequest("shutdown", {}, 3_000);
			} catch {
				// best-effort shutdown
			}
			try {
				this.sendNotification("exit");
			} catch {
				// ignore
			}

			await new Promise<void>((resolve) => {
				let settled = false;
				const done = () => {
					if (settled) return;
					settled = true;
					resolve();
				};
				const timer = setTimeout(() => {
					if (child.pid) {
						killProcessTree(child.pid);
					}
					done();
				}, 2_000);
				child.once("exit", () => {
					clearTimeout(timer);
					done();
				});
			});
		}

		this.child = undefined;
		this.initialized = false;
		this.startPromise = undefined;
		this.resolvedServerDisplay = undefined;
		this.rejectAllPending(new Error(`LSP session stopped: ${this.language}`));
	}
}

class LspRuntimeManager implements LspToolRuntime {
	private readonly cwd: string;
	private readonly requestTimeoutMs: number;
	private readonly idleTimeoutMs: number;
	private readonly serverCommands: Record<LspServerKind, LspServerCommand>;
	private readonly sessions = new Map<string, LspSessionRecord>();

	constructor(cwd: string, options?: LspToolOptions) {
		this.cwd = resolvePath(cwd);
		this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
		this.serverCommands = {
			...DEFAULT_SERVER_COMMANDS,
			...(options?.serverCommands ?? {}),
		};
	}

	private resolveLanguage(input: LspToolInput, filePath?: string): LspLanguage {
		if (input.language) return input.language;
		if (filePath) {
			const inferred = inferLanguageFromFile(filePath);
			if (inferred) return inferred;
		}
		throw new Error(
			"Unable to resolve language. Provide language explicitly or use a supported file extension (.ts/.tsx/.js/.jsx/.py/.go/.rs).",
		);
	}

	private resolveFilePath(input: LspToolInput): string {
		if (!input.file) {
			throw new Error("file is required for this action.");
		}
		return resolveReadPath(input.file, this.cwd);
	}

	private resolveSessionKey(language: LspLanguage): string {
		return `${this.cwd}::${language}`;
	}

	private async getSession(language: LspLanguage, signal?: AbortSignal): Promise<LspSessionRecord> {
		this.cleanupExpiredSessions();
		const key = this.resolveSessionKey(language);
		const existing = this.sessions.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing;
		}

		const serverKind = resolveServerKind(language);
		const command = this.serverCommands[serverKind];
		const session = new LspSession({
			key,
			language,
			command,
			projectRoot: this.cwd,
			requestTimeoutMs: this.requestTimeoutMs,
		});
		await session.start(signal);
		const createdAt = Date.now();
		const record: LspSessionRecord = {
			session,
			lastUsedAt: createdAt,
		};
		this.sessions.set(key, record);
		return record;
	}

	private async resolveSessionForWorkspaceAction(input: LspToolInput, signal?: AbortSignal): Promise<LspSessionRecord> {
		if (input.file) {
			const filePath = this.resolveFilePath(input);
			const language = this.resolveLanguage(input, filePath);
			return this.getSession(language, signal);
		}
		if (input.language) {
			return this.getSession(input.language, signal);
		}
		if (this.sessions.size === 1) {
			const first = this.sessions.values().next().value as LspSessionRecord;
			first.lastUsedAt = Date.now();
			return first;
		}
		if (this.sessions.size === 0) {
			throw new Error("No active LSP session. Provide language (or file) for workspace_symbols.");
		}
		throw new Error("Multiple LSP sessions are active. Provide language (or file) for workspace_symbols.");
	}

	private cleanupExpiredSessions(): void {
		const now = Date.now();
		for (const [key, record] of this.sessions) {
			if (now - record.lastUsedAt <= this.idleTimeoutMs) continue;
			this.sessions.delete(key);
			void record.session.stop().catch(() => undefined);
		}
	}

	private async syncFileAndSession(
		input: LspToolInput,
		signal?: AbortSignal,
	): Promise<{ sessionRecord: LspSessionRecord; uri: string; filePath: string; language: LspLanguage }> {
		const filePath = this.resolveFilePath(input);
		const language = this.resolveLanguage(input, filePath);
		const sessionRecord = await this.getSession(language, signal);
		sessionRecord.lastUsedAt = Date.now();
		const synced = await sessionRecord.session.syncDocument(filePath, language);
		return {
			sessionRecord,
			uri: synced.uri,
			filePath: synced.filePath,
			language,
		};
	}

	private async executeStatus(): Promise<LspToolExecutionResult> {
		this.cleanupExpiredSessions();
		const now = Date.now();
		const sessions = [...this.sessions.values()].map((record) => {
			const status = record.session.getStatus(now);
			status.idleSeconds = Math.max(0, Math.floor((now - record.lastUsedAt) / 1000));
			return status;
		});
		return {
			action: "status",
			sessions,
			supportedLanguages: [...SUPPORTED_LANGUAGES],
		};
	}

	private async executeShutdown(): Promise<LspToolExecutionResult> {
		const records = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(records.map((record) => record.session.stop().catch(() => undefined)));
		return {
			action: "shutdown",
			stoppedSessions: records.length,
		};
	}

	private async executeDefinition(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const { sessionRecord, uri, filePath, language } = await this.syncFileAndSession(input, signal);
		const pos = normalizePosition(input);
		const pythonImportTarget =
			language === "python" ? resolvePythonImportFallbackTarget(this.cwd, filePath, pos.line, pos.character) : undefined;
		const result = await sessionRecord.session.request(
			"textDocument/definition",
			{
				textDocument: { uri },
				position: {
					line: pos.line - 1,
					character: pos.character - 1,
				},
			},
			signal,
		);
		const limit = normalizeLimit(input.limit);
		const locations = normalizeLocations(result).slice(0, limit);
		if (language === "python" && pythonImportTarget?.cursorMode === "statement") {
			const probePosition = pythonImportTarget.modulePosition;
			if (probePosition.line !== pos.line || probePosition.character !== pos.character) {
				const probeResult = await sessionRecord.session.request(
					"textDocument/definition",
					{
						textDocument: { uri },
						position: {
							line: probePosition.line - 1,
							character: probePosition.character - 1,
						},
					},
					signal,
				);
					const probeLocations = normalizeLocations(probeResult).slice(0, limit);
					if (probeLocations.length > 0) {
						return {
							action: "definition",
							locations: probeLocations,
						};
					}
				}
			if (locations.length > 0) {
				return {
					action: "definition",
					locations,
				};
			}
			const fallback = fallbackPythonImportDefinition(this.cwd, filePath, pos.line, pos.character);
			if (fallback && fallback.locations.length > 0) {
				return {
					action: "definition",
					locations: fallback.locations.slice(0, limit),
					note: fallback.note,
				};
			}
		}
		if (locations.length === 0 && language === "python") {
			const fallback = fallbackPythonImportDefinition(this.cwd, filePath, pos.line, pos.character);
			if (fallback && fallback.locations.length > 0) {
				return {
					action: "definition",
					locations: fallback.locations.slice(0, limit),
					note: fallback.note,
				};
			}
		}
		return {
			action: "definition",
			locations,
		};
	}

	private async executeReferences(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const { sessionRecord, uri, filePath, language } = await this.syncFileAndSession(input, signal);
		const pos = normalizePosition(input);
		const pythonImportTarget =
			language === "python" ? resolvePythonImportFallbackTarget(this.cwd, filePath, pos.line, pos.character) : undefined;
		const result = await sessionRecord.session.request(
			"textDocument/references",
			{
				textDocument: { uri },
				position: {
					line: pos.line - 1,
					character: pos.character - 1,
				},
				context: {
					includeDeclaration: input.include_declaration === true,
				},
			},
			signal,
		);
		const limit = normalizeLimit(input.limit);
		const locations = normalizeLocations(result).slice(0, limit);
		if (language === "python" && pythonImportTarget?.cursorMode === "statement") {
			const probePosition = pythonImportTarget.modulePosition;
			if (probePosition.line !== pos.line || probePosition.character !== pos.character) {
				const probeResult = await sessionRecord.session.request(
					"textDocument/references",
					{
						textDocument: { uri },
						position: {
							line: probePosition.line - 1,
							character: probePosition.character - 1,
						},
						context: {
							includeDeclaration: input.include_declaration === true,
						},
					},
					signal,
				);
				const probeLocations = normalizeLocations(probeResult).slice(0, limit);
				if (probeLocations.length > 0) {
					return {
						action: "references",
						locations: probeLocations,
					};
				}
			}
		}
		return {
			action: "references",
			locations,
		};
	}

	private async executeHover(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const { sessionRecord, uri, filePath, language } = await this.syncFileAndSession(input, signal);
		const pos = normalizePosition(input);
		const pythonImportTarget =
			language === "python" ? resolvePythonImportFallbackTarget(this.cwd, filePath, pos.line, pos.character) : undefined;
		const result = await sessionRecord.session.request(
			"textDocument/hover",
			{
				textDocument: { uri },
				position: {
					line: pos.line - 1,
					character: pos.character - 1,
				},
			},
			signal,
		);
		const hoverText = normalizeHoverText(result);
		const range = normalizeLocations([{
			uri,
			range: asRecord(result)?.range,
		}])[0];
		if (language === "python" && pythonImportTarget?.cursorMode === "statement") {
			const probePosition = pythonImportTarget.modulePosition;
			if (probePosition.line !== pos.line || probePosition.character !== pos.character) {
				const probeResult = await sessionRecord.session.request(
					"textDocument/hover",
					{
						textDocument: { uri },
						position: {
							line: probePosition.line - 1,
							character: probePosition.character - 1,
						},
					},
					signal,
				);
				const probeHoverText = normalizeHoverText(probeResult);
					if (probeHoverText) {
						const probeRange = normalizeLocations([{
							uri,
							range: asRecord(probeResult)?.range,
						}])[0];
						return {
							action: "hover",
							hoverText: probeHoverText,
							range: probeRange,
						};
					}
				}
			if (hoverText) {
				return {
					action: "hover",
					hoverText,
					range,
				};
			}
			const fallback = fallbackPythonImportHover(this.cwd, filePath, pos.line, pos.character);
			if (fallback) {
				return {
					action: "hover",
					hoverText: fallback.hoverText,
					range: fallback.range,
					note: fallback.note,
				};
			}
		}
		if (!hoverText && language === "python") {
			const fallback = fallbackPythonImportHover(this.cwd, filePath, pos.line, pos.character);
			if (fallback) {
				return {
					action: "hover",
					hoverText: fallback.hoverText,
					range: fallback.range,
					note: fallback.note,
				};
			}
		}
		return {
			action: "hover",
			hoverText,
			range,
		};
	}

	private async executeDocumentSymbols(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const { sessionRecord, uri } = await this.syncFileAndSession(input, signal);
		const result = await sessionRecord.session.request(
			"textDocument/documentSymbol",
			{
				textDocument: { uri },
			},
			signal,
		);
		const symbols = flattenDocumentSymbols(result).slice(0, normalizeLimit(input.limit));
		return {
			action: "document_symbols",
			symbols,
		};
	}

	private async fallbackPrepareRename(
		session: LspSession,
		uri: string,
		filePath: string,
		line: number,
		character: number,
		signal?: AbortSignal,
	): Promise<Extract<LspToolExecutionResult, { action: "prepare_rename" }>> {
		const identifier = extractIdentifierAtPosition(filePath, line, character);
		if (!identifier) {
			return {
				action: "prepare_rename",
				preparation: null,
				note: "Server does not support textDocument/prepareRename; fallback could not detect an identifier at cursor.",
			};
		}

		let referencesCount = 0;
		try {
			const references = await session.request(
				"textDocument/references",
				{
					textDocument: { uri },
					position: {
						line: line - 1,
						character: character - 1,
					},
					context: {
						includeDeclaration: true,
					},
				},
				signal,
			);
			referencesCount = normalizeLocations(references).length;
		} catch {
			// Keep heuristic fallback if references call is unavailable.
		}

		return {
			action: "prepare_rename",
			preparation: {
				placeholder: identifier.name,
				range: {
					file: filePath,
					line,
					character: identifier.startCharacter,
					endLine: line,
					endCharacter: identifier.endCharacter,
				},
			},
			note:
				referencesCount > 0
					? `Heuristic fallback used because server does not support textDocument/prepareRename (found ${referencesCount} reference candidate(s)).`
					: "Heuristic fallback used because server does not support textDocument/prepareRename.",
		};
	}

	private async executeWorkspaceSymbols(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const query = (input.query ?? "").trim();
		if (!query) {
			throw new Error("query is required for workspace_symbols action.");
		}
		const sessionRecord = await this.resolveSessionForWorkspaceAction(input, signal);
		sessionRecord.lastUsedAt = Date.now();
		const limit = normalizeLimit(input.limit);
		try {
			const result = await sessionRecord.session.request(
				"workspace/symbol",
				{ query },
				signal,
			);
			const symbols = asArray(result)
				.map((item) => normalizeSymbolEntry(item))
				.filter((item): item is LspSymbolEntry => item !== undefined)
				.slice(0, limit);
			return {
				action: "workspace_symbols",
				symbols,
			};
		} catch (error) {
			if (!isMethodNotSupportedError(error)) {
				throw error;
			}
			const language = sessionRecord.session.getStatus().language;
			const fallback = fallbackWorkspaceSymbols(this.cwd, language, query, limit);
			return {
				action: "workspace_symbols",
				symbols: fallback.symbols,
				note: `workspace/symbol is not supported by ${language} server; returned heuristic declaration scan from ${fallback.scannedFiles} file(s).`,
			};
		}
	}

	private async executePrepareRename(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const { sessionRecord, uri, filePath } = await this.syncFileAndSession(input, signal);
		const pos = normalizePosition(input);
		let result: unknown;
		try {
			result = await sessionRecord.session.request(
				"textDocument/prepareRename",
				{
					textDocument: { uri },
					position: {
						line: pos.line - 1,
						character: pos.character - 1,
					},
				},
				signal,
			);
		} catch (error) {
			if (!isMethodNotSupportedError(error)) {
				throw error;
			}
			return this.fallbackPrepareRename(sessionRecord.session, uri, filePath, pos.line, pos.character, signal);
		}

		if (result === null || result === undefined) {
			return {
				action: "prepare_rename",
				preparation: null,
			};
		}

		const resultRecord = asRecord(result);
		const placeholder = typeof resultRecord?.placeholder === "string" ? resultRecord.placeholder : undefined;
		const rangeRaw = resultRecord?.range ?? resultRecord;
		const range = normalizeLocationFromUriAndRange(toFileUri(filePath), rangeRaw);
		if (!range) {
			return {
				action: "prepare_rename",
				preparation: null,
			};
		}

		return {
			action: "prepare_rename",
			preparation: {
				placeholder,
				range,
			},
		};
	}

	private async executeDiagnostics(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		const { sessionRecord, uri, filePath } = await this.syncFileAndSession(input, signal);
		sessionRecord.lastUsedAt = Date.now();

		let diagnostics = sessionRecord.session.getCachedDiagnostics(uri);
		if (sessionRecord.session.canPullDiagnostics()) {
			try {
				const pull = await sessionRecord.session.request(
					"textDocument/diagnostic",
					{ textDocument: { uri } },
					signal,
				);
				const pullRecord = asRecord(pull);
				if (pullRecord?.kind === "full") {
					diagnostics = normalizeDiagnostics(pullRecord.items);
				} else if (Array.isArray(pullRecord?.items)) {
					diagnostics = normalizeDiagnostics(pullRecord.items);
				}
			} catch {
				// Fallback to push-diagnostic cache when pull diagnostics are unsupported or fail.
			}
		}

		return {
			action: "diagnostics",
			file: filePath,
			diagnostics: diagnostics.slice(0, normalizeLimit(input.limit)),
		};
	}

	async execute(input: LspToolInput, signal?: AbortSignal): Promise<LspToolExecutionResult> {
		switch (input.action) {
			case "status":
				return this.executeStatus();
			case "shutdown":
				return this.executeShutdown();
			case "definition":
				return this.executeDefinition(input, signal);
			case "references":
				return this.executeReferences(input, signal);
			case "hover":
				return this.executeHover(input, signal);
			case "document_symbols":
				return this.executeDocumentSymbols(input, signal);
			case "workspace_symbols":
				return this.executeWorkspaceSymbols(input, signal);
			case "prepare_rename":
				return this.executePrepareRename(input, signal);
			case "diagnostics":
				return this.executeDiagnostics(input, signal);
			default:
				throw new Error(`Unsupported lsp action: ${(input as { action: string }).action}`);
		}
	}
}

export function createLspTool(cwd: string, options?: LspToolOptions): AgentTool<typeof lspSchema> {
	const runtime = options?.runtime ?? new LspRuntimeManager(cwd, options);

	return {
		name: "lsp",
		label: "lsp",
		description:
			"Language Server Protocol tool for semantic code intelligence. Actions: status, definition, references, hover, document_symbols, workspace_symbols, prepare_rename, diagnostics, shutdown.",
		parameters: lspSchema,
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
			const input = params as LspToolInput;
			const result = await runtime.execute(input, signal);
			return {
				content: [{ type: "text" as const, text: formatLspResult(result) }],
				details: { result } satisfies LspToolDetails,
			};
		},
	};
}

export const lspTool = createLspTool(process.cwd());

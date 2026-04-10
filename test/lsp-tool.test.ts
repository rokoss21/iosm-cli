import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LspToolExecutionResult, LspToolInput, LspToolRuntime } from "../src/core/tools/lsp.js";
import { createLspTool } from "../src/core/tools/lsp.js";

describe("lsp tool", () => {
	it("delegates requests to injected runtime and formats definition output", async () => {
		const execute = vi.fn(async (_input: LspToolInput): Promise<LspToolExecutionResult> => ({
			action: "definition",
			locations: [
				{
					file: "src/auth.ts",
					line: 42,
					character: 7,
				},
			],
		}));

		const runtime: LspToolRuntime = { execute };
		const tool = createLspTool(process.cwd(), { runtime });
		const result = await tool.execute("lsp-definition", {
			action: "definition",
			file: "src/auth.ts",
			line: 10,
			character: 2,
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(
			{
				action: "definition",
				file: "src/auth.ts",
				line: 10,
				character: 2,
			},
			undefined,
		);

		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text).toContain("definition: 1");
		expect(text).toContain("src/auth.ts:42:7");
	});

	it("formats status output and returns structured details", async () => {
		const runtime: LspToolRuntime = {
			execute: async (): Promise<LspToolExecutionResult> => ({
				action: "status",
				supportedLanguages: ["typescript", "javascript", "python", "go", "rust"],
				sessions: [
					{
						key: "k1",
						language: "typescript",
						server: "typescript-language-server --stdio",
						projectRoot: "/tmp/project",
						openDocuments: 2,
						cachedDiagnostics: 3,
						uptimeSeconds: 12,
						idleSeconds: 1,
					},
				],
			}),
		};

		const tool = createLspTool(process.cwd(), { runtime });
		const result = await tool.execute("lsp-status", { action: "status" });

		expect(result.details).toBeDefined();
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(text).toContain("lsp status: 1 running session(s)");
		expect(text).toContain("supported languages: typescript, javascript, python, go, rust");
	});

	it("includes fallback notes in workspace symbols and prepare_rename output", async () => {
		const runtime: LspToolRuntime = {
			execute: async (input: LspToolInput): Promise<LspToolExecutionResult> => {
				if (input.action === "workspace_symbols") {
					return {
						action: "workspace_symbols",
						symbols: [],
						note: "workspace/symbol is not supported by server; heuristic fallback used.",
					};
				}
				return {
					action: "prepare_rename",
					preparation: null,
					note: "Server does not support textDocument/prepareRename.",
				};
			},
		};

		const tool = createLspTool(process.cwd(), { runtime });

		const workspaceResult = await tool.execute("lsp-workspace", {
			action: "workspace_symbols",
			query: "Condition",
			language: "python",
		});
		const workspaceText = workspaceResult.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(workspaceText).toContain("workspace symbols: none");
		expect(workspaceText).toContain("note: workspace/symbol is not supported");

		const renameResult = await tool.execute("lsp-rename", {
			action: "prepare_rename",
			file: "src/auth.ts",
			line: 3,
			character: 5,
		});
		const renameText = renameResult.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(renameText).toContain("prepare_rename: symbol cannot be safely renamed here");
		expect(renameText).toContain("note: Server does not support textDocument/prepareRename.");
	});

	it("renders notes for definition and hover fallback responses", async () => {
		const runtime: LspToolRuntime = {
			execute: async (input: LspToolInput): Promise<LspToolExecutionResult> => {
				if (input.action === "definition") {
					return {
						action: "definition",
						locations: [
							{
								file: "/tmp/kwork_api.py",
								line: 102,
								character: 1,
							},
						],
						note: "Fallback definition resolved module path for import \"kwork_api\".",
					};
				}
				return {
					action: "hover",
					hoverText: "Python module: kwork_api\nfile: /tmp/kwork_api.py",
					note: "Fallback hover used import-module resolution.",
				};
			},
		};

		const tool = createLspTool(process.cwd(), { runtime });
		const definition = await tool.execute("lsp-definition-note", {
			action: "definition",
			file: "main.py",
			line: 34,
			character: 8,
		});
		const definitionText = definition.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(definitionText).toContain("definition: 1");
		expect(definitionText).toContain("note: Fallback definition resolved module path");

		const hover = await tool.execute("lsp-hover-note", {
			action: "hover",
			file: "main.py",
			line: 34,
			character: 8,
		});
		const hoverText = hover.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		expect(hoverText).toContain("Python module: kwork_api");
		expect(hoverText).toContain("note: Fallback hover used import-module resolution.");
	});

	it(
		"resolves Python import-line fallback for keyword positions (from/import line)",
		async () => {
			const testDir = mkdtempSync(join(tmpdir(), "iosm-lsp-python-"));
			try {
				writeFileSync(
					join(testDir, "main.py"),
					[
						"from kwork_api import KworkAPI",
						"",
						"api = KworkAPI()",
						"api.get_projects()",
						"",
					].join("\n"),
					"utf8",
				);
				writeFileSync(
					join(testDir, "kwork_api.py"),
					[
						"class KworkAPI:",
						"    def get_projects(self) -> list[dict]:",
						'        \"\"\"Return projects list.\"\"\"',
						"        return []",
						"",
					].join("\n"),
					"utf8",
				);

				const tool = createLspTool(testDir, {
					requestTimeoutMs: 12_000,
					idleTimeoutMs: 30_000,
				});

				const definitionResult = await tool.execute("lsp-def-import-line", {
					action: "definition",
					file: "main.py",
					line: 1,
					character: 1, // Cursor on "from" keyword
					language: "python",
				});
				const definitionText = definitionResult.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				expect(definitionText).toContain("definition: 1");
				expect(definitionText).toContain("kwork_api.py:1:1");

				const hoverResult = await tool.execute("lsp-hover-import-line", {
					action: "hover",
					file: "main.py",
					line: 1,
					character: 1, // Cursor on "from" keyword
					language: "python",
				});
					const hoverText = hoverResult.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					expect(hoverText).toContain("kwork_api");
					if (hoverText.includes("note:")) {
						expect(hoverText.includes("note: Fallback hover used import-module resolution.")).toBe(true);
					}

				await tool.execute("lsp-shutdown-import-line", {
					action: "shutdown",
					language: "python",
				});
			} finally {
				rmSync(testDir, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

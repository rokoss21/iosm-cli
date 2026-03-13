import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSharedMemoryReadTool, createSharedMemoryWriteTool } from "../src/core/tools/shared-memory.js";

describe("shared memory tool payload shaping", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "iosm-shared-memory-tools-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("returns compact details and defaults read include_values to false", async () => {
		const value = "v".repeat(320);
		const context = {
			rootCwd: cwd,
			runId: "run_tools",
			taskId: "task_1",
		};
		const writeTool = createSharedMemoryWriteTool(context);
		const readTool = createSharedMemoryReadTool(context);

		const writeResult = await writeTool.execute("write_1", {
			key: "findings/auth",
			value,
			scope: "run",
			mode: "set",
		});
		const writeItem = (writeResult.details as { item: Record<string, unknown> }).item;
		expect(writeItem.valueLength).toBe(320);
		expect(writeItem.valuePreview).toBeUndefined();
		expect(writeItem.value).toBeUndefined();

		const readDefault = await readTool.execute("read_1", {
			scope: "run",
			key: "findings/auth",
		});
		const defaultItems = (readDefault.details as { items: Array<Record<string, unknown>> }).items;
		expect(defaultItems).toHaveLength(1);
		expect(defaultItems[0]?.valueLength).toBeUndefined();
		expect(defaultItems[0]?.valuePreview).toBeUndefined();

		const readWithValues = await readTool.execute("read_2", {
			scope: "run",
			key: "findings/auth",
			include_values: true,
		});
		const valueItems = (readWithValues.details as { items: Array<Record<string, unknown>> }).items;
		expect(valueItems).toHaveLength(1);
		expect(typeof valueItems[0]?.valuePreview).toBe("string");
		expect(String(valueItems[0]?.valuePreview).length).toBeLessThanOrEqual(200);
	});

	it("emits scope warning in meta context when scope is omitted", async () => {
		const context = {
			rootCwd: cwd,
			runId: "run_tools_meta",
			taskId: "task_1",
			profile: "meta",
		};
		const writeTool = createSharedMemoryWriteTool(context);
		const readTool = createSharedMemoryReadTool(context);

		const writeResult = await writeTool.execute("write_meta_1", {
			key: "findings/meta",
			value: "meta note",
		});
		const writeText = (writeResult.content[0] as { type: "text"; text: string }).text;
		expect(writeText).toContain('warning: scope omitted -> defaulted to "task"');

		const readResult = await readTool.execute("read_meta_1", {
			key: "findings/meta",
		});
		const readText = (readResult.content[0] as { type: "text"; text: string }).text;
		expect(readText).toContain('warning: scope omitted -> defaulted to "task"');
	});
});

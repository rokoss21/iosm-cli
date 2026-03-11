import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamRun, getTeamRun, updateTeamTaskStatus } from "../src/core/agent-teams.js";
import { createTaskTool } from "../src/core/tools/task.js";

describe("subagent orchestration", () => {
	const tempDirs: string[] = [];

	const makeTempDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-subagent-orch-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0, tempDirs.length)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates team task status lifecycle on disk", () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			task: "test orchestration",
			assignments: [
				{ profile: "full", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [1] },
			],
		});

		expect(run.tasks[0]?.status).toBe("pending");
		expect(run.tasks[1]?.status).toBe("pending");

		updateTeamTaskStatus({ cwd, runId: run.runId, taskId: "task_1", status: "running" });
		updateTeamTaskStatus({ cwd, runId: run.runId, taskId: "task_1", status: "done" });

		const loaded = getTeamRun(cwd, run.runId);
		expect(loaded?.tasks.find((task) => task.id === "task_1")?.status).toBe("done");
		expect(loaded?.tasks.find((task) => task.id === "task_2")?.status).toBe("pending");
	});

	it("task tool writes done/error status to team runs when run_id/task_id are provided", async () => {
		const cwd = makeTempDir();
		const runOk = createTeamRun({
			cwd,
			mode: "sequential",
			agents: 1,
			task: "ok task",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});

		const toolOk = createTaskTool(
			cwd,
			async () => ({
				output: "completed",
				sessionId: "session_ok",
			}),
			{},
		);
		await toolOk.execute("call_ok", {
			description: "ok task",
			prompt: "do something",
			profile: "full",
			run_id: runOk.runId,
			task_id: "task_1",
		});
		expect(getTeamRun(cwd, runOk.runId)?.tasks[0]?.status).toBe("done");

		const runErr = createTeamRun({
			cwd,
			mode: "sequential",
			agents: 1,
			task: "failing task",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const toolErr = createTaskTool(cwd, async () => {
			throw new Error("boom");
		});

		await expect(
			toolErr.execute("call_err", {
				description: "failing task",
				prompt: "fail intentionally",
				profile: "full",
				run_id: runErr.runId,
				task_id: "task_1",
			}),
		).rejects.toThrow(/Subagent failed/);
		expect(getTeamRun(cwd, runErr.runId)?.tasks[0]?.status).toBe("error");
	});

	it("forwards model override to runner and supports background custom subagents", async () => {
		const cwd = makeTempDir();
		const observed: Array<{ modelOverride?: string; prompt: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observed.push({ modelOverride: options.modelOverride, prompt: options.prompt });
				return { output: "ok", sessionId: "session_model" };
			},
			{
				resolveCustomSubagent: (name) =>
					name === "bg_reader"
						? {
								name: "bg_reader",
								description: "background reader",
								sourcePath: "fixture",
								profile: "explore",
								instructions: "Background read instructions",
								model: "anthropic/claude-sonnet-4",
								background: true,
							}
						: undefined,
				availableCustomSubagents: ["bg_reader"],
			},
		);

		const started = await tool.execute("call_bg", {
			description: "background job",
			prompt: "scan docs",
			profile: "explore",
			agent: "bg_reader",
		});
		const text = (started.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Started background subagent run");
		expect(started.details?.background).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(observed[0]?.modelOverride).toBe("anthropic/claude-sonnet-4");
		expect(observed[0]?.prompt).toContain("Background read instructions");
		expect(observed[0]?.prompt).toContain("User task:\nscan docs");
	});

	it("maps custom agent names passed via profile into agent resolution", async () => {
		const cwd = makeTempDir();
		const observedPrompts: string[] = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observedPrompts.push(options.prompt);
				return { output: "ok", sessionId: "session_alias" };
			},
			{
				resolveCustomSubagent: (name) =>
					name === "codebase_auditor"
						? {
								name: "codebase_auditor",
								description: "Codebase audit specialist",
								sourcePath: "fixture",
								profile: "explore",
								instructions: "Audit with strict evidence.",
							}
						: undefined,
				availableCustomSubagents: ["codebase_auditor"],
			},
		);

		const result = await tool.execute("call_profile_alias", {
			description: "run audit",
			prompt: "inspect repository",
			profile: "codebase_auditor",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.agent).toBe("codebase_auditor");
		expect(result.details?.profile).toBe("explore");
		expect(observedPrompts[0]).toContain("Audit with strict evidence.");
		expect(observedPrompts[0]).toContain("User task:\ninspect repository");
	});

	it("falls back unknown profile to full without validation failure", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }));

		const result = await tool.execute("call_unknown_profile", {
			description: "unknown profile fallback",
			prompt: "do work",
			profile: "non_existing_profile",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.profile).toBe("full");
	});

	it("uses full-capability tools for meta profile", async () => {
		const cwd = makeTempDir();
		let observedTools: string[] = [];
		const tool = createTaskTool(cwd, async (options) => {
			observedTools = options.tools.slice();
			return { output: "ok" };
		});

		const result = await tool.execute("call_meta_profile", {
			description: "meta profile run",
			prompt: "run with meta profile",
			profile: "meta",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.profile).toBe("meta");
		expect(observedTools).toContain("read");
		expect(observedTools).toContain("bash");
		expect(observedTools).toContain("edit");
		expect(observedTools).toContain("write");
	});

	it("honors maxParallel from orchestration run metadata", async () => {
		const cwd = makeTempDir();

		let active = 0;
		let maxActive = 0;
		const runner = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active -= 1;
			return { output: "ok" };
		};
		const tool = createTaskTool(cwd, runner);

		const runLimited = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			maxParallel: 1,
			task: "limited run",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [] },
			],
		});
		await Promise.all([
			tool.execute("limited_1", {
				description: "limited 1",
				prompt: "a",
				profile: "explore",
				run_id: runLimited.runId,
				task_id: "task_1",
			}),
			tool.execute("limited_2", {
				description: "limited 2",
				prompt: "b",
				profile: "explore",
				run_id: runLimited.runId,
				task_id: "task_2",
			}),
		]);
		expect(maxActive).toBe(1);

		active = 0;
		maxActive = 0;
		const runOpen = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			maxParallel: 2,
			task: "open run",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [] },
			],
		});
		await Promise.all([
			tool.execute("open_1", {
				description: "open 1",
				prompt: "a",
				profile: "explore",
				run_id: runOpen.runId,
				task_id: "task_1",
			}),
			tool.execute("open_2", {
				description: "open 2",
				prompt: "b",
				profile: "explore",
				run_id: runOpen.runId,
				task_id: "task_2",
			}),
		]);
		expect(maxActive).toBe(2);
	});

	it("forces foreground execution for tracked orchestration tasks", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			task: "foreground enforcement",
			assignments: [{ profile: "explore", cwd, dependsOn: [] }],
		});
		const tool = createTaskTool(cwd, async () => ({ output: "foreground output" }));

		const result = await tool.execute("call_fg", {
			description: "tracked task",
			prompt: "run tracked",
			profile: "explore",
			run_id: run.runId,
			task_id: "task_1",
			background: true,
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("foreground output");
		expect(result.details?.background).toBe(false);
	});

	it("runs write-capable tasks in parallel when no lock_key is provided", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;
		const tool = createTaskTool(cwd, async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active -= 1;
			return { output: "ok" };
		});

		await Promise.all([
			tool.execute("call_full_1", {
				description: "full agent one",
				prompt: "analyze",
				profile: "full",
			}),
			tool.execute("call_full_2", {
				description: "full agent two",
				prompt: "analyze",
				profile: "full",
			}),
		]);

		expect(maxActive).toBe(2);
	});

	it("waits for team dependencies before running dependent orchestration task", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			maxParallel: 2,
			task: "dependency wait",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [1] },
			],
		});
		let firstDone = false;
		let secondStartedBeforeFirstDone = false;
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt === "first-task") {
				await new Promise((resolve) => setTimeout(resolve, 45));
				firstDone = true;
				return { output: "first done" };
			}
			if (options.prompt === "second-task") {
				if (!firstDone) secondStartedBeforeFirstDone = true;
				return { output: "second done" };
			}
			return { output: "ok" };
		});

		const secondPromise = tool.execute("call_dep_task_2", {
			description: "second",
			prompt: "second-task",
			profile: "explore",
			run_id: run.runId,
			task_id: "task_2",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		const firstPromise = tool.execute("call_dep_task_1", {
			description: "first",
			prompt: "first-task",
			profile: "explore",
			run_id: run.runId,
			task_id: "task_1",
		});
		await Promise.all([secondPromise, firstPromise]);

		expect(secondStartedBeforeFirstDone).toBe(false);
		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_1")?.status).toBe("done");
		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_2")?.status).toBe("done");
	});

	it("fails dependent orchestration task when dependency failed", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			maxParallel: 2,
			task: "dependency fail",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [1] },
			],
		});
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("first-fail")) {
				throw new Error("boom");
			}
			if (options.prompt === "second-after-fail") {
				return { output: "should not run" };
			}
			return { output: "ok" };
		});

		await expect(
			tool.execute("call_dep_fail_task_1", {
				description: "first fail",
				prompt: "first-fail",
				profile: "explore",
				run_id: run.runId,
				task_id: "task_1",
			}),
		).rejects.toThrow(/Subagent failed/);

		await expect(
			tool.execute("call_dep_fail_task_2", {
				description: "second fail",
				prompt: "second-after-fail",
				profile: "explore",
				run_id: run.runId,
				task_id: "task_2",
			}),
		).rejects.toThrow(/failed dependency|blocked by failed dependency/i);

		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_1")?.status).toBe("error");
		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_2")?.status).toBe("error");
	});

	it("retries root subagent when first pass returns empty output", async () => {
		const cwd = makeTempDir();
		let callCount = 0;
		const progressMessages: string[] = [];
		const tool = createTaskTool(cwd, async () => {
			callCount += 1;
			if (callCount === 1) {
				return {
					output: "",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return {
				output: "Recovered root output.",
				stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
			};
		});

		const result = await tool.execute(
			"call_root_empty_retry",
			{
				description: "root empty retry",
				prompt: "root-task",
				profile: "full",
			},
			undefined,
			(update) => {
				const progress = update.details?.progress as { message?: string } | undefined;
				if (progress?.message) progressMessages.push(progress.message);
			},
		);

		expect(callCount).toBe(2);
		expect((result.content[0] as { type: "text"; text: string }).text).toBe("Recovered root output.");
		expect(progressMessages.some((message) => /empty output/i.test(message) && /retry/i.test(message))).toBe(true);
	});

	it("marks orchestration task cancelled when aborted while waiting for dependencies", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			task: "dependency wait abort",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [1] },
			],
		});
		let runnerCalls = 0;
		const tool = createTaskTool(cwd, async () => {
			runnerCalls += 1;
			return { output: "should-not-run" };
		});
		const controller = new AbortController();
		const execution = tool.execute(
			"call_abort_waiting",
			{
				description: "waiting dependency abort",
				prompt: "wait",
				profile: "explore",
				run_id: run.runId,
				task_id: "task_2",
			},
			controller.signal,
		);
		setTimeout(() => controller.abort(), 30);

		await expect(execution).rejects.toThrow(/Operation aborted/i);
		expect(runnerCalls).toBe(0);
		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_2")?.status).toBe("cancelled");
	});

	it("marks orchestration task cancelled and records aborted cause when aborted during execution", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "sequential",
			agents: 1,
			task: "running abort",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const tool = createTaskTool(cwd, async (options) => {
			return await new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve({ output: "unexpected" }), 1_000);
				options.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("Operation aborted"));
					},
					{ once: true },
				);
			});
		});
		const controller = new AbortController();
		const execution = tool.execute(
			"call_abort_running",
			{
				description: "running abort",
				prompt: "run",
				profile: "full",
				run_id: run.runId,
				task_id: "task_1",
			},
			controller.signal,
		);
		setTimeout(() => controller.abort(), 30);

		await expect(execution).rejects.toMatchObject({
			message: "Operation aborted",
			details: {
				failureCauses: {
					aborted: 1,
				},
			},
		});
		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_1")?.status).toBe("cancelled");
	});

	it("applies root retrospective retry and records failure causes", async () => {
		const cwd = makeTempDir();
		const prompts: string[] = [];
		let callCount = 0;
		const tool = createTaskTool(cwd, async (options) => {
			callCount += 1;
			prompts.push(options.prompt);
			if (callCount === 1) {
				throw new Error("Context window exceeded token limit.");
			}
			return {
				output: "Recovered root output after narrowing scope.",
				stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
			};
		});

		const result = await tool.execute("call_root_retro", {
			description: "root retrospective",
			prompt: "root-retry-task",
			profile: "full",
		});

		expect(callCount).toBe(2);
		expect(prompts[1]).toContain("[RETROSPECTIVE_RETRY]");
		expect(prompts[1]).toContain("cause: token_limit");
		expect(result.details?.retrospectiveAttempts).toBe(1);
		expect(result.details?.retrospectiveRecovered).toBe(1);
		expect(result.details?.failureCauses?.token_limit).toBe(1);
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("### Retrospective");
	});

	it("forwards shared-memory context and applies delegate retrospective retry", async () => {
		const cwd = makeTempDir();
		const calls: Array<{
			prompt: string;
			sharedMemoryContext?: {
				runId?: string;
				taskId?: string;
				delegateId?: string;
			};
		}> = [];
		let delegateAttempt = 0;
		const tool = createTaskTool(cwd, async (options) => {
			calls.push({
				prompt: options.prompt,
				sharedMemoryContext: options.sharedMemoryContext
					? {
							runId: options.sharedMemoryContext.runId,
							taskId: options.sharedMemoryContext.taskId,
							delegateId: options.sharedMemoryContext.delegateId,
						}
					: undefined,
			});
			if (options.prompt.includes("root-memory-task")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="Child logic">delegate-logic-task</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("delegate-logic-task")) {
				delegateAttempt += 1;
				if (delegateAttempt === 1) {
					throw new Error("Invariant violated: logic mismatch.");
				}
				return {
					output: "Delegate recovered with different approach.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_shared_memory_delegate_retro", {
			description: "shared memory + delegate retry",
			prompt: "root-memory-task",
			profile: "full",
			run_id: "run_shared_context",
			task_id: "task_1",
		});

		expect(calls).toHaveLength(3);
		expect(calls[0]?.sharedMemoryContext?.runId).toBe("run_shared_context");
		expect(calls[0]?.sharedMemoryContext?.taskId).toBe("task_1");
		expect(calls[0]?.sharedMemoryContext?.delegateId).toBeUndefined();
		expect(calls[0]?.prompt).toContain("[SHARED_MEMORY]");
		expect(calls[0]?.prompt).toContain("shared_memory_write/shared_memory_read");
		expect(calls[1]?.sharedMemoryContext?.delegateId).toBe("1");
		expect(calls[2]?.sharedMemoryContext?.delegateId).toBe("1");
		expect(calls[2]?.prompt).toContain("[RETROSPECTIVE_RETRY]");
		expect(calls[2]?.prompt).toContain("cause: logic_error");
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
		expect(result.details?.retrospectiveAttempts).toBe(1);
		expect(result.details?.retrospectiveRecovered).toBe(1);
		expect(result.details?.failureCauses?.logic_error).toBe(1);
	});

	it("enables shared-memory context for standalone task mode (without run_id/task_id)", async () => {
		const cwd = makeTempDir();
		const calls: Array<{
			prompt: string;
			sharedMemoryContext?: {
				runId?: string;
				taskId?: string;
				delegateId?: string;
			};
		}> = [];
		const tool = createTaskTool(cwd, async (options) => {
			calls.push({
				prompt: options.prompt,
				sharedMemoryContext: options.sharedMemoryContext
					? {
							runId: options.sharedMemoryContext.runId,
							taskId: options.sharedMemoryContext.taskId,
							delegateId: options.sharedMemoryContext.delegateId,
						}
					: undefined,
			});
			if (options.prompt.includes("root-standalone-memory")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="Child memory">delegate-standalone-memory</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("delegate-standalone-memory")) {
				return {
					output: "Delegate completed with standalone shared memory context.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_shared_memory_standalone", {
			description: "standalone shared memory context",
			prompt: "root-standalone-memory",
			profile: "full",
		});

		expect(calls).toHaveLength(2);
		const rootContext = calls[0]?.sharedMemoryContext;
		expect(rootContext?.runId).toMatch(/^subagent_/);
		expect(rootContext?.taskId).toBe(rootContext?.runId);
		expect(rootContext?.delegateId).toBeUndefined();
		expect(calls[0]?.prompt).toContain("[SHARED_MEMORY]");
		expect(calls[0]?.prompt).toContain(`run_id: ${rootContext?.runId}`);
		expect(calls[1]?.sharedMemoryContext?.runId).toBe(rootContext?.runId);
		expect(calls[1]?.sharedMemoryContext?.taskId).toBe(rootContext?.taskId);
		expect(calls[1]?.sharedMemoryContext?.delegateId).toBe("1");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
	});

	it("fails when root subagent keeps returning empty output", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({
			output: "",
			stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
		}));

		await expect(
			tool.execute("call_root_empty_fail", {
				description: "root empty fail",
				prompt: "root-task",
				profile: "full",
			}),
		).rejects.toThrow(/empty output/i);
	});

	it("marks delegated subtask as failed when delegate output is empty", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis complete.\n<delegate_task profile="explore" description="Child">child-empty</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-empty")) {
				return {
					output: "",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_delegate_empty_fail", {
			description: "delegate empty fail",
			prompt: "root-task",
			profile: "full",
		});

			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("### Delegated Subtasks");
			expect(text).toMatch(/ERROR(?: \[cause=empty_output\])?: delegate 1\/1 failed/);
			expect(result.details?.delegatedTasks).toBe(1);
			expect(result.details?.delegatedSucceeded).toBe(0);
			expect(result.details?.delegatedFailed).toBe(1);
			expect(result.details?.failureCauses?.empty_output).toBe(1);
		});

	it("executes delegated subtasks emitted by subagent output", async () => {
		const cwd = makeTempDir();
		const prompts: string[] = [];
		const tool = createTaskTool(cwd, async (options) => {
			prompts.push(options.prompt);
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis complete.\n<delegate_task profile="explore" description="Patch vuln">apply fix</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("apply fix")) {
				return {
					output: "Fix applied.",
					stats: { toolCallsStarted: 2, toolCallsCompleted: 2, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_delegate", {
			description: "delegate flow",
			prompt: "root-task",
			profile: "full",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain("root-task");
		expect(prompts[1]).toContain("apply fix");
		expect(text).toContain("Root analysis complete.");
		expect(text).toContain("### Delegated Subtasks");
		expect(text).toContain("Fix applied.");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
		expect(result.details?.toolCallsStarted).toBe(3);
		expect(result.details?.toolCallsCompleted).toBe(3);
	});

	it("supports delegated custom agents via delegate_task agent attribute", async () => {
		const cwd = makeTempDir();
		const calls: Array<{ prompt: string; tools: string[]; systemPrompt: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				calls.push({
					prompt: options.prompt,
					tools: [...options.tools],
					systemPrompt: options.systemPrompt,
				});
				if (options.prompt.includes("root-task")) {
					return {
						output:
							'Root analysis complete.\n<delegate_task profile="explore" agent="security_reviewer" description="Security deep dive">scan module</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("User task:\nscan module")) {
					return {
						output: "Security review complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{
				resolveCustomSubagent: (name) =>
					name === "security_reviewer"
						? {
								name: "security_reviewer",
								description: "Security reviewer",
								sourcePath: "fixture",
								profile: "plan",
								systemPrompt: "Custom security auditor system prompt.",
								instructions: "Custom security reviewer instructions.",
								tools: ["read", "bash", "grep"],
								disallowedTools: ["bash"],
							}
						: undefined,
				availableCustomSubagents: ["security_reviewer"],
			},
		);

		const result = await tool.execute("call_delegate_custom_agent", {
			description: "delegate custom agent",
			prompt: "root-task",
			profile: "full",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(calls).toHaveLength(2);
		expect(calls[1]?.systemPrompt).toContain("Custom security auditor system prompt.");
		expect(calls[1]?.tools).toEqual(["read", "grep"]);
		expect(calls[1]?.prompt).toContain("Custom security reviewer instructions.");
		expect(calls[1]?.prompt).toContain("User task:\nscan module");
		expect(text).toContain("security_reviewer/plan");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
	});

	it("emits delegate mini-list progress updates", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis complete.\n<delegate_task profile="explore" description="Patch vuln">child-one</delegate_task>\n<delegate_task profile="plan" description="Audit UX">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-one")) {
				return {
					output: "Child one done.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-two")) {
				return {
					output: "Child two done.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const progressSnapshots: Array<Record<string, unknown>> = [];
		await tool.execute(
			"call_delegate_progress",
			{
				description: "delegate progress",
				prompt: "root-task",
				profile: "full",
			},
			undefined,
			(update) => {
				const progress = update.details?.progress as Record<string, unknown> | undefined;
				if (progress) {
					progressSnapshots.push(progress);
				}
			},
		);

		const hasRunningList = progressSnapshots.some((progress) => {
			const items = progress.delegateItems as Array<{ status?: string }> | undefined;
			return Array.isArray(items) && items.length === 2 && items.some((item) => item.status === "running");
		});
		const hasDoneList = progressSnapshots.some((progress) => {
			const items = progress.delegateItems as Array<{ status?: string }> | undefined;
			return Array.isArray(items) && items.length === 2 && items.every((item) => item.status === "done");
		});

		expect(hasRunningList).toBe(true);
		expect(hasDoneList).toBe(true);
	});

	it("runs independent delegated subtasks in parallel", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-one") || options.prompt.includes("child-two")) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 25));
				active -= 1;
				return {
					output: `${options.prompt} done`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		await tool.execute("call_delegate_parallel", {
			description: "delegate parallel",
			prompt: "root-task",
			profile: "full",
		});

		expect(maxActive).toBe(2);
	});

	it("honors delegate_parallel_hint for intra-task fan-out", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>\n<delegate_task profile="explore" description="C">child-three</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (
				options.prompt.includes("child-one") ||
				options.prompt.includes("child-two") ||
				options.prompt.includes("child-three")
			) {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
				return {
					output: `${options.prompt} done`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		await tool.execute("call_delegate_hint_serial", {
			description: "delegate hint serial",
			prompt: "root-task",
			profile: "full",
			delegate_parallel_hint: 1,
		});
		expect(maxActive).toBe(1);

		active = 0;
		maxActive = 0;
		await tool.execute("call_delegate_hint_parallel", {
			description: "delegate hint parallel",
			prompt: "root-task",
			profile: "full",
			delegate_parallel_hint: 5,
		});
		expect(maxActive).toBe(3);
	});

	it("enforces delegated split when delegate_parallel_hint requires fan-out", async () => {
		const cwd = makeTempDir();
		const rootPrompts: string[] = [];
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
				sawEnforcementPrompt = true;
				return {
					output:
						'Root refined.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("root-task")) {
				rootPrompts.push(options.prompt);
				return {
					output: "Root analysis without delegation.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-one") || options.prompt.includes("child-two")) {
				return {
					output: `${options.prompt} done`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_delegate_enforced", {
			description: "delegate enforced",
			prompt: "root-task",
			profile: "full",
			delegate_parallel_hint: 2,
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(rootPrompts.length).toBe(1);
		expect(sawEnforcementPrompt).toBe(true);
		expect(text).toContain("### Delegated Subtasks");
		expect(result.details?.delegatedTasks).toBe(2);
	});

	it("falls back to single-agent execution when delegation is not beneficial", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
				sawEnforcementPrompt = true;
				return {
					output: "DELEGATION_IMPOSSIBLE: single focused change in one file.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("root-task")) {
				return {
					output: "Root single-agent implementation complete.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_delegate_optional_fallback", {
			description: "delegate optional fallback",
			prompt: "root-task",
			profile: "full",
			delegate_parallel_hint: 5,
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(sawEnforcementPrompt).toBe(true);
		expect(text).toContain("DELEGATION_IMPOSSIBLE");
		expect(result.details?.delegatedTasks ?? 0).toBe(0);
		expect(result.details?.delegatedSucceeded ?? 0).toBe(0);
		expect(result.details?.delegatedFailed ?? 0).toBe(0);
	});

	it("auto-enables delegation pressure for complex orchestrator tasks without explicit hint", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(
			cwd,
				async (options) => {
					if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
						sawEnforcementPrompt = true;
						return {
							output:
								'Root refined.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>',
							stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
						};
					}
					if (options.prompt.includes("Scope:")) {
						return {
							output: "Root analysis without delegation on first pass.",
							stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
						};
					}
				if (options.prompt.includes("child-one") || options.prompt.includes("child-two")) {
					return {
						output: `${options.prompt} done`,
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{
				resolveCustomSubagent: (name) =>
					name === "meta_orchestrator"
						? {
								name: "meta_orchestrator",
								description: "Meta orchestrator",
								sourcePath: "fixture",
								profile: "meta",
								instructions: "Coordinate complex work.",
							}
						: undefined,
				availableCustomSubagents: ["meta_orchestrator"],
			},
		);

			const result = await tool.execute("call_auto_delegate_orchestrator", {
				description:
					"Coordinate a multi-part hardening and refactor plan across auth, sessions, API boundary, and regression coverage.",
				prompt: [
					"Scope:",
					"- review src/auth/token.ts and src/auth/session.ts",
					"- review src/api/middleware/auth.ts and tests/auth/session.spec.ts",
					"- split implementation, verification, and risk report into independent workstreams",
					"- produce rollback notes and integration checklist",
				].join("\n"),
				profile: "meta",
				agent: "meta_orchestrator",
			});
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(sawEnforcementPrompt).toBe(true);
		expect(text).toContain("### Delegated Subtasks");
		expect(result.details?.delegatedTasks).toBe(2);
	});

	it("auto-enables delegation pressure for complex meta profile tasks without explicit hint", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
				sawEnforcementPrompt = true;
				return {
					output:
						'Root refined.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("Scope:")) {
				return {
					output: "Root analysis without delegation on first pass.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-one") || options.prompt.includes("child-two")) {
				return {
					output: `${options.prompt} done`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_auto_delegate_meta_profile", {
			description:
				"Coordinate a multi-part hardening and refactor plan across auth, sessions, API boundary, and regression coverage.",
			prompt: [
				"Scope:",
				"- review src/auth/token.ts and src/auth/session.ts",
				"- review src/api/middleware/auth.ts and tests/auth/session.spec.ts",
				"- split implementation, verification, and risk report into independent workstreams",
				"- produce rollback notes and integration checklist",
			].join("\n"),
			profile: "meta",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(sawEnforcementPrompt).toBe(true);
		expect(text).toContain("### Delegated Subtasks");
		expect(result.details?.delegatedTasks).toBe(2);
	});

	it("keeps single-agent path for simple orchestrator tasks without explicit hint", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(
			cwd,
			async (options) => {
				if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
					sawEnforcementPrompt = true;
				}
				return {
					output: "Single change complete.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			},
			{
				resolveCustomSubagent: (name) =>
					name === "meta_orchestrator"
						? {
								name: "meta_orchestrator",
								description: "Meta orchestrator",
								sourcePath: "fixture",
								profile: "meta",
								instructions: "Coordinate tasks.",
							}
						: undefined,
				availableCustomSubagents: ["meta_orchestrator"],
			},
		);

		const result = await tool.execute("call_auto_delegate_orchestrator_simple", {
			description: "update one README line",
			prompt: "Fix one typo in README.",
			profile: "meta",
			agent: "meta_orchestrator",
		});

		expect(sawEnforcementPrompt).toBe(false);
		expect((result.details?.delegatedTasks ?? 0)).toBe(0);
	});

	it("honors depends_on ordering for delegated subtasks", async () => {
		const cwd = makeTempDir();
		let firstCompleted = false;
		let secondStartedBeforeFirstDone = false;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="First">child-one</delegate_task>\n<delegate_task profile="plan" description="Second" depends_on="1">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-one")) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				firstCompleted = true;
				return {
					output: "child-one done",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-two")) {
				if (!firstCompleted) {
					secondStartedBeforeFirstDone = true;
				}
				return {
					output: "child-two done",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		await tool.execute("call_delegate_depends", {
			description: "delegate depends_on",
			prompt: "root-task",
			profile: "full",
		});

		expect(secondStartedBeforeFirstDone).toBe(false);
	});

	it("executes delegated subtasks emitted with profile=meta", async () => {
		const cwd = makeTempDir();
		let delegateCalls = 0;
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-meta-delegate")) {
				return {
					output: 'Root analysis.\n<delegate_task profile="meta" description="Meta child">meta-child-task</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("meta-child-task")) {
				delegateCalls += 1;
				return {
					output: "Meta delegate complete.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_meta_delegate_profile", {
			description: "meta delegate",
			prompt: "root-meta-delegate",
			profile: "meta",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("### Delegated Subtasks");
		expect(delegateCalls).toBe(1);
		expect(result.details?.profile).toBe("meta");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
	});

	it("rejects write-capable background policy", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }), {
			resolveCustomSubagent: (name) =>
				name === "bg_writer"
					? {
							name: "bg_writer",
							description: "background writer",
							sourcePath: "fixture",
							profile: "full",
							instructions: "Do work",
							background: true,
						}
					: undefined,
		});

		await expect(
			tool.execute("call_bg_policy", {
				description: "policy check",
				prompt: "write files",
				profile: "full",
				agent: "bg_writer",
			}),
		).rejects.toThrow(/Background policy violation/);
	});

	it("rejects write-capable background policy for meta profile", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }));

		await expect(
			tool.execute("call_bg_policy_meta", {
				description: "meta background policy check",
				prompt: "write files",
				profile: "meta",
				background: true,
			}),
		).rejects.toThrow(/Background policy violation/);
	});
});

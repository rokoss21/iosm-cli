import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamRun, getTeamRun, updateTeamTaskStatus } from "../src/core/agent-teams.js";
import { MAX_SUBAGENT_DELEGATE_PARALLEL } from "../src/core/orchestration-limits.js";
import { readSharedMemory } from "../src/core/shared-memory.js";
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

	it("retries queued team task status updates after temporary lock contention", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			task: "lock contention status update",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const runPath = join(cwd, ".iosm", "subagents", "teams", `${run.runId}.json`);
		const release = lockfile.lockSync(runPath, { realpath: false });
		try {
			const immediate = updateTeamTaskStatus({
				cwd,
				runId: run.runId,
				taskId: "task_1",
				status: "running",
			});
			expect(immediate).toBeUndefined();
		} finally {
			release();
		}

		const deadline = Date.now() + 1500;
		while (Date.now() < deadline) {
			const loaded = getTeamRun(cwd, run.runId);
			if (loaded?.tasks.find((task) => task.id === "task_1")?.status === "running") break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(getTeamRun(cwd, run.runId)?.tasks.find((task) => task.id === "task_1")?.status).toBe("running");
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
		const observed: Array<{ modelOverride?: string; profileName?: string; prompt: string; systemPrompt: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observed.push({
					modelOverride: options.modelOverride,
					profileName: options.profileName,
					prompt: options.prompt,
					systemPrompt: options.systemPrompt,
				});
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
		expect(observed[0]?.profileName).toBe("explore");
		expect(observed[0]?.prompt).toContain("scan docs");
		expect(observed[0]?.prompt).toContain("[SHARED_MEMORY]");
		expect(observed[0]?.systemPrompt).toContain("Background read instructions");
	});

	it("maps custom agent names passed via profile into agent resolution", async () => {
		const cwd = makeTempDir();
		const observedCalls: Array<{ prompt: string; systemPrompt: string; profileName?: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observedCalls.push({
					prompt: options.prompt,
					systemPrompt: options.systemPrompt,
					profileName: options.profileName,
				});
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
		expect(observedCalls[0]?.profileName).toBe("explore");
		expect(observedCalls[0]?.prompt).toContain("inspect repository");
		expect(observedCalls[0]?.prompt).toContain("[SHARED_MEMORY]");
		expect(observedCalls[0]?.systemPrompt).toContain("Audit with strict evidence.");
	});

	it("rejects unknown explicit profile values", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }));

		await expect(
			tool.execute("call_unknown_profile", {
				description: "unknown profile fallback",
				prompt: "do work",
				profile: "non_existing_profile",
			}),
		).rejects.toThrow(/Unknown profile/);
	});

	it("accepts task calls without profile and defaults them to full", async () => {
		const cwd = makeTempDir();
		let observedTools: string[] = [];
		const tool = createTaskTool(cwd, async (options) => {
			observedTools = options.tools.slice();
			return { output: "ok" };
		});
		const validate = TypeCompiler.Compile(tool.parameters);

		expect(
			validate.Check({
				description: "missing profile fallback",
				prompt: "do work without explicit profile",
			}),
		).toBe(true);

		const result = await tool.execute("call_missing_profile", {
			description: "missing profile fallback",
			prompt: "do work without explicit profile",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.profile).toBe("full");
		expect(observedTools).toContain("write");
	});

	it("defaults missing profile to the current host profile when provided", async () => {
		const cwd = makeTempDir();
		const observedProfiles: string[] = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observedProfiles.push(options.profileName);
				return { output: "ok" };
			},
			{
				getHostProfileName: () => "meta",
			},
		);

		const result = await tool.execute("call_missing_profile_host_meta", {
			description: "missing profile with host override",
			prompt: "delegate and orchestrate",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toContain("ok");
		expect(result.details?.profile).toBe("meta");
		expect(observedProfiles[0]).toBe("meta");
	});

	it("blocks write-capable subtask profiles from read-only hosts", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(
			cwd,
			async () => ({ output: "ok" }),
			{
				getHostProfileName: () => "plan",
			},
		);

		await expect(
			tool.execute("call_readonly_host_write_profile", {
				description: "attempt write-capable delegate from read-only host",
				prompt: "perform edits",
				profile: "full",
			}),
		).rejects.toThrow(/Host profile "plan" is read-only/);
	});

	it("allows read-only subtask profiles from read-only hosts", async () => {
		const cwd = makeTempDir();
		let observedTools: string[] = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observedTools = options.tools.slice();
				return { output: "ok" };
			},
			{
				getHostProfileName: () => "plan",
			},
		);

		const result = await tool.execute("call_readonly_host_readonly_profile", {
			description: "safe read-only delegate from plan host",
			prompt: "scan auth and rbac",
			profile: "explore",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.profile).toBe("explore");
		expect(observedTools).toContain("read");
		expect(observedTools).not.toContain("write");
	});

	it("accepts task calls with description only and uses it as the prompt", async () => {
		const cwd = makeTempDir();
		let observedPrompt = "";
		const tool = createTaskTool(cwd, async (options) => {
			observedPrompt = options.prompt;
			return { output: "ok" };
		});
		const validate = TypeCompiler.Compile(tool.parameters);

		expect(
			validate.Check({
				description: "Audit authentication and RBAC flows",
				profile: "explore",
			}),
		).toBe(true);

		const result = await tool.execute("call_description_only", {
			description: "Audit authentication and RBAC flows",
			profile: "explore",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.description).toBe("Audit authentication and RBAC flows");
		expect(observedPrompt).toContain("Audit authentication and RBAC flows");
	});

	it("accepts task calls with prompt only and derives a short description", async () => {
		const cwd = makeTempDir();
		let observedPrompt = "";
		const tool = createTaskTool(cwd, async (options) => {
			observedPrompt = options.prompt;
			return { output: "ok" };
		});
		const validate = TypeCompiler.Compile(tool.parameters);
		const prompt = [
			"Perform a security audit of the RMCP codebase.",
			"Focus on auth, RBAC, SQLi, secrets, and multi-tenancy.",
		].join("\n");

		expect(
			validate.Check({
				prompt,
				profile: "explore",
			}),
		).toBe(true);

		const result = await tool.execute("call_prompt_only", {
			prompt,
			profile: "explore",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.description).toBe("Perform a security audit of the RMCP codebase.");
		expect(observedPrompt).toContain(prompt);
	});

	it("accepts legacy task field as an alias for prompt", async () => {
		const cwd = makeTempDir();
		let observedPrompt = "";
		const tool = createTaskTool(cwd, async (options) => {
			observedPrompt = options.prompt;
			return { output: "ok" };
		});
		const validate = TypeCompiler.Compile(tool.parameters);

		expect(
			validate.Check({
				task: "Perform a detailed security audit of authentication flows.",
				profile: "explore",
			}),
		).toBe(true);

		const result = await tool.execute("call_legacy_task_alias", {
			task: "Perform a detailed security audit of authentication flows.",
			profile: "explore",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.description).toBe("Perform a detailed security audit of authentication flows.");
		expect(observedPrompt).toContain("Perform a detailed security audit of authentication flows.");
	});

	it("accepts legacy args field as an alias for prompt", async () => {
		const cwd = makeTempDir();
		let observedPrompt = "";
		const tool = createTaskTool(cwd, async (options) => {
			observedPrompt = options.prompt;
			return { output: "ok" };
		});
		const validate = TypeCompiler.Compile(tool.parameters);

		expect(
			validate.Check({
				args: "Run a full security scan and summarize prioritized vulnerabilities.",
				profile: "explore",
			}),
		).toBe(true);

		const result = await tool.execute("call_legacy_args_alias", {
			args: "Run a full security scan and summarize prioritized vulnerabilities.",
			profile: "explore",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.description).toBe("Run a full security scan and summarize prioritized vulnerabilities.");
		expect(observedPrompt).toContain("Run a full security scan and summarize prioritized vulnerabilities.");
	});

	it("uses custom agent profile when profile is omitted", async () => {
		const cwd = makeTempDir();
		const observed: Array<{ prompt: string; systemPrompt: string; profileName?: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observed.push({
					prompt: options.prompt,
					systemPrompt: options.systemPrompt,
					profileName: options.profileName,
				});
				return { output: "ok" };
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
		const validate = TypeCompiler.Compile(tool.parameters);

		expect(
			validate.Check({
				description: "custom agent without profile",
				prompt: "inspect repository",
				agent: "codebase_auditor",
			}),
		).toBe(true);

		const result = await tool.execute("call_agent_without_profile", {
			description: "custom agent without profile",
			prompt: "inspect repository",
			agent: "codebase_auditor",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.agent).toBe("codebase_auditor");
		expect(result.details?.profile).toBe("explore");
		expect(observed[0]?.profileName).toBe("explore");
		expect(observed[0]?.prompt).toContain("inspect repository");
		expect(observed[0]?.prompt).toContain("[SHARED_MEMORY]");
		expect(observed[0]?.systemPrompt).toContain("Audit with strict evidence.");
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

	it("serializes write-capable profiles when explicit lock_key is provided", async () => {
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
			tool.execute("call_plan_lock_1", {
				description: "full agent one",
				prompt: "analyze",
				profile: "full",
				lock_key: "shared-plan-lock",
			}),
			tool.execute("call_plan_lock_2", {
				description: "full agent two",
				prompt: "analyze",
				profile: "full",
				lock_key: "shared-plan-lock",
			}),
		]);

		expect(maxActive).toBe(1);
	});

	it("uses host profile as fallback when task profile is omitted", async () => {
		const cwd = makeTempDir();
		const seenProfiles: string[] = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				seenProfiles.push(options.profileName ?? "unknown");
				return { output: "ok" };
			},
			{ hostProfileName: "plan" },
		);

		const result = await tool.execute("call_host_profile_fallback", {
			description: "analyze plan-only",
			prompt: "inspect architecture",
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("ok");
		expect(result.details?.profile).toBe("plan");
		expect(seenProfiles[0]).toBe("plan");
	});

	it("rejects write-capable subtasks when host profile is read-only", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }), { hostProfileName: "plan" });

		await expect(
			tool.execute("call_read_only_host_block", {
				description: "attempt write",
				prompt: "apply migration",
				profile: "full",
			}),
		).rejects.toThrow(/Host profile "plan" is read-only/);
	});

	it("does not deadlock when root and delegate share the same lock_key", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-lock-delegate-task")) {
				return {
					output:
						'Root coordination.\n<delegate_task profile="full" lock_key="shared-lock" description="Child lock stream">child-lock-stream</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-lock-stream")) {
				return {
					output: "Child lock stream complete.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const resultPromise = tool.execute("call_reentrant_lock", {
			description: "reentrant lock path",
			prompt: "root-lock-delegate-task",
			profile: "full",
			lock_key: "shared-lock",
		});
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("timed out waiting for delegated lock completion")), 1200);
		});
		const result = await Promise.race([resultPromise, timeoutPromise]);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Child lock stream complete.");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
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

	it("writes orchestrated task summaries into run-scoped shared memory", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			task: "summary snapshot",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output: "Root orchestration summary payload.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_orchestrated_summary", {
			description: "orchestrated summary",
			prompt: "root-task",
			profile: "full",
			run_id: run.runId,
			task_id: "task_1",
		});

		expect(result.details?.sharedMemorySummaryKey).toBe("results/task_1");
		const memory = await readSharedMemory(
			{
				rootCwd: cwd,
				runId: run.runId,
				taskId: "task_1",
			},
			{
				scope: "run",
				key: "results/task_1",
				includeValues: true,
			},
		);
		expect(memory.items).toHaveLength(1);
		expect(memory.items[0]?.value).toContain('"taskId":"task_1"');
		expect(memory.items[0]?.value).toContain('"description":"orchestrated summary"');
	});

	it("auto-publishes coordination plan and delegate findings into shared memory", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			task: "coordination warning",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-one") || options.prompt.includes("child-two")) {
				return {
					output: "child complete",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_coordination_warning", {
			description: "coordination warning",
			prompt: "root-task",
			profile: "full",
			run_id: run.runId,
			task_id: "task_1",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		const findings = await readSharedMemory(
			{
				rootCwd: cwd,
				runId: run.runId,
				taskId: "task_1",
			},
			{
				scope: "run",
				prefix: "findings/task_1/",
				includeValues: true,
			},
		);
		const plan = await readSharedMemory(
			{
				rootCwd: cwd,
				runId: run.runId,
				taskId: "task_1",
			},
			{
				scope: "run",
				key: "plan/task_1",
				includeValues: true,
			},
		);

		expect(text).toContain("### Orchestration Summary");
		expect(text).toContain("shared_memory_delegate_writes_current_task:");
		expect(text).toContain("claims_keys_matched:");
		expect(text).toContain("claims_collisions:");
		expect(text).not.toContain("No shared_memory writes detected from delegates in this task");
		expect(result.details?.coordination?.currentTaskDelegateWrites ?? 0).toBeGreaterThanOrEqual(2);
		expect(findings.items.length).toBeGreaterThanOrEqual(2);
		expect(findings.items.some((item) => item.key === "findings/task_1/1")).toBe(true);
		expect(findings.items.some((item) => item.key === "findings/task_1/2")).toBe(true);
		expect(plan.items).toHaveLength(1);
		expect(plan.items[0]?.value).toContain('"description":"coordination warning"');
	});

	it("publishes claims keys and shared findings snapshot for delegated streams", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			task: "claims snapshot",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-task")) {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="Auth stream">inspect src/auth/service.ts</delegate_task>\n<delegate_task profile="plan" description="UI stream">inspect src/ui/dashboard.tsx</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("inspect src/auth/service.ts")) {
				return {
					output: "Auth findings ready.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("inspect src/ui/dashboard.tsx")) {
				return {
					output: "UI findings ready.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_claims_snapshot", {
			description: "claims snapshot",
			prompt: "root-task",
			profile: "full",
			run_id: run.runId,
			task_id: "task_1",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		const claims = await readSharedMemory(
			{
				rootCwd: cwd,
				runId: run.runId,
				taskId: "task_1",
			},
			{
				scope: "run",
				prefix: "claims/",
				includeValues: false,
			},
		);

		expect(claims.totalMatched).toBeGreaterThanOrEqual(2);
		expect(text).toContain("### Claim Overlap Snapshot");
		expect(text).toContain("collisions:");
		expect(text).toContain("### Shared Findings Snapshot");
		expect(text).toContain("matched_keys:");
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
		const calls: Array<{ prompt: string; tools: string[]; systemPrompt: string; profileName?: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				calls.push({
					prompt: options.prompt,
					tools: [...options.tools],
					systemPrompt: options.systemPrompt,
					profileName: options.profileName,
				});
				if (options.prompt.includes("root-task")) {
					return {
						output:
							'Root analysis complete.\n<delegate_task profile="explore" agent="security_reviewer" description="Security deep dive">scan module</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("scan module")) {
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
		expect(calls[1]?.profileName).toBe("plan");
		expect(calls[1]?.systemPrompt).toContain("Custom security auditor system prompt.");
		expect(calls[1]?.systemPrompt).toContain("Custom security reviewer instructions.");
		expect(calls[1]?.tools).toEqual(["read", "grep"]);
		expect(calls[1]?.prompt).toContain("scan module");
		expect(calls[1]?.prompt).toContain("[SHARED_MEMORY]");
		expect(text).toContain("security_reviewer/plan");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
	});

	it("supports delegated custom agents referenced via profile alias", async () => {
		const cwd = makeTempDir();
		const calls: Array<{ prompt: string; profileName?: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				calls.push({ prompt: options.prompt, profileName: options.profileName });
				if (options.prompt.includes("root-task")) {
					return {
						output:
							'Root analysis complete.\n<delegate_task profile="security_reviewer" description="Security deep dive">scan module</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("scan module")) {
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
								instructions: "Security-focused reviewer.",
							}
						: undefined,
				availableCustomSubagents: ["security_reviewer"],
			},
		);

		const result = await tool.execute("call_delegate_custom_agent_profile_alias", {
			description: "delegate custom agent via profile alias",
			prompt: "root-task",
			profile: "full",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(calls).toHaveLength(2);
		expect(calls[1]?.profileName).toBe("plan");
		expect(text).toContain("security_reviewer/plan");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
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

	it("auto-synthesizes strict meta delegates when non-trivial work omits delegate blocks", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;
		let synthesizedDelegatesObserved = 0;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("Workstream ")) {
				synthesizedDelegatesObserved += 1;
				return {
					output: `${options.prompt.split("\n")[0]} complete.`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
				sawEnforcementPrompt = true;
				return {
					output: "Still monolithic output without nested delegation.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("root-task")) {
				return {
					output: "Root analysis without delegation.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_delegate_strict_meta_violation", {
			description:
				"Coordinate security hardening, auth validation, and regression verification across independent workstreams.",
			prompt: "root-task",
			profile: "meta",
			delegate_parallel_hint: 3,
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(sawEnforcementPrompt).toBe(true);
		expect(synthesizedDelegatesObserved).toBeGreaterThanOrEqual(3);
		expect(text).toContain("### Delegated Subtasks");
		expect(result.details?.delegatedTasks ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("auto-fans out specialist full-profile tasks under meta host when delegates are missing", async () => {
		const cwd = makeTempDir();
		let synthesizedDelegatesObserved = 0;
		const tool = createTaskTool(
			cwd,
			async (options) => {
				if (options.prompt.includes("Workstream ")) {
					synthesizedDelegatesObserved += 1;
					return {
						output: "Delegated specialist stream complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
					return {
						output: "Monolithic specialist output without delegate tags.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("Codebase architecture audit")) {
					return {
						output: "Architecture findings generated in one pass.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{ hostProfileName: "meta" },
		);

		const result = await tool.execute("call_meta_host_full_specialist", {
			description: "Codebase architecture audit",
			prompt: "Codebase architecture audit",
			profile: "full",
			delegate_parallel_hint: 3,
		});

		expect(synthesizedDelegatesObserved).toBeGreaterThanOrEqual(3);
		expect(result.details?.delegatedTasks ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("shards synthesized write lock keys to preserve delegate parallelism", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;
		const tool = createTaskTool(
			cwd,
			async (options) => {
				if (options.prompt.includes("Workstream ")) {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 20));
					active -= 1;
					return {
						output: "Delegated stream complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
					return {
						output: "Monolithic follow-up output without explicit delegate tags.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("root-task")) {
					return {
						output: "Root monolithic output.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{ hostProfileName: "meta" },
		);

		const result = await tool.execute("call_synth_lock_sharding", {
			description:
				"Fix security issues across these streams:\n- auth stream src/auth/service.ts\n- ui stream src/ui/dashboard.tsx\n- data stream src/storage/database.ts",
			prompt: "root-task",
			profile: "full",
			delegate_parallel_hint: 4,
		});

		expect(result.details?.delegatedTasks ?? 0).toBeGreaterThanOrEqual(3);
		expect(maxActive).toBeGreaterThan(1);
	});

	it("enforces delegate fan-out for orchestrated run contexts when hint >= 2", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			maxParallel: 1,
			task: "orchestrated fanout",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		let synthesizedDelegatesObserved = 0;
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("Workstream ")) {
				synthesizedDelegatesObserved += 1;
				return {
					output: "Delegated stream complete.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
				return {
					output: "Still monolithic output.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("root-orchestrated-task")) {
				return {
					output: "Root monolithic output.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_orchestrated_fanout", {
			description: "Orchestrated security audit stream",
			prompt: "root-orchestrated-task",
			profile: "full",
			delegate_parallel_hint: 3,
			run_id: run.runId,
			task_id: "task_1",
		});

		expect(synthesizedDelegatesObserved).toBeGreaterThanOrEqual(2);
		expect(result.details?.delegatedTasks ?? 0).toBeGreaterThanOrEqual(2);
	});

	it("supports delegated fan-out up to the 10-child ceiling", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;
		const delegateBodies = Array.from(
			{ length: MAX_SUBAGENT_DELEGATE_PARALLEL },
			(_value, index) =>
				`<delegate_task profile="explore" description="child-${index + 1}">child-${index + 1}</delegate_task>`,
		).join("\n");

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-fanout")) {
				return {
					output: `Root analysis.\n${delegateBodies}`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.startsWith("child-")) {
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

		await tool.execute("call_delegate_10way", {
			description: "delegate 10-way",
			prompt: "root-fanout",
			profile: "full",
			delegate_parallel_hint: MAX_SUBAGENT_DELEGATE_PARALLEL,
		});

		expect(maxActive).toBe(MAX_SUBAGENT_DELEGATE_PARALLEL);
	});

	it("auto-enables delegation pressure for complex orchestrator tasks without explicit hint", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;
		const rootCalls: Array<{ profileName?: string; systemPrompt: string; prompt: string }> = [];

		const tool = createTaskTool(
			cwd,
				async (options) => {
					rootCalls.push({
						profileName: options.profileName,
						systemPrompt: options.systemPrompt,
						prompt: options.prompt,
					});
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
		expect(rootCalls[0]?.profileName).toBe("meta");
		expect(rootCalls[0]?.systemPrompt).toContain("Coordinate complex work.");
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

	it("applies delegation pressure for short action-oriented meta prompts", async () => {
		const cwd = makeTempDir();
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
				sawEnforcementPrompt = true;
				return {
					output:
						'Root refined.\n<delegate_task profile="explore" description="Auth checks">child-auth</delegate_task>\n<delegate_task profile="plan" description="RBAC checks">child-rbac</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("audit auth and rbac")) {
				return {
					output: "Root analysis without delegation on first pass.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("child-auth") || options.prompt.includes("child-rbac")) {
				return {
					output: `${options.prompt} done`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_short_action_meta_prompt", {
			description: "audit auth and rbac",
			prompt: "audit auth and rbac",
			profile: "meta",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;

		expect(sawEnforcementPrompt).toBe(true);
		expect(text).toContain("### Delegated Subtasks");
		expect(result.details?.delegatedTasks).toBe(2);
	});

	it("uses dynamic host profile getter for meta delegation pressure after runtime profile switch", async () => {
		const cwd = makeTempDir();
		let hostProfile = "full";
		let sawEnforcementPrompt = false;

		const tool = createTaskTool(
			cwd,
			async (options) => {
				if (options.prompt.includes("DELEGATION_ENFORCEMENT")) {
					sawEnforcementPrompt = true;
					return {
						output: 'Root refined.\n<delegate_task profile="explore" description="Child audit">child-task</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("Scope:")) {
					return {
						output: "Root analysis without delegation on first pass.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("child-task")) {
					return {
						output: "Child audit complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{
				getHostProfileName: () => hostProfile,
			},
		);

		const prompt = [
			"Scope:",
			"- review auth module",
			"- review gateway middleware",
			"- produce remediation plan",
		].join("\n");

		const fullResult = await tool.execute("call_dynamic_host_profile_full", {
			description: "runtime host profile check",
			prompt,
			profile: "full",
		});
		expect(sawEnforcementPrompt).toBe(false);
		expect(fullResult.details?.delegatedTasks ?? 0).toBe(0);

		hostProfile = "meta";
		sawEnforcementPrompt = false;
		const metaResult = await tool.execute("call_dynamic_host_profile_meta", {
			description: "runtime host profile check",
			prompt,
			profile: "full",
		});
		const metaText = (metaResult.content[0] as { type: "text"; text: string }).text;
		expect(sawEnforcementPrompt).toBe(true);
		expect(metaText).toContain("### Delegated Subtasks");
		expect(metaResult.details?.delegatedTasks).toBe(1);
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

	it("executes nested delegated subtasks for meta-hosted tasks", async () => {
		const cwd = makeTempDir();
		const calls: string[] = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				calls.push(options.prompt);
				if (options.prompt.includes("root-nested-task")) {
					return {
						output:
							'Root analysis.\n<delegate_task profile="full" description="Implementation stream">child-implementation-task</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("child-implementation-task")) {
					return {
						output:
							'Child implementation planning.\n<delegate_task profile="explore" description="Inspect retry points">nested-explore-task</delegate_task>\n<delegate_task profile="plan" description="Design backoff metrics">nested-plan-task</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-explore-task")) {
					return {
						output: "Nested explore complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-plan-task")) {
					return {
						output: "Nested plan complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{
				hostProfileName: "meta",
			},
		);

		const result = await tool.execute("call_nested_meta_host", {
			description: "nested meta host",
			prompt: "root-nested-task",
			profile: "meta",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("##### Nested Delegated Subtasks");
		expect(text).toContain("Nested explore complete.");
		expect(text).toContain("Nested plan complete.");
		expect(result.details?.delegatedTasks).toBe(3);
		expect(calls.some((prompt) => prompt.includes("nested-explore-task"))).toBe(true);
		expect(calls.some((prompt) => prompt.includes("nested-plan-task"))).toBe(true);
	});

	it("enforces nested delegation split for complex delegated children in meta-hosted tasks", async () => {
		const cwd = makeTempDir();
		let childSawEnforcementPrompt = false;
		const tool = createTaskTool(
			cwd,
			async (options) => {
				if (options.prompt.includes("root-complex-meta-host-task")) {
					return {
						output:
							[
								"Root analysis.",
								'<delegate_task profile="explore" description="Broad child audit">',
								"Perform a broad security audit of the application authentication layer.",
								"Focus on:",
								"1. auth.py token and API key flows.",
								"2. rbac.py permission boundaries.",
								"3. middleware integration and route coverage.",
								"4. split findings by subsystem and verification path.",
								"</delegate_task>",
							].join("\n"),
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (
					options.prompt.includes("DELEGATION_ENFORCEMENT") &&
					options.prompt.includes("Perform a broad security audit of the application authentication layer.")
				) {
					childSawEnforcementPrompt = true;
					return {
						output:
							'Child refined.\n<delegate_task profile="explore" description="Inspect auth">nested-auth-task</delegate_task>\n<delegate_task profile="plan" description="Model risks">nested-risk-task</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("Perform a broad security audit of the application authentication layer.")) {
					return {
						output: "Child broad audit without nested delegation.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-auth-task")) {
					return {
						output: "Nested auth inspection complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-risk-task")) {
					return {
						output: "Nested risk modeling complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{
				hostProfileName: "meta",
			},
		);

		const result = await tool.execute("call_nested_delegate_enforced", {
			description: "nested delegate enforced",
			prompt: "root-complex-meta-host-task",
			profile: "meta",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(childSawEnforcementPrompt).toBe(true);
		expect(text).toContain("##### Nested Delegated Subtasks");
		expect(text).toContain("Nested auth inspection complete.");
		expect(text).toContain("Nested risk modeling complete.");
		expect(result.details?.delegatedTasks).toBe(3);
	});

	it("runs nested delegated subtasks in parallel and honors nested depends_on", async () => {
		const cwd = makeTempDir();
		let nestedFirstCompleted = false;
		let nestedSecondStartedBeforeFirstDone = false;
		let nestedThirdStartedBeforeSecondDone = false;
		let nestedSecondCompleted = false;
		const tool = createTaskTool(
			cwd,
			async (options) => {
				if (options.prompt.includes("root-nested-depends-task")) {
					return {
						output:
							'Root analysis.\n<delegate_task profile="full" description="Implementation stream">child-implementation-task</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("child-implementation-task")) {
					return {
						output:
							'Child implementation planning.\n<delegate_task profile="explore" description="First">nested-first-task</delegate_task>\n<delegate_task profile="plan" description="Second">nested-second-task</delegate_task>\n<delegate_task profile="explore" description="Third" depends_on="2">nested-third-task</delegate_task>',
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-first-task")) {
					await new Promise((resolve) => setTimeout(resolve, 30));
					nestedFirstCompleted = true;
					return {
						output: "Nested first complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-second-task")) {
					if (!nestedFirstCompleted) nestedSecondStartedBeforeFirstDone = true;
					await new Promise((resolve) => setTimeout(resolve, 40));
					nestedSecondCompleted = true;
					return {
						output: "Nested second complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				if (options.prompt.includes("nested-third-task")) {
					if (!nestedSecondCompleted) nestedThirdStartedBeforeSecondDone = true;
					return {
						output: "Nested third complete.",
						stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
					};
				}
				return { output: "unexpected" };
			},
			{
				hostProfileName: "meta",
			},
		);

		const result = await tool.execute("call_nested_delegate_depends_parallel", {
			description: "nested delegate depends/parallel",
			prompt: "root-nested-depends-task",
			profile: "meta",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Nested first complete.");
		expect(text).toContain("Nested second complete.");
		expect(text).toContain("Nested third complete.");
		expect(nestedSecondStartedBeforeFirstDone).toBe(true);
		expect(nestedThirdStartedBeforeSecondDone).toBe(false);
		expect(result.details?.delegatedTasks).toBe(4);
		expect(result.details?.delegatedSucceeded).toBe(4);
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

	it("rejects write-capable background policy for iosm profile", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }));

		await expect(
			tool.execute("call_bg_policy_iosm", {
				description: "iosm background policy check",
				prompt: "write files",
				profile: "iosm",
				background: true,
			}),
		).rejects.toThrow(/Background policy violation/);
	});

	it("allows background mode for plan profile (read-only toolset)", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }));

		const result = await tool.execute("call_bg_policy_plan", {
			description: "plan background policy check",
			prompt: "analyze repository",
			profile: "plan",
			background: true,
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Started background subagent run");
		expect(result.details?.background).toBe(true);
	});

	it("allows background mode for iosm_analyst profile (read-only toolset)", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }));

		const result = await tool.execute("call_bg_policy_iosm_analyst", {
			description: "iosm_analyst background policy check",
			prompt: "analyze metrics",
			profile: "iosm_analyst",
			background: true,
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Started background subagent run");
		expect(result.details?.background).toBe(true);
	});

	it("parses delegate_task attributes with single quotes and mixed-case profile", async () => {
		const cwd = makeTempDir();
		let delegateCalls = 0;
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt.includes("root-single-quote-delegate")) {
				return {
					output:
						"Root analysis.\n<delegate_task profile='Explore' description='Single quoted delegate'>quoted-child-task</delegate_task>",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt.includes("quoted-child-task")) {
				delegateCalls += 1;
				return {
					output: "Quoted delegate complete.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_single_quote_delegate_profile", {
			description: "single quote delegate",
			prompt: "root-single-quote-delegate",
			profile: "full",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("### Delegated Subtasks");
		expect(delegateCalls).toBe(1);
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
	});
});

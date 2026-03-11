import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomSubagents, resolveCustomSubagentReference } from "../src/core/subagents.js";

function writeAgentFile(pathValue: string, content: string): void {
	mkdirSync(dirname(pathValue), { recursive: true });
	writeFileSync(pathValue, content, "utf8");
}

describe("loadCustomSubagents", () => {
	const tempDirs: string[] = [];

	const makeTempDir = (): string => {
		const dir = join(tmpdir(), `iosm-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0, tempDirs.length)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers project agents over global and reports override visibility", () => {
		const root = makeTempDir();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent-home");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const globalPath = join(agentDir, "agents", "reviewer.md");
		const projectPath = join(cwd, ".iosm", "agents", "reviewer.md");

		writeAgentFile(
			globalPath,
			[
				"---",
				'name: "reviewer"',
				'description: "Global reviewer"',
				"---",
				"",
				"Review code globally.",
				"",
			].join("\n"),
		);
		writeAgentFile(
			projectPath,
			[
				"---",
				'name: "reviewer"',
				'description: "Project reviewer"',
				"---",
				"",
				"Review code in this repository.",
				"",
			].join("\n"),
		);

		const loaded = loadCustomSubagents({ cwd, agentDir });
		const effective = loaded.agents.find((agent) => agent.name === "reviewer");
		const globalEntry = loaded.allAgents.find((agent) => agent.sourcePath === globalPath);
		const projectEntry = loaded.allAgents.find((agent) => agent.sourcePath === projectPath);

		expect(effective?.sourcePath).toBe(projectPath);
		expect(effective?.sourceScope).toBe("project");
		expect(projectEntry?.effective).toBe(true);
		expect(globalEntry?.effective).toBe(false);
		expect(globalEntry?.overriddenByPath).toBe(projectPath);
		expect(
			loaded.overrides.some(
				(override) =>
					override.name === "reviewer" &&
					override.winnerPath === projectPath &&
					override.overriddenPath === globalPath,
			),
		).toBe(true);
	});

	it("loads built-in system agents when no files are present", () => {
		const root = makeTempDir();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent-home");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const loaded = loadCustomSubagents({ cwd, agentDir });
		const names = new Set(loaded.agents.map((agent) => agent.name));

		expect(names.has("codebase_auditor")).toBe(true);
		expect(names.has("system_error_analyst")).toBe(true);
		expect(names.has("iosm_change_executor")).toBe(true);
		expect(names.has("iosm_postchange_verifier")).toBe(true);
		expect(names.has("qa_test_engineer")).toBe(true);
		expect(names.has("test_failure_triager")).toBe(true);
		expect(names.has("meta_orchestrator")).toBe(true);
		expect(loaded.agents.find((agent) => agent.name === "meta_orchestrator")?.profile).toBe("meta");
		expect(loaded.agents.find((agent) => agent.name === "meta_orchestrator")?.instructions).toContain(
			"Recon is only preparation; once you can name the workstreams, stop exploring and delegate.",
		);
	});

	it("allows project agents to override built-in system agents by name", () => {
		const root = makeTempDir();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent-home");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const projectPath = join(cwd, ".iosm", "agents", "codebase_auditor.md");
		writeAgentFile(
			projectPath,
			[
				"---",
				'name: "codebase_auditor"',
				'description: "Project-specific override"',
				"profile: explore",
				"---",
				"",
				"Custom project audit instructions.",
				"",
			].join("\n"),
		);

		const loaded = loadCustomSubagents({ cwd, agentDir });
		const effective = loaded.agents.find((agent) => agent.name === "codebase_auditor");

		expect(effective?.sourceScope).toBe("project");
		expect(effective?.sourcePath).toBe(projectPath);
	});

	it("emits diagnostics for duplicate names within the same scope", () => {
		const root = makeTempDir();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent-home");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const first = join(cwd, ".iosm", "agents", "a", "dup.md");
		const second = join(cwd, ".iosm", "agents", "b", "dup.md");

		writeAgentFile(
			first,
			[
				"---",
				'name: "dup_agent"',
				'description: "first duplicate"',
				"---",
				"",
				"First instructions.",
				"",
			].join("\n"),
		);
		writeAgentFile(
			second,
			[
				"---",
				'name: "dup_agent"',
				'description: "second duplicate"',
				"---",
				"",
				"Second instructions.",
				"",
			].join("\n"),
		);

		const loaded = loadCustomSubagents({ cwd, agentDir });
		const dupAgents = loaded.allAgents.filter((agent) => agent.name === "dup_agent");
		const active = dupAgents.filter((agent) => agent.effective);

		expect(dupAgents.length).toBe(2);
		expect(active.length).toBe(1);
		expect(loaded.diagnostics.some((item) => item.message.includes('Duplicate agent "dup_agent"'))).toBe(true);
	});

	it("resolves custom subagent references with .md names and .iosm/agents paths", () => {
		const root = makeTempDir();
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent-home");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		writeAgentFile(
			join(cwd, ".iosm", "agents", "ux_specialist.md"),
			[
				"---",
				'name: "ux_specialist"',
				'description: "UX specialist"',
				"profile: explore",
				"---",
				"",
				"Review UX and accessibility.",
				"",
			].join("\n"),
		);

		const loaded = loadCustomSubagents({ cwd, agentDir });
		expect(resolveCustomSubagentReference("ux_specialist", loaded.agents)).toBe("ux_specialist");
		expect(resolveCustomSubagentReference("ux_specialist.md", loaded.agents)).toBe("ux_specialist");
		expect(resolveCustomSubagentReference(".iosm/agents/ux_specialist.md", loaded.agents)).toBe(
			"ux_specialist",
		);
		expect(resolveCustomSubagentReference("@.iosm/agents/ux_specialist.md", loaded.agents)).toBe(
			"ux_specialist",
		);
	});
});

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluatePermissionWithPolicy, PolicyEngineV2 } from "../src/core/policy/index.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ToolPermissionRequest } from "../src/core/tools/permissions.js";

function createPolicyFixture() {
	const root = mkdtempSync(join(tmpdir(), "iosm-policy-test-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".iosm"), { recursive: true });
	return { root, cwd, agentDir };
}

describe("PolicyEngineV2", () => {
	it("resolves precedence admin > user > workspace > default", () => {
		const fixture = createPolicyFixture();
		const settings = SettingsManager.inMemory();
		const adminPath = join(fixture.root, "admin-policy.toml");

		writeFileSync(
			adminPath,
			`version = 2
[[rules]]
id = "admin-deny-bash"
effect = "deny"
tools = ["bash"]
priority = 100
`,
			"utf8",
		);
		writeFileSync(
			join(fixture.agentDir, "policy.toml"),
			`version = 2
[[rules]]
id = "user-allow-bash"
effect = "allow"
tools = ["bash"]
priority = 100
`,
			"utf8",
		);
		writeFileSync(
			join(fixture.cwd, ".iosm", "policy.toml"),
			`version = 2
[[rules]]
id = "workspace-allow-bash"
effect = "allow"
tools = ["bash"]
priority = 100
`,
			"utf8",
		);

		const engine = new PolicyEngineV2({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: settings,
			adminPolicyPath: adminPath,
		});
		const request: ToolPermissionRequest = {
			toolName: "bash",
			cwd: fixture.cwd,
			input: { command: "echo hi" },
			summary: "echo hi",
			toolSource: "builtin",
		};
		const decision = engine.evaluate(request);
		expect(decision.effect).toBe("deny");
		expect(decision.rule?.id).toBe("admin-deny-bash");
	});

	it("compiles legacy permission allow/deny from settings", () => {
		const fixture = createPolicyFixture();
		const settings = SettingsManager.inMemory({
			permissionAllow: ["edit:README.md"],
			permissionDeny: ["bash:rm -rf"],
		});
		const engine = new PolicyEngineV2({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: settings,
		});
		const allow = engine.evaluate({
			toolName: "edit",
			cwd: fixture.cwd,
			input: {},
			summary: "Update README.md with docs",
			toolSource: "builtin",
		});
		expect(allow.effect).toBe("allow");
		const deny = engine.evaluate({
			toolName: "bash",
			cwd: fixture.cwd,
			input: {},
			summary: "rm -rf /tmp/nope",
			toolSource: "builtin",
		});
		expect(deny.effect).toBe("deny");
	});

	it("requires explicit trusted mcp allow rule for auto-bypass", () => {
		const fixture = createPolicyFixture();
		const settings = SettingsManager.inMemory();
		writeFileSync(
			join(fixture.agentDir, "policy.toml"),
			`version = 2
[[rules]]
id = "mcp-explicit-allow"
effect = "allow"
tools = ["search"]
tool_source = ["mcp"]
mcp_name = ["docs"]
priority = 100
`,
			"utf8",
		);

		const engine = new PolicyEngineV2({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: settings,
		});

		const request: ToolPermissionRequest = {
			toolName: "search",
			cwd: fixture.cwd,
			input: { query: "policy" },
			summary: "MCP docs/search query=policy",
			toolSource: "mcp",
			mcpServerName: "docs",
			mcpToolName: "search",
			mcpServerTrusted: true,
		};

		const trusted = evaluatePermissionWithPolicy(engine, request, {
			runtimeMode: "rpc",
			permissionMode: "ask",
		});
		expect(trusted.outcome).toBe("allow");

		const untrusted = evaluatePermissionWithPolicy(
			engine,
			{
				...request,
				mcpServerTrusted: false,
			},
			{
				runtimeMode: "rpc",
				permissionMode: "yolo",
			},
		);
		expect(untrusted.outcome).toBe("ask");
	});

	it("enforces mcp approval modes prompt/approve", () => {
		const fixture = createPolicyFixture();
		const settings = SettingsManager.inMemory();
		const engine = new PolicyEngineV2({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: settings,
		});

		const baseRequest: ToolPermissionRequest = {
			toolName: "search",
			cwd: fixture.cwd,
			input: { query: "policy" },
			summary: "MCP docs/search query=policy",
			toolSource: "mcp",
			mcpServerName: "docs",
			mcpToolName: "search",
			mcpServerTrusted: true,
		};

		const promptMode = evaluatePermissionWithPolicy(
			engine,
			{
				...baseRequest,
				mcpApprovalMode: "prompt",
			},
			{
				runtimeMode: "rpc",
				permissionMode: "yolo",
			},
		);
		expect(promptMode.outcome).toBe("ask");

		const approveModeTrusted = evaluatePermissionWithPolicy(
			engine,
			{
				...baseRequest,
				mcpApprovalMode: "approve",
			},
			{
				runtimeMode: "rpc",
				permissionMode: "ask",
			},
		);
		expect(approveModeTrusted.outcome).toBe("allow");

		const approveModeUntrusted = evaluatePermissionWithPolicy(
			engine,
			{
				...baseRequest,
				mcpApprovalMode: "approve",
				mcpServerTrusted: false,
			},
			{
				runtimeMode: "rpc",
				permissionMode: "ask",
			},
		);
		expect(approveModeUntrusted.outcome).toBe("ask");
	});
});

import { describe, expect, it } from "vitest";
import { parseMcpAddCommand, parseMcpTargetCommand } from "../src/core/mcp/cli.js";

describe("mcp cli parser", () => {
	it("parses stdio add command with repeated args", () => {
		const parsed = parseMcpAddCommand([
			"filesystem",
			"--scope",
			"project",
			"--transport",
			"stdio",
			"--command",
			"npx",
			"--arg",
			"-y",
			"--arg",
			"@modelcontextprotocol/server-filesystem",
			"--arg",
			".",
			"--disable",
			"--tool-approval",
			"read=prompt",
		]);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.name).toBe("filesystem");
		expect(parsed.value.scope).toBe("project");
		expect(parsed.value.config.transport).toBe("stdio");
		expect(parsed.value.config.command).toBe("npx");
		expect(parsed.value.config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "."]);
		expect(parsed.value.config.enabled).toBe(false);
		expect(parsed.value.config.tools).toEqual({
			read: { approvalMode: "prompt" },
		});
	});

	it("parses http add command with headers and env", () => {
		const parsed = parseMcpAddCommand([
			"github",
			"--scope",
			"user",
			"--transport",
			"http",
			"--url",
			"https://mcp.example.com",
			"--header",
			"Authorization=Bearer ${TOKEN}",
			"--env",
			"DEBUG=1",
		]);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.scope).toBe("user");
		expect(parsed.value.config.transport).toBe("http");
		expect(parsed.value.config.url).toBe("https://mcp.example.com");
		expect(parsed.value.config.headers).toEqual({ Authorization: "Bearer ${TOKEN}" });
		expect(parsed.value.config.env).toEqual({ DEBUG: "1" });
	});

	it("parses target commands with scope", () => {
		const parsed = parseMcpTargetCommand(["filesystem", "--scope", "project"]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual({ name: "filesystem", scope: "project" });
	});

	it("rejects invalid server names", () => {
		const parsed = parseMcpAddCommand(["invalid name", "--command", "echo"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok || "help" in parsed) return;
		expect(parsed.error).toContain("Invalid server name");
	});

	it("rejects invalid --tool-approval mode", () => {
		const parsed = parseMcpAddCommand([
			"filesystem",
			"--transport",
			"stdio",
			"--command",
			"npx",
			"--tool-approval",
			"read=always",
		]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok || "help" in parsed) return;
		expect(parsed.error).toContain("Invalid --tool-approval mode");
	});

	it("parses multiple --tool-approval flags", () => {
		const parsed = parseMcpAddCommand([
			"github",
			"--transport",
			"http",
			"--url",
			"https://mcp.example.com",
			"--tool-approval",
			"search=prompt",
			"--tool-approval",
			"get_file=approve",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.config.tools).toEqual({
			search: { approvalMode: "prompt" },
			get_file: { approvalMode: "approve" },
		});
	});
});

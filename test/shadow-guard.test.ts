import { describe, expect, it, vi } from "vitest";
import { ShadowGuard } from "../src/core/shadow-guard.js";

describe("shadow guard", () => {
	it("enables strict read-only mode and restores tools on disable", () => {
		let activeTools = ["read", "bash", "edit", "write", "task"];
		const setActiveTools = vi.fn((next: string[]) => {
			activeTools = [...next];
		});

		const guard = new ShadowGuard({
			getActiveTools: () => [...activeTools],
			getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write", "task"],
			setActiveTools,
		});

		guard.enable();
		expect(setActiveTools).toHaveBeenCalled();
		expect(activeTools).toEqual(["read", "grep", "find", "ls"]);
		expect(guard.shouldDenyTool("edit")).toBe(true);
		expect(guard.shouldDenyTool("read")).toBe(false);

		guard.disable();
		expect(activeTools).toEqual(["read", "bash", "edit", "write", "task"]);
		expect(guard.isEnabled()).toBe(false);
	});

	it("tracks restore tools while shadow mode remains enabled", () => {
		let activeTools = ["read", "bash"];
		const guard = new ShadowGuard({
			getActiveTools: () => [...activeTools],
			getAllTools: () => ["read", "grep", "bash", "edit", "write", "task"],
			setActiveTools: (next) => {
				activeTools = [...next];
			},
		});

		guard.enable();
		guard.setRestoreToolNames(["read", "task", "todo_read"]);
		guard.disable();
		expect(activeTools).toEqual(["read", "task", "todo_read"]);
	});

	it("treats fs_ops as mutating when shadow mode is enabled", () => {
		let activeTools = ["read", "fs_ops", "bash"];
		const guard = new ShadowGuard({
			getActiveTools: () => [...activeTools],
			getAllTools: () => ["read", "fetch", "git_read", "fs_ops", "bash", "edit", "write", "task"],
			setActiveTools: (next) => {
				activeTools = [...next];
			},
		});

		guard.enable();
		expect(guard.shouldDenyTool("fs_ops")).toBe(true);
		expect(activeTools).toContain("fetch");
		expect(activeTools).toContain("git_read");
		expect(activeTools).not.toContain("fs_ops");
	});
});

import { describe, expect, it, vi } from "vitest";
import { createApplyPatchTool } from "../src/core/tools/apply-patch.js";

const VALID_PATCH = `*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
`;

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.join("\n");
}

describe("apply_patch tool", () => {
	it("validates grammar and forwards patch to operations adapter", async () => {
		const applyPatch = vi.fn(async () => ({
			stdout: "patched",
			stderr: "",
			exitCode: 0,
		}));
		const tool = createApplyPatchTool(process.cwd(), {
			operations: { applyPatch },
		});

		const result = await tool.execute("apply-patch-1", { patch: VALID_PATCH });

		expect(applyPatch).toHaveBeenCalledWith(process.cwd(), VALID_PATCH);
		expect(getText(result)).toContain("patched");
		expect(result.details?.exitCode).toBe(0);
	});

	it("rejects invalid apply_patch grammar", async () => {
		const tool = createApplyPatchTool(process.cwd(), {
			operations: {
				applyPatch: vi.fn(),
			},
		});

		await expect(
			tool.execute("apply-patch-2", {
				patch: "*** Begin Patch\n*** Update File: src/x.ts\n@@\ninvalid\n*** End Patch\n",
			}),
		).rejects.toThrow(/Invalid apply_patch format/i);
	});

	it("honors permission guard", async () => {
		const applyPatch = vi.fn();
		const permissionGuard = vi.fn(async () => false);
		const tool = createApplyPatchTool(process.cwd(), {
			operations: { applyPatch },
			permissionGuard,
		});

		await expect(
			tool.execute("apply-patch-3", {
				patch: VALID_PATCH,
			}),
		).rejects.toThrow(/Permission denied/i);

		expect(permissionGuard).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "apply_patch",
				requiredPermission: "workspace-write",
				input: expect.objectContaining({
					patchLength: VALID_PATCH.length,
					readRequiredPaths: ["src/example.ts"],
				}),
			}),
		);
		expect(applyPatch).not.toHaveBeenCalled();
	});

	it("surfaces non-zero exit code as an error", async () => {
		const tool = createApplyPatchTool(process.cwd(), {
			operations: {
				applyPatch: vi.fn(async () => ({
					stdout: "",
					stderr: "failed hunk",
					exitCode: 1,
				})),
			},
		});

		await expect(
			tool.execute("apply-patch-4", {
				patch: VALID_PATCH,
			}),
		).rejects.toThrow(/apply_patch failed \(exit 1\)/i);
	});
});

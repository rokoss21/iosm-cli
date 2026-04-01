export type ToolRequiredPermission = "read-only" | "workspace-write" | "danger-full-access";

export interface ToolPermissionRequest {
	toolName: string;
	cwd: string;
	input: Record<string, unknown>;
	summary: string;
	requiredPermission?: ToolRequiredPermission;
	toolSource?: "builtin" | "extension" | "custom" | "mcp";
}

export type ToolPermissionGuard = (request: ToolPermissionRequest) => Promise<boolean> | boolean;

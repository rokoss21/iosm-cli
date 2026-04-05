export type ToolRequiredPermission = "read-only" | "workspace-write" | "danger-full-access";
export type McpToolApprovalMode = "auto" | "prompt" | "approve";
export type PermissionGrantScope = "once" | "turn" | "session";

export interface ToolPermissionRequest {
	toolName: string;
	cwd: string;
	input: Record<string, unknown>;
	summary: string;
	requiredPermission?: ToolRequiredPermission;
	toolSource?: "builtin" | "extension" | "custom" | "mcp";
	mcpServerName?: string;
	mcpToolName?: string;
	mcpServerTrusted?: boolean;
	mcpApprovalMode?: McpToolApprovalMode;
}

export type ToolPermissionGuard = (request: ToolPermissionRequest) => Promise<boolean> | boolean;

export function getToolPermissionSignature(request: ToolPermissionRequest): string {
	const summary = request.summary.trim().replace(/\s+/g, " ");
	return `${request.toolName}:${summary}`;
}

export class PermissionGrantStore {
	private readonly turnSignatures = new Set<string>();
	private readonly sessionSignatures = new Set<string>();

	isAllowed(request: ToolPermissionRequest): boolean {
		const signature = getToolPermissionSignature(request);
		return this.turnSignatures.has(signature) || this.sessionSignatures.has(signature);
	}

	allow(request: ToolPermissionRequest, scope: PermissionGrantScope): void {
		if (scope === "once") return;
		const signature = getToolPermissionSignature(request);
		if (scope === "turn") {
			this.turnSignatures.add(signature);
			return;
		}
		this.sessionSignatures.add(signature);
	}

	resetTurn(): void {
		this.turnSignatures.clear();
	}

	resetSession(): void {
		this.sessionSignatures.clear();
	}

	resetAll(): void {
		this.resetTurn();
		this.resetSession();
	}
}

export type SlashCommandSource = "extension" | "prompt" | "skill";

export type SlashCommandLocation = "user" | "project" | "path";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	location?: SlashCommandLocation;
	path?: string;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "init", description: "Initialize iosm.yaml and .iosm scaffold in current (or target) directory" },
	{
		name: "iosm",
		description: "Run IOSM auto-improvement loop: /iosm [target-index] [--max-iterations N] [--force-init]",
	},
	{
		name: "orchestrate",
		description:
			"Manual legacy multi-agent orchestration: /orchestrate (--parallel|--sequential) --agents N ... <task>",
	},
	{
		name: "swarm",
		description:
			"Recommended multi-agent orchestration runtime for complex/risky tasks: /swarm run <task> | /swarm from-singular <run-id> --option <1|2|3> | /swarm watch|retry|resume",
	},
	{
		name: "agents",
		description:
			"Interactive agent menu: browse/use/create/edit/delete custom agents and inspect source precedence from .iosm/agents",
	},
	{ name: "subagent-runs", description: "List recent subagent runs from .iosm/subagents/runs" },
	{
		name: "subagent-resume",
		description: "Resume from prior subagent output: /subagent-resume [run-id] [extra instructions] (picker when omitted)",
	},
	{
		name: "bg",
		description: "Background shell process manager: /bg [list|status|logs|stop] ... (works with ! <command> &)",
	},
	{ name: "team-runs", description: "List recent team orchestration runs from .iosm/subagents/teams" },
	{ name: "team-status", description: "Show a team run status: /team-status [team-run-id] (picker when omitted)" },
	{ name: "cycle-list", description: "List IOSM cycles" },
	{ name: "cycle-plan", description: "Plan a new IOSM cycle: /cycle-plan [--id <id>] [--force] <goal...>" },
	{ name: "cycle-status", description: "Show IOSM cycle completeness and gates: /cycle-status [cycle-id]" },
	{ name: "cycle-report", description: "Show IOSM cycle report JSON: /cycle-report [cycle-id]" },
	{
		name: "mcp",
		description:
			"MCP server manager: /mcp (interactive UI), /mcp add <name> ..., /mcp list, /mcp tools [name], /mcp enable|disable|remove <name>",
	},
	{
		name: "memory",
		description:
			"Memory manager: /memory (interactive), /memory <text>, /memory edit <index> <text>, /memory rm <index>",
	},
	{
		name: "semantic",
		description:
			"Semantic search manager: /semantic (interactive UI), /semantic setup|auto-index|status|index|rebuild|query <text> [--top-k N]",
	},
	{
		name: "contract",
		description:
			"Engineering contract manager: /contract (interactive field editor), /contract show|edit|clear --scope <project|session>",
	},
	{
		name: "singular",
		description:
			"Feature feasibility analyzer: /singular <request> (builds implementation options and recommendations)",
	},
	{
		name: "ultrathink",
		description:
			"Deep multi-iteration analysis mode: /ultrathink [-q N|--iterations N] [query] (strict read-only tools)",
	},
	{ name: "settings", description: "Open settings menu" },
	{
		name: "permissions",
		description:
			"Permission controls: /permissions (interactive menu) or /permissions [ask|auto|yolo|status|hooks] and /permissions [allow|deny] [list|add|remove] <tool:match>",
	},
	{ name: "yolo", description: "Toggle permission prompts: /yolo [on|off|status]" },
	{ name: "model", description: "Select model (provider-first selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session to HTML file: /export [output-path] (wizard when omitted)" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{
		name: "doctor",
		description: "Run runtime diagnostics (model/auth/MCP/CLI tools/hooks/paths) with optional interactive fixes",
	},
	{ name: "checkpoint", description: "Create/list checkpoints for safe rollback" },
	{ name: "rollback", description: "Rollback session tree to a checkpoint (picker when omitted)" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Authenticate with provider (OAuth incl. Qwen + OpenRouter API key)" },
	{ name: "auth", description: "Alias for /login" },
	{ name: "logout", description: "Remove saved provider credentials (OAuth/API key)" },
	{ name: "new", description: "Start a new session" },
	{ name: "clear", description: "Alias for /new" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit iosm" },
];

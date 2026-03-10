# Extensions, Packages, Skills, Themes

`iosm-cli` has a rich customization system supporting extensions (TypeScript modules), skills (Markdown workflows), prompt templates, themes, and package distribution.

---

## Extensions

Extensions are TypeScript modules that can register tools, commands, lifecycle hooks, UI components, and provider integrations.

### Loading Extensions

```bash
# Via CLI flag (repeatable)
iosm -e ./my-extension.ts
iosm -e ./gate.ts -e ./logger.ts

# Disable all auto-discovered extensions
iosm --no-extensions
```

### Auto-Discovery Directories

| Location | Scope |
|----------|-------|
| `~/.iosm/agent/extensions/` | Global (all projects) |
| `.iosm/extensions/` | Project-local |

Extensions are auto-loaded from these directories. Use `/reload` in interactive mode to hot-reload after changes.

### Writing an Extension

```typescript
import type { ExtensionAPI } from "iosm-cli";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Everything goes here: tools, commands, hooks, UI
}
```

### Registering Custom Tools

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "weather",
    label: "Weather",
    description: "Get current weather for a city",
    parameters: Type.Object({
      city: Type.String({ description: "City name" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      const data = await fetch(`https://api.example.com/weather?city=${params.city}`);
      const json = await data.json();
      return {
        content: [{ type: "text", text: `Weather in ${params.city}: ${json.temp}°C` }],
        details: { raw: json }, // Persisted in session for fork support
      };
    },
  });
}
```

> **Note**: Use `StringEnum` instead of `Type.Union` for string enum parameters (required for Google API compatibility):
> ```typescript
> import { StringEnum } from "@mariozechner/pi-ai";
> action: StringEnum(["add", "remove", "list"] as const)
> ```

### Registering Commands

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("deploy", {
    description: "Deploy to staging environment",
    handler: async (args, ctx) => {
      ctx.ui.notify("Starting deployment...", "info");
      // Execute deployment logic
      const result = await ctx.exec("npm", ["run", "deploy:staging"]);
      ctx.ui.notify(
        result.exitCode === 0 ? "Deployment successful!" : "Deployment failed!",
        result.exitCode === 0 ? "info" : "error"
      );
    },
  });
}
```

### Lifecycle Hooks

| Hook | Trigger |
|------|---------|
| `session_start` | When a session begins or is resumed |
| `before_agent_start` | Before the agent processes a message |
| `tool_call` | Before a tool executes (can block/modify) |
| `tool_result` | After a tool returns results |
| `turn_start` | When a new conversation turn begins |
| `turn_end` | When a conversation turn ends |
| `agent_end` | When the agent finishes responding |
| `model_select` | When the model is changed |
| `input` | When user input is received |

```typescript
export default function (pi: ExtensionAPI) {
  // Block dangerous commands
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash") {
      const cmd = event.input.command || "";
      if (cmd.includes("rm -rf /")) {
        return { block: true, reason: "Blocked: dangerous command" };
      }
    }
  });

  // Log all tool usage
  pi.on("tool_result", async (event, ctx) => {
    console.log(`Tool: ${event.toolName}, Duration: ${event.duration}ms`);
  });

  // Modify system prompt dynamically
  pi.on("before_agent_start", async (event, ctx) => {
    event.systemPromptAppend = "\n\nAlways explain your reasoning step by step.";
  });

  // React to session start
  pi.on("session_start", async (event, ctx) => {
    // Reconstruct state from previous tool results
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.toolName === "weather") {
        // Rebuild internal state from persisted details
      }
    }
  });
}
```

### UI Extensions

```typescript
export default function (pi: ExtensionAPI) {
  // Custom footer
  pi.on("turn_end", async (event, ctx) => {
    ctx.ui.setFooter("left", `Tokens: ${event.usage?.totalTokens || 0}`);
  });

  // Custom status
  pi.on("turn_start", async (event, ctx) => {
    ctx.ui.setStatus("Thinking...", "info");
  });

  // Interactive confirmation
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "write") {
      const ok = await ctx.ui.confirm(
        "Write Confirmation",
        `Allow write to ${event.input.file_path}?`
      );
      if (!ok) return { block: true, reason: "User denied" };
    }
  });

  // Selection dialog
  pi.registerCommand("pick-model", {
    description: "Pick a model from a list",
    handler: async (args, ctx) => {
      const choice = await ctx.ui.select("Select Model", [
        { label: "Claude Sonnet", value: "sonnet" },
        { label: "GPT-5.3", value: "gpt-5.3" },
        { label: "Gemini Pro", value: "gemini-pro" },
      ]);
      if (choice) {
        ctx.ui.notify(`Selected: ${choice}`, "info");
      }
    },
  });
}
```

### State Persistence Pattern

Store state in tool result `details` for proper session forking support:

```typescript
let todos: string[] = [];

pi.registerTool({
  name: "todo",
  label: "Todo List",
  description: "Manage a todo list",
  parameters: Type.Object({
    action: StringEnum(["add", "list", "remove"] as const),
    item: Type.Optional(Type.String()),
  }),
  async execute(toolCallId, params) {
    if (params.action === "add" && params.item) {
      todos.push(params.item);
    }
    // State is persisted in details for fork support
    return {
      content: [{ type: "text", text: todos.join("\n") }],
      details: { todos: [...todos] },
    };
  },
});

// Reconstruct state on session resume/fork
pi.on("session_start", async (_event, ctx) => {
  todos = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "todo") {
      todos = entry.message.details?.todos || [];
    }
  }
});
```

### 66 Extension Examples

See [examples/extensions/](../examples/extensions/) for a comprehensive library including:

| Category | Examples |
|----------|---------|
| **Safety** | Permission gates, protected paths, destructive action confirmation |
| **Tools** | Todo lists, SSH delegation, image generation, dynamic tool registration |
| **UI** | Custom footers/headers, overlays (including DOOM!), modal editors, notifications |
| **Git** | Checkpoint stashing, auto-commit on exit |
| **System** | macOS theme sync, file watchers, interactive shell |
| **Providers** | Custom Anthropic, GitLab Duo, Qwen CLI |
| **Session** | Named sessions, bookmarks, context handoff |

---

## Skills

Skills are Markdown-based workflow modules that provide structured instructions to the agent.

### Structure

Each skill is a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: deploy-workflow
description: Steps to deploy the application to production
---

## Deployment Steps

1. Run the test suite: `npm test`
2. Build production assets: `npm run build`
3. Deploy to staging: `npm run deploy:staging`
4. Run smoke tests against staging
5. If all pass, deploy to production: `npm run deploy:prod`
6. Monitor error rates for 30 minutes
```

### Discovery Directories

| Location | Scope |
|----------|-------|
| `~/.iosm/agent/skills/` | Global |
| `.iosm/skills/` | Project-local |
| `.claude/skills/` | Compatibility |
| `.opencode/skills/` | Compatibility |

### CLI Flags

```bash
# Load specific skill
iosm --skill ./my-workflow.md

# Disable auto-discovery
iosm --no-skills
```

---

## Prompt Templates

Prompt templates are reusable Markdown snippets invoked as slash commands.

### Structure

Create files in the prompts directory:

```markdown
<!-- ~/.iosm/agent/prompts/code-review.md -->
---
name: code-review
description: Thorough code review template
---

Please review the following code for:
1. Security vulnerabilities
2. Performance issues
3. Code style and readability
4. Error handling completeness
5. Test coverage gaps
```

### Discovery Directories

| Location | Scope |
|----------|-------|
| `~/.iosm/agent/prompts/*.md` | Global |
| `.iosm/prompts/*.md` | Project-local |

### Usage

```bash
# In interactive mode
/code-review src/auth.ts
```

### CLI Flags

```bash
iosm --prompt-template ./my-template.md
iosm --no-prompt-templates
```

---

## Themes

Theme files customize the TUI (Terminal User Interface) appearance.

### Structure

Themes are JSON files:

```json
{
  "name": "dark-ocean",
  "colors": {
    "primary": "#0ea5e9",
    "secondary": "#6366f1",
    "success": "#22c55e",
    "warning": "#f59e0b",
    "error": "#ef4444",
    "background": "#0f172a",
    "foreground": "#e2e8f0"
  }
}
```

### Discovery Directories

| Location | Scope |
|----------|-------|
| Built-in themes | Default |
| `~/.iosm/agent/themes/*.json` | Global |
| `.iosm/themes/*.json` | Project-local |

### CLI Flags

```bash
iosm --theme ./my-theme.json
iosm --no-themes
```

---

## Package Management

Distribute and install extensions, skills, themes, and prompts as packages.

### Commands

```bash
iosm install <source> [-l|--local]    # Install a package
iosm remove <source> [-l|--local]     # Remove a package
iosm update [source]                   # Update package(s)
iosm list                              # List installed packages
```

### Source Formats

| Format | Example |
|--------|---------|
| **npm** | `npm:@my-org/iosm-tools@1.0.0` |
| **git** | `git:github.com/user/repo@main` |
| **HTTPS** | `https://github.com/user/repo.git` |
| **SSH** | `ssh://git@github.com/user/repo.git` |
| **Local** | `./local-path`, `/absolute/path` |

### Project vs Global Install

```bash
# Global (available in all projects)
iosm install npm:@my-org/security-tools

# Project-local (only this project)
iosm install npm:@my-org/security-tools --local
```

### Package Manifest

Packages should include a manifest in `package.json`:

```json
{
  "name": "@my-org/iosm-security-tools",
  "version": "1.0.0",
  "iosm": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

This tells `iosm-cli` which resources to load from the package.

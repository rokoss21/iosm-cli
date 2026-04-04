# Extension Examples

65 example extensions for `iosm-cli` demonstrating the full extension API: custom tools, lifecycle hooks, commands, UI components, and provider integrations.

## Quick Start

```bash
# Load an extension via CLI flag
iosm -e examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.iosm/agent/extensions/

# Reload at runtime
/reload
```

---

## Extension Template

Every extension exports a default function receiving the `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "iosm-cli";

export default function (pi: ExtensionAPI) {
  // Register tools, commands, hooks, UI — all goes here
}
```

---

## Examples by Category

### 🛡️ Lifecycle & Safety

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [permission-gate.ts](permission-gate.ts) | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, chmod 777) | `pi.on("tool_call")`, `ctx.ui.select()` |
| [protected-paths.ts](protected-paths.ts) | Blocks writes to protected paths (.env, .git/, node_modules/) | `pi.on("tool_call")`, `return { block: true }` |
| [confirm-destructive.ts](confirm-destructive.ts) | Confirms before destructive session actions (clear, switch, fork) | `pi.on("tool_call")`, `ctx.ui.confirm()` |
| [dirty-repo-guard.ts](dirty-repo-guard.ts) | Prevents session changes with uncommitted git changes | `pi.on("session_switch")`, `pi.exec()` |
| [sandbox/](sandbox/) | OS-level sandboxing using `@anthropic-ai/sandbox-runtime` | External sandbox integration |

### 🔧 Custom Tools

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [hello.ts](hello.ts) | **Minimal example** — simplest custom tool | `pi.registerTool()` |
| [todo.ts](todo.ts) | Todo list with `/todos` command, custom rendering, and state persistence | `pi.registerTool()`, `renderCall()`, `renderResult()` |
| [question.ts](question.ts) | Demonstrates `ctx.ui.select()` for asking user questions | `ctx.ui.select()`, custom UI |
| [questionnaire.ts](questionnaire.ts) | Multi-question input with tab bar navigation | `ctx.ui.custom()`, tab bar |
| [tool-override.ts](tool-override.ts) | Override built-in tools (e.g., add logging to `read`) | `wrapRegisteredTool()` |
| [dynamic-tools.ts](dynamic-tools.ts) | Register tools after startup and at runtime via command | `session_start` hook, prompt snippets |
| [built-in-tool-renderer.ts](built-in-tool-renderer.ts) | Custom compact rendering for built-in tools | `renderCall()`, `renderResult()` |
| [minimal-mode.ts](minimal-mode.ts) | Override built-in tool rendering for minimal display | Tool render override |
| [truncated-tool.ts](truncated-tool.ts) | Wraps ripgrep with proper output truncation (50KB/2000 lines) | Output truncation, `pi.exec()` |
| [ssh.ts](ssh.ts) | Delegate all tools to a remote machine via SSH | SSH operations, tool delegation |
| [subagent/](subagent/) | Delegate tasks to subagents with isolated context | Subagent orchestration |

### 🎨 Commands & UI

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [commands.ts](commands.ts) | Register custom slash commands | `pi.registerCommand()` |
| [preset.ts](preset.ts) | Named presets for model, thinking, tools, instructions | `--preset` flag, `/preset` command |
| [plan-mode/](plan-mode/) | Claude Code-style plan mode with step tracking | `/plan` command, read-only mode |
| [tools.ts](tools.ts) | Interactive `/tools` to enable/disable tools with persistence | `pi.registerCommand()`, tool management |
| [handoff.ts](handoff.ts) | Transfer context to new focused session via `/handoff` | Session creation, context transfer |
| [qna.ts](qna.ts) | Extracts questions from response into editor | `ctx.ui.setEditorText()` |
| [status-line.ts](status-line.ts) | Shows turn progress in footer | `ctx.ui.setStatus()` |
| [widget-placement.ts](widget-placement.ts) | Shows widgets above/below the editor | `ctx.ui.setWidget()` |
| [model-status.ts](model-status.ts) | Shows model changes in status bar | `model_select` hook |
| [custom-footer.ts](custom-footer.ts) | Git branch and token stats in footer | `ctx.ui.setFooter()` |
| [custom-header.ts](custom-header.ts) | Custom header | `ctx.ui.setHeader()` |
| [modal-editor.ts](modal-editor.ts) | Vim-like modal editor | `ctx.ui.setEditorComponent()` |
| [rainbow-editor.ts](rainbow-editor.ts) | Animated rainbow text effect | Custom editor component |
| [notify.ts](notify.ts) | Desktop notifications via OSC 777 (Ghostty, iTerm2, WezTerm) | Terminal escape sequences |
| [titlebar-spinner.ts](titlebar-spinner.ts) | Braille spinner in terminal title while agent works | `turn_start`/`turn_end` hooks |
| [summarize.ts](summarize.ts) | Summarize conversation and show in transient UI | External model call, UI |
| [snake.ts](snake.ts) | Snake game with custom UI and keyboard handling | `ctx.ui.custom()`, game loop |
| [space-invaders.ts](space-invaders.ts) | Space Invaders game | Full game rendering |
| [doom-overlay/](doom-overlay/) | DOOM game running as overlay at 35 FPS | Real-time game rendering |
| [overlay-test.ts](overlay-test.ts) | Test overlay compositing with edge cases | Overlay system |
| [overlay-qa-tests.ts](overlay-qa-tests.ts) | Comprehensive overlay QA: anchors, margins, stacking | Overlay QA |
| [shutdown-command.ts](shutdown-command.ts) | `/quit` command demonstrating `ctx.shutdown()` | `ctx.shutdown()` |
| [reload-runtime.ts](reload-runtime.ts) | `/reload-runtime` with safe reload flow | Runtime reload |
| [interactive-shell.ts](interactive-shell.ts) | Run interactive commands (vim, htop) with full terminal | `user_bash` hook |
| [inline-bash.ts](inline-bash.ts) | Expands `!{command}` patterns in prompts | `input` event transformation |
| [send-user-message.ts](send-user-message.ts) | Send user messages from extensions | `pi.sendUserMessage()` |
| [timed-confirm.ts](timed-confirm.ts) | Auto-dismissing confirm/select with AbortSignal | `AbortSignal`, `ctx.ui.confirm()` |
| [rpc-demo.ts](rpc-demo.ts) | Exercises all RPC extension UI methods | RPC UI methods |

### 🔀 Git Integration

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [git-checkpoint.ts](git-checkpoint.ts) | Creates git stash checkpoints at each turn for fork restoration | `pi.exec("git")`, `session_before_fork` |
| [auto-commit-on-exit.ts](auto-commit-on-exit.ts) | Auto-commits on exit using last assistant message | `agent_end` hook |

### 📝 System Prompt & Compaction

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [pirate.ts](pirate.ts) | Dynamically modify system prompt via hook | `before_agent_start` + `systemPromptAppend` |
| [claude-rules.ts](claude-rules.ts) | Scans `.claude/rules/` and lists rules in system prompt | System prompt injection |
| [system-prompt-header.ts](system-prompt-header.ts) | Add header to system prompt | `systemPromptAppend` |
| [custom-compaction.ts](custom-compaction.ts) | Custom compaction that summarizes entire conversation | Custom compaction strategy |
| [trigger-compact.ts](trigger-compact.ts) | Auto-triggers compaction at 100k tokens | Context monitoring, compaction |

### 💻 System Integration

| Extension | Description |
|-----------|-------------|
| [mac-system-theme.ts](mac-system-theme.ts) | Syncs iosm theme with macOS dark/light mode |

### 📦 Resources

| Extension | Description |
|-----------|-------------|
| [dynamic-resources/](dynamic-resources/) | Loads skills, prompts, themes using `resources_discover` |

### 💬 Messages & Communication

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [message-renderer.ts](message-renderer.ts) | Custom message rendering with colors and expandable details | `registerMessageRenderer` |
| [event-bus.ts](event-bus.ts) | Inter-extension communication | `pi.events` |
| [input-transform.ts](input-transform.ts) | Transform user input before processing | `input` hook |

### 📌 Session Metadata

| Extension | Description | Key APIs |
|-----------|-------------|----------|
| [session-name.ts](session-name.ts) | Name sessions for the session selector | `setSessionName` |
| [bookmark.ts](bookmark.ts) | Bookmark entries for `/tree` navigation | `setLabel` |

### 🔌 Custom Providers

| Extension | Description |
|-----------|-------------|
| [custom-provider-anthropic/](custom-provider-anthropic/) | Custom Anthropic provider with OAuth and custom streaming |
| [custom-provider-gitlab-duo/](custom-provider-gitlab-duo/) | GitLab Duo provider using built-in streaming via proxy |
| [custom-provider-qwen-cli/](custom-provider-qwen-cli/) | Qwen CLI with OAuth device flow and OpenAI-compatible models |

### 📎 External Dependencies

| Extension | Description |
|-----------|-------------|
| [with-deps/](with-deps/) | Extension with its own package.json and dependencies (jiti module resolution) |
| [file-trigger.ts](file-trigger.ts) | Watches a trigger file and injects contents into conversation |

---

## Key Patterns

### Pattern 1: Tool with Safety Gate

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    const ok = await ctx.ui.confirm("Warning", "Allow rm -rf?");
    if (!ok) return { block: true, reason: "Blocked by user" };
  }
  return undefined;  // Allow execution
});
```

### Pattern 2: Custom Tool with Rendering

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({
    input: Type.String({ description: "Input value" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: `Result: ${params.input}` }],
      details: { raw: params.input },
    };
  },
  // Custom rendering in TUI
  renderCall(args, theme) {
    return new Text(theme.fg("toolTitle", "my_tool ") + args.input, 0, 0);
  },
  renderResult(result, { expanded }, theme) {
    return new Text(result.content[0]?.text || "", 0, 0);
  },
});
```

### Pattern 3: State Persistence via Details

```typescript
let state: MyState = {};

pi.registerTool({
  name: "stateful",
  // ...
  async execute(toolCallId, params) {
    // Modify state
    state = { ...state, ...newData };
    return {
      content: [{ type: "text", text: "Done" }],
      details: { state: { ...state } },  // ← Persisted in session
    };
  },
});

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
  state = {};
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "stateful") {
      state = entry.message.details?.state || {};
    }
  }
});
```

### Pattern 4: Dynamic System Prompt

```typescript
pi.on("before_agent_start", async (event) => {
  return {
    systemPrompt: event.systemPrompt + "\n\nAdditional instructions here.",
  };
});
```

### Pattern 5: StringEnum for Google Compatibility

```typescript
import { StringEnum } from "@mariozechner/pi-ai";

// ✅ Works everywhere
action: StringEnum(["list", "add", "remove"] as const)

// ❌ Breaks with Google API
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

---

## Extension API Reference

### Registration

| Method | Description |
|--------|-------------|
| `pi.registerTool(def)` | Register a custom tool |
| `pi.registerCommand(name, handler)` | Register a slash command |
| `pi.on(event, handler)` | Subscribe to lifecycle event |
| `pi.exec(cmd, args)` | Execute a shell command |
| `pi.sendUserMessage(text)` | Send a user message programmatically |

### Lifecycle Hooks

| Hook | When | Can Block |
|------|------|-----------|
| `session_start` | Session begins or is resumed | No |
| `session_switch` | Active session changes | No |
| `session_fork` | Session is forked | No |
| `session_tree` | Tree navigation occurs | No |
| `session_before_fork` | Before fork is executed | No |
| `before_agent_start` | Before model is called | No (can modify prompt) |
| `tool_call` | Before tool executes | **Yes** (`{ block: true }`) |
| `tool_result` | After tool returns | No |
| `turn_start` | Conversation turn begins | No |
| `turn_end` | Conversation turn ends | No |
| `agent_start` | Agent begins processing | No |
| `agent_end` | Agent finishes | No |
| `model_select` | Model is changed | No |
| `input` | User input received | No (can transform) |

### UI Context Methods

| Method | Description |
|--------|-------------|
| `ctx.ui.confirm(title, message)` | Show yes/no dialog |
| `ctx.ui.select(title, options)` | Show selection dialog |
| `ctx.ui.notify(message, level)` | Show notification |
| `ctx.ui.setStatus(text, level)` | Set status bar text |
| `ctx.ui.setFooter(factory)` | Custom footer renderer |
| `ctx.ui.setHeader(factory)` | Custom header renderer |
| `ctx.ui.setWidget(placement, component)` | Show widget above/below editor |
| `ctx.ui.setEditorText(text)` | Set editor content |
| `ctx.ui.setEditorComponent(factory)` | Replace editor with custom component |
| `ctx.ui.custom(factory)` | Show full-screen custom UI |
| `ctx.hasUI` | Check if interactive mode (for non-interactive safety) |

---

## Writing Your Own Extension

1. Create a `.ts` file with the extension template
2. Place it in `~/.iosm/agent/extensions/` (global) or `.iosm/extensions/` (project)
3. Or load explicitly: `iosm -e ./my-extension.ts`
4. Use `/reload` to hot-reload during development

For full documentation, see [Extensions & Packages](../../docs/extensions-packages-themes.md).

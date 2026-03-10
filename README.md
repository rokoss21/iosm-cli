<p align="center">
  <h1 align="center">iosm-cli</h1>
  <p align="center">
    <strong>AI-Powered Engineering Agent with IOSM Methodology</strong>
  </p>
  <p align="center">
    Interactive terminal agent · Multi-provider LLM support · Built-in tools · IOSM cycles · Subagent orchestration · Extensions
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/iosm-cli"><img alt="npm version" src="https://img.shields.io/npm/v/iosm-cli?style=flat-square&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/iosm-cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/iosm-cli?style=flat-square"></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen?style=flat-square&logo=node.js">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square&logo=typescript">
  <a href="https://github.com/rokoss21/iosm-cli"><img alt="GitHub" src="https://img.shields.io/badge/github-rokoss21%2Fiosm--cli-black?style=flat-square&logo=github"></a>
</p>

---

`iosm-cli` is a standalone TypeScript CLI that combines an LLM-powered coding agent with the **IOSM** (Improve → Optimize → Shrink → Modularize) methodology for systematic engineering excellence. It provides a rich interactive terminal, built-in file/code tools, multi-provider model support, session management, subagent orchestration, and a full extension system.

## ✨ Feature Highlights

| Feature | Description |
|---------|-------------|
| **Interactive Agent** | Multi-turn terminal sessions with persistent history, branching, and tree navigation |
| **15+ LLM Providers** | Anthropic, OpenAI, Google Gemini, Groq, Cerebras, xAI, OpenRouter, Mistral, AWS Bedrock, Azure OpenAI, and more |
| **7 Built-in Tools** | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — full filesystem and shell integration |
| **IOSM Methodology** | Algorithmic improvement cycles with quality gates, metrics, hypothesis cards, and IOSM-Index scoring |
| **Subagent Orchestration** | Parallel/sequential task delegation with isolation, locks, and worktree support |
| **Extension System** | Custom tools, commands, hooks, UI components, themes, and provider integrations |
| **Skills & Prompts** | Markdown-based workflow modules and reusable prompt templates |
| **Session Management** | Persistence, branching, forking, HTML export, and sharing via GitHub Gists |
| **Multi-Mode Output** | Interactive, print (`-p`), JSON stream, and JSON-RPC for IDE integrations |
| **Package Manager** | Install extensions/skills/themes from npm, git, or local paths |
| **Programmatic SDK** | Full API via `createAgentSession()` for embedding in custom applications |
| **Configurable Profiles** | `full`, `plan`, `iosm` + advanced profiles for specialized workflows |

---

## 📦 Installation

### Global Install (recommended)

```bash
npm install -g iosm-cli
iosm --version
```

### Run Without Installing

```bash
npx iosm-cli --version
```

### Build from Source

```bash
git clone https://github.com/rokoss21/iosm-cli.git
cd iosm-cli
npm install
npm run build
npm link
```

### Requirements

- **Node.js** `>=20.6.0`
- **npm** (bundled with Node.js)
- At least one LLM provider API key (see [Providers](#-supported-providers))

---

## 🚀 Quick Start

### 1. Set Up a Provider

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export OPENAI_API_KEY="sk-..."
# or
export GEMINI_API_KEY="..."
```

### 2. Start Interactive Mode

```bash
iosm
```

You'll enter a multi-turn terminal session where you can converse with the AI agent and leverage all built-in tools.

### 3. One-Shot Prompt

```bash
# Run a single prompt and exit
iosm -p "Review src/ and list the top 5 refactoring opportunities"

# Read-only mode (no writes)
iosm --tools read,grep,find,ls -p "Audit src/ for dead code"
```

### 4. Initialize IOSM Workspace

```bash
# Bootstrap IOSM artifacts for your project
iosm init

# Plan an improvement cycle
iosm cycle plan "reduce API latency" "simplify auth module"

# Check cycle progress
iosm cycle status

# View cycle report
iosm cycle report
```

---

## 🛠 Built-in Tools

The agent has access to 7 built-in tools for direct filesystem and shell interaction:

| Tool | Description | Key Capabilities |
|------|-------------|-----------------|
| `read` | Read file contents | Line-range selection, image support, streaming for large files |
| `bash` | Execute shell commands | Full shell access with configurable permissions and timeouts |
| `edit` | Edit existing files | Diff-based editing with before/after verification |
| `write` | Create/overwrite files | New file creation, directory auto-creation |
| `grep` | Search file contents | Regex/literal search, include/exclude patterns, context lines |
| `find` | Find files by name/pattern | Glob patterns, type filters, depth limits |
| `ls` | List directory contents | Recursive listing, size/date info, ignore patterns |

### Tool Control

```bash
# Use all tools (default)
iosm

# Read-only tools
iosm --tools read,grep,find,ls

# Disable all tools
iosm --no-tools

# Specific tool selection
iosm --tools read,bash,grep
```

---

## 🤖 Supported Providers

| Provider | Environment Variable | Example Model |
|----------|---------------------|---------------|
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6-20260217` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.3` |
| Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-pro` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b` |
| Cerebras | `CEREBRAS_API_KEY` | `llama-3.3-70b` |
| xAI | `XAI_API_KEY` | `grok-5` |
| OpenRouter | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4.6` |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` |
| AWS Bedrock | `AWS_ACCESS_KEY_ID` | `anthropic.claude-sonnet-4.6` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | `gpt-5.3` |
| MiniMax | `MINIMAX_API_KEY` | — |
| Kimi | `KIMI_API_KEY` | — |
| AI Gateway | `AI_GATEWAY_API_KEY` | — |

### Model Selection

```bash
# Full provider/model specification
iosm --provider openai --model gpt-5.3

# Shorthand with provider prefix
iosm --model openai/gpt-5.3

# Model with thinking level
iosm --model sonnet:high

# Cycle through models during session
iosm --models "sonnet,gpt-5.3,gemini-2.5-pro"

# List available models
iosm --list-models
iosm --list-models gemini
```

---

## 💬 Interactive Mode

Interactive mode is the default experience — a rich multi-turn terminal session:

```bash
iosm
```

### Slash Commands

| Category | Commands |
|----------|----------|
| **Session** | `/new` `/resume` `/fork` `/tree` `/checkpoint` `/rollback` `/name` `/session` `/quit` |
| **Model** | `/model` `/scoped-models` `/settings` `/hotkeys` `/changelog` |
| **MCP** | `/mcp` |
| **Context** | `/memory` |
| **IOSM** | `/init` `/iosm` `/cycle-plan` `/cycle-status` `/cycle-report` `/cycle-list` |
| **Orchestration** | `/orchestrate` `/agents` `/subagent-runs` `/subagent-resume` `/team-runs` `/team-status` |
| **System** | `/doctor` `/export` `/share` `/copy` `/compact` `/reload` `/permissions` `/yolo` `/login` `/logout` |

`/mcp add` without flags opens a guided add-server wizard directly in the TUI.
`/memory` opens an interactive memory manager (add/edit/remove/scope/path), and `/memory <text>` appends a note to `memory.md` with immediate context reload.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Esc` | Interrupt current run |
| `Ctrl+C` | Clear input |
| `Ctrl+D` | Exit |
| `Shift+Tab` | Cycle profile (full → plan → iosm) |
| `Shift+Ctrl+T` | Cycle thinking level |
| `Ctrl+P` / `Shift+Ctrl+P` | Next/previous model |
| `Ctrl+L` | Open model selector |
| `Ctrl+O` | Expand/collapse tool output |
| `Ctrl+T` | Toggle thinking panel |
| `Ctrl+G` | Open external editor |
| `Alt+Enter` | Queue follow-up message |

Customize keybindings via `~/.iosm/agent/keybindings.json`.

### Profiles

| Profile | Behavior |
|---------|----------|
| `full` | Default — all tools enabled, full agent capabilities |
| `plan` | Read-first planning and architecture mode |
| `iosm` | IOSM context with artifact synchronization |
| `explore` | Exploratory analysis (advanced) |
| `iosm_analyst` | IOSM metric analysis (advanced) |
| `iosm_verifier` | IOSM verification (advanced) |
| `cycle_planner` | Cycle planning specialist (advanced) |

```bash
iosm --profile plan
iosm --profile iosm
```

---

## 🔄 IOSM Methodology

IOSM (**Improve → Optimize → Shrink → Modularize**) is an algorithmic methodology for systematic engineering improvement. Each cycle follows a fixed phase order with quality gates:

```
PLAN → HYPOTHESIZE → IMPROVE → GATE_I → OPTIMIZE → GATE_O → SHRINK → GATE_S → MODULARIZE → GATE_M → SCORE → LEARN → DECIDE
```

### Workspace Artifacts

Running `iosm init` creates:

```
project/
├── iosm.yaml                    # Configuration, thresholds, weights, policies
├── IOSM.md                      # Operator/agent playbook and priority checklist
└── .iosm/
    ├── metrics-history.jsonl     # Longitudinal cycle metrics
    ├── decision-log.md           # Historical decisions and rationale
    ├── pattern-library.md        # Reusable implementation patterns
    ├── waivers.yaml              # Governance exceptions
    ├── invariants.yaml           # Logic baseline
    ├── contracts.yaml            # Boundary control
    └── cycles/
        └── <cycle-id>/
            ├── baseline-report.json
            ├── hypotheses.json
            ├── cycle-report.json
            └── phase-reports/
                ├── improve.json
                ├── optimize.json
                ├── shrink.json
                └── modularize.json
```

### Six Canonical Metrics

| Metric | Intent |
|--------|--------|
| `semantic` | The system says one thing in one way |
| `logic` | The system behaves consistently |
| `performance` | The system is fast enough and survives disruption |
| `simplicity` | The system is easier to use and change |
| `modularity` | The system evolves with low blast radius |
| `flow` | The organization ships changes predictably |

### Example Workflow

```bash
# 1. Initialize IOSM workspace
iosm init

# 2. Plan a cycle with goals
iosm cycle plan "reduce checkout latency" "simplify auth module"

# 3. Work through the cycle in interactive mode
iosm --profile iosm

# 4. Check progress
iosm cycle status

# 5. View the full report
iosm cycle report
```

For the full IOSM specification, see [iosm-spec.md](./iosm-spec.md).

---

## 🤝 Subagent Orchestration

Delegate tasks to specialized subagents with parallel or sequential execution:

```bash
# Orchestrate 3 parallel agents with different profiles
/orchestrate --parallel --agents 3 \
  --profiles explore,full,iosm_verifier \
  --cwd .,src,.iosm \
  Implement feature X

# Sequential with dependencies
/orchestrate --sequential --agents 2 \
  --depends 2>1 \
  First analyze, then implement

# With worktree isolation for write-heavy work
/orchestrate --parallel --worktree --agents 2 \
  Refactor both modules independently
```

### Custom Agents

Define custom agents in `.iosm/agents/*.md`:

```markdown
---
name: security-auditor
description: Specialized security review agent
---

You are a security auditor. Review code for:
- SQL injection vulnerabilities
- XSS attack vectors
- Authentication bypasses
- Secrets exposure
```

Use with `@security-auditor` mention in interactive mode.

---

## 🔌 Extension System

Extensions are TypeScript modules that can register tools, commands, hooks, UI components, and provider integrations.

### Quick Example

```typescript
import type { ExtensionAPI } from "iosm-cli";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  // Register a custom tool
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a slash command
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello from extension!", "info");
    },
  });

  // Subscribe to lifecycle events
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Warning", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });
}
```

### Loading Extensions

```bash
# CLI flag
iosm -e ./my-extension.ts

# Auto-discovery directories
~/.iosm/agent/extensions/    # Global
.iosm/extensions/            # Project-local
```

See [66 extension examples](./examples/extensions/) covering tools, UI, git integration, providers, and more.

---

## 📡 SDK & Programmatic Usage

Use `iosm-cli` as a library in your own applications:

```typescript
import { createAgentSession, AuthStorage, ModelRegistry } from "iosm-cli";

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

// Create a session
const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
});

// Subscribe to events
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

// Send prompts
await session.prompt("Analyze this codebase and suggest improvements");
```

### Output Modes

```bash
# JSON event stream (for automation)
iosm --mode json "Your prompt"

# JSON-RPC server (for IDE integration)
iosm --mode rpc --no-session

# Single-turn print (for scripts/CI)
iosm -p "Summarize the architecture"
```

See [12 SDK examples](./examples/sdk/) for complete usage patterns.

---

## 📂 Sessions & Export

### Session Persistence

```bash
# Continue previous session
iosm --continue
iosm -c

# Interactive session picker
iosm --resume
iosm -r

# Use specific session file
iosm --session /path/to/session.jsonl

# Ephemeral (no persistence)
iosm --no-session
```

### Export & Sharing

```bash
# Export session to HTML
/export

# Share via GitHub Gist
/share

# Copy last response to clipboard
/copy
```

### Session Navigation

```bash
# View session tree
/tree

# Fork from a previous point
/fork

# Name the session
/name "refactoring-auth-module"
```

---

## ⚙️ Configuration

### Hierarchy (highest priority first)

1. **CLI flags** — runtime overrides
2. **Project settings** — `.iosm/settings.json`
3. **Global settings** — `~/.iosm/agent/settings.json`

### Key Directories

| Path | Purpose |
|------|---------|
| `~/.iosm/agent/` | Global config, models, auth, sessions |
| `~/.iosm/agent/settings.json` | Global settings |
| `~/.iosm/agent/auth.json` | Provider credentials |
| `~/.iosm/agent/extensions/` | Global extensions |
| `~/.iosm/agent/skills/` | Global skills |
| `~/.iosm/agent/themes/` | Global themes |
| `.iosm/` | Project-local workspace |
| `.iosm/settings.json` | Project settings |
| `.iosm/extensions/` | Project extensions |

### Environment Variables

```bash
# Provider keys
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
export GEMINI_API_KEY="..."

# Runtime behavior
export IOSM_OFFLINE=1                     # Disable network on startup
export IOSM_SESSION_TRACE=1               # Enable JSONL trace
export IOSM_SESSION_TRACE_DIR="/traces"   # Trace directory
export IOSM_CODING_AGENT_DIR="/custom"    # Override agent directory
```

---

## 📁 Repository Structure

```
iosm-cli/
├── src/
│   ├── cli/              # CLI argument parsing and config
│   ├── core/             # Runtime engine
│   │   ├── tools/        # Built-in tools (read, bash, edit, write, grep, find, ls)
│   │   ├── extensions/   # Extension system (discovery, runners, hooks)
│   │   ├── compaction/   # Context compaction and summarization
│   │   ├── export-html/  # HTML session export templates
│   │   ├── agent-session.ts    # Core agent session logic
│   │   ├── subagents.ts        # Subagent orchestration
│   │   ├── session-manager.ts  # Session persistence
│   │   ├── model-registry.ts   # Multi-provider model registry
│   │   ├── package-manager.ts  # Package install/remove/update
│   │   ├── sdk.ts              # Programmatic API
│   │   └── ...
│   ├── iosm/             # IOSM methodology implementation
│   │   ├── init.ts       # Workspace bootstrapping
│   │   ├── cycle.ts      # Cycle lifecycle management
│   │   ├── metrics.ts    # Metric calculation and normalization
│   │   ├── config.ts     # IOSM configuration parsing
│   │   └── ...
│   ├── modes/            # Output modes
│   │   ├── interactive/  # TUI with full keyboard/UI
│   │   ├── rpc/          # JSON-RPC server mode
│   │   └── print-mode.ts # Single-shot print mode
│   └── utils/            # Utilities (git, shell, clipboard, images)
├── test/                 # 73 Vitest test files
├── examples/
│   ├── extensions/       # 66 extension examples
│   └── sdk/              # 12 SDK examples
├── docs/                 # Comprehensive documentation
├── iosm-spec.md          # Full IOSM methodology specification
├── package.json
├── tsconfig.base.json
└── vitest.config.ts
```

---

## 🧑‍💻 Development

```bash
# Install dependencies
npm install

# Type-check
npm run check

# Run tests
npm test

# Build
npm run build

# Watch mode (development)
npm run dev

# Build standalone binary (via Bun)
npm run build:binary
```

See [Development & Testing](./docs/development-and-testing.md) and [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](./docs/getting-started.md) | Installation, first run, provider setup |
| [CLI Reference](./docs/cli-reference.md) | Complete flag and option reference |
| [Interactive Mode](./docs/interactive-mode.md) | Slash commands, keybindings, profiles |
| [IOSM Init & Cycles](./docs/iosm-init-and-cycles.md) | Workspace bootstrap and cycle operations |
| [Orchestration & Subagents](./docs/orchestration-and-subagents.md) | Task delegation and parallel execution |
| [Extensions & Packages](./docs/extensions-packages-themes.md) | Extension API, skills, themes, packages |
| [Configuration](./docs/configuration.md) | Settings, env vars, profiles |
| [Sessions & Export](./docs/sessions-traces-export.md) | Persistence, traces, HTML export |
| [JSON/RPC/SDK](./docs/rpc-json-sdk.md) | Programmatic integrations |
| [Development & Testing](./docs/development-and-testing.md) | Contributing, architecture, tests |
| [IOSM Specification](./iosm-spec.md) | Full methodology specification |

---

## 📄 License

[MIT](./LICENSE) © 2026 Emil Rokossovskiy

---

<p align="center">
  <sub>Created by Emil Rokossovskiy · <a href="https://github.com/rokoss21">@rokoss21</a> · ecsiar@gmail.com</sub>
</p>

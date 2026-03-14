<div align="center">

<h1>IOSM CLI 0.2.8</h1>

<p><strong>Terminal-native AI runtime for controlled, measurable engineering work on real codebases.</strong></p>

<p>
  <a href="https://www.npmjs.com/package/iosm-cli"><img alt="npm version" src="https://img.shields.io/npm/v/iosm-cli?style=flat-square&color=cb3837&logo=npm"></a>
  <a href="https://www.npmjs.com/package/iosm-cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/iosm-cli?style=flat-square&logo=npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen?style=flat-square&logo=node.js&logoColor=white">
  <a href="https://github.com/rokoss21/iosm-cli"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/rokoss21/iosm-cli?style=flat-square&logo=github"></a>
</p>

<p>
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-the-iosm-methodology">Methodology</a> ·
  <a href="#-usage-patterns">Usage Patterns</a> ·
  <a href="#-agent-profiles">Profiles</a> ·
  <a href="#-documentation">Documentation</a>
</p>

<img src="./docs/assets/preview.jpg" alt="IOSM CLI terminal preview" width="860">

</div>

---

Most AI CLIs are optimized for conversation. **IOSM CLI is optimized for controlled engineering execution** — working directly against your filesystem and shell, orchestrating parallel agents across complex tasks, tracking metrics and artifacts over time, and running improvement cycles that can be audited, repeated, and benchmarked.

It is not a chat interface. It is a runtime.

---

## Table of Contents

- [What You Get](#-what-you-get)
- [The IOSM Methodology](#-the-iosm-methodology)
- [Quick Start](#-quick-start)
- [Usage Patterns](#-usage-patterns)
- [Agent Profiles](#-agent-profiles)
- [Complex Change Workflow](#-complex-change-workflow)
- [Integration Modes](#-integration-modes)
- [Extensibility](#-extensibility)
- [Configuration](#-configuration)
- [Architecture](#-architecture)
- [Documentation](#-documentation)
- [Development](#-development)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✦ What You Get

| Area | Capability |
|------|-----------|
| **Everyday coding** | Interactive terminal session with file, search, edit, and shell tools |
| **Operational safety** | `/checkpoint`, `/rollback`, `/doctor`, granular permission controls |
| **Complex changes** | `/contract` → `/singular` → `/swarm` — deterministic execution with locks and gates |
| **Codebase understanding** | Semantic search, repository-scale indexing, project memory |
| **Multi-agent work** | Parallel subagents with shared memory and consistency model |
| **Methodology** | IOSM cycles: measurable improvement with metrics, evidence, and artifact history |
| **Integrations** | Interactive TUI, print mode, JSON event stream, JSON-RPC server, TypeScript SDK |
| **Extensibility** | MCP servers, TypeScript extensions, Markdown skills, prompt templates, themes |

---

## ✦ The IOSM Methodology

IOSM — **Improve, Optimize, Shrink, Modularize** — is an algorithmic methodology for systematic engineering improvement. It transforms ad-hoc refactoring into a reproducible, measurable process.

**Four mandatory phases — executed in strict order:**

```
Improve → Optimize → Shrink → Modularize
```

| Phase | Focus |
|-------|-------|
| **Improve** | Eliminate defects, inconsistencies, and technical debt |
| **Optimize** | Reduce resource usage, latency, and execution cost |
| **Shrink** | Minimize code surface — delete dead code, compress abstractions |
| **Modularize** | Extract cohesive components, enforce dependency hygiene |

**Six canonical metrics** track progress across every phase:

| Metric | Measures |
|--------|----------|
| `semantic` | Code clarity — naming, comments, structure readability |
| `logic` | Correctness — test coverage, error handling, invariants |
| `performance` | Runtime efficiency — latency, throughput, resource usage |
| `simplicity` | Cognitive load — cyclomatic complexity, abstraction depth |
| `modularity` | Dependency health — coupling, cohesion, interface clarity |
| `flow` | Delivery velocity — CI reliability, deploy frequency, lead time |

Metrics can be derived automatically or attached as evidence during IOSM cycles.

**The IOSM-Index** aggregates all six metrics into a single weighted health score. Every cycle produces a baseline, hypothesis cards, evidence trails, and a final report — stored in `.iosm/` for permanent project history.

Quality gates after each phase enforce progression: a phase cannot close if any guardrail is breached.

> Full specification: [iosm-spec.md](./iosm-spec.md) · Canonical repository: [github.com/rokoss21/IOSM](https://github.com/rokoss21/IOSM)

---

## ✦ Quick Start

### 1. Install

```bash
npm install -g iosm-cli
iosm --version
```

**Requirements:** Node.js `>=20.6.0` · at least one authenticated model provider

No global install? Use `npx`:

```bash
npx iosm-cli --version
```

### 2. Configure a provider

The fastest path is interactive setup inside the app:

```
iosm
/login      ← OAuth or API key (models.dev catalog)
/model      ← pick your model
```

Or set an environment variable before launching:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude (recommended)
export OPENAI_API_KEY="sk-..."          # GPT models
export GEMINI_API_KEY="AI..."           # Gemini
export GROQ_API_KEY="gsk_..."           # Groq
# Also supported: OpenRouter, Mistral, xAI, Cerebras, AWS Bedrock
```

### 3. Run your first session

```bash
cd /path/to/your/project

# Interactive mode
iosm

# Or one-shot without entering the TUI
iosm -p "Summarize the repository architecture"
```

Inside interactive mode:
```
Review the repository structure and summarize the architecture.
```

### 4. Optional — enhanced search toolchain

Works without these, but large repositories benefit significantly:

```bash
# macOS
brew install ripgrep fd ast-grep comby jq yq semgrep

# Ubuntu / Debian
sudo apt-get install -y ripgrep fd-find jq yq sed
```

Run `/doctor` to check your environment at any time.

---

## ✦ Usage Patterns

### Daily coding and repository work

Default `full` profile. Works on any codebase without prior setup.

```bash
iosm
```

Common tasks:
- implement or refactor features
- read, search, and edit files with full shell access
- review architecture or explore unfamiliar modules
- resume previous sessions: `/resume`, `/fork`, `/tree`
- keep persistent notes: `/memory`

One-shot tasks skip the interactive TUI entirely:

```bash
iosm -p "Audit src/ for unused exports"
iosm @README.md @src/main.ts -p "Explain the CLI entry points"
iosm --tools read,grep,find -p "Find all TODO comments in src/"
```

---

### Read-only planning and review

Use `plan` when you want architecture analysis or code review without any writes.

```bash
iosm --profile plan
```

The agent is restricted to read-only tools. Nothing can be written to disk. Useful for code review, architecture audits, or exploring a codebase you are unfamiliar with before making changes.

---

### Complex or risky engineering changes

Define constraints → analyze options → execute with guardrails:

```
/contract
/singular Refactor auth module, split token validation from session management
```

`/singular` produces three implementation options with trade-off analysis. Select one, then choose **Start with Swarm** to hand off to the execution runtime.

> `/swarm` will not start without an active `/contract`. If none exists, it prompts you to draft one automatically.

The swarm runtime then executes with locks, gates, retries, and checkpoints, writing per-run artifacts under `.iosm/orchestrate/<run-id>/`.

Monitor and control the run:

```
/swarm watch     ← live status
/swarm retry     ← retry failed gates
/swarm resume    ← continue interrupted runs
```

---

### Measurable codebase improvement (IOSM cycles)

Use the `iosm` profile for structured improvement with metric tracking and artifact history.

```bash
iosm --profile iosm
```

Bootstrap the workspace once:

```
/init
```

Run a full improvement cycle targeting an IOSM-Index of 0.95:

```
/iosm 0.95 --max-iterations 5
```

Or use CLI subcommands:

```bash
iosm init                             # bootstrap .iosm/ workspace
iosm cycle plan "Reduce auth complexity" "Improve test coverage"
iosm cycle status                     # check phase progress and gate results
iosm cycle report                     # full JSON report
iosm cycle list                       # history of all cycles
```

Artifacts are written to `.iosm/cycles/<cycle-id>/` — baselines, hypothesis cards, phase data, and final reports.

---

## ✦ Agent Profiles

Profiles control tool access, thinking level, and behavioral guidance injected into the model's system prompt.

**Primary profiles** — operator-facing:

| Profile | Best for | Tool access | Thinking |
|---------|----------|-------------|----------|
| `full` | General engineering (default) | Full toolset | Medium |
| `meta` | Orchestration-first, parallel delegation | Full toolset | Medium |
| `iosm` | IOSM cycles, artifact-aware refactoring | Full + IOSM context | Medium |
| `plan` | Read-only planning and code review | Read-only | Medium |

**Specialist profiles** — for subagent delegation and targeted work:

| Profile | Best for | Tool access | Thinking |
|---------|----------|-------------|----------|
| `explore` | Fast codebase exploration (no writes) | Read, grep, find, ls | Off |
| `iosm_analyst` | Reading `.iosm/` artifacts, reporting | Read-only | Low |
| `iosm_verifier` | Verifying changes, updating `.iosm/` | bash, read, write | Low |
| `cycle_planner` | Planning IOSM cycles, writing hypotheses | bash, read, write | Medium |

Select at startup:

```bash
iosm --profile plan
iosm --profile iosm
```

Switch during a session: **Shift+Tab** (cycles through primary profiles), or select via the TUI.

> `meta` prioritizes orchestration and delegation over direct execution. Strong results require a capable model with a large context window and reliable tool-calling. For ordinary sessions, `full` is the better default.

---

## ✦ Complex Change Workflow

For non-trivial changes, the recommended path is a controlled progression rather than a single giant prompt.

```mermaid
flowchart LR
  A[Goal] --> B["/contract"]
  B --> C["/singular"]
  C --> D["/swarm"]
  D --> E[Verified changes]
  E --> F["/iosm cycle"]
  F --> G[Artifacts + history]
```

**Step-by-step:**

1. **Define scope** — `/contract` sets what is in scope, what is protected, and what model behavior is expected
2. **Analyze options** — `/singular <request>` produces three implementation plans with trade-off analysis
3. **Execute with guardrails** — `/swarm run <task>` enforces a deterministic control model:
   ```
   Scopes → Touches → Locks → Gates → Done
   ```
4. **Measure** — follow with `/iosm` to capture metric changes as part of a formal cycle

Run artifacts: `.iosm/orchestrate/<run-id>/` — run state, DAG, checkpoints, events, final report.

---

## ✦ Integration Modes

| Mode | Use case | How |
|------|----------|-----|
| **Interactive TUI** | Daily engineering work | `iosm` |
| **Print mode** | One-shot tasks, shell scripts | `iosm -p "..."` |
| **CI / automation** | Contract-driven runs inside pipelines | `iosm -p "..."` — exits non-zero on failure |
| **JSON stream** | Machine-readable event output | `iosm --mode json -p "..."` |
| **RPC server** | IDE / editor integration | `iosm --mode rpc --no-session` |
| **TypeScript SDK** | Embed the runtime in your own application | `createAgentSession()` |

```bash
# Print mode — one-shot task
iosm -p "Review src/auth.ts for security issues"

# Constrain which tools are available
iosm --tools read,grep,find,ls -p "Audit src/ for dead code"

# Pre-load files as context
iosm @src/main.ts @src/core/sdk.ts -p "Explain the session lifecycle"

# JSON stream for programmatic consumption
iosm --mode json -p "Summarize the repository" | jq -r 'select(.type=="text_delta") | .delta'

# RPC server for editor integrations
iosm --mode rpc --no-session
```

---

## ✦ Extensibility

`iosm-cli` acts as a runtime platform rather than a closed CLI tool. Every layer is open to extension.

### Extension surfaces

| Surface | Capability |
|---------|-----------|
| **MCP servers** | Connect external services as tools (user-level or project-level via `.mcp.json`) |
| **TypeScript extensions** | Custom tools, slash commands, hooks, UI components, provider adapters |
| **Markdown skills** | Reusable multi-step workflows as slash commands |
| **Prompt templates** | Parameterized prompts available as slash commands |
| **JSON themes** | Customize terminal colors and TUI appearance |

Install from npm, git, or a local path:

```bash
iosm install npm:@yourorg/your-extension
iosm install git:github.com/yourorg/your-extension@main
iosm install ./local-extension --local
iosm list
iosm update
```

### Included examples

- [66 extension examples](./examples/extensions/README.md) — tools, hooks, UI, commands
- [12 SDK examples](./examples/sdk/README.md) — programmatic session usage
- [Plan-mode extension](./examples/extensions/plan-mode/README.md)
- [Subagent orchestration extension](./examples/extensions/subagent/README.md)

---

## ✦ Configuration

Settings merge in priority order: **CLI flags** > **project** `.iosm/settings.json` > **global** `~/.iosm/agent/settings.json`.

### Key paths

```
~/.iosm/agent/
├── settings.json        # global defaults
├── auth.json            # provider credentials
├── models.json          # model configuration
├── mcp.json             # global MCP servers
├── keybindings.json     # keyboard shortcuts
└── sessions/            # session persistence

.iosm/                   # project workspace (created by /init or iosm init)
├── iosm.yaml            # methodology config: phases, gates, guardrails, weights
├── IOSM.md              # auto-generated project playbook
├── contract.json        # active engineering contract
├── cycles/              # IOSM cycle artifacts
├── orchestrate/         # swarm run artifacts
└── settings.json        # project overrides
```

### Key settings

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-20250514",
    "thinking": "medium"
  },
  "tools": {
    "enabled": ["read", "bash", "edit", "write", "grep", "rg"],
    "bashTimeout": 30000
  },
  "session": {
    "autoCompact": true,
    "compactThreshold": 100000
  },
  "permissions": {
    "autoApprove": false
  }
}
```

Run `/settings` inside the TUI to view and modify all settings interactively.

---

## ✦ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                         User                            │
│         CLI flags · slash commands · SDK calls          │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│                   iosm-cli runtime                      │
│   Interactive TUI · Print mode · JSON stream · RPC      │
│   Session persistence · Checkpoints · Contracts         │
└──────────┬──────────────────────────┬───────────────────┘
           │                          │
┌──────────▼─────────────┐  ┌─────────▼───────────────────┐
│      Agent engine      │  │        Orchestrator         │
│  Model · Profiles      │  │  /swarm · /singular · /meta │
│  Thinking · Tools      │  │  Shared memory · Locks      │
└──────────┬─────────────┘  └─────────┬───────────────────┘
           │                          │
┌──────────▼──────────────────────────▼───────────────────┐
│                       Tool layer                        │
│  read · edit · write · fs_ops · bash · grep · rg · fd · ast_grep │
│  comby · jq · yq · semgrep · sed · semantic_search · fetch · web_search · git_read · git_write │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                   Filesystem + Shell                    │
│          Project codebase · External processes          │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│               Artifacts + IOSM cycles                   │
│   .iosm/cycles/  ·  .iosm/orchestrate/  ·  sessions/    │
│   metrics-history.jsonl  ·  decision-log.md             │
└─────────────────────────────────────────────────────────┘
```

Every layer is independently configurable: tool access per profile, orchestration via swarm or manual delegation, persistence toggleable per session, extension hooks attachable at the tool, command, and event layers of the runtime.

---

## ✦ Documentation

| Topic | Link |
|-------|------|
| Documentation index | [docs/README.md](./docs/README.md) |
| Getting started | [docs/getting-started.md](./docs/getting-started.md) |
| CLI reference | [docs/cli-reference.md](./docs/cli-reference.md) |
| Interactive mode and slash commands | [docs/interactive-mode.md](./docs/interactive-mode.md) |
| IOSM init and cycles | [docs/iosm-init-and-cycles.md](./docs/iosm-init-and-cycles.md) |
| Orchestration and subagents | [docs/orchestration-and-subagents.md](./docs/orchestration-and-subagents.md) |
| Configuration and environment | [docs/configuration.md](./docs/configuration.md) |
| Extensions, packages, skills, themes | [docs/extensions-packages-themes.md](./docs/extensions-packages-themes.md) |
| Sessions, traces, export | [docs/sessions-traces-export.md](./docs/sessions-traces-export.md) |
| JSON stream, RPC, SDK | [docs/rpc-json-sdk.md](./docs/rpc-json-sdk.md) |
| Development and testing | [docs/development-and-testing.md](./docs/development-and-testing.md) |
| Changelog | [CHANGELOG.md](./CHANGELOG.md) |
| IOSM specification (v1.0) | [iosm-spec.md](./iosm-spec.md) |
| Canonical IOSM repository | [github.com/rokoss21/IOSM](https://github.com/rokoss21/IOSM) |

---

## ✦ Development

```bash
git clone https://github.com/rokoss21/iosm-cli.git
cd iosm-cli
npm install
npm run check    # typecheck
npm test         # run tests (vitest)
npm run build    # compile to dist/
```

Additional scripts:

```bash
npm run dev            # watch mode (incremental compilation)
npm run build:binary   # standalone Bun binary
npm run deploy-local   # build and sync local install
```

**Repository layout:**

```
src/           TypeScript source
test/          Vitest test suites
docs/          Reference documentation
examples/      Extension and SDK examples (66 + 12)
iosm-spec.md   IOSM methodology specification
```

---

## ✦ Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development workflow, testing requirements, and contribution guidelines.

Issues and pull requests are welcome. Please open an issue before starting large changes.

---

## ✦ License

[MIT](./LICENSE) © 2026 Emil Rokossovskiy

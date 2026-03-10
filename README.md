<h1 align="center">IOSM CLI v0.1.0</h1>

<p align="center">
  <strong>AI Engineering Runtime for Professional Developers</strong>
</p>
<p align="center">
  Interactive coding agent · IOSM methodology · MCP · Checkpoints · Subagent orchestration · Extensions
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/iosm-cli"><img alt="npm version" src="https://img.shields.io/npm/v/iosm-cli?style=flat-square&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/iosm-cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/iosm-cli?style=flat-square"></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D20.6.0-brightgreen?style=flat-square&logo=node.js">
  <a href="https://github.com/rokoss21/iosm-cli"><img alt="GitHub" src="https://img.shields.io/badge/github-rokoss21%2Fiosm--cli-black?style=flat-square&logo=github"></a>
</p>

<p align="center">
  <img src="./docs/assets/preview.jpg" alt="IOSM CLI terminal preview">
</p>

---

**IOSM CLI** (`iosm-cli`) is not a chat wrapper around an LLM.

It is a runtime for production codebases:
- a terminal-native coding agent with direct filesystem and shell tooling
- primary operating profiles: **full** (default) and **iosm** (advanced, methodology-driven engineering cycles)
- smart orchestration for complex tasks: parallel/sequential agents, dependency ordering, lock coordination, and worktree isolation
- repeatable codebase improvement workflows via **IOSM** (Improve -> Optimize -> Shrink -> Modularize)
- auditable artifact history for cycles, decisions, and metric evolution across runs
- operational controls for safe iteration (`/checkpoint`, `/rollback`, `/doctor`, `/memory`)
- extensibility for teams (MCP + extensions) and embedding (SDK + JSON/RPC modes)

Adoption path is layered: start in **full** profile for low-friction daily usage, then switch to **iosm** profile when you need advanced IOSM cycles, metrics, and governance.

## Why It Exists

Most AI CLIs optimize for conversation.
**IOSM CLI** optimizes for engineering execution quality.

| Area | Typical AI CLI | IOSM CLI |
|------|----------------|------------|
| Workflow | Prompt-by-prompt | Structured session + IOSM cycles |
| Safety | Basic confirmations | Checkpoints, rollback, diagnostics, permission policies |
| Context ops | Ad hoc notes | Managed memory with interactive edit/remove |
| Tooling | Built-ins only | Built-ins + MCP + extension tools |
| Integrations | Mostly interactive only | Interactive + print + JSON + JSON-RPC + SDK |

## Compared to Other Tools

This is not a “better/worse” claim. It is a positioning map so teams can choose the right tool for the job.

| Tool | Typical Strength | Typical Mode | IOSM CLI Difference |
|------|------------------|--------------|------------------------|
| **Claude Code** | Strong conversational coding flow | Terminal conversation | Adds structured IOSM cycles + explicit checkpoint/rollback/doctor workflow |
| **OpenCode** | Lightweight open-source coding assistant | Terminal-first iteration | Emphasizes repeatable engineering process and quality-gated cycles |
| **Cursor** | Excellent IDE-native editing and inline assistance | IDE-first | Keeps workflow in terminal with agent tooling, MCP, and scriptable runtime modes |
| **Gemini CLI** | Fast Gemini-centric command-line assistance | CLI prompts and tasks | Provider-agnostic runtime + IOSM methodology + deeper operational controls |
| **IOSM CLI** | Structured engineering execution | Terminal runtime + methodology | Designed for reproducible refactors, diagnostics, memory, and cycle artifacts |

## Who It Is For

- developers at any level: start in **full** profile and be productive quickly
- advanced engineers and tech leads using **iosm** mode for high-risk refactors and system-level change
- teams that need auditability, rollback, and repeatable improvement history
- platform/backend teams that operationalize AI coding into reliable workflows
- teams building internal coding automation on top of a CLI runtime

## Install

```bash
npm install -g iosm-cli
iosm --version
```

Requirements:
- Node.js `>=20.6.0`
- provider auth (environment variable API key and/or `/login`)

## 60-Second Start

```bash
# 1) Open project and start CLI
cd /path/to/repo
iosm
```

Inside the session (full profile):
```text
/login            # or /auth: configure credentials
/model            # select active model
<your task>       # start working immediately
```

When you need advanced IOSM workflow:
```text
Shift+Tab         # switch profile to iosm
/init             # bootstrap IOSM workspace
/iosm 0.95 --max-iterations 5
```

Core commands to unlock full runtime value:
- `/orchestrate` — run parallel/sequential subagents with dependencies, locks, and optional worktrees
- `/init` + `/iosm` — execute measurable IOSM cycles with artifacts and quality gates
- `/mcp` — connect external tool ecosystems in interactive UI
- `/memory` — persist project facts and constraints across sessions

### Example Session

```console
$ iosm
IOSM CLI v0.1.0 [full]
status  [profile full] [model github-copilot/grok-code-fast-1] [mcp 1/1] [memory p:0 u:0]
next    task  /orchestrate  /init  /iosm

you> Split auth refactor into parallel agents and run an IOSM cycle with quality gates
iosm> Team run started: #42 (/orchestrate --parallel --agents 4 ...)
iosm> agent[1|iosm_analyst] found coupling hotspots in auth/session/token
iosm> agent[2|explore] prepared migration path for middleware branches
iosm> agent[3|iosm_verifier] added regression checks and failure guards
iosm> Consolidated execution plan ready
iosm> /init
iosm> /iosm 0.95 --max-iterations 5
iosm> Result: simplicity +18%, modularity +11%, performance +6%
iosm> Artifacts: .iosm/cycles/2026-03-10-001/
```

## Real-World Example: Agent-Orchestrated IOSM Refactor

```console
$ iosm
IOSM CLI v0.1.0 [full]

you> Refactor authentication module with parallel agents, then finalize in IOSM mode
iosm> /orchestrate --parallel --agents 4 \
      --profiles iosm_analyst,explore,iosm_verifier,full \
      --depends 3>1,4>2 --locks schema,config --worktree \
      Refactor auth and reduce integration risk
iosm> Team run started: #77

iosm> agent[1] architecture map complete
iosm> agent[2] implementation patch set prepared
iosm> agent[3] verification suite and rollback checks ready
iosm> agent[4] integration validation passed
iosm> Consolidated patch plan generated

iosm> switch profile: iosm (Shift+Tab)
iosm> /init
iosm> IOSM workspace initialized
iosm> /iosm 0.95 --max-iterations 5

iosm> Baseline captured
iosm> Planned cycle from team artifacts: simplify auth module
iosm> Running improve -> verify -> optimize loop
iosm> Result: simplicity +18%, modularity +11%, performance +6%
iosm> Artifacts written to .iosm/cycles/2026-03-10-001/
```

For broader tasks, delegate in parallel:

```bash
/orchestrate --parallel --agents 4 \
  --profiles iosm_analyst,explore,iosm_verifier,full \
  --depends 3>1,4>2 --locks schema,config --worktree \
  Refactor auth and reduce integration risk
```

## Architecture Overview

`IOSM CLI` is layered so execution stays controllable as task complexity grows:

```text
Providers (OpenAI / Anthropic / OpenRouter / GitHub / Qwen)
   ↓
Auth + Model Selection (/login, /model)
   ↓
Agent Runtime (interactive + JSON + JSON-RPC + SDK)
   ↓
Tooling Layer (read / edit / bash / grep / find / ls + MCP tools)
   ↓
Orchestration Engine (/orchestrate, subagents, dependencies, locks, worktrees)
   ↓
IOSM Layer (/init, /iosm cycles, metrics, governance)
   ↓
Artifacts + Memory (.iosm/cycles/*, checkpoints, /memory state)
```

## Design Principles

- **AI executes structured engineering loops, not ad hoc chats.** Core flow is orchestration + IOSM cycle execution (`/orchestrate` -> `/init` -> `/iosm`).
- **Complex work needs orchestration.** Parallel agents, dependency ordering, locks, and optional worktree isolation reduce collision and blast radius.
- **Refactoring must be measurable.** IOSM cycles capture baseline, hypotheses, and metric deltas instead of untracked edits.
- **Every important run must be auditable.** Artifacts and memory preserve decisions and outcomes across sessions.
- **Adoption should be progressive.** Start in `full` profile for speed; move to `iosm` profile for advanced cycles and governance when needed.

## Operating Profiles

`IOSM CLI` has a layered operating model:

| Profile | Best For | What `/init` Does | Advanced Command |
|------|----------|-------------------|------------------|
| **full** (default) | Daily coding for any level | Generates/updates `AGENTS.md` from real repo scan and prepares `.iosm/agents/` | Use `/orchestrate` and built-in tools directly |
| **iosm** (advanced) | High-risk refactors and system-level engineering loops | Bootstraps full IOSM workspace (`iosm.yaml`, `IOSM.md`, `.iosm/cycles/...`) with optional agent verification | `/iosm [target-index] [--max-iterations N] [--force-init]` |

Typical advanced flow:

```bash
iosm --profile iosm
/init
/iosm 0.95 --max-iterations 5
```

## Smart Orchestration

For complex work, use explicit multi-agent orchestration instead of one long monolithic prompt.

`/orchestrate` supports:
- parallel or sequential execution (`--parallel` / `--sequential`)
- controlled concurrency (`--max-parallel`)
- per-agent profiles and working directories (`--profiles`, `--cwd`)
- dependency DAGs (`--depends 2>1,3>2`)
- write safety (`--locks`) and optional git worktree isolation (`--worktree`)

Example:

```bash
/orchestrate --parallel --agents 4 \
  --profiles iosm_analyst,explore,iosm_verifier,full \
  --max-parallel 2 \
  --depends 3>1,4>2 \
  --locks schema,config \
  --worktree \
  Improve auth reliability and performance with verification gates
```

Track and resume delegated execution with `/subagent-runs`, `/subagent-resume`, `/team-runs`, and `/team-status`.

## Core Commands

| Goal | Command |
|------|---------|
| Start fresh session | `/new` or `/clear` |
| Set auth | `/login` or `/auth` |
| Pick model | `/model` |
| Diagnose setup | `/doctor` |
| Manage MCP servers | `/mcp` |
| Manage session memory | `/memory` |
| Save/restore state | `/checkpoint` / `/rollback` |
| Manage settings | `/settings` |

## IOSM In One Line

**IOSM** gives you a repeatable loop for improving codebases with explicit quality gates, metrics, and artifact history instead of one-off AI edits.

Quick start:

```bash
iosm init
iosm cycle plan "reduce API latency" "simplify auth module"
iosm cycle status
iosm cycle report
```

## Documentation

Use the docs as the source of truth for details.

| Topic | Link |
|------|------|
| Getting started | [docs/getting-started.md](./docs/getting-started.md) |
| CLI flags and options | [docs/cli-reference.md](./docs/cli-reference.md) |
| Interactive mode (commands, keys, profiles) | [docs/interactive-mode.md](./docs/interactive-mode.md) |
| IOSM init/cycles | [docs/iosm-init-and-cycles.md](./docs/iosm-init-and-cycles.md) |
| MCP, providers, settings | [docs/configuration.md](./docs/configuration.md) |
| Orchestration and subagents | [docs/orchestration-and-subagents.md](./docs/orchestration-and-subagents.md) |
| Extensions, packages, themes | [docs/extensions-packages-themes.md](./docs/extensions-packages-themes.md) |
| Sessions, traces, export | [docs/sessions-traces-export.md](./docs/sessions-traces-export.md) |
| JSON/RPC/SDK usage | [docs/rpc-json-sdk.md](./docs/rpc-json-sdk.md) |
| Full docs index | [docs/README.md](./docs/README.md) |
| Full IOSM specification | [iosm-spec.md](./iosm-spec.md) |

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Contributing guide: [CONTRIBUTING.md](./CONTRIBUTING.md)

## License

[MIT](./LICENSE) © 2026 Emil Rokossovskiy

<p align="center">
  <sub>Built for teams that treat AI coding as an engineering system, not a chat.</sub>
</p>

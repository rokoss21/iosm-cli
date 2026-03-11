<h1 align="center">IOSM CLI v0.2.2</h1>

<p align="center">
  <strong>AI Engineering Runtime for Professional Developers</strong>
</p>
<p align="center">
  Interactive coding agent · IOSM methodology · MCP · Semantic Search · Checkpoints · Subagent orchestration · Extensions
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
- primary operating profiles: **full** (default), **meta** (orchestration-first), and **iosm** (advanced, methodology-driven engineering cycles)
- swarm-first orchestration for complex tasks: `Scopes -> Touches -> Locks -> Gates -> Done`, continuous dispatch, retries, checkpoints
- built-in semantic embeddings search (`semantic_search` tool + `/semantic` + `iosm semantic`)
- repeatable codebase improvement workflows via **IOSM** (Improve -> Optimize -> Shrink -> Modularize)
- auditable artifact history for cycles, decisions, and metric evolution across runs
- operational controls for safe iteration (`/checkpoint`, `/rollback`, `/doctor`, `/memory`)
- extensibility for teams (MCP + extensions) and embedding (SDK + JSON/RPC modes)

Adoption path is layered: start in **full** profile for low-friction daily usage, switch to **meta** when tasks benefit from adaptive multi-agent orchestration, then use **iosm** profile when you need advanced IOSM cycles, metrics, and governance.

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
- teams that need adaptive multi-agent execution with strict verification closure via **meta** profile
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
- `/login` now includes the full `models.dev` provider catalog; `/model` loads available models for authenticated providers

### Recommended CLI Toolchain (for maximum efficiency)

`iosm-cli` ships managed fallback for `rg` and `fd`, but best performance comes from system-installed tooling, especially for large repos.

Tools used by advanced search/analysis workflows:
- `rg`, `fd`, `ast-grep` (`sg`), `comby`, `jq`, `yq`, `semgrep`, `sed`

macOS (Homebrew):
```bash
brew install ripgrep fd ast-grep comby jq yq semgrep
```

Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install -y ripgrep fd-find jq yq sed

# optional but recommended:
# semgrep: pipx install semgrep
# ast-grep: npm i -g @ast-grep/cli
# comby: see https://comby.dev/docs/installation
```

Check availability quickly:
```bash
iosm
/doctor
```

## 60-Second Start

```bash
# 1) Open project and start CLI
cd /path/to/repo
iosm
```

Inside the session (full profile):
```text
/login            # or /auth: configure credentials (OAuth + API key providers from models.dev)
/model            # select active provider/model from currently authenticated providers
<your task>       # start working immediately
```

When you need advanced IOSM workflow:
```text
Shift+Tab         # switch profile to iosm
/init             # bootstrap IOSM workspace
/iosm 0.95 --max-iterations 5
```

Core commands to unlock full runtime value:
- direct prompt to main agent — default for simple tasks (single-agent flow)
- `/orchestrate` — manual legacy multi-agent orchestration (explicit team-run control)
- `/swarm` — recommended multi-agent orchestration runtime for complex/risky changes (`run`, `from-singular`, `watch`, `retry`, `resume`)
- `/init` + `/iosm` — execute measurable IOSM cycles with artifacts and quality gates
- `/mcp` — connect external tool ecosystems in interactive UI
- `/semantic` — configure semantic provider, build/rebuild embeddings index, run meaning-based retrieval
- `/memory` — persist project facts and constraints across sessions

## Real-World Example: Swarm-First IOSM Refactor

```console
$ iosm
IOSM CLI v0.2.2 [full]

you> /singular Refactor auth and split session handling from token validation
iosm> Option 1 selected
iosm> Start with Swarm (Recommended)
iosm> /swarm from-singular 2026-03-10-210201 --option 1
iosm> Swarm run started: swarm_1741632000000_ab12cd
iosm> status: running (ready/running/blocked/done visible via /swarm watch)
iosm> Touches -> Locks -> Gates pipeline completed
iosm> integration report written to .iosm/orchestrate/swarm_1741632000000_ab12cd/reports/

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

For plain-language execution without `/singular`:

```bash
/swarm run "Refactor auth and reduce integration risk" --max-parallel 3 --budget-usd 12
```

## Architecture Overview

`IOSM CLI` is layered so execution stays controllable as task complexity grows:

```text
Providers (built-ins + full models.dev catalog)
   ↓
Auth + Model Selection (/login, /model)
   ↓
Agent Runtime (interactive + JSON + JSON-RPC + SDK)
   ↓
Tooling Layer (read/edit/bash + search/structural/data/security tools + MCP tools)
   ↓
Swarm Runtime (/swarm run|from-singular|watch|retry|resume)
   ↓
IOSM Layer (/init, /iosm cycles, metrics, governance)
   ↓
Artifacts + Memory (.iosm/cycles/*, checkpoints, /memory state)
```

## Design Principles

- **AI executes structured engineering loops, not ad hoc chats.** Core flow for risky tasks is ` /singular -> /contract -> /swarm -> /iosm `.
- **Complex work needs controlled execution.** Swarm applies `Scopes -> Touches -> Locks -> Gates -> Done` with continuous dispatch and bounded retries.
- **Refactoring must be measurable.** IOSM cycles capture baseline, hypotheses, and metric deltas instead of untracked edits.
- **Every important run must be auditable.** Artifacts and memory preserve decisions and outcomes across sessions.
- **Adoption should be progressive.** Start in `full` profile for speed, use `meta` for orchestration-first execution, and move to `iosm` for advanced cycles and governance when needed.

## Operating Profiles

`IOSM CLI` has a layered operating model:

| Profile | Best For | What `/init` Does | Advanced Command |
|------|----------|-------------------|------------------|
| **full** (default) | Daily coding for any level | Generates/updates `AGENTS.md` from real repo scan and prepares `.iosm/agents/` | Use `/swarm` (canonical) and built-in tools directly |
| **meta** (orchestration-first) | Adaptive agent/delegate execution with verification gates | Same initialization behavior as full profile | `iosm --profile meta` |
| **iosm** (advanced) | High-risk refactors and system-level engineering loops | Bootstraps full IOSM workspace (`iosm.yaml`, `IOSM.md`, `.iosm/cycles/...`) with optional agent verification | `/iosm [target-index] [--max-iterations N] [--force-init]` |

Typical advanced flow:

```bash
iosm --profile iosm
/init
/iosm 0.95 --max-iterations 5
```

## Swarm-First Execution

For complex/risky work, use the canonical swarm runtime instead of one monolithic prompt.

Default routing rule:
- simple tasks -> direct prompt to one agent
- manual legacy multi-agent split -> `/orchestrate`
- complex/risky changes (multi-agent orchestration level) -> `/swarm`

`/swarm` supports:
- contract-bound execution (run blocks until effective `/contract` exists)
- run-level parallel workers via `--max-parallel` (1..20)
- continuous dispatch over DAG tasks (ready -> locks -> gates -> checkpoint)
- intra-task parallelism: one swarm task can fan out to delegated subagents (up to 10) when beneficial
- run-scoped shared memory (`shared_memory_write` / `shared_memory_read`) across tasks and delegates that share the same `run_id`
- standalone `task` executions auto-generate internal `run_id/task_id`, enabling shared memory for root + delegates without manual IDs
- hierarchical touches-based locking and lock downgrade
- task gates + run gates separation
- retries by taxonomy (`permission`, `dependency/import`, `test`, `timeout`, `unknown`)
- checkpoints/recovery (`/swarm resume`) and focused retries (`/swarm retry`)
- scheduler guards (`progress heuristic` + `conflict density guard`) for stable throughput under contention
- high-risk spawn candidates require explicit confirmation during run

Example:

```bash
/swarm run "Improve auth reliability and performance with verification gates" \
  --max-parallel 3 \
  --budget-usd 15
```

Bridge from decision mode:

```bash
/singular "Refactor auth and split session handling from token validation"
# choose option -> Start with Swarm (Recommended)
```

## Core Commands

| Workflow Step | Command | Why It Matters |
|------|---------|----------------|
| Start clean context | `/new` or `/clear` | Reset session state before a new task or after context drift |
| Configure auth | `/login` or `/auth` | Set OAuth/API key credentials with guided flow from full models.dev provider catalog |
| Select active model | `/model` | Choose provider/model from available authenticated providers |
| Launch controlled execution | `/swarm run ...` | Execute complex tasks with contract boundaries, locks, gates, retries, and checkpoints |
| Bridge decision to execution | `/swarm from-singular ...` | Apply selected `/singular` option under effective contract policy |
| Legacy orchestration | `/orchestrate --parallel ...` | Keep previous team-run flow when you explicitly need legacy semantics |
| Initialize IOSM workspace | `/init` | Bootstrap/update IOSM files and cycle workspace |
| Run IOSM cycle | `/iosm [target-index] [--max-iterations N]` | Execute measurable improve/verify loops with artifact output |
| Track swarm runs | `/swarm watch`, `/swarm resume`, `/swarm retry` | Observe state, resume checkpoints, and recover failed tasks |
| Manage MCP servers | `/mcp` | Inspect/add/enable external tool servers interactively |
| Manage semantic search | `/semantic` | Configure provider with auto model discovery (OpenRouter/Ollama), index codebase, query by intent/meaning |
| Define engineering contract | `/contract` | Field-by-field interactive contract editor with auto-save and automatic JSON generation |
| Analyze feasibility variants | `/singular <feature request>` | Runs baseline + standard agent pass, then returns 3 implementation options and recommendation |
| Manage memory | `/memory` | Add/edit/remove persistent project facts and constraints |
| Save/restore state | `/checkpoint` / `/rollback` | Safe experimentation with fast rollback |
| Diagnose runtime | `/doctor` | Verify model/auth/MCP/resources when behavior is inconsistent |
| Manage settings | `/settings` | Tune runtime defaults and operational preferences |

## Decision Workflow: `/contract` + `/singular`

### `/contract` (interactive contract manager)

- No manual JSON editing in terminal.
- You edit fields directly (`goal`, `scope_include`, `scope_exclude`, `constraints`, `quality_gates`, `definition_of_done`, `risks`, and additional planning fields).
- Press `Enter` on a field value and it is saved immediately.
- Contract JSON is built automatically.

Key manager actions:
- `Open effective contract` = read merged runtime contract (`project + session`).
- `Edit session contract` = temporary overlay for current session only.
- `Edit project contract` = persistent baseline in `.iosm/contract.json`.

### `/singular <request>` (feature feasibility analyzer)

- Command-first flow: write request, run analysis, receive decision options.
- Uses standard agent-style repository run (not static form output), then merges with baseline repository scan.
- Produces exactly 3 options:
  - `Option 1`: practical implementation path (usually recommended).
  - `Option 2`: alternative strategy with different trade-offs.
  - `Option 3`: defer/do-not-implement-now path.
- Each option includes affected files, step-by-step plan, risks, and when-to-choose guidance.
- User selects `1/2/3`, then chooses `Start with Swarm` or `Continue without Swarm`.
- `Start with Swarm` executes selected option via `/swarm from-singular ...` under effective `/contract`.

Legacy note:
- `/blast` and `/shadow` are removed from active workflow.
- Use `/singular` for feasibility decisions and `/contract` for engineering constraints.

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
| Full IOSM specification (local) | [iosm-spec.md](./iosm-spec.md) |
| IOSM methodology spec (canonical) | [github.com/rokoss21/IOSM](https://github.com/rokoss21/IOSM) |

## Related Repositories

| Repository | Description |
|------------|-------------|
| [IOSM](https://github.com/rokoss21/IOSM) | Canonical IOSM v1.0 specification, schemas, artifact templates, and validation scripts |
| [iosm-cli](https://github.com/rokoss21/iosm-cli) | This repo — CLI runtime that implements the IOSM methodology as an engineering agent |

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

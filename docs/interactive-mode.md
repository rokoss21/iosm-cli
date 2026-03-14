# Interactive Mode

Interactive mode is the default experience when running `iosm` without `-p` or `--mode` flags. It provides a rich multi-turn terminal session with persistent history, model switching, and keyboard-driven controls.

## Starting Interactive Mode

```bash
# Default
iosm

# With specific model
iosm --model sonnet:high

# With profile
iosm --profile plan

# Continue previous session
iosm --continue
```

## Core UX

- Multi-turn conversation with persistent session history
- Keyboard-driven controls for model, profile, and queue management
- Live tool execution rendering with expandable output
- Pending message queue for follow-up prompts
- Task plan visualization and progress tracking
- Streaming responses with interrupt/steer capability

---

## Slash Commands

### Session Lifecycle

| Command | Description | Example |
|---------|-------------|---------|
| `/new` | Start a new session | `/new` |
| `/clear` | Alias for `/new` | `/clear` |
| `/resume` | Open session picker | `/resume` |
| `/fork` | Branch from a previous message | `/fork` |
| `/tree` | Navigate the session tree | `/tree` |
| `/checkpoint` | Save a rollback checkpoint (`/checkpoint list`) | `/checkpoint before-refactor` |
| `/rollback` | Roll back to latest/named/indexed checkpoint | `/rollback 2` |
| `/name` | Set session display name | `/name refactoring-auth` |
| `/session` | Session info | `/session` |
| `/quit` | Exit the application | `/quit` |

### Model & Runtime

| Command | Description | Example |
|---------|-------------|---------|
| `/model` | Open provider-first model selector (`provider -> model`) | `/model` |
| `/scoped-models` | Manage model rotation | `/scoped-models` |
| `/mcp` | Open MCP manager UI and run MCP subcommands | `/mcp` |
| `/semantic` | Open semantic search manager (`setup/auto-index/status/index/rebuild/query`) | `/semantic` |
| `/contract` | Interactive engineering contract editor (field-by-field, auto JSON build) | `/contract` |
| `/singular` | Feature feasibility analyzer with implementation options and recommendation | `/singular add account dashboard` |
| `/swarm` | Recommended multi-agent orchestration runtime for complex/risky tasks (`run`, `from-singular`, `watch`, `retry`, `resume`) | `/swarm run refactor auth module --max-parallel 3` |
| `/memory` | Interactive memory manager (`add/edit/remove/scope/path`) | `/memory` |
| `/settings` | View/modify settings | `/settings` |
| `/hotkeys` | View keyboard shortcuts | `/hotkeys` |
| `/changelog` | View recent changes | `/changelog` |

### IOSM & Planning

| Command | Description | Example |
|---------|-------------|---------|
| `/init` | Bootstrap IOSM workspace | `/init` |
| `/iosm` | Run full IOSM cycle | `/iosm 0.95 --max-iterations 5` |
| `/cycle-plan` | Plan a new cycle | `/cycle-plan reduce latency` |
| `/cycle-status` | Check cycle progress | `/cycle-status` |
| `/cycle-report` | View cycle report | `/cycle-report` |
| `/cycle-list` | List all cycles | `/cycle-list` |

### Orchestration & Agents

| Command | Description | Example |
|---------|-------------|---------|
| `/swarm` | Swarm-first multi-agent orchestration runtime for complex/risky work | `/swarm run refactor auth and token flow` |
| `/orchestrate` | Manual legacy multi-agent orchestration (explicit agent splitting) | See below |
| `/agents` | Inspect custom/system agents | `/agents` |
| `/subagent-runs` | List subagent run history | `/subagent-runs` |
| `/subagent-resume` | Resume a subagent run | `/subagent-resume run-123` |
| `/team-runs` | List team orchestration runs | `/team-runs` |
| `/team-status` | Check team run status | `/team-status team-456` |

### System Actions

| Command | Description | Example |
|---------|-------------|---------|
| `/export` | Export session to HTML | `/export` |
| `/share` | Share via GitHub Gist | `/share` |
| `/copy` | Copy last response to clipboard | `/copy` |
| `/doctor` | Run diagnostics for model/auth/MCP/hooks/resources | `/doctor` |
| `/compact` | Compact conversation context | `/compact` |
| `/reload` | Reload extensions and resources | `/reload` |
| `/permissions` | View/set tool permissions | `/permissions` |
| `/yolo` | Toggle auto-approve mode | `/yolo on` |
| `/login` | Authenticate with provider (OAuth + API key providers from full models.dev catalog) | `/login` |
| `/auth` | Alias for `/login` | `/auth` |
| `/logout` | Clear saved provider credentials | `/logout` |

`/mcp add` without flags starts a guided wizard in the terminal UI.
`/semantic` opens an interactive setup/status/index/query manager for embeddings search.
Manager includes `Automatic indexing` toggle (default `on`) to control query-time auto-refresh.
`/semantic setup` now auto-loads model catalogs for OpenRouter (`/api/v1/embeddings/models`) and Ollama (`/api/tags`) with manual fallback.
In `/semantic setup`, the headers step is optional: press `Enter` on empty input to skip.
`/memory` opens an interactive manager. `/memory <text>` saves a note to `memory.md` and reloads session context. Use `/memory edit <index> <text>` for direct updates.
`/contract` edits contract fields interactively (`goal`, scope, constraints, quality gates, DoD, risks, etc.), then writes JSON automatically.
`/singular <request>` runs a two-pass feasibility analysis (baseline scan + standard agent pass), builds concrete implementation options, then prompts `Start with Swarm` / `Continue without Swarm` / `Cancel`.
`/swarm` enforces `Scopes -> Touches -> Locks -> Gates -> Done`. If effective contract is missing, it blocks execution and opens a bootstrap menu (auto-draft, guided Q&A, or manual `/contract` editor).
`/orchestrate --parallel` defaults `--max-parallel` to `--agents` when omitted and auto-selects `meta` workers when profiles are not explicitly set (outside read-only host contexts).
For orchestrate assignments, `delegate_parallel_hint` is carried into child task calls; high hints should trigger nested delegate fan-out or explicit `DELEGATION_IMPOSSIBLE`.
`/blast` and `/shadow` are removed from active interactive workflow.

### `/contract` Detailed Guide

`/contract` is a layered contract editor with two sources and one merged output:

| Layer | Scope | Persistence | Storage |
|------|-------|-------------|---------|
| `project` | Project-wide baseline | Persistent | `.iosm/contract.json` |
| `session` | Current session override | Temporary | In-memory session overlay |
| `effective` | `project + session` merged result | Derived | Computed at runtime |

Important merge rule:
- `session` overrides `project` for the same keys.
- `effective` is what the runtime actually uses.

#### Quick Difference: Effective vs Session vs Project

- `Open effective contract` is read-only and shows what runtime is enforcing right now.
- `Edit session contract` changes only this session (temporary overlay, not persisted to disk).
- `Edit project contract` changes `.iosm/contract.json` (persistent baseline for future sessions).

#### Manager Actions

| Action | What it does | When to use |
|------|---------------|-------------|
| `Open effective contract` | Shows the merged JSON currently enforced by runtime | Verify final active constraints |
| `Edit session contract` | Edits temporary overrides for current session | Experiments, one-off constraints |
| `Edit project contract` | Edits persistent project contract file | Team-wide stable defaults |
| `Copy effective -> session` | Saves merged state into session layer | Freeze current merged state for this run |
| `Copy effective -> project` | Saves merged state into project file | Promote temporary decisions to baseline |
| `Delete session contract` | Clears temporary overlay | Reset session overrides |
| `Delete project contract` | Removes `.iosm/contract.json` | Full baseline reset |

#### Field Editor Behavior

- Select a field and press `Enter`.
- Input text (single-line or multi-line list depending on field type).
- Press `Enter` to submit.
- Change is saved immediately to selected scope (`session` or `project`).
- Empty input clears that field.

There is no separate "Save" step in field editor mode.

#### Common Workflows

1. Temporary tightening for one run:
   - Open `/contract`
   - `Edit session contract`
   - Set `constraints` and `quality_gates`
   - Confirm via `Open effective contract`

2. Promote temporary policy to project baseline:
   - Open `/contract`
   - `Copy effective -> project`
   - Review `.iosm/contract.json` in VCS

3. Recover from aggressive temporary overrides:
   - Open `/contract`
   - `Delete session contract`
   - Re-open `effective` and verify fallback to `project`

### `/singular` Detailed Guide

`/singular` is a command-first feasibility mode (no pre-menu).  
Pattern: `/singular <feature request>`

Examples:
- `/singular add account dashboard`
- `/singular introduce RBAC for API`
- `/singular redesign billing reconciliation flow`

#### What Happens Internally

1. Baseline repository pass:
   - Scans project files and estimates baseline complexity/blast radius.
   - Collects likely impacted files and contract signals.

2. Standard agent feasibility pass:
   - Launches an isolated standard agent run (`plan` profile) with repository tools.
   - Agent inspects real files and returns structured feasibility JSON.
   - Produces recommendation, impact analysis, and implementation variants.

3. Merge + persistence:
   - Agent insights are merged with baseline data.
   - Analysis is saved to `.iosm/singular/<run-id>/analysis.json` (+ `meta.json`).

#### Output Shape

Each run includes:
- `recommendation`: `implement_now | implement_incrementally | defer`
- `reason`: why this recommendation is best for current stage
- `complexity` and `blast_radius`
- `stage_fit`: `needed_now | optional_now | later`
- `impact_analysis`: codebase, delivery, risks, operations
- `implementation_options` (exactly 3 variants):
  - Option 1: practical/recommended path
  - Option 2: alternative approach
  - Option 3: defer / do not implement now

Each option includes:
- summary and trade-offs (`pros`/`cons`)
- concrete file targets (`suggested_files`)
- step-by-step plan (`plan`)
- `when_to_choose` guidance

#### Decision Flow

After analysis, selector opens with variants:
- choose Option 1 / Option 2 / Option 3
- or close without decision

If Option 1 or 2 is selected, execution mode prompt opens:
- `Start with Swarm (Recommended)` -> runs `/swarm from-singular <run-id> --option <n>`
- `Continue without Swarm` -> inserts execution draft into editor (ready to run)
- `Cancel` -> exits without changes

If Option 3 is selected, run is explicitly marked as postponed.

#### Fallback Behavior

If no model is selected (or agent pass fails), `/singular` still returns a heuristic baseline analysis.  
Use `/model` to enable full agent feasibility pass.

#### Command Migration

- `/singular` is the feasibility command to use.
- `/blast` is deprecated/removed.
- `/shadow` is removed.

### `/swarm` Detailed Guide

Canonical commands:
- `/swarm run <task> [--max-parallel N] [--budget-usd X]`
- `/swarm from-singular <run-id> --option <1|2|3> [--max-parallel N] [--budget-usd X]`
- `/swarm watch [run-id]`
- `/swarm retry <run-id> <task-id> [--reset-brief]`
- `/swarm resume <run-id>`

Execution note:
- Run-level `--max-parallel` supports `1..20`.
- A single swarm task can use delegated intra-task subagents in parallel (up to 10) when decomposition is beneficial.
- Shared memory tools (`shared_memory_write` / `shared_memory_read`) are available to tasks/delegates that share a `run_id`.
- Standalone `task` calls auto-generate internal `run_id/task_id`, so shared-memory collaboration still works for root + delegates.

Runtime artifacts:
- `.iosm/orchestrate/<run-id>/run.json`
- `.iosm/orchestrate/<run-id>/dag.json`
- `.iosm/orchestrate/<run-id>/state.json`
- `.iosm/orchestrate/<run-id>/events.jsonl`
- `.iosm/orchestrate/<run-id>/checkpoints/latest.json`
- `.iosm/orchestrate/<run-id>/reports/*`

`/swarm watch` includes:
- current state and task breakdown
- budget and warning state
- ETA ticks and throughput
- critical path and theoretical speedup
- lock snapshot and bottleneck tasks

`/orchestrate --swarm` was removed. Use `/swarm ...` directly.

---

## Keyboard Shortcuts

### Application Controls

| Key | Action |
|-----|--------|
| `Esc` | Interrupt current agent run |
| `Ctrl+C` | Clear input or app-level clear |
| `Ctrl+D` | Exit the application |
| `Ctrl+Z` | Suspend process |

### Model & Profile

| Key | Action |
|-----|--------|
| `Shift+Tab` | Cycle profile (full → plan → iosm → meta) |
| `Shift+Ctrl+T` | Cycle thinking level |
| `Ctrl+P` | Next model in rotation |
| `Shift+Ctrl+P` | Previous model in rotation |
| `Ctrl+L` | Open model selector |

### UI Controls

| Key | Action |
|-----|--------|
| `Ctrl+O` | Expand/collapse tool output details |
| `Ctrl+T` | Toggle thinking panel |
| `Ctrl+G` | Open external editor for input |

### Input & Queue

| Key | Action |
|-----|--------|
| `Ctrl+Enter` | Steer while streaming (macOS: `Ctrl+\\`) |
| `Alt+Enter` | Queue follow-up message |
| `Alt+Up` | Dequeue/edit queued draft |
| `Ctrl+V` | Paste image (Windows: `Alt+V`) |

### Customization

Override keybindings by creating `~/.iosm/agent/keybindings.json`:

```json
{
  "Ctrl+P": "nextModel",
  "Ctrl+Shift+P": "previousModel",
  "Ctrl+L": "openModelSelector"
}
```

---

## Profiles

Profiles change the agent's behavior, available tools, and system prompt:

### Main Profiles (switchable via `Shift+Tab`)

| Profile | Tools | Use Case |
|---------|-------|----------|
| `full` | All built-ins (read, bash, edit, write, git_write, fs_ops, grep, find, ls, rg, fd, ast_grep, comby, jq, yq, semgrep, sed, semantic_search, fetch, web_search, git_read) | Default development work |
| `plan` | Read-only bundle (read, grep, find, ls, rg, fd, ast_grep, comby, jq, yq, semgrep, sed, semantic_search, fetch, web_search, git_read) | Architecture planning, code review |
| `iosm` | All + IOSM context | IOSM cycle execution with artifact sync |
| `meta` | Full toolset + orchestration-first contract | Adaptive multi-agent/delegate execution with verification closure |

> `meta` profile recommendation: use modern high-capability models with large context windows (`>=128k`, ideally `>=200k`) and high output limits.  
> This directly impacts orchestration quality (delegate fan-out, constraint retention, and final synthesis reliability).

### Advanced Profiles (via `--profile` or orchestration)

| Profile | Use Case |
|---------|----------|
| `explore` | Exploratory codebase analysis |
| `iosm_analyst` | Deep metric analysis and reporting |
| `iosm_verifier` | Verify cycle results and quality gates |
| `cycle_planner` | Plan and structure IOSM cycles |

### Example: Planning Workflow

```bash
# Start in plan mode for analysis
iosm --profile plan

# In the session:
# "Analyze the authentication module and propose a migration plan to OAuth 2.0"

# Switch to full mode for implementation (Shift+Tab)
# "Implement phase 1 of the OAuth migration"
```

---

## Streaming Input Modes

While a response is streaming, you can interact with it:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Steer** | `Ctrl+Enter` | Interrupt and redirect immediately |
| **Follow-up** | `Alt+Enter` | Queue message for after completion |
| **Meta** | Adaptive | Soft update at boundary checkpoints |

### Example: Steering

```
Agent: [streaming a long analysis of the codebase...]

You: (Ctrl+Enter) Focus specifically on the database layer
# Agent immediately redirects to database analysis
```

### Example: Follow-up Queue

```
Agent: [streaming response...]

You: (Alt+Enter) Also check for N+1 query issues
You: (Alt+Enter) And suggest indexing improvements
# Both messages will be processed after the current response
```

---

## Workflow Examples

### Code Review Session

```bash
iosm --profile plan --tools read,grep,find,ls

# "Review src/core/ for code quality issues, focusing on error handling"
# "Check for any security vulnerabilities in the auth module"
# "Generate a summary of findings sorted by severity"
```

### Debugging Session

```bash
iosm --model sonnet:high

# "The checkout API returns 500 errors intermittently. Help me debug."
# Agent will use bash, read, grep to investigate
# "Run the failing test with verbose output"
# "Apply the fix and verify all tests pass"
```

### IOSM Improvement Cycle

```bash
iosm --profile iosm

# "/init" (first time)
# "/cycle-plan reduce API response time"
# "Analyze the current baseline and create hypothesis cards"
# "Execute the Improve phase focusing on query optimization"
# "/cycle-status"
```

### Multi-Agent Orchestration

```bash
iosm

# "Launch 3 parallel agents to:
#  1. Audit auth module security
#  2. Review database query performance  
#  3. Check API contract compliance"

# Or via slash command:
/orchestrate --parallel --agents 3 \
  --profiles explore,explore,iosm_verifier \
  Audit security, performance, and contracts
```

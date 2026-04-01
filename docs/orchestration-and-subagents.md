# Orchestration & Subagents

`iosm-cli` now uses a **swarm-first** execution model for complex/risky changes.

Canonical path:
- `/singular` -> choose option
- effective `/contract` applied (or bootstrap required)
- `/swarm` execution runtime
- optional `/iosm` optimization loop

Core consistency model:
- **Scopes -> Touches -> Locks -> Gates -> Done**

---

## User-Level Entry Points

### 1. Decision-first flow (recommended)

```bash
/singular "Refactor auth and split session handling from token validation"
# choose Option 1/2/3
# choose Start with Swarm (Recommended)
```

### 2. Direct swarm execution

```bash
/swarm run "Refactor auth and reduce integration risk" --max-parallel 3 --budget-usd 12
```

### 3. Agent mention / delegated tasks

```text
@security-auditor Review the authentication module for vulnerabilities
```

---

## `/swarm` Command Surface

### Syntax

```bash
/swarm run <task> [--max-parallel N] [--budget-usd X]
/swarm from-singular <run-id> --option <1|2|3> [--max-parallel N] [--budget-usd X]
/swarm watch [run-id]
/swarm retry <run-id> <task-id> [--reset-brief]
/swarm resume <run-id>
/swarm help
```

### Notes

- `/swarm` will not execute without an effective `/contract`.
- Run-level `--max-parallel` supports `1..20`.
- Within a single swarm task, the execution agent can fan out delegated subagents in parallel (up to 10) when the subtask is decomposable.
- Tasks/delegates with the same `run_id` can exchange intermediate state via `shared_memory_write` / `shared_memory_read`.
- Standalone `task` calls without explicit `run_id` use an internal run/task id, so shared memory still works inside that task execution (root + delegates).
- If contract is missing, bootstrap menu is blocking:
  - `Auto-draft from task (Recommended)`
  - `Guided Q&A`
  - `Open manual /contract editor`
- Medium/large repositories use Project Index planning by default.
- Semantic index is optional enrichment; when stale/missing, swarm continues with guided recommendations.
- Scheduler guards are enabled by default:
  - `progress heuristic` (prioritizes high-impact tasks when progress stalls)
  - `conflict density guard` (reduces parallelism under heavy touch overlap)
- High-risk spawn candidates require confirmation (approve/reject/abort run).

---

## Command Separation

- Use direct prompt to the main agent for simple tasks.
- Use legacy `/orchestrate ...` when you explicitly want manual multi-agent splitting with old team-run semantics.
- Use canonical `/swarm ...` as multi-agent orchestration runtime for complex/risky work.
- `/orchestrate --swarm` was removed to avoid command ambiguity.

---

## Runtime Artifacts

Swarm run artifacts are written to:

```text
.iosm/orchestrate/<run-id>/
├── run.json
├── dag.json
├── state.json
├── events.jsonl
├── checkpoints/
│   └── latest.json
└── reports/
    ├── integration_report.md
    ├── gates.json
    └── shared_context.md
```

Swarm run history is native to `/swarm` commands (`watch`, `retry`, `resume`), not mirrored into legacy team-run storage.

---

## Visibility & Recovery

### Watch

```bash
/swarm watch [run-id]
```

Shows live snapshot fields:
- run status
- ready/running/blocked/done/error counts
- budget usage and 80% warning state
- locks and current touches map
- ETA ticks, throughput per tick, critical path estimate, theoretical speedup, and top bottleneck tasks

### Retry

```bash
/swarm retry <run-id> <task-id> [--reset-brief]
```

- retries one failed/blocked task under retry taxonomy
- optional `--reset-brief` lets you edit task brief before retry

### Resume

```bash
/swarm resume <run-id>
```

Resumes from checkpoint + snapshot state.

---

## Legacy `/orchestrate` (non-swarm)

Legacy orchestration remains available for existing workflows:

```bash
/orchestrate --parallel --agents 3 \
  --profiles explore,full,iosm_verifier \
  --cwd .,src,.iosm \
  Analyze security, optimize performance, verify IOSM compliance
```

`/orchestrate` parallel defaults in current runtime:
- if `--max-parallel` is omitted, it defaults to `--agents` (bounded by runtime limit)
- if worker profiles are omitted, parallel assignments default to `meta` in non-read-only host contexts
- assignments include `delegate_parallel_hint`; when hint is high, child tasks are expected to fan out with nested delegates (or emit explicit `DELEGATION_IMPOSSIBLE: <reason>`)

Use legacy mode when you explicitly need old team-run semantics.

---

## Custom Agents

### Defining Custom Agents

Create markdown files in `.iosm/agents/`:

```markdown
---
name: security-auditor
description: Specialized security vulnerability analysis
tools:
  - read
  - git-read
disallowed_tools:
  - write
---

You are a security auditor specializing in web application security.

Your responsibilities:
1. Review code for OWASP Top 10 vulnerabilities
2. Check authentication and authorization flows
3. Identify secrets exposure risks
4. Validate input sanitization
5. Check for SQL injection, XSS, CSRF vectors

Always provide:
- Severity rating (Critical/High/Medium/Low)
- Specific file and line references
- Recommended fixes with code examples
```

### Using Custom Agents

```bash
# Reference by name in chat
@security-auditor Review the login flow

# View all available agents
/agents
```

Built-in system agents remain available; inspect via `/agents`.

### Tool List Normalization in Agent Frontmatter

For custom agent frontmatter fields `tools` and `disallowed_tools`, runtime applies compatibility normalization:

- trims whitespace
- lowercases names
- converts `-` to `_` (for example `git-read` -> `git_read`)
- drops unknown tool names and records diagnostics

This keeps old/frontmatter variants compatible while preventing invalid tool names from breaking delegation.

---

## Safety Guidance

- Use `/contract` to lock execution scope before running swarm.
- Prefer `/singular` when scope/impact is unclear.
- Use `/swarm watch` frequently on medium/high-risk runs.
- Use `/checkpoint`/`/rollback` before broad refactors.
- Follow up with `/iosm` for measurable post-change quality improvements.

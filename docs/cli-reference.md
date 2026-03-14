# CLI Reference

Complete reference for all `iosm-cli` command-line options and subcommands.

## Usage

```bash
iosm [options] [@files...] [messages...]
```

## Top-Level Commands

### `iosm init`

Initialize IOSM workspace for a project.

```bash
iosm init [path] [--force] [--agent-verify|--no-agent-verify]
```

| Flag | Description |
|------|-------------|
| `path` | Target project directory (default: current directory) |
| `--force` | Re-initialize even if workspace exists |
| `--agent-verify` | Run post-init agent verification (default) |
| `--no-agent-verify` | Skip post-init verification |

**Examples:**

```bash
iosm init                        # Initialize current directory
iosm init ../backend             # Initialize another project
iosm init --force                # Force re-initialization
iosm init --no-agent-verify      # Skip verification step
```

### `iosm cycle`

IOSM cycle management subcommands.

```bash
iosm cycle <subcommand>
```

| Subcommand | Description |
|------------|-------------|
| `list` | List all known cycles |
| `plan [--id <id>] [--force] <goal...>` | Create a new cycle with goals |
| `report [cycle-id]` | Print cycle report (JSON) |
| `status [cycle-id]` | Print human-readable gate summary |

**Examples:**

```bash
iosm cycle list
iosm cycle plan "reduce latency" "simplify auth"
iosm cycle plan --id cycle-q1-2026 --force "modernize API"
iosm cycle report
iosm cycle report cycle-q1-2026
iosm cycle status
```

### `iosm install / remove / update / list`

Package management for extensions, skills, themes.

```bash
iosm install <source> [-l|--local]
iosm remove <source> [-l|--local]
iosm update [source]
iosm list
```

**Source formats:**

| Format | Example |
|--------|---------|
| npm | `npm:@scope/name@version`, `npm:my-extension` |
| git | `git:github.com/user/repo@ref`, `https://github.com/user/repo` |
| local | `./path/to/extension`, `/absolute/path` |

**Examples:**

```bash
iosm install npm:@my-org/iosm-security-tools
iosm install git:github.com/user/custom-theme@main
iosm install ./local-extension -l            # Project-local
iosm remove npm:@my-org/iosm-security-tools
iosm update                                   # Update all
iosm list                                     # List installed
```

### `iosm config`

View and manage configuration.

```bash
iosm config
```

### `iosm semantic`

Semantic index management for meaning-based retrieval.

```bash
iosm semantic help
iosm semantic status
iosm semantic index
iosm semantic rebuild
iosm semantic query "<text>" [--top-k N]
```

Notes:
- If semantic config is missing, the command prints actionable paths and suggests `/semantic setup`.
- `query` auto-refreshes stale indexes only when `semanticSearch.autoIndex=true` (default is `true`).
- When auto-index is off, run `iosm semantic index` (or `rebuild` for provider/chunk/filter changes).

### Interactive feasibility/contract commands

These commands run inside interactive mode (`iosm`), not as top-level CLI subcommands:

- `/contract` — interactive engineering contract manager:
  - edit fields one-by-one
  - autosave on `Enter`
  - auto-build `.iosm/contract.json` for project scope
- `/singular <feature request>` — command-first feasibility analyzer:
  - baseline repository scan + standard agent pass
  - outputs exactly 3 implementation options with recommendation
  - lets user choose option `1/2/3`, then `Start with Swarm` or `Continue without Swarm`
- `/swarm` — canonical gated execution runtime:
  - `/swarm run <task> [--max-parallel N] [--budget-usd X]`
  - `/swarm from-singular <run-id> --option <1|2|3> [--max-parallel N] [--budget-usd X]`
  - `/swarm watch [run-id]`
  - `/swarm retry <run-id> <task-id> [--reset-brief]`
  - `/swarm resume <run-id>`
  - limits: `--max-parallel` supports `1..20`; delegated intra-task fan-out supports up to `10`
  - consistency model: `Scopes -> Touches -> Locks -> Gates -> Done`
  - built-in scheduler guards: progress heuristic + conflict density guard
  - high-risk spawn candidates are confirmation-gated
- `/orchestrate` — legacy manual team splitting remains available:
  - in `--parallel` mode, omitted `--max-parallel` defaults to selected `--agents`
  - if profiles are omitted for parallel assignments, runtime defaults workers to `meta` (except read-only host contexts)
  - assignment hints include `delegate_parallel_hint` for nested delegate planning

Migration notes:
- `/blast` removed in favor of `/singular`
- `/shadow` removed

---

## Core Options

### Help & Version

| Flag | Description |
|------|-------------|
| `--help`, `-h` | Show help message and exit |
| `--version`, `-v` | Show version number and exit |

### Output Mode

| Flag | Description |
|------|-------------|
| `--mode <text\|json\|rpc>` | Set output/protocol mode |
| `--print`, `-p` | Non-interactive: run prompt and exit |

**Examples:**

```bash
# Interactive (default)
iosm

# One-shot prompt
iosm -p "Review the codebase"

# JSON event stream for automation
iosm --mode json "Analyze dependencies"

# JSON-RPC server for IDE integration
iosm --mode rpc --no-session
```

### Session Control

| Flag | Description |
|------|-------------|
| `--continue`, `-c` | Continue the previous session |
| `--resume`, `-r` | Open interactive session picker |
| `--session <path>` | Use a specific session file |
| `--session-dir <dir>` | Override session storage directory |
| `--no-session` | Disable persistence for current run |

**Examples:**

```bash
iosm --continue                              # Continue where you left off
iosm --resume                                # Pick from recent sessions
iosm --session ~/sessions/refactor.jsonl     # Specific session file
iosm --no-session                            # Ephemeral run
```

---

## Model & Provider Options

| Flag | Description |
|------|-------------|
| `--provider <name>` | Select LLM provider |
| `--model <pattern-or-id>` | Select model |
| `--api-key <key>` | Runtime-only API key override (not persisted) |
| `--models <comma-separated>` | Model rotation scope |
| `--thinking <level>` | Thinking/reasoning level |
| `--list-models [search]` | List available models |

### `--model` Formats

| Format | Example | Description |
|--------|---------|-------------|
| `provider/model-id` | `openai/gpt-5.3` | Explicit provider and model |
| `model-id` | `sonnet` | Model with auto-detected provider |
| `model-id:thinking` | `sonnet:high` | Model with thinking level |

### `--thinking` Levels

| Level | Description |
|-------|-------------|
| `off` | No extended thinking |
| `minimal` | Minimal reasoning |
| `low` | Low reasoning effort |
| `medium` | Moderate reasoning |
| `high` | High reasoning effort |
| `xhigh` | Maximum reasoning effort |

**Examples:**

```bash
iosm --provider openai --model gpt-5.3
iosm --model anthropic/claude-sonnet-4-20250514
iosm --model sonnet:high
iosm --thinking medium
iosm --models "sonnet,gpt-5.3,gemini-2.5-pro"
iosm --list-models                   # All models
iosm --list-models gemini            # Filter by name
iosm --api-key sk-test-123           # Override for this run
```

---

## Prompt & Tool Options

| Flag | Description |
|------|-------------|
| `--system-prompt <text>` | Replace the entire system prompt |
| `--append-system-prompt <text>` | Append text to the system prompt |
| `--tools <list>` | Specify which built-in tools to enable |
| `--no-tools` | Disable all built-in tools |

### Available Tools

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`, `semantic_search`, `fetch`, `git_read`, `fs_ops`

Tool notes:
- `rg`, `fd` are managed by iosm-cli and auto-resolved when missing.
- `ast_grep`, `comby`, `jq`, `yq`, `semgrep` are optional external CLIs and should be available in `PATH` to use their tools.
- `sed` tool is preview/extraction-oriented; in-place edits are intentionally blocked.
- `semantic_search` uses configured embeddings provider/index (`/semantic setup`).
- `fetch` is profile-aware: read-only profiles allow only `GET/HEAD/OPTIONS`; write-capable profiles allow full HTTP method set.
- `git_read` provides structured read-only git actions (`status`, `diff`, `log`, `blame`) without raw shell passthrough.
- `fs_ops` performs structured filesystem mutations (`mkdir`, `move`, `copy`, `delete`) with explicit `recursive`/`force` safety flags.

**Examples:**

```bash
# Full tool access (default)
iosm

# Read-only analysis
iosm --tools read,grep,find,ls -p "Audit for dead code"

# Structural/security analysis pass
iosm --tools read,rg,ast_grep,semgrep -p "Find risky auth patterns and report"

# No tools
iosm --no-tools -p "Explain polymorphism"

# Custom system prompt
iosm --system-prompt "You are a senior Go developer" -p "Review main.go"
iosm --append-system-prompt "Always respond in Russian"
```

---

## Extension & Resource Options

| Flag | Description |
|------|-------------|
| `--extension`, `-e <path>` | Load extension (repeatable) |
| `--no-extensions` | Disable all extension auto-discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable all skill auto-discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load TUI theme (repeatable) |
| `--no-themes` | Disable theme auto-discovery |

**Examples:**

```bash
# Load custom extensions
iosm -e ./safety-gate.ts -e ./custom-tool.ts

# Load with specific skill
iosm --skill ./deploy-workflow.md

# Clean mode — no auto-loaded resources
iosm --no-extensions --no-skills --no-prompt-templates
```

---

## Runtime Options

| Flag | Description |
|------|-------------|
| `--plan` | Read-first planning mode |
| `--profile <name>` | Select agent profile |
| `--offline` | Disable startup network operations |
| `--session-trace` | Enable full JSONL session trace |
| `--session-trace-dir <dir>` | Override trace directory |
| `--verbose` | Force verbose startup output |

### Profiles

| Profile | Description |
|---------|-------------|
| `full` | Default — all tools, full capabilities |
| `plan` | Read-only architecture/planning |
| `iosm` | IOSM artifact context and synchronization |
| `meta` | Full tools + orchestration-first execution contract |
| `explore` | Exploratory analysis |
| `iosm_analyst` | IOSM metric deep-dive |
| `iosm_verifier` | IOSM verification specialist |
| `cycle_planner` | Cycle planning specialist |

**Meta mode quality note:** for complex orchestration use modern models with large context windows (`>=128k`, ideally `>=200k`) and high token limits. Smaller models degrade orchestration stability and synthesis quality.

**Examples:**

```bash
iosm --profile plan                  # Planning mode
iosm --profile iosm                  # IOSM mode
iosm --profile meta                  # Orchestration-first mode
iosm --offline                       # No network
iosm --session-trace                 # Enable tracing
iosm --verbose                       # Verbose startup
```

---

## File Attachments

Prefix arguments with `@` to include file content in the initial user message:

```bash
iosm @prompt.md @diagram.png "Summarize and propose next steps"
iosm @src/auth.ts -p "Find security issues in this file"
iosm @requirements.md @design.md "Compare requirements to design"
```

---

## Common Workflows

### Code Review

```bash
iosm --tools read,grep,find,ls -p "Review src/ for code quality issues"
```

### Refactoring with Planning

```bash
iosm --profile plan
# "Analyze the auth module and propose a refactoring plan"
```

### IOSM Improvement Cycle

```bash
iosm init
iosm cycle plan "optimize database queries"
iosm --profile iosm
```

### CI Integration

```bash
iosm --mode json -p "Check for TODO comments" | jq '.text'
```

### IDE Integration (RPC)

```bash
iosm --mode rpc --no-session
# Communicate via stdin/stdout JSON-RPC messages
```

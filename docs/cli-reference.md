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

`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

**Examples:**

```bash
# Full tool access (default)
iosm

# Read-only analysis
iosm --tools read,grep,find,ls -p "Audit for dead code"

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
| `explore` | Exploratory analysis |
| `iosm_analyst` | IOSM metric deep-dive |
| `iosm_verifier` | IOSM verification specialist |
| `cycle_planner` | Cycle planning specialist |

**Examples:**

```bash
iosm --profile plan                  # Planning mode
iosm --profile iosm                  # IOSM mode
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

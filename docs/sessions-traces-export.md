# Sessions, Traces, Export

`iosm-cli` provides comprehensive session management with persistence, branching, tracing, HTML export, and sharing capabilities.

---

## Session Persistence

By default, interactive sessions are automatically persisted to:

```
~/.iosm/agent/sessions/
```

Each session is stored as a JSONL (JSON Lines) file containing the complete conversation history, tool calls, and metadata.

### CLI Session Controls

| Flag | Description | Example |
|------|-------------|---------|
| `--continue`, `-c` | Continue the most recent session | `iosm -c` |
| `--resume`, `-r` | Open interactive session picker | `iosm -r` |
| `--session <path>` | Open a specific session file | `iosm --session ~/sessions/my.jsonl` |
| `--session-dir <dir>` | Override session storage directory | `iosm --session-dir ./local-sessions` |
| `--no-session` | Disable persistence (ephemeral run) | `iosm --no-session` |

### Examples

```bash
# Continue where you left off
iosm --continue

# Pick from a list of recent sessions
iosm --resume

# Use a specific session file
iosm --session ~/my-project-sessions/refactor-auth.jsonl

# Custom session directory
iosm --session-dir /tmp/my-sessions

# One-off ephemeral session (not saved)
iosm --no-session -p "Quick question about TypeScript generics"
```

---

## Session Tree & Branching

Sessions support tree-based branching, allowing you to explore different paths from any point in the conversation.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/tree` | Navigate the session tree visually |
| `/fork` | Create a branch from a previous message |
| `/name` | Set a display name for the current session |

### Branching Workflow

```bash
iosm

# Have a conversation...
# You: "Analyze the auth module"
# Agent: [analysis]
# You: "Propose two approaches: rewrite vs refactor"
# Agent: [proposals]

# Fork to explore Approach A
/fork
# "Let's go with the rewrite approach and implement it"

# Later, go back and fork to explore Approach B
/tree
# Navigate to the branching point
/fork
# "Let's try the refactor approach instead"

# Name this session for easy finding later
/name "auth-module-exploration"
```

### Tree Navigation

The `/tree` command shows a visual tree of your conversation branches:

```
📝 auth-module-exploration
├── [1] You: Analyze the auth module
├── [2] Agent: [analysis]
├── [3] You: Propose two approaches
├── [4] Agent: [proposals]
├── Branch A (current)
│   └── [5] You: Rewrite approach
│       └── [6] Agent: [implementation]
└── Branch B
    └── [5] You: Refactor approach
        └── [6] Agent: [implementation]
```

---

## Session Trace Logging

Enable full JSONL trace logging for debugging, auditing, or analysis:

### Enable Tracing

```bash
# Via CLI flag
iosm --session-trace

# Via environment variable
IOSM_SESSION_TRACE=1 iosm

# Custom trace directory
iosm --session-trace --session-trace-dir /path/to/traces

# Via environment variable
IOSM_SESSION_TRACE_DIR="/path/to/traces" IOSM_SESSION_TRACE=1 iosm
```

### Trace File Format

Traces are stored as `<session-id>.jsonl` files. Each line is a JSON event:

```jsonl
{"type":"session_start","timestamp":"2026-03-09T15:42:00Z","sessionId":"abc123"}
{"type":"user_message","timestamp":"2026-03-09T15:42:05Z","content":"Analyze the project"}
{"type":"system_prompt_context_compose","timestamp":"2026-03-09T15:42:05Z","context_before_chars":16422,"context_after_chars":11998,"dedupe_hits":2,"truncated_files":["README.md"],"dropped_files":1}
{"type":"tool_call","timestamp":"2026-03-09T15:42:06Z","tool":"ls","input":{"path":"."}}
{"type":"tool_result","timestamp":"2026-03-09T15:42:06Z","tool":"ls","output":"..."}
{"type":"bash_end","timestamp":"2026-03-09T15:42:07Z","command":"npm run dev","backgroundTaskId":"bg_1770000000000_ab12cd34"}
{"type":"assistant_message","timestamp":"2026-03-09T15:42:10Z","content":"Here's my analysis..."}
{"type":"turn_end","timestamp":"2026-03-09T15:42:10Z","usage":{"totalTokens":1500}}
```

Notable runtime events:

- `system_prompt_context_compose` shows prompt-context preprocessing stats (before/after chars, dedupe hits, truncation, dropped files).
- `bash_end.backgroundTaskId` is populated when a shell command was started in detached background mode.

### Analyzing Traces

```bash
# View all events
cat ~/.iosm/agent/session-traces/<session-id>.jsonl | jq .

# Filter tool calls
cat trace.jsonl | jq 'select(.type=="tool_call")'

# Count token usage per turn
cat trace.jsonl | jq 'select(.type=="turn_end") | .usage.totalTokens'
```

---

## Export to HTML

Export sessions to beautifully formatted, self-contained HTML files.

### Interactive Export

```bash
iosm
# ... have a conversation ...
/export
```

### CLI Export

```bash
iosm --export /path/to/session.jsonl
```

### Export Features

- **Self-contained** — Single HTML file with all assets embedded
- **Themed** — Uses the current TUI theme for styling
- **Tool rendering** — Tool calls and results are pre-rendered with syntax highlighting
- **Navigable** — Conversation structure is preserved with collapsible sections

---

## Share via GitHub Gist

Share a session publicly (or privately) via GitHub Gist:

```bash
/share
```

This will:
1. Serialize the current session
2. Upload as a secret GitHub Gist
3. Return a shareable URL

> **Note**: Requires GitHub authentication. Use `/login` to set up GitHub credentials.

---

## Copy to Clipboard

Copy the latest assistant response to your clipboard:

```bash
/copy
```

Useful for quickly grabbing generated code, explanations, or summaries.

---

## Session Management Workflows

### Daily Development

```bash
# Morning — continue yesterday's session
iosm -c

# Or pick a specific past session
iosm -r
```

### Code Review Sessions

```bash
# Start a named review session
iosm --profile plan
/name "Q1 security review"
# ... review code ...
/export                    # Export for team sharing
```

### CI/Automation (Ephemeral)

```bash
# No persistence needed
iosm --no-session -p "Check for deprecated APIs in src/"
```

### Branching Exploration

```bash
iosm
# Analyze an issue
# Fork to try different solutions
/fork
# Try solution A
# ...
/tree
# Go back, fork again
/fork
# Try solution B
# Compare and decide
```

---

## Further Reading

- [Interactive Mode](./interactive-mode.md) — All slash commands
- [Configuration](./configuration.md) — Session directory settings
- [JSON/RPC/SDK](./rpc-json-sdk.md) — Programmatic session management

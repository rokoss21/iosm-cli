# Configuration & Environment

Complete reference for `iosm-cli` settings, environment variables, profiles, and permission controls.

---

## Configuration Directories

### Global (User-Level)

```
~/.iosm/agent/
├── settings.json          # Global settings
├── mcp.json               # User MCP servers
├── models.json            # Model configuration and preferences
├── auth.json              # Provider credentials (OAuth + API keys via /login)
├── keybindings.json       # Custom keyboard shortcuts
├── extensions/            # Global extensions (auto-discovered)
├── skills/                # Global skills
├── prompts/               # Global prompt templates
├── themes/                # Global TUI themes
├── sessions/              # Persisted sessions
└── session-traces/        # JSONL trace files
```

### Project-Level

```
.iosm/
├── settings.json          # Project-specific settings
├── extensions/            # Project extensions
├── skills/                # Project skills
├── prompts/               # Project prompt templates
├── themes/                # Project themes
├── agents/                # Custom agent definitions
├── subagents/             # Subagent run transcripts
│   ├── runs/
│   └── teams/
└── cycles/                # IOSM cycle artifacts

.mcp.json                  # Project MCP servers (repository root)
```

---

## Settings Hierarchy

Settings are merged in this order (later wins):

```
1. Global settings    (~/.iosm/agent/settings.json)   ← lowest priority
2. Project settings   (.iosm/settings.json)
3. CLI flags                                            ← highest priority
```

### Settings File Example

```json
{
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-20250514",
    "thinking": "medium"
  },
  "tools": {
    "enabled": ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "bashTimeout": 30000,
    "maxOutputLines": 2000
  },
  "session": {
    "autoCompact": true,
    "compactThreshold": 100000,
    "maxRetries": 3
  },
  "terminal": {
    "shell": "/bin/zsh",
    "cols": 120
  },
  "permissions": {
    "autoApprove": false
  }
}
```

## MCP Configuration

Manage MCP servers from CLI and interactive mode:

```bash
# CLI
iosm mcp list
iosm mcp add filesystem --transport stdio --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg .
iosm mcp tools

# Interactive
/mcp
/mcp add                      # guided wizard
/mcp add filesystem --transport stdio --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg .
```

MCP configs are loaded with project override precedence:

1. `~/.iosm/agent/mcp.json`
2. `.mcp.json` (project root)

---

## Environment Variables

### Provider API Keys

| Variable | Provider | Notes |
|----------|----------|-------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Primary recommended provider |
| `OPENAI_API_KEY` | OpenAI (GPT) | |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI | Requires endpoint config |
| `GEMINI_API_KEY` | Google Gemini | |
| `GROQ_API_KEY` | Groq | |
| `CEREBRAS_API_KEY` | Cerebras | |
| `XAI_API_KEY` | xAI (Grok) | |
| `OPENROUTER_API_KEY` | OpenRouter | Multi-provider gateway |
| `MISTRAL_API_KEY` | Mistral | |
| `MINIMAX_API_KEY` | MiniMax | |
| `KIMI_API_KEY` | Kimi | |
| `OPENCODE_API_KEY` | OpenCode | |
| `AI_GATEWAY_API_KEY` | AI Gateway | |
| `AWS_PROFILE` | AWS Bedrock | Also: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |

### Runtime Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `IOSM_CODING_AGENT_DIR` | `~/.iosm/agent` | Override global config directory |
| `IOSM_PACKAGE_DIR` | Auto | Override package base directory |
| `IOSM_OFFLINE` | `false` | Disable startup network operations (`1`/`true`/`yes`) |
| `IOSM_SESSION_TRACE` | `false` | Enable JSONL session trace logging |
| `IOSM_SESSION_TRACE_DIR` | Auto | Override trace directory location |
| `IOSM_SHARE_VIEWER_URL` | Default | Custom base URL for `/share` links |
| `IOSM_AI_ANTIGRAVITY_VERSION` | Auto | Override Antigravity user-agent version |
| `IOSM_SKIP_VERSION_CHECK` | `false` | Disable update/version checks |

### Example: Shell Configuration

Add to `~/.zshrc` or `~/.bashrc`:

```bash
# Provider key
export ANTHROPIC_API_KEY="sk-ant-api03-..."

# Optional: enable tracing
export IOSM_SESSION_TRACE=1
export IOSM_SESSION_TRACE_DIR="$HOME/.iosm/traces"

# Optional: offline mode for air-gapped environments
# export IOSM_OFFLINE=1
```

---

## Profiles

Profiles control the agent's behavior, available tools, and system prompt.

### Primary Profiles

| Profile | Tools | Behavior |
|---------|-------|----------|
| `full` | All (read, bash, edit, write, grep, find, ls) | Default full development capabilities |
| `plan` | Read-only (read, grep, find, ls) | Architecture planning and code review |
| `iosm` | All + IOSM context | IOSM cycle execution with artifact synchronization |

### Advanced Profiles

| Profile | Use Case |
|---------|----------|
| `explore` | Exploratory codebase analysis |
| `iosm_analyst` | Deep IOSM metric analysis |
| `iosm_verifier` | IOSM quality gate verification |
| `cycle_planner` | IOSM cycle planning specialist |

### Usage

```bash
# CLI flag
iosm --profile plan
iosm --profile iosm

# Interactive: cycle with Shift+Tab
# full → plan → iosm → full → ...

# In orchestration
/orchestrate --profiles explore,full,iosm_verifier
```

---

## Permissions

Permissions control tool execution approval behavior.

### Interactive Commands

```bash
# View current permission status
/permissions

# Enable auto-approve (YOLO mode)
/yolo on

# Disable auto-approve
/yolo off

# Check status
/yolo status
```

### What Permissions Control

- **Tool calls**: Whether the agent can execute tools without user confirmation
- **File writes**: Whether `edit` and `write` tools require approval
- **Shell commands**: Whether `bash` executions require approval
- **Destructive actions**: Special handling for `rm`, `sudo`, etc.

### Safety Defaults

By default, `iosm-cli` asks for confirmation before:
- Executing shell commands
- Writing or editing files
- Performing destructive operations

Use extensions like `permission-gate.ts` or `protected-paths.ts` for additional safety layers.

---

## Provider-Specific Configuration

### Anthropic

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."

iosm --model claude-sonnet-4-20250514
iosm --model sonnet:high          # With thinking
```

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."

iosm --model gpt-5.3
iosm --model openai/gpt-5.3-mini
```

### Google Gemini

```bash
export GEMINI_API_KEY="AI..."

iosm --model gemini-2.5-pro
```

### AWS Bedrock

```bash
export AWS_PROFILE="default"
# or
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_REGION="us-east-1"

iosm --provider bedrock --model anthropic.claude-v2
```

### Azure OpenAI

```bash
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com"

iosm --provider azure --model gpt-5.3
```

### OAuth-Based Providers

Some providers support OAuth login (for example, Qwen CLI free OAuth):

```bash
iosm
# In interactive mode:
/login
# Follow the authentication flow
```

---

## Further Reading

- [CLI Reference](./cli-reference.md) — All command-line flags
- [Interactive Mode](./interactive-mode.md) — Keybindings and slash commands
- [Extensions](./extensions-packages-themes.md) — Extension system and customization

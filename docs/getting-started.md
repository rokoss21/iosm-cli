# Getting Started

Welcome to `iosm-cli` — an AI-powered engineering agent with the IOSM (Improve → Optimize → Shrink → Modularize) methodology built in.

## Requirements

- **Node.js** `>=20.6.0` (check with `node --version`)
- **npm** (bundled with Node.js)
- At least one LLM provider API key

## Installation

### Option 1: Global Install (recommended)

```bash
npm install -g iosm-cli
iosm --version
```

### Option 2: Run Without Installing

```bash
npx iosm-cli --version
```

### Option 3: Build from Source

```bash
git clone https://github.com/rokoss21/iosm-cli.git
cd iosm-cli
npm install
npm run build
npm link    # Makes `iosm` available globally
```

## Provider Setup

You need at least one LLM provider. Set the API key as an environment variable:

### Anthropic (Claude)

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

### Google Gemini

```bash
export GEMINI_API_KEY="AI..."
```

### Other Providers

```bash
export GROQ_API_KEY="gsk_..."
export XAI_API_KEY="xai-..."
export OPENROUTER_API_KEY="sk-or-..."
export MISTRAL_API_KEY="..."
```

You can also use `/login` in interactive mode for OAuth providers (including free Qwen OAuth) and OpenRouter API key setup:

```bash
iosm
# Inside interactive mode:
/login
```

> **Tip**: Add your API key exports to `~/.zshrc` or `~/.bashrc` so they persist across sessions.

## First Run

### Interactive Mode

Start the agent in interactive mode:

```bash
iosm
```

You'll see a prompt where you can type messages. The agent has access to your filesystem and shell tools.

**Useful first commands inside the agent:**

| Command | What it does |
|---------|-------------|
| `/model` | Pick or change the active model |
| `/login` | Authenticate with OAuth providers (including Qwen) or add OpenRouter API key |
| `/init` | Bootstrap IOSM artifacts for the current project |
| `/agents` | View available custom/system agents |
| `/settings` | View and modify settings |
| `/hotkeys` | View keyboard shortcuts |

### Example First Interaction

```
You: Review the project structure and summarize the architecture

Agent: I'll analyze the project structure for you.

[Tool: ls] Listing directory...
[Tool: read] Reading key files...

Based on my analysis, here's the project architecture:
...
```

### One-Shot Usage

Run a single prompt without entering interactive mode:

```bash
# Quick code review
iosm -p "Review src/ and list the top 5 refactoring opportunities"

# Read-only audit
iosm --tools read,grep,find,ls -p "Audit src/ for dead code"

# With a specific model
iosm --model openai/gpt-5.3 -p "Explain the auth module"

# With file attachments
iosm @README.md @src/main.ts -p "How does the CLI entry point work?"
```

## Initialize IOSM Workspace

If you want to use the IOSM methodology for systematic improvement:

```bash
# Bootstrap in current project
iosm init

# Bootstrap in a specific path
iosm init ../service-a

# Force re-initialization
iosm init --force

# Skip post-init agent verification
iosm init --no-agent-verify
```

This creates:

- `iosm.yaml` — methodology configuration (thresholds, weights, policies)
- `IOSM.md` — operator/agent playbook
- `.iosm/` — workspace with cycle artifacts, metrics history, decision log

## Typical Daily Workflow

```bash
# 1. Open your project and start the agent
cd my-project
iosm

# 2. Initialize IOSM (first time only)
/init

# 3. Plan improvement cycles
/cycle-plan reduce checkout latency

# 4. Work on tasks via natural language
# "Implement the cache optimization from hypothesis hyp-latency-001"

# 5. Check cycle progress
/cycle-status

# 6. Export or share your session
/export
/share
```

## Choosing a Model

Select a model at startup or switch during a session:

```bash
# At startup
iosm --model sonnet                    # Claude Sonnet
iosm --model openai/gpt-5.3            # GPT-5.3
iosm --model gemini-2.5-pro           # Gemini Pro
iosm --model sonnet:high              # With high thinking level

# Model rotation (cycles through models)
iosm --models "sonnet,gpt-5.3,gemini-2.5-pro"

# During interactive session
/model                                 # Opens model selector
Ctrl+P                                 # Next model in rotation
Shift+Ctrl+P                           # Previous model
```

## Troubleshooting

### "No model available"

Ensure you have at least one valid API key:

```bash
echo $ANTHROPIC_API_KEY   # Should show your key
echo $OPENAI_API_KEY
```

### "Permission denied" when running tools

The agent respects tool permissions. Use `/permissions` or `/yolo on` to adjust:

```bash
/permissions                           # View current permissions
/yolo on                               # Enable auto-approve for tool calls
/yolo off                              # Disable auto-approve
```

### Network issues

Run in offline mode to skip startup network operations:

```bash
iosm --offline
# or
IOSM_OFFLINE=1 iosm
```

### Session recovery

If a session was interrupted:

```bash
iosm --continue                        # Continue the last session
iosm --resume                          # Pick from recent sessions
```

## Next Steps

- [CLI Reference](./cli-reference.md) — Complete flag documentation
- [Interactive Mode](./interactive-mode.md) — All slash commands and keybindings
- [IOSM Init & Cycles](./iosm-init-and-cycles.md) — IOSM methodology guide
- [Extensions](./extensions-packages-themes.md) — Build custom tools and integrations
- [Configuration](./configuration.md) — Settings, env vars, profiles

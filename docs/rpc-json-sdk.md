# JSON, RPC, and SDK Integrations

`iosm-cli` supports multiple integration modes beyond interactive use: JSON event streaming for automation, JSON-RPC for IDE integrations, and a programmatic SDK for embedding.

---

## JSON Stream Mode

Machine-readable line-delimited JSON event stream. Ideal for automation, log processing, and lightweight integrations.

### Usage

```bash
iosm --mode json "Your prompt"
```

### Event Types

Each line is a JSON object with a `type` field:

```jsonl
{"type":"text_delta","delta":"Here is "}
{"type":"text_delta","delta":"my analysis..."}
{"type":"tool_call_start","toolName":"read","input":{"file_path":"src/main.ts"}}
{"type":"tool_call_end","toolName":"read","result":"...file contents..."}
{"type":"text_delta","delta":"Based on the code..."}
{"type":"agent_end","usage":{"inputTokens":500,"outputTokens":200}}
```

### Example: CI Pipeline

```bash
# Check for TODO comments and parse output
result=$(iosm --mode json -p "Find all TODO comments in src/" 2>/dev/null)
echo "$result" | jq -r 'select(.type=="text_delta") | .delta' | tr -d '\n'

# Automated code review with JSON output
iosm --mode json -p "Review src/auth.ts for security issues" > review.jsonl
```

### Example: Script Integration

```bash
#!/bin/bash
# Automated documentation generator
iosm --mode json -p "Generate JSDoc for all exported functions in src/index.ts" \
  | jq -r 'select(.type=="text_delta") | .delta' \
  > generated-docs.md
```

---

## RPC Mode

stdio-based JSON-RPC server for stateful IDE/editor integrations.

### Starting the RPC Server

```bash
iosm --mode rpc --no-session
```

### Protocol

Communication happens over stdin/stdout using JSON-RPC 2.0 messages:

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "prompt",
  "params": {
    "message": "Explain this function",
    "context": {
      "file": "src/auth.ts",
      "selection": "function validateToken(token: string) { ... }"
    }
  }
}
```

**Response (streaming):**
```json
{"jsonrpc":"2.0","id":1,"result":{"type":"text_delta","delta":"This function..."}}
{"jsonrpc":"2.0","id":1,"result":{"type":"text_delta","delta":" validates..."}}
{"jsonrpc":"2.0","id":1,"result":{"type":"agent_end"}}
```

### Integration Pattern

```
┌─────────────┐     stdin      ┌────────────┐
│   IDE/App   │ ──────────────→ │  iosm-cli  │
│   (Host)    │ ←────────────── │  (RPC)     │
└─────────────┘    stdout       └────────────┘
```

1. **Spawn** the `iosm --mode rpc --no-session` process
2. **Send** JSON-RPC requests via stdin
3. **Receive** streaming responses via stdout
4. **Manage** lifecycle from the host application

### Example: Node.js Client

```typescript
import { spawn } from "child_process";

const agent = spawn("iosm", ["--mode", "rpc", "--no-session"]);

// Send a request
const request = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "prompt",
  params: { message: "Hello, explain TypeScript generics" }
});
agent.stdin.write(request + "\n");

// Read responses
agent.stdout.on("data", (data) => {
  const lines = data.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    const response = JSON.parse(line);
    if (response.result?.type === "text_delta") {
      process.stdout.write(response.result.delta);
    }
  }
});
```

### RPC Extension UI

Extensions can expose UI elements through RPC mode. See [rpc-extension-ui.ts](../examples/rpc-extension-ui.ts) for a complete example of using `confirm`, `select`, `notify`, and other UI methods over RPC.

---

## Print Mode

Single-turn output mode for scripts and CI:

```bash
iosm -p "Summarize the repository architecture"
```

### Use Cases

```bash
# Code review in CI
iosm -p "Review the last 5 commits for potential issues"

# Documentation generation
iosm -p "Generate API documentation for src/core/sdk.ts" > api-docs.md

# Dependency analysis
iosm --tools read,grep,find,ls -p "List all external dependencies and their versions"

# With specific model
iosm --model gpt-5.3 -p "Explain the authentication flow"

# With file attachments
iosm @src/auth.ts -p "Find vulnerabilities in this file"
```

---

## SDK (Programmatic API)

`iosm-cli` exposes a full SDK for embedding the agent in custom applications.

### Core Factory

```typescript
import { createAgentSession, AuthStorage, ModelRegistry } from "iosm-cli";
```

### Minimal Example

```typescript
import { createAgentSession, AuthStorage, ModelRegistry } from "iosm-cli";

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
});

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Hello, analyze this project");
```

### Custom Model

```typescript
import { getModel } from "@mariozechner/pi-ai";

const model = getModel("anthropic", "claude-sonnet-4-20250514");
const { session } = await createAgentSession({
  model,
  thinkingLevel: "high",
  authStorage,
  modelRegistry,
});
```

### Custom System Prompt

```typescript
import { DefaultResourceLoader } from "iosm-cli";

const loader = new DefaultResourceLoader({
  systemPromptOverride: (base) => `${base}\n\nAlways respond in Russian.`,
});
await loader.reload();

const { session } = await createAgentSession({
  resourceLoader: loader,
  authStorage,
  modelRegistry,
});
```

### Read-Only Mode

```typescript
import { readOnlyTools } from "iosm-cli";

const { session } = await createAgentSession({
  tools: readOnlyTools,  // Read-only bundle (code search + semantic + web discovery + HTTP/git introspection)
  authStorage,
  modelRegistry,
});
```

### In-Memory Session (No Persistence)

```typescript
import { SessionManager } from "iosm-cli";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});
```

### Full Control

```typescript
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  readTool,
  bashTool,
} from "iosm-cli";

// Custom auth
const customAuth = AuthStorage.create("/my/app/auth.json");
customAuth.setRuntimeApiKey("anthropic", process.env.MY_KEY!);

// Custom resource loader
const resourceLoader = new DefaultResourceLoader({
  systemPromptOverride: () => "You are a specialized code reviewer.",
  extensionFactories: [myExtension],
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  promptsOverride: () => ({ prompts: [], diagnostics: [] }),
});
await resourceLoader.reload();

// Create session with full control
const { session } = await createAgentSession({
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  authStorage: customAuth,
  modelRegistry: new ModelRegistry(customAuth),
  resourceLoader,
  tools: [readTool, bashTool],
  customTools: [{ tool: myCustomTool }],
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory(),
});
```

### SDK Options Reference

| Option | Default | Description |
|--------|---------|-------------|
| `authStorage` | `AuthStorage.create()` | Credential storage |
| `modelRegistry` | `new ModelRegistry(auth)` | Model registry |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `~/.iosm/agent` | Config directory |
| `model` | From settings | Model to use |
| `thinkingLevel` | `"off"` | Thinking level: off, low, medium, high |
| `tools` | `codingTools` | Built-in tools array |
| `customTools` | `[]` | Additional custom tools |
| `resourceLoader` | `DefaultResourceLoader` | Extension/skill/prompt/theme loader |
| `sessionManager` | `SessionManager.create(cwd)` | Session persistence |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | Settings management |

### Event Types

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      // Streaming text, thinking, tool calls
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Running tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Tool result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Agent finished");
      break;
  }
});
```

---

## Integration Strategy Guide

| Use Case | Recommended Mode | Why |
|----------|-----------------|-----|
| CI/CD automation | `--mode json` or `-p` | Lightweight, parseable output |
| IDE integration | `--mode rpc` | Stateful, bidirectional communication |
| Custom application | SDK | Full programmatic control |
| Scripting | `-p` (print mode) | Simplest for one-off tasks |
| Log analysis pipeline | `--mode json` | Structured event stream |

---

## Further Reading

- [12 SDK examples](../examples/sdk/) — Complete programmatic usage patterns
- [Extensions](./extensions-packages-themes.md) — Extension system for custom tools
- [Configuration](./configuration.md) — Provider setup and credentials

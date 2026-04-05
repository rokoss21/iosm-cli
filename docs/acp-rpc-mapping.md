# ACP Adapter Mapping (MVP)

This document defines the compatibility contract for `--mode acp`.

## Capability Negotiation

- Request: `acp.handshake`
- Response: protocol version + capabilities (`streaming`, `permissionBridge`, `toolEvents`, `sessionLifecycle`, `backCompatRpc`, `execSessions`).
- Unsupported methods return JSON-RPC `-32601` with `reason=capability_not_supported`.

## Method Mapping

| ACP Method | Internal Runtime Action |
|---|---|
| `acp.session.start` | `AgentSession` lifecycle bootstrap (returns current `sessionId/sessionFile`) |
| `acp.session.prompt` | `session.prompt(...)` |
| `acp.session.steer` | `session.steer(...)` |
| `acp.session.follow_up` | `session.followUp(...)` |
| `acp.session.abort` | `session.abort()` |
| `acp.session.state` | Session state snapshot (`model`, `thinkingLevel`, `isStreaming`, permission mode) |
| `acp.command.run_builtin` | `dispatchBuiltinSlashCommand(...)` |
| `acp.exec.command` | Starts resumable shell execution (returns output chunk + optional `sessionId`; supports `tty/shell/login` options) |
| `acp.exec.write_stdin` | Writes to a running exec session and polls next output chunk |
| `acp.permission.response` | Permission bridge response for pending tool confirmation (supports `scope=once|turn|session`) |

## Event Mapping

| Internal Event | ACP Notification |
|---|---|
| `AgentSessionEvent` stream | `acp.event` |
| tool permission confirmation request | `acp.permission.request` (includes available scopes + default scope) |
| async prompt failure (after `acp.session.prompt` accepted) | `acp.event` with `type=error` and `source=acp.session.prompt` |

## Compatibility Guarantees

- `--mode rpc` remains unchanged and fully supported.
- ACP adapter is additive and does not alter existing RPC protocol semantics.
- Unsupported ACP features fail with capability-level rejections instead of runtime crashes.

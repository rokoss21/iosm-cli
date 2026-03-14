# Development & Testing

Guide for contributing to `iosm-cli` — repository layout, build system, testing, and release process.

---

## Repository Layout

```
iosm-cli/
├── src/                          # Application source (TypeScript)
│   ├── cli.ts                    # CLI entry point
│   ├── main.ts                   # Main application logic
│   ├── config.ts                 # Path resolution and configuration
│   ├── index.ts                  # Public SDK exports
│   ├── migrations.ts             # Session/settings migrations
│   ├── cli/                      # CLI argument parsing
│   │   ├── args.ts               # Argument definitions and parsing
│   │   ├── config-selector.ts    # Config selection UI
│   │   ├── file-processor.ts     # @file attachment handling
│   │   ├── list-models.ts        # --list-models implementation
│   │   └── session-picker.ts     # --resume session selection
│   ├── core/                     # Runtime engine
│   │   ├── agent-session.ts      # Core agent session (main loop)
│   │   ├── agent-profiles.ts     # Profile definitions
│   │   ├── agent-teams.ts        # Team orchestration
│   │   ├── model-registry.ts     # Multi-provider model registry
│   │   ├── model-resolver.ts     # Model matching and resolution
│   │   ├── session-manager.ts    # Session persistence engine
│   │   ├── settings-manager.ts   # Settings hierarchy
│   │   ├── package-manager.ts    # Package install/remove/update
│   │   ├── resource-loader.ts    # Extension/skill/prompt/theme loader
│   │   ├── subagents.ts          # Subagent orchestration
│   │   ├── parallel-task-agent.ts # Parallel task execution
│   │   ├── sdk.ts                # Public SDK factory
│   │   ├── system-prompt.ts      # System prompt construction
│   │   ├── hooks.ts              # Hook system
│   │   ├── skills.ts             # Skill discovery and loading
│   │   ├── prompt-templates.ts   # Prompt template system
│   │   ├── bash-executor.ts      # Shell command execution
│   │   ├── tools/                # Built-in tools
│   │   │   ├── read.ts           # File reading
│   │   │   ├── bash.ts           # Shell execution
│   │   │   ├── edit.ts           # File editing
│   │   │   ├── write.ts          # File creation
│   │   │   ├── grep.ts           # Content search
│   │   │   ├── find.ts           # File finding
│   │   │   ├── ls.ts             # Directory listing
│   │   │   ├── task.ts           # Task management
│   │   │   └── todo.ts           # Todo tool
│   │   ├── extensions/           # Extension system
│   │   ├── compaction/           # Context compaction
│   │   └── export-html/          # HTML export templates
│   ├── iosm/                     # IOSM methodology
│   │   ├── init.ts               # Workspace bootstrapping
│   │   ├── cycle.ts              # Cycle lifecycle
│   │   ├── metrics.ts            # Metric calculation
│   │   ├── config.ts             # IOSM config parsing
│   │   ├── automation.ts         # IOSM autopilot
│   │   ├── guide.ts              # Playbook generation
│   │   ├── agent-verification.ts # Post-init verification
│   │   └── types.ts              # IOSM type definitions
│   ├── modes/                    # Output modes
│   │   ├── interactive/          # TUI (43 files)
│   │   ├── rpc/                  # JSON-RPC server
│   │   └── print-mode.ts         # Single-shot print
│   └── utils/                    # Utilities
│       ├── git.ts                # Git operations
│       ├── shell.ts              # Shell config detection
│       ├── clipboard.ts          # Clipboard access
│       ├── image-resize.ts       # Image processing
│       └── ...
├── test/                         # Vitest test suite (73 files)
├── examples/
│   ├── extensions/               # 66 extension examples
│   └── sdk/                      # 12 SDK examples
├── docs/                         # Documentation
├── scripts/                      # Build/migration scripts
├── iosm-spec.md                  # IOSM methodology specification
├── package.json
├── tsconfig.base.json            # Base TypeScript config
├── tsconfig.build.json           # Build config
├── tsconfig.examples.json        # Examples config
└── vitest.config.ts              # Test configuration
```

---

## Build Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Install | `npm install` | Install all dependencies |
| Type-check | `npm run check` | Run TypeScript type-checking without emit |
| Build | `npm run build` | Compile TypeScript + copy assets |
| Watch | `npm run dev` | Watch mode for development |
| Test | `npm test` | Run full Vitest test suite |
| Clean | `npm run clean` | Remove `dist/` directory |
| Binary | `npm run build:binary` | Build standalone Bun binary |
| Deploy Local | `npm run deploy-local` | Build and sync to global install |

### Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Start watch mode (rebuilds on file changes)
npm run dev

# 3. In another terminal, run your local build
node dist/cli.js

# Or link globally for testing
npm link
iosm
```

### Type-Checking

```bash
# Quick type check
npm run check

# Watch mode with type-checking
npx tsc -p tsconfig.build.json --watch --noEmit
```

---

## Testing

Tests are written with [Vitest](https://vitest.dev/) and run in Node.js environment.

### Running Tests

```bash
# Full test suite
npm test

# Single test file
npm test -- test/tools.test.ts

# Tests matching a pattern
npm test -- --grep "session"

# Watch mode
npx vitest --watch

# With coverage
npx vitest --coverage
```

### Test Structure

Tests are organized by feature area:

| Area | Test Files | Coverage |
|------|-----------|----------|
| **Tools** | `tools.test.ts` | Built-in tools (`read`, `bash`, `edit`, `write`, `git_write`, `fs_ops`, `grep`, `find`, `ls`, `rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`, `semantic_search`, `fetch`, `web_search`, `git_read`) |
| **Session** | `session-manager/`, `session-*.test.ts` | Persistence, branching, migration |
| **Extensions** | `extensions-*.test.ts` | Discovery, running, hooks, input events |
| **Compaction** | `compaction*.test.ts` | Context summarization |
| **Model** | `model-registry.test.ts`, `model-resolver.test.ts` | Multi-provider model management |
| **IOSM** | `iosm-*.test.ts` | Init, cycles, metrics, automation |
| **CLI** | `args.test.ts` | Argument parsing |
| **Packages** | `package-manager*.test.ts` | Package install/update/remove |
| **RPC** | `rpc.test.ts` | JSON-RPC protocol |
| **SDK** | `sdk-*.test.ts` | Programmatic API |
| **Subagents** | `subagent*.test.ts` | Orchestration |
| **UI** | `interactive-mode-status.test.ts`, etc. | TUI components |

### Writing Tests

```typescript
import { describe, it, expect } from "vitest";

describe("MyFeature", () => {
  it("should do the expected thing", async () => {
    const result = await myFunction();
    expect(result).toBe(expected);
  });
});
```

### Test Notes

- Some integration tests require network access and are skipped when prerequisites are absent
- Tests use a shared `utilities.ts` for common test helpers and fixtures
- Test fixtures are stored in `test/fixtures/`

---

## Migration & Maintenance

### Session Migration

For migrating sessions from older formats:

```bash
bash scripts/migrate-sessions.sh
```

### Configuration Fallbacks

Runtime path and config fallback logic lives in `src/config.ts`. This handles:
- User agent directory resolution
- Version detection
- Legacy path compatibility

### Documentation Alignment

When adding CLI features, keep in sync:
1. `src/cli/args.ts` — Argument definitions
2. `docs/cli-reference.md` — User-facing documentation
3. `README.md` — If the feature is significant

---

## Release Hygiene

### Pre-Release Checklist

```bash
# 1. Type-check passes
npm run check

# 2. All tests pass
npm test

# 3. Build succeeds
npm run build

# 4. Verify documentation
#    - README.md reflects current CLI behavior
#    - docs/ are up to date
#    - CHANGELOG.md has new entries

# 5. .gitignore covers all generated artifacts
#    - dist/, node_modules/, .iosm/, coverage/
```

### Publishing

```bash
# Runs clean + build automatically via prepublishOnly
npm publish
```

---

## Architecture Overview

```
┌────────────────────────────────────────────────┐
│                    CLI Layer                     │
│  cli.ts → args.ts → main.ts                    │
├────────────────────────────────────────────────┤
│                   Mode Layer                     │
│  Interactive Mode │ Print Mode │ RPC Mode        │
├────────────────────────────────────────────────┤
│                  Core Runtime                    │
│  AgentSession ─── ModelRegistry ─── Tools       │
│       │               │                │        │
│  SessionManager  ModelResolver    Bash/Edit/... │
│       │               │                │        │
│  Subagents      ResourceLoader   Permissions    │
│       │               │                         │
│  EventBus       Extensions/Skills/Themes        │
├────────────────────────────────────────────────┤
│                 IOSM Domain                      │
│  Init │ Cycles │ Metrics │ Config │ Guide       │
├────────────────────────────────────────────────┤
│                  Utilities                       │
│  Git │ Shell │ Clipboard │ Images │ Frontmatter │
└────────────────────────────────────────────────┘
```

### Key Data Flow

1. **CLI** parses arguments and resolves configuration
2. **Main** initializes the mode (interactive/print/rpc)
3. **AgentSession** manages conversation loop, model calls, tool execution
4. **Tools** execute file operations and shell commands
5. **Extensions** hook into lifecycle events
6. **IOSM** manages improvement cycles and metrics
7. **SessionManager** persists conversation state

---

## Further Reading

- [CONTRIBUTING.md](../CONTRIBUTING.md) — Contribution guide
- [CLI Reference](./cli-reference.md) — Flag documentation
- [Extensions](./extensions-packages-themes.md) — Extension API

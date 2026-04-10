# Changelog

All notable changes to `iosm-cli` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.11] - 2026-04-10

### Added

- **Runtime specialist instruction overlay** — `full` root session can now inject a selected custom/core agent instruction block at runtime (`runtime_agent_context`) so the same root conversation dynamically applies task-specific specialist guidance.
- **Assistant/runtime specialist labeling** — interactive UI now renders specialist identity on assistant/tool frames when runtime specialist context is active (instead of always showing only the default root label).
- **Expanded core specialist catalog** — added/extended practical specialist agents for workflow optimization, tooling evaluation, readiness validation, data engineering, brand consistency, and result analytics.

### Changed

- **Root-agent specialist routing behavior** — runtime specialist selection now prefers semantic routing using agent descriptions/instructions (embedding-backed when available) with deterministic fallback behavior.
- **Orchestration worker visibility** — orchestration progress now surfaces explicit worker identity with `agent@profile` formatting where a specialized agent is chosen.
- **Task-agent auto-routing plumbing** — task tool routing interfaces now carry richer agent hint metadata (name/description/instructions/profile) for higher-quality specialist selection.

### Fixed

- **Runtime overlay activation gaps** — specialist overlay path now covers non-imperative task requests more reliably instead of requiring narrow action-keyword patterns.
- **UI consistency for specialist context** — runtime specialist metadata is now consistently queued/consumed with display alias handling, preventing mismatched labels during turn rendering.

## [0.3.10] - 2026-04-06

### Changed

- **Telegram live trace UX** — running status card now presents richer execution telemetry (assistant/tool lifecycle events) in a compact streaming trace section instead of request→wait→final-only visibility.

### Fixed

- **Streaming trace duplicate lines** — assistant streaming trace now uses prefix-based upsert semantics, so the live card keeps one current `assistant streaming` line instead of appending duplicates on every update.
- **Trace payload matching internals** — added dedicated trace payload extract/find helpers to update existing trace rows deterministically in both visible and full-history trace buffers.

## [0.3.9] - 2026-04-06

### Changed

- **Telegram completion contract hardening** — bridge runtime prompt now explicitly requires a short final textual summary for each completed turn (prevents tool-only finishes in normal flow).

### Fixed

- **`Task completed with no assistant text output` fallback quality** — replaced generic empty-output message with contextual fallback summary including tool activity, elapsed time, and recovery hint for concise no-tool recap.
- **Turn-level telemetry for empty-output diagnosis** — Telegram bridge now tracks per-turn tool call count and unique tool names and logs them when assistant final text is empty.
- **Assistant text capture resilience** — bridge now also captures text from `message_update` events as an additional fallback path before `agent_end`.

## [0.3.8] - 2026-04-06

### Changed

- **Telegram runtime guidance injection** — bridge now appends runtime execution guidance to child RPC system prompt to reduce unstable command patterns during remote execution (focused outputs, bounded scans, script-file fallback for complex shell flows).

### Fixed

- **Windows shell adaptation robustness** — PowerShell-adapted commands now execute via `-EncodedCommand`, avoiding fragile quote/escape transport through bash wrappers.
- **Windows adapter false-positive routing** — commands like `ls C:\projects` are no longer incorrectly forced into `cmd.exe` just because they include a Windows path argument.
- **Telegram long-message delivery stability** — rich/fallback message sending now chunks long output payloads to stay within Telegram safe limits and reduce delivery failures.

## [0.3.7] - 2026-04-06

### Added

- **Telegram bridge module split** — extracted dedicated Telegram runtime modules:
  - `telegram-api` client with serialized outbound requests and retry controls
  - `prompt-queue` with fair round-robin draining across chats
  - `polling-state` store for persisted long-polling offsets
- **Configurable Telegram retry policy** — introduced `telegram.retry` settings block with API retry/backoff, polling backoff, and status-edit network retry controls

### Changed

- **Bridge retry/backoff wiring** — Telegram bridge now reads retry/backoff parameters from settings instead of hardcoded values for:
  - API request retries
  - polling-loop transient failure backoff
  - status edit network retry delay
- **Configuration docs** — extended Telegram configuration examples and generated settings documentation with new retry policy fields

### Tests

- Added dedicated test suites for:
  - Telegram API retry and outbound serialization behavior
  - prompt queue fairness
  - polling offset persistence
- Expanded `settings-manager` telegram settings tests to cover retry normalization and safe bounds

## [0.3.6] - 2026-04-06

### Added

- **Telegram polling trace mode** — added verbose polling/update tracing for diagnostics via `telegram.debug.pollingTrace=true` and `IOSM_TELEGRAM_POLLING_TRACE=1`

### Changed

- **Telegram live status update cadence** — raised default status edit throttle to `3000ms`, applied runtime bounds `1000..10000ms`, and removed implicit animation-time override to reduce API pressure

### Fixed

- **Stale callback query handling** — `answerCallbackQuery` now safely ignores expired callback IDs (`query is too old` / invalid query) instead of surfacing noisy polling failures
- **Polling network backoff** — transient `fetch failed` and related network errors now use exponential backoff (`2s` to `30s`) in long polling loop
- **Status edit resilience on network loss** — transient status edit network failures now schedule coalesced retries instead of immediate repeated edits
- **Telegram API transport diagnostics** — fetch-level Telegram API failures now include method context (`Telegram API <method> request failed`) for faster root-cause analysis

## [0.3.5] - 2026-04-06

### Fixed

- **Telegram API 429 resilience** — added automatic `retry after N` backoff/retry handling for all Telegram API operations (including `sendMessage`, `editMessageText`, `sendDocument`, and control actions)
- **Telegram status message recovery** — when live status edit target becomes invalid (`MESSAGE_ID_INVALID`, deleted or non-editable message), bridge now recreates status message and continues updates on a fresh `message_id`
- **Bridge runtime stability under delivery failures** — wrapped RPC event callbacks and final output delivery with fail-safe guards to prevent bridge process crashes from transient Telegram delivery errors

## [0.3.4] - 2026-04-06

### Fixed

- **Windows shell command compatibility** — added runtime auto-adaptation for Windows command syntax, routing cmd-style commands (`%VAR%`, `dir`, `C:\...`) to `cmd.exe` and PowerShell-style commands (`$env:...`, `Get-*`) to `powershell.exe`
- **Telegram bridge command execution on Windows** — fixed failures when users sent native Windows shell commands through Telegram-driven runs while IOSM executed under bash
- **Execution path consistency** — applied shell adaptation uniformly across foreground bash execution, bash tool execution, and detached background processes

### Tests

- Added regression suite for Windows command adaptation and explicit-shell passthrough behavior

## [0.3.3] - 2026-04-05

### Fixed

- **META orchestration default fan-out** — actionable META prompts without explicit `agents=N` now require at least two top-level `task` calls, preventing silent single-thread execution for orchestration-first requests
- **Locale-agnostic META fallback** — replaced language-specific complexity keyword detection with runtime orchestration compliance signals (`required task calls`, nested delegation status) for stable behavior across languages
- **MCP/external tool output rendering** — unknown external tools now use generic fallback rendering instead of empty tool boxes, restoring visible arguments/results in interactive UI

### Tests

- Updated META prompt fallback tests to cover actionable vs question-like prompts
- Added regression test for unknown external tool result rendering in `ToolExecutionComponent`

## [0.3.2] - 2026-04-05

### Fixed

- **Playbook filename canonicalization** — `/init` and `iosm init` now normalize lowercase variants (`agents.md`, `iosm.md`) to canonical `AGENTS.md` and `IOSM.md`
- **Cross-platform case handling** — implemented robust case-only rename flow (with temporary hop) to reliably normalize filenames on case-insensitive filesystems
- **Profile context continuity** — `IOSM.md` context is now kept loaded in the resource layer to avoid context loss after runtime profile switching

### Changed

- **Standard init path resolution** — standard `/init` now resolves and writes through canonical playbook path before reading/updating repository guidance
- **IOSM guide writers** — IOSM/AGENTS guide writers now enforce canonical path selection prior to write operations

### Tests

- Added regression tests for lowercase-to-canonical playbook rename behavior in:
  - iosm guide writer flow
  - iosm init flow
  - interactive standard `/init` flow
- Updated resource-loader profile test expectations for runtime profile switching behavior

## [0.3.1] - 2026-04-05

### Added

- **Profile-aware `/init` flow** — `/init` now follows active profile semantics: `full/plan/meta` updates `AGENTS.md`; `iosm` initializes and synchronizes both `AGENTS.md` and `IOSM.md`
- **AGENTS managed sync block for IOSM** — introduced deterministic managed section in `AGENTS.md` during IOSM init, preserving user-authored content outside the managed block

### Changed

- **IOSM init file sync contract** — `iosm init` now performs guaranteed create/update for both `AGENTS.md` and `IOSM.md` to avoid missing physical playbook files
- **Interactive init control flow** — added dedicated standard-init session tracking with explicit “already running” guard and interrupt-safe cancellation path
- **CLI init status output** — `iosm init` now reports per-file state for `AGENTS.md` and `IOSM.md` (`created/updated/skipped/unchanged`)

### Documentation

- Updated README release marker and highlights to `0.3.1`
- Updated `docs/getting-started.md` and `docs/interactive-mode.md` to document profile-scoped `/init` behavior

### Tests

- Expanded coverage for IOSM/AGENTS guide writers and profile-aware `/init` behavior in interactive and init test suites

## [0.3.0] - 2026-04-05

### Added

- **Unified framed message windows** — introduced consistent full-contour windows (`╭╮│╰╯`) with labels and padding for interactive conversation output
- **Input area redesign** — replaced the plain editor strip with a framed, mode-aware input box that reflects active mode (`input`, `command`, `bash`)
- **Reasoning preview stream UX** — added collapsed reasoning summary with live spinner animation during assistant streaming
- **Compact footer setting** — added configurable compact footer mode in settings and interactive selector

### Changed

- **Assistant response branding** — assistant window label now renders as `IOSM Agent`
- **Tool execution visuals** — migrated tool call/result rendering from filled background blocks to green-framed windows with consistent spacing
- **Orchestration panel visuals** — migrated orchestration status panel to orange-framed `IOSM Orchestration` window and aligned inner section header colors
- **Message surface consistency** — removed legacy filled-background user/orchestration/tool blocks in favor of border-first presentation

### Documentation

- Updated README release marker and release highlights to `0.3.0`

### Tests

- Added and expanded coverage for framed message/input rendering, assistant label updates, tool window framing, and orchestration panel presentation

## [0.2.17] - 2026-04-05

### Fixed

- **Startup crash after npm install** — fixed packaging regression where `dist/core/settings.schema.json` was not included in published artifacts, causing `ENOENT` on startup in some global installers (including Volta)
- **Settings schema load resilience** — added safe fallback validator path when settings schema file is missing or unreadable, so runtime no longer hard-crashes at import time

## [0.2.16] - 2026-04-05

### Added

- **Policy Engine v2** — added TOML-backed layered policy resolver with deterministic precedence and legacy compatibility bridge for existing permission rules
- **ACP mode** — added `--mode acp` adapter over RPC/event bus with capability negotiation and compatibility degradation handling
- **Tooling expansion** — added built-in `apply_patch`, `tool_search`, and `tool_suggest` tools
- **Unified execution runtime** — added PTY-capable unified execution support for interactive command sessions (`exec` + stdin streaming workflow)
- **Session resume indexing** — added indexed session lookup to avoid full filesystem scans on large session sets
- **Schema-driven settings docs pipeline** — added generated configuration docs and CI validation scripts for settings/schema drift detection

### Changed

- **Permission flow** — unified permission evaluation across interactive and RPC runtimes through policy-backed evaluator
- **Permission UX** — added turn-scoped and session-scoped approval behavior to reduce repeated prompts in ask mode while preserving safety controls
- **MCP governance** — enforced source trust checks and logged per-tool policy decision traces for MCP tool calls
- **Task UI in interactive mode** — task-state operations now render as structured checklists (`done / in progress / pending`) instead of raw JSON argument dumps
- **Package/tool security baseline** — install/update/extensions/tool-manager paths now use trust-ledger and source security checks (host allowlist, fingerprint/integrity, consent gates)
- **Linux sandbox execution** — added explicit opt-in sandbox path using `bwrap` with hard failure when required runtime is unavailable
- **Command rollback safety** — integrated filesystem checkpoint snapshot/restore with deterministic rollback ordering in command dispatch flow

### Documentation

- Updated README release marker and release highlights for `0.2.16`
- Added docs navigation entries for ACP mapping and generated configuration reference
- Refreshed configuration documentation from schema generation pipeline

### Tests

- Expanded coverage for policy engine behavior, ACP mode, apply_patch grammar/runtime, tool_search/tool_suggest flow, session index resume path, and unified execution runtime
- Revalidated interactive task-plan/task-checklist rendering and orchestration-related interactive regressions

## [0.2.15] - 2026-04-04

### Changed

- **Telegram stop/resume contour** — when bridge is stopped, Hub now switches to a dedicated stop-state action set (`Start`, `Refresh`, `Help`) instead of showing full active-run controls
- **Telegram quick keyboard state** — reply keyboard now also switches to stop-state layout (`Hub`, `Start`, `Help`) and restores full actions after resume
- **Telegram Hub navigation after restart** — `/start` now posts a fresh Hub card at the bottom of chat for immediate visibility

### Fixed

- **Telegram quick-action reliability** — removed over-aggressive quick-action debounce that could drop first button press and make actions appear to require a second tap
- **Slash command parsing in Telegram** — `/start@botname` and similar bot-suffixed slash commands now route correctly
- **Stopped-bridge menu routing** — command/model callbacks in stopped mode now return cleanly to Hub instead of leaving stale menu state

### Tests

- Revalidated telegram-related runtime changes with TypeScript check and interactive/command regression suites

## [0.2.14] - 2026-04-04

### Added

- **Telegram bridge mode** — added mobile remote-control runtime (`iosm telegram` / `--mode telegram`) with long-polling transport, single-operator allowlist guard, Control Hub navigation, live status updates, quick-action keyboard, model picker, and confirmation flow for dangerous tool calls
- **Headless built-in command dispatcher** — extracted built-in slash command execution into a shared dispatcher for non-TUI runtimes
- **RPC built-in command contract** — added `get_builtin_commands` and `run_builtin_command` RPC commands so external clients can invoke core slash commands without TUI routing
- **RPC permission events** — added `requires_confirmation` event and `confirm_permission` extension UI request contract for ask-mode tool confirmations in external clients
- **Subagent background run registry** — added persistent metadata/log tracking for background subagent execution with stop/stop-all/prune helpers and interactive command surface

### Changed

- **CLI mode surface** — expanded `--mode` to include `telegram` and added top-level `iosm telegram` alias command
- **RPC startup behavior** — RPC mode now starts without a preselected model so remote clients can choose model later (for example via Telegram `/model`)
- **Interactive subagent commands** — extended `/subagent-runs` with `bg` management commands (`list/running/queued/done/error/cancelled/status/logs/stop/stop-all/prune`)
- **Provider policy filtering** — disabled `google-antigravity` provider from auth/model/login catalogs and default model resolution in this build
- **Example set refresh** — removed deprecated `examples/extensions/antigravity-image-gen.ts` and updated extension example count

### Documentation

- Updated README integration/mode coverage with Telegram bridge examples and profile-based launch commands
- Updated `docs/cli-reference.md` with `--mode telegram` and `iosm telegram --profile ...` usage
- Updated `docs/configuration.md` with `telegram` settings schema (`enabled`, `botToken`, `allowedUserIds`, `transport`, `chatDefaults`)
- Updated `docs/rpc-json-sdk.md` with built-in command RPC calls and confirmation event/response protocol

### Tests

- Added command dispatcher coverage in `test/command-dispatcher.test.ts`
- Added subagent background run storage/control coverage in `test/subagent-background-runs.test.ts`
- Expanded RPC/interactive/settings/model/auth regressions for telegram mode wiring, built-in command dispatch, permission-mode/state handling, and provider policy filtering

## [0.2.13] - 2026-04-02

### Added

- **Interactive extension lifecycle commands** — added `/extensions` with `/ext` alias for `list`, `install`, `update`, `remove`, `enable`, `disable`, and `help` flows in interactive mode
- **Background prune command** — added safe cleanup support for old completed background process records via `/bg prune [hours]`
- **Git snapshot runtime context capture** — added bounded git snapshot composition (`status`, `diff --stat`, `diff --cached --stat`) wired into prompt context when enabled
- **Prompt-context setting for git snapshot size** — added `promptContext.gitSnapshotMaxChars` (default `2000`)

### Changed

- **Prompt context telemetry** — `system_prompt_context_compose` trace events now include git snapshot diagnostics (`git_snapshot_chars_before`, `git_snapshot_chars_after`, `git_snapshot_truncated`, `git_snapshot_max_chars`)
- **Background command UX** — `/bg` usage/help/menu now includes prune flow and clearer cleanup guidance
- **System prompt guidance** — root-agent guidance now includes explicit `/extensions` lifecycle routing for extension management requests

### Documentation

- Updated README version marker to `0.2.13`
- Updated `docs/interactive-mode.md` and `docs/cli-reference.md` with `/extensions` (`/ext`) and `/bg prune` command coverage
- Updated `docs/configuration.md` for `promptContext.gitSnapshotMaxChars` and bounded git snapshot behavior
- Updated `docs/sessions-traces-export.md` with expanded prompt-context trace event fields
- Refreshed `task.md` and `improvement-checklist.md` with v2 execution status and risky-feature rollout policy

### Tests

- Added git snapshot context tests in `test/system-prompt.test.ts`
- Added background prune coverage in `test/background-processes.test.ts`
- Added interactive command coverage for `/bg prune` and `/extensions` lifecycle paths in `test/interactive-mode-status.test.ts`

## [0.2.12] - 2026-04-01

### Changed

- **Startup command execution policy** — system prompt guidance now explicitly routes "start/run project", dev-server, and watcher requests to detached `bash` execution (`run_in_background=true`) by default, with foreground mode reserved for immediate-output needs
- **Subagent runtime capability hint** — delegated task prompts now include the same detached-startup guidance so child agents avoid blocking turns when launching persistent processes

### Documentation

- Updated README usage guidance to document default detached handling for project/server startup requests
- Updated `docs/cli-reference.md` and `docs/interactive-mode.md` with explicit startup-to-background behavior and `/bg` follow-up flow

### Tests

- Added system-prompt regression asserting explicit startup background guidance (`run_in_background=true`, `/bg status|logs|stop`)
- Expanded subagent orchestration tests to assert delegated runtime hints include startup/background routing rules

## [0.2.11] - 2026-04-01

### Added

- **Prompt context preprocessing controls** — added deterministic `promptContext` pipeline (`normalize -> dedupe -> per-file cap -> total cap`) with optional git snapshot plumbing and context preprocessing trace metrics
- **Background shell process runtime** — added persistent detached process manager with metadata/log tracking under `.iosm/background/processes`
- **Interactive background command surface** — added `/bg` command family (`list`, `status`, `logs`, `stop`) and detached shell submission syntax via `! <command> &`
- **Bash detached execution parameter** — added `run_in_background` support in built-in `bash` tool and session-level bash execution path with returned `backgroundTaskId`/status/log metadata
- **Extension tool permission tiers** — added optional `requiredPermission` metadata (`read-only`, `workspace-write`, `danger-full-access`) for extension tools and runtime propagation through permission flow
- **Subagent tool-name normalization** — added normalization/filtering for custom agent `tools` and `disallowed_tools` (lowercase, `-` -> `_`, unknown removal with diagnostics)

### Changed

- **Permission flow unification** — consolidated tool permission evaluation for built-ins and extensions with tier/source-aware request metadata and stricter extension enforcement branch behind `permissions.extensionToolEnforcement` (default off)
- **Compaction continuation framing** — compaction summary prefix now explicitly instructs continuation from current state without full recap unless user asks
- **System prompt guidance updates** — bash guidance now includes detached execution usage (`run_in_background`) for long-running non-blocking commands

### Documentation

- Updated README header/version marker to `0.2.11`
- Updated interactive/CLI/configuration/session-trace/orchestration docs with:
  - background process workflow (`! ... &`, `/bg`)
  - `promptContext` settings and defaults
  - extension permission tier semantics and `permissions.extensionToolEnforcement`
  - subagent frontmatter tool normalization behavior
- Updated extension authoring docs with `requiredPermission` examples for `registerTool`

### Tests

- Added `test/background-processes.test.ts` coverage for start/list/log-tail/stop lifecycle
- Added interactive `/bg` coverage in `test/interactive-mode-status.test.ts`
- Added `run_in_background` coverage for `bash` in `test/tools.test.ts`
- Expanded regressions for context preprocessing, extension permission-tier behavior, compaction continuation framing, and subagent tool normalization

## [0.2.10] - 2026-03-18

### Added

- **`/ultrathink` built-in command** — added deep multi-iteration analysis mode with robust slash parsing (`-q`/`--iterations`, `--` separator), context-aware no-query fallback, and shared behavior through `AgentSession.prompt` across interactive/print/json/rpc flows
- **Ultrathink checkpoint engine** — added structured checkpoint state (`Goal`, `Verified Facts`, `Rejected Hypotheses`, `Open Questions`, `Next Checks`) with carry-forward summaries and checkpoint compression support for long runs
- **Ultrathink read-only execution policy** — added strict temporary read-only tool filtering during ultrathink runs with guaranteed restoration of the original active tool set
- **Ultrathink evidence/runtime tests** — added dedicated parser and session-flow test suites covering iteration loops, no-query objective resolution, streaming guards, budget/stagnation paths, evidence-policy fallback, and tool-set restoration

### Changed

- **Ultrathink runtime hardening** — added budget guardrails (per-iteration input, run input/total tokens, run cost), stagnation early-stop behavior, and evidence-catalog carry-forward between passes
- **Ultrathink anti-hallucination policy** — added quantitative-claim evidence tagging rules, verify/synthesis no-new-evidence marker handling, and compliance-repair pass support
- **Ultrathink grounding behavior** — when early passes produce no tool evidence, runtime now injects an internal grounding retry that explicitly forces live read-only workspace probes before continuing
- **Interactive slash UX** — added `/ultrathink` to built-in slash registry and interactive autocomplete argument hints (`-q`, `--iterations`, common iteration counts)

### Fixed

- **Ultrathink hard-stop on evidence mismatch** — repeated evidence-policy mismatch no longer aborts the entire command; runtime now degrades gracefully and returns a best-effort final response instead of throwing
- **Internal prompt visibility leakage** — ultrathink internal retries (iteration/grounding/policy-repair prompts) are now consistently routed through hidden orchestration aliases, so users see clean progress text instead of raw directives
- **Budget accounting with internal retries** — per-iteration budget checks now account for cumulative input tokens across the main pass plus internal retry prompts

### Documentation

- Updated README header/version marker to `0.2.10`
- Added `/ultrathink` command coverage to interactive and CLI references, including read-only behavior, context fallback, and grounding-retry semantics

### Tests

- Added `test/ultrathink.test.ts` parser/validation coverage for `/ultrathink`
- Added `test/agent-session-ultrathink.test.ts` runtime coverage for q-iteration flow, early-stop, budget-cutoff, no-query fallback, evidence-policy graceful fallback, and restoration guarantees
- Expanded semantic regressions to assert `/ultrathink` built-in slash discoverability

## [0.2.9] - 2026-03-15

### Added

- **Structured verification/data tools** — added built-in `test_run`, `lint_run`, `typecheck_run`, and `db_run` with runner/adapter auto-detection, normalized statuses, bounded output capture, and tool-registry/SDK exports
- **DB runtime settings layer** — added `dbTools` settings (`defaultConnection`, named `connections`, adapter-specific fields, migrate script options) wired into session/runtime resolution for `db_run`
- **Universal terminal theme** — added built-in `universal` theme and made it the default/fallback theme for interactive mode
- **Protocol and stall auto-repair flow** — added bounded automatic recovery for raw pseudo tool markup and silent stop responses, including interactive recovery actions (retry, repeat prompt, switch model + retry, keep session)

### Changed

- **Profile tool policy expansion** — enabled `test_run`, `lint_run`, `typecheck_run`, and `db_run` across write-capable engineering profiles (`full`, `meta`, `iosm`); enabled `typecheck_run` for `iosm_verifier`
- **Interactive UX readability pass** — updated dark/light palettes, introduced universal box colors, and normalized box paddings/section spacing for user/custom/tool/plan/subagent/summary messages
- **System prompt hardening** — added explicit guidance for structured verification/data tools, instruction-priority handling, untrusted tool-output/web-content handling, completion checks before final success claims, and stricter pseudo-markup prohibition
- **Doctor diagnostics coverage** — expanded interactive `/doctor` CLI-toolchain checks to include verification and DB client commands used by new structured tools

### Fixed

- **Abort continuation wording** — when user interrupts execution, recovery selector now shows a user-action title (`You stopped the current run`) instead of model-failure wording
- **Protocol false positives** — inline explanatory mentions like `raw <tool_call>/<function=...> markup` no longer trigger protocol auto-repair; only executable-looking pseudo-blocks are repaired
- **Dark theme contrast in boxes** — fixed low-contrast text-on-dark-box cases for user/custom/tool blocks

### Documentation

- Updated README header/version marker to `0.2.9`
- Updated CLI/config/interactive/development docs with `test_run`/`lint_run`/`typecheck_run`/`db_run`, profile policy updates, `dbTools` configuration, and `/doctor` toolchain scope

### Tests

- Added dedicated tool coverage for `test_run`, `lint_run`, `typecheck_run`, and `db_run`
- Added protocol auto-repair and recovery-selector coverage in interactive/session tests (raw markup, silent stop, false-positive guard, model-switch recovery)
- Expanded regressions for profiles, SDK exports, settings manager, shadow guard, system prompt guidance, and theme defaults/colors

## [0.2.8] - 2026-03-14

### Added

- **`web_search` built-in tool** — added structured web discovery with provider chaining (`Tavily -> SearXNG -> DuckDuckGo`), include/exclude domain filters, recency/topic/depth hints, runtime configuration hooks, and permission-guard integration
- **`git_write` built-in tool** — added structured git mutation actions (`add`, `restore`, `reset_index`, `commit`, `switch`, `branch_create`, `fetch`, `pull`, `push`, `stash_push`, `stash_pop`, `stash_apply`, `stash_drop`, `stash_list`) with action-specific validation, permission-guard integration, and safe argv execution (no raw shell passthrough)
- **GitHub tools settings** — added persistent `githubTools` settings block (`networkEnabled`, `token`) and interactive settings submenu for enabling git network actions and managing GitHub token
- **Expanded `git_read` actions** — added read-only actions `show`, `branch_list`, `remote_list`, and `rev_parse` while preserving backwards compatibility for existing `status`, `diff`, `log`, and `blame` contracts

### Changed

- **Shared git tool runtime** — consolidated git process execution/capture/truncation/error handling into a common internal helper used by `git_read` and `git_write`
- **Profile and mutation policy updates** — enabled `git_write` by default in write-capable profiles (`full`, `meta`, `iosm`), included `web_search` in read-oriented profiles, and updated mutation classification in task/shadow-guard checks
- **System prompt and tool-routing guidance** — added explicit guidance to prefer `git_write` over ad-hoc git bash mutations and to use `web_search` for discovery plus `fetch` for source validation
- **CLI/SDK tool surface expansion** — updated tool registry, factories, and exports to include `web_search` and `git_write` in all relevant creation paths and public SDK/index entrypoints
- **Settings/runtime wiring** — threaded web search runtime config (provider/fallback/safe-search/max-results/timeout/credentials) and GitHub network/token policy from settings into tool execution
- **Interactive menu hint UX polish** — normalized selector/menu control hints across settings, model/oauth/MCP selectors, tree/session views, and config/model-scoping panels for consistent navigation/action/search/exit guidance

### Documentation

- Updated README header/version marker to `0.2.8`
- Updated CLI/config/interactive/development/RPC docs for `web_search` behavior, `git_write` network actions, GitHub tools settings (`networkEnabled`, `token`), and expanded `git_read` action coverage
- Updated help text and tool listings to reflect the new structured git/web workflow (`web_search` + `fetch`, `git_read` + `git_write`)

### Tests

- Added dedicated `web_search` and `git_write` tool coverage, plus expanded `git_read` tests for new actions (`show`, `branch_list`, `remote_list`, `rev_parse`)
- Added/updated regression checks for profile tool membership, SDK defaults, settings manager behavior, system prompt guidance, shadow-guard/task classification, and settings/menu hint behavior

## [0.2.7] - 2026-03-14

### Added

- **`fetch` built-in tool** — added structured HTTP tool with fields `url`, `method`, `headers`, `body`, `timeout`, `max_bytes`, `response_format`, `max_redirects`; includes manual redirect loop control, bounded body capture, and `auto` JSON/text formatting by `content-type`
- **`git_read` built-in tool** — added read-only structured git introspection actions (`status`, `diff`, `log`, `blame`) with action-specific validation and safe argv execution (no raw shell passthrough)
- **`fs_ops` built-in tool** — added structured filesystem mutation tool (`mkdir`, `move`, `copy`, `delete`) with explicit `recursive`/`force` safety gates and `EXDEV` move fallback (`copy + delete`)
- **SDK/public exports for new tools** — exported factories, tool singletons, and typed input/options/details surfaces for `fetch`, `git_read`, and `fs_ops`

### Changed

- **Profile tool policy expansion** — `fetch` and `git_read` are now included in read-only exploration profiles; `fs_ops` is included in write-capable engineering profiles (`full`, `meta`, `iosm`)
- **Dynamic `fetch` method policy by active profile** — read-only profiles (`explore`, `plan`, `iosm_analyst`) allow only `GET|HEAD|OPTIONS`; write-capable profiles allow full method set (`GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS`)
- **Unified tool permission/pre-hook integration** — `fetch` and `fs_ops` now pass through the same session permission and pre-tool hook pipeline used by write-capable built-ins
- **Mutation classification updates** — `fs_ops` is now classified as mutating in shadow guard and task write-capable tool checks

### Documentation

- Updated CLI help, system prompt tool guidance, and docs pages to include `fetch`, `git_read`, and `fs_ops` with usage/policy notes
- Updated profile/tool tables and architecture snippets to reflect the expanded built-in tool layer

### Tests

- Added dedicated coverage for `fetch`, `git_read`, and `fs_ops`
- Added regression assertions for profile membership, read-only/write-capable classification, shadow guard behavior, and CLI help/tool listings

## [0.2.6] - 2026-03-14

### Added

- **Shared memory scope policy** — new `IOSM_SHARED_MEMORY_SCOPE_POLICY` environment variable (`legacy` / `warn` / `enforce`) controls how missing scope arguments are handled in `shared_memory_read` / `shared_memory_write`; `meta` profile automatically activates `warn` mode so omitted scopes surface a warning in tool output and details
- **Shared memory usage analytics** — new `summarizeSharedMemoryUsage()` API aggregates write counts by scope, unique writers, unique keys, and per-task/delegate breakdown for observability in orchestrated runs
- **Nested delegation detection** — `promptMetaWithParallelismGuard` now tracks `nestedDelegationMissing`: when top-level fan-out is satisfied but no nested delegates were observed for multi-stream tasks, the parallelism correction prompt and TUI warning fire explicitly
- **Workstream semantic deduplication** — `semanticallyDeduplicateWorkstreamTitles()` uses Jaccard token similarity (threshold 0.82) to eliminate near-duplicate delegate workstream titles before dispatch
- **Duplicate delegated section detection** — `detectDuplicateDelegatedSections()` compares normalized section bodies to catch copy-pasted or near-identical delegate blocks with ≥92% coverage overlap
- **Workstream title uniquification** — `uniquifyWorkstreamTitles()` appends ordinal suffixes to disambiguate repeated titles in fan-out plans
- **Coordination details in task tool output** — `TaskToolDetails` now surfaces a `coordination` object with `sharedMemoryWrites`, `currentTaskWrites`, `currentTaskDelegateWrites`, `runScopeWrites`, `taskScopeWrites`, `duplicatesDetected`, `claimKeysMatched`, and `claimCollisions` fields for post-run auditing
- **Swarm progress shared memory integration** — TUI swarm progress reporter now reads `results/` prefix keys from shared memory to enrich per-task summary display with delegated totals

### Changed

- **META profile evidence policy** — `meta` profile system prompt and subagent task prompt now require that metrics (speedup, compliance scores, conflict counts) are backed only by observed runtime evidence; unknown values must be marked as `unknown` rather than inferred
- **META profile artifact claims** — `meta` and meta-subagent prompts now prohibit claiming report files or artifacts exist unless they were produced in the current run or verified on disk
- **`resolveScope` replaces `normalizeScope`** — shared memory tool's scope defaulting logic refactored into `resolveScope()` with policy-aware warning output and `enforce` mode that throws on missing explicit scope
- **`completedTaskToolCalls` tracking** — parallelism guard now separately tracks completed (resolved) task calls so nested delegation assessment waits for actual task completion rather than firing prematurely on partial state

### Fixed

- **False nested-delegation compliance** — guard no longer silently passes when top-level fan-out count is met but zero nested delegates exist inside multi-stream tasks; correction prompt now fires
- **Scope warning surface** — `shared_memory_write` and `shared_memory_read` tool results now include `scopePolicy` and `scopeWarning` in their `details` payload for agent-side introspection

### Documentation

- **README redesign** — complete rewrite with professional positioning, IOSM methodology section with 4-phase table and 6 metrics, architecture ASCII diagram, profile split into primary/specialist, integration modes with CI row, extensibility as runtime platform, accurate install/extension syntax from docs

## [0.2.5] - 2026-03-13

### Added

- **Orchestrate parallel fan-out defaults** — `/orchestrate --parallel` now auto-sets `--max-parallel` to the selected agent count when omitted, reducing accidental single-lane execution
- **Parallel worker profile auto-selection** — when no worker profile is provided in parallel orchestration, assignments default to `meta` in write-capable host contexts for stronger orchestration behavior
- **Delegate hint propagation for orchestrate assignments** — assignment generation now injects `delegate_parallel_hint` guidance to drive nested delegate fan-out inside child tasks
- **Swarm dispatch timeout controls** — scheduler now supports bounded dispatch timeouts (including `IOSM_SWARM_DISPATCH_TIMEOUT_MS`) to avoid silent long stalls
- **Interactive swarm progress surfaces** — improved live subagent task/delegate progress rendering and swarm-aware footer busy state in TUI

### Changed

- **Task profile defaulting** — task tool now defaults missing `profile` to current host profile (fallback `full`) instead of always forcing `full`
- **Delegation depth baseline** — max delegation depth default increased to `2` for better nested decomposition capacity
- **Shared memory read behavior** — `shared_memory_read` now returns metadata-only by default (`include_values=false`) with safe value preview details when requested
- **Swarm planning fan-out quality** — planner now prioritizes code-relevant touches and partitions work into multiple workstreams more aggressively for parallel execution
- **Singular run id generation** — `/singular` run ids now include milliseconds and random suffix for collision-resistant rapid runs

### Fixed

- **Dependent-task dead-end behavior** — scheduler now marks downstream tasks as blocked when dependencies fail, preventing ambiguous pending states
- **Status update loss under file lock contention** — team task status writes now queue and retry asynchronously instead of being dropped during temporary lock conflicts
- **Steering skip false errors** — parallel task agent no longer marks steering-driven tool skips as execution errors
- **Swarm-from-singular startup guard** — execution now fails fast with a clear warning if no active model is configured
- **Strict delegation in orchestrated contexts** — nested delegation contract now also applies in run/task orchestrated contexts when delegate hints indicate required fan-out

### Documentation

- Updated README to `v0.2.5` and added a focused "What's New in v0.2.5" section
- Expanded orchestration docs (`interactive-mode`, `cli-reference`, `orchestration-and-subagents`) with `/orchestrate` parallel defaults and delegation guidance

## [0.2.4] - 2026-03-12

### Added

- **META profile onboarding UX** — switching to `meta` now shows an explicit runtime hint describing orchestration-first usage and when to switch back to `full`
- **META interruption fallback hint** — when a run ends without any assistant message in `meta`, the UI now emits a recovery warning with concrete prompt guidance
- **Task host-profile runtime getter** — task tool integration now supports dynamic host profile reads (`getHostProfileName`) so orchestration pressure follows live profile changes during a session

### Changed

- **META directive policy (chat-safe classification)** — meta orchestration directive now explicitly classifies non-repository prompts as direct chat responses and limits orchestration rules to actionable repository work
- **META profile system prompt alignment** — profile-level prompt now mirrors the chat-safe classification behavior to avoid conflicting orchestration instructions
- **Internal orchestration metadata aliasing** — hidden orchestration UI metadata now always persists display aliases (including streaming paths) for safer prompt display substitution

### Fixed

- **Profile switch propagation into task orchestration** — runtime profile changes now propagate through session config-change events and task-tool host-profile resolution
- **Invisible assistant responses in meta chat prompts** — assistant prose suppression no longer triggers for `META_ORCHESTRATION_DIRECTIVE` metadata (suppression remains for legacy `ORCHESTRATION_DIRECTIVE` blocks only)
- **Meta interruption messaging consistency** — differentiated interruption guidance now appears for both assistant-level abort/error and run-level early termination scenarios

### Documentation

- Updated README version markers and added a dedicated **Modes At A Glance** block
- Added explicit **META model requirements** guidance (modern models, large context windows, high output limits) in README, CLI reference, interactive mode docs, and configuration docs

## [0.2.3] - 2026-03-11

### Fixed

- **Startup model restore after restart** — `createAgentSession()` now hydrates missing saved provider/model definitions from `models.dev` before resolving default model, so previously selected providers such as coding-plan providers are restored automatically on relaunch
- **Stale startup warning suppression** — interactive startup no longer shows stale `No models available...` warning when model restore succeeds during session initialization
- **Restart UX consistency** — startup header and active session state now align with restored saved `provider/model` selection without requiring manual `/model` re-selection

## [0.2.2] - 2026-03-11

### Added

- **Models.dev provider+model catalog runtime** — added full catalog parsing (providers + models metadata) with timeout/fallback behavior for interactive auth/model flows
- **Automatic provider model hydration after `/login`** — when a provider has credentials but no built-in model definitions, `iosm-cli` now registers models from `models.dev` so `/model` is immediately usable (including coding-plan providers such as `zai-coding-plan`)
- **Startup/on-demand auth model hydration** — `/model` now attempts to hydrate missing models for saved authenticated providers before rendering provider/model choices

### Changed

- **Provider/model visibility in status line** — footer and model-switch status now display `provider/model` to make cross-provider switches explicit even when model IDs are identical
- **Auth UX feedback** — login flow now reports a clear warning when credentials are stored but no models can be loaded yet

### Fixed

- **API-key login crash** — fixed unbound registry method usage that caused `TypeError: Cannot read properties of undefined (reading 'models')` in interactive login flows
- **Empty model selector after provider login** — fixed cases where `/model` stayed empty after successful API-key auth for providers not shipped in the built-in registry

### Documentation

- Updated README and docs (`getting-started`, `interactive-mode`, `configuration`) to reflect full models.dev-backed provider/model availability via `/login` and `/model`

## [0.2.1] - 2026-03-11

### Added

- **Run/task shared memory runtime** — introduced `.iosm/subagents/shared-memory/*.json` state with versioned entries and history for cross-task coordination
- **Shared memory tools** — added `shared_memory_write` and `shared_memory_read` tools for subagent orchestration (`run` and `task` scopes, CAS support, append/set modes)
- **Canonical `/swarm` command surface** — added dedicated runtime commands: `/swarm run`, `/swarm from-singular`, `/swarm watch`, `/swarm retry`, `/swarm resume` (with bounded parallelism and budget controls)
- **Swarm scheduler reliability modules** — added dedicated scheduler/locks/gates/state-store/spawn/retry components for stable multi-task dispatch under contention
- **Swarm lock + gate execution model** — introduced hierarchical touch locks and contract-aware task/run gates for `Scopes -> Touches -> Locks -> Gates -> Done`
- **Swarm runtime artifacts** — added persisted run state in `.iosm/orchestrate/<run-id>/` (`run.json`, `dag.json`, `state.json`, `events.jsonl`, checkpoints, reports)
- **Swarm watch telemetry** — added runtime visibility for ready/running/blocked/done distribution, budget usage, lock snapshot, ETA/throughput, critical path, and theoretical speedup
- **Swarm spawn policy controls** — added high-risk spawn candidate classification with confirmation-gated fan-out behavior
- **Project index subsystem** — introduced repository indexing (`.iosm/project-index/index.json`) for scale-aware planning and targeted file selection
- **Failure retrospective engine** — added failure-cause classification and retry directive generation for smarter follow-up attempts

### Changed

- **Swarm-first orchestration flow** — `/singular` execution handoff now supports `Start with Swarm (Recommended)` and routes selected options to `/swarm from-singular ...`
- **Command separation** — `/orchestrate --swarm` removed; `/swarm` is now the canonical gated runtime while `/orchestrate` remains manual legacy team splitting
- **Task orchestration contract** — `task` tool/runtime now carries richer run/task metadata and improved scheduling context for delegated execution
- **Interactive swarm observability** — expanded interactive mode status/watch output with deeper swarm runtime diagnostics and task progress details

### Fixed

- **Swarm retry stability** — improved retry bucket handling (`permission`, `dependency/import`, `test`, `timeout`, `unknown`) to reduce noisy re-runs
- **Lock/contention handling** — improved execution behavior for conflicting touches and blocked tasks in DAG scheduling scenarios

### Documentation

- Expanded README, CLI reference, interactive mode, and orchestration docs for swarm runtime semantics, shared-memory collaboration, and reliability controls

## [0.2.0] - 2026-03-11

### Added

- **Interactive engineering contract manager (`/contract`)** — field-by-field contract editing with immediate save-on-enter and automatic JSON generation for project scope
- **Layered contract model** — explicit `project`, `session`, and `effective` contract layers with copy/delete flows and merged runtime enforcement
- **Singular feasibility mode (`/singular`)** — command-first feasibility analysis that combines repository baseline scan with a standard agent pass and returns exactly three implementation options
- **Option-driven execution handoff** — `/singular` now produces concrete file targets, step plans, trade-offs, and decision guidance before implementation starts
- **Regression coverage for large paste UX** — multiline unbracketed paste now covered by dedicated tests to ensure one submission flow and compact marker rendering

### Changed

- **Feasibility workflow naming** — `/blast` replaced by `/singular` for feature feasibility decisions
- **Profile cleanup** — `/shadow` workflow removed to avoid duplication with plan-oriented analysis
- **Contract interaction model** — removed extra save step in field editor; entering value immediately persists to selected scope

### Fixed

- **TUI width safety** — startup resources block now truncates long lines to terminal width, preventing render crashes on narrow terminals
- **Paste queue behavior** — large pasted multiline input is treated as a single paste event instead of fragmented queued submissions

### Documentation

- Expanded README with dedicated decision workflow section (`/contract` vs `/singular`), command migration notes, and clearer contract layer distinctions
- Extended interactive mode docs with explicit `effective/session/project` explanations and migration guidance from removed commands
- Updated CLI reference with interactive feasibility/contract command behavior and migration notes

## [0.1.3] - 2026-03-10

### Added

- **Semantic search runtime** — Added built-in `semantic_search` tool (`index`, `query`, `status`, `rebuild`), interactive `/semantic` manager, and top-level `iosm semantic` command
- **Semantic setup UX upgrades** — Added provider model discovery (OpenRouter/Ollama) and setup-flow guidance for optional fields
- **Search/analysis toolchain expansion** — Added separate built-in tools: `rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`
- **Doctor CLI diagnostics for tools** — `/doctor` now reports external CLI toolchain availability (`rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`) in text and JSON output
- **CLI entry point** — Standalone `iosm` binary with full argument parsing
- **Interactive mode** — Multi-turn terminal agent with keyboard-driven controls
- **Print mode** — One-shot `iosm -p` for scripting and CI
- **JSON stream mode** — Machine-readable `--mode json` event output
- **RPC mode** — stdio JSON-RPC server for IDE integrations
- **Built-in tools** — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `rg`, `fd`, `ast_grep`, `comby`, `jq`, `yq`, `semgrep`, `sed`
- **Multi-provider support** — Anthropic, OpenAI, Gemini, Groq, Cerebras, xAI, OpenRouter, Mistral, AWS Bedrock, Azure OpenAI, and more
- **Model cycling** — `--models` flag and `Ctrl+P` for model rotation
- **Thinking levels** — `--thinking off|minimal|low|medium|high|xhigh`
- **Agent profiles** — `full`, `plan`, `iosm` + advanced profiles (`explore`, `iosm_analyst`, `iosm_verifier`, `cycle_planner`)
- **IOSM workspace** — `iosm init` bootstraps `iosm.yaml`, `IOSM.md`, `.iosm/` artifacts
- **IOSM cycles** — `iosm cycle plan|report|status|list` for systematic improvement
- **IOSM metrics** — Six canonical metrics (semantic, logic, performance, simplicity, modularity, flow) with IOSM-Index
- **Subagent orchestration** — Parallel/sequential delegation with `/orchestrate`
- **Custom agents** — Markdown agent definitions in `.iosm/agents/`
- **Extension system** — TypeScript extensions with tools, commands, hooks, and UI
- **Skills** — Markdown workflow modules
- **Prompt templates** — Reusable prompt snippets as slash commands
- **Themes** — JSON TUI theme customization
- **Package manager** — `iosm install|remove|update|list` from npm/git/local
- **Session persistence** — Automatic session saving and recovery
- **Session branching** — `/tree`, `/fork` for conversation tree navigation
- **HTML export** — `/export` with themed, self-contained HTML output
- **Session sharing** — `/share` via GitHub Gists
- **Session trace** — `--session-trace` for full JSONL audit logging
- **Context compaction** — Automatic context summarization when approaching limits
- **File attachments** — `@file` syntax for including files in prompts
- **Programmatic SDK** — `createAgentSession()` for embedding in custom apps
- **Keybinding customization** — `~/.iosm/agent/keybindings.json`
- **OAuth support** — `/login` for provider authentication
- **Permission controls** — `/permissions` and `/yolo` for tool approval management

### Changed

- Switched from monorepo `tsgo` scripts to standalone `tsc`-based build system
- Promoted CLI source, docs, examples, and tests to repository root

### Documentation

- Comprehensive README with feature showcase, provider reference, and examples
- 10 detailed documentation files covering all features
- CONTRIBUTING.md with development setup and PR guidelines
- 66 extension examples with categorized README
- 12 SDK examples with quick reference guide

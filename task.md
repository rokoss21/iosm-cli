# iosm-cli research + implementation task (v2)

Date: 2026-04-02  
Reference baseline was reviewed from local clone at `/private/tmp/claw-code-ref`.

## Current status (already implemented)

1. Prompt context preprocessing with deterministic pipeline:
- normalize -> dedupe -> per-file cap -> total cap -> metadata

2. Extension tool permission tiers:
- `requiredPermission` for extension tools
- unified permission propagation for built-in + extension tools
- strict extension enforcement is feature-flagged

3. Subagent tool-name normalization:
- normalized `tools` / `disallowed_tools`
- unknown names filtered with diagnostics (non-fatal)

4. Compaction continuation framing:
- explicit continuation guidance after compaction summary

5. Background detached execution + interactive manager:
- detached bash runs and `/bg` command family

6. OpenRouter model/cost work:
- OpenRouter live catalog hydration path
- usage cost fallback when provider cost payload is missing/zero

## Completed in this v2 iteration

1. Runtime git snapshot context composition is implemented (bounded, flag-gated).
2. Interactive extension lifecycle UX is implemented (`/extensions`, `/ext`).
3. Background runtime/UX polish is implemented, including safe prune flow.
4. OpenRouter/cost stabilization path is validated for footer + session stats consistency.

## Remaining operational step (not code gap)

1. Staged production rollout for risky toggles (shadow -> partial -> full), with explicit operator confirmation before enablement.

## Locked implementation direction

1. Keep all risky behaviors default-off:
- `permissions.extensionToolEnforcement=false`
- `promptContext.enableGitSnapshotContext=false`

2. Preserve backward compatibility:
- no breaking changes to existing package and slash command behavior

3. No source/reference attribution in code comments, commits, or changelog text.

## Execution order

1. Sync audit artifacts (`task.md`, `improvement-checklist.md`)
2. Stabilize OpenRouter/cost path consistency
3. Implement bounded runtime git snapshot context + trace fields
4. Implement `/extensions` + `/ext` lifecycle UX
5. Polish `/bg` runtime and add safe pruning flow
6. Run regression checks, then update version/changelog/docs

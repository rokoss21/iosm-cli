# iosm-cli Improvement Checklist (v2)

## Phase 0: Audit sync
- [x] Refresh `task.md` with current implemented baseline and remaining gaps.
- [x] Refresh checklist structure with explicit execution order.
- [x] Record risky-feature gate policy (`default-off`, staged rollout only).

## Phase 1: OpenRouter/cost stabilization
- [x] Ensure cost fallback is shared by session stats and footer rendering.
- [x] Keep OpenRouter live catalog hydration path with models.dev fallback.
- [x] Add final doc/changelog notes for stabilized cost behavior.

## Phase 2: Git snapshot prompt context (flag-gated)
- [x] Add runtime git snapshot capture (`status` + `diff --stat` + `diff --cached --stat`).
- [x] Bound git snapshot chars before prompt composition.
- [x] Pass git snapshot through system-prompt pipeline only when enabled.
- [x] Add session trace diagnostics for git snapshot size/truncation.
- [x] Add/adjust tests for git snapshot include/disable behavior.

## Phase 3: Extension lifecycle UX
- [x] Add `/extensions` command handling with `/ext` alias.
- [x] Add lifecycle subcommands: `list`, `install`, `update`, `remove`, `enable`, `disable`, `help`.
- [x] Route install/update/remove through existing `PackageManager`.
- [x] Implement non-destructive enable/disable toggles (package source + path override).
- [x] Add/adjust interactive tests for lifecycle command behavior.

## Phase 4: Background UX/runtime polish
- [x] Add safe background prune API for old completed records.
- [x] Expose prune in `/bg` command flow and interactive menu.
- [x] Improve help/usage surface to include prune flow.
- [x] Add/adjust tests for prune behavior.

## Phase 5: Release hygiene
- [x] Run `npm run check` + targeted regression suites.
- [x] Bump version to next patch.
- [x] Update `CHANGELOG.md`.
- [x] Update docs (`README`, `docs/cli-reference.md`, `docs/interactive-mode.md`, `docs/configuration.md`, session trace docs).
- [x] Keep risky flags `default-off` and document staged rollout requirement.

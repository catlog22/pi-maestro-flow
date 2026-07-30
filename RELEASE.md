# v0.10.0 — Compaction Capacity Management, API Retry Settings, Resilient Teammate Retry

## Overview

This release hardens the compaction pipeline against context-window overflow, adds user-facing API retry configuration, and makes teammate retry substantially more resilient. Compaction now derives a linked threshold across both the session model and the configured summary model, budgets summary output tokens against actual capacity, and falls back gracefully when a model cannot fit the checkpoint. The API provider manager gains a `retry` action with persistent settings. Teammate retry policy is widened (12 attempts, 10-minute ceiling), a persistence guard prevents child agents from polluting `settings.json`, and the cockpit shows live retry countdowns.

The release publishes all three workspaces. `pi-maestro-teammate` moves from `1.1.0` to `1.2.0`, `pi-cockpit` moves from `0.3.0` to `0.4.0`, and `pi-maestro-flow` moves from `0.9.0` to `0.10.0` and pins both updated sibling packages. The external core engine `maestro-flow` pin is unchanged at `0.5.58` (verified aligned with npm latest before release).

## Package Versions

| Package | Previous | New | Install |
|---------|----------|-----|---------|
| `pi-maestro-teammate` | 1.1.0 | 1.2.0 | `npm i pi-maestro-teammate@1.2.0` |
| `pi-cockpit` | 0.3.0 | 0.4.0 | `npm i pi-cockpit@0.4.0` |
| `pi-maestro-flow` | 0.9.0 | 0.10.0 | `npm i pi-maestro-flow@0.10.0` |

`pi-maestro-flow@0.10.0` depends on `pi-maestro-teammate@1.2.0`, `pi-cockpit@0.4.0`, and `maestro-flow@0.5.58`.

## Detailed Changes

### Compaction capacity management (`packages/pi-maestro-flow/src/compaction/`)

- **Linked threshold derivation** (`compaction-threshold.ts`, +56): `deriveLinkedCompactionThreshold` computes the earliest safe trigger across both the active session model and the configured compaction summary model. The summary side reserves only the output budget the compaction request actually sends (`summaryOutputTokenLimit`, 80% of reserve capped by model max), rather than the model's full general-purpose response limit. A `limiter` tag (`"session"` | `"compaction"`) records which model governs the trigger.
- **Summary output budget** (`maestro-compaction.ts`, +159): `fitSummaryOutputBudget` checks that the estimated request tokens plus a 4 096-token safety margin leave at least 1 024 output tokens. When the configured compaction model cannot fit the checkpoint, the system falls back to the current session model with a warning instead of failing silently. `CompactionCapacityError` is surfaced to the caller rather than swallowed. `estimateSummaryRequestTokens` uses a conservative mixed-encoding heuristic (2.5 ASCII chars/token, 1.5 tokens/CJK char).
- **Auto-compaction integration** (`auto-compaction.ts`, +76): the mid-turn auto-compaction lifecycle now resolves the linked threshold at session start and uses the governing capacity window for all trigger comparisons. The compaction model setting is threaded through `CompactionSettings`.
- **TUI capacity display** (`tui/compaction-settings.ts`, +103): the threshold editor shows the output budget, capacity source label, and linked-threshold validation. Threshold editing validates against the governing model's window rather than always assuming the session model.
- Tests: `test/compaction.test.ts` (+118), `test/compaction-tui.test.ts` (+15).

### API retry settings (`packages/pi-maestro-flow/src/providers/`)

- **Retry configuration** (`api-provider-config.ts`, +184): new `retry` action in the API provider manager lets users view and toggle API retry behavior (enabled/disabled, max retries up to 12). Settings persist to `settings.json` under a `retry` key. `ensureApiRetryDefaults` initializes defaults on `session_start`. `loadApiRetrySettings` / `saveApiRetrySettings` provide programmatic access.
- Tests: `test/api-provider-config.test.ts` (+119).

### Companion package registration (`packages/pi-maestro-flow/scripts/`)

- **Improved dedup** (`register-companion-packages.mjs`, +43): prunes duplicate package names while preserving the first configured source; skips nested companions when a workspace source is already configured.
- Tests: `test/register-companion-packages.test.mjs` (+56).

### Teammate retry resilience (`packages/pi-maestro-teammate/`)

- **Wider retry policy** (`src/runs/retry.ts`): `maxRetries` 5 → 12, `maxDelayMs` 16 s → 10 min. Network error regex expanded with `connection error/failed/failure/reset/refused/timed out/timeout/closed` patterns.
- **Retry persistence guard** (`src/runs/execution.ts`, +110): `acquireRetryPersistenceGuard` snapshots `settings.json` before child agents issue `set_auto_retry` RPCs and restores the original value after all concurrently starting children have acknowledged. Prevents session-local retry overrides from being persisted to disk. Reference-counted with a 250 ms settle timer for concurrent spawns.
- **Better failure messages** (`src/runs/execution.ts`): `resultFailureMessage` now prefers the newest retryable provider error message over a generic system message, giving callers actionable diagnostics.
- **Retry status display** (`src/extension/index.ts`, +24): agent widget shows `retry N/M in Xs` with a live countdown. Retry events forward the error message and delay to parent progress via `reportChildStatus`.
- Tests: `test/performance-buffers-and-spawn.test.ts` (+99), `test/agent-state-visibility.test.ts` (+22).

### pi-cockpit agent timing (`packages/pi-cockpit/`)

- **Duration tracking** (`src/agents-store.ts`, +41): `ProgressPayload` gains `completedAt` and `durationMs`. `terminalTime` derives the finish timestamp from explicit `completedAt`, `durationMs` offset, or the current time. `finishedAt` lifecycle is managed across `applyStarted`, `applyMessage`, and `applyComplete` — cleared on re-start, set on terminal status.
- **Stack widget** (`src/stack-widget.ts`, +24): duration display for completed/failed agents.
- Tests: `tests/agents-store.test.ts` (+75), `tests/stack-widget.test.ts` (+57), `tests/render.test.ts` (+8).

## Statistics

- Commits since v0.9.0: 2
- Files changed: 26
- Insertions: 1 298 / Deletions: 112
- Tests: pi-maestro-teammate 362 pass / pi-cockpit 155 pass (1 pre-existing env failure) / pi-maestro-flow changed-file suites all pass

## Upgrade

```bash
npm i pi-maestro-flow@0.10.0
```

No breaking changes. The compaction linked threshold activates automatically when a compaction model is configured; without one, behavior is identical to v0.9.0. API retry defaults are initialized on session start (enabled, 12 retries).

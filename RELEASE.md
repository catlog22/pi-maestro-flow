# v0.27.1 — Cockpit Last-Column Wrap Fix & Todo Numbering From #1

## Overview

This is a small patch release on top of v0.27.0. It publishes **Flow 0.27.1**
and **Cockpit 0.22.1**. **Teammate 2.5.0**, **Settings-Core 0.2.1**,
**Backend-Core 0.1.2**, and **Backends 0.1.2** remain unchanged, and the exact
external engine pin stays at `maestro-flow@0.5.84` (already the latest).

Two user-facing fixes ship in the published companions: Cockpit no longer
writes the terminal's final column on live rows (which armed auto-wrap and
pushed the real cursor below pi-tui's model), and Todo task ids are
user-facing sequence numbers starting at `#1` instead of `#0`.

## Highlights

### Flow 0.27.1

- **Todo numbering starts at #1** - `packages/pi-maestro-flow/src/tools/todo.ts`
  initializes the task-id counter at 1 and resets to 1 on session shutdown, so
  the first created task is `#1`. The id-reconciliation scan adopts the same
  base. Covered by `test/todo.test.ts` (98 tests pass).
- **Exact companion bump** - the precise `pi-cockpit` dependency moves from
  `0.22.0` to `0.22.1`, so the published Flow tarball carries the wrap fix
  below. No other dependency changes.

### Cockpit 0.22.1

- **Last-column wrap fix** - live main-screen rows leave the final terminal
  column untouched so auto-wrap cannot move the real cursor:
  `src/agent-bar.ts` (session bar line and empty-endpoint chip),
  `src/stack-widget.ts` (agent widget header, marker, and agent rows via a
  shared `liveWidth`), and `src/window-bar.ts` (empty-window line). Covered by
  the updated `tests/agent-bar.test.ts`, `tests/stack-widget.test.ts`, and
  `tests/window-bar.test.ts` (49 targeted tests pass).
- **Docs refresh** - teammate-dispatch, model-routing, goal-plan-todo,
  cockpit, monitor, api-provider-config, and bash-bg-observe guides plus the
  tool-schema reference are updated; install commands and the docs-site banner
  point at `0.27.1`.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.27.0 | 0.27.1 |
| pi-cockpit | 0.22.0 | 0.22.1 |
| pi-maestro-teammate | 2.5.0 | 2.5.0 (unchanged) |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.2 | 0.1.2 (unchanged) |
| pi-maestro-backends | 0.1.2 | 0.1.2 (unchanged) |
| maestro-flow (engine pin) | 0.5.84 | 0.5.84 (unchanged, latest) |

## Stats

- **29 files** changed on top of v0.27.0 before release-note updates
- **+203 / -70** lines before release-note updates

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.27.1
```

This pulls the exact published companions `pi-maestro-teammate@2.5.0` and
`pi-cockpit@0.22.1`, plus `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.2`, and `pi-maestro-backends@0.1.2`.

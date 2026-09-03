# v0.26.0 — Deterministic New-Context Reset, Compact-History Recovery & Context-Pressure Guidance

## Overview

This release publishes **Flow 0.26.0**, **Teammate 2.4.0**, and **Cockpit 0.21.0**.
**Settings-Core 0.2.1**, **Backend-Core 0.1.2**, and **Backends 0.1.2** remain
unchanged. The core engine stays exact-pinned at `maestro-flow@0.5.83`.

The release turns the explicit **New Context** mode into a first-class,
deterministic workflow boundary: `new_context` resets are unchanged-summary
and opt-in, `compact_history` recovers the current session through compact
timelines, search, and turn/checkpoint reads with exact `session://` resources,
and compaction pressure surfaces as actionable advisory on Todo handoffs.
It also adds Todo duration charts, a teammate-side checkpoint history API,
and viewport-stability hardening in Cockpit.

## Highlights

### Flow 0.26.0

- **Explicit New-Context mode** - new `compaction.newContext.enabled` controls
  registration: while disabled, `new_context` and `compact_history` stay absent
  from a fresh model tool registry; after enabling, both tools are registered
  at Session start or the next Agent turn. `new_context` performs a
  deterministic, no-model-summary same-session reset and hands the next stage a
  Todo/Goal/Plan Recovery Capsule v2 (validated `resourceUris` included).
- **Compact-history recovery** - `compact_history` is current-session-only and
  host-authorized, exposing compact `timeline`, `search`, `read_turn`, and
  `read_checkpoint` actions with exact `session://` entry resources. Checkpoint
  projections now parse the recovery capsule (Checkpoint ID / Previous
  Checkpoint) so a reset boundary is always recoverable.
- **Context-pressure guidance** - compaction scheduling now projects context
  pressure (estimated tokens vs. the context window, hard-threshold headroom,
  and soft-band push/prune token budgets) into Todo output advice, including a
  `[context-pressure-advisory]` handoff marker when a Todo
  `advance transition=new_context` is advised; failed transitions are marked
  `[new-context-transition-failed]` instead of failing silently.
- **Todo handoff & duration charts** - terminal Todo advances can render the
  duration chart (bounded 5-bar baseline, empty-spacing aware), with the
  `todoDurationChart` option honored end to end in Cockpit events.
- **Tooling & regressions** - Plan tooling gains confirmed-action passing and
  model/details fields; resource formatting and session-history scan bounds are
  tightened; MCPX bridge/overlay registration is hardened, and compaction,
  session-history, and regression suites are expanded accordingly.

### Teammate 2.4.0

- **Checkpoint history API** - `SessionHistory.compactions()` returns bounded,
  versioned compaction checkpoints (with generation when available), replacing
  ad-hoc scans for the flow compact-history timeline.
- **Workspace-peer lock lease fix** - stale lock claims now also verify lock
  freshness (`acquiredAt` hard bound) and process liveness, so PID reuse can
  no longer produce permanent lockouts in workspace coordination.

### Cockpit 0.21.0

- **Viewport stability** - renderer wiring reworked so the stable main screen
  keeps viewport rows and working status aligned; related live-render edge
  cases are covered by expanded regression tests.
- **Todo duration chart events** - the terminal-advance duration chart flag is
  surfaced as `todoDurationChart` on the public v1 events surface, keeping
  Flow and Cockpit projections in sync.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.25.0 | 0.26.0 |
| pi-maestro-teammate | 2.3.0 | 2.4.0 |
| pi-cockpit | 0.20.0 | 0.21.0 |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.2 | 0.1.2 (unchanged) |
| pi-maestro-backends | 0.1.2 | 0.1.2 (unchanged) |
| maestro-flow (engine pin) | 0.5.83 | 0.5.83 (unchanged) |

## Stats

- **66 files** changed (**60 modified, 6 added**) on top of v0.25.0, surfacing
  as the single release commit for this cycle
- **+2,880 / -645** lines (tracked diff +2,210 / -645, plus 6 new files totaling +670 lines)

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.26.0
```

This pulls the exact published companions `pi-maestro-teammate@2.4.0` and
`pi-cockpit@0.21.0`, plus `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.2`, and `pi-maestro-backends@0.1.2`.

**New Context is opt-in**: enable `compaction.newContext.enabled` in `.pi`
settings. While disabled, `new_context` and `compact_history` are not
registered on the model tool surface and nothing else changes.
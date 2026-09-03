# v0.27.0 — Default New-Context Recovery, Workspace Session History & Knowledge-Aware Plans

## Overview

This release publishes **Flow 0.27.0**, **Teammate 2.5.0**, and **Cockpit 0.22.0**.
**Settings-Core 0.2.1**, **Backend-Core 0.1.2**, and **Backends 0.1.2** remain
unchanged. The core engine is updated to the latest exact pin,
`maestro-flow@0.5.84`.

New Context recovery is now enabled by default, while the new read-only
`session_history` tool makes bounded current, workspace, and teammate session
history available independently of compaction. Plan execution also gains an
explicit end-of-task knowledge assessment, teammate compaction cancellation is
handled without false failure, and Cockpit shows inherited settings together
with their effective values.

## Highlights

### Flow 0.27.0

- **New Context enabled by default** - `compaction.newContext.enabled` now
  defaults to on. Deterministic resets remain scheduled only at settlement and
  preserve the bounded recovery capsule; soft context pressure recommends a
  reset at completed Todo boundaries while critical pressure prioritizes the
  next safe reset.
- **Bounded workspace session history** - the new always-available,
  host-authorized `session_history` tool lists sessions, performs literal
  searches, and reads exact turns across current, workspace, or teammate
  scopes. It exposes only active-chain user/assistant/visible compaction data,
  keeps tool results opt-in, and never reveals transcript paths or hidden tool
  calls.
- **Exact session resources** - `resource` now resolves authorized
  `session://` entries discovered by either `compact_history` or
  `session_history`, including prior workspace sessions, while revalidating the
  active chain on every read.
- **Knowledge-aware Plans** - Plan contracts require an end-of-execution
  knowledge outcome: stage only reusable non-obvious lessons that meet the
  project quality bar, or explicitly report zero candidates without inventing
  content. `session_history` is admitted as a read-only Plan-mode discovery
  tool after the governing Maestro knowledge search misses.
- **Stable Workflow mirrors** - same-generation Todo reconciliation now
  preserves local timing metadata and skill activation instead of treating an
  unchanged canonical mirror as a fresh update.
- **Latest Maestro engine** - the exact external engine pin moves from
  `maestro-flow@0.5.83` to `maestro-flow@0.5.84`.

### Teammate 2.5.0

- **Compaction cancellation recovery** - a cancelled explicit reset now clears
  the parent's compaction wait and timer without publishing a false failure,
  allowing a pending message to continue in the existing context.
- **Planner knowledge outcome** - the built-in planner emits a dedicated
  Knowledge Outcome section that predicts only plausible reusable lessons and
  requires an explicit zero-candidate result when none qualify.

### Cockpit 0.22.0

- **Effective settings visibility** - unset settings now display both the
  absence of an explicit value and the inherited effective value. The Flow New
  Context toggle is covered end to end through render, edit, and persistence.
- **Standalone compatibility** - Cockpit no longer performs runtime value
  imports from its optional Teammate peer. Its local V2 read-model adapter keeps
  canonical snapshots and deltas available when Teammate is present while a
  bare Cockpit installation continues to load through the V1 fallback.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.26.0 | 0.27.0 |
| pi-maestro-teammate | 2.4.0 | 2.5.0 |
| pi-cockpit | 0.21.0 | 0.22.0 |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.2 | 0.1.2 (unchanged) |
| pi-maestro-backends | 0.1.2 | 0.1.2 (unchanged) |
| maestro-flow (engine pin) | 0.5.83 | 0.5.84 |

## Stats

- **42 implementation and documentation files** changed on top of v0.26.0
  before release metadata
- **+1,003 / -134** lines before package-version and release-note updates

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.27.0
```

This pulls the exact published companions `pi-maestro-teammate@2.5.0` and
`pi-cockpit@0.22.0`, plus `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.2`, and `pi-maestro-backends@0.1.2`.

New Context is enabled by default. Set `compaction.newContext.enabled` to
`false` if deterministic settlement-time resets are not desired.
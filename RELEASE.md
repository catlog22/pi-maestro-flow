# v0.24.0 — Safer Process Lifecycles, Explicit Interrupts, Responsive Operations

## Overview

This release publishes **Flow 0.24.0**, **Teammate 2.2.0**, and
**Cockpit 0.19.0**. **Settings-Core 0.2.1**, **Backend-Core 0.1.1**, and
**Backends 0.1.1** remain unchanged. The core engine remains current at
`maestro-flow@^0.5.82`.

The release makes subprocess ownership fail-closed across cancellation and
normal exit, separates queued `steer` delivery from explicit `interrupt`, adds
crash-consistent completion-outbox maintenance, improves cross-window agent
coordination, and reduces unnecessary Cockpit polling and rendering work.

## Highlights

### Flow 0.24.0

- **Verified process-tree reclamation** — Maestro CLI, self-evolve stage, and
  SmartSearch subprocesses now share an owned-process-tree utility. POSIX uses
  isolated process groups; Windows retains discovered descendants through a
  bounded CIM cleanup and fails closed when reclamation cannot be confirmed.
- **Abort-aware host runners** — Maestro CLI adapters accept `AbortSignal`, FFF
  initialization is cancelled with its session, and SmartSearch enforces a host
  wall-clock deadline while reclaiming descendants before settlement.
- **Plan continuation handoff** — approved Plan decomposition and compaction
  handoff preserve Goal continuation instead of leaving interrupted work
  stranded.
- **Provider registry consistency** — `/api-manager` and the settings shell keep
  managed provider registries synchronized, including explicit-empty state and
  legacy fallback migration. Provider-discovery tests now wait on real UI state
  rather than fixed sleeps.
- **MCPX quick tunnels** — HTTP/2 is used for quick-tunnel transport.

### Teammate 2.2.0

- **Queued steer vs explicit interrupt** — `steer` is now the native Pi queue and
  never cancels the active turn. `interrupt` explicitly performs abort + prompt,
  rejects a second in-flight interrupt, and degrades safely to `follow_up` when
  interruption cannot be confirmed.
- **Cross-window coordination** — teammate-send can target workspace-peer agents;
  dispatch exposes a `steeringMode` override and clarifies batched coordination
  reporting instead of incremental status traffic.
- **Completion durability operations** — the new `pi-teammate-outbox` CLI exposes
  crash-consistent remnant cleanup. Lock-order regression coverage prevents a
  writer that starts after the generation snapshot from being missed.
- **Terminal publication ordering** — terminal results are published before
  completion callbacks, and progress events remain bounded during streaming.
- **Resource retention** — sleeping runtimes use smaller defaults with explicit
  environment overrides, while checkpoints preserve cold resume after eviction.
- **Lifecycle polish** — attach-overlay animation runs only while visible, tree
  cleanup reports honest Windows confirmation, and corrupted outbox GC indexes
  self-heal during reconciliation.

### Cockpit 0.19.0

- **Usage controls** — `/usage` gains manual-refresh mode and a poll toggle, so
  users can inspect provider usage without background refreshes.
- **Todo event projection** — Cockpit broadcasts and reacts to
  `maestro todo-state-changed` events for prompt UI updates.
- **Crash-consistent editor history** — input-history saves retry transient
  failures without losing the previous durable snapshot.
- **Lower idle rendering cost** — ambient writes are deduplicated and animation
  timing is aligned to 500ms.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.23.0 | 0.24.0 |
| pi-maestro-teammate | 2.1.0 | 2.2.0 |
| pi-cockpit | 0.18.0 | 0.19.0 |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.1 | 0.1.1 (unchanged) |
| pi-maestro-backends | 0.1.1 | 0.1.1 (unchanged) |
| maestro-flow (engine pin) | ^0.5.82 | 0.5.82 |

## Stats

- **29 commits** since v0.23.0, including the release commit
- **139 files** changed, **+4,721 / −1,075**

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.24.0
```

This pulls the exact published companions `pi-maestro-teammate@2.2.0` and
`pi-cockpit@0.19.0`, plus unchanged `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.1`, and `pi-maestro-backends@0.1.1`.

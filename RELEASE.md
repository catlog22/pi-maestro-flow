# v0.29.0 — Shared Gateway Board, Durable Handoffs & Hardened Agent Launching

## Overview

This feature release publishes **Flow 0.29.0** and **Teammate 2.6.1** on top
of v0.28.0. **Cockpit 0.23.0**, **Settings-Core 0.2.1**,
**Backend-Core 0.1.3**, and **Backends 0.1.3** are unchanged. Flow now pins
the current external engine, `maestro-flow@0.5.86`.

Three capabilities define the release:

1. **Workspace-shared Gateway Board** — versioned contracts, durable task
   storage, optimistic revisions, claim leases, transitions, and Session,
   Plan, Todo, and endpoint links are exposed through authenticated local IPC.
2. **Durable execution handoffs** — Todo tasks persist bounded next-step
   recommendations and task-relative file loading value; New Context recovery
   deterministically selects the relevant actor-, Goal-, and Plan-scoped handoff.
3. **Hardened teammate launching** — shell-free, provenance-bearing Pi binary
   resolution handles native PATH entries and verified Windows shims while
   structured child-process diagnostics preserve bounded failure evidence.

Plan mode also gains explicit model-transition reporting and deterministic Act
model restoration. Foreground Teammate and `bash_bg run` calls now share one
session-scoped Alt+B dispatcher, so nested work detaches outermost-first without
terminating the process. Gateway workspace, job, file, session, and teammate
services receive the contract and lifecycle updates needed by the shared board.

## Highlights

### Flow 0.29.0

- **Gateway Board contracts and storage** — new `src/gateway/board-contracts.ts`
  and `board-store.ts` define the versioned board model, revision fencing,
  dependency-aware state transitions, claim generations and lease expiry,
  completion policy, and durable Session/Plan/Todo/resource links.
- **Board and workspace services** — new `services/board-service.ts`,
  `services/workspace-service.ts`, and `tools/gateway-board.ts` expose the board
  through authenticated local IPC; `local-client.ts`, the gateway catalog,
  policy, runtime, CLI, and service surfaces carry the new operations.
- **Durable Todo handoffs** — Todo create/update/advance accept up to three
  next steps plus file loading values (`required`, `conditional`, `skip`,
  `unknown`) with bounded reasons and reload conditions. Serialization,
  extension schemas, rendering, and child proxy guidance preserve the data.
- **Deterministic New Context recovery** — recovery capsules select actor-owned
  active/completed handoffs, scope them by the current Goal and approved Plan,
  bound their payload, and emit explicit checkpoint/file-loading guidance.
- **Plan/Act model restoration** — Plan entry records the selected planning
  model, confirmation reports the transition, and Execute/Exit restore the
  prior Act model without leaking Plan-mode state.
- **Gateway lifecycle hardening** — job cancellation and output handling,
  file/exec/session/teammate services, path ownership, IPC contracts, and
  policy checks are aligned with the shared workspace surface.
- **Shared foreground detach** — `bash_bg run` can be detached immediately with
  Alt+B and continues under normal background job ownership; the shared
  dispatcher handles nested foreground owners outermost-first with one TUI
  listener and deterministic session cleanup.
- **Compaction relay resilience** — teammate compaction telemetry avoids sends
  on disconnected IPC and treats EPIPE/channel-closed failures as settled
  transport loss rather than an unhandled error.

### Teammate 2.6.1

- **Provenance-bearing Pi launcher resolution** — `execution-infra.ts`
  resolves explicit overrides, native PATH binaries, verified Windows npm
  shims, verified host package bins, and a final compatibility fallback without
  enabling shell execution.
- **Structured child diagnostics** — spawn, child-error, and close events now
  include bounded stderr, exit code, signal, lifecycle phase, and launcher
  source so failures remain actionable across process boundaries.
- **Public foreground-detach coordination** — the new
  `pi-maestro-teammate/v1/foreground-detach` surface lets Flow and Teammate
  share one session-safe Alt+B ownership queue.
- **Focused regression coverage and declarations** — launcher precedence,
  Windows shim parsing, fallback behavior, and diagnostic projection are
  covered in `performance-buffers-and-spawn.test.ts`; declarations are
  regenerated from the release source.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.28.0 | 0.29.0 |
| pi-maestro-teammate | 2.6.0 | 2.6.1 |
| pi-cockpit | 0.23.0 | 0.23.0 (unchanged) |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.3 | 0.1.3 (unchanged) |
| pi-maestro-backends | 0.1.3 | 0.1.3 (unchanged) |
| maestro-flow (engine pin) | 0.5.84 | 0.5.86 |

## Stats

- **1 release commit** on top of baseline tag `v0.28.0`; all selected worktree
  changes are landed atomically in the release commit.
- **83 implementation/test/support files**, **+5,694 / -455** lines before
  Flow version/pin, lockfile, release-note, and documentation updates.

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.29.0
```

This pulls the exact published companion `pi-maestro-teammate@2.6.1` and
existing `pi-cockpit@0.23.0`, `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.3`, and `pi-maestro-backends@0.1.3`.

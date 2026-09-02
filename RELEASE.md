# v0.25.0 — Remote Windows, SSH Host Management, Durable Workflow Boundaries

## Overview

This release publishes **Flow 0.25.0**, **Teammate 2.3.0**, **Cockpit 0.20.0**,
**Backend-Core 0.1.2**, and **Backends 0.1.2**. **Settings-Core 0.2.1**
remains unchanged. The core engine is exact-pinned at `maestro-flow@0.5.83`.

The release adds encrypted SSH host references, remote-window supervision,
session Artifacts, bounded session history and resource references, explicit
new-context compaction, richer Todo projections, model-routing Profiles, and
stronger Workflow Goal/Plan boundaries. It also hardens completion durability,
browser pairing, provider history, and cross-window rendering.

## Highlights

### Flow 0.25.0

- **SSH and connectivity** - encrypted `/ssh` host references and configuration,
  improved DSH remote SSH launch, and an authenticated browser-extension bridge
  selected only through its explicit channel.
- **Workflow data and orchestration** - flow-schedule, data-manager, and session
  Artifact sources carry ownership metadata; Todo supports atomic batch mutation,
  task timing, structured result cards, and validated durable `resourceUris`.
- **Goal and Plan boundaries** - verifier and acceptance-command limits are now
  bounded at 10 minutes and 5 minutes respectively. Canonical Workflow identity
  drift and terminal state fail closed before acceptance commands run, and Plan
  approval no longer forces Goal creation.
- **Context continuity** - `session_history` exposes bounded host-authorized
  session entries and `session://` resource reads; explicit `new_context` resets
  are opt-in and carry deterministic Todo/Goal/Plan recovery capsules with
  validated resource references.
- **Runtime hardening** - compaction and tool-result spill, provider/usage
  history, browser tooling, abort propagation, and loop terminal reporting are
  covered by expanded regression tests.

### Teammate 2.3.0

- **Remote-window supervision** - agent/runtime provenance, Monitor window
  lifecycle, remote-window protocol and session services, and a workspace-peer
  observation rewrite are now available across local and remote workers.
- **Durable delivery** - completion outbox GC, mailbox routing, terminal
  publication ordering, and recovery paths are hardened for concurrent writers,
  reloads, and late results.
- **Remote configuration** - SSH host contracts, ACP catalog/configuration, DSH
  and remote-worker transport handling, and model/configuration surfaces are
  synchronized across the package and generated declarations.
- **Model routing and settlement** - saved routing Profiles can be listed,
  resolved, activated by stable ID or name, and opened directly from
  `/teammate-model`; structured-output failures retain provider causes and the
  applicable settlement diagnostic.

### Cockpit 0.20.0

- **Operational projection** - window autocomplete, session/window owner identity,
  structured tool-call/result cards, Todo task cards, and duration charts.
- **Stable rendering** - viewport and working rows remain stable on the regular
  main screen, while fullscreen retains live duration; collapsed Todo output only
  shows the relevant shortcut hints.

### Backend contracts 0.1.2

- Backend-Core exposes the versioned SSH host contract.
- Backends improve DSH SSH launch behavior and remote event handling.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.24.0 | 0.25.0 |
| pi-maestro-teammate | 2.2.0 | 2.3.0 |
| pi-cockpit | 0.19.0 | 0.20.0 |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| pi-maestro-backend-core | 0.1.1 | 0.1.2 |
| pi-maestro-backends | 0.1.1 | 0.1.2 |
| maestro-flow (engine pin) | 0.5.82 | 0.5.83 |

## Stats

- **51 implementation commits** since v0.24.0
- **357 files** changed, **+59,169 / -17,914** in the implementation range

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.25.0
```

This pulls the exact published companions `pi-maestro-teammate@2.3.0` and
`pi-cockpit@0.20.0`, plus `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.2`, and `pi-maestro-backends@0.1.2`.

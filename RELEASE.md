# v0.21.2 — v3 Simplification Sync to maestro-flow 0.5.71

## Overview

Flow `0.21.2` bumps the core engine pin from `maestro-flow@0.5.70` to
`maestro-flow@0.5.71` and adapts the v3 adapter to the simplified Session/Run
protocol: decision gates, no participant pre-registration, no identity
revision / paused / gates state in v3, and receipts keyed by actor identity.
The v2 execution branch is untouched.

## Highlights

### Engine Pin — maestro-flow 0.5.69 → 0.5.71

- `feat(runtime)`: v3 decision gates — chain steps may declare a
  `decision_ref`; `run next`/`create` block on unresolved predecessor gates
  (`DECISION_GATE_BLOCKED`), `session complete` blocks on open gates while
  escalated gates pass with concerns, `decide escalate` no longer pauses the
  Session.
- `refactor(runtime)`: v3 simplification anchored on the ralph run path —
  removed chain-proposal application, TC-P0-3 extra completion inputs, 22
  retired v2-only subcommand stubs, `session fail`/`chain audit`,
  resume-map truncation, and per-check knowledge reconciliation (candidates
  are generated once by `run complete`).
- `refactor(runtime)`: batch B — dropped the participant entity and command
  family (`--participant` still accepted for injection compatibility),
  Session `identity_revision`, status `paused`, and the gates system;
  receipts store `participant_id = actorId`; legacy v3 files read via
  strip-tolerant schemas (`paused` maps to `open`).
- `feat(cli)`: `maestro config session-schema set/show` for explicit writer
  switching; writer-scoped `session_schema_writes` in capabilities.

### Flow Adapter (this package)

- Removed v3 participant pre-registration preflight (`ensureV3ParticipantRegistered`).
- Dropped identity-revision parsing and gates projection from the bridge;
  session status no longer includes `paused` in v3.
- Removed `session-pause`/`session-resume` from the v3 operation surface;
  capability negotiation (six keys) unchanged.
- `--participant`/`--actor` injection retained for core compatibility.

## Upgrade Notes

- v3 workspaces: no participant registration calls are needed (or accepted);
  correction points are expressed as chain decision gates resolved via
  `run decide`.

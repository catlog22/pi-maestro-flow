# v0.21.6 — Remote Teammate Workers, Monitor Control, and Plan Knowledge Gate

## Overview

Teammate `1.14.0` ships the remote worker system: a `pi-teammate-remote` CLI
with an ACP (Agent Client Protocol) driver, SSH transport, Pi RPC driver, and
remote journaling — plus Monitor integration (tool-exposure switching,
remote-aware `teammate-list`, remote worker supervision) and an interactive
ask-before-dispatch gate. Flow `0.21.6` opens the plan execution contract with
the Knowledge Gate and syncs the core engine pin to `maestro-flow@0.5.75`.

## Highlights

### Teammate 1.14.0 — Remote Workers (`pi-teammate-remote`)

- New CLI binary `pi-teammate-remote` and public `./v1/remote` API surface with
  worker protocol, configuration, bridge, journal, and adapter contracts
  (`src/remote/`): ACP driver, Pi RPC driver, SSH transport, child security and
  process-tree management, worker-manager, and remote state.
- New runtime dependencies: `@agentclientprotocol/sdk@1.3.0`, `jiti@2.7.0`,
  `ssh2@1.17.0`, `zod@4.4.3` (bundled settings core unchanged).
- Monitor control window: `MonitorToolExposureController` switches local vs
  Monitor tool variants with exclusive tools (`workspace-window`,
  `remote-worker`) without granting cross-window authority before admission;
  `teammate-list` merges local workspace peers with remote runs; monitor mode
  context now covers SSH-backed remote worker supervision.
- Ask-before-dispatch gate: when enabled in the model routing config
  (`~/.pi/agent/teammate-models.json` → `askBeforeDispatch: true`,
  toggleable via `/teammate-models`), root dispatches pause for per-task model /
  thinking / location confirmation in a model-ask overlay before any agent is
  spawned; nested/proxied dispatches never ask.
- Delivery hardening: monitor runtime interventions carry an in-process
  `authorize` fence checked before external publication; `ActiveAgent` gains a
  resolved `cwd` (local path or `remote:<targetId>`).

### Flow 0.21.6 — Plan Knowledge Gate + Engine Sync

- The approved-plan execution contract now opens with the Knowledge Gate: it
  instructs executing agents to run `maestro search "<1-3 task keywords>"`
  before any project work and to `maestro load` every governing hit (search is
  exposure, load records consumption), then re-search at subsystem or
  architecture boundaries.
- Core engine pin synced `maestro-flow@0.5.74 → 0.5.75` (upstream v3 runtime
  updates; v2 branch untouched).

## Package Versions

| Package | Version | Change |
|---------|---------|--------|
| pi-maestro-teammate | 2.0.0 | major — 破坏性远端 journal 格式（REMOTE_JOURNAL_VERSION 1 → 2，无迁移） |
| pi-maestro-flow | 0.21.6 | patch — plan Knowledge Gate, engine sync |
| pi-cockpit | 0.16.0 | unchanged |
| pi-maestro-settings-core | 0.1.3 | unchanged |

## Upgrade Notes

- Teammate requires the new runtime deps (`ssh2`, `jiti`,
  `@agentclientprotocol/sdk`); reinstall (`pi install npm:pi-maestro-teammate@1.14.0`
  or clean `npm install`) rather than copying an old node_modules.
- Ask-before-dispatch defaults to off; enable it in `/teammate-models`
  (Ctrl+A). When enabled, dispatches from contexts without overlay UI support
  skip the gate instead of failing.
- `maestro-flow` is exact-pinned; the pin is bumped to 0.5.75 to match this
  release (upstream latest).

## Install

```bash
pi install npm:pi-maestro-flow@0.21.6
```

## Verification

- `packages/pi-maestro-teammate`: 1453 tests pass (full suite), typecheck clean.
- `packages/pi-maestro-flow`: `test:plan` 122 pass, typecheck clean.
- Published artifacts verified by registry install + smoke after release.

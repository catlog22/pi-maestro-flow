# v0.28.0 — SSH Remote Channels, Smart Model Selection & Receipt-Bound Wake Protocol

## Overview

This is a feature release on top of v0.27.1. It publishes **Flow 0.28.0**,
**Teammate 2.6.0**, **Cockpit 0.23.0**, **Backend-Core 0.1.3**, and
**Backends 0.1.3**. **Settings-Core 0.2.1** is unchanged. The exact external
engine pin stays at `maestro-flow@0.5.84` — upstream has since published
0.5.85/0.5.86 (knowledge-CLI and release-machine fixes only), and this release
explicitly accepts that lag rather than bumping the pin mid-release.

Three headline capabilities ship together:

1. **Provider-owned teammate remote channels** — an SSH host-reference
   provider can now open a dedicated, admission-brokered channel for teammate
   RPC instead of falling back to ad-hoc SSH exec. The Flow side owns a fixed
   broker (2 per host / 8 global, abortable, shutdown-safe) exposed through
   the ssh-manager host provider surface.
2. **Smart teammate model selection** — a global Smart Mode
   (off/economy/balanced/sota) persisted in the model-routing v3 store, a
   routing-tab Ctrl+S toggle, and a `model_intelligence` view (OpenRouter
   benchmark ranks with 24h file cache) surfaced through
   `model_availability`. Intelligence ranks are advisory only and never
   override availability.
3. **Receipt-bound wake protocol v1** — auto-compaction wakes are fenced by
   capability envelopes, wakeId binding, absolute deadlines, and
   supersede/expiry detection on both the producer (Flow relay) and consumer
   (teammate subprocess attempt) sides, with fail-closed durable persistence.

Also included: Plan confirmation handoffs now execute through the New Context
continuation (`continueAfterReset`/`onCancelled`, 20KB carry-forward budget),
the gateway gains an idempotent `service ensure` action with a Windows
Startup resident backend (Startup-folder shortcut, explicitly not a Windows
Service) plus a hardened private-state lock (TOCTOU-narrowed stale reclaim,
symlink/replace detection, heartbeat partial-write loop), and Cockpit ships
target routing / integration widgets and compact-form styling.

## Highlights

### Flow 0.28.0

- **SSH remote channel broker** - new `src/ssh-manager/remote-channel.ts`
  (`TeammateRemoteChannelBroker`, 2/host + 8/global caps, abort + shutdown)
  wired into the host provider `openTeammateRemoteChannel` capability;
  `sshHostReferenceIssue` compatibility moves into the broker. Covered by
  `test/ssh-manager-remote-channel.test.ts` (235 lines).
- **Smart model selection surface** - new `src/providers/model-intelligence.ts`
  (374 lines: OpenRouter five-dimension ranking, 24h atomic-write cache,
  taskType + preference mapping, stale/unavailable degradation) and a
  `taskType`-aware `model_intelligence` view in
  `src/tools/model-availability.ts`. Covered by
  `test/model-intelligence.test.ts` and `test/model-availability.test.ts`.
- **Receipt-bound wake protocol v1** - `src/compaction/auto-compaction.ts`
  wake lifecycle hardening (branch-checkpoint depth anchors, supersede on new
  user input, deadline expiry, fail-closed durable persistence retry) and
  relay capability envelopes in `src/compaction/teammate-compaction-relay.ts`.
- **Plan New Context continuation** - `src/tools/plan.ts` /
  `plan-confirm.ts` schedule a deterministic reset via `scheduleNewContext`
  with in-memory `continueAfterReset` / `onCancelled` callbacks;
  `src/compaction/new-context.ts` accepts `source: "plan-confirm"` and raises
  the carry-forward budget to `NEW_CONTEXT_MAX_PLAN_HANDOFF_BYTES` (20KB).
- **Gateway resident ensure + Windows Startup backend** -
  `src/gateway/resident-service.ts` (+680: idempotent `ensure()` with 15s
  readiness polling, adapter-per-manifest selection, startupName /
  shortcutDigest / windowsCreate state machine, schtasks creation-termination
  tracking, absence-observation clock guard); `cli.ts` gains `service ensure`
  with `--windows-startup` / `--detached-fallback` mutual-exclusion
  validation.
- **Hardened private-state lock** - `src/gateway/private-state-transaction.ts`
  captures the owner before re-validating staleness (TOCTOU narrowed),
  detects symlink/replace on the reclaim marker (lstat dev+ino), and loops
  heartbeat partial writes.
- **RPC sender fallback** - `src/gateway/services/teammate-service.ts` falls
  back to the public RPC sender when an injected port omits `send`.
- **Gateway CLI binary** - `bin/pi-maestro-gateway.mjs` is now packaged
  (`bin` entry + `bin/` in files), and a public `pi-maestro-flow/gateway/v1`
  export is added.
- **Committed earlier in the window** - gateway local runtime + SSH
  orchestration, ssh pairing store / resident service / pi-config sync,
  session-history recovery unification, the process-wide `/advisor` broker,
  durable completion publication, browser lifecycle hardening, computer-use
  pointer feedback, hidden Windows child consoles, and serialized Plan
  handoff submission.

### Teammate 2.6.0

- **Provider-owned remote channels** - `src/public/v1/ssh-hosts.ts` adds the
  optional `openTeammateRemoteChannel` capability with strict stream/abort
  validation; `src/remote/ssh.ts` prefers provider channels for
  host-reference configs with convergent close().
- **Smart mode** - `src/models/model-routing.ts` gains
  `TeammateSmartMode` (off/economy/balanced/sota) persisted in the global v3
  store, `setGlobalSmartMode` / `getGlobalSmartMode`, and
  `appendSmartModelSelectionContext` with a reversible marked block injected
  for the root agent only; routing tab Ctrl+S cycles modes (zh/en locales).
- **Wake protocol v1 consumer** - `src/runs/pi-subprocess-attempt.ts`
  (+134) implements capability negotiation, the receipt state machine
  (prepared→queued→consumed→turn-started + cancel/fail), wakeId binding,
  monotonic absolute deadlines, and pre-settlement IPC drain;
  `src/runs/execution.ts` adds `settlement-authority-insufficient` and
  `model-selection-unsupported` failure decisions.
- **Stale declaration catch-up** - `types/runs/recovery-protocol.d.ts`,
  `retry.d.ts`, and `shared/types.d.ts` are regenerated to match previously
  committed src.

### Cockpit 0.23.0

- **Target routing & integration** - new `src/target-routing.ts` (667 lines)
  and `src/target-integration.ts` (305 lines) with full test coverage
  (`tests/target-routing.test.ts`, `tests/target-integration.test.ts`).
- **Compact-form styling** - new `src/compaction-style.ts` (233 lines) for
  compaction summaries, covered by `tests/compaction-style.test.ts`.
- **Committed earlier in the window** - target routing / terminal
  presentation improvements.

### Backend-Core 0.1.3 / Backends 0.1.3

- **`SshHostReferenceIssue` extension** - three new issues
  (`unsupported-managed-key`, `unsupported-jump-host`, `untrusted-host`)
  consumed by the remote-channel compatibility check.
- **Spawn hardening** - the DSH keyscan runner spawns with
  `shell: false, windowsHide: true`.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.27.1 | 0.28.0 |
| pi-maestro-teammate | 2.5.0 | 2.6.0 |
| pi-cockpit | 0.22.1 | 0.23.0 |
| pi-maestro-backend-core | 0.1.2 | 0.1.3 |
| pi-maestro-backends | 0.1.2 | 0.1.3 |
| pi-maestro-settings-core | 0.2.1 | 0.2.1 (unchanged) |
| maestro-flow (engine pin) | 0.5.84 | 0.5.84 (unchanged, lag accepted) |

## Stats

- **26 commits** on top of v0.27.1 (20 pre-existing + 6 worktree-landing
  commits), baseline tag `v0.27.1`, release range verified at
  release-commit time
- **280 files** changed, **+35,564 / -3,282** lines before release-note
  updates

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.28.0
```

This pulls the exact published companions `pi-maestro-teammate@2.6.0` and
`pi-cockpit@0.23.0`, plus `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.3`, and `pi-maestro-backends@0.1.3`.

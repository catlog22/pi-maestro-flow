# v0.17.0 - Cross-Session Scheduler, Monitor Supervision, Shared TUI Locale, and Core Engine 0.5.67

## Overview

Flow `0.17.0` bundles Teammate `1.10.0`, Cockpit `0.12.0`, and
`pi-maestro-settings-core` `0.1.2`. This release delivers the cross-session
scheduler/sessions core with durable monitor supervision and closed-loop
interventions, teammate dispatch hardening (role circuit policies, custom
task types, routing context, Alt+R session-list handoff, observation turns
view), a shared TUI locale across all companion packages with per-package
translation catalogs (in-shell language switching, listeners released on
quit/reload), self-evolve auto-deposit mode (Phase 2B) with an editable
mode CLI gate, flow run-loop fixes (loop scheduler re-arm on reload,
loop-critical marker preservation, hard-compaction first-boundary
interrupt), and the api-manager model-ID rename with downstream migration.

The core engine reference is updated from `maestro-flow@0.5.65` to
**`maestro-flow@0.5.67`** (exact pin). The bump carries three run-chain
fixes: projections registered on all session creation paths plus enum-arg
validation and session prune, chain-file step args and explicit topic
preserved in chain start, and `--arg` passed through chain dispatch with
failed sessions kept canonical-reachable.

## Package Versions and Requirements

| Package | v0.16.0 | v0.17.0 |
|---------|---------|---------|
| pi-maestro-flow | 0.16.0 | **0.17.0** |
| pi-maestro-teammate | 1.9.0 | **1.10.0** |
| pi-cockpit | 0.11.0 | **0.12.0** |
| pi-maestro-settings-core | 0.1.1 | **0.1.2** |
| maestro-flow | 0.5.65 | **0.5.67** |

- Requires Node.js `>=22.19.0`.
- Pi core packages remain optional wildcard peers supplied by the host; the
  release tarballs do not bundle private SDK copies. The dev verification
  baseline stays at `@earendil-works/pi-*@0.83.0`.
- `pi-maestro-flow` pins the core engine `maestro-flow` exactly at `0.5.67`.
  Exact pins do not auto-follow upstream: the 0.5.65 → 0.5.67 bump is an
  explicit preflight decision (see `TIP-20260727-exact-pin-stale-upstream-dep`).
- Exact workspace pins were bumped together with the closure: settings-core
  `0.1.1` → `0.1.2` in Teammate, Cockpit, and Flow; cockpit `0.11.0` →
  `0.12.0` and teammate `1.9.0` → `1.10.0` in Flow. Cockpit's peer range
  `^1.6.0` for Teammate still covers `1.10.0` (1.x caret semantics) and is
  intentionally left unchanged.

## Highlights

### Settings-Core - Shared TUI Locale with Per-Package Catalogs

- `src/public/v1/i18n.ts` exposes the shared locale contract:
  `SETTINGS_LOCALE_EVENT`, `detectSystemSettingsLocale` (with
  LC_MESSAGES/LANGUAGE precedence), and per-package translation catalogs so
  companion packages render a single consistent language.

### Teammate - Cross-Session Scheduler, Monitor Supervision, and Dispatch Hardening

- Durable monitor supervision with a ledger, closed-loop interventions, and
  turn-level advisor; deterministic monitor controller with a window-mode
  session registry; cross-session scheduler/sessions core lets the monitor
  run on independent sessions.
- Durable per-turn publication ids for idempotent result capture; caller
  may observe the same result across retries without duplicate handling.
- Role circuit policies, custom task types, and routing context for
  teammate dispatch.
- Alt+R session-list handoff with extension wiring for routing, monitor,
  and turns; observation turns view, monitor-mode context, and transcript
  grouping.
- First-class max thinking level selectable in the control center;
  concurrency-limit errors classified as retryable with a configurable
  backoff cap; stall notifications throttled per-agent cooldown; tool
  descriptions aligned with parameter schemas.
- TUI locale listener lifecycle owned by the extension: the shared
  `SETTINGS_LOCALE_EVENT` subscription is disposed on quit/reload (no
  duplicate-locale-application after session restart).

### Cockpit - Endpoint-Driven Bars and Session-List Handoff

- Endpoint-driven agent/window bars with session tabs.
- Session-list handoff, window monitoring, and shortcut rework.
- Consumes the shared TUI locale event so cockpit chrome follows the
  in-shell language selection.

### Flow - Self-Evolve Auto-Deposit, Run-Loop Fixes, and API Manager Migration

- Self-evolve auto-deposit mode (Phase 2B) with a CLI staging gate; the
  mode is now editable between dry-run and auto-deposit at runtime.
- Host cross-session result publication with output-store ack and the
  SchedulerCore loop.
- Run-loop fixes: loop scheduler re-armed on session reload with persisted
  loops resumed; loop-critical marker preserved on compaction replacement;
  tool loop interrupted at the first boundary after the hard compaction
  threshold.
- API manager supports renaming model IDs with downstream migration; agent
  header presets for API Manager channel configuration.
- bash-bg foreground/background snapshot and actionable browser run errors;
  packed tarball listing fixed with `--force-local` on Windows.
- History editor route sigils and render truncation; todo usage conflicts
  resolved and tool descriptions deduped; placeholder taskType for
  team-role spawns in Pi conversion; odyssey entry via session start with
  the chain command.
- Flow extension disposes the shared TUI locale listener on quit/reload.

## Core Engine Update - maestro-flow 0.5.65 → 0.5.67

- **0.5.66**: line-delimited artifact metadata support in run sessions.
- **0.5.67**: projections registered on all session creation paths, enum
  argument validation, and session prune; chain-file step args and explicit
  topic preserved in chain start; `--arg` passed through chain dispatch
  with failed sessions kept canonical-reachable.

## Behavior and Upgrade Notes

- Close all running Pi processes before upgrading. The installer updates
  disk settings that an older in-memory SettingsManager could otherwise
  overwrite.
- Companion registration order remains mandatory: Teammate, then Cockpit,
  then Flow. Verify all three versions after restart.
- TUI language now follows the shared in-shell locale: switching language
  in settings propagates to Teammate, Cockpit, and Flow chrome without a
  restart. On session quit/reload the shared locale listener is disposed so
  no stale subscription survives into the next session.
- The core engine is pinned exactly at `0.5.67`; the bump is deliberate.
- Repo-level chore: pipeline output relocated to `.pi-sync` and the tracked
  flow mirror dropped (affects repository layout only, not package content).

## Install / Upgrade

```bash
# Close running Pi processes first.
pi install npm:pi-maestro-flow@0.17.0
pi list
```

After restarting Pi, verify that Flow, Teammate, and Cockpit are registered at
the versions in the table above before running model-sensitive workflows.

## Release Verification

The release candidate passed the serial root `test:release` gate, including
settings-core typecheck/test, workspace version-drift and manifest-contract
assertions (three consumers pin `pi-maestro-settings-core` exactly at
`0.1.2`), all changed Flow subsystems (settings/TUI locale, compaction,
session, providers, api-manager migration, goal, bash-bg, plan, swarm,
intelligence, packed consumers), Teammate declarations and tests, and
Cockpit tests. Packed tests remain intentionally serial because Flow
prepack/postpack share `packages/pi-maestro-flow/.pi/skills`.

Dry-run tarballs from the verified candidate:

| Package | Files | Packed | Unpacked | SHA-1 |
|---------|------:|-------:|---------:|-------|
| pi-maestro-settings-core@0.1.2 | 7 | 5.4 kB | 20.3 kB | `a94722d4bc750771dcbf19056d30227183f12bed` |
| pi-maestro-teammate@1.10.0 | 178 | 441.6 kB | 2.0 MB | `9f5a5651b8b4167de28b5f4934152502b93abceb` |
| pi-cockpit@0.12.0 | 82 | 213.5 kB | 0.8 MB | `0d9521d2c89bdb969de50dfca2cafd2057ddf91d` |
| pi-maestro-flow@0.17.0 | 521 | 1.5 MB | 5.8 MB | `7330fed7b3a73a1f69e0ae068c7d5a62e9d6ac79` |

Publication order is mandatory:

1. Publish and verify `pi-maestro-settings-core@0.1.2`.
2. Publish and verify `pi-maestro-teammate@1.10.0` (pins settings-core 0.1.2).
3. Publish and verify `pi-cockpit@0.12.0` (pins settings-core 0.1.2).
4. Publish and verify `pi-maestro-flow@0.17.0` with exact companion versions
   and `maestro-flow@0.5.67`.
5. Run a fresh temporary-home registry install and Pi runtime smoke test.
6. Create and push `v0.17.0`, then create the GitHub Release.

## Change Statistics

Final candidate compared with `v0.16.0` (34 feature/fix/docs commits plus
the release commit):

- 520 files changed
- 27,279 insertions and 45,676 deletions (deletions dominated by the
  tracked flow-mirror removal chore)
- 4 published packages (settings-core, teammate, cockpit, flow)

Package-level code deltas (excluding repo-level chore and docs):

| Package | Files | Insertions | Deletions |
|---------|------:|-----------:|----------:|
| pi-maestro-settings-core | 2 | +83 | -0 |
| pi-maestro-teammate | 132 | +17,227 | -1,301 |
| pi-cockpit | 58 | +4,686 | -569 |
| pi-maestro-flow | 75 | +4,593 | -764 |

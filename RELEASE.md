# v0.22.0 — Teammate 2.0 Backend Registry, MCPX Dashboard, Prompt Enhance & Usage Insights

> **Post-release status (2026-08-21).** Two packaging-fix patches have been
> published to npm on top of this release: **0.22.1** (declares flow's runtime
> dependency on `pi-maestro-backends`, previously installed only transitively via
> teammate) and **0.22.2** (switches the `maestro-flow` engine constraint from an
> exact pin `0.5.79` to caret `^0.5.79`). Both are pure packaging fixes, so the
> install command and announcement banner remain at `@0.22.0`. Development beyond
> `v0.22.0` (model-registry, completion-durability, DSH ssh, browser
> stealth/attach, computer-use/OCR, MCPX enhancements, …) is tracked in the
> **Unreleased** section of `docs-site/src/content/docs/guides/changelog.md`
> (and `changelog.en.md`) and will be promoted to a formal release section on
> the next tagged version.

## Overview

This release publishes **Teammate 2.0.0** (the committed breaking major, previously
unpublished), **Flow 0.22.0**, **Cockpit 0.17.0**, and **Settings-Core 0.2.0**,
built on 138 commits since v0.21.6 (288 files, +40,490/−3,520). Core engine pin
synced `maestro-flow@0.5.75 → 0.5.79` (upstream latest).

## Highlights

### Teammate 2.0.0 — Backend Registry (breaking major)

- **Breaking**: remote journal format `REMOTE_JOURNAL_VERSION` 1 → 2 with **no
  migration path** — old v1 journals hard-fail at parse time and must be deleted
  and rebuilt; remote protocol vocabulary `RemoteCapability` removed, protocol
  bumped to `remote/2`.
- Inline `cli/<tool>` dispatch removed — routing now goes through the **backend
  registry**; third-party adapters must implement the backend contract.
- New pure-contract package `pi-maestro-backend-core` (capability table expanded
  to 12 entries; credentials modeled as references, not masked values) plus the
  Pi subprocess backend adapter and the dsh backend (per-run hosted loopback MCP
  todo endpoint; `outputSchema` host-side compensation upgraded from unsupported
  to emulated).
- Generic **ACP-CLI TeammateBackend**: facts returned via `outcome.recovery`,
  `settleAcpRun` observes tool events with done/in-flight counts, ACP handshake
  timeout configurable (no longer hardcoded 15s), failover gate driven by
  observed activity.
- **In-process model failover** via `set_model` RPC — hot-swap models without
  restarting the run; manual model switch resets that model's circuit breaker.
- Cross-window workspace peers and cross-window replies; lifecycle-boundary
  regression hardening; task-delegation refinements.

### Flow 0.22.0

- **MCPX dashboard (看板)** — full dashboard on top of the config wizard and
  connection monitor: tunnel health monitoring with anomaly key guidance,
  one-key tunnel restart (T) with automatic URL sync to config + mcpx restart,
  OAuth ops-password display + persistence, workspace management sub-mode (W —
  list/select/remove any workspace), delegated-task status and result display
  (task-orchestration Phase 4), mcpx-for-pmf fork detection, auth-mode 401
  online-detection fix, tunnel URL shown with `/mcp` suffix + client hints, and
  dashboard client-ification (`mcpx-client.ts`).
- **prompt-enhance** — new prompt-enhancement feature on `Alt+Shift+E`
  (Ctrl+Shift+E removed to avoid conflict with Pi `app.thinking.cycle`).
- **`/notify` toast toggle** — `/notify [on|off|error|complete|status]` for
  model-error / turn-complete toasts; error turns suppress the complete toast,
  at most one toast per turn; state persisted.
- **next-suggest** — next-step suggestion widget under the editor after each
  turn; F2 (configurable) fills the editor; configured via API Manager
  (`/api-manager nextsuggest`), persisted under `nextSuggest` in
  `api-manager.json`.
- **Dynamic model discovery** — API Manager queries the provider for a live
  model list, gated behind a saved API key.
- **API Manager config import/export**; teammate CLI tool availability surfaced;
  blocked knowledge candidates shown.
- **submit-gate** — new submit-gate extension (pre-submit gate).
- **Usage insights** — statusline usage history, usage chart, and history
  backfill.
- **`.pi/SYSTEM.md` single-authority migration** — project system instructions
  come only from `.pi/SYSTEM.md`; inline packaged `AGENTS.md` injection retired.
- **Browser** — GenericAgent DOM probe, list folding, navigation detection.
- **Hardening waves** (odyssey-review): lock retries raised to 64 for
  high-contention trust, unified `serializeMutation` lock, event-bus cleanup,
  replay cap, usage-history perf + index atomicity, mcpx tunnel/pid/yaml
  hardening, ops-password masking, backup mode/cap, PID identity verify.

### Cockpit 0.17.0

- **Alt+Shift+T Todo overlay**; blocked-todo priority demoted; visible cap
  raised.
- Same-file edits batched; identical edits rejected atomically.
- `optionsSource` adopted for the model selector (filled by the executor).

### Settings-Core 0.2.0

- `optionsSource` upgraded from a declared field to a working mechanism; the
  model namespace is owned by the executor; `backendOptionsOf` delivers the real
  `host.proxyToolCall`.

## Package Versions

| Package | Version | Change |
|---------|---------|--------|
| pi-maestro-flow | 0.22.0 | minor — MCPX dashboard, prompt-enhance, /notify, model discovery, submit-gate, usage insights |
| pi-maestro-teammate | 2.0.0 | major — backend registry, remote journal v2 (breaking, no migration) |
| pi-cockpit | 0.17.0 | minor — Todo overlay, atomic edit batching, optionsSource |
| pi-maestro-settings-core | 0.2.0 | minor — optionsSource mechanism |
| maestro-flow (engine pin) | 0.5.79 | sync 0.5.75 → 0.5.79 (upstream latest) |

## Upgrade Notes

- **Teammate 2.0.0 is breaking**: old v1 remote journals are unreadable and must
  be deleted and rebuilt; third-party backends must implement the backend
  contract instead of inline `cli/<tool>` dispatch.
- Cockpit's peer range for `pi-maestro-teammate` is now `^2.0.0` — upgrade the
  two together.
- `maestro-flow` is exact-pinned and bumped to 0.5.79 for this release.
- Users relying on the retired inline `AGENTS.md` injection must migrate content
  to `.pi/SYSTEM.md`.

## Install

```bash
pi install npm:pi-maestro-flow@0.22.0
```

## Verification

- All four packages typecheck clean; teammate `build:declarations` +
  `check:declarations` pass.
- Focused tests for changed areas: flow 164 pass, teammate 113 pass / 2 skipped
  / 0 fail.
- Published artifacts verified by registry install + smoke after release.

# v0.23.0 — Runtime Broker & Completion Durability, Computer Use/OCR, Plan Refine, Usage Trends

## Overview

This release publishes **Flow 0.23.0**, **Teammate 2.1.0**, **Cockpit 0.18.0**,
**Settings-Core 0.2.1**, **Backend-Core 0.1.1**, and **Backends 0.1.1**, built on
**121 commits** since v0.22.0 (789 files, +135,044/−12,784). Core engine pin
synced `maestro-flow@0.5.79 → 0.5.82` (upstream latest, caret range).

The headline themes are: a **persistent workspace runtime broker** with
canonical turn lifecycle and **completion-durability** (crash-consistent
redelivery of teammate results); **native Computer Use** with an ONNX OCR
vision pipeline; the **Review & Refine** Plan panel (Apply/Discard in-panel);
**MCPX dashboard** enhancements; **durable flow schedule** controller; and a
**per-provider 7-day token trend** in the Cockpit `/usage` overlay.

## Highlights

### Flow 0.23.0

- **Session/3.0 + chain update** — migrated to the v3 Session/Run chain surface:
  `session/3.0 chain insert/update` with migrate fences and legacy-mode
  classification; flow consumes the core v3 plan-publish producer instead of
  synthesizing the envelope, so Run handoffs are authoritative.
- **Durable flow schedule controller** — Todo-bound schedule projections with a
  serialized, concurrency-balanced suite; schedule control restricted to the
  monitor role; flow-schedule runtime state directory git-ignored.
- **Review & Refine Plan panel** — a multi-role (reviewer/decomposer/optimizer/
  brainstormer) read-only subagent panel with Plan refine + rollback; the Apply
  and Discard actions now live **inside** the refine panel (numbered 1–6 rows +
  `a`/`d` shortcuts) instead of on the Plan confirmation screen, so the refine
  lifecycle is self-contained. `plan-decompose` injects the main-flow
  decomposition prompt for an approved Plan.
- **Native Computer Use** — desktop control tool with manager + broker and
  packaging tests; ONNX RapidOCR vision pipeline with bundled tesseract language
  packs; expanded native Computer Use support.
- **Browser bridge** — stealth anti-fingerprint patches + attach-to-user-browser
  and visible launch modes; per-run request-interception scoping; desktop notify
  + user-attention prompts + schedule identity.
- **API Manager model discovery** enriched with `models.dev` reference specs;
  teammate-visible models filtered for OAuth providers; model-failover
  default-table inheritance + raced-cancel terminality; global default fallback
  priority table.
- **Unified `/install` command** with AI-driven setup docs; self-evolve
  knowledge-moment gating (collection 87→17, −80%) + Phase 7 semantic enrichment,
  tool trajectory, and session wrap; session-info message renderer + self-evolve
  install item.
- Robustness: post-compaction interrupted tasks no longer strand — zombie
  late-completions replay and resume via a unified recovery strategy; loop
  statusline uses status glyphs + relative time; teammate output buckets write
  `.workspace` metadata with cwd-subtree discovery; tracked optional skills
  preserved during cleanup; trajectory episodes typed in self-evolve signals.

### Teammate 2.1.0

- **Workspace runtime broker** (persistent actor architecture) — a sidecar
  broker with a persistent actor model; `PI_RUNTIME_BROKER` defaults to **off**
  to stop intermittent startup hangs (opt-in). Canonical workspace identity
  hardened and the runtime broker hardened.
- **Canonical turn lifecycle + completion durability** — teammate persists the
  canonical turn lifecycle and a **crash-consistent completion outbox** that
  redelivers settled results to the right session (WAL recovery + caller
  notification), with two-channel completion delivery and an `intentRevision`
  fence on the outbox. Completion durability passed two review rounds
  (backward-compat + pin semantics; crash-consistency).
- **Workspace observation & peers** — workspace session observation +
  projection, identify managed workspace windows, cross-window workspace peers
  and replies, authoritative message provenance threaded throughout, and a
  centralized diagnostic logger with a statusline badge. `observe` gains a
  `diagnose` contract and renders the canonical diagnosis; non-verbose observe
  renders the last-result excerpt; the root-session settle is persisted for
  polling observers and **included in the workspace owner snapshot**
  (`mainLastSettle`).
- **Session-scoped model routing overrides** via an LLM tool; session-scoped
  routing overrides are hot-swappable without a restart.
- **Terminal & lifecycle fixes** — structured terminal result inclusion +
  publication validation + owner fixture correction; terminal request identity
  validated; ACP CLI progress streamed to Cockpit; interim text turns
  distinguished from result-ready with an extended lifecycle grace window;
  replayed teammate-complete drained at the next turn boundary; deferred
  context restored after cold-resume failure; unknown-model failure defaults
  to retryable; agent output short-id prefix addressing.
- **Backend contract** — legacy monitor evaluator removed; `mainLastSettle`
  round-trips through `validateWorkspaceMainSettle` (bounds-checked, over-long
  `lastResult` rejected not truncated). Companion contracts published:
  `backend-core` exposes the model-registry contract (`TeammateExecutionMode`
  three-state, transport metadata, `resolveConfig` warnings); `backends` adds
  the DSH remote ssh launch mode + advisory warnings.

### Cockpit 0.18.0

- **Per-provider 7-day token trend** in the `/usage` overlay — a sparkline of
  daily token usage plus a `total tok · $cost · turns/day` summary and the top 2
  models by token share, read from the optional `pi-maestro-flow`
  usage-history store (`~/.pi/agent/usage-history`); omitted on bare Pi when
  that extension hasn't recorded turns. A tiny theme-aware sparkline
  reimplementation uses the same `▁▂▃▄▅▆▇█` glyphs and even-stride downsample as
  the statusline version.
- **Session projection fences, CLI agent badge, and usage bars** — canonical
  teammate runtime status consumed; teammate messages rendered as incoming;
  teammate conversation and work detail shown.
- **Model settings picker** gains an `inherit/default` option; macOS Alt keys
  display as **Option** (unified cross-platform key labels); save confirmation
  with change display + prefix-first model search.

### Settings-Core 0.2.1, Backend-Core 0.1.1, Backends 0.1.1

- **Settings-Core 0.2.1** — `altModifierLabel` (macOS Alt → Option display).
- **Backend-Core 0.1.1** — model-registry contract: `TeammateExecutionMode`
  three-state, transport metadata, `resolveConfig` warnings.
- **Backends 0.1.1** — DSH remote ssh launch mode + `resolveConfig` advisory
  warnings.

### MCPX

- **Inline config editor** in the `/mcpx` TUI (server/auth/commands/files
  permissions); **E key** permanently registers a workspace; the panel
  recognizes windows and tool calls across workspaces; **quick tunnel** process
  discovery + adopt (the wizard can take over an existing tunnel and verify its
  port); `sanitizeTerminalText` fix so ESC-stripping no longer corrupts color
  codes into `[31` garbage.

## Package version table

| Package | Previous | New |
|---|---|---|
| pi-maestro-flow | 0.22.2 | 0.23.0 |
| pi-maestro-teammate | 2.0.0 | 2.1.0 |
| pi-cockpit | 0.17.0 | 0.18.0 |
| pi-maestro-settings-core | 0.2.0 | 0.2.1 |
| pi-maestro-backend-core | 0.1.0 | 0.1.1 |
| pi-maestro-backends | 0.1.0 | 0.1.1 |
| maestro-flow (engine pin) | ^0.5.79 | ^0.5.82 |

## Stats

- **121 commits** since v0.22.0
- **789 files** changed, **+135,044 / −12,784**
- Core engine: `maestro-flow 0.5.79 → 0.5.82`

## Install / Upgrade

```bash
pi install npm:pi-maestro-flow@0.23.0
```

This also pulls the exact companions: `pi-maestro-teammate@2.1.0`,
`pi-cockpit@0.18.0`, `pi-maestro-settings-core@0.2.1`,
`pi-maestro-backend-core@0.1.1`, `pi-maestro-backends@0.1.1`.

`PI_RUNTIME_BROKER` defaults to **off** in this release; enable it explicitly
to opt into the persistent workspace broker sidecar.

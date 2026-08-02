# v0.14.0 — Unified Settings Platform, Lossless Compaction, Mailbox Queue

## Overview

This release introduces the **unified Maestro settings platform** across all
plugins backed by the new `pi-maestro-settings-core` package (versioned
settings + i18n contracts with atomic commit/rollback), a **lossless
compaction overhaul** (tier-0 folding, cross-turn verbatim dedup, lexical
relevance pruning, adaptive cache pruning, soft mechanism toggles),
**workflow-backed Plan execution**, teammate **mailbox message queue** and
**window-tree monitoring**, a new **general-executor** agent role, and a
broad lifecycle/atomicity hardening pass. The external core engine pin stays
at `maestro-flow@0.5.60` (verified in sync with npm latest).

## Package Versions

| Package | v0.13.0 | v0.14.0 |
|---------|---------|---------|
| pi-maestro-flow | 0.13.0 | **0.14.0** |
| pi-maestro-teammate | 1.5.0 | **1.6.0** |
| pi-cockpit | 0.7.0 | **0.8.0** |
| pi-maestro-settings-core | — | **0.1.0** (new) |

## Highlights

### Unified Maestro Settings Platform (`pi-maestro-settings-core` 0.1.0, new)
- New `pi-maestro-settings-core` package: versioned settings schemas, provider
  contracts, and i18n contracts shared by all Pi Maestro plugins (`b4871ebf`)
- Flow settings provider with plugin-owned actions and discovery
  (`packages/pi-maestro-flow/src/settings/flow-settings-provider.ts`),
  API-manager settings provider, and resource-lock hardening
- Cockpit settings shell: providers, coordinator, registry, i18n, locale
  state, and a full settings view (`packages/pi-cockpit/src/settings/*`)
- Teammate settings provider with commit/rollback atomicity hardened across
  providers plus fault-injection regression coverage (`73672d1c`, `0d9ba7ab`)

### Lossless Compaction Overhaul (`pi-maestro-flow`)
- Tier-0 lossless folding ported into the prune pipeline (`afe03474`)
- Content-aware lossless kind routing (`c98aeedf`)
- Cross-turn verbatim dedup with reference protection, hardened against image
  blocks and multi-ref restore fidelity (`d79d34cc`, `30c0d229`)
- Rank prune candidates by lexical relevance with bounded ranking work
  (`98139c8b`, `856c6e66`)
- Adaptive cache pruning driven by hit ratio and age (`82eaf424`)
- Summary-reserve thresholds and capacity-aware summary requests (`caadde39`)
- Soft mechanism toggles exposed in the `maestro-compaction` TUI with deep
  cross-mechanism tests (`bcc8c9dd`, `fd78b152`)

### Plan Workflow Execution (`pi-maestro-flow`)
- Workflow-backed Plan execution with canonical publish binding
  (`77961e45`, `packages/pi-maestro-flow/src/tools/plan-workflow.ts`)

### Teammate Mailbox & Monitoring (`pi-maestro-teammate`)
- Persistent mailbox message queue with workspace-scoped isolation, cold
  resume sync, Windows rename retry, and orphan-state GC (`80070431`,
  `57dcc5fc`, `04222a0c`, `9c372a53`)
- Window-tree monitor view with agent hierarchy and idle peers; monitor
  targets windows via their main session (`0c690c09`, `740204a1`)
- `observe` watch action and `until=completed` blocking wait (`b0a92eae`,
  `9ba09b63`); wait schema requires `name` or `waitMs` (`5569d8e1`)
- New `general-executor` agent role with report schema; enriched builtin
  agents from community conventions (`a93a7b91`)
- Wake the caller when a background agent stalls (`a2d48ce7`)
- Reject self-referencing dependencies (`2584b77e`)

### Pi Cockpit (`pi-cockpit` 0.7.0 → 0.8.0)
- Claude Code-style terminal title with optional LLM generation (`66e6a88d`)
- agents-store state ownership and render refinements (`4031ff36`)
- Settings platform shell and settings view (`settings-shell.ts`,
  `cockpit-provider.ts`, `settings-view.ts`)

### Flow Stability & Ops (`pi-maestro-flow`)
- run-control bound to the Pi session ownership that invoked it (`2d8701b0`)
- Compaction lease hardening, api-provider ops, vision delegation, and
  effort display (`e39bf4db`)
- Bridge model failover retry gaps closed — terminated/timeout classification
  and turn continuation (`2857e95c`)
- Memory bounds: GUI event replay bytes and MCP connection identity leases
  (`d4ce62f0`, `5927d5c3`)

### Other Changes
- Docs: Maestro CLI prerequisite removed — the knowledge system installs with
  the plugin (`10a1d08f`); update notes and new-features usage guide
  (`123add04`)

## Statistics

- 41 commits since v0.13.0
- 238 files changed, +38,922 / −10,718 lines
- pi-maestro-teammate: 99 files (+12,214 / −617)
- pi-maestro-flow: 67 files (+9,695 / −1,296)
- pi-cockpit: 37 files (+5,501 / −50)
- pi-maestro-settings-core: 12 files (+869, new)

## Install / Upgrade

```bash
npm install pi-maestro-flow@0.14.0
```

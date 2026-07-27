# v0.6.0 — Pi Cockpit, Teammate State Rebuild, Soft Plan Mode & Custom API Channels

## Overview

This is a major release headlined by the **first publication of `pi-cockpit`** — a list-mode status stack (live teammates + todo plan) pinned above the editor with a Starship-style footer, rendered exclusively through public extension APIs. The **teammate runtime state layer is rebuilt** around a single state table with hardened lifecycle edge semantics, a real nested-depth guard, and a global concurrency gate. **Plan mode becomes a soft, prompt-only constraint** with zero per-turn cache impact, and **skill injection moves off the system prompt** onto the context channel to eliminate cache busting. A **custom API provider channel** lands alongside the Cockpit, and Goal verification gains adversarial checks, stall detection, and a bounded verifier circuit breaker.

> ⚠️ **Breaking:** `teammate` `background` now defaults to `false` (foreground/blocking). Callers that relied on the old background-by-default behavior must pass `background: true` explicitly. Teammate nesting is capped at two layers.

## Package Versions

| Package | Version | npm |
|---------|---------|-----|
| `pi-maestro-flow` | 0.6.0 | `npm i pi-maestro-flow@0.6.0` |
| `pi-maestro-teammate` | 0.6.0 | `npm i pi-maestro-teammate@0.6.0` |
| `pi-cockpit` | 0.1.0 (first publish) | `npm i pi-cockpit@0.1.0` |

`pi-maestro-flow@0.6.0` pins `pi-maestro-teammate@0.6.0`; `pi-cockpit@0.1.0` peer-depends on `pi-maestro-teammate@^0.6.0`.

## Detailed Changes

### 🛰️ Pi Cockpit (new package — first publish)

A self-contained Pi extension that renders only via public extension APIs (`setWidget`/`setFooter`), 37 commits / 45 files / +5793 lines under `packages/pi-cockpit/`:

- **Status stack widget** — live teammates + todo plan pinned above the editor (`stack-widget.ts`, `agents-store.ts`, `todo-store.ts`)
- **Starship-style footer** — approval state, usage statistics, and control status; safety-relevant state never relies on color alone and never truncates (`footer.ts`)
- **`/cockpit` panel** — viewport-aware row allocation so panels no longer squeeze the main content; three zero-row ambient info panes (`index.ts`, `viewport.ts`, `layout.ts`, `ambient.ts`)
- **`/theme` command** — live-preview, undoable theme picker that expands in-place inside the `/cockpit` panel (Esc no longer overflows the stack) (`theme-picker.ts`, `settings-view.ts`)
- **9 themes** — Notion, Ocean, Amber, and minimal green/purple/cyan/rose/amber variants with unified input borders (`themes/*.json`)
- **Background task cards** — bash-bg tasks render cards that use their full requested height (`bash-bg-widget.ts`, `bash-bg-overlay.ts`, `bash-bg-store.ts`)
- **Todo ownership handoff** — the Todo panel can be handed to the Cockpit extension via the `cockpit:ui-ownership` event (loosely coupled, no package dependency) (`extension/index.ts`)
- 148 tests + clean typecheck; ships `src/`, `themes/`, and `README.md` (30 packed files)

### 🤝 Teammate State Rebuild & Contract Hardening

The `odyssey-improve(teammate-state)` series reconstructs the runtime around a single source of truth, 83 files / +9151/-852 under `packages/pi-maestro-teammate/`:

- **Single TUI state table** — status presentation unified onto one state table; failed agents no longer vanish in the same frame as the event that produced them (`progress-tree.ts`, `agent-status.ts`)
- **Lifecycle edge semantics** — result-ready edge semantics, cohort reclamation, name-conflict handling, and execution-layer lifecycle backstops with bounded buffer overhead (`execution.ts`, `retry.ts`)
- **Real concurrency guards** — nested-depth guard made real (capped at two layers) plus a global concurrency gate (`limits.ts`)
- **Ownership & authorization** — `parentCid` claim must land within the dispatcher subtree; cross-subtree send/abort and `structured_output` authorization enforced (`child-extensions.ts`)
- **Foreground streaming** — foreground tree streaming updates, foreground-lane result publish with grace period + absolute ceiling to prevent caller deadlocks; foreground task list streamlined
- **public/v1 event contract** — cross-extension event contract promoted to `public/v1`; Flow↔Teammate type boundary established (`public/v1/events.d.ts`, `public/v1/index.d.ts`)
- **Breaking default flip** — `background` defaults to `false` (foreground/blocking) with updated invocation/DAG/stage-model guidance
- Provider failure reasons preserved; agents sorted by most-recent activity; interaction queue and wait loop de-bounded

### 🎯 Goal Verification & Recovery

- **Adversarial verification + stall detection + richer diagnostics** (`goal.ts`)
- **Bounded verifier circuit breaker** — infrastructure faults trip a bounded breaker instead of infinite retries
- **Compaction resilience** — Goal and Plan recovery state saved structurally across compaction; Goal compaction continuation restored; goal panel widget reads the registry per-frame instead of freezing on a mount-time snapshot
- **Referential integrity** — `goalId` bindings cascade-unbind on destruction and validate on load; `todo next` no longer revives a user-stopped Goal

### 📝 Soft Plan Mode & Performance

- **Prompt-only plan mode** — plan mode no longer mutates the tool panel or rewrites the system prompt each turn; one-time injection yields **zero per-turn cache impact**; all hard blocks removed in favor of soft constraints
- **Skill injection moved to the context channel** — eliminates per-turn system-prompt cache busting
- **Handoff decoupling** — plan handoff no longer force-links to Goal; the handoff key is given to the model; approval failure reports that the draft is retained instead of swallowing typed errors
- **Permission safety** — plan mode no longer passes mutating tools

### 🔌 Custom API Channels & Provider Config

- **Custom API provider channel** — register custom providers with configurable endpoints (`api-provider-config.ts`, `provider-registry.ts`)
- **MCP sampling handler** refinements (`sampling-handler.ts`)
- Pi 0.82 base-type compatibility fixes; Pi SDK dependency hardening + packaging verification

### 🧰 Tooling & UX

- **`bash_bg` tool** — adaptive foreground/background shell execution registered with system-prompt selection guidance
- **`ask` tool** — options accept supplementary details; "none of the above" supports a custom answer
- **`explore`** — per-explore prompt count capped at `maxAgents`
- **Input history** — persisted per working directory so new sessions can recall prior input; covered by a real TUI render-pipeline test
- **Browser tool** — documented Puppeteer run API, added `visible` (headed) launch, and fixed run-code helper collisions with user declarations
- **Compaction cache stability** — pruning cache invalidation cost model; redundant-judgment converged to a single definition
- **macOS** — shortcuts display as Option key with terminal configuration notes
- **YOLO approval mode** — enabled by default (documented)
- **Skills/agents refactor** — flattened skill directory, `maestro-manage` split into three intent entries, frontmatter unified to the `tools` field, `ralph-executor` demoted to an alias

## Statistics

- **130 commits** since `v0.5.0`
- **747 files changed**, +31,342 / −75,173 lines
- `pi-maestro-flow`: 73 files, +7,056 / −1,215
- `pi-maestro-teammate`: 83 files, +9,151 / −852
- `pi-cockpit`: 45 files, +5,793 (new package)

## Installation & Upgrade

```bash
# Fresh install
npm i pi-maestro-flow@0.6.0
npm i pi-cockpit@0.1.0        # optional Cockpit UI extension

# Upgrade from 0.5.0
npm i pi-maestro-flow@0.6.0 pi-maestro-teammate@0.6.0
```

**Upgrade notes:**

1. `pi-maestro-teammate` must be upgraded to `0.6.0` together with `pi-maestro-flow` — flow `0.6.0` pins teammate `0.6.0`.
2. **Breaking:** teammate `background` now defaults to `false`. If you dispatched teammates expecting them to run detached, pass `background: true` explicitly.
3. Teammate nesting is capped at two levels; deeper chains are rejected.
4. `pi-cockpit` is optional and independent — install it separately to enable the status stack, footer, `/cockpit` panel, and `/theme` picker.

# v0.5.0 — Two-Layer Compaction, Goal Verification Overhaul, MCP Adapter & GUI Sidecar

## Overview

This is a major release focused on **context compaction resilience**, **Goal verification integrity**, and **platform extensibility**. The compaction system is rebuilt with a two-layer architecture to prevent output-token-limit truncation. Goal completion now uses acceptance-command-first verification with hardened evidence checks. A full MCP adapter has been ported with a GUI sidecar service for cross-extension tool registration.

## Package Versions

| Package | Version | npm |
|---------|---------|-----|
| `pi-maestro-flow` | 0.5.0 | `npm i pi-maestro-flow@0.5.0` |
| `pi-maestro-teammate` | 0.4.7 | `npm i pi-maestro-teammate@0.4.7` |

## Detailed Changes

### 🔧 Two-Layer Compaction System

Prevent output-token-limit truncation via a graduated compaction pipeline:

- **Content-aware token estimation (F1)** — replaces naive character counting with structure-aware estimation (`auto-compaction.ts`)
- **Compaction failure circuit breaker (F2)** — halts compaction after repeated failures to avoid infinite loops (`auto-compaction.ts`)
- **Graduated eviction of bulk tool outputs (F3)** — progressively removes large tool outputs before touching conversation content (`auto-compaction.ts`)
- **Redundancy detection + telemetry (F4)** — identifies and deduplicates redundant context blocks (`auto-compaction.ts`)
- **Multi-criteria soft trigger with velocity-based early pruning** — Phase 1 equivalent refactor + Phase 2 velocity pruning to trigger compaction before hard limits (`auto-compaction.ts`)
- **Compaction settings module + arbiter + TUI** — extracted `compaction-settings.ts`, `compaction-arbiter.ts`, and `tui/compaction-settings.ts` for configurable thresholds
- **Plan mode exit + compaction arbitration integration** (`plan.ts`, `compaction-arbiter.ts`)
- Focused tests for F1–F4 + velocity pruning coverage (`test/compaction.test.ts` +1100 lines, `test/compaction-settings.test.ts`, `test/compaction-tui.test.ts`)

### 🎯 Goal Verification Overhaul

- **Acceptance-command-first verification** — Goal completion now runs declared acceptance commands as primary evidence; verifier bash removed (`goal.ts` +914/-lines)
- **Multi-goal registry + Todo quality gate** — supports multiple concurrent Goals with Todo-level quality gate binding (`goal.ts`, `todo.ts`)
- **Compact goal panel + Alt+G detail overlay** — new `goal-overlay.ts` (357 lines) with keyboard-driven detail view
- **Hardened evidence verification** — prevents completion claims without fresh command output (`goal.ts`)
- **Workflow isolation scope** — Goal blocking scoped to its own Workflow, not global (`goal.ts`)
- **Accelerated completion verification** — reduced verifier overhead (`goal.ts`)

### 🔌 MCP Adapter Port

Full MCP (Model Context Protocol) adapter ported with 40+ new source files under `src/mcp/`:

- Server manager, config center, OAuth flow, callback server (`server-manager.ts`, `config.ts`, `mcp-auth-flow.ts`, `mcp-callback-server.ts`)
- MCP panel with menu + toggle + JSON editor mode (`mcp-panel.ts`, 878 lines)
- Setup panel, consent manager, elicitation handler (`mcp-setup-panel.ts`, `consent-manager.ts`, `elicitation-handler.ts`)
- Proxy modes, output guard, sampling handler (`proxy-modes.ts`, `mcp-output-guard.ts`, `sampling-handler.ts`)
- UI server, session, stream types (`ui-server.ts`, `ui-session.ts`, `ui-stream-types.ts`)
- NPX resolver, metadata cache, tool registrar (`npx-resolver.ts`, `metadata-cache.ts`, `tool-registrar.ts`)

### 🖥️ GUI Sidecar Service

- New GUI sidecar with cross-extension tool registration (`src/gui/` — 8 files, ~1000 lines)
- GUI server, client, registry, state, events, tool routes, types (`gui-server.ts`, `gui-client.ts`, `gui-registry.ts`, etc.)
- FFF search tools (fuzzy file finder + literal grep) (`tools/fff.ts`, 108 lines)
- API contextWindow editing + statusline cache hit rate display (`statusline.ts`)

### 🤝 Teammate Lifecycle Fixes

- **Progress token cross-turn accumulation** — tokens now accumulate correctly across turns; sleeping duration frozen during idle (`execution.ts`)
- **Block async teammate status polling** — prevents wasteful polling loops (`extension/index.ts`)
- **Decouple result return from lifecycle confirmation** — result delivery no longer blocked by lifecycle handshake (`execution.ts`)
- **Fix Pi result ready state** — corrects premature ready-state signaling (`execution.ts`)
- Retry utility for teammate operations (`retry.ts`)
- GUI registry shared module (`shared/gui-registry.ts`)

### 📋 Plan Mode Enhancements

- `plan-confirm` / `/plan approve` now triggers mode-change listener to resync approval status bar (`plan-confirm.ts`)
- Plan mode only restricts edit tools, not read/search (`plan.ts`)
- Exit Plan mode action added (`plan.ts`)
- Handoff switch to quality-gate Goal regression tests (`test/plan-lifecycle.test.ts`)

### ✅ Todo Batch Creation

- **Batch create entire plan in ONE call** — `todo action=create` with `tasks` array; array order = execution order; `blockedBy: "#N"` for intra-plan dependencies (`todo.ts` +258 lines)
- Todo UI: color-coded statuses + expandable details + merged goal/runs view (`todo-overlay.ts`)

### 🧩 Skill Management TUI

- New Skill manager with TUI interface — browse, enable/disable, configure skills (`skill-manager.ts`, `skill-manager-tui.ts`, `skill-manager-store.ts`, ~900 lines)

### 🔍 Model Availability Tool

- New `model-availability` tool — reports reachable teammate models + delegate CLI tools + fallback routing (`tools/model-availability.ts`, 190 lines)
- Progressive fallback guidance in system prompt for external model requests

### 🧠 Thinking Intensity Control

- Model-level thinking depth control (`api-provider-config.ts` +270 lines)
- Statusline thinking intensity linkage (`effort-display.ts`)

### 🔄 CLI Adapter Session/Run Architecture

- CLI adapter adapted to Session/Run architecture for v0.5.0 (`cli-adapter.ts`)

### 📖 Documentation

- Chinese default README + English version (`README.md`, `README_EN.md`)
- Comprehensive bilingual USAGE docs (`docs/USAGE.md`, `docs/USAGE_EN.md`, 1375 lines each)
- Plugin tool interface development guide (`docs/plugin-tool-interface-guide.md`, 965 lines)
- Tool interface guide updates — GUI/UCL sidecar, compaction, FFF tools

### 🏗️ System Prompt & Skills Refactor

- Unified system prompt into `.pi/SYSTEM.md`, removed `AGENTS.md`
- Delegation routed to teammate, Plan Mode added, prose trimmed
- 200+ skill files updated (team skills, scholar skills, workflow skills)
- Extension consolidation + workflow knowledge capture

### 🚀 Cache Hit Rate Optimization

- Stable auto-pruning to improve prompt cache hit rate
- Fixed F1–F3 & F6–F10 cache hit issues
- Compact statusline progress bar

## Statistics

- **Commits**: 53 (v0.4.14..v0.5.0)
- **Files changed**: 393
- **Lines**: +38,411 / −3,955
- **pi-maestro-flow src**: 84 files, +20,368 / −741
- **pi-maestro-flow test**: 32 files, +6,592 / −471
- **pi-maestro-teammate src**: 10 files, +795 / −92
- **pi-maestro-teammate test**: 5 files, +687 / −3
- **Skills/docs/config**: 244 files, +9,418 / −2,544

## Upgrade Guide

```bash
npm install pi-maestro-flow@0.5.0
```

`pi-maestro-flow@0.5.0` depends on `pi-maestro-teammate@0.4.7` — the dependency is pinned and will be installed automatically.

## Verification

```bash
npm view pi-maestro-flow@0.5.0 version
npm view pi-maestro-teammate@0.4.7 version
npm view pi-maestro-flow@0.5.0 dependencies.pi-maestro-teammate  # should be 0.4.7
```

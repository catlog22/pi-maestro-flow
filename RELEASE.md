# v0.12.0 — UI Projection, Model-Centric API Manager, Lifecycle Hardening

## Overview

This release introduces the Maestro UI projection system for cockpit integration,
a model-centric single-form API manager, comprehensive lifecycle race fixes across
MCP/LSP/compaction subsystems, and GitHub clone cache TTL management.

## Package Versions

| Package | Version |
|---------|---------|
| pi-maestro-flow | 0.12.0 |
| pi-maestro-teammate | 1.4.0 |
| pi-cockpit | 0.6.0 |

## Highlights

### UI Projection System (`pi-maestro-flow`)
- New `ui-projection.ts`: `MaestroUiPublisher` emits deduped `maestro-ui` snapshots
  (workflow, goals, swarm, planMode, approvalMode) on state changes
- Cockpit pull-query support via `registerMaestroUiQuery`
- Goal panel cooperative ownership: cockpit can withdraw/restore Flow's below-editor panel

### Model-Centric API Manager (`pi-maestro-flow`)
- `/api-manager` now operates on a global model picker instead of provider-first navigation
- New `api-model-editor.ts`: single-form overlay for model editing (falls back to
  step-by-step prompts on hosts without custom form support)
- User-defined Providers gain compat/headers/authHeader editing in the form
- Providers can be enabled or disabled without deleting URL, API key, or model configuration
- `list` output restructured: model-level + provider-level lines
- Insecure HTTP base URL downgraded from error to warning

### MCP Lifecycle Race Fixes (`pi-maestro-flow`)
- `server-manager`: connect() startup owned by manager AbortController, not first caller's
  signal; close() fences pending startup; closeAll() covers pending servers
- `npx-resolver`: cache v2 with canonical keys, exact-version validation, concurrent
  population dedup, env-aware npm cache dir
- `direct-tools` / `index.ts`: generation-aware init promise resolution

### Compaction Hardening (`pi-maestro-flow`)
- `validateSpillPath()`: liveness check for persisted spill paths (containment, regular
  file, no symlink, realpath resolution)
- `hydrateRestoredPrunes()`: async validation with atomic downgrade of dead entries
- Non-destructive `onSessionShutdown()`: preserves prune manifest for session resume
- Epoch freeze: only current-pass prunes eligible for spill upgrade

### Web Access Improvements (`pi-maestro-flow`)
- Unified config cache invalidation: all 14 providers register via `web-config-cache.ts`
- GitHub clone cache: TTL for moving refs (10 min), immutable SHA checkouts, in-flight
  protection, lowercase owner/repo normalization, fail-soft config parse
- GitHub API: AbortSignal threaded through all `gh` subprocess calls

### Keybinding Changes (`pi-maestro-flow`)
- Plan mode toggle: `Alt+P` → `Alt+Shift+P`
- Thinking cycle: `Shift+E` → `Ctrl+Shift+E` (legacy binding auto-migrated)

### LSP Startup Isolation (`pi-maestro-flow`)
- Startup owned by lifecycle signal only; callers abort their wait via `abortable()`
  without cancelling shared startup
- `findProjectRoot` results cached with generation ownership

### Smart Search Fallback (`pi-maestro-flow`)
- `@konbakuyomu/smart-search` moved to optionalDependencies
- Graceful native fallback for search/fetch when Python CLI package is missing

### Pi Cockpit (`pi-cockpit`)
- Sidebar controller: visibility, width, collapse/expand with keyboard shortcuts
- Sidebar render: agent list, workflow status, goal progress in scrollable pane
- Split-pane layout: resizable with drag handle, min/max constraints
- Maestro store: subscribes to `maestro-ui` events for local projection
- Public events API: typed contracts for `cockpit-ui-ownership` and `maestro-ui-snapshot`

### Pi Maestro Teammate (`pi-maestro-teammate`)
- Agent catalog cache with token telemetry
- Retry terminal regression guards hardened
- Network retry policy constants exported for provider reuse
- TUI quiet render mode for cockpit-owned display

### Other Changes
- Skills: config snapshot shared across binding loads per activation (2 reads vs 2*(N+1))
- `maestro-package.ts`: prefers `.pi/SYSTEM.md` over `AGENTS.md`
- `install-workflows.mjs`: failure downgraded to non-fatal warning
- `model-failover`: removed redundant session_start config load

## Statistics

- 22 commits since v0.11.0
- 127 files changed
- +11,140 / −1,058 lines

## Install / Upgrade

```bash
npm install pi-maestro-flow@0.12.0
```

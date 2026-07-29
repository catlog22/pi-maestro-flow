# v0.8.0 - Teammate 1.0, Model Failover, Hook Installer, and Planning Pipeline

## Overview

This release upgrades the orchestration stack around `pi-maestro-teammate@1.0.0`, adds resilient model routing and a stricter planning pipeline, and expands the Pi extension with a native Maestro Hook installer and session knowledge review UI. It also consolidates task dispatch, failure handling, todo ordering, cockpit ownership, and tool contracts across the monorepo.

The release publishes all three workspaces. `pi-maestro-teammate` moves from `0.6.0` to `1.0.0` with a versioned public API and a unified execution model. `pi-cockpit` moves to `0.2.0` because its teammate peer range crosses the 1.0 boundary. `pi-maestro-flow` moves to `0.8.0` and pins both updated sibling packages.

## Package Versions

| Package | Previous | New | Install |
|---------|----------|-----|---------|
| `pi-maestro-teammate` | 0.6.0 | 1.0.0 | `npm i pi-maestro-teammate@1.0.0` |
| `pi-cockpit` | 0.1.2 | 0.2.0 | `npm i pi-cockpit@0.2.0` |
| `pi-maestro-flow` | 0.7.0 | 0.8.0 | `npm i pi-maestro-flow@0.8.0` |

`pi-maestro-flow@0.8.0` depends on `pi-maestro-teammate@1.0.0`, `pi-cockpit@0.2.0`, and `maestro-flow@0.5.58`.

## Detailed Changes

### Teammate 1.0 execution model

- Unified single-task and DAG dispatch behind the `teammate` tool, including dependency-aware output injection, structured results, foreground/background transitions, and nested-agent depth controls.
- Hardened execution lifecycle behavior for retries, failures, timeouts, result publication, progress cursors, and control-center recovery.
- Timed foreground runs now move to the background instead of failing when the interactive wait window expires.
- Introduced a versioned `./v1/*` public API surface and removed the legacy prompt-template exports and bundled prompt catalog.
- Reworked built-in agent roles and discovery, including dedicated analyst, explorer, planner, research, verifier, and workflow contracts.

### Model routing and resilience

- Added per-task model routing with task-type mappings, explicit overrides, configurable thinking levels, and authenticated model catalog validation.
- Added a model circuit breaker and failover routing, with a dedicated settings TUI and status projection.
- Billing and credit-exhaustion failures now skip futile retries and advance directly to the next configured fallback model.
- Improved retry classification, timeout handling, background failure reporting, and structured-output validation.

### Planning pipeline

- Plan mode now delegates every final implementation Plan to the built-in read-only `planner`, which owns a required execution-ready Markdown contract.
- The planner may use bounded read-only analyst, research, and explorer delegates while implementation-capable roles remain approval-gated.
- Added evidence, requirement mapping, executable task DAG, exact validation, risk/recovery, and open-decision requirements to generated Plans.
- Improved direct Plan mode entry, mode-state synchronization, footer projection, and Plan/Todo lifecycle integration.

### Maestro Hook review and installer

- Added a dedicated `/hooks install` TUI with `none`, `minimal`, `standard`, and `full` presets plus per-Hook selection and filtering.
- Installer writes are atomic and lock-protected, preserve unrelated project Hooks, remove legacy Maestro entries, and never grant trust automatically.
- Missing Hook configuration now opens the installer from `/hooks`; installed configurations return to hash-based review and trust.
- Hook permission-shaped output is explicitly advisory. Pi's permission controller remains the only authorization boundary, and non-interactive installation fails closed.

### Knowledge, session, and task workflows

- Added a session knowledge review center and native knowledge/session view models.
- Unified root and teammate todo ordering and improved active-work prioritization, partial updates, overlays, and session projection.
- Added canonical run-control and tool schema alignment across built-in tools.
- Reworked delegate CLI conversion to emit native teammate calls and synchronized the Pi skills and agent catalog.

### Cockpit and interactive UI

- `pi-cockpit@0.2.0` now consumes `pi-maestro-teammate@1.0.0` and coordinates primary footer ownership with Plan mode and the flow extension.
- Simplified background-run summaries and added compact token breakdowns, stable progress rendering, and integration contract coverage.
- Refined provider/model configuration interactions and made Ask review submission explicit.
- Improved cross-platform key normalization and narrow-terminal rendering across interactive overlays.

### Documentation and maintenance

- Updated package guides, tool schema references, bundled skills, project agents, and conversion resources for the teammate 1.0 architecture.
- Added design documentation for multicriteria soft compaction and refreshed runtime dependencies.
- Updated `@modelcontextprotocol/sdk` to `1.30.0` and `maestro-flow` to `0.5.58`.

## Statistics

- 31 commits after `v0.7.0`, plus the Hook installer and planning-contract completion included in the release commit.
- More than 280 tracked files changed across the three workspaces, runtime skills, agents, tests, and documentation.
- More than 33,000 lines added and 5,000 lines removed since `v0.7.0` before generated release metadata.

## Installation and Upgrade

```bash
# Fresh install or upgrade
npm i pi-maestro-flow@0.8.0

# Install the packages independently
npm i pi-maestro-teammate@1.0.0
npm i pi-cockpit@0.2.0
```

Upgrade notes:

- Consumers of `pi-maestro-teammate` should use the versioned `pi-maestro-teammate/v1/*` exports. The deprecated prompt-template API and prompt catalog are no longer published.
- `pi-cockpit@0.2.0` expects `pi-maestro-teammate@^1.0.0` when teammate integration is enabled.
- Use `/hooks install` to configure Maestro project Hooks. Installation changes the config hash and requires an explicit review and trust step.
- Existing `pi-maestro-flow` installations receive `pi-maestro-teammate@1.0.0`, `pi-cockpit@0.2.0`, and `maestro-flow@0.5.58` through exact dependencies.

# v0.9.0 - Proactive Compaction Threshold, Session Export, and Hook Context Rendering

## Overview

This release centers on a reworked proactive compaction model: a dependency-free threshold derivation that keeps compaction starting around 90% of the context window regardless of window size, plus durable owner-typed trigger metadata so each hard compaction records exactly the facts its owner observed. It adds a session export module, a hook context renderer for startup/resume context sections, and a reworked API provider config resolver. It also enriches todo list output, hardens the teammate circuit breaker, and makes plan mode display-only for permission evaluation.

The release publishes all three workspaces. `pi-maestro-teammate` moves from `1.0.0` to `1.1.0`, `pi-cockpit` moves from `0.2.0` to `0.3.0`, and `pi-maestro-flow` moves from `0.8.0` to `0.9.0` and pins both updated sibling packages. The external core engine `maestro-flow` pin is unchanged at `0.5.58` (verified aligned with upstream before release).

## Package Versions

| Package | Previous | New | Install |
|---------|----------|-----|---------|
| `pi-maestro-teammate` | 1.0.0 | 1.1.0 | `npm i pi-maestro-teammate@1.1.0` |
| `pi-cockpit` | 0.2.0 | 0.3.0 | `npm i pi-cockpit@0.3.0` |
| `pi-maestro-flow` | 0.8.0 | 0.9.0 | `npm i pi-maestro-flow@0.9.0` |

`pi-maestro-flow@0.9.0` depends on `pi-maestro-teammate@1.1.0`, `pi-cockpit@0.3.0`, and `maestro-flow@0.5.58`.

## Detailed Changes

### Proactive compaction threshold (`packages/pi-maestro-flow/src/compaction/`)

- Added `compaction-threshold.ts`, a pure, dependency-free derivation of the proactive compaction trigger from model limits and soft pressure settings. A `MIN_RESERVE_RATIO` (0.1) floor keeps compaction starting around 90% of the window even on large contexts, where a fixed absolute reserve would sit dangerously close to 100%.
- Reworked `compaction-arbiter.ts` to carry durable, owner-typed trigger metadata (`mid-turn`, `output-limit`, `plan-handoff`). Each owner records only the facts it observed at the request site; native compaction carries no fabricated trigger.
- Updated `auto-compaction.ts` and `maestro-compaction.ts` to consume the effective reserve derivation and surface the full threshold breakdown to UI and telemetry.
- Expanded the compaction settings TUI (`tui/compaction-settings.ts`, +193) and `compaction-settings.ts` to render the threshold derivation, with substantial new coverage in `test/compaction.test.ts` (+347), `test/compaction-settings.test.ts`, and `test/compaction-tui.test.ts`.

### Session export (`packages/pi-maestro-flow/src/session/`)

- Added `session-export.ts` (+109) for exporting session content, wired through `extension/index.ts` (+52) and covered by `test/session-export.test.ts` (+134), now part of the `test:session` suite.

### Hook context rendering (`packages/pi-maestro-flow/src/hooks/`)

- Added `hook-context-renderer.ts` (+86) to render startup/resume context sections (source, labeled counts), wired through `hooks/pi-adapter.ts`.
- Tracked `.pi/hooks.json` declaring the SessionStart hook chain (session-context, spec-injector).

### API provider config rework (`packages/pi-maestro-flow/src/providers/`)

- Reworked `api-provider-config.ts` (+109) provider resolution logic, with expanded coverage in `test/api-provider-config.test.ts`.

### Todo list enrichment

- `feat(todo)`: list output now surfaces goal binding, blocking relationships, and skill tags for clearer task context.

### Teammate circuit breaker fix (`packages/pi-maestro-teammate/`)

- `fix(teammate)`: prevented the `HALF_OPEN` circuit breaker from getting permanently stuck and fixed acquisition leaks.
- Updated `extension/index.ts` and `tui/render.ts`; added `test/proxy-ipc-binding.test.ts` (+67) and expanded performance/render coverage.

### Plan mode permission fix

- `fix(flow)`: plan mode is now display-only for permission evaluation, so read-only planning no longer trips permission gates.

### pi-cockpit

- Extended `agents-store.ts` (+38) with expanded coverage in `tests/agents-store.test.ts` (+81).

## Statistics

- Commits since v0.8.0: 5
- Files changed: 38 (+2688 / −258)
  - `pi-maestro-flow`: 25 files (+1940 / −172)
  - `pi-maestro-teammate`: 8 files (+294 / −76)
  - `pi-cockpit`: 2 files (+111 / −8)

## Installation / Upgrade

```bash
npm i pi-maestro-flow@0.9.0
```

Upgrade note: `pi-maestro-flow@0.9.0` requires the updated sibling packages `pi-maestro-teammate@1.1.0` and `pi-cockpit@0.3.0`; both are published and pinned by the main package. The `maestro-flow` engine pin is unchanged at `0.5.58`.

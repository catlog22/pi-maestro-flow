# v0.11.0 — Plan Clean-Context Handoff, Quiet-Mode Tool Rendering, Compaction Deferred-Intent Refactor

## Overview

This release makes `/plan approve` execution resilient without a replacement session, ships a repo-wide Quiet-mode tool rendering pass, and lands a large compaction refactor. Plan approval can now reset the model context by compaction — preserving the approved Plan as a deterministic summary — when a new session is unavailable, guarded by a lifecycle-generation/request-id scheme so a stale handoff can never inject work after the plan was reset. Quiet mode compresses built-in tool calls across the whole tool surface (flow, cockpit, teammate) to one-line lifecycle summaries with a configurable glyph set (`check` ✓/✕ vs `dot` ●/○). The compaction pipeline is rebuilt around a deferred-intent model with spill security hardening, and the cockpit gains thinking-fold and thinking-timer widgets. MCP gains auto-auth, and the npm package now publishes the full canonical `.pi` directory.

The release publishes all three workspaces. `pi-maestro-teammate` moves from `1.2.0` to `1.3.0`, `pi-cockpit` moves from `0.4.0` to `0.5.0`, and `pi-maestro-flow` moves from `0.10.0` to `0.11.0` and pins both updated sibling packages. The external core engine `maestro-flow` pin is bumped `0.5.58` → `0.5.59` (verified aligned with npm latest and the upstream source repo before release; re-typechecked against 0.5.59).

## Package Versions

| Package | Previous | New | Install |
|---------|----------|-----|---------|
| `pi-maestro-teammate` | 1.2.0 | 1.3.0 | `npm i pi-maestro-teammate@1.3.0` |
| `pi-cockpit` | 0.4.0 | 0.5.0 | `npm i pi-cockpit@0.5.0` |
| `pi-maestro-flow` | 0.10.0 | 0.11.0 | `npm i pi-maestro-flow@0.11.0` |

`pi-maestro-flow@0.11.0` depends on `pi-maestro-teammate@1.3.0`, `pi-cockpit@0.5.0`, and `maestro-flow@0.5.59`.

## Detailed Changes

### Plan clean-context handoff + model selection (`packages/pi-maestro-flow/src/tools/`)

- **Clean-context handoff via compaction** (`plan.ts`, +446): `/plan approve` can reset the model context by compaction instead of requiring `ctx.newSession`. A `planLifecycleGeneration` + `requestId` identity guards every handoff so a stale request can never inject work after the plan was reset; `finishPlanHandoff`/`isCurrentPlanHandoff` settle each request exactly once. `executeNewSessionHandoff` is extracted for the new-session path; the clean-context path drives `ctx.compact` with a deterministic summary and fails closed when the payload is unavailable.
- **Confirmation relabeling** (`plan-confirm.ts`, +23): new `clearContextMode` (`"new-session"` | `"compaction"`) relabels the execute action ("Reset context then execute" vs "Execute in new session").
- **Plan model selection** (`plan-model.ts`, +209 new): per-plan model selection surfaced through the plan tool surface.
- Tests: `test/plan-lifecycle.test.ts` (+318), `test/plan-model.test.ts` (+185 new), `test/plan-editor.test.ts` (+38).

### Compaction deferred-intent refactor (`packages/pi-maestro-flow/src/compaction/`)

- **Deferred-intent lifecycle** (`auto-compaction.ts`, +639): the mid-turn auto-compaction pipeline is rebuilt around a deferred-intent model with an arbiter lease so plan handoff and auto-compaction cannot race.
- **Clean-context summary override** (`maestro-compaction.ts`, +29): `summaryOverride` + `firstKeptEntryIdOverride` let a clean-context handoff bypass model summarization and keep no old entries, producing a deterministic Plan-only context.
- **Spill security hardening** (`tool-result-spill.ts`, +56): `spillToolResult` rejects mismatched content at an existing path and returns `ok:true` on the EEXIST (already persisted) path.
- **Prune manifest persistence** (`compaction-arbiter.ts`, +12): the cleared prune manifest is persisted in `onCompact`.
- Tests: `test/compaction.test.ts` (+526), `test/tool-result-spill.test.ts` (+33).

### Quiet-mode tool rendering (all three packages)

- **Flow tool surface** (`quiet-render.ts` +93 new, `quiet-state.ts` +35 new): a shared Quiet state mirrors the cockpit enable flag and lifecycle glyph set; every flow-owned tool renderer (fff, lsp-tool, browser-tool, bash-bg, search-tool-bm25, smart-search, model-availability, source-check-tool, todo, MCP tool-result-renderer) collapses to a one-line lifecycle row.
- **Configurable glyph sets** (`quiet-state.ts`): `QuietSymbolMode` `"check"` (…/✓/✕) vs `"dot"` (○/●/!). Symbol changes apply live; turning Quiet off still needs `/reload` to restore native renderers.
- **Cockpit config + renderer** (`pi-cockpit/src/quiet-tools.ts` +310 new, `config.ts`, `settings-view.ts`, `types.ts`): the settings view exposes the Quiet toggle and glyph selector and broadcasts them on `cockpit:ui-ownership`.
- **Teammate TUI** (`pi-maestro-teammate/src/quiet-state.ts` +35, `tui/render.ts` +114): teammate output honors the same Quiet presentation.
- Tests: `pi-cockpit/tests/quiet-tools.test.ts` (+85 new), `pi-maestro-flow/test/quiet-render.test.ts` (+26), `pi-maestro-teammate/test/tui-quiet-render.test.ts` (+177 new).

### Cockpit thinking widgets (`packages/pi-cockpit/src/`)

- **Thinking fold** (`thinking-fold.ts`, +86 new): Quiet mode folds thinking blocks via pi's native thinking toggle; pi owns and persists visibility.
- **Thinking timer** (`thinking-timer.ts`, +224 new): live thinking-duration display.
- Tests: `tests/thinking-fold.test.ts` (+123 new), `tests/thinking-timer.test.ts` (+252 new).

### MCP auto-auth (`packages/pi-maestro-flow/src/mcp/`)

- **Auto-auth flow** (`init.ts` +68, `mcp-manager.ts` +26, `mcp-manager-flow.ts` +25, `mcp-auth-flow.ts`): MCP servers that require OAuth are authenticated automatically during init.

### Full canonical `.pi` directory publishing (`packages/pi-maestro-flow/scripts/`)

- The npm package now ships the full canonical `.pi` directory (skills + agents), not a whitelisted subset (`prepare-package-skills.mjs`).

### Teammate structured output + quiet TUI (`packages/pi-maestro-teammate/`)

- **Structured-output fallback** (`src/runs/execution.ts`, +135): `displayMessageForResult` falls back to the `structured_output` summary instead of `(no output)`.
- Tests: `test/graph-status-and-structured-output.test.ts` (+81), `test/performance-buffers-and-spawn.test.ts` (+108).

### Misc fixes

- **Todo batch dependency indexes** (`src/tools/todo.ts`, +26): batch `blockedBy` indexes simplified to zero-based positions within the same `tasks` array.

### Build / sync tooling + mirror refresh (repo root, `flow/`, `.pi/`)

- **Full-recursive skill copy** (`convert.mjs`): replaces the hardcoded subfolder whitelist `['scripts','references','assets']` — which silently dropped `roles/`, `specs/`, `phases/`, `templates/`, `examples/`, `workflows/`, `agents/`, `index/`, `wisdom/` and their non-`.md` assets — with a full recursive copy.
- **One-shot sync orchestrator** (`sync-pi.mjs`, +147 new): 3-phase pipeline (convert → convert-pi → convert-paths) that ports the Claude harness into `flow/` and verifies every skill subfolder was carried over.
- **Mirror regeneration**: `.pi/` + `flow/` skill & agent mirror regenerated (Claude → pi tool rewrite applied in-place; previously-dropped subfolders recovered).

## Statistics

- Commits since v0.10.0: 10
- Package code: pi-maestro-flow 48 files (+3 295 / −805), pi-cockpit 20 files (+1 516 / −20), pi-maestro-teammate 13 files (+855 / −44)
- Mirror + tooling: ~1 034 files total including the regenerated `.pi`/`flow` skill & agent mirror
- Tests: pi-maestro-flow plan + compaction 168/168, pi-cockpit 199/199, pi-maestro-teammate 376 pass / 0 fail; all typechecks clean (main package re-verified against maestro-flow 0.5.59)

## Upgrade

```bash
npm i pi-maestro-flow@0.11.0
```

No breaking changes. The clean-context handoff activates automatically when `/plan approve` runs in a context without `newSession`; with `newSession` available, behavior is identical to v0.10.0. Quiet mode defaults to the `check` glyph set and is off unless enabled in the cockpit settings. The `maestro-flow` pin moves to `0.5.59`.

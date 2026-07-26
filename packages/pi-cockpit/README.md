# pi-cockpit

A list-mode **agent cockpit** for [Pi](https://pi.dev): a status stack pinned **above the editor** showing live teammates and the current todo plan, plus a Starship-style footer. Everything is drawn through Pi's public extension APIs only (`setWidget` / `setFooter`) — no core patches.

```
 ┌─ AGENTS · 2 running ─────────────────────────────┐   ← setWidget(aboveEditor)
 │ ⠋ explorer  #a1f3c2  map auth   read routes.ts   │
 │ ⠋ explorer  #b9e014  trace jwt  read jwt.ts      │
 ├─ TODO · 1/4 ─────────────────────────────────────┤
 │ 01 ✓ map auth entrypoints                        │
 │ 02 ⠋ trace jwt verify                            │
 │ 03 · implement refresh                           │
 │ 04 · add tests                                   │
 └──────────────────────────────────────────────────┘
 >  dispatch a goal…                                  ← editor (Pi native)
 pi/stream-70b · ctx [████░░░░] 42% · $0.52 · 01:23   ← setFooter
```

## Install

```bash
pi install <path-or-spec>     # or, for one run:
pi -e ./extensions/pi-cockpit
```

## What it shows

- **AGENTS** — every running teammate as a table row (status spinner · role · id · label · live tail), sorted running-first. Collapses to a one-line `N agents running` summary in compact mode.
- **TODO** — the active plan as numbered rows with four states (done ✓ / in-progress spinner / blocked ! / pending ·). Collapses to a segmented progress bar + current step + percent.
- **Footer** — `provider/model · context gauge · ↑in ↓out · $cost · elapsed · git branch`.

Toggle each block between list and compact with `/cockpit`.

## Data sources (and the dependency this implies)

| Block | Source | Available on bare Pi? |
|-------|--------|------------------------|
| AGENTS | `pi.events` channels `teammate:started` / `teammate:message` / `teammate:complete`, broadcast by **pi-maestro-teammate** | **No** — without that extension no events fire, the block stays hidden |
| TODO | the `todo-state` snapshot the **pi-maestro-flow** `todo` tool persists after every mutation (re-read on each `tool_execution_end` and on `session_start`) | **No** — without the `todo` tool the block stays hidden |
| Footer | `ctx.model`, `ctx.getContextUsage()`, session usage totals, `footerData.getGitBranch()` | **Yes** |

So on a stock Pi (no teammate / no todo tool) the extension loads without error, the status stack renders nothing, and only the footer appears. The roster is **self-accumulated from event deltas** — teammates already running before the extension loads are not back-filled (the teammate extension broadcasts deltas, never a full roster). The todo list **is** back-filled on `session_start` from the persisted snapshot.

## Configuration

`~/.pi/agent/cockpit.json` (created on first run):

```json
{
  "enabled": true,
  "agentsMode": "list",
  "todoMode": "list",
  "hideNativeAgents": false
}
```

- `agentsMode` / `todoMode`: `"list"` or `"compact"`.
- `hideNativeAgents`: when `true`, clears the teammate extension's own `teammate-agents` widget (it draws a similar list *below* the editor) so the two don't duplicate. Off by default — the two widgets use different keys and placements and can coexist.

## Command

`/cockpit` opens an overlay to toggle `enabled`, `agentsMode`, `todoMode`, and `hideNativeAgents` (`e` / `a` / `t` / `n`, `Esc` to close). Changes persist immediately.

## Terminal feasibility — what this design deliberately does NOT do

The original mockup was a browser page; a terminal is an ANSI stream with no DOM, no CSS, no focus, no hover. Four mockup effects are **out of scope** here, with replacements:

| Mockup effect | Why it can't work in a TUI | Replacement |
|---------------|----------------------------|-------------|
| Input-focus "power-up" glow (`:has(:focus)`) | no focus pseudo-class; `render(width)` can't see focus | the stack's header dot turns accent-green while an agent is running |
| Hover-to-expand chips/rows | no hover in a terminal | list mode shows everything; compact mode is one line; `/cockpit` toggles |
| Scanlines / logo light-up animation | no overlay/animation layer | a braille spinner frame, advanced on each redraw |
| In-stream thinking-collapse / edit progress bar / colored bash stdout | built-in message & built-in tool rendering is **not** replaceable by extensions (`renderCall`/`renderResult` only apply to tools *you* register) | the conversation stream is left to Pi's native renderer — it is context, not a cockpit deliverable |

## Local development

```bash
cd extensions/pi-cockpit
node --test --experimental-transform-types tests/agents-store.test.ts tests/todo-store.test.ts tests/render.test.ts tests/footer.test.ts
../../node_modules/.bin/tsc -p tsconfig.json     # type-check (uses the monorepo root's tsc + types)
```

The package lives inside the `pi-maestro-flow` tree so it resolves `@earendil-works/*` types from the root `node_modules`, but it is **not** part of the `packages/*` workspace — it neither pollutes the lockfile nor gets swept by monorepo builds.

## License

MIT

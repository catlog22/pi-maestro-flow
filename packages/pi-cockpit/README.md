# pi-cockpit

A list-mode **agent cockpit** for [Pi](https://pi.dev): a status stack pinned **above the editor** showing live teammates and the current todo plan, plus a Starship-style footer. Everything is drawn through Pi's public extension APIs only (`setWidget` / `setFooter`) — no core patches.

It is the third plugin of the `pi-maestro-flow` project (alongside `pi-maestro-flow` and `pi-maestro-teammate`). Since `pi-maestro-flow@0.6.1` it is an exact-pinned dependency of `pi-maestro-flow` — installed together and auto-registered into Pi's `settings.packages` on postinstall — but it also installs and runs standalone.

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

`pi-cockpit` comes automatically with the orchestration layer — installing `pi-maestro-flow@0.6.1` pulls `pi-cockpit@0.1.1` and registers it into `settings.packages` on postinstall, no manual setup required. To use it on its own:

```bash
pi install npm:pi-cockpit     # standalone from npm
# or, for one run:
pi -e ./packages/pi-cockpit
```

## What it shows

- **AGENTS** — every running teammate as a table row (status spinner · role · id · label · live tail), sorted running-first. Collapses to a one-line `N agents running` summary in compact mode.
- **TODO** — the active plan as numbered rows with four states (done ✓ / in-progress spinner / blocked ! / pending ·). Collapses to a segmented progress bar + current step + percent.
- **Footer** — `provider/model · context gauge · ↑in ↓out · $cost · elapsed · git branch`. Since v0.1.1, `bash_bg` background-job state lives on a **dedicated second footer row** so it no longer competes with the primary line.

Toggle each block between list and compact with `/cockpit`.

## Data sources (and the dependency this implies)

| Block | Source | Available on bare Pi? |
|-------|--------|------------------------|
| AGENTS | `pi.events` channels `teammate:started` / `teammate:message` / `teammate:complete`, broadcast by **pi-maestro-teammate** | **No** — without that extension no events fire, the block stays hidden |
| TODO | the `todo-state` snapshot the **pi-maestro-flow** `todo` tool persists after every mutation (re-read on each `tool_execution_end` and on `session_start`) | **No** — without the `todo` tool the block stays hidden |
| Footer | `ctx.model`, `ctx.getContextUsage()`, session usage totals, `footerData.getGitBranch()` | **Yes** |

So on a stock Pi (no teammate / no todo tool) the extension loads without error, the status stack renders nothing, and only the footer appears. The roster is **self-accumulated from event deltas** — teammates already running before the extension loads are not back-filled (the teammate extension broadcasts deltas, never a full roster). The todo list **is** back-filled on `session_start` from the persisted snapshot.

This is the whole coupling story: cockpit has **no package dependency on `pi-maestro-flow`** and only a peer dependency on `pi-maestro-teammate`. It observes the other two plugins through public channels alone — teammate's event broadcasts for AGENTS, and the `todo-state` snapshot flow's `todo` tool persists for TODO. Remove either source and the matching block simply hides; the footer always remains.

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
cd packages/pi-cockpit
node --test --experimental-transform-types tests/agents-store.test.ts tests/todo-store.test.ts tests/render.test.ts tests/footer.test.ts
../../node_modules/.bin/tsc -p tsconfig.json     # type-check (uses the monorepo root's tsc + types)
```

The package lives inside the `pi-maestro-flow` monorepo under `packages/` so it resolves `@earendil-works/*` types from the root `node_modules`. Since v0.6.1 it is also an exact-pinned dependency of `pi-maestro-flow` and ships as its own npm package (`pi-cockpit`).

## License

MIT

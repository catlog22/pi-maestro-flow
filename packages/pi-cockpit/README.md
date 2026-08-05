# pi-cockpit

A responsive **agent cockpit** for [Pi](https://pi.dev): wide terminals get a docked Maestro operations sidebar, narrow terminals automatically fall back to the existing Todo and Agent widgets, and every layout keeps the Starship-style footer.

It is the third plugin of the `pi-maestro-flow` project (alongside `pi-maestro-flow` and `pi-maestro-teammate`). It is installed and registered with `pi-maestro-flow`, but it also runs standalone. Current version: **0.9.1**.

The dock is a non-capturing top-right overlay. Cockpit reserves its columns by wrapping the active TUI renderer at runtime, so the Pi workspace reflows instead of rendering underneath it. No Pi source files are modified.

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

`pi-cockpit` comes automatically with the orchestration layer — installing `pi-maestro-flow` pulls `pi-cockpit` and registers it into `settings.packages` on postinstall, no manual setup required. To use it on its own:

```bash
pi install npm:pi-cockpit@0.9.1     # standalone from npm
# or, for one run:
pi -e ./packages/pi-cockpit
```

## What it shows

- **SIDEBAR** — Workflow Session/Run progress, Goal state and budget, Todo tasks, Teammate roster, background jobs, and read-only Team Swarm progress. Empty sections disappear and constrained heights retain current or failed work before secondary detail.
- **AGENTS** — every running teammate as a table row (status spinner · role · id · label · live tail), sorted running-first. Completed/failed agents show their total duration. On narrow terminals this returns to the below-editor widget.
- **TODO** — the active plan as numbered rows with four states (done ✓ / in-progress spinner / blocked ! / pending ·). On narrow terminals this returns to the above-editor widget.
- **Footer** — `provider/model · context gauge · ↑in ↓out · $cost · elapsed · git branch`. `bash_bg` background-job state lives on a **dedicated second footer row** so it no longer competes with the primary line.
- **Thinking timer** — while the model is thinking, the folded thinking row shows a spinner and running elapsed time; when the run ends, it settles to the actual duration (e.g. `thoughts · 8.4s`).
- **Quiet mode** — compresses the seven built-in tool calls (read/bash/edit/write/grep/find/ls) into single-line ✓/✗/⋯ summaries and folds thinking blocks. Two glyph sets available: `check` (✓/✗/⋯) and `dot` (●/○/◌). Toggle with `/cockpit quiet`; turning off requires `/reload` to restore native tool renderers.

Toggle each block between list and compact with `/cockpit`.

## Data sources (and the dependency this implies)

| Block | Source | Available on bare Pi? |
|-------|--------|------------------------|
| MAESTRO | Versioned `cockpit:maestro-query` / `maestro:ui-snapshot` full snapshots from **pi-maestro-flow** | **No** — Workflow, Goal, and Swarm sections stay hidden |
| AGENTS | `pi.events` channels `teammate:started` / `teammate:message` / `teammate:complete`, broadcast by **pi-maestro-teammate** | **No** — without that extension no events fire, the block stays hidden |
| TODO | the `todo-state` snapshot the **pi-maestro-flow** `todo` tool persists after every mutation (re-read on each `tool_execution_end` and on `session_start`) | **No** — without the `todo` tool the block stays hidden |
| Footer | `ctx.model`, `ctx.getContextUsage()`, session usage totals, `footerData.getGitBranch()` | **Yes** |

So on a stock Pi the extension loads without error, the Maestro sections stay empty, and the footer remains available. The roster is **self-accumulated from event deltas**; Todo is back-filled from the latest durable `todo-state`. Workflow, Goal, and Swarm use a versioned full-replacement snapshot with generation fencing and a query path for cold-start recovery.

Cockpit has no package dependency on `pi-maestro-flow`. It observes optional producers through public event contracts; removing a producer hides only the matching section.

## Configuration

`~/.pi/agent/cockpit.json` (created on first run):

```json
{
  "enabled": true,
  "quietMode": false,
  "quietSymbols": "check",
  "agentsMode": "list",
  "todoMode": "list",
  "todoExpanded": false,
  "hideNativeAgents": true,
  "icons": { "mode": "auto" },
  "sidebar": {
    "mode": "auto",
    "width": 40,
    "density": "comfortable"
  },
  "title": {
    "enabled": true,
    "showSession": true,
    "showCwd": false,
    "showModel": false,
    "showThinking": false,
    "showGit": false,
    "showMaestro": false,
    "maxLength": 80
  },
  "theme": ""
}
```

- `quietMode`: when `true`, compresses built-in tool rendering and folds thinking blocks.
- `quietSymbols`: `"check"` (✓/✗/⋯) or `"dot"` (●/○/◌) lifecycle glyphs for quiet tool rows.
- `agentsMode` / `todoMode`: `"list"` or `"compact"`.
- `todoExpanded`: when `true`, expands the todo widget by default.
- `hideNativeAgents`: when `true`, clears the teammate extension's own `teammate-agents` widget (it draws a similar list *below* the editor) so the two don't duplicate. On by default.
- `sidebar.mode`: `"auto"` or `"on"` enables the dock when at least 72 main columns plus 32 sidebar columns fit; `"off"` always uses widgets.
- `sidebar.width`: persisted dock width, rounded and clamped to `32..56`; default `40`.
- `sidebar.density`: `"comfortable"` or `"compact"`.
- `icons.mode`: `"auto"` (detect Nerd Font), `"nerd"`, or `"ascii"`.
- `title.enabled`: master switch for the terminal tab title (session summary + working state + opt-in tags). On by default.
- `title.showSession`: include the session summary (the `session_info` name, else a short session id) right after `pi`. On by default.
- `title.showCwd`: include the working directory after the session. Off by default — the title stays short, since the tab strip has no room for a wall of tags.
- `title.showModel`: include the active model tag (`m:gpt-5.6-sol`). Off by default.
- `title.showThinking`: include the thinking level tag (`t:high`); skipped while off. Off by default.
- `title.showGit`: include the git branch tag (`git:main`, `git:detached`); read synchronously from `.git/HEAD`, so it costs no process spawn. Off by default.
- `title.showMaestro`: include the Maestro workflow status tag (`wf:running`, `wf:done`). Off by default.
- `title.maxLength`: hard cap on the composed title; the middle is ellided to keep the head and the working-state tail. Clamped to `20..200`; default `80`.
- `title.generationModel`: `"provider/model"` (e.g. `"maestro-qwen/qwen3.8-max-preview"`) of a model registered with the `/api-manager` command (or any other provider pi resolves). When set, the session title is generated by that model over the first completed turn (user prompt + assistant reply) through its OpenAI-compatible endpoint, with a 10s timeout. Empty (default) uses the offline rule-based extractor instead. Generation is best-effort — on any failure the title silently falls back to the rule-based one. Editable from the `/cockpit` settings overlay (`z` or cursor to the `title gen model` row, Enter, type, Enter to save; empty clears back to rule-based).

The tab title is `frame + pi - <session> - <working state>`. The session part follows Claude Code's chain (`sessionTitle ?? agentTitle ?? haikuTitle ?? default`): the `/session name` title wins, otherwise the generated title, otherwise a short session id. The frame is Claude Code's title chrome: `⠂`/`⠐` braille spinner while a turn runs, static `✳` when idle; failure replaces it with `✗`. On quit, Cockpit clears the title so no stale tab label lingers (Claude Code's `CLEAR_TERMINAL_TITLE`).
- `theme`: named theme override; empty string follows the Pi session theme.

## Commands

- `/cockpit` — opens the settings overlay.
- `/maestro-settings` — opens the unified settings shell (Cockpit, Flow, Teammate and integrations).
- `Alt+J` — opens the background Bash jobs overlay (live status, command, cwd, duration, output tail).
- `/cockpit sidebar` — reports the current sidebar mode, width, and density.
- `/cockpit sidebar auto|on|off` — selects dock behavior.
- `/cockpit sidebar resize` or `Ctrl+Shift+R` — enters temporary Resize mode. Left/Right adjusts one column, Shift+Left/Shift+Right adjusts four, Enter accepts, and Escape rolls back. Mouse reporting is active only during Resize mode.
- `/cockpit quiet` — toggles quiet mode; `/cockpit bg` shows background jobs.
- `/theme` — switch theme with live preview; `/theme <name>` applies directly. Pi ships no standalone theme command; cockpit provides one.

## Sidebar compatibility

The split-pane wrapper depends on Pi's current TUI renderer shape and is verified against Pi `0.83.0`. A render integration failure disables the split and retries the original renderer at full width.

Do not enable `pi-cockpit`'s dock and `pi-atelier@0.7.0`'s sidebar together. Both reserve columns by wrapping the same renderer, and `pi-atelier@0.7.0` does not participate in Cockpit's split-owner marker protocol. Use `"sidebar": { "mode": "off" }` when running Atelier.

## Terminal feasibility — what this design deliberately does NOT do

The original mockup was a browser page; a terminal is an ANSI stream with no DOM, no CSS, no focus, no hover. Four mockup effects are **out of scope** here, with replacements:

| Mockup effect | Why it can't work in a TUI | Replacement |
|---------------|----------------------------|-------------|
| Input-focus "power-up" glow (`:has(:focus)`) | no focus pseudo-class; `render(width)` can't see focus | the stack's header dot turns accent-green while an agent is running |
| Hover-to-expand chips/rows | no hover in a terminal | list mode shows everything; compact mode is one line; `/cockpit` toggles |
| Scanlines / logo light-up animation | no overlay/animation layer | a braille spinner frame, advanced on each redraw |
| In-stream thinking-collapse / edit progress bar / colored bash stdout | built-in message & built-in tool rendering is **not** replaceable by extensions (`renderCall`/`renderResult` only apply to tools *you* register) | the conversation stream is left to Pi's native renderer — it is context, not a cockpit deliverable |

## Claude Code-style interactions (all opt-in, all default off)

Three independent settings, each stored in `cockpit.json` and exposed bilingually in `/cockpit` and `/maestro-settings`:

| Setting | Default | Applies | What it does |
|---|---|---|---|
| `doubleEscapeClearInput` | off | after `/reload` | Press Escape twice quickly to clear a non-empty input draft. The first Escape keeps its native meaning; an empty-draft double-Escape stays pi's rewind/tree action. Requires the Cockpit custom editor (`/reload`). |
| `fullscreenInput` | off | after `/reload` | Alternate screen with the editor fixed at the bottom and an application-scrolled transcript. Wheel scrolls history while the editor stays put; `↑ n new · click to bottom` appears when new output arrives while you are scrolled up. Replaces terminal-native scrollback/search inside fullscreen. Requires the Cockpit custom editor (`/reload`). |
| `copyOnSelect` | off | live | Drag inside the fullscreen transcript to select; the visible text is copied to the clipboard on release. Effective only while `fullscreenInput` is active. |

Interaction rules:

- The three settings are independent; `copyOnSelect` is inert without `fullscreenInput`.
- The legacy `pinEditorBottom` keeps working in normal mode and is ignored inside fullscreen.
- If another extension already owns a custom editor, `doubleEscapeClearInput` and `fullscreenInput` fail closed with one warning (they share the Cockpit custom editor) and never overwrite it.
- A clipboard failure shows a warning and keeps the selection so you can retry.

### Terminal capability matrix

Fullscreen needs an alternate screen (`?1049`) and SGR mouse reporting (`1006`/`1002`); copy-on-select additionally needs drag selection to be application-owned. No universal support is claimed — this is best effort, opt-in, and `TERM=dumb`/unset is refused with a warning.

| Terminal | Alternate screen | SGR mouse | Copy-on-select | Verified |
|---|---|---|---|---|
| iTerm2 | ✓ | ✓ | ✓ | expected |
| Ghostty | ✓ | ✓ | ✓ | expected |
| WezTerm | ✓ | ✓ | ✓ | expected |
| kitty | ✓ | ✓ | ✓ | expected |
| Windows Terminal | ✓ | ✓ | ✓ | expected |
| VS Code integrated terminal | ✓ | ✓ | ✓ | expected |
| tmux (no `-T` config) | depends | depends | depends | not claimed |
| `TERM=dumb` | ✗ | ✗ | ✗ | refused with a warning |

### Manual smoke checklist

1. `/maestro-settings` → Cockpit → enable `doubleEscapeClearInput`, then `/reload`; type a draft and press Escape twice — the draft clears; a single Escape does nothing; with an empty draft two Escapes still open the tree selector.
2. Enable `fullscreenInput`, `/reload`; scroll the transcript with the mouse wheel — the editor stays fixed at the bottom; while scrolled up, new output shows the `↑ n new` hint; clicking it returns to the bottom.
3. Enable `copyOnSelect` (live, no reload); drag across transcript lines — the visible text lands on the clipboard (verify with `pbpaste` on macOS); a plain click does not copy; a copy failure (e.g. headless) shows a warning and keeps the selection.
4. Toggle everything off and `/reload` — behavior returns to stock pi.
5. If a terminal ever gets stuck in a blank alternate screen (crash while fullscreen), run `reset` to restore the normal screen.

## Local development

```bash
cd packages/pi-cockpit
npm test
npm run typecheck
npm pack --dry-run
```

The package lives inside the `pi-maestro-flow` monorepo under `packages/` so it resolves `@earendil-works/*` types from the root `node_modules`. It is also an exact-pinned dependency of `pi-maestro-flow` and ships as its own npm package (`pi-cockpit`).

## License

MIT. The split-pane behavior is adapted from `pi-atelier` under its MIT license; attribution is retained in `src/split-pane.ts`.

# pi-maestro-flow

> Maestro workflow orchestration for [Pi](https://github.com/earendil-works/pi) — tools, workflows, and templates

Pi extension providing Maestro's workflow tools. Built on [pi-maestro-teammate](../pi-maestro-teammate/) for the execution engine. Skills and agents live in project-level `.pi/` directory (see root README).

## Contents

| Resource | Count | Description |
|----------|-------|-------------|
| **Maestro tool** | 1 | `maestro` |
| **Goal tool** | 1 | `goal` (`get` / `create`; user-owned lifecycle commands) |
| **Intelligence tools** | 3 | `lsp`, `browser`, `search_tool_bm25` |
| **Workflow docs** | 82 | Installed from `maestro-flow` to `~/.maestro/workflows` |
| **Templates** | 23 | Bundled template files |

Skills (113) and agents (29) are in the project root `.pi/` directory, not in this package.

## Prerequisites

- **Pi coding agent** — the host runtime
- **Maestro CLI** — `maestro search` and `maestro load` for the project knowledge system
- **pi-maestro-teammate** — exploration, analysis, planning, development, review, and testing dispatch
- **pi-maestro-teammate** — peer dependency (optional)

## Install

```bash
# From npm
pi install npm:pi-maestro-flow

# Or from local path (development)
pi install ./packages/pi-maestro-flow
```

After installation:
- Maestro dispatch is available through the single `maestro` tool
- Autonomous Goal state is available through `goal`; use `/goal stop`, `/goal resume`, and `/goal clear` for lifecycle control
- LSP navigation/refactoring, named-tab browser control, and BM25 tool discovery are available through `lsp`, `browser`, and `search_tool_bm25`
- Maestro workflow docs installed at `~/.maestro/workflows/`

## Pi Skill Conversion

Pi skills are generated in two stages. `convert.mjs` performs the source-to-Pi
directory conversion; `convert-pi.mjs --dst .pi` then applies Pi-specific prompt
semantics, including the current Run/Session command surface. The latter is not an
install or prepack concern: package preparation copies the already converted canonical
`.pi/skills` tree unchanged.

Use these checks before publishing a skill change:

```bash
node convert-pi.mjs --dst .pi
npm --prefix packages/pi-maestro-flow run test:conversion
npm --prefix packages/pi-maestro-flow run check:maestro-run-cli
```

Generated human-facing prompts use `maestro run start`, `maestro run done`,
`maestro run edit`, and simple `--chain` commands. `session create --chain-file` is
reserved for coordinator chains that require structured decision or decomposition data.

## Skills Categories

**Workflow orchestration:** `maestro-analyze`, `maestro-plan`, `maestro-execute`, `maestro-ralph-v2`, `maestro-roadmap`

**Quality & review:** `quality-review`, `quality-test`, `quality-refactor`, `security-audit`

**Odyssey workflows:** `odyssey-planex`, `odyssey-debug`, `odyssey-review-test-fix`, `odyssey-ui`

**Team orchestration:** `team-coordinator`, `team-executor`, `team-frontend`, `team-quality-assurance`

**Knowledge management:** `spec-add`, `spec-load`, `manage-knowhow-capture`, `manage-knowledge-audit`

**Academic writing:** `scholar-writing`, `scholar-review`, `scholar-experiment`, `scholar-thesis-docx`

## Tool Actions

### Explore
```
{ action: "explore", prompts: ["Find authentication middleware"], maxTurns: 6 }
```

### Delegate
```
{ action: "delegate", prompt: "Fix the login bug", tool: "claude", mode: "write" }
```

### MOA (Mixture-of-Agents)
```
{ action: "moa", prompts: ["Best approach for caching layer?"] }
```

### Goal

The LLM tool has a deliberately small surface:

```javascript
goal({ action: "create", objective: "Implement JWT authentication" })
goal({ action: "create", objective: "Implement JWT authentication", tokenBudget: "100k" }) // explicit budget
goal({ action: "get" })
```

Token budget is absent by default and exists only when `tokenBudget` or `--tokens` is supplied explicitly. The `/goal` command offers native argument-completion hints for both the unbudgeted and explicitly budgeted forms.

Users control lifecycle transitions with `/goal stop`, `/goal resume [--tokens 100k]`, and `/goal clear`. When the complete agent loop ends normally, `agent_end` automatically runs the independent verifier. `turn_end` does not verify, and `session_shutdown` only persists state. A passing verdict completes and clears the Goal; a failing verdict starts another loop; an inconclusive verdict holds the active Goal until `/goal resume`.

An always-on, width-aware Goal panel is placed `aboveEditor` while a Goal exists. It updates immediately for active, waiting, verifying, verified, stopped, budget-limited, gate-blocked, and error states. Wide layouts include the objective, elapsed time, and round; Token usage and a budget progress bar appear only after a budget is explicitly configured. Narrow layouts collapse to one explicit status line.

Goal persistence is scoped to `sessionManager.getSessionId()`. New and forked sessions start without a Goal even if their conversation history exposes an older Goal entry. Resuming the same session restores its Goal in `WAITING`; unrelated prompts do not acquire Goal ownership or invoke the verifier. Run `/goal resume` to explicitly start the next Goal-owned agent loop.

For a running canonical Workflow, `/new` and `/fork` also suppress automatic lease attachment and Goal projection. Explicit Resume from `/maestro-session` opts the new Pi session back into that Workflow.

Pi reports ordinary process launches as `session_start(reason: "startup")`. The extension therefore checks for a Goal entry owned by the current sessionId before restoring or attaching; `startup` alone never recreates a Goal from a running project Workflow.

For OpenAI-compatible providers, the Goal function schema is a single root `type: "object"`. The execution layer still requires a non-empty `objective` for `create`.

If a provider reports `Invalid schema for function 'goal' ... got 'type: null'`, the running Pi process still has a root-union schema loaded. Update the extension and restart Pi (or reload extensions) before retrying; then use `/goal resume` if the failed request paused an existing Goal.

## Intelligence Tools

### LSP

`lsp` provides diagnostics, definition, references, hover, symbols, rename,
file rename, code actions, type definition, implementation, status, reload,
capabilities, and raw requests. Language servers are reused per project root and
shut down with the Pi session.

#### Default servers and dependencies

| Server | Command | npm package | File types |
|--------|---------|-------------|------------|
| typescript | `typescript-language-server` | `typescript-language-server typescript` | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` |
| python | `pyright-langserver` | `pyright` | `.py` `.pyi` |
| rust | `rust-analyzer` | system install | `.rs` |
| go | `gopls` | `go install golang.org/x/tools/gopls@latest` | `.go` |
| clangd | `clangd` | system install | `.c` `.h` `.cc` `.cpp` `.cxx` `.hpp` |
| json | `vscode-json-language-server` | `vscode-langservers-extracted` | `.json` `.jsonc` |
| yaml | `yaml-language-server` | `yaml-language-server` | `.yaml` `.yml` |

Install all npm-based servers:

```bash
npm install -g typescript-language-server typescript pyright vscode-langservers-extracted yaml-language-server
```

Servers whose binary is not found on `$PATH` will show ENOENT/EPIPE in
`lsp status`. Disable unwanted servers via a config file (see below) rather
than leaving them in error state.

#### Configuration

Configuration is merged in this order; later files override earlier entries:

```text
~/.omp/lsp.json
~/.pi/agent/lsp.json
<workspace>/.omp/lsp.json
<workspace>/.pi/lsp.json
```

Each file may define `disabled` server names and `servers` entries containing
`name`, `command`, `args`, `fileTypes`, `rootMarkers`, `initializationOptions`,
`settings`, and `env`.

### Browser

`browser` uses named tabs with `open`, `run`, and `close`. `open` can launch a
local headless Chromium (`app.path`, optional `app.args`) or connect to an
existing Chrome DevTools Protocol endpoint (`app.cdp_url`, optional
`app.target`). `run` exposes navigation, observation, selector/element input,
evaluation, waits, screenshots, and extraction helpers.

`browser.run` intentionally executes trusted host code with the same
`AsyncFunction` semantics as oh-my-pi. Treat it like shell execution: do not run
untrusted code. Supported asynchronous browser operations obey timeout and
`AbortSignal`; abort or timeout closes the named tab. Session shutdown closes all
tabs and removes automatically created screenshots.

### BM25 tool discovery

`search_tool_bm25` ranks the current Pi tool catalog by name, label, summary,
description, and schema keys, then activates matching inactive tools. Results
use stable ordering and support a caller-supplied `limit`.

In durable Plan mode, BM25 and read-only LSP actions remain available. All
browser actions and LSP mutations (`rename`, `rename_file`, applied code actions,
`reload`, and raw `request`) are blocked until Plan mode is confirmed or exited.

## Durable Plan Mode

Act mode exposes `plan-enter`. Entering Plan mode loads the current chat session draft and
dynamically activates the safe Plan tools:

- `plan-update` — persist complete Markdown to `current.md`
- `plan-review` — open the full-screen multiline editor without approval
- `plan-confirm` — edit and atomically approve before returning to Act mode
- `plan-exit` — leave Plan mode while preserving the draft
- `plan-status` — inspect session ID, path, revision and approval state

Plans are stored outside the project under:

```text
~/.pi/workspaces/<workspace-name>-<path-hash>/sessions/<session-id>-<id-hash>/plans/
├─ current.md
├─ manifest.json              # includes sessionId/sessionFile/sessionName
└─ approvals/<timestamp>-<revision>-<checksum>.md
```

Different chats in the same workspace have independent drafts, revisions,
approval histories and transaction locks. On upgrade, the legacy workspace-level
`plans/` directory is atomically assigned to the first chat session that opens it.

The full-screen editor supports line numbers, current-line highlighting,
multiline cursor editing, `Ctrl+S` save, `Ctrl+Enter` confirm and `Esc` cancel.
`/plan` and `Alt+P` remain available as human-facing aliases.

### Approval-mode shortcut

Maestro Flow registers `Shift+Tab` to cycle the hook approval mode in this order:

```text
default -> acceptEdits -> plan -> dontAsk -> bypassPermissions -> default
```

Pi uses `Shift+Tab` for effort/thinking-level cycling by default, and that action is a
reserved host binding. During `npm install`, Maestro Flow creates or merges
`~/.pi/agent/keybindings.json` so the original effort shortcut moves to `Shift+E`:

```json
{
  "app.thinking.cycle": "shift+e"
}
```

The installer preserves all other shortcuts. If the existing file is invalid JSON, it
is left unchanged and npm prints a warning. Run `/reload` after installation when Pi is
already open. Pi then releases `Shift+Tab`, allowing the extension shortcut to handle
approval-mode cycling. `plan` activates Maestro's durable Plan mode. The other values
control the permission engine and are also forwarded as `permission_mode` to
Codex-style hooks. Permissions are application-level gates, not an operating-system
sandbox.

The statusline follows the effective approval mode. Wide terminals show labels such as
`ACT · APPROVAL acceptEdits`; medium and narrow terminals progressively compact this to
`ACT/acceptEdits` and `A/E`. Active or ready Plan mode always renders approval as `plan`,
regardless of whether it was entered through `Shift+Tab`, `Alt+P`, or `/plan`.

### Permission rules

Permission rules use `Tool` or `Tool(specifier)` syntax and resolve in fixed order:
`deny`, then `ask`, then `allow`. Settings merge from user, project and local files:

1. `~/.pi/agent/settings.json`
2. `.pi/settings.json`
3. `.pi/settings.local.json`

Later files override scalar values such as `defaultMode`; rule arrays are merged and
deduplicated. Because a repository must not grant itself new privileges, project
`allow` rules are ignored until the user persists approval locally, and a project
cannot select `acceptEdits` or `bypassPermissions` as its default mode. An
editor schema is bundled at `schemas/permissions.schema.json`.

```json
{
  "$schema": "../node_modules/pi-maestro-flow/schemas/permissions.schema.json",
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(npm test)", "Read"],
    "ask": ["Bash(git push *)"],
    "deny": ["Read(./.env)", "Bash(rm *)"],
    "disableBypassPermissionsMode": "disable"
  }
}
```

In `default` mode, internal/read-only tools run directly and other tools ask first.
The permission dialog offers `Allow once`, `Always allow`, and `Deny`; `Always allow`
writes an exact rule to `.pi/settings.local.json`; keep this file gitignored.
`acceptEdits` auto-allows built-in
edit tools, `dontAsk` denies tools without an allow rule, and `bypassPermissions`
is the explicit YOLO mode that bypasses allow/ask/deny permission rules. Use
`/permissions yolo` to enable it for the current session, `/permissions` to inspect
active rules, and `/permissions reload` after editing a settings file. Plan mode and
Codex-compatible hooks remain independent enforcement layers.

### Statusline fonts

Pi renders terminal text and ANSI styles; the terminal emulator controls the font
family. Configure the desired font in Windows Terminal, WezTerm, Kitty, iTerm2, or the
host terminal rather than in Maestro Flow. Set `MAESTRO_NERD_FONT=1` before starting Pi
to use the statusline's Nerd Font icon set. Without it, Maestro Flow uses portable
Unicode symbols. Bold and dim ANSI styling are supported when the terminal implements
them, but a single statusline cannot select a different font family from the rest of
the terminal.

## Native swarm command

`/swarm <objective>` activates the bundled `swarm` Skill through Pi's native Skill
expansion path. The Skill first reads the live teammate catalog, then derives task-specific dimensions,
role bindings, task types, Prompts, evidence rules, scoring weights, missions, and synthesis requirements
from the objective. It submits that plan to the built-in
`swarm_runtime` bridge; the TypeScript runtime owns teammate dispatch, MMAS/ACO math,
contract validation, event persistence, and visualization. The runtime resolves the exact catalog roles
selected by the Skill and fails closed on unknown roles, missing stages, unsupported task types, or blank
Prompts. No Python script or shell controller sits between
the Skill and runtime.

The command keeps its primary monitor in Pi's footer as one compact line containing the
current/max iteration and convergence percentage. `/swarm status` reports the same compact
state without opening another surface. The detailed height-aware overlay is diagnostic-only
and opens explicitly through `/swarm inspect`; it provides Live, Prepare, Topology, Metrics,
and Result views. Live and Topology reuse teammate's progress tree and show every
Ant, Scorer, and Analyst with explicit status text, correlation id, tools, tokens, duration,
trail, latest message, idle diagnostics, settlement signal, and errors. It projects authoritative `skill_phase`, `role_bound`,
`prompt_compiled`, teammate assistant/tool delta, `convergence_decision`, and
`artifact_produced` events. Live output is rendered with follow-tail and scroll
controls; a throttled aggregate also appears in Pi's main message stream. Close the
overlay without stopping the run, reopen it with `/swarm inspect`, or preserve partial
artifacts while cancelling with `/swarm stop`. Parallel Ants receive complementary exploration
lenses, and later iterations receive a capped set of prior verified candidates as untrusted
evidence so they can refine or challenge earlier findings. Every run writes a stable
visualization-first contract under `.workflow/swarms/<run-id>/`:

Runtime controls:

- `/swarm --ants 5 --iterations 5 --path-length 5 <objective>` — override the normalized execution envelope
- `/swarm feedback <text>` — apply user guidance from the next iteration
- `/swarm resume [run-id]` — reconcile and resume the latest incomplete persisted run
- `/swarm continue [K] [run-id]` — preserve graph/best/feedback and add more iterations
- `/swarm export <directory>` — export `result.json`, `swarm-report.json`, `best.json`, and `best-solution.md`
- `/swarm archive` — detach the run while retaining all artifacts

Core artifacts:

- `run.json` — complete current snapshot, graph, agents, and metric history
- `iterations/<nnn>.json` — immutable per-iteration assignments and outcomes
- `metrics.jsonl` — chart-ready convergence time series
- `events.jsonl` — ordered Skill, Prompt, teammate, convergence, and artifact event stream
- `result.json` — compact best solution and final synthesis

External dashboards can validate `run.json` against `schemas/swarm-run.schema.json`.

## Shared root and teammate Todo

Todo state is owned and persisted by the root Pi session. Teammate children inherit a
proxy `todo` tool and send mutations over the existing parent IPC channel; they never
write a competing session-local Todo state. Each task records both `createdBy` and
`assignee`. Root can manage every task, while a teammate can update tasks it created or
was assigned, hand work back to root, and keep one assigned task `in_progress` at a
time. Different assignees may work concurrently, and dependencies can cross members.

Press `Alt+T` or run `/maestro-todo` to open the shared Todo Center. Use Left/Right to
switch between All, root, and individual teammate scopes; Up/Down selects a task;
Enter opens its inspector; typing filters by task, member, or ID; Escape returns or
closes. Wide terminals use a list/inspector split, while narrow terminals collapse to
one reversible column and keep the Escape recovery cue visible.

## Session Compaction Checkpoints

Pi compaction is extended with a Maestro recovery checkpoint that preserves the
current Todo snapshot, active Todo skill metadata, working/reference files, and
the previous checkpoint lineage. Skill source is recorded by identity and path
so the normal Todo loader can re-inject the canonical skill after compaction.

## Project skills and teammate agents

The npm package declares its canonical skill set through `pi.skills`, pointing to
the bundled `.pi/skills/` directory. In this repository the source set lives under
`packages/pi-maestro-flow/.pi/skills`, while the root `.pi/settings.json` references
that same directory for local development. Install the package through
`pi install npm:pi-maestro-flow` (or register a local package path) and Pi discovers
the bundled skills through its standard package resource loader.

The package also publishes its Pi-only `AGENTS.md`. The extension reads that bundled
file from the installed package and appends it to Pi's system prompt through the
`before_agent_start` event. This keeps the instructions available after npm installation
without requiring a repository-root `AGENTS.md`, which other coding agents may discover.

`pi-maestro-flow` pins `maestro-flow@0.5.53` as an associated workflow resource package.
During postinstall it calls Maestro's workflows-only installer from the prepared registry
artifact, which includes the complete runtime `dist` tree and canonical workflow documents.
The installer writes to `~/.maestro/workflows`. The active Maestro CLI remains an environment
runtime, and local development may link the latest `maestro-flow` checkout explicitly.
The extension does not register the installed `maestro-flow` package's `.agents/skills`
directory, so compatibility mirrors cannot compete with the plugin's canonical `.pi/skills`
resources.

Agent definitions are not a native Pi package resource type and must not be declared
as `pi.agents`. They are owned by `pi-maestro-teammate`, which discovers Markdown
agent definitions in this priority order:

1. nearest project `.pi/agents/*.md`
2. `~/.pi/agent/extensions/teammate/agents/*.md`
3. the `agents/*.md` directory bundled inside the installed `pi-maestro-teammate` package

Project and user definitions override lower-priority agents with the same frontmatter
`name`. Each file requires `name` and `description`; its Markdown body becomes the
agent system prompt.

Each successful Maestro compaction also writes a non-overwriting session copy to:

```text
<project>/.workflow/knowhow/KNW-<timestamp>-session-compact-<session>-<checkpoint>.md
```

The session entry remains the machine-readable source of truth; the knowhow file
is a durable recovery and audit copy. Repeated compactions carry the prior
knowhow path forward as a reference instead of copying the full previous document.

## Codex-compatible Hooks

Project hooks use `.pi/hooks.json` as their only configuration source. The shape follows the OpenAI Codex `hooks.json` contract; an editor schema is bundled at `schemas/hooks.schema.json`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "python3 .pi/hooks/pre_tool_use.py",
            "commandWindows": "python .pi/hooks/pre_tool_use.py",
            "timeout": 30,
            "statusMessage": "Checking command"
          }
        ]
      }
    ]
  }
}
```

Command hooks receive Codex-compatible JSON on `stdin` and return JSON on `stdout`. Pi maps `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, and `Stop`. `PreToolUse` supports `allow`, `ask`, and `deny`; `PermissionRequest` can allow or deny the pending prompt and may return `updatedInput` or `updatedPermissions`. `SubagentStart` and `SubagentStop` are accepted by the schema but reported as unmapped because Pi does not currently expose equivalent lifecycle events here.

Repository commands require review before first execution. Run `/hooks` to inspect and trust the exact config hash; run `/hooks revoke` to disable it. Any change to `.pi/hooks.json` invalidates the previous trust entry.

## Architecture

```
┌──────────────────────────────────────────┐
│  pi-maestro-flow (extension package)     │
│                                          │
│  Extension tools:                        │
│    maestro                               │
│    lsp · browser · search_tool_bm25      │
│                                          │
│  Runtime assets:                         │
│    Maestro workflows + Templates (23)    │
│                                          │
│  Dispatch via ──► pi-maestro-teammate    │
└──────────────────────────────────────────┘

Skills (113) and agents (29) are in .pi/ at project root.
```

## License

MIT

# pi-maestro-flow

<p align="center">
  <strong>🎼 All-in-One Multi-Agent Orchestration for [Pi Coding Agent](https://github.com/earendil-works/pi)</strong><br />
  <em>One install. The complete engineering team — orchestration, execution, visualization, and knowledge.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-maestro-flow"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/pi-maestro-teammate"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=teammate" /></a>
  <a href="https://www.npmjs.com/package/pi-cockpit"><img alt="npm" src="https://img.shields.io/npm/v/pi-cockpit?color=cb3837&logo=npm&logoColor=white&label=cockpit" /></a>
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

**pi-maestro-flow** is the **all-in-one** entry point of the three-plugin suite. A single `pi install npm:pi-maestro-flow@0.17.1` upgrades the [Pi coding agent](https://github.com/earendil-works/pi) into a coordinated engineering team:

> **v0.17.1 supersedes the withdrawn v0.17.0:** package-relative Skill and agent discovery now works after npm installation, and teammate children isolate explicitly loaded extensions.

| Layer | Package | What you get |
|-------|---------|--------------|
| 🎼 **Orchestration & knowledge** | **pi-maestro-flow** (this) | `maestro` · `goal` · `todo` · `run-control` · `plan-*` · persistent knowledge system (search / spec / knowhow) |
| 🚀 **Parallel execution engine** | [pi-maestro-teammate](../pi-maestro-teammate/) | subprocess agents · DAG dependency graphs · model routing · structured output |
| 🖥️ **Visual status cockpit** | [pi-cockpit](../pi-cockpit/) | live status stack above the editor · Starship-style footer |

The companion plugins are dependencies and **auto-register on postinstall** — no manual setup required.

## Core Features

- 🔀 **Parallel multi-agent dispatch** — spawn multiple subprocess agents at once, with DAG dependency graphs and structured output
- 🎯 **Autonomous Goals** — token-budgeted long-running loops, audited by an independent verifier
- 📝 **Durable Plan mode** — read-only Markdown draft, approve-before-act, dedicated Plan model
- 🧠 **Persistent knowledge system** — semantic search · specs · knowhow, survives across sessions
- 🔌 **Full protocol connectivity** — MCP (OAuth auto-auth) · LSP · Browser (CDP) · Smart Search · source verification
- 🛰️ **Live cockpit visualization** — running teammates & todo plan in real time, 9 built-in themes
- 🧐 **Turn-level Advisor** — optional second-model quality reviewer (`/advisor on`); raises `concern`/`blocker` notes into the session, throttled by the shared supervision gate
- 👁️ **Unified supervision telemetry** — goal/monitor/advisor events on one bus; cockpit `SUP` footer segment + `/supervision` command
- ⏱️ **Adaptive shell** — `bash_bg` auto-backgrounds long commands and notifies on completion
- 🔒 **Permission control** — 5 modes (YOLO enabled by default) · fine-grained allow/ask/deny
- 🪝 **Codex-compatible Hooks** — project hook system with a built-in installer and trust review
- 📦 **63 skills · 32 agent roles · 87 workflow docs · 23 templates** bundled

## Contents

| Resource | Count | Description |
|----------|-------|-------------|
| **Maestro tool** | 1 | `maestro` (explore / delegate / moa) |
| **Goal tool** | 1 | `goal` (`get` / `create` / `update` / `complete`; user-owned lifecycle commands) |
| **Todo tool** | 1 | `todo` (create / update / list / get / delete / clear / next) |
| **Run control** | 1 | `run-control` (status / brief / prepare / check / next / done / edit) |
| **Shell tool** | 1 | `bash_bg` (adaptive foreground/background execution) |
| **Intelligence tools** | 5 | `lsp`, `browser`, `search_tool_bm25`, `smart_search`, `source_check` |
| **Search tools** | 2 | `ffgrep`, `fffind` (FFF-backed fast search) |
| **Other tools** | 3 | `mcp`, `ask-user-question`, `model-availability` |
| **Plan tools** | 5 | `plan-enter`, `plan-update`, `plan-review`, `plan-confirm`, `plan-exit` (+ `plan-status`) |
| **Workflow docs** | 87 | Installed from `maestro-flow` to `~/.maestro/workflows` |
| **Templates** | 23 | Bundled template files |

Skills (63, maintained by [Maestro Flow](https://github.com/catlog22/maestro-flow)) and agents (25) are in the project root `.pi/` directory, not in this package.

## Prerequisites

- **Pi coding agent** — the host runtime
- **Maestro Flow** — the project knowledge system (`maestro search` / `maestro load`) (dependency, auto-installed and auto-registered)
- **pi-maestro-teammate** — the execution engine for exploration, analysis, planning, development, review, and testing dispatch (dependency, auto-installed and auto-registered)
- **pi-cockpit** — the status-stack / footer UI (dependency, auto-installed and auto-registered; optional at runtime)

## Install

```bash
# From npm, including upgrades
pi install npm:pi-maestro-flow@0.17.1

# Or from local path (development)
pi install ./packages/pi-maestro-flow
```

After installation:
- Maestro dispatch is available through the single `maestro` tool
- Autonomous Goal state is available through `goal`; use `/goal stop`, `/goal resume`, and `/goal clear` for lifecycle control
- Adaptive foreground/background shell is available through `bash_bg` (auto-backgrounds on timeout, notifies on completion)
- LSP navigation/refactoring, named-tab browser control, BM25 tool discovery, smart search, and source verification are available through `lsp`, `browser`, `search_tool_bm25`, `smart_search`, and `source_check`
- Compaction capacity management, API retry settings, and model failover are configured through `/maestro-compaction`, `/api-manager`, and `/model-failover`
- Vision delegation is active when the primary model is text-only: `describe_image` is auto-activated and routes image analysis to a multimodal model; configure with `/vision`
- MCP OAuth auto-authentication is managed through `/mcp auth`
- Session export is available through `/export-session-info`
- Companion extensions `pi-maestro-teammate` and `pi-cockpit` are pulled as dependencies and auto-registered into `settings.packages` on postinstall. Flow records the companion sources it manages so upgrades can replace those paths safely; an unowned same-name local registration is retained and logged rather than overwritten.
- Maestro workflow docs installed at `~/.maestro/workflows/`

## Commands

> **macOS:** the `Alt+…` shortcuts below are the **option** key and render as `Option+…`. Your terminal must be set to send option as Meta; see [pi-cockpit's README](../pi-cockpit/README.md#commands) for the iTerm2 and Terminal.app settings.

| Command | Description |
|---------|-------------|
| `/permissions` | Inspect and manage permission rules; `/permissions yolo` enables bypass mode |
| `/plan`, `Alt+Shift+P` | Enter durable Plan mode |
| `/plan-model` | Select or disable a dedicated Plan model |
| `/goal` | Goal lifecycle: `/goal stop`, `/goal resume`, `/goal clear` |
| `/maestro-session` | Canonical Maestro Session management |
| `/maestro-knowledge` | Knowledge store management |
| `/maestro-todo`, `Alt+T` | Shared Todo Center TUI |
| `/maestro-goal` | Goal panel |
| `/maestro-compaction` | Compaction settings TUI (threshold, model, capacity) |
| `/maestro-keybindings` | Shortcut conflict audit and fix |
| `/hooks` | Hook trust review; `/hooks install` opens the installer |

> **macOS:** Alt shortcuts match on the `alt` token everywhere; the UI shows them as `Option+X`. Terminal.app, iTerm2, and the VS Code integrated terminal need Option configured as Meta/Esc+ (or `terminal.integrated.macOptionIsMeta`) before they deliver `alt+X`; Kitty/WezTerm/Ghostty work out of the box. Slash commands are always available as fallbacks, and pi prints a one-time setup hint on affected terminals.
| `/mcp` | MCP server management |
| `/mcp auth` | MCP OAuth authentication flow |
| `/api-manager` | API provider configuration (models, retry settings) |
| `/vision` | Vision delegation settings (model, fallbacks, cache, retries, timeout) |
| `/effort` | Thinking effort level |
| `/model-failover` | Model failover routing configuration; `/model-failover status` shows circuit breaker health |
| `/smart-search` | Smart Search provider configuration |
| `/websearch`, `/curator` | Native web search and content curator |
| `/skills` | Skill manager |
| `/sysprompt` | System prompt inspection |
| `/export-session-info` | Export session identity and history snapshot |

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

Generated human-facing prompts use `maestro session start`, `maestro session done`,
`maestro session chain edit`, and simple `--chain` commands. `session create --chain-file` is
reserved for coordinator chains that require structured decision or decomposition data.

## Skills

63 skills are bundled in the canonical `.pi/skills/` directory and maintained by the [Maestro Flow](https://github.com/catlog22/maestro-flow) project. They span six categories:

| Category | Count | Examples |
|----------|-------|---------|
| Workflow orchestration | 14 | `maestro`, `maestro-next`, `maestro-ralph`, `maestro-companion`, `maestro-odyssey` |
| Knowledge management | 6 | `maestro-spec`, `maestro-knowhow`, `maestro-knowledge`, `maestro-issue` |
| Team orchestration | 25 | `team-swarm`, `team-brainstorm`, `team-roadmap-dev`, `team-review` |
| Academic writing | 10 | `scholar-writing`, `scholar-rebuttal-pro`, `scholar-citation-verify` |
| Skill tooling | 8 | `skill-generator`, `skill-tuning`, `skill-simplify` |

Full skill catalog and source: [Maestro Flow skills directory](https://github.com/catlog22/maestro-flow/tree/main/skills).

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
`/plan` and `Alt+Shift+P` remain available as human-facing aliases.

Plan mode can use a dedicated model while Act mode keeps the session model. Set
`plan.model` to a configured `provider/model` reference in the user, project, or local
settings file. Later settings files override earlier ones; set the value to `null` to
disable an inherited Plan model. Project and local Plan-model settings are ignored until
the workspace is trusted. The model is selected before the first Plan turn and
the previous session model is restored before the next Act turn.

```json
{
  "plan": {
    "model": "anthropic/claude-sonnet-4-5"
  }
}
```

If the configured model is unavailable or has no authentication, Plan mode warns and
continues with the session model. Run `/plan-model` to select an available model,
`/plan-model provider/model` to set one directly, or `/plan-model off` to follow the
session model. The command saves to `.pi/settings.local.json`.

### Approval-mode shortcut

Maestro Flow registers `Shift+Tab` to cycle the hook approval mode in this order:

```text
default -> acceptEdits -> dontAsk -> bypassPermissions -> default
```

Pi uses `Shift+Tab` for effort/thinking-level cycling by default, and that action is a
reserved host binding. During `npm install`, Maestro Flow creates or merges
`~/.pi/agent/keybindings.json` so the original effort shortcut moves to `Ctrl+Shift+E`:

```json
{
  "app.thinking.cycle": "ctrl+shift+e"
}
```

The installer preserves all other shortcuts. If the existing file is invalid JSON, it
is left unchanged and npm prints a warning. Run `/reload` after installation when Pi is
already open. Pi then releases `Shift+Tab`, allowing the extension shortcut to handle
approval-mode cycling. Plan is not part of this carousel; enter durable Plan mode
through `/plan`, `Alt+Shift+P`, or the Plan tools exposed to the LLM. The approval values
control the permission engine and are also forwarded as `permission_mode` to
Codex-style hooks. Permissions are application-level gates, not an operating-system
sandbox.

Run `/maestro-keybindings` to open the shortcut conflict menu. It can audit all
Maestro Flow, Teammate, and Cockpit global shortcuts, apply the recommended
`Shift+Tab` fix, report any remaining custom conflicts, or restore Pi's default binding. The same actions are available directly as
`/maestro-keybindings check`, `/maestro-keybindings fix`, and
`/maestro-keybindings restore`. Run `/reload` after a change; restoring the Pi default
intentionally disables Maestro's conflicting `Shift+Tab` shortcut.

The statusline follows the effective approval mode. Wide terminals show labels such as
`ACT · APPROVAL acceptEdits`; medium and narrow terminals progressively compact this to
`ACT/acceptEdits` and `A/E`. Active or ready Plan mode has its own mode indicator, while
YOLO remains visible because it is safety-relevant.

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

## Team swarm JSON display

`/skill:team-swarm <objective>` is the sole Swarm execution entry. Its coordinator and
`scripts/aco.py` own worker dispatch, pheromone updates, scoring, convergence, resume, and
final synthesis. Maestro Flow no longer registers `/swarm` or exposes `swarm_runtime`.

The extension retains a read-only display adapter. It scans the latest canonical
`{run_dir}/work/team/` JSON state and projects a compact footer plus Summary, Topology,
Metrics, and Result views. The projection reads only:

- `team-session.json` — status, iteration, worker ids, and execution envelope
- `swarm-config.json` / `task-space.json` — objective and task-space nodes
- `pheromone/current.json` and `pheromone/history/*.json` — edge weights and entropy
- `trails/*.jsonl` — per-iteration verified best/mean scores
- `best.json` and `outputs/swarm-report.json` — best candidate and final report paths

The adapter never writes these files, launches teammates, changes convergence, or invents
missing live events. A hidden compatibility input accepts only `/swarm status` and
`/swarm inspect`; it is intentionally absent from command discovery and autocomplete.
All execution and lifecycle controls remain with `team-swarm`.

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

Skills are authored and maintained by the [Maestro Flow](https://github.com/catlog22/maestro-flow) project; this package bundles the canonical `.pi/skills/` tree as a Pi package resource. The npm package declares its skill set through `pi.skills`, pointing to
the bundled `.pi/skills/` directory. In this repository the canonical source set lives under
the root `.pi/skills`; prepack copies it into `packages/pi-maestro-flow/.pi/skills` for npm,
while the root `.pi/settings.json` references its local `skills` directory for development. Install the package through
`pi install npm:pi-maestro-flow@0.17.1` (or register a local package path) and Pi discovers
the bundled skills through its standard package resource loader.

The package also publishes its Pi-only `AGENTS.md`. The extension reads that bundled
file from the installed package and appends it to Pi's system prompt through the
`before_agent_start` event. This keeps the instructions available after npm installation
without requiring a repository-root `AGENTS.md`, which other coding agents may discover.

`pi-maestro-flow` pins `maestro-flow@0.5.67` as an associated workflow resource package.
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

Command hooks receive Codex-compatible JSON on `stdin` and return JSON on `stdout`. Pi maps `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, and `Stop`. Hook permission-shaped outputs are compatibility data, not an authorization channel: `PreToolUse` `allow`, `ask`, `deny`, `block`, and exit-code-2 results do not allow or block the target tool, and `PermissionRequest` decisions or permission updates are ignored. A successful `PreToolUse` `allow` or `ask` result may still provide `updatedInput` or additional context. Target-tool authorization remains exclusively owned by Pi's permission controller. `SubagentStart` and `SubagentStop` are accepted by the schema but reported as unmapped because Pi does not currently expose equivalent lifecycle events here.

Repository commands require review before first execution. Run `/hooks` to inspect and trust the exact config hash; run `/hooks revoke` to disable it. Any change to `.pi/hooks.json` invalidates the previous trust entry.

Run `/hooks install` to open the dedicated Maestro Flow Hooks installer. When the project has no `.pi/hooks.json`, `/hooks` opens the installer automatically. The installer supports the Maestro `none`, `minimal`, `standard`, and `full` presets plus individual Hook selection. It only manages exact `maestro hooks run <name>` entries and preserves unrelated project Hooks. Applying or uninstalling a selection changes the config hash and returns to `/hooks` review; installation never grants trust automatically.

Installer keys: `1`-`4` select a preset, `Space` toggles one Hook, `/` enters filtering, `A` applies the draft, `U` uninstalls Maestro entries, and `Esc` returns without writing. PreToolUse guards are marked advisory because Pi tool authorization remains owned by the permission controller.

## Session Export

`/export-session-info` exports the current session's identity and history-storage snapshot to a file. Useful for debugging, auditing, and cross-session context handoff.

## Compaction Capacity Management

Pi compaction is extended with proactive capacity management:

- **Linked threshold derivation** — computes the earliest safe compaction trigger across both the session model and the configured summary model, preventing context-window overflow.
- **Summary output budget** — validates that the estimated request tokens plus a safety margin leave sufficient output tokens; falls back to the session model when the compaction model cannot fit the checkpoint.
- **Auto-compaction** — mid-turn auto-compaction resolves the linked threshold at session start and uses the governing capacity window for all trigger comparisons.
- **Settings TUI** — `/maestro-compaction` opens a threshold editor showing the output budget, capacity source label, and linked-threshold validation.

## API Retry and Model Failover

- **API retry settings** — `/api-manager` includes a `retry` action to view and toggle API retry behavior (enabled/disabled, max retries up to 12). Settings persist to `settings.json`.
- **Circuit breaker** — model calls are protected by a circuit breaker that trips on repeated failures and automatically recovers after a cooldown period.
- **Failover routing** — `/model-failover` configures automatic failover to backup models when the primary model is unavailable. `/model-failover status` shows live circuit breaker state.

## MCP Auto-Auth

MCP servers that require OAuth authentication are handled automatically: `/mcp auth` manages the authentication flow, and the extension can auto-initiate OAuth when a server returns an authentication challenge during tool calls.

## Architecture

```
┌──────────────────────────────────────────┐
│  pi-maestro-flow (extension package)     │
│  —— top-level entry of the suite ——       │
│                                          │
│  Extension tools:                        │
│    maestro · goal · todo · run-control   │
│    bash_bg · lsp · browser · mcp         │
│    smart_search · source_check            │
│    ffgrep/fffind · search_tool_bm25      │
│    model-availability · plan-*            │
│                                          │
│  Subsystems:                             │
│    compaction · session export · hooks   │
│    API retry · model failover · MCP auth │
│                                          │
│  Runtime assets:                         │
│    Maestro workflows + Templates (23)    │
│                                          │
│  Dispatch via ──► pi-maestro-teammate    │
│  Status UI   ──► pi-cockpit              │
└──────────────────────────────────────────┘

pi-maestro-teammate (execution engine) and pi-cockpit (status UI)
are dependencies and auto-register on postinstall.
Skills (63, by Maestro Flow) and agents (25) are in .pi/ at project root.
```

## License

MIT

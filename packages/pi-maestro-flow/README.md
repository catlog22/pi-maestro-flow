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

**pi-maestro-flow** is the **all-in-one** entry point of the three-plugin suite. A single `pi install npm:pi-maestro-flow@0.32.0` upgrades the [Pi coding agent](https://github.com/earendil-works/pi) into a coordinated engineering team:

> **v0.32.0 — Scoped Decisions, Exact Evidence & Browser Bridge:** human-scoped Plan-auto, advisory policy, exact Goal evidence, multi-listener extension bridging, and scoped Codex Fast. Pi baseline remains 0.99.0; legacy 0.87–0.98 is version-gated. Release verification/publication is tracked in [RELEASE.md](../../RELEASE.md).

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
- 🌉 **Native Gateway ingress** — standalone configuration TUI plus managed Cloudflare Quick/Named, experimental OpenAI Secure, and persistent OpenSSH Reverse tunnel profiles
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
| **Todo tool** | 1 | `todo` (create / update / list / get / delete / clear / next / advance) |
| **Run control** | 1 | `run-control` (`session status`; `run brief/check/next/complete`; `session chain insert/update`) |
| **Shell tool** | 1 | `bash_bg` (adaptive foreground/background execution) |
| **Intelligence tools** | host-dependent | `lsp`, `browser`, `smart_search`, `source_check`; native `tool_search` (legacy `search_tool_bm25`) |
| **Search tools** | 2 | `search`, `fffind` (shared index; bounded rg for plain/regex fallback) |
| **Other tools** | host-dependent | `ask-user-question`, `model-availability`, `open-code-review`; Pi 0.99+ owns MCP |
| **Plan tools** | 5 | `plan-enter`, `plan-update`, `plan-review`, `plan-confirm`, `plan-exit` (+ `plan-status`) |
| **Workflow docs** | 87 | Installed from `maestro-flow` to `~/.maestro/workflows` |
| **Templates** | 23 | Bundled template files |

Skills (63, maintained by [Maestro Flow](https://github.com/catlog22/maestro-flow)) and agents (25) are in the project root `.pi/` directory, not in this package.

## Prerequisites

- **Node.js ≥ 22.19.0**
- **Pi coding agent** — 0.99.0 validation baseline; legacy 0.87–0.98 compatibility is version-gated (optional host peers remain `*`)
- **Maestro Flow** — the project knowledge system (`maestro search` / `maestro load`) (dependency, auto-installed and auto-registered)
- **pi-maestro-teammate** — the execution engine for exploration, analysis, planning, development, review, and testing dispatch (dependency, auto-installed and auto-registered)
- **pi-cockpit** — the status-stack / footer UI (dependency, auto-installed and auto-registered; optional at runtime)

## Install

```bash
# From npm, including upgrades
pi install npm:pi-maestro-flow@0.32.0

# Or from local path (development)
pi install ./packages/pi-maestro-flow
```

After installation:
- Maestro dispatch is available through the single `maestro` tool
- Autonomous Goal state is available through `goal`; use `/goal stop`, `/goal resume`, and `/goal clear` for lifecycle control
- Adaptive foreground/background shell is available through `bash_bg` (auto-backgrounds on timeout, notifies on completion)
- LSP navigation/refactoring, named-tab browser control, smart search, and source verification are available through `lsp`, `browser`, `smart_search`, and `source_check`; Pi 0.99+ owns `tool_search`, while legacy hosts use `search_tool_bm25`
- Compaction capacity management, API retry settings, and model failover are configured through `/maestro-compaction`, `/api-manager`, and `/model-failover`
- Vision delegation is active when the primary model is text-only: `describe_image` is auto-activated and routes image analysis to a multimodal model; configure with `/vision`
- Pi 0.99+ uses native `/mcp` and `/mcp login <name>`; `/mcp auth` is legacy-only. Disable `builtin:mcp` before previewing and approving migration with `/maestro-mcp-migrate`.
- `open-code-review` integrates a separately installed `ocr` CLI for preview/rules/review/health; configure its review model via `/api-manager open-code-review` (see `optional/OCR-SETUP.md`).
- Native Cockpit Quiet mode toggles live without changing execution or activating extra tools; first resumed-history rendering may still be official, and third-party execution-only overrides cannot be identified by the public API.
- Ask transports race the local TUI with cancellation cleanup; Plan confirm/review exposes an optional transport seam, not a bundled remote client UI.
- DSH users must install the optional peer `@deepseek-ai/dsh-sdk-client` manually; the development baseline is 0.1.0-rc.6.
- Session export is available through `/export-session-info`
- Companion extensions `pi-maestro-teammate` and `pi-cockpit` are pulled as dependencies and auto-registered into `settings.packages` on postinstall. Flow records the companion sources it manages so upgrades can replace those paths safely; an unowned same-name local registration is retained and logged rather than overwritten.
- Maestro workflow docs installed at `~/.maestro/workflows/`

### Browser Bridge and runtime safety (v0.32.0)

See [Browser Bridge Setup](optional/BROWSER-BRIDGE-SETUP.md) for multiple
listeners in `19222..19231`, default paired vs explicit
`PI_BROWSER_BRIDGE_AUTH_MODE=none`, and popup Advanced custom ports. NONE is
ready without token/pair (`transportReady:true`, `authenticatedConnected:false`),
not authenticated. Select `app.channel` explicitly; extension has limited APIs,
physical-tab leases, and shared cookies/login state, not full Puppeteer isolation.
Chrome136 profile debugging requires a chosen non-default user-data-dir;
auto-launch uses dynamic port 0, never copies/switches profiles.

`/skill:decision-policy` is a manual configuration lane with exact human-confirmed
revision saves; machine recommendations are not user answers or approval.
`goal complete` accepts requirement-bound `evidenceRefs` with exact URI/path
sources. `/fast` and teammate `fast` overrides request Codex priority only for
matching Codex Responses payloads (possibly more quota, not a speed guarantee).
Remote Ask/Plan failures keep local TUI prompts alive for reconnect; explicit
cancel/abort still clean up. The external OpenCodeReview runner has bounded
output/timeouts and process-tree cleanup; it is not image OCR.

### Gateway cutover

The built-in Gateway is managed through `/gateway` and the `pi-maestro-gateway` CLI. Its supported package API is `pi-maestro-flow/gateway/v1`; the unrelated `pi-maestro-flow/src/*` wildcard export remains available.

Gateway configuration can also be edited without starting Pi:

```bash
pi-maestro-gateway config
pi-maestro-gateway config --config /secure/gateway.yaml
```

The standalone TUI edits the listener, transport switches, command policy, localhost/proxy guards, and log level. It deliberately does not display or modify credentials or tunnel-profile lifecycle. Use `/gateway tunnel` for the dedicated profile editor, state-only doctor, safe connection descriptor, and manual lifecycle controls; the CLI equivalent is `pi-maestro-gateway tunnel profile ...`. Persistent profiles are managed with `enable|disable|status|restart`; only one persistent profile may be enabled, and its HTTPS `publicUrl` must match the OAuth server origin. See the [Gateway Tunnel configuration guide](../../docs/gateway-tunnel-configuration.md) and the [OpenAI Secure MCP Tunnel setup](optional/OPENAI-TUNNEL-SETUP.md) for provider-specific examples and requirements.

The MCPX compatibility facade, `/mcpx` command, legacy deep-import files, and `PI_MCPX_BRIDGE`, `MCPX_BIN`, and `MCPX_TUNNEL_*` environment variables have been removed. Existing legacy state is read only by the explicit offline migration command:

```bash
pi-maestro-gateway migrate-legacy --dry-run
pi-maestro-gateway migrate-legacy --apply
```

Normal Gateway startup does not read legacy state. Calls that can safely replay are limited to reads and mutations backed by a canonical `operationId`; an unreceipted mutation that may have reached the server fails with `gateway_outcome_unknown` instead of switching transports and replaying.

## Commands

> **macOS:** the `Alt+…` shortcuts below are the **option** key and render as `Option+…`. Your terminal must be set to send option as Meta; see [pi-cockpit's README](../pi-cockpit/README.md#commands) for the iTerm2 and Terminal.app settings.

| Command | Description |
|---------|-------------|
| `/permissions` | Inspect and manage permission rules; `/permissions yolo` enables bypass mode |
| `/gateway` | Open the native Gateway management overlay; `/gateway wizard` opens guided setup |
| `/gateway tunnel` / `/gateway-tunnel` | Open the dedicated Gateway Tunnel operator page |
| `/plan`, `Alt+Shift+P` | Enter durable Plan mode |
| `/plan-auto [on\|off\|status]`, `Alt+Shift+A` | Toggle human, session-only Plan preauthorization (default off) |
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
| `/api-manager` | API provider configuration (models, retry settings, model thinking defaults) |
| `/vision` | Vision delegation settings (model, fallbacks, cache, retries, timeout) |
| `/model-failover` | Model failover routing configuration; `/model-failover status` shows circuit breaker health |
| `/smart-search` | Smart Search provider configuration |
| `/websearch`, `/curator` | Native web search and content curator |
| `/skills` | Skill manager |
| `/sysprompt` | System prompt inspection |
| `/export-session-info` | Export session identity and history snapshot |

## Run Control

`run-control` is the only LLM tool surface for Maestro Session/Run lifecycle commands. Pass canonical CLI arguments as an `argv` array without the leading `maestro`; do not issue lifecycle mutations through bash. It can open a new Session as well as operate on an active or explicitly named Session, but the Workflow Coordinator must be available for every call.

Session/3.0 has no mutation lease. The coordinator injects the current Pi identity as identical `--participant` and `--actor` values, plus a request ID, reason, and JSON output. `session open` has no Session/CAS target yet. Active-Session mutations receive the exact `--session` and orchestration revision; Run mutations also receive the Run revision. Migration alone uses legacy identity/activity revision fences. Revision conflicts fail closed and require a fresh read; the coordinator does not silently retry with a replaced revision.

```javascript
run-control({ argv: ["session", "status", "--session", "session-123", "--json"] })
run-control({ argv: ["run", "brief", "run-123", "--session", "session-123", "--json"] })
run-control({ argv: ["run", "check", "run-123", "--session", "session-123", "--json"] })
run-control({ argv: ["session", "chain", "insert", "--session", "session-123", "--step-id", "review-1", "--command", "review", "--arg", "src", "--json"] })
run-control({ argv: ["session", "chain", "update", "--session", "session-123", "--step-id", "review-1", "--stage", "verification", "--json"] })
run-control({ argv: ["run", "next", "--session", "session-123", "--json"] })
run-control({ argv: ["run", "complete", "run-123", "--session", "session-123", "--verdict", "done", "--advance", "--json"] })
```

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

Generated core Pi skills include `run-control` in `allowed-tools` and route lifecycle operations through that host tool. Their retained Maestro CLI lines are human syntax references copied from the canonical source, including the receipt-chained `session open` -> `session chain insert|update --arg` -> `run next` contract with participant equal to actor, distinct request IDs, reasons, and exact entity revisions. The converter does not synthesize `run start`, `run edit`, `run prepare`, or `session open --chain-file` as canonical v3 commands.

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

For a running canonical Workflow, `/new` and `/fork` suppress automatic active-Session and Goal projection. Explicit Resume from `/maestro-session` opts the new Pi session back into that Workflow; session/3.0 mutation authority remains participant identity plus entity-revision CAS, not a host lease.

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

### Session-only Plan auto-confirm

After entering Plan mode, type `/plan-auto on` in the parent TUI or press
`Alt+Shift+A`. `/plan-auto` without arguments toggles; `status` reports the grant,
and `off` revokes it. Only physical TUI submission or the shortcut can enable it;
model-injected commands, child agents, RPC and resumed audit entries cannot.

The next `plan-confirm` approves the exact persisted draft through the normal
archive/manifest transaction and starts **standalone, current-context** execution.
Enabling does not approve an existing draft immediately; `plan-update` only saves
and `plan-review` remains manual. Old Workflow/New Context settings are not inherited.

During planning and execution, `ask-user-question` can return classified internal
technical recommendations instead of opening a dialog. Existing project rules
remain additional restrictions. Without project ask rules, only reversible,
code/spec-grounded choices inside the authorized task qualify. Classification
uses the existing backend: `auto` may fall back from classifier to LLM; strict
`classifier` failures require a human. Advice is a separate LLM stage. No classifier
configuration or project policy is changed. Machine results stay in `decisions`,
never in human `answers`, and are not approval for Plan, permissions or governance.
Sensitive choices, personal preferences, uncertain scope, low confidence, invalid
output, timeouts and exhausted budgets require a human; configuration and remote
human-only flows are unchanged.

The footer shows `PLAN-AUTO confirm+ask` or `PLAN-AUTO ask`. The grant survives
revision, ordinary compaction and same-session `new_context`, but is revoked by
off, manual Plan exit/clear, a new Plan cycle, session/cwd change, fork, reload,
restart or shutdown. It is never restored from disk. Turning it off stops future
automatic decisions, not already-started execution. Approval already committed
before revocation remains recorded, but an unstarted automatic handoff is stopped.

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

Todo is live execution state. Call `todo({ action: "advance" })` to activate the
caller's first runnable task. When that task finishes, call
`todo({ action: "advance", id, summary })` immediately to complete it and activate the
caller's next runnable task. Use `update` with `status: "completed"` when completion
must not start another task; `next` remains the activation-only compatibility action.
`advance` never completes or activates another assignee's task. For one logical outcome
that needs several roles, create one parent task plus one singly owned child task per
role instead of sharing terminal ownership of one item. Canonical Workflow Session/Run
mirror Todos remain lifecycle projections and continue to advance through Run control.

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
`pi install npm:pi-maestro-flow@0.31.3` (or register a local package path) and Pi discovers
the bundled skills through its standard package resource loader.

Project system instructions use `.pi/SYSTEM.md` as their single authority; the
previous bundled `AGENTS.md` injection is retired. Migrate projects that depended
on that old injection to `.pi/SYSTEM.md`.

`pi-maestro-flow` depends on `maestro-flow >=0.5.87` as an associated workflow resource package (a range, not an exact pin).
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

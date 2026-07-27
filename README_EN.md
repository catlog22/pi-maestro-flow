# pi-maestro-flow

<p align="center">
  <strong>🎼 Multi-Agent Orchestration for Pi Coding Agent</strong><br />
  <em>Turn a single coding agent into a coordinated engineering team.</em>
</p>

<p align="center">
  <a href="README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-maestro-flow"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/pi-maestro-teammate"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=teammate" /></a>
  <a href="https://www.npmjs.com/package/pi-cockpit"><img alt="npm" src="https://img.shields.io/npm/v/pi-cockpit?color=cb3837&logo=npm&logoColor=white&label=cockpit" /></a>
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## Core Features

Pi is a powerful coding agent — but one agent can only do one thing at a time. **pi-maestro-flow** is an orchestration layer made of three plugins (see [The Three Plugins](#the-three-plugins--how-they-relate) below), giving Pi:

### 🔀 Parallel Multi-Agent Dispatch
Spawn multiple subprocess agents working concurrently. DAG dependency graphs, RPC messaging, structured prompt templates — each task with independent model and thinking depth control.

```javascript
teammate({
  tasks: [
    { name: "defs", agent: "explorer", task: "FIND: Auth exports\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", task: "FIND: Auth imports\nSCOPE: src/" },
    { name: "report", agent: "delegate", task: "Merge {defs} + {calls} into a gap report" }
  ]
})
```

### 🎯 Goal Mode — Autonomous Long-Running Objectives
Set an objective with an optional token budget. The agent loops autonomously across turns. An **independent verifier** audits the completion claim.

```javascript
goal({ action: "create", objective: "Implement JWT authentication module", tokenBudget: "100k" })
```

```bash
/goal status                 # Check progress (live panel above input)
/goal stop                   # Pause (state persisted)
/goal resume --tokens 200k   # Resume with raised budget
```

**How it works:** create → autonomous loop (plan → execute → self-check) → independent verification → `pass` auto-completes / `fail` continues with unmet requirements / `inconclusive` waits for user resume

### 📝 Plan Mode — Approve Before You Change
Enter a read-only planning state: draft a Markdown plan, get explicit user approval before any code change. Since v0.6.0 Plan mode is a **soft constraint**: it takes effect through a one-time prompt injection, no longer rewriting the system prompt or mutating the tool panel each turn — **zero per-turn cache impact**. Skill injection also moved to the context channel, eliminating per-turn cache busting.

```bash
/plan                        # Toggle Plan/Act mode (or Alt+P)
/plan approve                # Approve plan, restore editing tools
```

**How it works:** enter plan mode (mutating tools not released) → draft plan (`plan-update`/`plan-review`) → user approval (`plan-confirm`) → commit & restore / abandon via `plan-exit` without committing (draft retained). Ideal for complex or risky multi-step work.

> 💡 **macOS note:** `Alt+P` (and `Alt+T` / `Alt+G`) show as `Option+P/T/G` on macOS. If they don't fire, enable "Use Option as Meta key" in your terminal (iTerm2: *Settings → Profiles → Keys → Option Key → Esc+*; Terminal.app: *Settings → Profiles → Keyboard → Use Option as Meta key*). Kitty / WezTerm / Ghostty work out of the box; `Shift+Tab` and `Ctrl+` shortcuts are unaffected.

### 🧠 Persistent Knowledge System
Semantic search, spec management, knowhow capture — survives across sessions. Supports supersession and conflict lifecycle.

```bash
maestro search "auth pattern" --code     # Semantic search (specs + code)
/spec-add coding "Result types" "..."    # Capture conventions
```

### 🔌 Full Protocol Connectivity
- **MCP Client** — unified proxy tool for any MCP server (OAuth, UI sessions, streaming)
- **LSP Integration** — diagnostics, go-to-definition, find-references, rename
- **Browser Control** — Chromium via CDP (screenshots, JS execution)
- **Web Search** — quick lookup, deep research, URL content extraction

### 🔒 Permission Control
5 permission modes (default / acceptEdits / plan / dontAsk / bypassPermissions), fine-grained allow/ask/deny rules, teammate child process relay. Since v0.6.0 **YOLO approval mode** (`bypassPermissions`) is enabled by default (inspect and adjust with `/permissions`); `Shift+Tab` cycles through the five modes.

### 👥 27 Specialized Agent Roles
explorer, reviewer, debugger, planner, verifier, roadmapper… working in structured pipelines.

### 💡 Thinking Depth Control
Per-task reasoning depth: `off` → `minimal` → `low` → `medium` → `high` → `xhigh`

### 🛰️ Pi Cockpit — Visual Status Stack (first published in v0.6.0)
The third plugin, **pi-cockpit**, pins a status stack above the editor showing live teammates and the current todo plan, with a Starship-style footer (`provider/model · context gauge · ↑in ↓out · $cost · elapsed · git branch`). Everything renders through Pi's public extension APIs only (`setWidget`/`setFooter`) — no core patches. Ships 9 themes; the `/cockpit` panel and `/theme` picker switch them with live preview.

### ⏱️ bash_bg — Adaptive Foreground/Background Shell (new in v0.6.0)
`bash_bg` blocks in the foreground like plain `bash`; if a command outlives its timeout it **automatically moves to the background** and notifies you on completion (a new turn) instead of blocking the current one. Ideal for uncertain, long, or unbounded commands (dev servers, `npm test`, builds). v0.6.1 corrected the foreground/background completion semantics: results are delivered instantly, the log entry shows only when output is truncated, and cockpit places its state on a second footer row.

### 🔌 Custom API Channels (new in v0.6.0)
Beyond the built-in providers, you can register **custom API provider channels** with any OpenAI-compatible endpoint (`api-provider-config.ts` / `provider-registry.ts`), plus refined MCP sampling handler — suited to private deployments and proxy gateways.

---

## Installation

pi-maestro-flow is a **Pi plugin** (Pi extension). It is installed into the Pi Coding Agent via `pi install`, not as a regular npm dependency.

### 1. Prerequisites

| Component | Version | Notes |
|-----------|---------|-------|
| [Node.js](https://nodejs.org) | ≥ 22.19.0 | Runtime |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.74.0 | Host runtime (required) |
| [Maestro CLI](https://github.com/catlog22/maestro2) | ≥ 1.0.0 | Knowledge system features (optional) |

```bash
# Check Node.js version
node --version

# Install Pi Coding Agent globally (host runtime)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Install Maestro CLI globally (knowledge system features, optional)
npm install -g maestro-flow

# Authenticate Pi (pick one)
export ANTHROPIC_API_KEY=sk-ant-...   # Option A: environment variable
pi                                     # Option B: run /login after startup to pick a provider
```

### 2. Install the Plugin

```bash
# From npm (pi-maestro-teammate and pi-cockpit are auto-installed as dependencies)
pi install npm:pi-maestro-flow

# Or from a local path (development mode)
pi install ./packages/pi-maestro-flow
```

> 📦 **Companion auto-registration (v0.6.1):** Pi only loads packages explicitly listed in `settings.packages`; it never walks a package's dependency tree. So `pi-maestro-flow` runs a best-effort `postinstall` step (`scripts/register-companion-packages.mjs`) that idempotently merges **`pi-maestro-teammate`** and **`pi-cockpit`** into the `packages` array of `~/.pi/agent/settings.json` (realpath + case-normalized dedupe, other settings preserved). A registration hiccup only warns and never fails `npm install` — in that case you can add the two packages manually.

### 3. Verify Installation

```bash
pi list
# Expected: pi-maestro-flow@0.6.1, pi-maestro-teammate@0.6.0, pi-cockpit@0.1.1
```

Pi now has 20+ registered tools, 60+ skills, 27 agents, 20+ prompt templates, and a full knowledge system.

> **Note:** Full LSP support requires the corresponding language servers (e.g. `typescript-language-server`, `pyright`). See [packages/pi-maestro-flow/README.md](packages/pi-maestro-flow/README.md) for details.

---

## Quick Start

```bash
pi   # Start Pi (trust the project when prompted on first run)
```

Just describe your task in natural language. Maestro Flow automatically classifies intent, assesses complexity, and routes to the right execution channel:

- **Simple tasks** — direct execution with minimal lifecycle overhead
- **Multi-step engineering** — auto-decomposed into chained plans, executed and verified step by step
- **Long-running objectives** — set a goal with budget, autonomous loops across turns, independent completion verification

Use `/maestro-help` to browse all available commands and workflow recommendations.

---

## The Three Plugins & How They Relate

This project ships as three independently publishable Pi plugins. `pi-maestro-flow` is the top-level entry point — installing it brings the other two along. The three collaborate loosely through **dependencies + events + persisted snapshots**.

```
┌──────────────────────────────────────────────────────────────┐
│                      Pi Coding Agent (host)                  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  pi-maestro-flow  @0.6.1  — top orchestration layer (entry)  │
│  ┌───────────────────────────┐                              │
│  │ maestro · goal · todo       │                              │
│  │ run-control · plan-* · mcp  │                              │
│  │ lsp · browser · smart_search│                              │
│  │ bash_bg · ffgrep/fffind     │                              │
│  │ permissions · knowledge sys │                              │
│  └───────┬─────────────┬─────┘                              │
│        │ dep (exec)   │ dep (UI, since v0.6.1)             │
│        ▼               ▼                                      │
│  pi-maestro-teammate @0.6.0        pi-cockpit @0.1.1         │
│  ┌───────────────────────┐        ┌───────────────────────┐ │
│  │ teammate · send         │        │ status stack (AGENTS    │ │
│  │ list · watch · wait     │ events │   + TODO)             │ │
│  │ DAG graphs · RPC subs   │──────▶│ Starship footer         │ │
│  │ thinking · model routing│        │ /cockpit · /theme       │ │
│  └───────────────────────┘        │ 9 themes · bash_bg row  │ │
│        ▲ engine used by flow       └──────────┬────────────┘ │
│        └─────────────────────────────────┘  observe (read) │
│          todo state snapshot (flow persists ──▶ cockpit reads) │
│                                                              │
│  Shared: .pi/skills/ (60+)  .pi/agents/ (27)  prompts (20+)  │
│  Runtime: auto-compaction · GUI sidecar (UCL) · TUI panels    │
└──────────────────────────────────────────────────────────────┘
```

### Division of Responsibility

| Plugin | Version | Role | Core Responsibility |
|--------|---------|------|---------------------|
| **pi-maestro-flow** | 0.6.1 | Top orchestration layer (install entry) | Maestro tools, Goal/Todo/Run lifecycle, soft Plan mode, MCP client, LSP, browser, `bash_bg`, permissions (YOLO), knowledge system, custom API channels |
| **pi-maestro-teammate** | 0.6.0 | Core execution engine | `teammate` tool, DAG dependency graphs, RPC subprocesses, resident agents, thinking depth, model routing, nesting/concurrency guards |
| **pi-cockpit** | 0.1.1 | Visual status UI (optional) | Status stack above the editor (live teammates + todo plan), Starship footer, `/cockpit` panel, `/theme` picker |

### Relationships in Detail

**1. Dependency relationship (npm level)**

- `pi-maestro-flow` is the only install entry. It exact-pins `pi-maestro-teammate@0.6.0` and `pi-cockpit@0.1.1`, pulls both on install, and auto-registers them into `settings.packages` on `postinstall`.
- `pi-maestro-teammate` can be installed standalone (it only peer-depends on the Pi SDK).
- `pi-cockpit` can also be installed standalone; it peer-depends on `pi-maestro-teammate@^0.6.0` (to receive AGENTS events) but does **not** depend on `pi-maestro-flow`.
- `pi-maestro-flow` also depends on `maestro-flow@0.5.57` (workflow resource package, installed to `~/.maestro/workflows` on postinstall).

**2. Call relationship (execution level)**

- `pi-maestro-flow` uses `pi-maestro-teammate` as its execution engine: whenever the `maestro`/`goal`/`todo` tools need parallelism or delegation, they dispatch subprocesses through teammate's `teammate` tool (DAG, RPC, model routing).
- Through teammate's main-session interaction relay, flow injects permission hooks and the `ask-user-question` tool into every child.

**3. Observation relationship (UI level, loosely coupled)**

`pi-cockpit` is a pure read-only observer. It renders only through Pi's public extension APIs (`setWidget`/`setFooter`) and depends on no package internals:

| Block | Data source | Available on bare Pi (no teammate/flow)? |
|-------|-------------|-------------------------------------------|
| **AGENTS** | Events broadcast by `pi-maestro-teammate` (`teammate:started` / `teammate:message` / `teammate:complete`) | No — hidden without events |
| **TODO** | The `todo-state` snapshot persisted by `pi-maestro-flow`'s `todo` tool after every mutation (re-read on `session_start` and `tool_execution_end`) | No — hidden without the `todo` tool |
| **Footer** | `ctx.model`, context usage, session totals, git branch | Yes |

So on bare Pi, cockpit loads without error, the status stack renders nothing, and only the footer appears. The AGENTS roster self-accumulates from event deltas (no back-fill of pre-existing agents); the TODO list **is** back-filled from the snapshot on `session_start`.

> 💡 In short: **flow handles "orchestration & knowledge", teammate handles "parallel execution", cockpit handles "visibility"**. Install flow and you get all three; install teammate alone for dispatch; install cockpit alone on bare Pi and you get just the footer.

---

## Plugin Tools

The three plugins register 19 always-on tools with Pi, plus 5 tools activated dynamically only in Plan mode.

| Tool | Source | Purpose |
|------|--------|---------|
| `teammate` | teammate | Multi-agent dispatch (single / parallel / DAG; since v0.6.0 `background` defaults to `false`, foreground/blocking) |
| `teammate-send` | teammate | Message running agents (follow_up / steer / abort) |
| `teammate-list` | teammate | List active agents / available roles |
| `teammate-watch` | teammate | Inspect agent output |
| `teammate-wait` | teammate | Event-driven wait for agent completion |
| `maestro` | flow | Knowledge-aware dispatch (explore / delegate / moa) |
| `goal` | flow | Long-running objective lifecycle + independent verification |
| `todo` | flow | Task decomposition and tracking (with skill bindings) |
| `run-control` | flow | Workflow Run lifecycle (status / next / done / edit) |
| `mcp` | flow | Unified MCP client (connect / call / search / OAuth / UI) |
| `bash_bg` | flow | Adaptive foreground/background shell (auto-background on timeout + completion notice, new in v0.6.0) |
| `lsp` | flow | Language server integration (diagnostics / definition / rename…) |
| `browser` | flow | Chromium control via CDP (supports headed `visible` launch) |
| `smart_search` | flow | Web search / deep research / URL fetch |
| `ffgrep` / `fffind` | flow | FFF fast content search / fuzzy file search |
| `search_tool_bm25` | flow | BM25 tool discovery |
| `ask-user-question` | flow | Structured TUI user input (options accept supplementary details) |
| `plan-enter` | flow | Enter durable soft Plan mode |
| `plan-update` / `plan-review` / `plan-confirm` / `plan-exit` / `plan-status` | flow | Plan-mode dynamic tools (draft / full-screen edit / approve / exit / status) |

> `pi-cockpit` registers no model tools — it renders status only via `setWidget`/`setFooter`, and provides two human commands: `/cockpit` and `/theme`.

**Runtime subsystems:** permission controller (5 modes, YOLO default) · auto-compaction · GUI sidecar (`PI_GUI=1`) · TUI panels & overlays

---

## Skills & Agents

60+ skills covering orchestration, code quality, team coordination, UI design, academic writing, knowledge management, and more.
See the **[Maestro Flow](https://github.com/catlog22/maestro-flow)** project for the full skill catalog and workflow definitions.

| Domain | Capabilities | Core Skills |
|--------|-------------|-------------|
| Orchestration | Intent classification & routing, lightweight quick execution, multi-step chain planning, closed-loop autonomous execution | `maestro-next`, `maestro-companion`, `maestro`, `maestro-ralph` |
| Code Quality | Tech debt reduction, OWASP/STRIDE security auditing, multi-role code review | `quality-refactor`, `security-audit`, `team-review` |
| Iterative Improvement | Long-running five-mode cycles (debug / improve / planex / review / ui) | `odyssey` |
| Team Coordination | Multi-role coordination, lifecycle management, swarm intelligence | `team-coordinate`, `team-lifecycle-v4`, `team-swarm` |
| Academic Writing | Paper writing, peer review simulation, citation verification | `scholar-writing`, `scholar-review`, `scholar-citation-verify` |
| UI Design | Design token management, accessibility validation, visual polish | `maestro-impeccable`, `team-uidesign`, `team-visual-a11y` |
| Knowledge Management | Spec constraints, knowhow capture, knowledge audit, project status | `spec`, `manage`, `learn` |

27 agent roles: `explorer` · `delegate` · `workflow-planner` · `workflow-executor` · `workflow-reviewer` · `workflow-debugger` · `workflow-verifier` · `goal-verifier` · `ui-design-agent` · `impeccable-agent` and more.

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| **[使用指南（中文）](docs/USAGE.md)** | 完整功能文档 — 全部工具、MCP、权限、思考深度、Agent、工作流 |
| **[Usage Guide](docs/USAGE_EN.md)** | Complete feature documentation — all tools, MCP, permissions, thinking depth, agents, workflows |
| **[User Guide](GUIDE.md)** | In-depth tutorial with examples for every subsystem |
| **[Release Notes](RELEASE.md)** | Version history and changelog |

---

## Requirements

| Component | Version |
|-----------|---------|
| Node.js | ≥ 22.19.0 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.74.0 |
| [Maestro CLI](https://github.com/catlog22/maestro2) | ≥ 1.0.0 (for knowledge features) |

---

## Credits

**Frameworks & Runtime**

- **[Maestro-Flow](https://github.com/catlog22/maestro-flow)** — intent-driven workflow orchestration by [@catlog22](https://github.com/catlog22)
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — terminal coding harness (host runtime) by [@earendil-works](https://github.com/earendil-works)

**Upstream Libraries Powering Built-in Tools**

- **[@modelcontextprotocol/sdk](https://modelcontextprotocol.io)** — Model Context Protocol implementation for TypeScript, powering the `mcp` tool
- **[Puppeteer](https://github.com/puppeteer/puppeteer)** — control Chromium over the DevTools Protocol, powering the `browser` tool
- **[@ff-labs/fff-node](https://github.com/dmtrKovalenko/fff)** — high-performance fuzzy file finder, powering the `ffgrep` / `fffind` tools
- **[@konbakuyomu/smart-search](https://www.npmjs.com/package/@konbakuyomu/smart-search)** — multi-source web search & deep research powering the `smart_search` tool ([GitHub](https://github.com/konbakuyomu/smartsearch))

## License

[MIT](LICENSE) © 2026 catlog22

---

## Friendly Links

- **[Linux DO](https://linux.do/)** — Learn AI on Linux DO!

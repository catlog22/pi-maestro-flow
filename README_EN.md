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
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## Core Features

Pi is a powerful coding agent — but one agent can only do one thing at a time. **pi-maestro-flow** gives Pi:

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
Enter a read-only planning state: draft a Markdown plan, get explicit user approval before any code change.

```bash
/plan                        # Toggle Plan/Act mode (or Alt+P)
/plan approve                # Approve plan, restore editing tools
```

**How it works:** enter plan mode (edit tools blocked) → draft plan → user approval → commit & restore / abandon without committing. Ideal for complex or risky multi-step work.

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
5 permission modes (default / acceptEdits / plan / dontAsk / bypassPermissions), fine-grained allow/ask/deny rules, teammate child process relay.

### 👥 27 Specialized Agent Roles
explorer, reviewer, debugger, planner, verifier, roadmapper… working in structured pipelines.

### 💡 Thinking Depth Control
Per-task reasoning depth: `off` → `minimal` → `low` → `medium` → `high` → `xhigh`

---

## Quick Start

```bash
# 1. Install (Pi Coding Agent + Node.js ≥ 22.19 required)
pi install npm:pi-maestro-flow

# 2. Start Pi
pi

# 3. Go — describe your task in natural language, or use skills directly
/skill:maestro-help          # Browse all commands
/skill:maestro-analyze       # Analyze a problem before planning
/skill:team-review           # Multi-role code review
```

Pi now has 17 registered tools, 27 agents, 20 prompt templates, and a full knowledge system.

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      Pi Coding Agent                       │
├───────────────────────────────────────────────────────────┤
│                                                            │
│  pi-maestro-flow               pi-maestro-teammate         │
│  ┌────────────────────┐       ┌───────────────────────┐   │
│  │ maestro · goal      │◄────►│ teammate · send        │   │
│  │ todo · run-control  │       │ list · watch · wait    │   │
│  │ lsp · browser · mcp │       │ DAG graphs · RPC       │   │
│  │ smart_search · fff  │       │ thinking depth         │   │
│  │ permissions · plan  │       │ model routing          │   │
│  └─────────┬──────────┘       └───────────┬───────────┘   │
│            │                               │               │
│  ┌─────────▼───────────────────────────────▼───────────┐   │
│  │  .pi/skills/ (104)   .pi/agents/ (27)   prompts (20) │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  Runtime: auto-compaction · GUI sidecar (UCL) · TUI panels │
└───────────────────────────────────────────────────────────┘
```

| Package | Role |
|---------|------|
| **pi-maestro-teammate** | Core dispatch engine — `teammate` tool, DAG graphs, RPC subprocesses, thinking depth, model routing |
| **pi-maestro-flow** | Maestro tools, Goal/Todo/Run lifecycle, MCP client, LSP, browser, permissions, knowledge system |

---

## Plugin Tools (17 Registered)

| Tool | Source | Purpose |
|------|--------|---------|
| `teammate` | teammate | Multi-agent dispatch (single / parallel / DAG / background) |
| `teammate-send` | teammate | Message running agents (follow_up / steer / abort) |
| `teammate-list` | teammate | List active agents |
| `teammate-watch` | teammate | Inspect agent output |
| `teammate-wait` | teammate | Event-driven wait for agent completion |
| `maestro` | flow | Knowledge-aware dispatch (explore / delegate / moa) |
| `goal` | flow | Long-running objective lifecycle + independent verification |
| `todo` | flow | Task decomposition and tracking (with skill bindings) |
| `run-control` | flow | Workflow Run lifecycle (status / next / done / edit) |
| `mcp` | flow | Unified MCP client (connect / call / search / OAuth / UI) |
| `lsp` | flow | Language server integration (diagnostics / definition / rename…) |
| `browser` | flow | Chromium control via CDP |
| `smart_search` | flow | Web search / deep research / URL fetch |
| `ffgrep` / `fffind` | flow | FFF fast content search / fuzzy file search |
| `search_tool_bm25` | flow | BM25 tool discovery |
| `ask-user-question` | flow | Structured TUI user input |
| `plan-enter` | flow | Enter durable Plan mode |

**Runtime subsystems:** permission controller (5 modes) · auto-compaction · GUI sidecar (`PI_GUI=1`) · TUI panels & overlays

---

## Skills & Agents

104 skills covering orchestration, quality, UI design, team coordination, academic writing, knowledge management, and more.
See the **[Maestro Flow](https://github.com/catlog22/maestro-flow)** project for the full skill catalog and workflow definitions.

| Domain | Example Skills |
|--------|---------------|
| Orchestration | `maestro-plan`, `maestro-execute`, `maestro-ralph` |
| Quality | `quality-refactor`, `security-audit`, `team-review` |
| Team | `team-coordinate`, `team-lifecycle-v4`, `team-swarm` |
| Academic | `scholar-writing`, `scholar-review`, `scholar-citation-verify` |
| UI | `maestro-impeccable`, `team-uidesign`, `team-visual-a11y` |

27 agent roles: `explorer` · `delegate` · `workflow-planner` · `workflow-executor` · `workflow-reviewer` · `workflow-debugger` · `workflow-verifier` · `goal-verifier` · `ui-design-agent` · `impeccable-agent` and more.

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| **[使用指南（中文）](docs/USAGE.md)** | 完整功能文档 — 全部 17 个工具、MCP、权限、思考深度、Agent、工作流 |
| **[Usage Guide](docs/USAGE_EN.md)** | Complete feature documentation — all 17 tools, MCP, permissions, thinking depth, agents, workflows |
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

- **[Maestro-Flow](https://github.com/catlog22/maestro-flow)** — intent-driven workflow orchestration by [@catlog22](https://github.com/catlog22)
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — terminal coding harness by [@earendil-works](https://github.com/earendil-works)

## License

[MIT](LICENSE) © 2026 catlog22

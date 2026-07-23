# pi-maestro-flow

<p align="center">
  <strong>🎼 Multi-Agent Orchestration for Pi Coding Agent</strong><br />
  <em>Turn a single coding agent into a coordinated engineering team.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-maestro-flow"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-flow?color=cb3837&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/pi-maestro-teammate"><img alt="npm" src="https://img.shields.io/npm/v/pi-maestro-teammate?color=cb3837&logo=npm&logoColor=white&label=teammate" /></a>
  <a href="https://github.com/catlog22/pi-maestro-flow"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-repo-blue?logo=github" /></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
</p>

---

## Why pi-maestro-flow?

Pi is a powerful coding agent — but one agent can only do one thing at a time. **pi-maestro-flow** gives Pi the ability to:

- 🔀 **Spawn parallel agents** — dispatch multiple subprocess agents with DAG task graphs, RPC messaging, and per-task thinking depth control
- 🧠 **Remember everything** — persistent knowledge system with semantic search, specs, knowhow, and conflict/supersession lifecycle
- 📋 **Orchestrate complex workflows** — plan→execute→verify pipelines, long-running autonomous cycles, and Goal lifecycle with independent verification
- 👥 **Coordinate teams** — 27 specialized agent roles (explorer, reviewer, debugger, planner…) in structured pipelines
- 🔌 **Connect anything** — full MCP client (OAuth, UI sessions, streaming), LSP integration, browser control, web search
- 🔒 **Control permissions** — 5 permission modes, fine-grained allow/ask/deny rules, teammate child relay
- 🎯 **104 skills** — from code review to academic writing, UI design to security auditing

> **One command, one team.** Describe what you want — pi-maestro-flow routes it to the right agents, skills, and knowledge.

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

That's it. Pi now has 104 skills, 27 agents, and a full knowledge system.

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
| **pi-maestro-flow** | Maestro tools, Goal/Todo/Run lifecycle, MCP client, LSP, browser, permissions, 104 skills, knowledge system |

---

## What Can It Do?

### 🚀 Parallel Code Exploration
```javascript
teammate({
  tasks: [
    { name: "defs", agent: "explorer", task: "FIND: Auth exports\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", task: "FIND: Auth imports\nSCOPE: src/" },
    { name: "report", agent: "delegate", task: "Merge {defs} + {calls} into a gap report" }
  ]
})
```

### 🔄 Plan → Execute → Verify
```
/skill:maestro-analyze → /skill:maestro-plan → /skill:maestro-execute → /skill:quality-review
```

### 🐛 Long-Running Debug Cycles
```
/skill:odyssey-debug "Memory leak in WebSocket handler"
```

### 👥 Team Code Review
```
/skill:team-review src/ --level deep    # scanner → reviewer → fixer pipeline
```

### 📚 Knowledge That Persists
```bash
maestro search "auth pattern"           # Semantic search across specs + code
/spec-add coding "Result types" "..."   # Capture conventions
```

### 🔌 MCP + LSP + Browser
```javascript
mcp({ tool: "github_create_issue", args: '{"title":"Bug"}' })  // Call any MCP tool
lsp({ action: "references", file: "src/auth.ts", line: 42 })   // Find all references
browser({ action: "open", url: "http://localhost:3000" })       // Control Chromium
```

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
| `goal` | flow | Long-running objective lifecycle with verification |
| `todo` | flow | Task decomposition and tracking with skill bindings |
| `run-control` | flow | Workflow Run lifecycle (status / next / done / edit) |
| `mcp` | flow | Unified MCP client (connect / call / search / OAuth / UI) |
| `lsp` | flow | Language server integration (diagnostics / definition / rename…) |
| `browser` | flow | Chromium control via CDP (open / run / screenshot) |
| `smart_search` | flow | Web search / deep research / URL fetch |
| `ffgrep` / `fffind` | flow | FFF-backed fast content & file search |
| `search_tool_bm25` | flow | BM25 tool discovery across all registered tools |
| `ask-user-question` | flow | Structured TUI user input (single / multi-select / open) |
| `plan-enter` | flow | Enter durable Plan mode with approval workflow |

**Runtime subsystems:** permission controller (5 modes) · auto-compaction · GUI sidecar (`PI_GUI=1`) · TUI panels & overlays

---

## Skills Overview (104)

| Domain | Count | Highlights |
|--------|-------|------------|
| **Orchestration** | ~25 | `maestro-plan`, `maestro-execute`, `maestro-ralph-v2`, `maestro-brainstorm` |
| **Quality & Testing** | ~12 | `quality-review`, `quality-debug`, `security-audit`, `team-review` |
| **UI / Design** | ~10 | `maestro-impeccable`, `team-uidesign`, `team-visual-a11y` |
| **Team Coordination** | ~15 | `team-coordinate`, `team-lifecycle-v4`, `team-swarm` |
| **Knowledge** | ~18 | `spec-add`, `manage-knowhow-capture`, `manage-knowledge-audit` |
| **Academic Writing** | 10 | `scholar-writing`, `scholar-review`, `scholar-citation-verify` |
| **Meta / Tooling** | ~9 | `skill-generator`, `prompt-generator`, `maestro-composer` |
| **Learning** | ~5 | `learn-investigate`, `learn-follow`, `learn-decompose` |

---

## Agent Roles (27)

| Category | Agents |
|----------|--------|
| **Core** | `explorer`, `delegate`, `coordinator`, `goal-verifier`, `ralph-executor` |
| **Workflow** | `workflow-planner`, `workflow-executor`, `workflow-reviewer`, `workflow-debugger`, `workflow-verifier`, `workflow-roadmapper` + 9 more |
| **Specialist** | `team-supervisor`, `team-worker`, `ui-design-agent`, `impeccable-agent`, `aggregator`, `reference` + 3 more |

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| **[Usage Guide](docs/USAGE.md)** | Complete feature documentation — all 17 tools, MCP, permissions, thinking depth, agents, workflows |
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

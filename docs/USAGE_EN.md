# pi-maestro-flow Usage Guide

<p align="center">
  <a href="USAGE.md">中文</a> | <strong>English</strong>
</p>

> Complete documentation of all tools, capabilities, and usage registered by the pi-maestro-flow plugin for Pi Coding Agent.
> Skills are briefly indexed here; see [Maestro Flow](https://github.com/catlog22/maestro-flow) for full definitions.

---

## Table of Contents

1. [Installation & Configuration](#1-installation--configuration)
2. [Core Tools](#2-core-tools)
   - [teammate — Multi-Agent Dispatch](#21-teammate--multi-agent-dispatch)
   - [maestro — Knowledge-Aware Dispatch](#22-maestro--knowledge-aware-dispatch)
   - [goal — Long-Running Objective Lifecycle](#23-goal--long-running-objective-lifecycle)
   - [todo — Task Management](#24-todo--task-management)
   - [run-control — Workflow Run Control](#25-run-control--workflow-run-control)
3. [Intelligence Tools](#3-intelligence-tools)
   - [lsp — Language Server Integration](#31-lsp--language-server-integration)
   - [browser — Browser Control](#32-browser--browser-control)
   - [smart_search — Web Search & Research](#33-smart_search--web-search--research)
   - [ffgrep / fffind — Fast Search](#34-ffgrep--fffind--fast-search)
   - [search_tool_bm25 — Tool Discovery](#35-search_tool_bm25--tool-discovery)
4. [MCP Integration](#4-mcp-integration)
5. [Permission System](#5-permission-system)
6. [Thinking Depth Control](#6-thinking-depth-control)
7. [Interaction Tools](#7-interaction-tools)
   - [ask-user-question — Structured User Input](#71-ask-user-question--structured-user-input)
   - [plan-enter — Plan Mode](#72-plan-enter--plan-mode)
8. [Agent Control Tools](#8-agent-control-tools)
9. [Runtime Subsystems](#9-runtime-subsystems)
   - [Auto-Compaction](#91-auto-compaction)
   - [GUI Subsystem (UCL)](#92-gui-subsystem-ucl)
   - [TUI Components](#93-tui-components)
10. [Agent Roles (27)](#10-agent-roles-27)
11. [Prompt Input](#11-prompt-input)
12. [Skills Index (68)](#12-skills-index-68)
13. [Knowledge System](#13-knowledge-system)
14. [Workflow Patterns](#14-workflow-patterns)
15. [Configuration Reference](#15-configuration-reference)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Installation & Configuration

### Prerequisites

| Component | Version |
|-----------|---------|
| Node.js | ≥ 22.19.0 |
| [Pi Coding Agent](https://github.com/earendil-works/pi) | ≥ 0.74.0 |

> [Maestro Flow](https://github.com/catlog22/maestro-flow) (knowledge system) is auto-installed as a dependency — no separate prerequisite install needed.

### Install

```bash
# Install or upgrade (pi-maestro-teammate is installed as a dependency)
pi install npm:pi-maestro-flow@0.21.6

# Confirm Flow, Teammate, and Cockpit are listed, then restart Pi or reload extensions.
pi list
```

Upgrades migrate Flow-managed companion registrations. A same-name local development override is preserved and reported in the startup log; update or remove that override explicitly.

### Registered Tools Overview

After installation, the plugin registers these tools with Pi:

| Source Package | Tool | Purpose |
|---------------|------|---------|
| pi-maestro-teammate | `teammate` | Multi-agent dispatch (single/parallel/DAG) |
| pi-maestro-teammate | `teammate-send` | Message running agents |
| pi-maestro-teammate | `teammate-list` | List active agents |
| pi-maestro-teammate | `teammate-watch` | Inspect agent output |
| pi-maestro-teammate | `teammate-wait` | Wait for agent completion |
| pi-maestro-flow | `maestro` | Knowledge-aware dispatch (explore/delegate/moa) |
| pi-maestro-flow | `goal` | Long-running objective lifecycle |
| pi-maestro-flow | `todo` | Task decomposition and tracking |
| pi-maestro-flow | `run-control` | Workflow Run lifecycle |
| pi-maestro-flow | `ask-user-question` | Structured user input collection |
| pi-maestro-flow | `lsp` | Language Server Protocol integration |
| pi-maestro-flow | `browser` | Chromium browser control |
| pi-maestro-flow | `smart_search` | Web search / deep research / URL fetch |
| pi-maestro-flow | `ffgrep` | FFF fast literal content search |
| pi-maestro-flow | `fffind` | FFF fast fuzzy file search |
| pi-maestro-flow | `search_tool_bm25` | BM25 tool discovery |
| pi-maestro-flow | `plan-enter` | Enter Plan mode |

---

## 2. Core Tools

### 2.1 teammate — Multi-Agent Dispatch

Every call uses a required non-empty `tasks[]` array. One task represents single-agent work; multiple tasks represent parallel or dependency-aware work. Each `prompt` is literal task text and no prompt template is loaded.

```javascript
teammate({ tasks: [{
  agent: "explorer",
  taskType: "explore",
  prompt: "FIND: auth entry points
SCOPE: src/"
}] })

teammate({
  agent: "explorer",
  model: "provider/fast-model",
  tasks: [
    { name: "scan", prompt: "Locate auth entry points" },
    { name: "calls", prompt: "Locate call sites" },
    { name: "review", agent: "analyst", taskType: "review",
      model: "provider/deep-model", prompt: "Review {scan} and {calls}" }
  ],
  concurrency: 2,
  background: false
})
```

Top-level `agent/taskType/model/thinking/context/cwd/outputSchema/timeoutMs` values are task defaults; task values override them. The final role default is `general`. `{name}`/`{name.field}` inject upstream output and `dependsOn` declares ordering only. `background` defaults to `false`.

Model precedence is task model > top-level model > taskType mapping > role model > parent Pi model. taskType affects routing only. The Control Center automatically combines built-in types, types declared by currently discovered built-in/project/user agent YAML, and types already present in routing configuration; custom agents may declare new lower-case identifiers.

### 2.2 maestro — Knowledge-Aware Dispatch

Three actions connecting external CLI endpoints and the knowledge system:

#### explore — Parallel Code Search

```javascript
maestro({
  action: "explore",
  prompts: [
    "FIND: All JWT validation middleware\nSCOPE: src/middleware/\nEXPECTED: file:line + control-flow summary",
    "FIND: All auth.login() call sites\nSCOPE: src/**/*.ts\nEXPECTED: file:line list"
  ],
  concurrency: 3,
  maxTurns: 6
})
```

#### delegate — Task Delegation to External Tools

```javascript
maestro({
  action: "delegate",
  prompt: "PURPOSE: Implement password reset flow\nMODE: write\nCONTEXT: @src/auth/",
  tool: "claude",       // gemini | claude | codex
  mode: "write"
})
```

#### moa — Mixture-of-Agents Synthesis

```javascript
maestro({
  action: "moa",
  prompts: ["Analyze payment flow from security and architecture perspectives"],
  preset: "deep"
})
// Runs analysis across multiple models, then synthesizes into a unified report
```

---

### 2.3 goal — Long-Running Objective Lifecycle

Persistent engine for multi-turn autonomous work: auto-continuation, token budget, compaction survival, independent verification.

#### Model-Side Operations

```javascript
goal({ action: "create", objective: "Implement JWT auth module" })
goal({ action: "create", objective: "Implement JWT auth module", tokenBudget: "100k" })
goal({ action: "get" })
goal({ action: "update", objective: "Implement JWT auth + refresh tokens" })
goal({ action: "complete", summary: "All modules implemented and tests passing" })
```

#### User-Side Commands

| Command | Effect |
|---------|--------|
| `/goal status` | Show current Goal |
| `/goal create [--tokens 100k] <objective>` | Create Goal and start agent loop |
| `/goal stop` | Pause, persist state |
| `/goal resume [--tokens 200k]` | Resume; optionally raise budget |
| `/goal clear` | Abandon and remove Goal |

#### Verification

- Normal `agent_end` automatically triggers independent verification
- `pass` → marked complete, Goal cleared
- `fail` → stays active, next loop with unmet requirements
- `inconclusive` → stays active, waits for `/goal resume`

#### Goal Panel

While a Goal exists, a `goal-panel` renders above the input editor showing:
- Status (ACTIVE / WAITING / VERIFYING / VERIFIED / STOPPED / BUDGET / BLOCKED / ERROR)
- Objective, elapsed time, loop count
- Explicitly configured token budget (hidden when unset)

---

### 2.4 todo — Task Management

7 actions with plain-text context and optional Pi Skill execution:

```javascript
// Create task
todo({ action: "create", subject: "Implement user auth", description: "JWT + refresh tokens" })

// Task with skill binding
todo({
  action: "create",
  subject: "Code review",
  skills: [{ name: "quality-review", role: "primary", args: "--level deep" }]
})

// Update status
todo({ action: "update", id: "abc123", status: "completed", summary: "Auth module done" })

// List tasks
todo({ action: "list", filter: { status: "pending" } })

// Activate next pending task
todo({ action: "next" })

// Assign to teammate
todo({ action: "create", subject: "Explore codebase", assignee: "explorer-1" })
```

| Action | Description |
|--------|-------------|
| `create` | Create task (subject required) |
| `update` | Update status/summary/context/skills |
| `list` | List filtered by status/member |
| `get` | Get single task details |
| `delete` | Delete task |
| `clear` | Clear all tasks |
| `next` | Activate next pending task, return resolved context |

---

### 2.5 run-control — Maestro CLI passthrough shell

Drive the canonical Maestro CLI through argv passthrough — the single LLM surface for the Session/Run lifecycle (no hand-written `maestro run/session` in bash):

| Command class | Description |
|---------------|-------------|
| Read | `status`/`brief`/`prepare`/`check`/`recall`/`evidence`/`list`/`show`/`graph`/`skills`/`search`/`load`/`review` — no mutation lease needed |
| Write | `next`/`done`/`decide`/`seal`/`edit`/`meta`/`recover`/`accept-reuse`/… — current Pi session must own the mutation lease; blocked in Plan mode |
| Entry | `session/run create|start` — allowed without a held lease; refused when a lease is held for another Session |

```javascript
run-control({ argv: ["session", "status"] })
run-control({ argv: ["session", "next"] })
run-control({ argv: ["run", "done", "run-123", "--verdict", "done", "--summary", "Complete"] })
run-control({ argv: ["run", "edit", "quality-review", "--after", "current"] })
```

---

## 3. Intelligence Tools

### 3.1 lsp — Language Server Integration

Connect to language servers for code intelligence:

| Action | Description |
|--------|-------------|
| `diagnostics` | Get diagnostics (errors/warnings) |
| `definition` | Go to definition |
| `references` | Find all references |
| `hover` | Hover info (type/docs) |
| `symbols` | File/workspace symbol list |
| `rename` | Rename symbol |
| `rename_file` | Rename file (update references) |
| `code_actions` | Available code actions |
| `type_definition` | Go to type definition |
| `implementation` | Find implementations |
| `status` | Language server status |
| `reload` | Reload |
| `capabilities` | Server capabilities |
| `request` | Raw LSP request |

```javascript
lsp({ action: "diagnostics", file: "src/auth/login.ts" })
lsp({ action: "definition", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "references", file: "src/auth/login.ts", line: 42, symbol: "validateToken" })
lsp({ action: "rename", file: "src/auth/login.ts", line: 42, symbol: "validateToken", new_name: "verifyToken", apply: true })
lsp({ action: "symbols", file: "*" })  // Workspace symbols
```

The plugin also registers **LSP auto-diagnostics**: automatically triggers diagnostic checks after file edits.

---

### 3.2 browser — Browser Control

Control Chromium via CDP with named tabs, screenshots, and in-page JavaScript execution:

| Action | Description |
|--------|-------------|
| `open` | Open/attach browser tab |
| `close` | Close tab (`all: true` closes all) |
| `run` | Execute JavaScript in page |

```javascript
// Open page
browser({ action: "open", url: "http://localhost:3000", name: "app" })

// Execute JS + screenshot
browser({
  action: "run",
  name: "app",
  code: "await page.screenshot({ path: 'screenshot.png' }); return document.title;"
})

// Set viewport
browser({ action: "open", url: "...", viewport: { width: 1920, height: 1080 } })

// Close
browser({ action: "close", name: "app" })
browser({ action: "close", all: true })
```

Configuration options:
- `app.path` — custom Chromium/Chrome/Edge path
- `app.cdp_url` — connect to existing browser CDP endpoint
- `wait_until` — navigation wait strategy (load / domcontentloaded / networkidle0 / networkidle2)
- `dialogs` — dialog handling (accept / dismiss)

---

### 3.3 smart_search — Web Search & Research

External information retrieval — web search, deep research, URL content extraction:

| Mode | Purpose | Key Params |
|------|---------|------------|
| `search` | Quick lookup | `platform`, `validation` |
| `research` | Multi-source deep research | `budget` (quick/standard/deep), `validation` (strict) |
| `fetch` | Extract known URL content | — |
| `route` | Routing diagnostics | `router_mode` |

```javascript
smart_search({ mode: "search", query: "Express.js middleware error handling best practices" })
smart_search({ mode: "research", query: "JWT vs session auth comparison", budget: "deep", validation: "strict" })
smart_search({ mode: "fetch", query: "https://docs.example.com/api/auth" })
```

Configure via `Alt+S` or `/smart-search-config`.

---

### 3.4 ffgrep / fffind — Fast Search

Native index search powered by [FFF](https://github.com/fff-labs/fff), registered to root Pi session only:

```javascript
// Literal content search
ffgrep({ pattern: "validateToken", context: 3, limit: 20 })

// Fuzzy file path search
fffind({ pattern: "auth middleware", limit: 10 })
```

---

### 3.5 search_tool_bm25 — Tool Discovery

Search all registered tools by name, description, and parameter names using BM25 weighted ranking:

```javascript
search_tool_bm25({ query: "code search", limit: 10 })
```

Matching inactive tools are automatically activated.

---

## 4. MCP Integration

The plugin includes a full MCP (Model Context Protocol) client, connecting external MCP servers through a unified `mcp` proxy tool.

> Design principle: instead of registering hundreds of MCP server tools individually, a single `mcp` proxy tool provides unified access, keeping LLM context lean.

### Basic Operations

```javascript
// Check server status
mcp({ })

// List server tools
mcp({ server: "server-name" })

// Search tools (by name/description)
mcp({ search: "query" })
mcp({ search: "pattern.*", regex: true })

// Show tool details and parameters
mcp({ describe: "tool_name" })

// Connect server and refresh metadata
mcp({ connect: "server-name" })

// Call tool
mcp({ tool: "tool_name", args: '{"key": "value"}' })
mcp({ server: "server-name", tool: "tool_name", args: '{"key": "value"}' })
```

### OAuth Authentication

```javascript
// Start manual OAuth flow, get browser URL
mcp({ action: "auth-start", server: "server-name" })

// Complete manual OAuth
mcp({ action: "auth-complete", server: "server-name", args: '{"redirectUrl":"..."}' })

// Retrieve completed UI session messages
mcp({ action: "ui-messages" })
```

### Transport Protocols

Three transport types supported:
- **stdio** — local process communication (most common)
- **SSE** — Server-Sent Events HTTP stream
- **Streamable HTTP** — streamable HTTP transport

### Advanced Features

| Feature | Description |
|---------|-------------|
| **Metadata Cache** | Persistent tool/resource metadata cache (7-day TTL), avoids reconnection |
| **NPX Resolution** | Auto-resolves `npx`/`npm exec` binary paths, avoids npm parent process overhead |
| **Output Guard** | Large output auto-truncated (default 50KB / 2000 lines), full output written to temp file |
| **Sampling** | Supports MCP Sampling requests (server requests LLM generation), requires user confirmation |
| **UI Sessions** | Supports MCP UI resources (`ui://` protocol), renders interactive interfaces in browser |
| **UI Streaming** | Supports `eager` / `stream-first` UI streaming modes |
| **OAuth Provider** | Full OAuth client implementation (registration, token storage, authorization redirect) |
| **Config Import** | Import config from Cursor / Claude Code / Claude Desktop / Codex / Windsurf / VSCode |
| **MCP Manager** | TUI management interface (`/mcp` command), enable/disable/delete servers |
| **Resource Tools** | MCP resources auto-converted to `get_<name>` tools |
| **Consent Management** | Tool call consent management with auto-approve configuration |

### Configuration

MCP servers are defined in Pi config files (user-level or project-level):

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my/mcp-server"],
      "env": { "API_KEY": "..." },
      "enabled": true,
      "excludeTools": ["dangerous_tool"]
    }
  }
}
```

---

## 5. Permission System

The plugin implements full tool-call permission control with multiple modes and fine-grained rules.

### Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Default mode, dangerous operations require user confirmation |
| `acceptEdits` | Auto-accept file edits, other operations still require confirmation |
| `plan` | Plan mode, only read-only operations allowed |
| `dontAsk` | Never ask, auto-allow all operations |
| `bypassPermissions` | YOLO mode, skip all permission checks (can be disabled by config) |

### Permission Rules

Three behavior levels:

| Behavior | Description |
|----------|-------------|
| `allow` | Auto-allow, never ask |
| `ask` | Ask user every time |
| `deny` | Refuse execution |

Rules can be configured at session level (temporary) or local settings file (persistent):

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(npm test)", "Bash(npm run *)"],
    "ask": ["Bash(rm *)"],
    "deny": ["Bash(rm -rf /)"],
    "disableBypassPermissionsMode": "disable"
  }
}
```

### Always-Allowed Tools

These tools are auto-allowed in all modes (read-only or side-effect free):

`Read`, `Grep`, `Glob`, `Ls`, `Find`, `ffgrep`, `fffind`, `ask-user-question`, `teammate`, `teammate-send`, `teammate-list`, `teammate-watch`, `goal`, `todo`, `plan-*`, `search_tool_bm25`

### Teammate Child Permission Relay

Teammate subprocesses have no local terminal; permission requests are relayed to the parent via IPC:
- Parent owns live mode, session rules, hooks, and persistence
- Child permission requests forwarded via `teammate_proxy_request`
- Parent evaluates and returns `allow_once` or `deny`

---

## 6. Thinking Depth Control

Teammate dispatch supports fine-grained thinking depth control, affecting subprocess agent reasoning depth.

### Available Levels

| Level | Description |
|-------|-------------|
| `off` | Disable extended thinking, fastest response |
| `minimal` | Minimal thinking overhead |
| `low` | Low depth reasoning |
| `medium` | Medium depth (balance of speed and quality) |
| `high` | High depth reasoning |
| `xhigh` | Extra-high depth (slowest but most thorough) |
| `max` | Alias for `xhigh` |

### Usage

```javascript
// Top-level default
teammate({
  thinking: "high",
  tasks: [
    { name: "quick-scan", agent: "explorer", prompt: "...", thinking: "off" },
    { name: "deep-analysis", agent: "general", prompt: "...", thinking: "xhigh" }
  ]
})
```

### Precedence

Task-level `thinking` → top-level `thinking` → `taskType` mapping → agent frontmatter → Pi default

> Note: thinking depth is never restricted by the teammate layer — every level in the table above is selectable for any routed model. If a provider cannot honor a level, the child Pi host clamps to its own capability boundary.

---

## 7. Interaction Tools

### 7.1 ask-user-question — Structured User Input

Collect structured user answers through a keyboard-first TUI wizard:

```javascript
// Single select
ask-user-question({
  questions: [{
    question: "Which approach?",
    header: "Approach",
    options: [
      { label: "A: Microservices", description: "Independent deployment, loose coupling" },
      { label: "B: Monolith", description: "Simple, easy to debug" }
    ]
  }]
})

// Multi-select
ask-user-question({
  questions: [{
    question: "Which features?",
    multiSelect: true,
    options: [
      { label: "Auth" }, { label: "Authorization" },
      { label: "Audit log" }, { label: "Rate limiting" }
    ]
  }]
})

// Open-ended
ask-user-question({
  questions: [{ question: "What should the project name be?" }]
})
```

- Up to 4 questions per call
- 2-4 options per question
- Supports single-select, multi-select, open-ended

---

### 7.2 plan-enter — Plan Mode

Enter durable Plan mode, load the current session's `current.md` draft, activate plan-only tools:

```javascript
plan-enter()
```

**Plan mode behavior:**
- Edit/write tools and file-mutating commands are blocked
- Read/search/explore tools remain available
- Draft Markdown plans with `plan-update`
- Inspect plan status with `plan-status`
- `plan-confirm` (or `/plan approve`) commits the plan and restores Act tools
- `plan-exit` abandons the plan and returns to Act mode

**Toggle:** `Alt+Shift+P` or `/plan` to switch Plan/Act mode.

---

## 8. Agent Control Tools

Manage running teammate agents:

```javascript
// List all active agents
teammate-list({ view: "all" })     // all | active | named | roles

// Inspect agent output
teammate-watch({ name: "my-agent", lines: 30 })

// Wait for agent completion (event-driven, avoids polling)
teammate-wait({ name: "my-agent", timeoutMs: 60000 })
teammate-wait({ waitMs: 5000 })  // Fixed delay

// Send message to running agent
teammate-send({ to: "my-agent", message: "Also check edge cases", mode: "follow_up" })

// Urgent correction (interrupts current turn)
teammate-send({ to: "my-agent", message: "Stop current approach, try alternative", mode: "steer" })

// Terminate
teammate-send({ to: "my-agent", mode: "abort" })
```

| Tool | Purpose |
|------|---------|
| `teammate-list` | List agents (active / named / all / roles) |
| `teammate-watch` | View recent output, tool activity, inbox |
| `teammate-wait` | Event-driven wait for completion or fixed delay |
| `teammate-send` | Send message (follow_up / steer / abort) |

---

## 9. Runtime Subsystems

### 9.1 Auto-Compaction

Intelligent context window management preventing long session overflow:

| Feature | Description |
|---------|-------------|
| **Auto-prune** | Automatically prunes large tool results (≥4KB) when context hits threshold (~70%) |
| **Keep recent** | Always preserves ~20K tokens of recent conversation |
| **Reserve space** | Reserves ~16K tokens for model response |
| **Replayable tools** | `read`, `grep`, `glob`, `search`, `find`, `resource` results safely prunable (re-executable on demand; pruned `resource` results keep their URI for re-reading) |
| **Compaction continue** | Auto-injects continuation prompt after compaction, agent resumes from checkpoint |
| **State persistence** | Prune state persisted across sessions |

### 9.2 GUI Subsystem (UCL)

Unified Communication Layer, enabled via `PI_GUI=1` environment variable:

```bash
PI_GUI=1 pi   # Start Pi with GUI sidecar
```

| Feature | Description |
|---------|-------------|
| **Tool discovery** | `GET /tools` — list all available tools |
| **Tool invocation** | `POST /tools/:name` — invoke tools via HTTP (with permission gateway) |
| **State aggregation** | `GET /state` / `GET /state/:sub` — aggregated session state |
| **Change events** | SSE (Server-Sent Events) real-time state change push |
| **Zero intrusion** | No behavior change when disabled (no listener, no discovery file) |

### 9.3 TUI Components

The plugin registers multiple TUI overlays and panels:

| Component | Trigger | Function |
|-----------|---------|----------|
| **Goal Panel** | Auto-shown when Goal exists | Status, objective, time, loop count, token budget |
| **Todo Overlay** | During todo operations | Task list and status |
| **Session Overlay** | `/maestro-session` | Workflow session control center |
| **Maestro Panel** | During maestro operations | Run status and progress |
| **Swarm Overlay** | `/swarm` | ACO swarm status, topology, metrics |
| **Model Mapping Overlay** | `Alt+M` / `/teammate-models` | Configure taskType → model mappings |
| **Smart Search Config** | `Alt+S` / `/smart-search-config` | Search engine and provider config |
| **MCP Manager** | `/mcp` | MCP server management (enable/disable/delete/import) |
| **MCP Panel** | During MCP tool selection | Server tool browsing, search, invocation |
| **MCP Setup Panel** | First MCP configuration | Guided setup (import/scaffold/repo prompt) |
| **Progress Tree** | During teammate execution | Agent execution progress visualization |
| **Attach Overlay** | During teammate startup | Attach to agent subprocess |
| **Status Bar** | Always visible | Current mode, compaction status, MCP connection status |

---

## 10. Agent Roles

### Built-In Roles

| Role | Purpose | Boundary |
|---|---|---|
| `general` | General implementation, analysis, and verification | Read/write/command tools |
| `explorer` | Code discovery and call-chain tracing | Read-only |
| `planner` | Architecture and execution planning | Read-only, high thinking |
| `analyst` | Technical analysis and review | Read-only, high thinking |
| `research` | Project architecture knowledge and external web research | Read-only, knowledge CLI and web search |
| `verifier` | Goal fallback when no acceptance commands are declared | Strictly read-only, structured fail-closed verdict |
| `workflow` | Dependency-aware DAG decomposition and dispatch | Read and teammate collaboration tools |

The old `delegate`, `goal-verifier`, and `coordinator` names are not built-ins. Goal runs acceptance commands first and invokes `verifier` only when no commands were declared. Project roles live in `.pi/agents/*.md`; user roles live in `~/.agents/*.md`. Built-in names cannot be overridden.

## 11. Prompt Input

`tasks[].prompt` is required literal task text. Teammate 1.0 does not discover `.pi/prompts`, ship bundled prompt templates, or support `promptArgs`, positional parameters, or template-name expansion. Reusable instructions must be rendered by the caller or a Skill and passed as a complete prompt.

## 12. Skills Index (68)

Skills are on-demand capability packages invoked via `/skill:name` or auto-loaded by agents.
See [Maestro Flow](https://github.com/catlog22/maestro-flow) for full skill definitions and workflow details.

### Orchestration & Lifecycle

| Skill | Description |
|-------|-------------|
| `maestro` | Intent-to-chain planner, auto-routes to optimal command chain |
| `maestro-next` | Unified dev intent entry, classifies complexity and routes to execution channel |
| `maestro-companion` | Quick execution for small tasks, minimal Run lifecycle |
| `maestro-ralph` | Closed-loop policy over canonical Session/Run chain |
| `maestro-init` | Project initialization with auto state detection |
| `maestro-fork` | Create/sync session worktree for parallel dev |
| `maestro-merge` | Merge worktree branch back to main |
| `maestro-session-seal` | Seal current session with knowledge extraction and DAG progression |
| `maestro-update` | Detect version, preview changes, apply workflow upgrades |
| `maestro-help` | Command help system, search commands, browse skills |
| `maestro-guard` | Manage editing boundary restrictions |
| `maestro-overlay` | Create/edit command overlays from natural language |

### Quality & Testing

| Skill | Description |
|-------|-------------|
| `quality-refactor` | Systematic tech-debt identification and safe reduction |
| `security-audit` | OWASP Top 10 + STRIDE security auditing |
| `insight-challenge` | Adversarial review of code quality findings |
| `delegation-check` | Check workflow delegation prompts for content separation violations |

### UI / Design

| Skill | Description |
|-------|-------------|
| `maestro-impeccable` | Frontend UI design, audit, polish |

### Team Coordination

| Skill | Description |
|-------|-------------|
| `team-coordinate` | Universal team coordination with dynamic role generation |
| `team-lifecycle-v4` | Full lifecycle: plan → develop → test → review |
| `team-review` | 3-role code review pipeline: scanner → reviewer → fixer |
| `team-testing` | Progressive test coverage (Generator-Critic loops) |
| `team-quality-assurance` | Full closed-loop QA (issue discovery + testing) |
| `team-brainstorm` | Unified brainstorming team |
| `team-arch-opt` | Architecture optimization |
| `team-perf-opt` | Performance optimization (single/fan-out/parallel modes) |
| `team-tech-debt` | Tech debt identification and remediation |
| `team-roadmap-dev` | Roadmap-driven development |
| `team-planex` | Plan-and-execute pipeline |
| `team-ultra-analyze` | Deep collaborative multi-role investigation |
| `team-issue` | Issue resolution team |
| `team-swarm` | ACO swarm intelligence multi-agent exploration |
| `team-adversarial-swarm` | ACO swarm with adversarial decision gates |
| `team-frontend` | Unified frontend dev (with ui-ux-pro-max design intelligence) |
| `team-frontend-debug` | Chrome DevTools MCP frontend debugging |
| `team-uidesign` | UI design team: research → tokens → audit → implementation |
| `team-ui-polish` | Auto-discover/fix UI issues |
| `team-motion-design` | Animation token systems, scroll choreography, GPU transforms |
| `team-visual-a11y` | Visual accessibility QA (OKLCH contrast, WCAG AA/AAA) |
| `team-ux-improve` | Discover/fix UI/UX interaction issues |
| `team-interactive-craft` | Vanilla JS+CSS interactive components (zero dependencies) |
| `team-designer` | Team skill generator meta-skill |
| `team-executor` | Lightweight session execution (resume existing team-coordinate sessions) |

### Long-Running Cycles (Odyssey)

| Skill | Description |
|-------|-------------|
| `odyssey` | Long-running iterative cycle, five modes (debug/improve/planex/review/ui) |
| `maestro-odyssey` | Long-running iterative cycle, six modes (+security) |

### Knowledge Management

| Skill | Description |
|-------|-------------|
| `maestro-spec` | Spec precipitation (intent-driven capture of project constraints) |
| `maestro-knowhow` | KnowHow precipitation (intent-driven capture of reusable knowledge by type) |
| `maestro-knowledge` | Knowledge-store management (intent-driven: audit/harvest/wiki/extractors/domain) |
| `maestro-issue` | Issue management (intent-driven: report/list/close/link + auto-discovery) |
| `codify-to-knowhow` | Manifest-driven knowledge asset generator |

### Academic Writing (Scholar)

| Skill | Description |
|-------|-------------|
| `scholar-ideation` | Research ideation (literature → gap analysis → planning) |
| `scholar-writing` | End-to-end academic paper writing (NeurIPS/ICML/ICLR etc.) |
| `scholar-review` | Systematic paper review (self-review + rebuttal) |
| `scholar-rebuttal-pro` | Enhanced rebuttal (collaborative analysis + multi-perspective) |
| `scholar-experiment` | ML/AI paper experimental results analysis |
| `scholar-citation-verify` | Four-layer citation verification |
| `scholar-anti-ai-writing` | Remove AI writing patterns from academic prose |
| `scholar-latex-organizer` | Organize LaTeX templates for Overleaf |
| `scholar-publish` | Post-acceptance conference preparation (slides/poster/promotion) |
| `scholar-thesis-docx` | Create/revise thesis Word documents |

### Meta / Tooling

| Skill | Description |
|-------|-------------|
| `prompt-generator` | Generate/convert prompt files (GSD-style quality gates) |
| `skill-generator` | Meta-skill for creating new skills |
| `skill-iter-tune` | Iterative skill tuning (execute → evaluate → improve) |
| `skill-simplify` | SKILL.md simplification (functional integrity verification) |
| `skill-tuning` | Universal skill diagnosis and optimization |
| `workflow-skill-designer` | Orchestrator+phases workflow skill design meta-skill |
| `swarm` | ACO swarm optimization state projection |

### Learning

| Skill | Description |
|-------|-------------|
| `learn` / `maestro-learn` | Guided reading, investigation, pattern extraction, second opinions |

---

## 13. Knowledge System

The knowledge system ensures agents have full project context before touching code.

### Mandatory Knowledge Gate

Execute before any code access or dispatch:

```bash
# Search (across spec, knowhow, domain, issue, session)
maestro search "<query>" [--type spec|knowhow|domain|issue] [--code] [--kg]

# Load specific knowledge
maestro load --type <type> [--list] [--category <cat>] [--keyword <word>] [--id <id>]
```

### Query Rules

```bash
# ❌ Avoid keyword dumps
maestro search "topology display frontend DetailedTopologySVG elk layout rendering"

# ✅ Use focused queries
maestro search "topology layout"
maestro search "DetailedTopologySVG" --code
maestro load --type spec --category coding
```

### Knowledge Types

| Type | Categories | Purpose |
|------|-----------|---------|
| `spec` | `arch`, `coding`, `debug`, `test`, `review`, `learning`, `ui` | Reusable conventions and rules |
| `knowhow` | `compact`, `tip` | Task-specific patterns and recipes |
| `domain` | — | Project glossary terms |
| `issue` | — | Tracked bugs and tasks |
| `roadmap` | — | Milestone and phase planning |

### Knowledge Lifecycle

```bash
# Add
/maestro-spec "coding: Use Result<T,E> — Service methods must return Result<T,AppError>"
/maestro-knowhow

# Evolve
maestro spec supersede SPEC-042 --by SPEC-089     # Replace old rule
maestro spec conflict mark src/auth.ts 45 --note "JWT vs session: both valid"

# Maintain
maestro spec health                                # Health check
maestro spec history SPEC-042                     # View history
maestro search "old pattern" --include-deprecated  # Search all
```

### Three Orthogonal Axes

| Axis | Description |
|------|-------------|
| `confidence` | Human/audit ruling |
| `status` | active / deprecated lifecycle |
| Time decay | Automatic freshness decay |

---

## 14. Workflow Patterns

### Pattern 1: Gate → Explore → Implement

```
1. maestro search + load      → Knowledge Gate
2. teammate (explorer × 2-3)  → Cross-search for confidence
3. Targeted reads              → Verify single-match results
4. teammate (delegate)         → Implement with full context
5. /skill:quality-review       → Validate
```

### Pattern 2: Plan → Execute → Verify

```
1. maestro search + load      → Knowledge Gate
2. /skill:maestro-plan         → Create execution plan
3. /skill:maestro-execute      → Step-by-step execution + verification
4. workflow-verifier           → Goal-backward verification
5. /skill:quality-test         → Acceptance testing
```

### Pattern 3: Parallel Review → Synthesize → Fix → Re-Review

```
1. teammate (reviewer × 3)    → Security, performance, maintainability
2. teammate (delegate)         → Synthesize findings
3. teammate (delegate)         → Fix highest-priority issues
4. teammate (reviewer × 3)    → Re-review fixes
```

### Pattern 4: Odyssey Full Cycle

```
1. /skill:odyssey-debug        → Archaeology → Diagnosis → Fix → Generalize
2. /skill:quality-test         → Verify fix
3. /maestro-knowhow            → Persist lessons
```

### Pattern 5: Multi-Stage DAG Pipeline

```javascript
teammate({
  tasks: [
    // Stage 1: Parallel research
    { name: "api-research", agent: "workflow-external-researcher", prompt: "Research rate limiting best practices" },
    { name: "codebase-survey", agent: "explorer", prompt: "FIND: All API endpoints\nSCOPE: src/api/" },
    // Stage 2: Plan (after research + survey complete)
    { name: "plan", agent: "workflow-planner", prompt: "Incorporate {api-research} + {codebase-survey} into plan" },
    // Stage 3: Implement
    { name: "implement", agent: "workflow-executor", prompt: "Execute {plan}" },
    // Stage 4: Verify
    { name: "verify", agent: "workflow-verifier", prompt: "Verify {implement} against {plan}" }
  ]
})
```

### Explorer Cross-Search Strategy

| Angle | Task A | Task B |
|-------|--------|--------|
| Definition vs usage | Find exported definitions | Find imports and call sites |
| Positive vs missing | Find correct implementations | Find places missing the convention |
| Entry vs implementation | Find routes or exports | Find internal logic |

**Confidence rules:**
- ✅ Two matching angles → high confidence, use result
- ⚠️ One matching angle → verify with `rg` or targeted read
- ❌ Zero matches → change angle or conclude target absent

---

## 15. Configuration Reference

### Model Routing Profiles

Shared Profiles are stored globally in `~/.pi/agent/teammate-models.json`:

```json
{
  "version": 3,
  "defaultProfile": "balanced",
  "profiles": {
    "balanced": {
      "name": "Balanced",
      "mappings": {
        "explore": "deepseek/deepseek-v4-flash",
        "analysis": "deepseek/deepseek-v4-pro"
      },
      "fallbackMappings": {
        "analysis": ["deepseek/deepseek-v4-flash"]
      },
      "thinkingLevels": {
        "explore": "low",
        "analysis": "high"
      }
    }
  }
}
```

The project `.pi/teammate-models.json` persists only the active selection and optional compatibility overrides:

```json
{
  "version": 3,
  "activeProfile": "balanced",
  "applyOverrides": false,
  "overrides": {
    "mappings": {},
    "thinkingLevels": {}
  }
}
```

Open the Control Center with `Alt+M` or `/teammate-models`. The **Profiles** tab activates, creates, duplicates, renames, sets the global default, and deletes Profiles. Legacy project overrides can be restored, promoted to a global Profile, or cleared. Switching Profiles disables but preserves existing overrides. v1/v2 files are not rewritten on read and migrate losslessly on their first save; missing project Profile references fall back to the global default.

Routing source precedence: enabled project overrides > project-selected global Profile > global default Profile.

### Project-Level Configuration

| File | Purpose |
|------|---------|
| `.pi/teammate-models.json` | Active Profile and optional compatibility overrides for this project |
| `.pi/agents/` | Project-specific agent definitions |
| `.pi/settings.json` | Pi settings overrides |

### Global Configuration

| File | Purpose |
|------|---------|
| `~/.pi/agent/teammate-models.json` | Cross-project Profile registry and global default |
| `~/.pi/agent/settings.json` | Global Pi settings |

---

## 16. Troubleshooting

### Teammate Fails to Start

```
Error: Failed to spawn teammate process
```

**Check:** `which pi`, `node --version` (≥22.19.0), `/teammate-models` model config.

### Explorer Returns No Results

**Fix:** Verify `SCOPE` paths exist, make `FIND` more concrete, add `ATTENTION` with naming conventions.

### Knowledge Gate Fails

```
maestro: command not found
```

**Fix:** `npm install -g maestro-flow`

### Model Not Available

```
Error: Model not found in authenticated catalog
```

**Fix:** `/teammate-models` → check available models → `/login` to authenticate.

### Agent Hangs

```javascript
teammate-list({ view: "all" })                          // Check status
teammate-watch({ name: "stuck", lines: 50 })            // Inspect output
teammate-send({ to: "stuck", mode: "abort" })           // Terminate
// Retry with timeout:
teammate({ tasks: [{ agent: "general", prompt: "...", timeoutMs: 120000 }] })
```

### Long Session Context Overflow

```bash
/compact "Summarize key decisions and current state"
# Or use fresh context for heavy work:
teammate({ tasks: [{ agent: "general", context: "fresh", prompt: "PURPOSE: Read state and continue\n..." }] })
```

---

## Quick Reference

```bash
# ─── Install ───
pi install npm:pi-maestro-flow@0.21.6

# ─── Knowledge ───
maestro search "query" --code
maestro load --type spec --category coding

# ─── Explore ───
teammate({ tasks: [{ agent: "explorer", taskType: "explore", prompt: "FIND: ...\nSCOPE: src/..." }] })

# ─── Analyze ───
teammate({ tasks: [{ agent: "analyst", taskType: "analysis", prompt: "Analyze the target with file:line evidence" }] })

# ─── Implement ───
teammate({ tasks: [{ agent: "general", taskType: "development", prompt: "Implement the target and run focused tests" }] })

# ─── Review ───
/skill:team-review src/ --level deep

# ─── Full Cycle ───
/skill:maestro-analyze → /skill:maestro-plan → /skill:maestro-execute → /skill:quality-review

# ─── Debug ───
/skill:odyssey-debug "issue description"

# ─── Agent Control ───
teammate-list({ view: "all" })
teammate-watch({ name: "agent", lines: 30 })
teammate-send({ to: "agent", message: "..." })
teammate-send({ to: "agent", mode: "abort" })
```

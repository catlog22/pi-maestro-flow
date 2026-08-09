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

## What It Is

**pi-maestro-flow** is a multi-agent orchestration plugin for the [Pi coding agent](https://github.com/earendil-works/pi). It turns an agent that can only do one thing at a time into an engineering team that **dispatches work in parallel, runs autonomously over the long haul, plans before it acts, and stays fully visible** — with a persistent knowledge system that survives across sessions.

It ships as three plugins (install one, get all three):

| Plugin | In one line |
|--------|-------------|
| **pi-maestro-flow** | Orchestration layer & install entry: goals/tasks/plans, knowledge system, MCP/LSP/browser/search |
| **pi-maestro-teammate** | Execution engine: parallel subprocess agents, DAG dependency graphs, model routing |
| **pi-cockpit** | Visual status: a live status stack above the editor + a Starship-style footer |

> In short: **flow handles "orchestration & knowledge", teammate handles "parallel execution", cockpit handles "visibility".**

## Core Features

- 🔀 **Parallel multi-agent dispatch** — spawn multiple subprocess agents at once, with DAG dependency graphs and structured output
- 🎯 **Goal — autonomous long-running objectives** — set an objective and token budget, loop autonomously across turns, audited by an independent verifier
- 📝 **Plan — approve before you change** — draft a Markdown plan read-only; edits are released only after user approval; supports a dedicated Plan model
- 🛰️ **Pi Cockpit visualization** — live view of running teammates and the todo plan, with 9 built-in themes; Quiet mode compresses tool output and folds thinking blocks
- ⏱️ **bash_bg adaptive shell** — long commands auto-background on timeout and notify on completion, without blocking the conversation
- 🧠 **Persistent knowledge system** — semantic search, spec & knowhow capture, survives across sessions
- 🔄 **Compaction capacity management** — proactive compaction threshold, linked threshold derivation, summary output budgeting against context-window overflow
- 🔁 **Model circuit breaker & failover** — circuit breaker protects API calls with automatic failover to backup models; configurable API retry policy (up to 12 attempts)
- 📤 **Session export** — export current session context for debugging and auditing
- 🔌 **Full protocol connectivity** — MCP client (with OAuth auto-auth) · LSP · browser control (CDP) · web search / deep research
- 🔒 **Permission control** — 5 modes (YOLO enabled by default), fine-grained allow/ask/deny, child-process permission relay
- 🪝 **Codex-compatible Hooks** — project-level hook system with a built-in installer and trust review
- ⌨️ **Shortcut conflict manager** — automatically detect and resolve Shift+Tab and other keybinding conflicts
- 👥 **32 agent roles** (7 built-in + 25 project-level) · 💡 **per-task thinking depth** (`off`→`xhigh`) · 🔌 **custom API Providers**

```javascript
// Flagship: parallel dispatch + DAG dependencies in a single call
teammate({
  tasks: [
    { name: "defs", agent: "explorer", prompt: "FIND: Auth exports\nSCOPE: src/auth/" },
    { name: "calls", agent: "explorer", prompt: "FIND: Auth imports\nSCOPE: src/" },
    { name: "report", agent: "general", prompt: "Merge {defs} + {calls} into a gap report" }
  ]
})
```

---

## Installation

pi-maestro-flow is a **Pi plugin** — install it with `pi install` (not a regular npm dependency).

> **v0.18.0 is out:** fixes the Skill discovery regression that caused v0.17.0 to be withdrawn. npm `latest` and the recommended pinned version are now `0.18.0`.

**Prerequisites:** [Node.js](https://nodejs.org) ≥ 22.19.0 · [Pi Coding Agent](https://github.com/earendil-works/pi) ≥ 0.74.0 (required)

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # host runtime
pi install npm:pi-maestro-flow@0.18.0                              # install or upgrade the plugin
pi list                                                            # confirm Flow, Teammate, and Cockpit are listed
```

Installing `pi-maestro-flow` automatically pulls and registers `pi-maestro-teammate` and `pi-cockpit`. Upgrades migrate Flow-managed companion paths; a same-name local development override is preserved and reported in the startup log, so update or remove that override explicitly. Restart Pi or reload extensions before retrying model-sensitive work.

## Quick Start

```bash
pi   # start, then just describe your task in natural language
```

Maestro Flow classifies intent and routes automatically: **simple tasks** run directly · **multi-step engineering** is decomposed into chained plans and verified step by step · **long-running objectives** loop autonomously with independent completion verification. `/maestro-help` lists all commands.

---

## Tools & Skills

- **19 always-on tools + 5 dynamic Plan tools**
  - Dispatch: `teammate` · `teammate-send/list/watch/wait`
  - Orchestration: `maestro` · `goal` · `todo` · `run-control` · `plan-*`
  - Connectivity: `mcp` · `lsp` · `browser` · `smart_search` · `ffgrep`/`fffind`
  - Other: `bash_bg` · `ask-user-question` · `search_tool_bm25`
- **63 skills** (maintained by [Maestro Flow](https://github.com/catlog22/maestro-flow)) — spanning workflow orchestration, knowledge management, team coordination, UI design, academic writing, and skill tooling. Full catalog: [Maestro Flow skills directory](https://github.com/catlog22/maestro-flow/tree/main/skills)
- **32 agent roles** — 7 built-in (explorer, planner, analyst, research, general, verifier, workflow) + 25 project-level (executor, reviewer, debugger, roadmapper…)

Full tool parameters and workflow definitions live in the **[Usage Guide](docs/USAGE_EN.md)**.

---

## 📖 Documentation

| Document | Description |
|----------|-------------|
| **[Usage Guide](docs/USAGE_EN.md)** / **[中文](docs/USAGE.md)** | Complete feature documentation — all tools, MCP, permissions, thinking depth, agents, workflows |
| **[User Guide](GUIDE.md)** | In-depth tutorial with examples for every subsystem |
| **[Smart Search Provider Config](docs/smart-search-provider-config.md)** | Search provider setup — dual-path architecture, API keys, credential syntax, TUI config, sync |
| **[Release Notes](RELEASE.md)** | Version history and changelog |
| Per-plugin READMEs | [flow](packages/pi-maestro-flow/README.md) · [teammate](packages/pi-maestro-teammate/README.md) · [cockpit](packages/pi-cockpit/README.md) |

---

## Credits

- **[Maestro-Flow](https://github.com/catlog22/maestro-flow)** — intent-driven workflow orchestration by [@catlog22](https://github.com/catlog22)
- **[Pi Coding Agent](https://github.com/earendil-works/pi)** — terminal coding harness (host runtime) by [@earendil-works](https://github.com/earendil-works)
- Upstream libraries powering built-in tools: [@modelcontextprotocol/sdk](https://modelcontextprotocol.io) (`mcp`) · [Puppeteer](https://github.com/puppeteer/puppeteer) (`browser`) · [@ff-labs/fff-node](https://github.com/dmtrKovalenko/fff) (`ffgrep`/`fffind`) · [@konbakuyomu/smart-search](https://github.com/konbakuyomu/smartsearch) (`smart_search`) · [pi-web-access](https://github.com/nicobailon/pi-web-access) (native web search/extraction/curator)

## License

[MIT](LICENSE) © 2026 catlog22

---

## Friendly Links

- **[Linux DO](https://linux.do/)** — Learn AI on Linux DO!

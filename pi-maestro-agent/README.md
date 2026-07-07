# pi-maestro-agent

> Maestro flow tools for [Pi](https://github.com/earendil-works/pi) — explore, delegate, and MOA built on pi-teammate

Pi extension providing a unified `maestro` tool with action-based dispatch for code exploration, task delegation, and Mixture-of-Agents synthesis. Built on [pi-teammate](../pi-teammate/) for the execution engine.

## Features

### Tools

| Tool | Purpose |
|------|---------|
| `maestro` | Main dispatch — `action: explore \| delegate \| moa` |
| `maestro-wait` | Block until background runs finish |
| `maestro-status` | Inspect running/completed teammate fleet |

### Actions

**explore** — Parallel codebase exploration. Each prompt spawns an `explorer` agent with read-only tools.

```
{ action: "explore",
  prompts: ["Find all API route handlers", "Map the database schema"],
  concurrency: 4 }
```

**delegate** — Task delegation to a specific model/provider. The `delegate` agent gets full read-write tools.

```
{ action: "delegate",
  prompt: "Refactor the auth module to use JWT",
  tool: "claude",
  mode: "write" }
```

**moa** — Mixture-of-Agents. Multiple `reference` agents explore in parallel, then an `aggregator` synthesizes.

```
{ action: "moa",
  prompts: ["Analyze the payment flow"],
  preset: "default" }
```

### Dynamic Provider Registration

On startup, reads `~/.maestro/cli-tools.json` and registers each enabled tool as a Pi provider via `pi.registerProvider()`. Supports Gemini, Claude, Codex, OpenCode, and any OpenAI-compatible endpoint. Authentication via Pi CredentialStore.

### Agent Definitions

| Agent | Role | Tools |
|-------|------|-------|
| `explorer` | Read-only codebase exploration | read, grep, find, ls |
| `delegate` | General-purpose task execution | read, grep, find, ls, bash, edit, write |
| `reference` | MOA reference — independent analysis | read, grep, find, ls |
| `aggregator` | MOA aggregator — synthesize reference outputs | read, grep, find, ls |

## Install

```bash
pi install npm:@pi-maestro/agent
# or from local path
pi install ./pi-maestro-agent
```

Requires `@pi-maestro/teammate` as a dependency (installed automatically).

## Usage

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

### Wait for Background Runs

```
// maestro-wait tool
{ all: true, timeoutMs: 600000 }
```

### Check Fleet Status

```
// maestro-status tool
{ view: "fleet" }
```

## Configuration

### cli-tools.json

Provider registration reads from `~/.maestro/cli-tools.json`:

```json
{
  "tools": {
    "claude": { "enabled": true, "primaryModel": "claude-sonnet-4" },
    "gemini": { "enabled": true, "primaryModel": "gemini-2.5-pro" },
    "codex": { "enabled": true, "primaryModel": "gpt-4.1" }
  }
}
```

## Architecture

```
┌──────────────────────────────────────┐
│  maestro tool                        │
│                                      │
│  action: explore ─┬─► explorer agents (parallel)
│  action: delegate ─┤─► delegate agent (single)
│  action: moa ──────┘─► reference agents (parallel)
│                          └─► aggregator agent
│                                      │
│  All dispatch via ──► pi-teammate    │
│  (spawn pi subprocess)              │
└──────────────────────────────────────┘
```

## License

MIT

# pi-teammate

> Teammate dispatch tool for [Pi](https://github.com/earendil-works/pi) — three-axis agent orchestration with P0 decoupling

Pi extension implementing teammate dispatch with **P0 three-axis decoupling** (name × reply_to × lifecycle). Spawn isolated pi subprocesses as teammates with protocol-versioned routing, parallel/chain execution, and structured output.

## Features

### Three-Axis Control

| Axis | Field | Values | Purpose |
|------|-------|--------|---------|
| Addressability | `name` | string \| omit | Cross-agent routing via name |
| Result Routing | `reply_to` | `"caller"` \| `"main"` | Where results go |
| Lifecycle | `lifecycle` | `"ephemeral"` \| `"resident"` | One-shot or persistent |

**Protocol version gate** — v2 (default) routes results to `caller`; v1 compat routes named agents to `main`. Explicit `reply_to` always wins.

### Execution Modes

- **Single** — dispatch one agent with a task
- **Parallel** — `tasks[]` runs multiple agents concurrently with configurable `concurrency`
- **Chain** — `chain[]` sequential pipeline where each step receives `{previous}` result

### Reliability

- **Model fallback chain** — primary model → `fallbackModels[]` from agent config → automatic retry on model failures
- **Nesting depth guard** — `PI_TEAMMATE_DEPTH` env tracking with configurable max (default: 3) prevents fork bombs
- **Windows-safe pi resolution** — `getPiSpawnCommand()` resolves the pi binary via env override, Windows script detection, or PATH
- **Abort signal** — SIGTERM → 5s grace → SIGKILL

### Output & Tracking

- **Structured output** — `outputSchema` validates child output against JSON Schema, returns parsed `structuredOutput`
- **Rich progress** — `AgentProgress` with `recentTools[]`, `toolCount`, `tokens`, `durationMs`, `lastActivityAt`
- **Session management** — derives child session directory from parent session, supports `context: "fork"`
- **Correlation ID** — auto-generated per dispatch for result routing

### Agent Definitions

Agents are markdown files with YAML frontmatter — discovered from project (`.pi/agents/`), user (`~/.pi/agent/extensions/teammate/agents/`), or builtin locations. Project overrides user overrides builtin.

## Install

```bash
pi install npm:@pi-maestro/teammate
# or from local path
pi install ./pi-teammate
```

## Quick Start

### Single Agent

```
{ agent: "delegate", task: "Implement the auth middleware" }
```

### Parallel Execution

```
{ tasks: [
    { agent: "scout", task: "Find all API endpoints" },
    { agent: "scout", task: "Map database schemas" },
    { agent: "scout", task: "List external dependencies" }
  ],
  concurrency: 3
}
```

### Chain Pipeline

```
{ chain: [
    { agent: "scout", task: "Find the auth module structure" },
    { agent: "delegate", task: "Based on this context: {previous}\n\nRefactor the auth module" }
  ]
}
```

### Three-Axis Routing

```
{ agent: "delegate", task: "...", name: "worker-1", reply_to: "caller", lifecycle: "ephemeral" }
```

### Structured Output

```
{ agent: "scout", task: "List all API routes",
  outputSchema: {
    type: "object",
    properties: { routes: { type: "array", items: { type: "string" } } },
    required: ["routes"]
  }
}
```

## Agent Definition Format

Create `agents/my-agent.md`:

```markdown
---
name: my-agent
description: Short description of what this agent does
tools: read, grep, find, ls, bash, edit, write
model: anthropic/claude-sonnet-4
fallbackModels: google/gemini-2.5-pro, anthropic/claude-haiku-4
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
---

You are a specialized agent. Your system prompt goes here.

Use the provided tools to accomplish the task.
```

### Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | **required** | Agent identifier |
| `description` | string | **required** | Short description |
| `tools` | comma-sep | all | Available tools |
| `model` | string | parent model | Primary model |
| `fallbackModels` | comma-sep | — | Fallback model chain |
| `thinking` | string | — | Thinking level (low/medium/high) |
| `systemPromptMode` | append\|replace | replace | How system prompt is applied |
| `inheritProjectContext` | bool | false | Inherit parent project context |
| `inheritSkills` | bool | false | Inherit parent skills |
| `defaultContext` | fresh\|fork | fresh | Default context mode |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Parent Pi Session                              │
│                                                 │
│  teammate tool call                             │
│       │                                         │
│       ├── resolve agent (project > user > built) │
│       ├── resolve reply_to (protocol gate)      │
│       ├── check depth guard                     │
│       ├── build model candidates                │
│       │                                         │
│       ▼                                         │
│  ┌─────────────────────────────────────┐        │
│  │  spawn("pi", ["--mode","json","-p"])│        │
│  │  env: PI_TEAMMATE_CHILD=1           │        │
│  │       PI_TEAMMATE_DEPTH=N           │        │
│  │       PI_TEAMMATE_CORRELATION_ID=…  │        │
│  │       PI_TEAMMATE_REPLY_TO=caller   │        │
│  │                                     │        │
│  │  stdout: JSON lines ──────────────► │ parse  │
│  │  (message_end, tool_result_end,     │ events │
│  │   usage, error)                     │        │
│  └─────────────────────────────────────┘        │
│       │                                         │
│       ├── accumulate usage                      │
│       ├── track progress (AgentProgress)        │
│       ├── model fallback on failure             │
│       └── return SingleResult                   │
└─────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PI_TEAMMATE_PI_BINARY` | Override pi binary path |
| `PI_TEAMMATE_CHILD` | Set to `"1"` in child processes |
| `PI_TEAMMATE_DEPTH` | Current nesting depth |
| `PI_TEAMMATE_CORRELATION_ID` | Correlation ID for routing |
| `PI_TEAMMATE_REPLY_TO` | Resolved reply target |
| `PI_TEAMMATE_PARENT_SESSION` | Parent session file path |

## License

MIT

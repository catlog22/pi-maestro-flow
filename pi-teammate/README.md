# pi-teammate

> Teammate dispatch tool for [Pi](https://github.com/earendil-works/pi) — unified TaskSpec with DAG variable referencing

Pi extension implementing teammate dispatch with **unified TaskSpec model**. Single agent, parallel fan-out, sequential chains, and arbitrary DAGs all use the same schema — execution order is determined by `{name}` variable references between tasks.

## Quick Start

### Single Agent

```
{ agent: "delegate", task: "Implement the auth middleware" }
```

### Parallel (no references = concurrent)

```
{ tasks: [
    { agent: "scout", task: "Find all API endpoints" },
    { agent: "scout", task: "Map database schemas" },
    { agent: "scout", task: "List external dependencies" }
  ],
  concurrency: 3
}
```

### Chain (linear references = sequential)

```
{ tasks: [
    { agent: "scout", name: "recon", task: "Find the auth module structure" },
    { agent: "delegate", task: "Based on this context: {recon}\n\nRefactor the auth module" }
  ]
}
```

### DAG (mixed references = auto-scheduling)

```
{ tasks: [
    { agent: "scout", name: "api", task: "List all API routes",
      outputSchema: {
        type: "object",
        properties: { routes: { type: "array", items: { type: "string" } } },
        required: ["routes"]
      } },
    { agent: "scout", name: "db", task: "Map the database schema" },
    { agent: "reviewer", task: "Routes: {api.routes}\nDB: {db}\n\nCheck consistency" }
  ]
}
```

`api` and `db` run in parallel. `reviewer` waits for both, with `{api.routes}` resolved from structured output and `{db}` from text output.

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

In multi-task mode, structured outputs are aggregated by task `name` in the result's `structuredOutput` field.

## Core Concepts

### Two Rules

1. **Reference = dependency**: `{name}` in a task's description means "wait for the task named `name` to complete, then inject its output here"
2. **No reference = parallel**: tasks with no dependencies run concurrently (bounded by `concurrency`)

No `mode` field needed — the execution engine infers parallel, chain, or graph from the reference topology.

### Variable References

| Syntax | Resolves to |
|--------|-------------|
| `{name}` | Full text output; or JSON string if the task has `outputSchema` |
| `{name.field}` | Field from structured output |
| `{name.arr[0].path}` | Nested field with array indexing |

Only tasks with a `name` field can be referenced. Non-task `{braces}` (JSON, format strings) are left untouched.

### Default Inheritance

Top-level fields serve as defaults for all tasks:

| Field | Scope | Override |
|-------|-------|----------|
| `model` | Default model for all tasks | Per-task `model` wins |
| `cwd` | Default working directory | Per-task `cwd` wins |
| `outputSchema` | Default schema for all tasks | Per-task `outputSchema` wins |
| `timeoutMs` | Default timeout | Per-task `timeoutMs` wins |

### Three-Axis Control

| Axis | Field | Values | Purpose |
|------|-------|--------|---------|
| Addressability | `name` | string \| omit | Variable referencing + teammate-send routing |
| Result Routing | `reply_to` | `"caller"` \| `"main"` | Where results go |
| Lifecycle | `lifecycle` | `"ephemeral"` \| `"resident"` | One-shot or persistent |

**Protocol version gate** — v2 (default) routes results to `caller`; v1 compat routes named agents to `main`. Explicit `reply_to` always wins.

## TaskSpec Schema

```typescript
interface TaskSpec {
  agent: string;        // Agent name (matches agents/*.md filename)
  task?: string;        // Task description with {name} variable support
  name?: string;        // Identifier for referencing and teammate-send
  model?: string;       // Model override
  cwd?: string;         // Working directory
  outputSchema?: object; // JSON Schema for structured output
  timeoutMs?: number;   // Timeout in milliseconds
}
```

## Full Parameters

```typescript
interface TeammateParams extends TaskSpec {
  // Multi-task
  tasks?: TaskSpec[];     // Multiple tasks with {name} references
  concurrency?: number;   // Max concurrent tasks (default: 4)

  // Execution control (applies to ALL modes)
  background?: boolean;   // Run in background (default: true)
  context?: "fresh" | "fork";

  // P0 three-axis
  reply_to?: "caller" | "main";
  protocol_version?: number;

  // Deprecated
  chain?: Array<{ agent, task?, model? }>; // Use tasks with {name} references
}
```

## Validation & Error Handling

- **Duplicate names**: detected before execution, all tasks fail with error
- **Circular dependencies**: detected before execution via cycle detection
- **Missing reference**: `{unknown}` left as literal text (not a task name)
- **Field access without schema**: error when `{name.field}` used but task has no `outputSchema`
- **Upstream failure**: dependent tasks are skipped with "upstream dependency failed"

## Deprecated: chain[]

The `chain` field is preserved for backward compatibility. It normalizes internally to `tasks` with sequential `{_stepN}` references:

```
// This chain:
{ chain: [
    { agent: "scout", task: "Find auth code" },
    { agent: "delegate", task: "Fix: {previous}" }
  ]
}

// Is equivalent to:
{ tasks: [
    { agent: "scout", name: "_step0", task: "Find auth code" },
    { agent: "delegate", name: "_step1", task: "Fix: {_step0}" }
  ]
}
```

## Flat Agent Model

All agents are managed by the root process in a single flat `activeRuns` pool, regardless of who requested the spawn. Child agents that call the teammate tool send a proxy request to the root, which spawns the new agent as a peer — not a nested subprocess.

### How It Works

```
coordinator calls teammate({ agent: "scout", name: "recon" })
  │  stdout: teammate_proxy_request
  ▼
Root spawns scout → registers in root's activeRuns/namedAgents
  │  IPC: teammate_proxy_result
  ▼
coordinator receives result
```

All agents are flat peers:
- `teammate-send({ to: "name" })` = one lookup in `namedAgents` → stdin. Direct delivery.
- `teammate-list` = iterate `activeRuns`. Flat, simple.
- `teammate-watch` = read agent's `outputLog`. Direct.

### Child Proxy Tools

Child processes register proxy versions of all teammate tools. Each proxy:
1. Writes a `teammate_proxy_request` JSON line to stdout
2. Awaits the result via Node.js IPC (`process.on("message")`)

The root's event parser intercepts these requests and executes them locally. The IPC channel is established via `stdio: ["pipe","pipe","pipe","ipc"]` at spawn time.

## Reliability

- **Model fallback chain** — primary model → `fallbackModels[]` from agent config → automatic retry
- **Flat agent pool** — all agents managed by root process; child proxy tools forward spawn requests to root; depth guard (`PI_TEAMMATE_DEPTH`) prevents runaway recursion
- **Windows-safe pi resolution** — `getPiSpawnCommand()` resolves the pi binary via env override, Windows script detection, or PATH
- **Abort signal** — SIGTERM → 5s grace → SIGKILL

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

## Install

```bash
pi install npm:@pi-maestro/teammate
# or from local path
pi install ./pi-teammate
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

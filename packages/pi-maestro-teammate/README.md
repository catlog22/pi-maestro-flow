# pi-teammate

> Teammate dispatch tool for [Pi](https://github.com/earendil-works/pi) — unified TaskSpec with DAG variable referencing + resident agent model

Pi extension implementing teammate dispatch with **unified TaskSpec model**. Single agent, parallel fan-out, sequential chains, and arbitrary DAGs all use the same schema — execution order is determined by `{name}` variable references between tasks.

## Automatic Model Routing

Teammate maps task phases to models authenticated in the current Pi session. Supported task types are `explore`, `analysis`, `debug`, `planning`, `development`, `review`, and `testing`.

Open the mapping overlay with `Alt+M` or `/teammate-models`. Project mappings are saved to `.pi/teammate-models.json`; global defaults can be stored in `~/.pi/agent/teammate-models.json`, with project values taking precedence.

```json
{
  "version": 1,
  "mappings": {
    "explore": "google/gemini-2.5-pro",
    "analysis": "openai/gpt-5",
    "debug": "anthropic/claude-opus-4"
  }
}
```

Precedence is task-level `model` → top-level `model` → explicit `taskType` mapping → inferred task type → agent default. Omit `model` to use routing:

```json
{
  "agent": "explorer",
  "taskType": "explore",
  "task": "FIND: auth middleware\nSCOPE: src/auth/",
  "background": false
}
```

## Quick Start

### Single Agent

```
{ agent: "delegate", task: "Implement the auth middleware" }
```

### Parallel (no references = concurrent)

```
{ tasks: [
    { agent: "explorer", name: "api", task: "Find all API endpoints" },
    { agent: "explorer", name: "db", task: "Map database schemas" },
    { agent: "explorer", name: "deps", task: "List external dependencies" }
  ],
  concurrency: 3,
  background: false
}
```

### Chain (linear references = sequential)

```
{ tasks: [
    { agent: "explorer", name: "recon", task: "Find the auth module structure" },
    { agent: "delegate", name: "implement", task: "Based on this context: {recon}\n\nRefactor the auth module" }
  ],
  concurrency: 1,
  background: false
}
```

### DAG (mixed references = auto-scheduling)

```
{ tasks: [
    { agent: "explorer", name: "api", task: "List all API routes",
      outputSchema: {
        type: "object",
        properties: { routes: { type: "array", items: { type: "string" } } },
        required: ["routes"]
      } },
    { agent: "explorer", name: "db", task: "Map the database schema" },
    { agent: "delegate", name: "verify", task: "Routes: {api.routes}\nDB: {db}\n\nCheck consistency" }
  ],
  concurrency: 2,
  background: false
}
```

`api` and `db` run in parallel. `delegate` waits for both, with `{api.routes}` resolved from structured output and `{db}` from text output.

For production nested dispatch, give every task a unique `name`, set an explicit
provider-safe `concurrency`, and use `background: false` whenever the parent must
consume all child results before it continues. Background runs return immediately
and report completion to the root session.

### Structured Output

```
{ agent: "explorer", task: "List all API routes",
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

## Resident Agent Model

Agents don't exit after completing a task. Instead they enter a **sleeping** state and can be woken up for follow-up work.

### Lifecycle

```
dispatch → running → turn complete → sleeping → teammate-send → running → ...
                                                                         ↓
                                                              abort → terminated
```

| Status | Description |
|--------|-------------|
| `running` | Agent is actively processing a task |
| `sleeping` | Turn complete, process alive, waiting for `teammate-send` to wake |
| `completed` | Agent terminated (via abort or session shutdown) |

### How It Works

1. Agent completes its turn → `agent_end` event fires
2. Result is reported to the main session (background notification)
3. Agent enters **sleeping** state — RPC process stays alive, stdin open
4. `teammate-send({ to: "name", message: "new task" })` sends a `follow_up` → agent wakes up and processes the new message
5. `teammate-send({ to: "name", mode: "abort" })` terminates the agent

### Active Time Tracking

Time spent sleeping is excluded from the displayed duration. `sleepMs` accumulates total sleep time; displayed uptime = wall clock − sleep time.

### Agent Resolution

Agent names must resolve to one of the three reserved builtin roles (`delegate`,
`explorer`, `workflow`) or to a discovered project/user role. Unknown names return
an error with the available role catalog instead of silently using a generic
configuration. The legacy name `coordinator` resolves to `workflow`.

## TaskSpec Schema

```typescript
interface TaskSpec {
  agent: string;        // Agent name (matches agents/*.md, or any name with fallback)
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
    { agent: "explorer", task: "Find auth code" },
    { agent: "delegate", task: "Fix: {previous}" }
  ]
}

// Is equivalent to:
{ tasks: [
    { agent: "explorer", name: "_step0", task: "Find auth code" },
    { agent: "delegate", name: "_step1", task: "Fix: {_step0}" }
  ]
}
```

## Flat Agent Model

All agents are managed by the root process in a single flat `activeRuns` pool, regardless of who requested the spawn. Child agents that call the teammate tool send a proxy request to the root via IPC, which spawns the new agent as a peer — not a nested subprocess.

### How It Works

```
workflow calls teammate({ agent: "explorer", name: "recon" })
  │  IPC: teammate_proxy_request (process.send)
  ▼
Root spawns explorer → registers in root's activeRuns/namedAgents
  │  IPC: teammate_proxy_result (child.send)
  ▼
workflow receives result
```

All agents are flat peers:
- `teammate-send({ to: "name" })` = one lookup in `namedAgents` → stdin. Direct delivery.
- `teammate-list({ view: "active" | "named" | "all" })` = iterate running instances.
- `teammate-list({ view: "roles" })` = list all available builtin, project, and user-defined roles with descriptions.
- `teammate-watch` = read agent's `outputLog`. Direct.

### Child Proxy Tools

Every child process automatically gets proxy versions of all 4 teammate tools (injected into `--tools` whitelist regardless of agent definition). Each proxy:
1. Sends a `teammate_proxy_request` via Node.js IPC (`process.send()`)
2. Awaits the result via IPC (`process.on("message")`)

The root's IPC message listener (`child.on("message")`) intercepts these requests and executes them locally.

### Main-Session Interaction Relay

Parent extensions can register themselves for inheritance by teammate children. `pi-maestro-flow` uses this bridge automatically, so every child loads its permission hooks and receives the `ask-user-question` tool even when the role has an explicit `tools` whitelist.

When a child needs user input, it sends a reply-capable `teammate_interaction_request` to the root session:

- Permission requests are displayed in the main UI with `Allow once`, `Always allow`, and `Deny`. The selected action is returned to the blocked child tool call.
- `ask-user-question` requests are displayed in the main UI and return structured option/free-text answers to the child.
- Pending requests are tracked by `requestId` on the active agent and serialized through the root interaction queue, preventing overlapping prompts.
- Headless root sessions still run the parent permission broker: silent allow/deny decisions work, while permissions that require a dialog fail closed and questionnaires are cancelled.

The response uses `teammate_interaction_response` with the original `requestId`, so late or duplicate responses cannot resolve a different child request.

## Reliability

- **Model fallback chain** — primary model → `fallbackModels[]` from agent config → automatic retry
- **Flat agent pool** — all agents managed by root process; child proxy tools forward spawn requests to root; depth guard (`PI_TEAMMATE_DEPTH`) prevents runaway recursion
- **Resident lifecycle** — agents sleep after turn completion; process stays alive for follow-up; only killed on explicit abort or session shutdown
- **IPC disconnect guard** — child proxy resolves all pending requests with error on disconnect (root crash / agent abort)
- **Interaction fail-closed** — missing main UI, timeout, or relay failure never grants a child permission request
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
pi install npm:pi-maestro-teammate
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
# Agent discovery

The package always provides exactly three reserved builtin roles:

- `delegate`: general-purpose execution, including fixed prompt templates
- `explorer`: read-only code discovery and call-chain tracing
- `workflow`: dependency-aware DAG decomposition and teammate delegation

Other Agent Markdown files are discovered with the following precedence:

1. nearest project `.pi/agents/*.md`
2. nearest project `.agents/*.md`
3. `~/.agents/*.md`
4. legacy `~/.pi/agent/extensions/teammate/agents/*.md`

Project and user files cannot override the three reserved builtin names. Their
`name` and `description` fields are refreshed into the active system prompt on
every `before_agent_start`; the Markdown body is loaded only after the role is
selected. Files without both fields are ignored. Unknown role names are rejected.

Pi has no native `pi.agents` package manifest field. Builtin teammate agents are
resolved relative to the installed extension module, so npm, git, global and local
Pi package installs all use the same package-local `agents/` directory.

## Fixed prompt templates

`teammate` can load Pi-compatible Markdown prompt templates with `prompt` and
`promptArgs`. Discovery priority is project `.pi/prompts/*.md`, user
`~/.pi/agent/prompts/*.md`, then this package's `prompts/*.md`. Template syntax uses
Pi's `$1`, `$2`, `$@`, `$ARGUMENTS`, `${1:-default}`, and `${@:N:L}` forms. The task
value is `$1`; `promptArgs` start at `$2`.

```json
{
  "agent": "delegate",
  "prompt": "analysis",
  "task": "Analyze the authentication flow",
  "promptArgs": ["@src/auth/**/*.ts", "file:line evidence"],
  "model": "provider/model",
  "background": true
}
```

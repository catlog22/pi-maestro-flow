# pi-maestro-teammate

Pi extension for dispatching one or more role-based teammate tasks through a single dependency-aware API.

`pi-maestro-teammate` is the execution engine used by `pi-maestro-flow`. Each task runs in an isolated Pi subprocess with its own role prompt, tools, context, model, lifecycle, and structured-output contract.

## Breaking Changes In 1.0

- Every public `teammate` call requires a non-empty `tasks` array.
- Single-agent work is represented by `tasks` with one item.
- `tasks[].prompt` is the only task text and is always literal.
- Removed `task`, `promptArgs`, top-level `prompt`, and deprecated `chain`.
- Removed prompt-template discovery, bundled templates, and `./v1/prompts`.
- Built-in roles are now `general`, `explorer`, `planner`, `analyst`, `research`, `verifier`, and `workflow`.
- Removed the built-in names `delegate`, `goal-verifier`, and the `coordinator` alias.
- Public parameter objects reject unknown fields.

## Quick Start

### Single Task

```ts
teammate({
  tasks: [{
    agent: "general",
    prompt: "Implement the auth middleware and run focused tests"
  }]
})
```

`agent` is optional. A task inherits the top-level `agent`, then defaults to `general`.

### Parallel Tasks

```ts
teammate({
  agent: "explorer",
  taskType: "explore",
  model: "provider/fast-model",
  tasks: [
    { name: "api", prompt: "Find all API endpoints" },
    { name: "db", prompt: "Map database schemas" },
    { name: "deps", prompt: "List external dependencies" }
  ],
  concurrency: 3
})
```

Top-level task fields are defaults. A task-level value overrides the matching top-level value.

### Dependency Graph

```ts
teammate({
  tasks: [
    {
      name: "scan",
      agent: "explorer",
      prompt: "Find the authentication entry points"
    },
    {
      name: "review",
      agent: "analyst",
      prompt: "Review {scan} for correctness and security"
    },
    {
      name: "implement",
      agent: "general",
      dependsOn: ["review"],
      prompt: "Implement the approved authentication changes from {review}"
    }
  ],
  concurrency: 2,
  background: false
})
```

`{name}` injects an upstream task's final output. `{name.field}` reads structured output. `dependsOn` creates ordering without injecting output. Independent tasks run concurrently.

### Structured Output

```ts
teammate({
  tasks: [{
    name: "routes",
    agent: "explorer",
    prompt: "List all API routes",
    outputSchema: {
      type: "object",
      properties: {
        routes: { type: "array", items: { type: "string" } }
      },
      required: ["routes"],
      additionalProperties: false
    }
  }]
})
```

## Parameters

```ts
interface TeammateParams {
  tasks: TaskSpec[];

  // Defaults inherited by tasks
  agent?: string;
  taskType?: string; // validated lower-case identifier; custom agent types are supported
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  context?: "fresh" | "fork";
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;

  // Dispatch controls
  concurrency?: number;
  maxAgents?: number;
  background?: boolean;
  reply_to?: "caller" | "main";
}

interface TaskSpec {
  prompt: string;
  agent?: string;
  taskType?: TeammateParams["taskType"];
  model?: string;
  thinking?: TeammateParams["thinking"];
  name?: string;
  dependsOn?: string[];
  context?: "fresh" | "fork";
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}
```

`tasks` must contain at least one item and every `prompt` must be non-empty. `background` defaults to `false`. `context` defaults to `fresh`.

## Built-In Roles

| Role | Purpose | Default boundary |
|---|---|---|
| `general` | Direct implementation, analysis, and verification | Read/write/command tools; project context |
| `explorer` | Fast code discovery and call-chain tracing | Read-only; low thinking |
| `planner` | Architecture and execution planning | Read-only; high thinking |
| `analyst` | Technical analysis, review, and verification | Read-only; high thinking |
| `research` | Project architecture knowledge and external web research | Read-only; knowledge CLI plus web search |
| `verifier` | Goal completion fallback when no acceptance commands exist | Strictly read-only; structured fail-closed verdict |
| `workflow` | Dependency-aware decomposition and teammate DAG dispatch | Read plus teammate collaboration tools |

Unknown role names fail explicitly. Built-in names are reserved and cannot be replaced by project or user roles.

## Custom Roles

Create `.pi/agents/my-agent.md`:

```markdown
---
name: my-agent
description: Project-specific migration specialist
tools:
  - Read
  - Grep
  - Bash
taskType: planning
model: provider/model
fallbackModels: provider/fallback-a, provider/fallback-b
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

You are the project migration specialist.
```

Supported discovery precedence is:

```text
project .pi/agents > project .agents > ~/.agents > legacy user directory > bundled roles
```

`taskType` is optional role metadata and may be a built-in type or a custom lower-case identifier such as `security-audit`. Explicit task-level or top-level values override it; otherwise routing uses the resolved role's YAML type, may infer a built-in type from the role name or prompt, or leaves it unset. `tools` accepts a comma-separated value or YAML-style list and is normalized to Pi tool IDs.

## Model Routing

Configure task-type defaults with `Alt+M`, `/teammate-models`, project `.pi/teammate-models.json`, or global `~/.pi/agent/teammate-models.json`. The Control Center automatically combines built-in task types, types declared by currently discovered built-in/project/user agents, and types already present in routing configuration. Each type can select both an authenticated model and a model-supported thinking depth.

```json
{
  "version": 2,
  "mappings": {
    "explore": "provider/fast-model",
    "analysis": "provider/deep-model"
  },
  "thinkingLevels": {
    "explore": "low",
    "analysis": "high"
  }
}
```

Model precedence:

```text
task.model > top-level model > taskType mapping > role model > parent Pi model
```

Thinking precedence:

```text
task.thinking > top-level thinking > taskType mapping > role thinking > Pi default
```

Role `fallbackModels` follow the selected primary model. Model identifiers must use exact authenticated `provider/model` values.

## Runtime

- Foreground dispatch is the default and returns child results directly.
- Background dispatch returns an acknowledgement and later emits `teammate-complete`.
- Named agents can receive `steer`, `follow_up`, or `abort` messages through `teammate-send`.
- Resident agents sleep after a completed turn and can be resumed by follow-up messages.
- Nesting is capped at two layers and concurrent agents are globally bounded.
- Public lifecycle events are exported from `pi-maestro-teammate/v1/events`.

## Development

```bash
npm --workspace pi-maestro-teammate run typecheck
npm --workspace pi-maestro-teammate test
npm --workspace pi-maestro-teammate run build:declarations
npm --workspace pi-maestro-teammate run check:declarations
```

## License

ISC

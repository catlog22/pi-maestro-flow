# pi-maestro-teammate

Pi extension for dispatching one or more role-based teammate tasks through a single dependency-aware API.

`pi-maestro-teammate` is the execution engine used by `pi-maestro-flow`. Each task runs in an isolated Pi subprocess with its own role prompt, tools, context, model, lifecycle, and structured-output contract.

## Breaking Changes In 1.0

> Current version: **2.0.0**. The 1.0 breaking changes below remain in effect; later releases added circuit breaker, retry resilience, quiet state, duration tracking, observe `watch`/`until=completed`, per-workspace mailbox isolation, lifecycle hardening, and explicit model-registry routing without breaking the v1 public import paths.

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

## Model Routing Profiles

Configure task-type defaults with `Alt+M` or `/teammate-models`. The Control Center's **Profiles** tab manages named routing Profiles shared by every project. Its **Routing** tab edits the active global Profile and combines built-in task types, discovered agent types, and types already present in that Profile.

The **Roles** tab lists discovered roles and their effective durable route. Role-scoped settings can be edited through the unified Settings surface as `role.<role-name>.model`, `role.<role-name>.fallbacks`, and `role.<role-name>.thinking`. These settings are stored in the same global Profile or project override file; package updates never rewrite role definitions or user routing data.

Global Profiles are stored in `~/.pi/agent/teammate-models.json`:

```json
{
  "version": 3,
  "defaultProfile": "balanced",
  "profiles": {
    "balanced": {
      "name": "Balanced",
      "mappings": {
        "explore": "provider/fast-model",
        "analysis": "provider/deep-model"
      },
      "fallbackMappings": {
        "analysis": ["provider/backup-model"]
      },
      "thinkingLevels": {
        "explore": "low",
        "analysis": "high"
      },
      "roleMappings": {
        "security-specialist": {
          "model": "provider/security-model",
          "fallbackModels": ["provider/security-backup"],
          "thinking": "high"
        }
      }
    }
  }
}
```

Each project persists its active Profile and optional compatibility overrides in `.pi/teammate-models.json`:

```json
{
  "version": 3,
  "activeProfile": "balanced",
  "applyOverrides": false,
  "overrides": {
    "mappings": {},
    "thinkingLevels": {},
    "roleMappings": {}
  }
}
```

Profile IDs remain stable when display names are renamed. Switching Profiles disables but preserves existing project overrides; the Profiles menu can restore, promote, or clear them. Global and project v1/v2 files are read without being rewritten and migrate losslessly on their first save. A missing project Profile falls back to the global default and is reported in the Control Center.

Routing source precedence:

```text
project overrides (when enabled) > active global Profile > global default Profile
```

Model precedence:

```text
task.model > top-level model > taskType mapping > role mapping > role frontmatter model > parent Pi model
```

Thinking precedence:

```text
task.thinking > top-level thinking > taskType mapping > role mapping > role frontmatter thinking > Pi default
```

Role `fallbackModels` follow the selected primary model. In legacy and backend-registry modes, model identifiers use exact authenticated `provider/model` values. In v2 model-registry mode they use canonical registration ids or configured aliases.

## Model Registry

`.pi/teammate-backends.json` has three modes:

| Mode | Authority |
|---|---|
| absent / `legacy` | original Pi/CLI routing |
| `backend-registry` | older backend registrations; model catalog remains a compatibility projection |
| `model-registry` with `version: 2` | explicit deployment and model-registration graph |

A v2 manifest preserves separate identities for the model registration, intrinsic model, deployment, and adapter selector. DSH deployments use `pi-maestro-backends/dsh` and select the harness model with an `adapter-model` selector. Pi, DSH, local ACP, and direct-SSH ACP routes are available in root and child sessions. `remote-workers` uses a `fixed` selector and is available only from the active root Monitor session.

The Flow `model-availability` tool returns the selectable ids in its existing `teammate_models` field and adds a secret-free `model_registry.registrations` topology matrix. Every row reports `registered`, `resolvable`, `sessionAvailable`, `healthy`, and a sanitized `unavailableReason`; remote rows remain visible outside Monitor with a deterministic reason. Raw backend config, commands, SSH targets, selectors, and credential values are never included.

CLI catalog compatibility is opt-in with `compatibility.teammateCliToolsProjection.enabled`. An enabled `teammate-cli-tools.json` entry is projected only when exactly one ACP deployment owns the matching `cli/<tool>` route. The compatibility file is not a launch authority.

To migrate, back up the document, retain deployment ids/config, add `version: 2`, explicit `models`, one default registration on the default deployment, and `defaultModel`; then reload extensions and inspect all four gates. Roll back by changing only `mode` to `backend-registry` or `legacy` and reloading. Keeping `models`, `defaultModel`, and `compatibility` provides round-trip preservation, not guaranteed valid re-entry: the strict v2 parser may still reject unsupported or unknown fields. Flow Settings can edit exact module-matched deployment config and preserves all v2/unknown sections, but intentionally provides no model registration editor.

Task-level `timeoutMs` is still not forwarded through either registry mode and no host watchdog replaces it. Configure a deployment timeout such as ACP `runTimeoutMs` when a bound is required. See [the backend adapter contract](../../docs/teammate-backend-adapter-contract.md) for the manifest, DSH example, topology matrix, migration, and rollback details.

## Agent Status Machine

Every agent carries one of six canonical statuses (`AgentStatus`). Two additional derived display statuses exist only for rendering and are never stored on an agent.

### Canonical statuses

| Status | Icon | Meaning |
|--------|------|---------|
| `pending` | □ | Queued, waiting for a concurrency slot or dependency resolution |
| `running` | ■ | Actively executing in a Pi subprocess |
| `retrying` | ↻ | A retryable failure occurred; the agent is waiting for the next retry attempt (live countdown shown in the widget) |
| `sleeping` | ◉ | Completed a turn and waiting for a follow-up message (resident agents only) |
| `completed` | ✓ | Finished successfully; the agent is being cleaned up |
| `failed` | ✗ | Terminated with an error. Failed agents are retained as tombstones for 2 minutes (`FAILED_AGENT_RETENTION_MS`) before removal, so callers can observe the failure |

### Derived display statuses

These are computed by `effectiveDisplayStatus()` for rendering only:

| Display status | Icon | Condition |
|----------------|------|-----------|
| `result-ready` | ◆ | A `running` agent whose final assistant turn has already been produced (`resultReadyAt` is set) but whose result has not yet been consumed by a waiter |
| `stalled` | ▲ | An active `pending`/`running` agent with no activity past its canonical deadline: 30 s for heartbeat-backed tool execution, and 5 min for queueing and expected-silence phases such as startup, model prompting, restore, continuation and compaction |

All other statuses display as themselves. Rendering surfaces must use `STATUS_PRESENTATION` / `DERIVED_STATUS_PRESENTATION` lookup tables rather than `status === "..."` chains.

## Circuit Breaker

Model calls are protected by a per-model circuit breaker with three states:

| State | Behavior |
|-------|----------|
| `CLOSED` | Normal operation; failures are counted |
| `OPEN` | The model is blocked after reaching the failure threshold (default: 3 consecutive failures); calls are rejected until the cooldown expires (default: 60 s) |
| `HALF_OPEN` | After cooldown, one trial call is allowed; success resets to `CLOSED`, failure re-opens the circuit |

The breaker prevents cascading failures when a model endpoint is down. Use `/model-failover status` (registered by `pi-maestro-flow`) to inspect live circuit state.

## Retry Resilience

Retryable network and provider errors trigger automatic retries with exponential backoff:

- **Max retries:** 12 attempts
- **Max delay:** 10 minutes (exponential backoff capped)
- **Retryable errors:** connection errors, timeouts, resets, rate limits, and transient provider failures
- **Non-retryable errors:** authentication failures, invalid requests, and other permanent errors

A **retry persistence guard** snapshots `settings.json` before child agents issue retry-related RPCs and restores the original value afterward, preventing session-local retry overrides from being persisted to disk. The agent widget shows a live `retry N/M in Xs` countdown during retry waits.

## Observe (status / wait / watch)

`observe` is the single observation interface over mixed teammate and background-bash targets:

```ts
// Blocking barrier: wait until every target completes its terminal lifecycle
observe({ action: "wait", targets: [{ kind: "bash_bg", id: "bg-1" }], until: "completed" })

// Persistent observation: poll every target, recording full progression until deadline
observe({ action: "watch", targets: [{ kind: "teammate", id: "reviewer" }], timeoutMs: 30000 })
```

- `action`: `status` (one-shot snapshot), `wait` (all/any/count barrier), `watch` (continuous progression).
- `until`: `"result-ready"` (default) or `"completed"` (terminal lifecycle).
- `wait` targets must provide a `name` or `waitMs` (schema-enforced).

## Mailbox Message Queue

A durable, per-workspace-isolated message queue backing cross-session delivery (staging → ready → claimed → accepted, atomic writes + idempotent receipts). Cold resume stays synchronous when the mailbox is authoritative; Windows file-lock renames retry automatically and orphaned state records are garbage-collected. External consumers (the Flow host) integrate through the `pi-maestro-teammate/v1/mailbox` subpath: the extension publishes a live `MailboxHostRegistry` on the shared-process bridge key `Symbol.for("pi-maestro-teammate.mailbox-registry")` (durable `enqueueTaskNotification`, per-recipient `pendingCount`, and `negotiate` capability v1/v2, with `taskId`-keyed dedup); `pi-maestro-flow` consumes it via `mailboxRegistry()` (see `packages/pi-maestro-flow/src/extension/index.ts`) and the contract is covered by `test/mailbox-registry.test.ts`.

## Runtime

- Foreground dispatch is the default and returns child results directly.
- Background dispatch returns an acknowledgement and later emits `teammate-complete`.
- Named agents can receive `steer`, `follow_up`, or `abort` messages through `teammate-send`.
- Resident agents sleep after a completed turn and can be resumed by follow-up messages.
- Nesting is capped at two layers and concurrent agents are globally bounded.
- Timed-out foreground runs are automatically moved to background rather than killed.
- Agent duration is tracked and displayed for completed/failed agents.
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

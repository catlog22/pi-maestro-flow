/**
 * TypeBox schemas for teammate tool parameters.
 *
 * Unified TaskSpec model:
 *   - Every public dispatch uses a non-empty tasks array
 *   - prompt is the task text; agent may inherit from the top level
 *   - Top-level fields serve as defaults, per-task overrides win
 *
 * P0 three-axis decoupling:
 *   - name: addressability + variable referencing
 *   - reply_to: result routing (caller | main)
 */

import { Type } from "typebox";
import { TEAMMATE_THINKING_INPUTS } from "../shared/thinking.ts";

const TaskType = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]*$",
  description: "Task phase driving automatic model routing; in experts mode it also selects the default expert agent when none is given. It never changes a chosen agent's behavior.",
});

const ThinkingLevel = StringEnum(
  [...TEAMMATE_THINKING_INPUTS],
  "Pi thinking depth; max is accepted as an alias for xhigh.",
);

function StringEnum<T extends string[]>(values: [...T], description?: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(description ? { description } : {}),
  });
}

function structuredOutputSchema(description: string) {
  // Keep the model-facing argument compact. The runtime performs the detailed
  // JSON Schema preflight and can return more actionable diagnostics.
  return Type.Unsafe<Record<string, unknown>>({
    type: "object",
    additionalProperties: true,
    description,
  });
}

// ---------------------------------------------------------------------------
// TaskSpec — unified task shape used by single and multi-task modes
// ---------------------------------------------------------------------------

export const TaskSpec = Type.Object({
  prompt: Type.String({
    minLength: 1,
    description:
      "Required task instruction. Use {name} to reference another task's output and {name.field} for structured fields.",
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Short human-readable purpose of this task; used as the display label in graph summaries when the task has no name.",
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description: 'Agent name to dispatch; defaults to the top-level agent, then "general"',
    }),
  ),
  taskType: Type.Optional(TaskType),
  name: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Task identifier, unique within this dispatch; enables references and teammate-send addressing",
    }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Explicit dependency task names. Merged with implicit {name} references. Use when ordering is needed without injecting the referenced task's output. Unknown names and self-references are rejected.",
    }),
  ),
  context: Type.Optional(
    Type.Unsafe<"fresh" | "fork">({
      type: "string",
      enum: ["fresh", "fork"],
      description:
        'Session context override for this task; overrides the top-level context default. "fork" copies the parent conversation per task — prefer per-task fork over a top-level default when only some tasks need history.',
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Exact provider/model override for this task; overrides the top-level model default",
    }),
  ),
  fallbackModels: Type.Optional(
    Type.Array(Type.String(), {
      description: "Ordered provider/model fallbacks for this task; overrides the top-level fallback chain",
    }),
  ),
  thinking: Type.Optional(ThinkingLevel),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this task" }),
  ),
  outputSchema: Type.Optional(
    structuredOutputSchema(
      "Optional JSON Schema for a machine-readable result. Use only when structured fields are required; this overrides the top-level default. The child must submit its final answer through the structured_output tool (validated against this schema; plain-text JSON is never accepted) — a run ending without a valid value fails. Validated results persist and are readable via agent://<publicationId>.",
    ),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Foreground wait window in milliseconds. If it elapses first, the dispatch moves to background and continues running; for graphs, the shortest task window applies only when top-level concurrencyWaitMs is omitted.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Not supported per task — background is a dispatch-level setting controlled by the top-level background flag (default: false). A per-task value is ignored with a warning; move it to the top level instead.",
    }),
  ),
  todo: Type.Optional(
    Type.Union([
      Type.String({ minLength: 1 }),
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    ], {
      description:
        "Optional Todo task id(s) bound to this agent, in priority order (first = highest). On start the host re-assigns each task's assignee to this agent (actor changes from root to the agent), auto-activates the first runnable one, and injects the whole list as a managed fragment; the agent drives its queue with `todo update`. The tasks must exist before dispatch — missing ids produce a warning and dispatch continues. Accepts `\"12\"`, `\"#12\"`, or an ordered array like `[\"#1\", \"#2\"]`.",
    }),
  ),
  maxNestingDepth: Type.Optional(
    Type.Integer({
      // Bound must match MAX_DEFAULT_DEPTH in runs/execution-infra.ts; the
      // runtime re-validates as a second line of defense.
      minimum: 0,
      maximum: 2,
      description:
        "Nesting budget override for the agent spawned by this task; overrides the top-level maxNestingDepth. 0 forbids nested teammate calls by that agent. Omit to inherit the top-level value (which itself defaults to the global ceiling). Only 0 and 1 are effective; 2 is capped to 1 by the global 2-level ceiling and anything above 2 is rejected.",
    }),
  ),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// TeammateParams — top-level tool parameters
// ---------------------------------------------------------------------------

export const TeammateParams = Type.Object({
  mode: Type.Optional(
    Type.Unsafe<"default" | "expert">({
      type: "string",
      enum: ["default", "expert"],
      default: "default",
      description:
        'Dispatch strategy. "default" executes the supplied tasks directly. "expert" requires exactly one objective task and runs it through the fixed workflow/planning Leader with maxNestingDepth=1; conflicting agent, taskType, or nesting overrides are rejected.',
    }),
  ),
  agent: Type.Optional(
    Type.String({
      description: 'Default agent for tasks that omit agent; defaults to "general"',
    }),
  ),
  taskType: Type.Optional(TaskType),

  // === P0 Result Routing ===

  reply_to: Type.Optional(
    Type.Unsafe<"caller" | "main">({
      type: "string",
      enum: ["caller", "main"],
      description:
        'Result routing (default: "caller"). "caller" returns the result to the dispatching context; "main" routes it to the main session.',
    }),
  ),

  // === Tasks ===

  tasks: Type.Array(TaskSpec, {
    minItems: 1,
    description:
      'Tasks to execute. Default mode runs the graph directly. Expert mode requires exactly one objective task; the fixed workflow Leader decomposes it into a nested dependency-aware graph.',
  }),

  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Max concurrent tasks (default: 4)",
    }),
  ),

  concurrencyWaitMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Dedicated foreground wait window for multi-task parallel/DAG dispatches. When omitted, graph calls retain the legacy smallest-task timeoutMs/default behavior. Expiry detaches the graph to background and never cancels queued or running tasks.",
    }),
  ),

  maxAgents: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Maximum number of tasks allowed in a single dispatch (default: 15). Override globally via PI_TEAMMATE_MAX_AGENTS. A separate runtime budget caps live agents across the whole dispatch tree (default 32, configurable via PI_TEAMMATE_MAX_ACTIVE_AGENTS).",
    }),
  ),

  maxNestingDepth: Type.Optional(
    Type.Integer({
      // Bound must match MAX_DEFAULT_DEPTH in runs/execution-infra.ts; the
      // runtime re-validates as a second line of defense.
      minimum: 0,
      maximum: 2,
      description:
        "How many levels of nested teammate dispatch the agents spawned by this call may perform below themselves. Default when omitted: the global ceiling. Per-task maxNestingDepth overrides this per task; otherwise every task inherits this value. Evaluated at the dispatch: 0 forbids nested calls entirely (the assigned agents cannot dispatch teammates). The only effective values are 0 and 1 — 2 is capped to 1 by the global 2-level ceiling and anything above 2 is rejected, so deeper nesting is unreachable. Inside a spawned agent this parameter can only tighten the parent's budget — it can never extend depth beyond what the parent allowed; under the current ceiling the parent budget already forbids grandchildren, so passing 0 here is at most an explicit no-further-nesting marker.",
    }),
  ),

  // === Structured Output (default for tasks without their own) ===

  outputSchema: Type.Optional(
    structuredOutputSchema(
      "Advanced optional default JSON Schema for machine-readable results. Omit for ordinary tasks; a task-level outputSchema overrides this default.",
    ),
  ),

  // === Execution Control (applies to all modes) ===

  background: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Run in background (default: false). The foreground wait window is always bounded — multi-task calls use concurrencyWaitMs when provided, otherwise the smallest per-task timeoutMs or a 600000 ms (10 minutes) default. A call that outlives the window returns a background acknowledgement while the teammate continues, then delivers the result via one automatic teammate-complete notification. Explicit background calls acknowledge immediately and send that notification later. The completion is delivered automatically to the caller: for a root dispatch it arrives as a new turn in the root session; for a nested dispatch the work executes in the root process and the root forwards the same envelope over IPC, so it also arrives as a new turn in the dispatching child agent's session while that agent is still live (the root caller additionally receives it). If the dispatching agent has already ended, delivery is skipped and the result is settled and only inspectable via observe.",
    }),
  ),

  context: Type.Optional(
    Type.Unsafe<"fresh" | "fork">({
      type: "string",
      enum: ["fresh", "fork"],
      description:
        'Session context mode. "fresh" (default) starts a blank conversation. "fork" inherits the current session\'s full conversation history — the child sees everything that happened before the fork and continues independently. In multi-task mode this is the default for every task (per-task context wins); forking N tasks copies the parent conversation N times.',
    }),
  ),

  model: Type.Optional(
    Type.String({
      description:
        "Exact provider/model default from the injected available model catalog. Per-task model takes precedence.",
    }),
  ),
  fallbackModels: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Ordered provider/model fallback chain. Per-task fallbackModels takes precedence.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevel),

  cwd: Type.Optional(
    Type.String({
      description:
        "Default working directory. Per-task cwd takes precedence.",
    }),
  ),

  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Default foreground detach window in milliseconds for this dispatch (600000 ms / 10 minutes when omitted). Per-task timeoutMs takes precedence for single-task calls and remains the graph fallback when concurrencyWaitMs is omitted. Expiry moves the dispatch to background without terminating its agents. This is NOT the observation-wait limit — observe/wait/monitor use their own timeoutMs semantics.",
    }),
  ),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Other tool schemas (unchanged)
// ---------------------------------------------------------------------------

export const TeammateSendParams = Type.Object({
  to: Type.String({
    description:
      "Target agent or peer session — name, @name, displayed name#id-prefix, correlation ID (or prefix), owner:<ownerId> for a window, or owner:<ownerId>:<correlationId> for a remote agent",
  }),
  message: Type.Optional(
    Type.String({
      description:
        'Message content. Required for "steer" and "follow_up" (the default mode); optional only for "abort".',
    }),
  ),
  mode: Type.Optional(
    Type.Unsafe<"steer" | "follow_up" | "abort">({
      type: "string",
      enum: ["steer", "follow_up", "abort"],
      default: "follow_up",
      description:
        'Delivery mode. "steer" interrupts the current turn; if the interruption is not acknowledged promptly it degrades to a queued follow_up instead of failing the agent. "follow_up" queues after the current turn. "abort" terminates the agent. For cross-session delivery, queued or accepted means persisted/enqueued but not necessarily consumed by the target model; do not resend without new evidence.',
    }),
  ),
  kind: Type.Optional(
    Type.Unsafe<"coordination" | "request" | "status" | "supervision">({
      type: "string",
      enum: ["coordination", "request", "status", "supervision"],
      default: "coordination",
      description:
        'Cross-session message semantics. "coordination" adds execution constraints without changing the user objective; "request" asks the peer to evaluate work without granting human authorization; "status" is informational and is always queued; "supervision" carries safety or lifecycle constraints. Local agent delivery preserves its existing direct-message behavior.',
    }),
  ),
}, {
  additionalProperties: false,
  // message is required unless the mode is explicitly "abort". The guard uses
  // required:["mode"] so a missing mode (default follow_up) still demands a
  // message; the runtime enforces the same contract as a second line.
  if: { not: { required: ["mode"], properties: { mode: { const: "abort" } } } },
  then: { required: ["message"] },
});

export const TeammateListParams = Type.Object({
  view: Type.Optional(
    Type.Unsafe<"active" | "named" | "all" | "roles" | "windows" | "inbox">({
      type: "string",
      enum: ["active", "named", "all", "roles", "windows", "inbox"],
      default: "active",
      description: 'View to return: "active" live agents except completed entries, "named" addressable agents, "all" tracked live entries, "roles" role definitions, "windows" available cross-session windows, or "inbox" persisted cross-window messages.',
    }),
  ),
  session: Type.Optional(Type.String({
    minLength: 1,
    description: 'Inbox-only session id/name/prefix. Omit to aggregate recent workspace sessions; use "current" for the active session.',
  })),
  peer: Type.Optional(Type.String({
    minLength: 1,
    description: "Inbox-only peer owner id or owner:<ownerId> target filter.",
  })),
  direction: Type.Optional(Type.Unsafe<"incoming" | "outgoing">({
    type: "string",
    enum: ["incoming", "outgoing"],
    description: "Inbox-only message direction filter.",
  })),
  status: Type.Optional(Type.Unsafe<"pending" | "queued" | "injected" | "accepted" | "rejected" | "timeout">({
    type: "string",
    enum: ["pending", "queued", "injected", "accepted", "rejected", "timeout"],
    description: "Inbox-only persisted delivery status filter. Queued or accepted records confirm persistence/enqueueing, not target-model consumption.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    default: 20,
    description: "Inbox-only maximum number of newest messages (default: 20).",
  })),
}, {
  additionalProperties: false,
  allOf: ["session", "peer", "direction", "status", "limit"].map((field) => ({
    if: { required: [field] },
    then: { properties: { view: { const: "inbox" } }, required: ["view"] },
  })),
});

export const TeammateWatchParams = Type.Object({
  name: Type.String({
    description: "Agent name, @name, displayed name#id-prefix, or correlation ID/prefix from teammate-list",
  }),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 20,
      description: "Number of recent output lines to return (default: 20)",
    }),
  ),
}, { additionalProperties: false });

export const TeammateWaitParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description: "Agent selector to wait for. Omit only when waitMs is provided",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 10 * 60_000,
      description: "Maximum named-wait time in milliseconds (default: 600000, 10 minutes)",
    }),
  ),
  waitMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Fixed delay in milliseconds when name is omitted; ignored when name is provided",
    }),
  ),
}, {
  additionalProperties: false,
  // Enforce the execution contract: at least one of name (agent wait) or
  // waitMs (fixed delay) must be provided. The runtime rejects requests with
  // neither ("Provide an agent name or waitMs.").
  anyOf: [
    { required: ["name"] },
    { required: ["waitMs"] },
  ],
  description: "Provide name for an agent wait or waitMs for a fixed delay.",
});

// ---------------------------------------------------------------------------
// Observe — mixed multi-target observation and barrier wait
// ---------------------------------------------------------------------------

export const ObserveParams = Type.Object({
  action: Type.Unsafe<"status" | "wait" | "watch">({
    type: "string",
    enum: ["status", "wait", "watch"],
    description:
      '"status" takes a one-shot snapshot; "wait" blocks on a multi-target barrier; "watch" polls until timeoutMs and returns the full status-transition timeline.',
  }),
  targets: Type.Array(
    Type.Object({
      kind: Type.String({ minLength: 1, description: 'Observation provider kind, such as "teammate" or "bash_bg".' }),
      id: Type.String({ minLength: 1, description: "Provider-specific target name or id." }),
    }, { additionalProperties: false }),
    { minItems: 1, maxItems: 15, description: "Mixed targets to observe in the requested order." },
  ),
  detail: Type.Optional(Type.Unsafe<"summary" | "tail" | "full">({
    type: "string",
    enum: ["summary", "tail", "full"],
    default: "summary",
    description: 'Observation detail level. "tail" is a compatibility alias for "full".',
  })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 20, description: "Recent detail lines per target." })),
  waitMode: Type.Optional(Type.Unsafe<"all" | "any" | "count">({
    type: "string",
    enum: ["all", "any", "count"],
    default: "all",
    description: "Barrier mode for wait only.",
  })),
  waitCount: Type.Optional(Type.Integer({ minimum: 1, description: "Number of targets required when waitMode is count." })),
  until: Type.Optional(Type.Unsafe<"result-ready" | "completed">({
    type: "string",
    enum: ["result-ready", "completed"],
    default: "result-ready",
    description:
      "Wait-only completion threshold: first result (default) or full terminal completion.",
  })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, default: 600_000, description: "Request-level wait/watch timeout in milliseconds (default: 600000, 10 minutes)." })),
  view: Type.Optional(Type.Unsafe<"live" | "turns">({
    type: "string",
    enum: ["live", "turns"],
    default: "live",
    description:
      '"live" shows the current snapshot (default); "turns" lists the session turn history instead (status action only).',
  })),
  turn: Type.Optional(Type.Integer({
    minimum: 1,
    description: '1-based turn index to expand when view="turns"; omitted lists all turns.',
  })),
}, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { action: { const: "status" } }, required: ["action"] },
      then: { not: { anyOf: [
        { required: ["waitMode"] },
        { required: ["waitCount"] },
        { required: ["until"] },
        { required: ["timeoutMs"] },
      ] } },
    },
    {
      if: { properties: { action: { const: "watch" } }, required: ["action"] },
      then: { not: { anyOf: [
        { required: ["waitMode"] },
        { required: ["waitCount"] },
        { required: ["until"] },
      ] } },
    },
    {
      if: {
        properties: { action: { const: "wait" }, waitMode: { const: "count" } },
        required: ["action", "waitMode"],
      },
      then: { required: ["waitCount"] },
    },
    {
      if: { properties: { view: { const: "turns" } }, required: ["view"] },
      then: { properties: { action: { const: "status" } }, required: ["action"] },
    },
    {
      if: { required: ["turn"] },
      then: { properties: { view: { const: "turns" } }, required: ["view"] },
    },
    {
      if: { required: ["waitCount"] },
      then: {
        properties: { action: { const: "wait" }, waitMode: { const: "count" } },
        required: ["action", "waitMode"],
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Monitor — teammate-compatible multi-agent observation and barrier wait
// ---------------------------------------------------------------------------

export const TeammateMonitorParams = Type.Object({
  action: Type.Unsafe<"status" | "wait">({
    type: "string",
    enum: ["status", "wait"],
    description:
      'Operation: "status" one-shot multi-target snapshot (non-blocking); "wait" block until barrier condition is met. Monitor mode is user-controlled via /monitor; this tool only queries and waits.',
  }),
  targets: Type.Array(
    Type.String({ minLength: 1 }),
    {
      minItems: 1,
      maxItems: 15,
      description:
        "Agent names, @name, name#id-prefix, or correlation ID prefixes to monitor.",
    },
  ),
  waitMode: Type.Optional(
    Type.Unsafe<"all" | "any" | "count">({
      type: "string",
      enum: ["all", "any", "count"],
      default: "all",
      description:
        'Barrier mode (wait action): "all" wait for every target, "any" wait for the first, "count" wait for k targets.',
    }),
  ),
  waitCount: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Number of targets to wait for when waitMode is 'count'.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 600_000,
      description: "Maximum wait time in milliseconds for the wait action (default: 600000, 10 minutes).",
    }),
  ),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      default: 3,
      description: "Recent output lines per target (default: 3).",
    }),
  ),
  verbose: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Include expanded output per target (default: false).",
    }),
  ),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Workspace window — Monitor-owned worker lifecycle
// ---------------------------------------------------------------------------

export const WorkspaceWindowParams = Type.Object({
  action: Type.Unsafe<"create" | "list" | "close">({
    type: "string",
    enum: ["create", "list", "close"],
    description: "Create, list, or close worker windows owned by the active Monitor session.",
  }),
  name: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    description: "Stable worker-window name. Required for create and close.",
  })),
  objective: Type.Optional(Type.String({
    minLength: 1,
    description: "Task objective passed to the new Pi worker. Required for create.",
  })),
  presentation: Type.Optional(Type.Unsafe<"interactive" | "headless">({
    type: "string",
    enum: ["interactive", "headless"],
    default: "interactive",
    description: "Open a visible interactive terminal by default; use headless only when no terminal UI is needed.",
  })),
}, {
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { action: { const: "create" } }, required: ["action"] },
      then: { required: ["name", "objective"] },
    },
    {
      if: { properties: { action: { const: "close" } }, required: ["action"] },
      then: { required: ["name"] },
    },
    {
      if: { required: ["objective"] },
      then: { properties: { action: { const: "create" } }, required: ["action"] },
    },
    {
      if: { required: ["presentation"] },
      then: { properties: { action: { const: "create" } }, required: ["action"] },
    },
  ],
});

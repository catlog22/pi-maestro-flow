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
});

const ThinkingLevel = StringEnum([...TEAMMATE_THINKING_INPUTS]);

function StringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
  });
}

// ---------------------------------------------------------------------------
// TaskSpec — unified task shape used by single and multi-task modes
// ---------------------------------------------------------------------------

export const TaskSpec = Type.Object({
  prompt: Type.String({
    minLength: 1,
    description:
      "Required non-empty task text. Use {name} to reference another task's output, {name.field} for structured output fields.",
  }),
  agent: Type.Optional(
    Type.String({
      description: 'Agent name to dispatch; defaults to the top-level agent, then "general"',
    }),
  ),
  taskType: Type.Optional(
    Type.Unsafe({
      ...TaskType,
      description:
        "Task phase used only for automatic model routing (task model > top-level model > taskType routing). Does not change the agent's behavior — that is defined by the agent role.",
    }),
  ),
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
        "Explicit dependency task names. Merged with implicit {name} references. Use when ordering is needed without injecting the referenced task's output. Unknown names are rejected.",
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
  thinking: Type.Optional(
    Type.Unsafe({
      ...ThinkingLevel,
      description: "Pi thinking depth override for this task; max is accepted as an alias for xhigh",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this task" }),
  ),
  outputSchema: Type.Optional(
    Type.Unsafe({
      type: "object",
      additionalProperties: true,
      description:
        "JSON Schema for structured output. Output becomes accessible as {name.field} in dependent tasks.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Foreground wait window in milliseconds. If it elapses first, the dispatch moves to background and continues running; for graphs, the shortest task window applies to the whole dispatch.",
    }),
  ),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// TeammateParams — top-level tool parameters
// ---------------------------------------------------------------------------

export const TeammateParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: 'Default agent for tasks that omit agent; defaults to "general"',
    }),
  ),
  taskType: Type.Optional(
    Type.Unsafe({
      ...TaskType,
      description:
        "Default task phase for automatic model routing; per-task taskType takes precedence. Routing only — does not change agent behavior.",
    }),
  ),

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
      "Tasks to execute. Dependencies come from {name}/{name.field} references in prompts plus explicit dependsOn lists; dependent tasks are awaited and independent tasks run in parallel.",
  }),

  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Max concurrent tasks (default: 4)",
    }),
  ),

  maxAgents: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Maximum number of tasks allowed in a single dispatch (default: 15). Override globally via PI_TEAMMATE_MAX_AGENTS.",
    }),
  ),

  // === Structured Output (default for tasks without their own) ===

  outputSchema: Type.Optional(
    Type.Unsafe({
      type: "object",
      additionalProperties: true,
      description:
        "JSON Schema for structured output validation. Serves as the default for every task without its own outputSchema.",
    }),
  ),

  // === Execution Control (applies to all modes) ===

  background: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Run in background (default: false). Foreground calls return the result directly when it is ready; if timeoutMs elapses first, they return a background acknowledgement while the teammate continues. Explicit background calls acknowledge immediately and send one automatic teammate-complete notification later.",
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
  thinking: Type.Optional(
    Type.Unsafe({
      ...ThinkingLevel,
      description:
        "Default Pi thinking depth. Precedence: task thinking, top-level thinking, taskType routing, agent frontmatter, then Pi default. max aliases xhigh.",
    }),
  ),

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
        "Default foreground wait window in milliseconds. Per-task timeoutMs takes precedence; when the effective window elapses, the dispatch moves to background without terminating its agents.",
    }),
  ),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Other tool schemas (unchanged)
// ---------------------------------------------------------------------------

export const TeammateSendParams = Type.Object({
  to: Type.String({
    description:
      "Target agent — name, @name, displayed name#id-prefix, correlation ID, or unique ID prefix from teammate-list",
  }),
  message: Type.Optional(
    Type.String({
      description:
        'Message content. Required for "steer" and "follow_up"; optional for "abort".',
    }),
  ),
  mode: Type.Optional(
    Type.Unsafe<"steer" | "follow_up" | "abort">({
      type: "string",
      enum: ["steer", "follow_up", "abort"],
      default: "follow_up",
      description:
        'Delivery mode. "steer" interrupts the current turn, "follow_up" queues after it, "abort" terminates the agent.',
    }),
  ),
}, { additionalProperties: false });

export const TeammateListParams = Type.Object({
  view: Type.Optional(
    Type.Unsafe<"active" | "named" | "all" | "roles">({
      type: "string",
      enum: ["active", "named", "all", "roles"],
      default: "active",
      description: 'View to return: "active" live agents except completed entries, "named" addressable agents, "all" tracked live entries, or "roles" available role definitions.',
    }),
  ),
}, { additionalProperties: false });

export const TeammateWatchParams = Type.Object({
  name: Type.String({
    description: "Agent name, @name, displayed name#id-prefix, or correlation ID/prefix from teammate-list",
  }),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
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
      description: "Maximum named-wait time in milliseconds (default: 600000)",
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
  description: "Provide name for an agent wait or waitMs for a fixed delay.",
});

// ---------------------------------------------------------------------------
// Monitor — multi-agent observation and barrier wait
// ---------------------------------------------------------------------------

export const TeammateMonitorParams = Type.Object({
  action: Type.Unsafe<"status" | "wait">({
    type: "string",
    enum: ["status", "wait"],
    description:
      'Operation: "status" one-shot multi-target snapshot (non-blocking); "wait" block until barrier condition is met. Monitor mode is entered/exited by the user via /monitor command.',
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
      description: "Maximum wait time in milliseconds for the wait action (default: 600000).",
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
      description: "Include full watch output per target (default: false).",
    }),
  ),
}, { additionalProperties: false });

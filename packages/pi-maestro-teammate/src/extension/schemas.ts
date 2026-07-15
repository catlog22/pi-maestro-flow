/**
 * TypeBox schemas for teammate tool parameters.
 *
 * Unified TaskSpec model:
 *   - Single agent: { agent, task }
 *   - Multi-task: { tasks: TaskSpec[] } with {name} variable references defining execution order
 *   - Top-level fields serve as defaults, per-task overrides win
 *
 * P0 three-axis decoupling:
 *   - name: addressability + variable referencing
 *   - reply_to: result routing (caller | main)
 */

import { Type } from "typebox";
import { TEAMMATE_THINKING_INPUTS } from "../shared/thinking.ts";

const TaskType = StringEnum([
  "explore",
  "analysis",
  "debug",
  "planning",
  "development",
  "review",
  "testing",
]);

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
  agent: Type.String({
    description: "Agent name to dispatch (matches agents/*.md filename)",
  }),
  task: Type.Optional(
    Type.String({
      description:
        "Task description. Use {name} to reference another task's output, {name.field} for structured output fields.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Fixed prompt template name from project, user, or bundled teammate prompts",
    }),
  ),
  promptArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Additional positional prompt arguments. task is $1; promptArgs begin at $2",
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
      description:
        "Task identifier — enables referencing via {name} in other tasks and addressing via teammate-send",
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
      description: "Timeout in milliseconds for this task",
    }),
  ),
});

// ---------------------------------------------------------------------------
// TeammateParams — top-level tool parameters
// ---------------------------------------------------------------------------

export const TeammateParams = Type.Object({
  // === Single Agent Sugar (top-level is itself a TaskSpec) ===

  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to dispatch. Required for single mode, optional when using tasks.",
    }),
  ),

  task: Type.Optional(
    Type.String({
      description:
        "Task description. Supports {name} variable references in multi-task mode.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Default fixed prompt template name. Per-task prompt takes precedence",
    }),
  ),
  promptArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Default additional positional prompt arguments. Per-task promptArgs take precedence",
    }),
  ),
  taskType: Type.Optional(
    Type.Unsafe({
      ...TaskType,
      description:
        "Default task phase for automatic model routing; per-task taskType takes precedence. Routing only — does not change agent behavior.",
    }),
  ),

  // === P0 Three-Axis Fields ===

  name: Type.Optional(
    Type.String({
      description:
        "Addressable name — enables variable referencing via {name} and cross-agent routing via teammate-send",
    }),
  ),

  reply_to: Type.Optional(
    Type.Unsafe<"caller" | "main">({
      type: "string",
      enum: ["caller", "main"],
      description:
        'Result routing (default: "caller"). "caller" returns the result to the dispatching context; "main" routes it to the main session.',
    }),
  ),

  // === Multi-Task ===

  tasks: Type.Optional(
    Type.Array(TaskSpec, {
      description:
        "Multiple tasks to execute. Dependencies come from {name}/{name.field} references in task descriptions plus explicit dependsOn lists — dependent tasks are awaited; independent tasks run in parallel. A {ref} that matches no task name is passed through as literal text (misspellings close to an existing name are rejected).",
    }),
  ),

  chain: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String(),
        task: Type.Optional(
          Type.String({
            description: "Task template with {previous} variable",
          }),
        ),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(ThinkingLevel),
        taskType: Type.Optional(TaskType),
        prompt: Type.Optional(Type.String()),
        promptArgs: Type.Optional(Type.Array(Type.String())),
      }),
      {
        description:
          "[Deprecated] Use tasks with {name} references instead. Sequential pipeline where each step receives {previous} result.",
      },
    ),
  ),

  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Max concurrent tasks (default: 4)",
    }),
  ),

  // === Structured Output (default for tasks without their own) ===

  outputSchema: Type.Optional(
    Type.Unsafe({
      type: "object",
      additionalProperties: true,
      description:
        "JSON Schema for structured output validation. In multi-task mode, serves as default for tasks without their own outputSchema.",
    }),
  ),

  // === Execution Control (applies to all modes) ===

  background: Type.Optional(
    Type.Boolean({
      default: true,
      description:
        "Run in background (default: true). Set false to block until completion.",
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
  thinking: Type.Optional(
    Type.Unsafe({
      ...ThinkingLevel,
      description: "Default Pi thinking depth. Per-task thinking takes precedence; max aliases xhigh.",
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
        "Default timeout in milliseconds. Per-task timeoutMs takes precedence.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Other tool schemas (unchanged)
// ---------------------------------------------------------------------------

export const TeammateSendParams = Type.Object({
  to: Type.String({
    description:
      "Target agent — a name, a correlation ID, or a unique correlation ID prefix (from teammate-list)",
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
      description:
        'Delivery mode (default: "follow_up"). "steer" interrupts the current turn, "follow_up" queues after it, "abort" terminates the agent.',
    }),
  ),
});

export const TeammateListParams = Type.Object({
  view: Type.Optional(
    StringEnum(["active", "named", "all", "roles"]),
  ),
});

export const TeammateWatchParams = Type.Object({
  name: Type.String({
    description: "Agent name or correlation ID/prefix from teammate-list",
  }),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Number of recent output lines to return (default: 20)",
    }),
  ),
});

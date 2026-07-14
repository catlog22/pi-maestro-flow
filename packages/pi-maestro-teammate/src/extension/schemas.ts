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
import { TEAMMATE_THINKING_LEVELS } from "../shared/thinking.ts";

const TaskType = StringEnum([
  "explore",
  "analysis",
  "debug",
  "planning",
  "development",
  "review",
  "testing",
]);

const ThinkingLevel = StringEnum([...TEAMMATE_THINKING_LEVELS]);

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
      description: "Optional task phase used for automatic model mapping",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Task identifier — enables referencing via {name} in other tasks and addressing via teammate-send",
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
      description: "Pi thinking depth override for this task; overrides the top-level thinking default",
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
      description: "Default task phase for automatic model mapping. Per-task taskType takes precedence",
    }),
  ),

  // === P0 Three-Axis Fields ===

  name: Type.Optional(
    Type.String({
      description:
        "Addressable name — enables variable referencing via {name} and cross-agent routing via teammate-send",
    }),
  ),

  reply_to: Type.Optional(StringEnum(["caller", "main"])),

  protocol_version: Type.Optional(
    Type.Integer({
      default: 2,
      description:
        "Protocol version for backward compatibility (v2 defaults reply_to=caller)",
    }),
  ),

  // === Multi-Task ===

  tasks: Type.Optional(
    Type.Array(TaskSpec, {
      description:
        "Multiple tasks to execute. Use {name} references in task descriptions to define dependencies — referenced tasks are awaited; unreferenced tasks run in parallel.",
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
        'Session context mode. "fresh" (default) starts a blank conversation. "fork" inherits the current session\'s full conversation history — the child sees everything that happened before the fork and continues independently.',
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
      description: "Default Pi thinking depth. Per-task thinking takes precedence.",
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
    description: "Target agent name (must be a named, running agent)",
  }),
  message: Type.String({
    description: "Message content to send to the agent",
  }),
  mode: Type.Optional(
    StringEnum(["steer", "follow_up", "abort"]),
  ),
});

export const TeammateListParams = Type.Object({
  view: Type.Optional(
    StringEnum(["active", "named", "all"]),
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

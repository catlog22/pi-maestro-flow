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
  name: Type.Optional(
    Type.String({
      description:
        "Task identifier — enables referencing via {name} in other tasks and addressing via teammate-send",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Override model for this task" }),
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

  context: Type.Optional(StringEnum(["fresh", "fork"])),

  model: Type.Optional(
    Type.String({
      description:
        "Default model override. Per-task model takes precedence.",
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
    description: "Name of the agent to watch",
  }),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Number of recent output lines to return (default: 20)",
    }),
  ),
});

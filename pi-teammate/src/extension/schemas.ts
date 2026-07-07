/**
 * TypeBox schemas for teammate tool parameters.
 *
 * P0 three-axis decoupling:
 *   - name: addressability (optional agent name for routing)
 *   - reply_to: result routing (caller | main)
 *
 * Plus protocol_version gate and correlation_id (runtime-generated).
 */

import { Type } from "typebox";

function StringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
  });
}

export const TeammateParams = Type.Object({
  // Required: agent definition to use
  agent: Type.String({
    description: "Agent name to dispatch (matches agents/*.md filename)",
  }),

  // Required: task description for the agent
  task: Type.Optional(
    Type.String({
      description:
        "Task description for the agent (optional for self-contained agents)",
    }),
  ),

  // === P0 Three-Axis Fields ===

  // Axis 1: Addressability
  name: Type.Optional(
    Type.String({
      description:
        "Optional addressable name for the teammate instance (enables cross-agent routing)",
    }),
  ),

  // Axis 2: Result Routing
  reply_to: Type.Optional(
    StringEnum(["caller", "main"]),
  ),

  // === Protocol & Correlation ===

  // Protocol version gate — v2 defaults reply_to=caller; v1 defaults reply_to=main for named agents
  protocol_version: Type.Optional(
    Type.Integer({
      default: 2,
      description:
        "Protocol version for backward compatibility (v2 defaults reply_to=caller)",
    }),
  ),

  // correlation_id is auto-generated at runtime, not user-provided

  // === Multi-Agent Modes ===

  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String(),
        task: Type.String(),
        model: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
      }),
      { description: "PARALLEL mode: run multiple agents concurrently" },
    ),
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
      { description: "CHAIN mode: sequential pipeline, each step gets {previous} result" },
    ),
  ),

  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Max concurrent parallel tasks (default: 4)",
    }),
  ),

  // === Structured Output ===

  outputSchema: Type.Optional(
    Type.Unsafe({
      type: "object",
      additionalProperties: true,
      description: "JSON Schema for structured output validation",
    }),
  ),

  // === Execution Control ===

  mode: Type.Optional(
    StringEnum(["await", "detach"]),
  ),

  context: Type.Optional(
    StringEnum(["fresh", "fork"]),
  ),

  model: Type.Optional(
    Type.String({
      description: "Override model for this teammate run",
    }),
  ),

  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the teammate subprocess",
    }),
  ),

  async: Type.Optional(
    Type.Boolean({
      description: "Run in background (default: false)",
    }),
  ),

  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Timeout in milliseconds for the teammate run",
    }),
  ),
});

export const TeammateSendParams = Type.Object({
  to: Type.String({
    description: "Target agent name (must be a named, running agent)",
  }),
  message: Type.String({
    description: "Message content to send to the agent",
  }),
  kind: Type.Optional(
    StringEnum(["notification", "task"]),
  ),
});

export const TeammateListParams = Type.Object({
  view: Type.Optional(
    StringEnum(["active", "named", "all"]),
  ),
});

export const TeammateAttachParams = Type.Object({
  name: Type.String({
    description: "Name of the running agent to attach to (view its real-time activity)",
  }),
});

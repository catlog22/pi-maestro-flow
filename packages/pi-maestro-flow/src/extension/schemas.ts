/**
 * TypeBox schemas for the maestro tool with action-based dispatch.
 *
 * Main tool: maestro (action: explore | delegate | moa)
 * Auxiliary tools: maestro-wait, maestro-status
 */

import { Type } from "typebox";

function StringEnum<T extends string[]>(values: [...T]) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
  });
}

export const MaestroParams = Type.Object({
  // === Action Dispatch ===
  action: StringEnum(["explore", "delegate", "moa"]),

  // === Explore Action Fields ===
  prompts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Search prompts for explore action (each prompt = one parallel agent)",
    }),
  ),
  endpoint: Type.Optional(
    Type.String({
      description: "Specific model/endpoint for explore agents",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description: "Fan out each prompt to all registered endpoints",
    }),
  ),
  maxTurns: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum agent turns per exploration job",
    }),
  ),
  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum concurrent explore agents (default: 4)",
    }),
  ),

  // === Delegate Action Fields ===
  prompt: Type.Optional(
    Type.String({
      description: "Task prompt for delegate action",
    }),
  ),
  tool: Type.Optional(
    Type.String({
      description:
        "Target tool/provider for delegate (e.g., 'gemini', 'claude', 'codex')",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["analysis", "write"]),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model override for delegate or explore",
    }),
  ),
  rule: Type.Optional(
    Type.String({
      description: "Protocol + prompt template for delegate",
    }),
  ),

  // === MOA Action Fields ===
  preset: Type.Optional(
    Type.String({
      description: "MOA preset configuration name",
    }),
  ),

  // === Common Fields ===
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the operation",
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
      description: "Timeout in milliseconds",
    }),
  ),
});

export const MaestroWaitParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Specific run ID to wait for (omit to wait for any)",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description: "Wait for all active runs (default: wait for first)",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Timeout in milliseconds (default: 1800000 / 30 min)",
    }),
  ),
});

export const MaestroStatusParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description: "Specific run ID to inspect",
    }),
  ),
  view: Type.Optional(
    StringEnum(["fleet", "transcript"]),
  ),
});

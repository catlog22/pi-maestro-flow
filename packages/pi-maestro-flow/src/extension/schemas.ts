/**
 * TypeBox schemas for all maestro tools.
 *
 * Main tool: maestro (action: explore | delegate | moa)
 * Auxiliary tools: goal, ask-user-question, todo
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
  name: Type.Optional(
    Type.String({
      description: "Stable delegate task name for nested tracing and follow-up",
    }),
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
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Timeout in milliseconds",
    }),
  ),
});

// === Goal Tool Schema ===

// Keep the function schema rooted at an object. Some OpenAI-compatible
// providers reject a root-level anyOf even when every union variant is an
// object. Action-specific requirements are enforced by executeGoal().
export const GoalToolParams = Type.Object({
  action: StringEnum(["get", "create", "update"]),
  objective: Type.Optional(
    Type.String({ description: "Goal objective; required when action is 'create' or 'update'" }),
  ),
  tokenBudget: Type.Optional(
    Type.String({ description: "Optional explicit Token budget; omit for no budget. Accepts plain, k, or m values, e.g. '100000', '100k', or '1.5m'; create only" }),
  ),
  planHandoffKey: Type.Optional(
    Type.String({ description: "Internal approved-Plan handoff binding; injected by the Plan gate" }),
  ),
}, { additionalProperties: false });

// === Ask User Question Schema ===

const QuestionOptionSchema = Type.Object({
  label: Type.String({ description: "Option display text" }),
  description: Type.Optional(
    Type.String({ description: "Explanation of this option" }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: "The question text" }),
  header: Type.Optional(
    Type.String({ description: "Short chip/tag label (max 16 chars)" }),
  ),
  options: Type.Optional(
    Type.Array(QuestionOptionSchema, {
      minItems: 2,
      maxItems: 4,
      description: "Multiple-choice options (2-4)",
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow multiple selections (default: false); every option question also accepts additional details" }),
  ),
});

export const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: "1-4 questions collected through the keyboard-first TUI wizard",
  }),
});

// === Todo Tool Schema ===

const TodoSkillBindingSchema = Type.Object({
  name: Type.String({
    minLength: 1,
    description: "Pi skill name resolved by the native skill loader during next",
  }),
  role: StringEnum(["primary", "guard", "support"]),
  args: Type.Optional(
    Type.String({ description: "Task-level skill arguments; override matching skill-config defaults" }),
  ),
});

const TodoFilterSchema = Type.Object({
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"]),
  ),
  memberId: Type.Optional(
    Type.String({ description: "Return tasks created by or assigned to this root/teammate member id" }),
  ),
});

export const TodoToolParams = Type.Object({
  action: StringEnum([
    "create",
    "update",
    "list",
    "get",
    "delete",
    "clear",
    "next",
  ]),

  subject: Type.Optional(
    Type.String({ description: "Task title (required for create)" }),
  ),
  description: Type.Optional(
    Type.String({ description: "Long-form task detail" }),
  ),
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"]),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), { description: "Task IDs this depends on" }),
  ),
  context: Type.Optional(
    Type.String({ description: "Plain-text execution context. On update, an empty string clears the stored context" }),
  ),
  skills: Type.Optional(
    Type.Union([Type.Array(TodoSkillBindingSchema), Type.Null()], {
      description: "Ordered Pi skill bindings. On update, an empty array or null clears the stored skills",
    }),
  ),
  summary: Type.Optional(
    Type.String({ description: "Short completion summary carried into later todo steps" }),
  ),
  assignee: Type.Optional(
    Type.String({ description: "Assignee selector: self, root, a known teammate id, or an unambiguous teammate label" }),
  ),

  id: Type.Optional(
    Type.String({ description: "Task ID (required for get/update/delete)" }),
  ),
  filter: Type.Optional(TodoFilterSchema),
  planHandoffKey: Type.Optional(
    Type.String({ description: "Internal approved-Plan handoff binding; injected by the Plan gate" }),
  ),
});

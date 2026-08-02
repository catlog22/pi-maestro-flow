/**
 * TypeBox schemas for all maestro tools.
 *
 * Main tool: maestro (action: explore | delegate | moa)
 * Auxiliary tools: goal, ask-user-question, todo
 */

import { Type } from "typebox";
import { MAX_ACCEPTANCE_COMMAND_CHARS } from "../tools/goal-verification.ts";
import { TODO_UPDATE_FIELDS } from "../tools/todo-contract.ts";

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
    Type.Unsafe<"analysis" | "write">({
      type: "string",
      enum: ["analysis", "write"],
      description: "analysis: read-only investigation; write: allow file modifications",
    }),
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
  action: StringEnum(["get", "create", "update", "complete"]),
  objective: Type.Optional(
    Type.String({ description: "Goal objective; required when action is 'create' or 'update'" }),
  ),
  summary: Type.Optional(Type.String({ description: "Completion evidence; required when action is 'complete'" })),
  tokenBudget: Type.Optional(
    Type.String({ description: "Optional explicit Token budget; omit for no budget. Accepts plain, k, or m values, e.g. '100000', '100k', or '1.5m'; create only" }),
  ),
  planHandoffKey: Type.Optional(
    Type.String({ description: "Handoff key of the approved Plan this item implements. There is no injector: pass the key that the Plan approval message gave you, or omit it" }),
  ),
  acceptance: Type.Optional(
    Type.Array(Type.String({ maxLength: MAX_ACCEPTANCE_COMMAND_CHARS }), {
      maxItems: 5,
      description: `Acceptance commands (max 5, ${MAX_ACCEPTANCE_COMMAND_CHARS} characters each), configurable on create or update. During completion the extension reruns them and their exit status directly determines verification; without commands, completion uses the agent verifier.`,
    }),
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
}, { additionalProperties: false });

const TodoFilterSchema = Type.Object({
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"]),
  ),
  memberId: Type.Optional(
    Type.String({ description: "Return tasks created by or assigned to self, root, a teammate id or unique id prefix, label, @label, or label#id-prefix" }),
  ),
}, { additionalProperties: false });

const TodoBatchTaskSchema = Type.Object({
  subject: Type.String({
    minLength: 1,
    description: "Task title",
  }),
  description: Type.Optional(
    Type.String({ description: "Long-form task detail" }),
  ),
  context: Type.Optional(
    Type.String({ description: "Plain-text execution context for this step" }),
  ),
  skills: Type.Optional(
    Type.Array(TodoSkillBindingSchema, { description: "Ordered Pi skill bindings; exactly one primary when present" }),
  ),
  assignee: Type.Optional(
    Type.String({ description: "Assignee selector; defaults to the calling actor" }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Integer({
      minimum: 0,
      description: "Zero-based index of an earlier dependency in this exact tasks array. For tasks[i], the index must be less than i; for example, tasks[1] may depend on 0.",
    }), {
      description: "Batch indexes this task depends on. Example: tasks[1].blockedBy = [0] makes the second item depend on the first.",
    }),
  ),
  goalId: Type.Optional(
    Type.String({ description: "Id of the Goal acting as this task's quality gate. Bind only key tasks with verifiable acceptance criteria — do not create a Goal for every task; the task completes only after this Goal verifies" }),
  ),
}, { additionalProperties: false });

// The top level remains permissive for the legacy `skill` input normalized by todo.ts.
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
    Type.String({ minLength: 1, description: "Task title (required for single create)" }),
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
    Type.Array(TodoSkillBindingSchema, {
      description: "Ordered Pi skill bindings. Omit when no skill is needed; on update, an empty array clears the stored skills",
    }),
  ),
  summary: Type.Optional(
    Type.String({ description: "Short completion summary carried into later todo steps" }),
  ),
  updateFields: Type.Optional(
    Type.Array(
      StringEnum([...TODO_UPDATE_FIELDS]),
      { description: "Fields to modify during update. When present, other top-level values are ignored; omit for legacy presence-based updates", uniqueItems: true },
    ),
  ),
  assignee: Type.Optional(
    Type.String({ description: "Assignee selector: self, root, a known teammate id or unique id prefix, label, @label, or label#id-prefix" }),
  ),

  tasks: Type.Optional(
    Type.Array(TodoBatchTaskSchema, {
      minItems: 1,
      description: "Non-empty batch for create. Inside tasks[i].blockedBy, each integer N means tasks[N] in this same array and must satisfy 0 <= N < i.",
    }),
  ),

  id: Type.Optional(
    Type.String({ description: "Task ID (required for get/update/delete)" }),
  ),
  filter: Type.Optional(TodoFilterSchema),
  planHandoffKey: Type.Optional(
    Type.String({ description: "Handoff key of the approved Plan this item implements. There is no injector: pass the key that the Plan approval message gave you, or omit it" }),
  ),
  goalId: Type.Optional(
    Type.String({ description: "Id of the Goal acting as this task's quality gate (bind sparingly, only for tasks with verifiable acceptance); empty string clears it on update" }),
  ),
});

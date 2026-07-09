/**
 * TypeBox schemas for all maestro tools.
 *
 * Main tool: maestro (action: explore | delegate | moa)
 * Auxiliary tools: maestro-wait, maestro-status, goal, ask-user-question, todo
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

// === Goal Tool Schema ===

export const GoalToolParams = Type.Object({
  action: StringEnum(["set", "done", "pause", "clear"]),
  objective: Type.Optional(
    Type.String({
      description: "Goal objective (for 'set'). Omit with 'set' to show status or resume a paused goal.",
    }),
  ),
  tokenBudget: Type.Optional(
    Type.String({
      description: "Token budget with k/m suffix, e.g. '100k' or '1.5m' (for 'set')",
    }),
  ),
  summary: Type.Optional(
    Type.String({
      description: "Completion summary (required for 'done') — an independent verifier agent will check this claim.",
    }),
  ),
});

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
      description: "Multiple-choice options (2-4 recommended)",
    }),
  ),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "Allow multiple selections (default: false)" }),
  ),
});

export const AskUserQuestionParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    description: "1-4 questions to ask the user",
  }),
});

// === Todo Tool Schema ===

const LoadSpecSchema = Type.Object({
  type: StringEnum(["file", "skill", "text"]),
  source: Type.String({
    description: "File path, skill name, or plain text content",
  }),
  label: Type.Optional(
    Type.String({ description: "XML tag name for the injected block" }),
  ),
});

const InjectionSchema = Type.Object({
  skillRef: Type.Optional(
    Type.String({ description: "Skill path reference (e.g., maestro-execute)" }),
  ),
  goalContext: Type.Optional(
    Type.String({ description: "Goal context block for downstream injection" }),
  ),
  stepContext: Type.Optional(
    Type.String({ description: "Previous step output / carry-forward context" }),
  ),
  boundaryContract: Type.Optional(
    Type.String({ description: "Boundary rules for the execution scope" }),
  ),
  deferredReads: Type.Optional(
    Type.Array(Type.String(), {
      description: "File paths to load on demand",
    }),
  ),
});

const CompletionSchema = Type.Object({
  completionStatus: StringEnum(["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_RETRY"]),
  summary: Type.String({ description: "Completion summary (verb-led, ≤100 chars)" }),
  evidence: Type.Optional(Type.String({ description: "Verification artifact paths" })),
  decisions: Type.Optional(Type.String({ description: "Architectural/technical decisions made" })),
  caveats: Type.Optional(Type.String({ description: "Issues for downstream steps" })),
  deferred: Type.Optional(Type.String({ description: "Deferred work items" })),
  concerns: Type.Optional(Type.String({ description: "Concerns (DONE_WITH_CONCERNS only)" })),
});

const TodoFilterSchema = Type.Object({
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "blocked"]),
  ),
  owner: Type.Optional(Type.String()),
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
  owner: Type.Optional(
    Type.String({ description: "Assigned agent or step owner" }),
  ),

  injection: Type.Optional(InjectionSchema),
  load: Type.Optional(LoadSpecSchema),
  completion: Type.Optional(CompletionSchema),
  decision: Type.Optional(
    Type.String({ description: "Decision gate type (e.g., post-execute, post-review). Marks task as a decision node" }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arbitrary key-value metadata for tracking",
    }),
  ),

  id: Type.Optional(
    Type.String({ description: "Task ID (required for get/update/delete)" }),
  ),
  filter: Type.Optional(TodoFilterSchema),
});

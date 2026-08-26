import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES,
  MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES,
  MAX_TODO_PROMPT_CONTEXT_TODOS,
  getTodoPromptContextProvider,
  type TodoPromptContextProvider,
} from "pi-maestro-teammate/v1/todo-context";
import {
  TODO_PROMPT_CONTEXT_MAX_CONTEXT_BYTES,
  TODO_PROMPT_CONTEXT_MAX_DESCRIPTION_BYTES,
  TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES,
  projectTodoPromptContext,
  registerFlowTodoPromptContextProvider,
} from "../src/teammate/todo-prompt-context.ts";
import { ROOT_TODO_ACTOR, type TodoTask } from "../src/tools/todo.ts";

function task(
  id: string,
  overrides: Partial<TodoTask> = {},
): TodoTask {
  return {
    id,
    subject: `Task ${id}`,
    status: "pending",
    blockedBy: [],
    skills: [],
    createdBy: { ...ROOT_TODO_ACTOR },
    assignee: { ...ROOT_TODO_ACTOR },
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    updatedAt: Number(id.replace(/\D/g, "")) || 1,
    ...overrides,
  };
}

test("Todo prompt context resolves requested tasks in priority order with full task detail", () => {
  const tasks = [
    task("1", {
      subject: "First",
      description: "Long-form detail",
      context: "Complete execution context",
      planHandoffKey: "handoff-a",
    }),
    task("2", { subject: "Second" }),
  ];

  assert.deepEqual(projectTodoPromptContext(["#2", "1", "2", "missing"], tasks), [
    {
      todoId: "2",
      subject: "Second",
    },
    {
      todoId: "1",
      subject: "First",
      description: "Long-form detail",
      context: "Complete execution context",
    },
  ]);
});

test("Todo prompt context includes only the five newest completed summaries in the same handoff", () => {
  const current = task("current", { planHandoffKey: "handoff-a", updatedAt: 100 });
  const related = Array.from({ length: 7 }, (_, index) => task(`done-${index}`, {
    status: "completed",
    planHandoffKey: "handoff-a",
    summary: `summary ${index}`,
    createdAt: index,
    updatedAt: index === 5 || index === 6 ? 50 : index,
  }));
  related[5]!.createdAt = 20;
  related[6]!.createdAt = 20;
  const excluded = [
    task("other-handoff", { status: "completed", planHandoffKey: "handoff-b", summary: "other" }),
    task("incomplete", { status: "in_progress", planHandoffKey: "handoff-a", summary: "not done" }),
    task("empty", { status: "completed", planHandoffKey: "handoff-a", summary: "   " }),
    task("deleted", { status: "deleted", planHandoffKey: "handoff-a", summary: "removed" }),
  ];

  const [projection] = projectTodoPromptContext([current.id], [current, ...related, ...excluded]);
  assert.equal(projection?.previousSummaries?.length, MAX_TODO_PROMPT_CONTEXT_PREVIOUS_SUMMARIES);
  assert.deepEqual(
    projection?.previousSummaries?.map((item) => item.todoId),
    ["done-5", "done-6", "done-4", "done-3", "done-2"],
  );
});

test("Todo prompt context omits deleted requested tasks and bounds UTF-8 content", () => {
  const oversized = task("large", {
    subject: "你".repeat(TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES),
    description: "界".repeat(TODO_PROMPT_CONTEXT_MAX_DESCRIPTION_BYTES),
    context: "文".repeat(TODO_PROMPT_CONTEXT_MAX_CONTEXT_BYTES),
    planHandoffKey: "handoff-a",
  });
  const completed = task("done", {
    subject: "题".repeat(TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES),
    status: "completed",
    planHandoffKey: "handoff-a",
    summary: "结".repeat(MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES),
  });
  const deleted = task("deleted", { status: "deleted" });

  const projected = projectTodoPromptContext(["deleted", "large"], [deleted, oversized, completed]);
  assert.equal(projected.length, 1);
  assert.ok(Buffer.byteLength(projected[0]?.subject ?? "", "utf8") <= TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES);
  assert.ok(Buffer.byteLength(projected[0]?.description ?? "", "utf8") <= TODO_PROMPT_CONTEXT_MAX_DESCRIPTION_BYTES);
  assert.ok(Buffer.byteLength(projected[0]?.context ?? "", "utf8") <= TODO_PROMPT_CONTEXT_MAX_CONTEXT_BYTES);
  assert.ok(Buffer.byteLength(projected[0]?.previousSummaries?.[0]?.subject ?? "", "utf8") <= TODO_PROMPT_CONTEXT_MAX_SUBJECT_BYTES);
  assert.ok(Buffer.byteLength(projected[0]?.previousSummaries?.[0]?.summary ?? "", "utf8") <= MAX_TODO_PROMPT_CONTEXT_SUMMARY_BYTES);

  const manyIds = Array.from({ length: MAX_TODO_PROMPT_CONTEXT_TODOS + 2 }, (_, index) => String(index));
  const manyTasks = manyIds.map((id) => task(id));
  assert.equal(projectTodoPromptContext(manyIds, manyTasks).length, MAX_TODO_PROMPT_CONTEXT_TODOS);
});

test("Flow registers a resolver over the current visible Todo snapshot and disposes it", async () => {
  const tasks = [task("1", { context: "initial" })];
  let provider: TodoPromptContextProvider | undefined;
  let disposed = false;
  const dispose = registerFlowTodoPromptContextProvider({
    getTasks: () => tasks,
    registerProvider: (candidate) => {
      provider = candidate;
      return () => {
        disposed = true;
      };
    },
  });

  tasks[0] = task("1", { context: "latest" });
  const result = await provider?.({
    version: 1,
    correlationId: "agent-1",
    cwd: "/workspace",
    todoIds: ["1"],
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, [{ todoId: "1", subject: "Task 1", context: "latest" }]);

  dispose();
  assert.equal(disposed, true);
});

test("Flow provider registers through the public runtime boundary and removes itself", async () => {
  const dispose = registerFlowTodoPromptContextProvider({
    getTasks: () => [task("bound", { context: "root-only" })],
  });
  const provider = getTodoPromptContextProvider();
  assert.ok(provider);
  assert.deepEqual(await provider({
    version: 1,
    correlationId: "agent-public",
    cwd: "/workspace",
    todoIds: ["bound"],
    signal: new AbortController().signal,
  }), [{ todoId: "bound", subject: "Task bound", context: "root-only" }]);

  dispose();
  assert.equal(getTodoPromptContextProvider(), undefined);
});

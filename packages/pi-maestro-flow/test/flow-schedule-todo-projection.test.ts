import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkspaceProjectionItem,
  WorkspaceProjectionProvider,
} from "pi-maestro-teammate/v1/workspace-projections";
import {
  FLOW_SCHEDULE_MAX_PROJECTED_TODOS,
  registerFlowScheduleTodoProjection,
} from "../src/flow-schedule/todo-projection.ts";
import {
  FLOW_SCHEDULE_VERSION,
  type FlowScheduleTodoBinding,
} from "../src/flow-schedule/types.ts";
import {
  ROOT_TODO_ACTOR,
  type TodoTask,
} from "../src/tools/todo.ts";

function task(id: string, status: TodoTask["status"] = "in_progress"): TodoTask {
  return {
    id,
    subject: `Task ${id}`,
    status,
    blockedBy: [],
    skills: [],
    createdBy: { ...ROOT_TODO_ACTOR },
    assignee: { ...ROOT_TODO_ACTOR },
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    updatedAt: 1_000,
  };
}

function binding(
  todoId: string,
  state: FlowScheduleTodoBinding["state"],
  updatedAt: number,
): FlowScheduleTodoBinding {
  return {
    version: FLOW_SCHEDULE_VERSION,
    type: "flow-schedule-binding",
    dispatchId: `dispatch-${todoId}`,
    scheduleId: "release",
    stepId: todoId,
    todoId,
    state,
    createdAt: 100,
    updatedAt,
  };
}

test("Todo projection joins reverse pointers from durable bindings and refreshes dirty snapshots", async () => {
  let bindings = [binding("t2", "bound", 200), binding("t3", "completed", 300)];
  const tasks = [task("t1", "pending"), task("t2"), task("t3", "completed")];
  let provider: WorkspaceProjectionProvider | undefined;
  let listener: (() => void) | undefined;
  let dirty = 0;
  let providerDisposed = false;
  let listenerDisposed = false;
  const projection = registerFlowScheduleTodoProjection({
    store: { listBindings: async () => bindings },
    getTasks: () => tasks,
    subscribe: (candidate) => {
      listener = candidate;
      return () => {
        listenerDisposed = true;
      };
    },
    registerProvider: (candidate) => {
      provider = candidate;
      return {
        kind: candidate.kind,
        markDirty: () => {
          dirty += 1;
        },
        dispose: () => {
          providerDisposed = true;
        },
      };
    },
  });
  await projection.refresh();

  const snapshot = projection.snapshot();
  assert.deepEqual(snapshot.map((item) => item.id), ["t2", "t1", "t3"]);
  assert.deepEqual(snapshot[0], {
    id: "t2",
    subject: "Task t2",
    status: "in_progress",
    assigneeLabel: "root",
    dispatchId: "dispatch-t2",
    scheduleId: "release",
    stepId: "t2",
    bindingActive: true,
    updatedAt: 1_000,
  });
  assert.equal(snapshot[2]?.dispatchId, "dispatch-t3");
  assert.equal(snapshot[2]?.bindingActive, false);
  const items = provider?.snapshot() as WorkspaceProjectionItem[];
  assert.equal(items[0]?.kind, "todo");
  assert.deepEqual(items[0]?.data, snapshot[0]);

  const dirtyBefore = dirty;
  bindings = [binding("t2", "completed", 400), binding("t3", "completed", 300)];
  listener?.();
  await projection.refresh();
  assert.ok(dirty > dirtyBefore);
  assert.deepEqual(projection.snapshot().map((item) => item.id), ["t1", "t2", "t3"]);

  projection.dispose();
  assert.equal(providerDisposed, true);
  assert.equal(listenerDisposed, true);
});

test("Todo projection caps output while retaining active bindings first", async () => {
  const tasks = Array.from({ length: FLOW_SCHEDULE_MAX_PROJECTED_TODOS + 2 }, (_, index) => task(`t${index}`));
  const activeId = tasks.at(-1)!.id;
  const projection = registerFlowScheduleTodoProjection({
    store: { listBindings: async () => [binding(activeId, "bound", 200)] },
    getTasks: () => tasks,
    subscribe: () => () => undefined,
    registerProvider: (provider) => ({ kind: provider.kind, markDirty: () => undefined, dispose: () => undefined }),
  });
  await projection.refresh();

  const snapshot = projection.snapshot();
  assert.equal(snapshot.length, FLOW_SCHEDULE_MAX_PROJECTED_TODOS);
  assert.equal(snapshot[0]?.id, activeId);
  assert.equal(snapshot[0]?.dispatchId, `dispatch-${activeId}`);
  projection.dispose();
});

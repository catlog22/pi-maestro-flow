import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoMirrorTaskSpec } from "../src/session/types.ts";
import {
  executeTodo,
  getTodoCompactionSnapshot,
  getVisibleTasks,
  initTodo,
  onSessionShutdown,
  onSessionStart,
  reconcileMirrorTasks,
  type TodoContext,
} from "../src/tools/todo.ts";

test("Todo v4 reconciles canonical mirror tasks while preserving user tasks", async () => {
  let persisted: unknown;
  initTodo({
    appendEntry(_type: string, value: unknown) {
      persisted = structuredClone(value);
    },
  } as never);
  const entries = [{
    type: "custom",
    customType: "todo-state",
    data: {
      version: 3,
      tasks: {
        user: {
          id: "user",
          subject: "User task",
          status: "pending",
          blockedBy: [],
          skills: [],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    },
  }];
  const todoContext = context(entries);
  const extensionContext = { cwd: "D:/workspace", ui: { setStatus() {} } } as unknown as ExtensionContext;
  onSessionStart(todoContext);
  try {
    const specs = mirrorSpecs();
    const first = reconcileMirrorTasks(specs, extensionContext);
    assert.equal(first.created.length, 2);
    assert.equal(first.updated.length, 0);
    assert.equal(getTodoCompactionSnapshot().stateVersion, 4);
    assert.equal(getVisibleTasks().find((task) => task.id === "user")?.subject, "User task");

    const mirrors = getVisibleTasks().filter((task) => task.origin);
    assert.deepEqual(mirrors.map((task) => task.status), ["completed", "in_progress"]);
    assert.equal(mirrors[1]?.blockedBy.length, 0);
    assert.equal((persisted as { version?: number }).version, 4);
    assert.equal(JSON.stringify(persisted).includes("session-1"), true);

    const unchanged = reconcileMirrorTasks(specs, extensionContext);
    assert.equal(unchanged.unchanged.length, 2);
    assert.equal(unchanged.created.length, 0);

    const active = mirrors[1]!;
    await executeTodo({ action: "delete", id: active.id }, extensionContext);
    const afterDelete = reconcileMirrorTasks(specs, extensionContext);
    assert.ok(afterDelete.unchanged.includes(active.id), "a human tombstone must not be recreated");
    assert.equal(getVisibleTasks().some((task) => task.id === active.id), false);

    const firstOnly = reconcileMirrorTasks(specs.slice(0, 1), extensionContext);
    assert.equal(firstOnly.tombstoned.length, 0, "already deleted mirrors remain tombstoned");
  } finally {
    onSessionShutdown(todoContext);
  }
});

test("Todo projection rejects multiple canonical active root tasks", () => {
  initTodo({ appendEntry() {} } as never);
  const todoContext = context([]);
  const extensionContext = { cwd: "D:/workspace", ui: { setStatus() {} } } as unknown as ExtensionContext;
  onSessionStart(todoContext);
  try {
    const specs = mirrorSpecs().map((spec) => ({ ...spec, status: "in_progress" as const }));
    assert.throws(() => reconcileMirrorTasks(specs, extensionContext), /expected at most one/);
    assert.deepEqual(getVisibleTasks(), []);
  } finally {
    onSessionShutdown(todoContext);
  }
});

function mirrorSpecs(): TodoMirrorTaskSpec[] {
  const firstOrigin = { sessionId: "session-1", step: "analyze", runId: "run-1", runSeq: "001" };
  return [
    {
      origin: firstOrigin,
      subject: "Step 1: analyze",
      status: "completed",
      blockedByOriginKeys: [],
      skills: [],
      summary: "Analysis complete",
    },
    {
      origin: { sessionId: "session-1", step: "plan", runId: "run-2", runSeq: "002" },
      subject: "Step 2: plan",
      status: "in_progress",
      blockedByOriginKeys: [],
      context: "maestro run brief run-2",
      skills: [],
    },
  ];
}

function context(entries: unknown[]): TodoContext {
  return {
    cwd: "D:/workspace",
    ui: { setStatus() {} },
    sessionManager: { getEntries: () => entries },
  };
}

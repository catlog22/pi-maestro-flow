import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { todoOriginKey, type TodoMirrorTaskSpec } from "../src/session/types.ts";
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

test("Todo projection generation authoritatively clears mirrors across Session identity changes", () => {
  initTodo({ appendEntry() {} } as never);
  const todoContext = context([]);
  const extensionContext = { cwd: "D:/workspace", ui: { setStatus() {} } } as unknown as ExtensionContext;
  onSessionStart(todoContext);
  try {
    reconcileMirrorTasks(mirrorSpecs(), extensionContext, "canonical:valid:session-1:1");
    assert.equal(getVisibleTasks().filter((task) => task.origin).length, 2);

    const replacement = mirrorSpecs().slice(0, 1).map((spec) => ({
      ...spec,
      origin: { ...spec.origin, sessionId: "session-2" },
    }));
    const switched = reconcileMirrorTasks(replacement, extensionContext, "canonical:valid:session-2:1");
    assert.equal(switched.tombstoned.length, 2);
    assert.deepEqual(
      getVisibleTasks().filter((task) => task.origin).map((task) => task.origin?.sessionId),
      ["session-2"],
    );

    reconcileMirrorTasks([], extensionContext, "canonical:invalid:session-2:0");
    assert.equal(getVisibleTasks().some((task) => task.origin), false);
  } finally {
    onSessionShutdown(todoContext);
  }
});

test("Todo projection replaces same-Session mirrors and activation when identity generation changes", async () => {
  initTodo({ appendEntry() {} } as never);
  const todoContext = context([]);
  const extensionContext = { cwd: "D:/workspace", ui: { setStatus() {} } } as unknown as ExtensionContext;
  onSessionStart(todoContext);
  try {
    const specs = mirrorSpecs().slice(1);
    const generation1 = "canonical:valid:session-1:1";
    const generation2 = "canonical:valid:session-1:2";
    const first = reconcileMirrorTasks(specs, extensionContext, generation1);
    const firstId = first.created[0]!;

    await executeTodo({ action: "update", id: firstId, status: "pending" }, extensionContext);
    await executeTodo({ action: "next" }, extensionContext);
    const activated = getVisibleTasks().find((task) => task.id === firstId)!;
    assert.equal(activated.origin?.sessionGeneration, generation1);
    assert.ok(activated.skillActivation);

    const stable = reconcileMirrorTasks(specs, extensionContext, generation1);
    assert.deepEqual(stable.unchanged, [firstId]);
    assert.ok(getVisibleTasks().find((task) => task.id === firstId)?.skillActivation);

    const replaced = reconcileMirrorTasks(specs, extensionContext, generation2);
    assert.deepEqual(replaced.tombstoned, [firstId]);
    assert.equal(replaced.created.length, 1);
    assert.notEqual(replaced.created[0], firstId);
    const replacement = getVisibleTasks().find((task) => task.id === replaced.created[0])!;
    assert.equal(replacement.origin?.sessionId, "session-1");
    assert.equal(replacement.origin?.sessionGeneration, generation2);
    assert.equal(replacement.skillActivation, undefined);
  } finally {
    onSessionShutdown(todoContext);
  }
});

test("Todo projection remaps legacy dependency keys to blockers in the current generation", () => {
  initTodo({ appendEntry() {} } as never);
  const todoContext = context([]);
  const extensionContext = { cwd: "D:/workspace", ui: { setStatus() {} } } as unknown as ExtensionContext;
  onSessionStart(todoContext);
  try {
    const blockerOrigin = { sessionId: "session-1", step: "analyze", runId: "run-1", runSeq: "001" };
    const dependentOrigin = { sessionId: "session-1", step: "plan", runId: "run-2", runSeq: "002" };
    const specs: TodoMirrorTaskSpec[] = [
      {
        origin: blockerOrigin,
        subject: "Step 1: analyze",
        status: "pending",
        blockedByOriginKeys: [],
        skills: [],
      },
      {
        origin: dependentOrigin,
        subject: "Step 2: plan",
        status: "pending",
        blockedByOriginKeys: [todoOriginKey(blockerOrigin)],
        skills: [],
      },
    ];
    const generation1 = "canonical:valid:session-1:1";
    const generation2 = "canonical:valid:session-1:2";

    const first = reconcileMirrorTasks(specs, extensionContext, generation1);
    const firstTasks = getVisibleTasks().filter((task) => task.origin);
    const firstBlocker = firstTasks.find((task) => task.subject === "Step 1: analyze")!;
    const firstDependent = firstTasks.find((task) => task.subject === "Step 2: plan")!;
    assert.deepEqual(firstDependent.blockedBy, [firstBlocker.id]);
    assert.equal(firstDependent.status, "blocked");

    const stable = reconcileMirrorTasks(specs, extensionContext, generation1);
    assert.deepEqual(new Set(stable.unchanged), new Set(first.created));
    assert.deepEqual(
      getVisibleTasks().find((task) => task.subject === "Step 2: plan")?.blockedBy,
      [firstBlocker.id],
    );

    const replaced = reconcileMirrorTasks(specs, extensionContext, generation2);
    assert.deepEqual(new Set(replaced.tombstoned), new Set(first.created));
    assert.equal(replaced.created.length, 2);
    const replacementTasks = getVisibleTasks().filter((task) => task.origin);
    const replacementBlocker = replacementTasks.find((task) => task.subject === "Step 1: analyze")!;
    const replacementDependent = replacementTasks.find((task) => task.subject === "Step 2: plan")!;
    assert.equal(replacementBlocker.origin?.sessionGeneration, generation2);
    assert.equal(replacementDependent.origin?.sessionGeneration, generation2);
    assert.deepEqual(replacementDependent.blockedBy, [replacementBlocker.id]);
    assert.equal(replacementDependent.status, "blocked");
    assert.notEqual(replacementBlocker.id, firstBlocker.id);
    assert.equal(replacementDependent.blockedBy.includes(firstBlocker.id), false);
    assert.equal(getVisibleTasks().some((task) => first.created.includes(task.id)), false);
  } finally {
    onSessionShutdown(todoContext);
  }
});

test("Todo origin keys preserve the persisted legacy shape when generation is absent", () => {
  const legacyOrigin = { sessionId: "session-1", step: "plan", runId: "run-2", runSeq: "002" };
  const legacyKey = "session-1\u0000plan\u0000run-2\u0000002";
  assert.equal(todoOriginKey(legacyOrigin), legacyKey);
  assert.equal(
    todoOriginKey({ ...legacyOrigin, sessionGeneration: "canonical:valid:session-1:2" }),
    `${legacyKey}\u0000canonical:valid:session-1:2`,
  );
});

test("Todo projection publishes no mirror or generation cleanup when persistence fails", async () => {
  const useSuccessfulPersist = () => initTodo({ appendEntry() {} } as never);
  const useFailingPersist = () => initTodo({
    appendEntry() { throw new Error("persist failed"); },
  } as never);
  useSuccessfulPersist();
  const todoContext = context([]);
  const extensionContext = { cwd: "D:/workspace", ui: { setStatus() {} } } as unknown as ExtensionContext;
  onSessionStart(todoContext);
  try {
    useFailingPersist();
    const beforeCreate = getTodoCompactionSnapshot();
    assert.throws(
      () => reconcileMirrorTasks(mirrorSpecs(), extensionContext, "canonical:valid:session-1:1"),
      /persist failed/,
    );
    assert.deepEqual(getTodoCompactionSnapshot(), beforeCreate);

    useSuccessfulPersist();
    reconcileMirrorTasks(mirrorSpecs(), extensionContext, "canonical:valid:session-1:1");
    const activeMirror = getVisibleTasks().find((task) => task.status === "in_progress")!;
    await executeTodo({ action: "update", id: activeMirror.id, status: "pending" }, extensionContext);
    await executeTodo({ action: "next" }, extensionContext);
    const beforeCleanup = getTodoCompactionSnapshot();
    assert.equal(beforeCleanup.tasks.filter((task) => task.origin).length, 2);
    assert.equal(beforeCleanup.activeTaskId, activeMirror.id);
    assert.ok(beforeCleanup.tasks.find((task) => task.id === activeMirror.id)?.skillActivation);

    useFailingPersist();
    assert.throws(
      () => reconcileMirrorTasks([], extensionContext, "canonical:invalid:session-1:0"),
      /persist failed/,
    );
    assert.deepEqual(getTodoCompactionSnapshot(), beforeCleanup);
  } finally {
    useSuccessfulPersist();
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

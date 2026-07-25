import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TodoSkillLoader } from "../src/skills/skill-loader.ts";
import {
  executeTodo,
  getVisibleTasks,
  initTodo,
  onSessionStart,
  onSessionShutdown,
  type TodoContext,
} from "../src/tools/todo.ts";
import {
  executeGoal,
  initGoal,
  onSessionStart as goalSessionStart,
  onSessionShutdown as goalSessionShutdown,
  type GoalContext,
} from "../src/tools/goal.ts";

function makeExtensionContext() {
  return { cwd: "", ui: { setStatus() {} } } as never;
}

function startTodo(cwd: string, loader: TodoSkillLoader): TodoContext {
  initTodo({ appendEntry() {} } as never);
  const context: TodoContext = {
    cwd,
    ui: { setStatus() {} },
    skillLoader: loader,
    sessionManager: { getEntries: () => [] },
  };
  onSessionStart(context);
  return context;
}

function makeGoalContext(): GoalContext {
  return {
    cwd: "",
    ui: { setStatus() {}, notify() {} },
    isIdle: () => true,
  } as never;
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

function assertOk(result: { isError?: boolean; content: Array<{ type: string; text: string }> }, label: string): string {
  const text = textOf(result);
  assert.ok(!result.isError, `${label} failed: ${text}`);
  return text;
}

test("SIM: batch create → update/get/delete with #id prefix (original bug)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sim-hash-id-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoCtx = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    const created = await executeTodo({
      action: "create",
      tasks: [
        { subject: "Task A" },
        { subject: "Task B", blockedBy: ["#0"] },
        { subject: "Task C", blockedBy: ["#0"] },
      ],
    }, ctx);
    const createdText = assertOk(created, "batch create");
    assert.match(createdText, /Created 3 tasks/);

    const tasks = getVisibleTasks();
    assert.equal(tasks.length, 3);
    const idA = tasks[0].id;

    // Scenario 1: update with #id (LLM copies "#f4a43d05" from output)
    const r1 = await executeTodo({ action: "update", id: `#${idA}`, status: "in_progress" }, ctx);
    assertOk(r1, "update with #id");
    assert.match(textOf(r1), /Updated/);

    // Scenario 2: update with ##id (double hash)
    await executeTodo({ action: "update", id: idA, status: "pending" }, ctx);
    const r2 = await executeTodo({ action: "update", id: `##${idA}`, status: "in_progress" }, ctx);
    assertOk(r2, "update with ##id");

    // Scenario 3: get with #id
    const r3 = await executeTodo({ action: "get", id: `#${idA}` }, ctx);
    const getText = assertOk(r3, "get with #id");
    assert.match(getText, /Task A/);

    // Scenario 4: delete with #id
    const idC = tasks[2].id;
    const r4 = await executeTodo({ action: "delete", id: `#${idC}` }, ctx);
    assertOk(r4, "delete with #id");
    assert.match(textOf(r4), /Deleted/);
  } finally {
    onSessionShutdown(todoCtx);
    await rm(root, { recursive: true, force: true });
  }
});

test("SIM: blockedBy with #id prefix (dependency resolution)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sim-hash-dep-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoCtx = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    // Create task A (standalone)
    const rA = await executeTodo({ action: "create", subject: "Standalone A" }, ctx);
    assertOk(rA, "create A");
    const idA = getVisibleTasks()[0].id;

    // Create task B blocked by #idA (LLM copies #id from display)
    const rB = await executeTodo({
      action: "create",
      subject: "Blocked B",
      blockedBy: [`#${idA}`],
    }, ctx);
    assertOk(rB, "create with #blockedBy");
    const taskB = getVisibleTasks().find((t) => t.subject === "Blocked B")!;
    assert.equal(taskB.status, "blocked");
    assert.deepEqual(taskB.blockedBy, [idA], "stored blockedBy should be bare ID");

    // Update: add another dependency with #id
    await executeTodo({ action: "create", subject: "Standalone C" }, ctx);
    const idC = getVisibleTasks().find((t) => t.subject === "Standalone C")!.id;

    const rUpd = await executeTodo({
      action: "update",
      id: taskB.id,
      blockedBy: [`#${idA}`, `#${idC}`],
    }, ctx);
    assertOk(rUpd, "update blockedBy with #ids");
    const updatedB = getVisibleTasks().find((t) => t.subject === "Blocked B")!;
    assert.deepEqual(updatedB.blockedBy.sort(), [idA, idC].sort());
  } finally {
    onSessionShutdown(todoCtx);
    await rm(root, { recursive: true, force: true });
  }
});

test("SIM: goal create/get/update return ID for todo goalId binding", async () => {
  const goalCtx = makeGoalContext();
  initGoal(goalCtx);
  goalSessionStart(goalCtx);

  try {
    // create returns ID
    const rCreate = await executeGoal({ action: "create", objective: "Test objective" }, goalCtx);
    assert.ok(!rCreate.isError, `goal create failed: ${rCreate.text}`);
    const idMatch = rCreate.text.match(/\(id: ([0-9a-f-]+)\)/);
    assert.ok(idMatch, `goal create should return ID, got: ${rCreate.text}`);
    const goalId = idMatch[1];

    // get returns ID
    const rGet = await executeGoal({ action: "get" }, goalCtx);
    assert.ok(!rGet.isError);
    assert.match(rGet.text, new RegExp(`Goal \\[${goalId}\\]`), `goal get should contain ID, got: ${rGet.text}`);

    // update returns ID
    const rUpdate = await executeGoal({ action: "update", objective: "Updated objective" }, goalCtx);
    assert.ok(!rUpdate.isError);
    assert.match(rUpdate.text, new RegExp(`\\(id: ${goalId}\\)`), `goal update should contain ID, got: ${rUpdate.text}`);

    // The ID is a valid UUID usable for todo goalId binding
    assert.match(goalId, /^[0-9a-f-]{36}$/);
  } finally {
    goalSessionShutdown(goalCtx);
  }
});

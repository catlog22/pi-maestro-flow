/**
 * Plan <-> Todo seam.
 *
 * Every other suite tests one side with the other stubbed: plan-lifecycle.test.ts fakes
 * the todo predicate through `hasExecutableTodo`, and todo.test.ts never loads plan.ts at
 * all. That is why handoff regressions on this edge stay invisible. These tests wire the
 * *real* modules together and drive the seam end to end.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluatePermission } from "../src/permissions/policy.ts";
import { TodoSkillLoader } from "../src/skills/skill-loader.ts";
import {
  getPlanHandoffStatus,
  initPlan,
  onSessionShutdownPlan,
  onSessionStartPlan,
  onToolCallPlan,
  registerPlanCommand,
  registerPlanTools,
} from "../src/tools/plan.ts";
import { PlanStore } from "../src/tools/plan-store.ts";
import {
  executeTodo,
  getVisibleTasks,
  initTodo,
  onSessionShutdown as todoSessionShutdown,
  onSessionStart as todoSessionStart,
  type TodoContext,
} from "../src/tools/todo.ts";

interface ToolLike {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<any>;
}

/**
 * Minimal plan harness. Unlike the one in plan-lifecycle.test.ts it passes no
 * `hasExecutableTodo` override, so plan.ts resolves the handoff against the real
 * `getVisibleTasks()` — that is the whole point of this file.
 */
function createPlanHarness(root: string) {
  let active = ["Read", "Write", "Bash", "todo"];
  const tools = new Map<string, ToolLike>();
  const notifications: string[] = [];
  const tui = { requestRender() {} };
  const theme = {
    fg: (_name: string, text: string) => text,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
  const pi = {
    registerTool(tool: { name: string }) { tools.set(tool.name, tool as unknown as ToolLike); },
    registerCommand() {},
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active = [...names]; },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: join(root, "workspace"),
    hasUI: true,
    isIdle: () => false,
    abort() {},
    getContextUsage: () => ({ percent: 0 }),
    sessionManager: {
      getSessionId: () => "session-plan-todo",
      getSessionFile: () => join(root, "session-plan-todo.jsonl"),
      getSessionName: () => "session-plan-todo",
    },
    ui: {
      setStatus() {},
      notify(message: string) { notifications.push(message); },
      async custom(factory: Function) {
        return new Promise((resolve) => {
          // Confirm the plan (ctrl+enter) as soon as the confirmation panel mounts.
          const component = factory(tui, theme, {}, resolve);
          setImmediate(() => component.handleInput("\x1b[13;5u"));
        });
      },
    },
  } as unknown as ExtensionContext;

  initPlan(pi, {
    storeFactory: (cwd, session) => new PlanStore(cwd, { rootDir: join(root, "global"), session }),
  });
  registerPlanTools(pi);
  registerPlanCommand(pi);
  return { pi, ctx, tools, notifications };
}

async function runPlanTool(
  harness: ReturnType<typeof createPlanHarness>,
  name: string,
  params: Record<string, unknown> = {},
) {
  const tool = harness.tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return tool.execute(name, params, undefined, undefined, harness.ctx);
}

function startTodoModule(root: string): TodoContext {
  initTodo({ appendEntry() {} } as never);
  const context: TodoContext = {
    cwd: root,
    ui: { setStatus() {} },
    skillLoader: new TodoSkillLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
    }),
    sessionManager: { getEntries: () => [] },
  };
  todoSessionStart(context);
  return context;
}

function todoToolContext(root: string): ExtensionContext {
  return { cwd: root, ui: { setStatus() {}, notify() {} } } as never;
}

test("an approved Plan is only handed off by a Todo carrying its own handoff key", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-todo-"));
  const harness = createPlanHarness(root);
  const todoContext = startTodoModule(root);
  const ctx = todoToolContext(root);

  try {
    await onSessionStartPlan(harness.ctx);
    await runPlanTool(harness, "plan-enter");
    await runPlanTool(harness, "plan-update", { markdown: "# Ship it\n\nDo the work" });
    const confirmed = await runPlanTool(harness, "plan-confirm");
    assert.equal(confirmed.details.approved, true);

    const handoffKey = confirmed.details.handoffKey;
    assert.ok(handoffKey, "an approved Plan must publish a handoff key");

    // Approved, but nothing to execute yet.
    assert.equal(getPlanHandoffStatus(), "todo-required");

    // A Todo that is not bound to this approval must not satisfy the gate.
    await executeTodo({ action: "create", subject: "Unrelated chore" }, ctx);
    assert.equal(getPlanHandoffStatus(), "todo-required");

    // A Todo carrying the key does.
    await executeTodo({
      action: "create",
      subject: "Implement the approved plan",
      planHandoffKey: handoffKey,
    }, ctx);
    assert.equal(getPlanHandoffStatus(), "ready");

    // Finishing the bound work retires the handoff — "ready" tracks executable
    // work, not the mere existence of a once-bound task.
    const bound = getVisibleTasks().find((task) => task.planHandoffKey === handoffKey);
    assert.ok(bound);
    await executeTodo({ action: "update", id: bound.id, status: "completed" }, ctx);
    assert.equal(getPlanHandoffStatus(), "todo-required");
  } finally {
    todoSessionShutdown(todoContext);
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("the approval message hands the model the key the todo tool needs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-todo-key-"));
  const harness = createPlanHarness(root);
  const todoContext = startTodoModule(root);
  const ctx = todoToolContext(root);

  try {
    await onSessionStartPlan(harness.ctx);
    await runPlanTool(harness, "plan-enter");
    await runPlanTool(harness, "plan-update", { markdown: "# Wire it\n\nBind the handoff" });
    const confirmed = await runPlanTool(harness, "plan-confirm");
    const handoffKey = confirmed.details.handoffKey;
    assert.ok(handoffKey);

    // Nothing injects planHandoffKey into the todo tool input — the model supplies it.
    // So the approval message is the only place it can come from; without it the key is
    // unknowable and the handoff status can never leave "todo-required".
    const approvalText = confirmed.content[0]?.text ?? "";
    assert.match(approvalText, /planHandoffKey/);
    assert.ok(
      approvalText.includes(handoffKey),
      "the approval message must contain the literal handoff key",
    );

    // Round-trip: the key as published is the key the gate accepts.
    const published = approvalText.match(/planHandoffKey: "([^"]+)"/)?.[1];
    assert.equal(published, handoffKey);
    await executeTodo({ action: "create", subject: "Bound work", planHandoffKey: published }, ctx);
    assert.equal(getPlanHandoffStatus(), "ready");
  } finally {
    todoSessionShutdown(todoContext);
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("a blocked Todo does not satisfy the Plan handoff until its dependency clears", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-todo-blocked-"));
  const harness = createPlanHarness(root);
  const todoContext = startTodoModule(root);
  const ctx = todoToolContext(root);

  try {
    await onSessionStartPlan(harness.ctx);
    await runPlanTool(harness, "plan-enter");
    await runPlanTool(harness, "plan-update", { markdown: "# Staged\n\nTwo steps" });
    const confirmed = await runPlanTool(harness, "plan-confirm");
    const handoffKey = confirmed.details.handoffKey as string;

    await executeTodo({
      action: "create",
      tasks: [
        { subject: "Prepare" },
        { subject: "Implement", blockedBy: ["#0"] },
      ],
      planHandoffKey: handoffKey,
    }, ctx);

    const [first, second] = getVisibleTasks();
    assert.ok(first && second);
    assert.deepEqual(second.blockedBy, [first.id]);
    // The unblocked head of the graph is what makes the handoff executable.
    assert.equal(getPlanHandoffStatus(), "ready");

    await executeTodo({ action: "update", id: first.id, status: "completed" }, ctx);
    // Completing the head auto-unblocks the tail, which keeps the handoff executable.
    assert.equal(getVisibleTasks().find((task) => task.id === second.id)?.blockedBy.length, 0);
    assert.equal(getPlanHandoffStatus(), "ready");

    await executeTodo({ action: "update", id: second.id, status: "completed" }, ctx);
    assert.equal(getPlanHandoffStatus(), "todo-required");
  } finally {
    todoSessionShutdown(todoContext);
    onSessionShutdownPlan(harness.ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("Plan mode constrains mutating tools through the permission layer, not the tool_call hook", () => {
  const empty = { allow: [], ask: [], deny: [] };
  const write = { toolName: "write", input: { path: "src/app.ts" } };

  // Plan is advisory at the tool_call layer by design (a5b0d8b7): blocking there would
  // rewrite the tool panel and invalidate the cached prompt prefix.
  assert.equal(onToolCallPlan({ toolName: "Write", input: {} }), undefined);

  // Which is exactly why the permission layer must not wave it through either — Plan
  // has to be at least as strict as default, never looser.
  assert.equal(evaluatePermission(write, "default", empty).behavior, "ask");
  assert.equal(evaluatePermission(write, "plan", empty).behavior, "ask");
  assert.equal(
    evaluatePermission(write, "plan", { allow: [], ask: [], deny: ["Write(src/app.ts)"] }).behavior,
    "deny",
  );
});

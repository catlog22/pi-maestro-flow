import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGuiServer } from "../src/gui/gui-server.ts";
import { createGuiEventForwarder, GUI_EVENTS } from "../src/gui/gui-events.ts";
import type { GuiServerHandle } from "../src/gui/types.ts";
import {
  executeTodo,
  initTodo,
  onSessionShutdown as todoSessionShutdown,
  onSessionStart as todoSessionStart,
  setTodoStateChangeListener,
} from "../src/tools/todo.ts";
import {
  executeGoal,
  executeGoalCommand,
  initGoal,
  onSessionShutdown as goalSessionShutdown,
  onSessionStart as goalSessionStart,
  setGoalStateChangeListener,
} from "../src/tools/goal.ts";

function fakeServer(): { handle: GuiServerHandle; pushed: Array<{ name: string; payload: unknown }> } {
  const pushed: Array<{ name: string; payload: unknown }> = [];
  const handle = {
    pushEvent: (name: string, payload: unknown) => pushed.push({ name, payload }),
  } as unknown as GuiServerHandle;
  return { handle, pushed };
}

test("forwarder is a no-op when unbound", () => {
  const forwarder = createGuiEventForwarder();
  assert.equal(forwarder.isActive(), false);
  // Must not throw.
  forwarder.emit(GUI_EVENTS.todoUpdated, { x: 1 });
  forwarder.emitDeduped(GUI_EVENTS.goalChanged, "k", { y: 2 });
});

test("forwarder emits cloned payloads, dedupes, and receives durable state notifications", async () => {
  const forwarder = createGuiEventForwarder();
  const { handle, pushed } = fakeServer();
  forwarder.bind(handle);
  assert.equal(forwarder.isActive(), true);

  // Plain emit passes through (cloned).
  const payload = { fn: () => 1, value: 5 };
  forwarder.emit(GUI_EVENTS.runTransition, payload);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].payload, { value: 5 }, "function dropped by clone");

  // Deduped emit: first fires event + state.changed.
  forwarder.emitDeduped(GUI_EVENTS.todoUpdated, "fp1", { count: 1 });
  assert.equal(pushed.length, 3);
  assert.equal(pushed[1].name, GUI_EVENTS.todoUpdated);
  assert.equal(pushed[2].name, GUI_EVENTS.stateChanged);
  assert.deepEqual((pushed[2].payload as any).subsystem, GUI_EVENTS.todoUpdated);

  // Same key -> suppressed.
  forwarder.emitDeduped(GUI_EVENTS.todoUpdated, "fp1", { count: 1 });
  assert.equal(pushed.length, 3);

  // Different key -> fires again.
  forwarder.emitDeduped(GUI_EVENTS.todoUpdated, "fp2", { count: 2 });
  assert.equal(pushed.length, 5);

  // Rebind clears dedup state and detaches when null.
  forwarder.bind(null);
  assert.equal(forwarder.isActive(), false);
  forwarder.emit(GUI_EVENTS.todoUpdated, { z: 9 });
  assert.equal(pushed.length, 5, "no push after unbind");

  const cwd = await mkdtemp(join(tmpdir(), "gui-state-events-"));
  const todoContext = {
    cwd,
    ui: { setStatus() {} },
    sessionManager: { getEntries: () => [] },
  } as never;
  const toolContext = { cwd, ui: { setStatus() {} } } as never;
  let todoChanges = 0;
  let goalChanges = 0;

  initTodo({ appendEntry() {} } as never);
  todoSessionStart(todoContext);
  setTodoStateChangeListener(() => { todoChanges += 1; });
  initGoal({ appendEntry() {} } as never);
  const goalContext = { cwd, ui: { notify() {}, setStatus() {} } } as never;
  goalSessionStart(goalContext, { reason: "new" });
  setGoalStateChangeListener(() => { goalChanges += 1; });
  try {
    await executeTodo({ action: "create", subject: "Emit the Todo change" }, toolContext);
    await executeGoal({ action: "create", objective: "Emit the Goal change" }, goalContext);
    assert.equal(todoChanges, 1);
    assert.equal(goalChanges, 1);
  } finally {
    setTodoStateChangeListener(undefined);
    setGoalStateChangeListener(undefined);
    await executeGoalCommand({ action: "clear" }, goalContext);
    todoSessionShutdown(todoContext);
    goalSessionShutdown(goalContext);
  }
});

test("forwarder events reach SSE clients through a real server", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gui-events-"));
  const server = await startGuiServer({ sessionId: "s", cwd, writeDiscovery: false });
  const forwarder = createGuiEventForwarder();
  forwarder.bind(server);
  try {
    const received = new Promise<any>((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: server.port, path: `/events?session=${server.token}` }, (res) => {
        let buffer = "";
        let current: Partial<{ event: string; data: string }> = {};
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          let idx: number;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.startsWith(":")) continue;
            if (line === "") {
              if (current.event === GUI_EVENTS.goalChanged && current.data !== undefined) {
                req.destroy();
                resolve(JSON.parse(current.data));
                return;
              }
              current = {};
              continue;
            }
            const colon = line.indexOf(":");
            const field = colon >= 0 ? line.slice(0, colon) : line;
            const value = colon >= 0 ? line.slice(colon + 1).trimStart() : "";
            if (field === "event") current.event = value;
            else if (field === "data") current.data = value;
          }
        });
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    forwarder.emitDeduped(GUI_EVENTS.goalChanged, "g1", { objective: "ship" });
    const data = await received;
    assert.deepEqual(data, { objective: "ship" });
  } finally {
    forwarder.bind(null);
    server.close("done");
  }
});

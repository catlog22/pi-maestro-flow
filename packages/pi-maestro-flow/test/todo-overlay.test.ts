import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TodoOverlay } from "../src/tui/todo-overlay.ts";
import type { TodoActorRef, TodoTask } from "../src/tools/todo.ts";

const root: TodoActorRef = { kind: "root", id: "root", label: "root" };
const api: TodoActorRef = { kind: "teammate", id: "api-1111", label: "api", agentType: "worker" };
const apiTwo: TodoActorRef = { kind: "teammate", id: "api-2222", label: "api", agentType: "reviewer" };

function task(
  id: string,
  subject: string,
  status: TodoTask["status"],
  createdBy: TodoActorRef,
  assignee: TodoActorRef,
): TodoTask {
  return {
    id,
    subject,
    status,
    blockedBy: [],
    skills: [],
    createdBy,
    assignee,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    updatedAt: 1,
  };
}

test("Todo overlay renders shared member scopes width-safely and distinguishes colliding labels", () => {
  let renders = 0;
  const overlay = new TodoOverlay({
    getTasks: () => [
      task("1", "Root planning", "completed", root, root),
      task("2", "Build API", "in_progress", root, api),
      task("3", "Review API", "pending", apiTwo, apiTwo),
    ],
    requestRender: () => { renders++; },
    close() {},
  });

  for (let width = 1; width <= 120; width++) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    }
  }

  const wide = overlay.render(100).join("\n");
  assert.match(wide, /Scope: \[All\]/);
  assert.match(wide, /@root→@api#api-/);
  assert.match(wide, /Build API/);

  overlay.handleInput("\x1b[C");
  assert.ok(renders > 0);
  assert.match(overlay.render(80).join("\n"), /Scope: All \[root\]/);
  overlay.handleInput("\x1b[C");
  assert.match(overlay.render(80).join("\n"), /\[api#api-/);

  overlay.handleInput("\r");
  assert.match(overlay.render(60).join("\n"), /task detail/);
  overlay.handleInput("\x1b");
  assert.doesNotMatch(overlay.render(60).join("\n"), /task detail/);
});

test("Todo overlay filters by printable paste and keeps narrow recovery controls visible", () => {
  const overlay = new TodoOverlay({
    getTasks: () => [
      task("1", "Fix retry transport", "in_progress", api, api),
      task("2", "Write documentation", "pending", root, root),
    ],
    requestRender() {},
    close() {},
  });

  overlay.handleInput("retry");
  const rendered = overlay.render(48).join("\n");
  assert.match(rendered, /Fix retry transport/);
  assert.doesNotMatch(rendered, /Write documentation/);
  assert.match(rendered, /Esc close/);
  assert.match(overlay.render(12)[0], /Esc/);

  overlay.handleInput("hidden");
  assert.match(overlay.render(48).join("\n"), /Fix retry transport/);
});

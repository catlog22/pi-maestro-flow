import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TodoSkillLoader } from "../src/skills/skill-loader.ts";
import {
  executeTodo,
  initTodo,
  onSessionShutdown,
  onSessionStart,
  type TodoActorRef,
  type TodoContext,
  type TodoTask,
} from "../src/tools/todo.ts";
import { renderTodoWidget } from "../src/extension/index.ts";
import { TodoOverlay } from "../src/tui/todo-overlay.ts";

const identity = (_color: string, text: string): string => text;
const mockTheme = {
  fg: identity,
  bg: identity,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const root: TodoActorRef = { kind: "root", id: "root", label: "root" };

function task(
  id: string,
  subject: string,
  status: TodoTask["status"],
): TodoTask {
  return {
    id,
    subject,
    status,
    blockedBy: [],
    skills: [],
    createdBy: root,
    assignee: root,
    createdAt: Number(id) || 1,
    updatedAt: 1,
  };
}

function makeExtensionContext() {
  return {
    cwd: "",
    ui: { setStatus() {} },
  } as never;
}

function startTodo(cwd: string, loader: TodoSkillLoader): TodoContext {
  const persisted: unknown[] = [];
  initTodo({ appendEntry(_type: string, data: unknown) { persisted.push(data); } } as never);
  const context: TodoContext = {
    cwd,
    ui: { setStatus() {} },
    skillLoader: loader,
    sessionManager: { getEntries: () => [] },
  };
  onSessionStart(context);
  return context;
}

// Cross-tool regression: every Todo surface must mark an incomplete (pending)
// task with a rectangular box glyph, never a circle. The tool text output uses
// "[ ]", the status widget and the /todo overlay use "□".
test("todo marks pending tasks with a rectangular box across tool, widget, and overlay renderers", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "pi-todo-marker-"));
  const loader = new TodoSkillLoader({
    cwd: rootDir,
    agentDir: join(rootDir, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(rootDir, loader);
  const ctx = makeExtensionContext();

  try {
    // Tool text output: rectangular brackets.
    await executeTodo({ action: "create", subject: "First marker task" }, ctx);
    await executeTodo({ action: "create", subject: "Second marker task" }, ctx);
    const list = await executeTodo({ action: "list" }, ctx);
    const listText = (list.content[0] as { text: string }).text;
    assert.match(listText, /\[ \]/, "tool list must mark pending tasks with [ ]");
    assert.doesNotMatch(listText, /○/, "tool list must not use a circle marker");

    // Status widget: rectangular box glyph.
    const widgetLines = renderTodoWidget([
      { id: "1", subject: "Waiting", status: "pending", blockedBy: [], skills: [] },
    ], true, 120).join("\n");
    assert.match(widgetLines, /□/, "widget must mark pending tasks with □");
    assert.doesNotMatch(widgetLines, /○/, "widget must not use a circle marker");

    // /todo overlay: same rectangular box glyph as the widget.
    const overlay = new TodoOverlay({
      getTasks: () => [
        task("1", "Waiting", "pending"),
        task("2", "Doing", "in_progress"),
        task("3", "Done", "completed"),
      ],
      requestRender() {},
      close() {},
      theme: mockTheme,
    });
    const overlayText = overlay.render(80).join("\n");
    assert.match(overlayText, /□ pending/, "overlay must mark pending tasks with □");
    assert.doesNotMatch(overlayText, /○/, "overlay must not use a circle marker");
  } finally {
    onSessionShutdown(todoContext);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("todo overlay keeps distinct markers per status with only pending as a box", () => {
  const overlay = new TodoOverlay({
    getTasks: () => [
      task("1", "Waiting", "pending"),
      task("2", "Doing", "in_progress"),
      task("3", "Stuck", "blocked"),
      task("4", "Done", "completed"),
    ],
    requestRender() {},
    close() {},
    theme: mockTheme,
  });

  const rendered = overlay.render(80).join("\n");
  assert.match(rendered, /□ pending/);
  assert.match(rendered, /▶ running/);
  assert.match(rendered, /! blocked/);
  assert.match(rendered, /✓ completed/);
  assert.doesNotMatch(rendered, /○/);
});

test("todo overlay keeps the rectangular pending marker in narrow compact mode", () => {
  const overlay = new TodoOverlay({
    getTasks: () => [task("1", "Waiting", "pending")],
    requestRender() {},
    close() {},
    theme: mockTheme,
  });

  for (let width = 1; width <= 19; width++) {
    const compact = overlay.render(width)[0];
    // "Esc · " occupies 6 visible columns and □ renders double-width, so the
    // marker only shows at width >= 8.
    if (width >= 8) assert.match(compact, /□/, `compact width ${width} must keep the box marker`);
    assert.doesNotMatch(compact, /○/);
  }
});

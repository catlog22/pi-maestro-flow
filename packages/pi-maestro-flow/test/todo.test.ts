import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { TodoSkillLoader } from "../src/skills/skill-loader.ts";
import {
  executeTodo,
  getVisibleTasks,
  initTodo,
  onSessionShutdown,
  onSessionStart,
  type TodoContext,
} from "../src/tools/todo.ts";
import { renderTodoWidget } from "../src/extension/index.ts";
import { TodoToolParams } from "../src/extension/schemas.ts";

function makeExtensionContext() {
  return {
    cwd: "",
    ui: { setStatus() {} },
  } as never;
}

function startTodo(cwd: string, loader: TodoSkillLoader, entries: unknown[] = []): TodoContext {
  const persisted: unknown[] = [];
  initTodo({ appendEntry(_type: string, data: unknown) { persisted.push(data); } } as never);
  const context: TodoContext = {
    cwd,
    ui: { setStatus() {} },
    skillLoader: loader,
    sessionManager: { getEntries: () => entries },
  };
  onSessionStart(context);
  return context;
}

test("todo create/update preserves, replaces, and clears context and skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-state-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    const created = await executeTodo({
      action: "create",
      subject: "Run demo",
      context: "initial",
      skill: { name: "demo", args: "--depth deep" },
    }, ctx);
    const id = (created.details as { tasks: Array<{ id: string }> }).tasks[0].id;

    await executeTodo({ action: "update", id, subject: "Renamed" }, ctx);
    assert.equal(getVisibleTasks()[0].context, "initial");
    assert.equal(getVisibleTasks()[0].skill?.name, "demo");

    await executeTodo({ action: "update", id, context: "", skill: null }, ctx);
    assert.equal(getVisibleTasks()[0].context, undefined);
    assert.equal(getVisibleTasks()[0].skill, undefined);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo next loads context and skill before transitioning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-next-"));
  const agentDir = join(root, "agent");
  const skillDir = join(root, ".pi", "skills", "demo");
  await mkdir(skillDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, "---\nname: demo\ndescription: demo\n---\n# Demo instructions\n");
  const skill = {
    name: "demo",
    description: "demo",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  } satisfies Skill;
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir,
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [skill], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({ action: "create", subject: "Run demo", context: "CONTEXT", skill: { name: "demo" } }, ctx);
    const next = await executeTodo({ action: "next" }, ctx);
    const text = (next.content[0] as { text: string }).text;
    assert.match(text, /<context>\nCONTEXT/);
    assert.match(text, /<skill_prompt>\n# Demo instructions/);
    assert.equal(getVisibleTasks()[0].status, "in_progress");
    assert.equal(getVisibleTasks()[0].skillLoad?.filePath, skillPath);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo next keeps task pending when skill loading fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-next-error-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({ action: "create", subject: "Missing", skill: { name: "missing" } }, ctx);
    const next = await executeTodo({ action: "next" }, ctx);
    assert.equal((next as { isError?: boolean }).isError, true);
    assert.match((next.content[0] as { text: string }).text, /E_SKILL_NOT_FOUND/);
    assert.equal(getVisibleTasks()[0].status, "pending");
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy injected state migrates to context, skill, and summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-legacy-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const entries = [{
    type: "custom",
    customType: "todo-state",
    data: {
      tasks: {
        old: {
          id: "old",
          subject: "Legacy",
          status: "pending",
          blockedBy: [],
          inject: [
            { type: "text", source: "legacy text", tag: "boundary_contract" },
            { type: "skill", source: "maestro-execute" },
            { type: "file", source: "notes.md" },
          ],
          completion: { summary: "legacy summary" },
          createdAt: 1,
          updatedAt: 2,
        },
      },
    },
  }];
  const todoContext = startTodo(root, loader, entries);

  try {
    const task = getVisibleTasks()[0];
    assert.match(task.context ?? "", /legacy text/);
    assert.match(task.context ?? "", /legacy_file_reference/);
    assert.equal(task.skill?.name, "maestro-execute");
    assert.equal(task.summary, "legacy summary");
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo widget shows the configured skill", () => {
  const lines = renderTodoWidget([{
    id: "1",
    subject: "Execute",
    status: "pending",
    blockedBy: [],
    skill: { name: "maestro-execute" },
  }], true, 120);
  assert.match(lines.join("\n"), /\/maestro-execute/);
});

test("todo public schema exposes only the simplified context and skill contract", () => {
  const properties = (TodoToolParams as unknown as { properties: Record<string, unknown> }).properties;
  assert.ok(properties.context);
  assert.ok(properties.skill);
  assert.ok(properties.summary);
  for (const legacy of ["injection", "load", "refs", "inject", "owner", "completion", "decision", "metadata"]) {
    assert.equal(properties[legacy], undefined, `legacy field ${legacy} should not be public`);
  }
});

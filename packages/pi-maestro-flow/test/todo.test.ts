import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { TodoSkillLoader } from "../src/skills/skill-loader.ts";
import {
  executeTodo,
  getTodoCompactionSnapshot,
  getVisibleTasks,
  initTodo,
  onAgentEndTodo,
  onBeforeAgentStartTodo,
  onContextTodo,
  onSessionShutdown,
  onSessionStart,
  type TodoActorRef,
  type TodoContext,
} from "../src/tools/todo.ts";
import { TodoToolParams } from "../src/extension/schemas.ts";
import { renderTodoWidget } from "../src/extension/index.ts";

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

test("Todo keeps its task summary out of the statusline", async () => {
  const statusValues: Array<string | undefined> = [];
  initTodo({ appendEntry() {} } as never);
  const todoContext: TodoContext = {
    cwd: "",
    ui: { setStatus(_key, value) { statusValues.push(value); } },
    sessionManager: { getEntries: () => [] },
  };
  onSessionStart(todoContext);

  try {
    await executeTodo({ action: "create", subject: "Render above the input" }, makeExtensionContext());
    assert.deepEqual(statusValues, [undefined]);
  } finally {
    onSessionShutdown(todoContext);
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("todo create/update preserves, replaces, and clears context and skills", async () => {
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
      skills: [{ name: "demo", role: "primary", args: "--depth deep" }],
    }, ctx);
    const id = (created.details as { tasks: Array<{ id: string }> }).tasks[0].id;

    await executeTodo({ action: "update", id, subject: "Renamed" }, ctx);
    assert.equal(getVisibleTasks()[0].context, "initial");
    assert.deepEqual(getVisibleTasks()[0].skills, [
      { name: "demo", role: "primary", args: "--depth deep" },
    ]);

    await executeTodo({
      action: "update",
      id,
      skills: [{ name: "review", role: "primary" }],
    }, ctx);
    assert.deepEqual(getVisibleTasks()[0].skills, [{ name: "review", role: "primary" }]);

    await executeTodo({ action: "update", id, context: "", skills: [] }, ctx);
    assert.equal(getVisibleTasks()[0].context, undefined);
    assert.deepEqual(getVisibleTasks()[0].skills, []);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("Todo creation and reload preserve the approved Plan handoff binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-handoff-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const handoffKey = "b".repeat(64);
  let todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();
  try {
    await executeTodo({ action: "create", subject: "Bound task", planHandoffKey: handoffKey }, ctx);
    const created = getVisibleTasks()[0];
    assert.equal(created.planHandoffKey, handoffKey);
    onSessionShutdown(todoContext);

    const entry = {
      type: "custom",
      customType: "todo-state",
      data: { version: 4, tasks: { [created.id]: created } },
    };
    todoContext = startTodo(root, loader, [entry]);
    assert.equal(getVisibleTasks()[0].planHandoffKey, handoffKey);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo next loads context and skills before transitioning", async () => {
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
    await executeTodo({
      action: "create",
      subject: "Run demo",
      context: "CONTEXT",
      skills: [{ name: "demo", role: "primary" }],
    }, ctx);
    const next = await executeTodo({ action: "next" }, ctx);
    const text = (next.content[0] as { text: string }).text;
    assert.match(text, /<context>\nCONTEXT/);
    assert.match(text, /<skill_prompt role="primary">\n# Demo instructions/);
    assert.equal(getVisibleTasks()[0].status, "in_progress");
    assert.match(getVisibleTasks()[0].skillActivation?.activationId ?? "", /^[0-9a-f-]{36}$/);
    assert.match(getVisibleTasks()[0].skillActivation?.stackRevision ?? "", /^[0-9a-f]{64}$/);
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
    await executeTodo({
      action: "create",
      subject: "Missing",
      skills: [{ name: "missing", role: "primary" }],
    }, ctx);
    const next = await executeTodo({ action: "next" }, ctx);
    assert.equal((next as { isError?: boolean }).isError, true);
    assert.match((next.content[0] as { text: string }).text, /E_SKILL_NOT_FOUND/);
    assert.equal(getVisibleTasks()[0].status, "pending");
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo next renders guard, primary, support while preserving order inside roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-stack-order-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const skills: Skill[] = [];
  for (const name of ["support-a", "guard-a", "primary", "guard-b", "support-b"]) {
    const skillDir = join(root, ".pi", "skills", name);
    await mkdir(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    await writeFile(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`);
    skills.push({
      name,
      description: name,
      filePath,
      baseDir: skillDir,
      sourceInfo: {} as Skill["sourceInfo"],
      disableModelInvocation: false,
    });
  }
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir,
    resourceLoader: { async reload() {}, getSkills: () => ({ skills, diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({
      action: "create",
      subject: "Ordered stack",
      skills: [
        { name: "support-a", role: "support" },
        { name: "guard-a", role: "guard" },
        { name: "primary", role: "primary" },
        { name: "guard-b", role: "guard" },
        { name: "support-b", role: "support" },
      ],
    }, ctx);
    const next = await executeTodo({ action: "next" }, ctx);
    const text = (next.content[0] as { text: string }).text;
    const names = [...text.matchAll(/# (guard-a|guard-b|primary|support-a|support-b)/g)]
      .map((match) => match[1]);
    assert.deepEqual(names, ["guard-a", "guard-b", "primary", "support-a", "support-b"]);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo rejects duplicate skill names and non-empty stacks without one primary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-stack-invalid-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    const duplicate = await executeTodo({
      action: "create",
      subject: "Duplicate",
      skills: [
        { name: "same", role: "primary" },
        { name: "same", role: "support" },
      ],
    }, ctx);
    assert.equal((duplicate as { isError?: boolean }).isError, true);
    assert.match((duplicate.content[0] as { text: string }).text, /E_SKILL_DUPLICATE/);

    const missingPrimary = await executeTodo({
      action: "create",
      subject: "Missing primary",
      skills: [{ name: "guard", role: "guard" }],
    }, ctx);
    assert.equal((missingPrimary as { isError?: boolean }).isError, true);
    assert.match((missingPrimary.content[0] as { text: string }).text, /E_SKILL_PRIMARY_COUNT/);
    assert.deepEqual(getVisibleTasks(), []);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy V2 skill state migrates to canonical skills, context, and summary", async () => {
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
      version: 2,
      tasks: {
        old: {
          id: "old",
          subject: "Legacy",
          status: "pending",
          blockedBy: [],
          skill: { name: "maestro-execute", args: "--continue" },
          inject: [
            { type: "text", source: "legacy text", tag: "boundary_contract" },
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
    assert.deepEqual(task.skills, [
      { name: "maestro-execute", role: "primary", args: "--continue" },
    ]);
    assert.equal("skill" in task, false);
    assert.equal(task.summary, "legacy summary");
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy single-skill input is normalized only at the execute boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-legacy-input-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({
      action: "create",
      subject: "Legacy input",
      skill: { name: "maestro-execute", args: "--continue" },
    }, ctx);
    const task = getVisibleTasks()[0];
    assert.deepEqual(task.skills, [
      { name: "maestro-execute", role: "primary", args: "--continue" },
    ]);
    assert.equal("skill" in task, false);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo public schema exposes only the canonical context and skills contract", () => {
  const properties = (TodoToolParams as unknown as { properties: Record<string, unknown> }).properties;
  assert.ok(properties.context);
  assert.ok(properties.skills);
  const skills = properties.skills as { type?: string; anyOf?: unknown };
  assert.equal(skills.type, "array", "public skills must remain a direct array schema for provider compatibility");
  assert.equal(skills.anyOf, undefined, "public skills must not use an array/null union");
  assert.ok(properties.summary);
  assert.ok(properties.assignee);
  for (const legacy of ["skill", "injection", "load", "refs", "inject", "owner", "completion", "decision", "metadata"]) {
    assert.equal(properties[legacy], undefined, `legacy field ${legacy} should not be public`);
  }
});

test("todo widget shows the primary skill and additional binding count", () => {
  const lines = renderTodoWidget([{
    id: "1",
    subject: "Execute",
    status: "pending",
    blockedBy: [],
    skills: [
      { name: "security-audit", role: "guard" },
      { name: "maestro-execute", role: "primary" },
      { name: "quality-test", role: "support" },
    ],
  }], true, 120);
  assert.match(lines.join("\n"), /\/maestro-execute \+2/);
});

test("todo widget bounds expanded rows and keeps actionable work first", () => {
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: String(index + 1),
    subject: index === 0 ? "Current work" : index === 1 ? "Blocked work" : `Task ${index + 1}`,
    status: index === 0 ? "in_progress" as const : index === 1 ? "blocked" as const : "completed" as const,
    blockedBy: index === 1 ? ["external"] : [],
    skills: [],
  }));

  const lines = renderTodoWidget(tasks, true, 120);

  assert.equal(lines.length, 10);
  assert.match(lines[1], /Current work/);
  assert.match(lines[2], /Blocked work/);
  assert.match(lines.at(-1) ?? "", /92 more/);
});

test("todo state version is 5", () => {
  assert.equal(getTodoCompactionSnapshot().stateVersion, 5);
});

test("todo next refuses to activate a second task", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-single-active-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({ action: "create", subject: "First" }, ctx);
    await executeTodo({ action: "create", subject: "Second" }, ctx);
    const first = await executeTodo({ action: "next" }, ctx);
    assert.equal((first as { isError?: boolean }).isError, undefined);

    const second = await executeTodo({ action: "next" }, ctx);
    assert.equal((second as { isError?: boolean }).isError, true);
    assert.match((second.content[0] as { text: string }).text, /already in progress/);
    assert.deepEqual(getVisibleTasks().map((task) => task.status), ["in_progress", "pending"]);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("root and teammates share Todo state with per-assignee active tasks and ownership permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-members-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();
  const api: TodoActorRef = { kind: "teammate", id: "api-correlation", label: "api", agentType: "worker" };
  const reviewer: TodoActorRef = { kind: "teammate", id: "review-correlation", label: "reviewer", agentType: "reviewer" };

  try {
    await executeTodo({ action: "create", subject: "Root task" }, ctx);
    await executeTodo({ action: "create", subject: "API task" }, ctx, api);
    await executeTodo({ action: "create", subject: "Review task" }, ctx, reviewer);

    const [rootTask, apiTask, reviewTask] = getVisibleTasks();
    assert.equal(rootTask.createdBy.id, "root");
    assert.equal(apiTask.createdBy.id, api.id);
    assert.equal(apiTask.assignee.id, api.id);

    await executeTodo({ action: "next" }, ctx);
    await executeTodo({ action: "next" }, ctx, api);
    assert.deepEqual(getVisibleTasks().map((task) => task.status), ["in_progress", "in_progress", "pending"]);

    const denied = await executeTodo({ action: "update", id: reviewTask.id, status: "completed" }, ctx, api);
    assert.equal((denied as { isError?: boolean }).isError, true);
    assert.match((denied.content[0] as { text: string }).text, /cannot update/);

    const activeReassign = await executeTodo({ action: "update", id: apiTask.id, assignee: "root" }, ctx, api);
    assert.equal((activeReassign as { isError?: boolean }).isError, true);
    assert.match((activeReassign.content[0] as { text: string }).text, /already in progress/);

    const handedBack = await executeTodo({ action: "update", id: apiTask.id, assignee: "root", status: "pending" }, ctx, api);
    assert.equal((handedBack as { isError?: boolean }).isError, undefined);
    assert.equal(getVisibleTasks().find((task) => task.id === apiTask.id)?.assignee.id, "root");

    const activeRootBeforeReassign = getVisibleTasks().find((task) => task.id === rootTask.id)!;
    const reassigned = await executeTodo({ action: "update", id: rootTask.id, assignee: reviewer.id }, ctx);
    assert.equal((reassigned as { isError?: boolean }).isError, undefined);
    const activeRootAfterReassign = getVisibleTasks().find((task) => task.id === rootTask.id)!;
    assert.equal(activeRootAfterReassign.assignee.id, reviewer.id);
    assert.notEqual(
      activeRootAfterReassign.skillActivation?.activationId,
      activeRootBeforeReassign.skillActivation?.activationId,
      "active reassignment must revalidate the task's activation snapshot",
    );
    const reviewerNext = await executeTodo({ action: "next" }, ctx, reviewer);
    assert.equal((reviewerNext as { isError?: boolean }).isError, true);
    assert.match((reviewerNext.content[0] as { text: string }).text, /already in progress/);

    const deniedClear = await executeTodo({ action: "clear" }, ctx, reviewer);
    assert.equal((deniedClear as { isError?: boolean }).isError, true);
    assert.equal(getVisibleTasks().length, 3);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent skill activations preserve one active task per assignee", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-activation-race-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, "---\nname: demo\ndescription: demo\n---\n# Gated demo\n");
  const skill: Skill = {
    name: "demo",
    description: "demo",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const entered = deferred();
  const release = deferred();
  let reloadCount = 0;
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: {
      async reload() {
        reloadCount++;
        if (reloadCount === 1) {
          entered.resolve();
          await release.promise;
        }
      },
      getSkills: () => ({ skills: [skill], diagnostics: [] }),
    },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({ action: "create", subject: "First", skills: [{ name: "demo", role: "primary" }] }, ctx);
    await executeTodo({ action: "create", subject: "Second", skills: [{ name: "demo", role: "primary" }] }, ctx);
    const [first, second] = getVisibleTasks();

    const activateFirst = executeTodo({ action: "update", id: first.id, status: "in_progress" }, ctx);
    const activateSecond = executeTodo({ action: "update", id: second.id, status: "in_progress" }, ctx);
    await entered.promise;
    release.resolve();
    const [firstResult, secondResult] = await Promise.all([activateFirst, activateSecond]);

    assert.equal((firstResult as { isError?: boolean }).isError, undefined);
    assert.equal((secondResult as { isError?: boolean }).isError, true);
    assert.match((secondResult.content[0] as { text: string }).text, /already in progress/);
    assert.equal(reloadCount, 1, "the rejected activation must not enter async skill loading");
    assert.deepEqual(getVisibleTasks().map((task) => task.status), ["in_progress", "pending"]);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("queued Todo updates cannot be overwritten by a stale activation draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-stale-draft-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, "---\nname: demo\ndescription: demo\n---\n# Gated demo\n");
  const skill: Skill = {
    name: "demo",
    description: "demo",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const entered = deferred();
  const release = deferred();
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: {
      async reload() {
        entered.resolve();
        await release.promise;
      },
      getSkills: () => ({ skills: [skill], diagnostics: [] }),
    },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({ action: "create", subject: "Original", skills: [{ name: "demo", role: "primary" }] }, ctx);
    const id = getVisibleTasks()[0].id;
    const activation = executeTodo({ action: "update", id, status: "in_progress" }, ctx);
    await entered.promise;
    const rename = executeTodo({ action: "update", id, subject: "Renamed while activating" }, ctx);
    release.resolve();
    await Promise.all([activation, rename]);

    assert.equal(getVisibleTasks()[0].subject, "Renamed while activating");
    assert.equal(getVisibleTasks()[0].status, "in_progress");
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("session generation fences late skill activation commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-generation-race-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, "---\nname: demo\ndescription: demo\n---\n# Gated demo\n");
  const skill: Skill = {
    name: "demo",
    description: "demo",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const entered = deferred();
  const release = deferred();
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: {
      async reload() {
        entered.resolve();
        await release.promise;
      },
      getSkills: () => ({ skills: [skill], diagnostics: [] }),
    },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({ action: "create", subject: "Old session", skills: [{ name: "demo", role: "primary" }] }, ctx);
    const id = getVisibleTasks()[0].id;
    const activation = executeTodo({ action: "update", id, status: "in_progress" }, ctx);
    await entered.promise;
    onSessionShutdown(todoContext);
    release.resolve();
    const result = await activation;

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match((result.content[0] as { text: string }).text, /session changed/);
    assert.deepEqual(getVisibleTasks(), []);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 Todo state migrates missing actor fields to root ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-v4-actor-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const now = Date.now();
  const todoContext = startTodo(root, loader, [{
    type: "custom",
    customType: "todo-state",
    data: {
      version: 4,
      tasks: {
        legacy: {
          id: "legacy",
          subject: "Legacy root task",
          status: "pending",
          blockedBy: [],
          skills: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  }]);
  try {
    const task = getVisibleTasks()[0];
    assert.deepEqual(task.createdBy, { kind: "root", id: "root", label: "root" });
    assert.deepEqual(task.assignee, { kind: "root", id: "root", label: "root" });
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("active skills inject through system prompt and context fallback without duplication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-injection-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, `---\nname: demo\ndescription: demo skill\n---\n# Injected demo`);
  const skill: Skill = {
    name: "demo",
    description: "demo skill",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [skill], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({
      action: "create",
      subject: "Inject",
      skills: [{ name: "demo", role: "primary" }],
    }, ctx);
    await executeTodo({ action: "next" }, ctx);

    const system = await onBeforeAgentStartTodo({ systemPrompt: "base" });
    assert.match(system?.systemPrompt ?? "", /<active_skill_stack>/);
    assert.match(system?.systemPrompt ?? "", /# Injected demo/);
    assert.equal(await onContextTodo([]), undefined);

    onAgentEndTodo();
    const fallback = await onContextTodo([]);
    assert.equal(fallback?.messages.length, 1);
    assert.equal(fallback?.messages[0].role, "custom");
    assert.match(String((fallback?.messages[0] as { content?: string }).content), /# Injected demo/);

    const active = getVisibleTasks()[0];
    await executeTodo({ action: "update", id: active.id, status: "completed" }, ctx);
    assert.equal(await onContextTodo([]), undefined);
    assert.equal(await onBeforeAgentStartTodo({ systemPrompt: "base" }), undefined);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-skill injection reuses duplicate required reading content", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-required-dedupe-"));
  const sharedPath = join(root, "shared.md");
  await writeFile(sharedPath, "SHARED REQUIRED CONTENT");
  const skills: Skill[] = [];
  for (const name of ["guard", "primary"]) {
    const skillDir = join(root, ".pi", "skills", name);
    const filePath = join(skillDir, "SKILL.md");
    await mkdir(skillDir, { recursive: true });
    await writeFile(filePath, `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n<required_reading>\n@${sharedPath}\n</required_reading>`);
    skills.push({
      name,
      description: name,
      filePath,
      baseDir: skillDir,
      sourceInfo: {} as Skill["sourceInfo"],
      disableModelInvocation: false,
    });
  }
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills, diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    await executeTodo({
      action: "create",
      subject: "Dedupe",
      skills: [
        { name: "primary", role: "primary" },
        { name: "guard", role: "guard" },
      ],
    }, ctx);
    await executeTodo({ action: "next" }, ctx);
    const system = await onBeforeAgentStartTodo({ systemPrompt: "base" });
    const prompt = system?.systemPrompt ?? "";
    assert.equal(prompt.split("SHARED REQUIRED CONTENT").length - 1, 1);
    assert.match(prompt, /required reading reused from earlier skill/);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("active skill metadata resumes and marks changed skill content stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-resume-skill-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, `---\nname: demo\ndescription: demo\n---\n# Original`);
  const skill: Skill = {
    name: "demo",
    description: "demo",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [skill], diagnostics: [] }) },
  });
  let persisted: unknown;
  initTodo({ appendEntry(_type: string, data: unknown) { persisted = structuredClone(data); } } as never);
  const context = (entries: unknown[] = []): TodoContext => ({
    cwd: root,
    ui: { setStatus() {} },
    skillLoader: loader,
    sessionManager: { getEntries: () => entries },
  });
  const ctx = makeExtensionContext();

  try {
    onSessionStart(context());
    await executeTodo({
      action: "create",
      subject: "Resume",
      skills: [{ name: "demo", role: "primary" }],
    }, ctx);
    await executeTodo({ action: "next" }, ctx);
    const original = structuredClone(getVisibleTasks()[0].skillActivation);
    const persistedText = JSON.stringify(persisted);
    assert.doesNotMatch(persistedText, /# Original/);
    assert.doesNotMatch(persistedText, /active_skill_stack/);
    assert.doesNotMatch(persistedText, /"prompt"\s*:/);
    const entries = [{ type: "custom", customType: "todo-state", data: persisted }];

    onSessionShutdown(context());
    onSessionStart(context(entries));
    await onBeforeAgentStartTodo({ systemPrompt: "base" });
    assert.equal(getVisibleTasks()[0].skillActivation?.activationId, original?.activationId);
    assert.equal(getVisibleTasks()[0].skillActivation?.state, "active");

    onSessionShutdown(context());
    await writeFile(skillPath, `---\nname: demo\ndescription: demo\n---\n# Changed content with a different size`);
    onSessionStart(context(entries));
    await assert.rejects(
      onBeforeAgentStartTodo({ systemPrompt: "base" }),
      /skill activation is stale/,
    );
    assert.equal(getVisibleTasks()[0].skillActivation?.state, "stale");
  } finally {
    onSessionShutdown(context());
    await rm(root, { recursive: true, force: true });
  }
});

test("todo update activates skills and leaves task and activation snapshots unchanged on errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-update-atomic-"));
  const skillDir = join(root, ".pi", "skills", "demo");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, "---\nname: demo\ndescription: demo\n---\n# Atomic demo\n");
  const skill: Skill = {
    name: "demo",
    description: "demo",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [skill], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    const created = await executeTodo({
      action: "create",
      subject: "Atomic update",
      context: "original context",
      skills: [{ name: "demo", role: "primary" }],
    }, ctx);
    const id = (created.details as { tasks: Array<{ id: string }> }).tasks[0].id;
    const activated = await executeTodo({ action: "update", id, status: "in_progress" }, ctx);
    assert.equal((activated as { isError?: boolean }).isError, undefined);
    assert.equal(getVisibleTasks()[0].status, "in_progress");
    assert.match(getVisibleTasks()[0].skillActivation?.activationId ?? "", /^[0-9a-f-]{36}$/);
    assert.match((await onBeforeAgentStartTodo({ systemPrompt: "base" }))?.systemPrompt ?? "", /# Atomic demo/);

    const beforeValidationError = getTodoCompactionSnapshot();
    const validationError = await executeTodo({
      action: "update",
      id,
      context: "must not leak",
      blockedBy: ["missing"],
    }, ctx);
    assert.equal((validationError as { isError?: boolean }).isError, true);
    assert.deepEqual(getTodoCompactionSnapshot(), beforeValidationError);

    initTodo({ appendEntry() { throw new Error("persist failed"); } } as never);
    const beforePersistError = getTodoCompactionSnapshot();
    const persistError = await executeTodo({
      action: "update",
      id,
      context: "must not commit",
    }, ctx);
    assert.equal((persistError as { isError?: boolean }).isError, true);
    assert.match((persistError.content[0] as { text: string }).text, /persist failed/);
    assert.deepEqual(getTodoCompactionSnapshot(), beforePersistError);
    assert.match((await onBeforeAgentStartTodo({ systemPrompt: "base" }))?.systemPrompt ?? "", /# Atomic demo/);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo create, next, delete, and clear publish no live state when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-public-mutation-atomic-"));
  const skillDir = join(root, ".pi", "skills", "atomic");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, "---\nname: atomic\ndescription: atomic\n---\n# Atomic mutation skill\n");
  const skill: Skill = {
    name: "atomic",
    description: "atomic",
    filePath: skillPath,
    baseDir: skillDir,
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [skill], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();
  const useSuccessfulPersist = () => initTodo({ appendEntry() {} } as never);
  const useFailingPersist = () => initTodo({
    appendEntry() { throw new Error("persist failed"); },
  } as never);
  const assertLiveSnapshotUnchanged = (before: ReturnType<typeof getTodoCompactionSnapshot>) => {
    const after = getTodoCompactionSnapshot();
    assert.equal(after.revision, before.revision);
    assert.equal(after.activeTaskId, before.activeTaskId);
    assert.deepEqual(after.tasks, before.tasks);
  };

  try {
    useFailingPersist();
    const beforeCreate = getTodoCompactionSnapshot();
    const createError = await executeTodo({ action: "create", subject: "Must not exist" }, ctx);
    assert.equal((createError as { isError?: boolean }).isError, true);
    assert.match((createError.content[0] as { text: string }).text, /persist failed/);
    assertLiveSnapshotUnchanged(beforeCreate);

    useSuccessfulPersist();
    const created = await executeTodo({
      action: "create",
      subject: "Atomic task",
      skills: [{ name: "atomic", role: "primary" }],
    }, ctx);
    const id = (created.details as { tasks: Array<{ id: string }> }).tasks[0].id;

    useFailingPersist();
    const beforeNext = getTodoCompactionSnapshot();
    const nextError = await executeTodo({ action: "next" }, ctx);
    assert.equal((nextError as { isError?: boolean }).isError, true);
    assert.match((nextError.content[0] as { text: string }).text, /persist failed/);
    assertLiveSnapshotUnchanged(beforeNext);
    assert.equal(getVisibleTasks()[0].skillActivation, undefined);

    useSuccessfulPersist();
    await executeTodo({ action: "next" }, ctx);
    assert.equal(getVisibleTasks()[0].status, "in_progress");
    assert.ok(getVisibleTasks()[0].skillActivation);

    useFailingPersist();
    const beforeDelete = getTodoCompactionSnapshot();
    const deleteError = await executeTodo({ action: "delete", id }, ctx);
    assert.equal((deleteError as { isError?: boolean }).isError, true);
    assert.match((deleteError.content[0] as { text: string }).text, /persist failed/);
    assertLiveSnapshotUnchanged(beforeDelete);
    assert.match(
      (await onBeforeAgentStartTodo({ systemPrompt: "base" }))?.systemPrompt ?? "",
      /# Atomic mutation skill/,
    );

    const beforeClear = getTodoCompactionSnapshot();
    const clearError = await executeTodo({ action: "clear" }, ctx);
    assert.equal((clearError as { isError?: boolean }).isError, true);
    assert.match((clearError.content[0] as { text: string }).text, /persist failed/);
    assertLiveSnapshotUnchanged(beforeClear);
    assert.match(
      (await onBeforeAgentStartTodo({ systemPrompt: "base" }))?.systemPrompt ?? "",
      /# Atomic mutation skill/,
    );
  } finally {
    useSuccessfulPersist();
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo dependencies reject deleted tasks, drop completed tasks, and derive blocked or pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-dependencies-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    const completedResult = await executeTodo({ action: "create", subject: "Completed dependency" }, ctx);
    const activeResult = await executeTodo({ action: "create", subject: "Active dependency" }, ctx);
    const completedId = (completedResult.details as { tasks: Array<{ id: string }> }).tasks[0].id;
    const activeId = (activeResult.details as { tasks: Array<{ id: string }> }).tasks
      .find((task) => task.id !== completedId)!.id;
    await executeTodo({ action: "update", id: completedId, status: "completed" }, ctx);

    const childResult = await executeTodo({
      action: "create",
      subject: "Child",
      blockedBy: [completedId, activeId, completedId],
    }, ctx);
    const childId = (childResult.details as { tasks: Array<{ id: string }> }).tasks
      .find((task) => task.id !== completedId && task.id !== activeId)!.id;
    let child = getVisibleTasks().find((task) => task.id === childId)!;
    assert.equal(child.status, "blocked");
    assert.deepEqual(child.blockedBy, [activeId]);

    const blockedActivation = await executeTodo({ action: "update", id: childId, status: "in_progress" }, ctx);
    assert.equal((blockedActivation as { isError?: boolean }).isError, true);
    assert.match((blockedActivation.content[0] as { text: string }).text, /blocked by/);
    assert.equal(getVisibleTasks().find((task) => task.id === childId)?.status, "blocked");

    await executeTodo({ action: "update", id: childId, blockedBy: [completedId] }, ctx);
    child = getVisibleTasks().find((task) => task.id === childId)!;
    assert.equal(child.status, "pending");
    assert.deepEqual(child.blockedBy, []);

    await executeTodo({ action: "update", id: childId, blockedBy: [activeId] }, ctx);
    await executeTodo({ action: "update", id: activeId, status: "completed" }, ctx);
    child = getVisibleTasks().find((task) => task.id === childId)!;
    assert.equal(child.status, "pending");
    assert.deepEqual(child.blockedBy, []);

    await executeTodo({ action: "delete", id: activeId }, ctx);
    const beforeDeletedError = getTodoCompactionSnapshot();
    const deletedError = await executeTodo({ action: "update", id: childId, blockedBy: [activeId] }, ctx);
    assert.equal((deletedError as { isError?: boolean }).isError, true);
    assert.match((deletedError.content[0] as { text: string }).text, /deleted task/);
    assert.deepEqual(getTodoCompactionSnapshot(), beforeDeletedError);

    const createDeletedError = await executeTodo({
      action: "create",
      subject: "Invalid deleted dependency",
      blockedBy: [activeId],
    }, ctx);
    assert.equal((createDeletedError as { isError?: boolean }).isError, true);
    assert.match((createDeletedError.content[0] as { text: string }).text, /deleted task/);
    assert.deepEqual(getTodoCompactionSnapshot(), beforeDeletedError);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo update keeps blocked work pending when skill activation fails after unblocking", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-update-skill-error-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const todoContext = startTodo(root, loader);
  const ctx = makeExtensionContext();

  try {
    const blockerResult = await executeTodo({ action: "create", subject: "Blocker" }, ctx);
    const blockerId = (blockerResult.details as { tasks: Array<{ id: string }> }).tasks[0].id;
    const childResult = await executeTodo({
      action: "create",
      subject: "Missing skill child",
      blockedBy: [blockerId],
      skills: [{ name: "missing", role: "primary" }],
    }, ctx);
    const childId = (childResult.details as { tasks: Array<{ id: string }> }).tasks
      .find((task) => task.id !== blockerId)!.id;
    await executeTodo({ action: "update", id: blockerId, status: "completed" }, ctx);
    const before = getTodoCompactionSnapshot();

    const result = await executeTodo({ action: "update", id: childId, status: "in_progress" }, ctx);
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match((result.content[0] as { text: string }).text, /E_SKILL_NOT_FOUND/);
    assert.deepEqual(getTodoCompactionSnapshot(), before);
    assert.equal(getVisibleTasks().find((task) => task.id === childId)?.status, "pending");
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

test("todo next reports legacy dependency deadlocks and normalizes completed blockers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-todo-deadlock-"));
  const loader = new TodoSkillLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: { async reload() {}, getSkills: () => ({ skills: [], diagnostics: [] }) },
  });
  const entries = [{
    type: "custom",
    customType: "todo-state",
    data: {
      version: 2,
      tasks: {
        completed: {
          id: "completed",
          subject: "Completed",
          status: "completed",
          blockedBy: [],
          createdAt: 1,
          updatedAt: 1,
        },
        released: {
          id: "released",
          subject: "Released",
          status: "blocked",
          blockedBy: ["completed"],
          createdAt: 2,
          updatedAt: 2,
        },
        cycleA: {
          id: "cycleA",
          subject: "Cycle A",
          status: "blocked",
          blockedBy: ["cycleB"],
          createdAt: 3,
          updatedAt: 3,
        },
        cycleB: {
          id: "cycleB",
          subject: "Cycle B",
          status: "blocked",
          blockedBy: ["cycleA"],
          createdAt: 4,
          updatedAt: 4,
        },
      },
    },
  }];
  const todoContext = startTodo(root, loader, entries);
  const ctx = makeExtensionContext();

  try {
    const released = getVisibleTasks().find((task) => task.id === "released")!;
    assert.equal(released.status, "pending");
    assert.deepEqual(released.blockedBy, []);
    await executeTodo({ action: "update", id: "released", status: "completed" }, ctx);

    const next = await executeTodo({ action: "next" }, ctx);
    const text = (next.content[0] as { text: string }).text;
    assert.equal((next as { isError?: boolean }).isError, true);
    assert.match(text, /Dependency deadlock/);
    assert.match(text, /#cycleA/);
    assert.match(text, /#cycleB/);
    assert.doesNotMatch(text, /All tasks completed/);
  } finally {
    onSessionShutdown(todoContext);
    await rm(root, { recursive: true, force: true });
  }
});

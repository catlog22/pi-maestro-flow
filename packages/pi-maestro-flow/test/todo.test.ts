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
  assert.ok(properties.summary);
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

test("todo state version is 4", () => {
  assert.equal(getTodoCompactionSnapshot().stateVersion, 4);
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

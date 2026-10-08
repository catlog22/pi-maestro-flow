import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import {
  configureClassifier, resetClassifierForTest, registerBuiltinClassifyDomains, classifierStatus,
  type ClassifierConfig,
} from "pi-maestro-teammate/v1/classify";
import { listHandoffAdviceTasks, previewHandoffAdvice, applyHandoffAdvice } from "../src/classifier/handoff-advice.ts";
import {
  executeTodo, initTodo, onSessionStart, onSessionShutdown, getVisibleTasks,
  getTodoCompactionSnapshot, registerTodoActor, captureTodoHandoffAdvice, applyTodoHandoffAdviceCAS,
} from "../src/tools/todo.ts";
import { TodoSkillLoader } from "../src/skills/skill-loader.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const actorEnv = { child: process.env.PI_TEAMMATE_CHILD, managed: process.env.PI_TEAMMATE_MANAGED_WINDOW };
  delete process.env.PI_TEAMMATE_CHILD;
  delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
  const cwd = await mkdtemp(join(tmpdir(), "handoff-advice-"));
  let sessionId = "root-session";
  const messages: string[] = [];
  const requests: string[] = [];
  const entries: unknown[] = [];
  const ctx = {
    cwd, hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: { setStatus() {}, async confirm(_title: string, message: string) { messages.push(message); return true; } },
  } as unknown as ExtensionContext;
  initTodo({ appendEntry(_type: string, data: unknown) { entries.push(data); } } as never);
  onSessionStart(ctx);
  resetClassifierForTest();
  registerBuiltinClassifyDomains();
  function configure(label = "required", confidence = 0.9, overrides: Partial<ClassifierConfig> = {}) {
    configureClassifier({ enabled: true, hostVersion: "0.98.0", endpoint: "openrouter", apiKey: "mock-only",
      domains: { "file-value": "jev" },
      fetchFn: (async (_url, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({ model: "mock-jev", answers: { value: { type: "choice", choice: label, confidence } } }));
      }) as typeof fetch, ...overrides });
  }
  configure();
  const created = await executeTodo({ action: "create", subject: "Root task", context: "Background only",
    handoff: { nextSteps: ["Review the named subsystem contract"], files: [
      { path: "does-not-exist.ts", value: "unknown", reason: "Contract relevant to the next action" },
      { path: "keep.ts", value: "required", reason: "Already explicit" },
      { path: "conditional.ts", value: "conditional", reason: "Already explicit", when: "Editing its API" },
      { path: "skip.ts", value: "skip", reason: "Already explicit" },
    ] }, resourceUris: ["agent://evidence"], planHandoffKey: "approved-plan" }, ctx);
  assert.equal(created.isError, undefined);
  const id = getVisibleTasks()[0]!.id;
  return { ctx, cwd, id, messages, requests, entries, configure,
    setSession: (id: string) => { sessionId = id; },
    async close() {
      onSessionShutdown(ctx); resetClassifierForTest(); await rm(cwd, { recursive: true, force: true });
      if (actorEnv.child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = actorEnv.child;
      if (actorEnv.managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = actorEnv.managed;
    } };
}
const selection = [{ path: "does-not-exist.ts" }];

test("preview is unknown-only and file-byte-free; confirmed apply preserves all other fields and tombstones", async () => {
  const f = await fixture();
  try {
    const task = getVisibleTasks()[0]!;
    // Persisted clear history must survive a later unknown-only merge.
    await executeTodo({ action: "update", id: f.id, handoff: { files: [] } }, f.ctx);
    await executeTodo({ action: "update", id: f.id, handoff: { files: task.handoff!.files } }, f.ctx);
    const before = structuredClone(getVisibleTasks()[0]!);
    const preview = await previewHandoffAdvice(f.ctx, f.id);
    assert.equal(preview.status, "ready");
    assert.equal(preview.rows.length, 1);
    assert.equal(preview.rows[0]!.eligible, true);
    assert.equal(preview.rows[0]!.model, "mock-jev");
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0]!, /Next action/);
    const result = await applyHandoffAdvice(f.ctx, preview, selection);
    assert.equal(result.status, "applied");
    assert.equal(f.messages.length, 1);
    const confirmation = JSON.parse(f.messages[0]!);
    assert.equal(confirmation.taskId, f.id);
    assert.equal(confirmation.nextAction, preview.nextAction);
    assert.deepEqual(confirmation.changes[0].original, before.handoff!.files[0]);
    assert.equal(confirmation.changes[0].proposed.value, "required");
    const after = structuredClone(getVisibleTasks()[0]!);
    assert.equal(after.handoff!.files[0]!.value, "required");
    assert.deepEqual(after.handoff!.files.slice(1), before.handoff!.files.slice(1));
    assert.equal(after.handoff!.filesClearedRevision, before.handoff!.filesClearedRevision);
    assert.equal(after.handoff!.nextStepsRevision, before.handoff!.nextStepsRevision);
    assert.deepEqual(after.handoff!.nextSteps, before.handoff!.nextSteps);
    const { handoff: _ah, updatedAt: _au, ...stableAfter } = after;
    const { handoff: _bh, updatedAt: _bu, ...stableBefore } = before;
    assert.deepEqual(stableAfter, stableBefore);
    assert.equal((await applyHandoffAdvice(f.ctx, preview, selection)).status, "blocked");
  } finally { await f.close(); }
});

test("no explicit next action means no classifier call; explicit context marker is accepted", async () => {
  const f = await fixture();
  try {
    await executeTodo({ action: "update", id: f.id, handoff: { nextSteps: [] } }, f.ctx);
    const preview = await previewHandoffAdvice(f.ctx, f.id);
    assert.equal(preview.status, "blocked");
    assert.match(preview.error!, /No explicit next action/);
    assert.equal(f.requests.length, 0);
    await executeTodo({ action: "update", id: f.id, context: "Next action: Review the contract" }, f.ctx);
    assert.equal((await previewHandoffAdvice(f.ctx, f.id)).status, "ready");
  } finally { await f.close(); }
});

for (const variant of ["disabled", "off", "shadow", "lowconfidence", "unknown", "failure", "budget"] as const) {
  test(`${variant} never applies model advice`, async () => {
    const f = await fixture();
    try {
      if (variant === "disabled") f.configure("required", 0.9, { enabled: false });
      if (variant === "off" || variant === "shadow") f.configure("required", 0.9, { domains: { "file-value": variant } });
      if (variant === "lowconfidence") f.configure("required", 0.79);
      if (variant === "unknown") f.configure("unknown");
      if (variant === "failure") f.configure("required", 0.9, { fetchFn: (async () => { throw new Error("mock offline"); }) as typeof fetch });
      if (variant === "budget") f.configure("required", 0.9, { maxCallsPerSession: 0 });
      const before = getTodoCompactionSnapshot();
      const preview = await previewHandoffAdvice(f.ctx, f.id);
      const result = await applyHandoffAdvice(f.ctx, preview, selection);
      assert.notEqual(result.status, "applied");
      assert.equal(f.messages.length, 0);
      assert.deepEqual(getTodoCompactionSnapshot(), before);
      if (variant === "disabled" || variant === "off" || variant === "budget") assert.equal(f.requests.length, 0);
      if (variant === "budget") assert.equal(classifierStatus().callsUsed, 0);
    } finally { await f.close(); }
  });
}

test("conditional needs concrete human when, then exact host confirmation", async () => {
  const f = await fixture();
  try {
    f.configure("conditional");
    let preview = await previewHandoffAdvice(f.ctx, f.id);
    assert.equal(preview.rows[0]!.needsWhen, true);
    assert.equal(preview.rows[0]!.eligible, false);
    assert.equal((await applyHandoffAdvice(f.ctx, preview, selection)).status, "blocked");
    assert.equal(f.messages.length, 0);
    preview = await previewHandoffAdvice(f.ctx, f.id);
    assert.equal((await applyHandoffAdvice(f.ctx, preview, [{ ...selection[0]!, when: "When editing the public API" }])).status, "applied");
    assert.equal(getVisibleTasks()[0]!.handoff!.files[0]!.when, "When editing the public API");
    assert.match(f.messages[0]!, /When editing the public API/);
  } finally { await f.close(); }
});

test("host cancellation/no UI/untrusted clones never authorize; mutated preview cannot change verdict", async () => {
  const f = await fixture();
  try {
    const before = getTodoCompactionSnapshot();
    let preview = await previewHandoffAdvice(f.ctx, f.id);
    assert.equal((await applyHandoffAdvice(f.ctx, structuredClone(preview), selection)).status, "blocked");
    f.ctx.ui.confirm = async () => false;
    assert.equal((await applyHandoffAdvice(f.ctx, preview, selection)).status, "cancelled");
    assert.deepEqual(getTodoCompactionSnapshot(), before);
    preview = await previewHandoffAdvice(f.ctx, f.id);
    (f.ctx as unknown as { hasUI: boolean }).hasUI = false;
    assert.equal((await applyHandoffAdvice(f.ctx, preview, selection)).status, "blocked");
    (f.ctx as unknown as { hasUI: boolean }).hasUI = true;
    f.ctx.ui.confirm = async () => true;
    f.configure("required", 0.2);
    preview = await previewHandoffAdvice(f.ctx, f.id);
    Object.assign(preview.rows[0]!, { confidence: 1, eligible: true, label: "required" });
    assert.equal((await applyHandoffAdvice(f.ctx, preview, selection)).status, "blocked");
    assert.deepEqual(getTodoCompactionSnapshot(), before);
  } finally { await f.close(); }
});

for (const change of ["task", "handoff", "directtask", "directhandoff", "actor", "revision", "cwd", "session", "manager", "lifecycle", "child", "managed", "config", "abort"] as const) {
  test(`confirmation fences ${change} changes without retrying approval`, async () => {
    const f = await fixture();
    const child = process.env.PI_TEAMMATE_CHILD;
    const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
    try {
      const controller = new AbortController();
      const preview = await previewHandoffAdvice(f.ctx, f.id);
      f.ctx.ui.confirm = async () => {
        if (change === "task") await executeTodo({ action: "update", id: f.id, context: "New task scope" }, f.ctx);
        if (change === "handoff") await executeTodo({ action: "update", id: f.id, handoff: { files: [] } }, f.ctx);
        if (change === "directtask") getVisibleTasks()[0]!.context = "Scope changed outside the tool queue";
        if (change === "directhandoff") getVisibleTasks()[0]!.handoff!.nextSteps = ["Different next action"];
        if (change === "manager") (f.ctx as unknown as { sessionManager: unknown }).sessionManager = { ...f.ctx.sessionManager };
        if (change === "actor") {
          registerTodoActor({ id: "child", kind: "teammate", label: "child" });
          await executeTodo({ action: "update", id: f.id, assignee: "child" }, f.ctx);
        }
        if (change === "revision") await executeTodo({ action: "create", subject: "Unrelated change" }, f.ctx);
        if (change === "cwd") (f.ctx as unknown as { cwd: string }).cwd = "different-workspace";
        if (change === "session") f.setSession("other-session");
        if (change === "lifecycle") { onSessionShutdown(f.ctx); onSessionStart(f.ctx); }
        if (change === "child") process.env.PI_TEAMMATE_CHILD = "1";
        if (change === "managed") process.env.PI_TEAMMATE_MANAGED_WINDOW = "1";
        if (change === "config") f.configure("required", 0.9, { domains: { "file-value": "off" } });
        if (change === "abort") controller.abort();
        return true;
      };
      const result = await applyHandoffAdvice(f.ctx, preview, selection, controller.signal);
      assert.equal(result.status, "stale");
      assert.ok(!getVisibleTasks()[0]?.handoff?.files.some((file) => file.path === selection[0]!.path && file.value === "required"));
      assert.equal((await applyHandoffAdvice(f.ctx, preview, selection)).status, "blocked");
    } finally {
      if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
      if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
      await f.close();
    }
  });
}

test("list excludes teammate and canonical mirror projections, and refuses different host manager", async () => {
  const f = await fixture();
  try {
    registerTodoActor({ id: "child", kind: "teammate", label: "child" });
    await executeTodo({ action: "create", subject: "Child", assignee: "child" }, f.ctx);
    assert.deepEqual(listHandoffAdviceTasks(f.ctx).map((task) => task.taskId), [f.id]);
    const live = getVisibleTasks()[0]!;
    live.origin = { sessionId: "remote", taskId: "projection" } as never;
    assert.equal(listHandoffAdviceTasks(f.ctx).length, 0);
    delete live.origin;
    assert.throws(() => listHandoffAdviceTasks({ ...f.ctx, sessionManager: { ...f.ctx.sessionManager } } as ExtensionContext), /canonical root/);
  } finally { await f.close(); }
});

test("queued CAS checks AFTER a previously queued async mutation commits", async () => {
  const f = await fixture();
  try {
    const skillDir = join(f.cwd, ".pi", "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    await writeFile(filePath, "---\nname: demo\ndescription: demo\n---\n# Demo\n");
    const entered = deferred();
    const release = deferred();
    let reloads = 0;
    const skill: Skill = { name: "demo", description: "demo", filePath, baseDir: skillDir,
      sourceInfo: {} as Skill["sourceInfo"], disableModelInvocation: false };
    onSessionStart({ ...f.ctx, skillLoader: new TodoSkillLoader({ cwd: f.cwd, resourceLoader: {
      async reload() { reloads++; entered.resolve(); await release.promise; },
      getSkills: () => ({ skills: [skill], diagnostics: [] }),
    } }) });
    await executeTodo({ action: "create", subject: "Gated", skills: [{ name: "demo", role: "primary" }],
      handoff: { nextSteps: ["Review demo"], files: [{ path: selection[0]!.path, value: "unknown", reason: "Review demo contract" }] } }, f.ctx);
    const id = getVisibleTasks()[0]!.id;
    const preview = await previewHandoffAdvice(f.ctx, id);
    const queued = executeTodo({ action: "update", id, status: "in_progress" }, f.ctx);
    await entered.promise;
    let confirmed = false;
    f.ctx.ui.confirm = async () => { confirmed = true; return true; };
    const applying = applyHandoffAdvice(f.ctx, preview, selection);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(confirmed, true);
    assert.equal(getVisibleTasks()[0]!.status, "pending");
    release.resolve();
    assert.equal((await queued).isError, undefined);
    assert.equal((await applying).status, "stale");
    assert.equal(getVisibleTasks()[0]!.handoff!.files[0]!.value, "unknown");
    const before = structuredClone(getVisibleTasks()[0]!.skillActivation);
    const fresh = await previewHandoffAdvice(f.ctx, id);
    assert.equal((await applyHandoffAdvice(f.ctx, fresh, selection)).status, "applied");
    assert.deepEqual(getVisibleTasks()[0]!.skillActivation, before);
    assert.equal(reloads, 1, "handoff-only update must not load skills");
  } finally { await f.close(); }
});

test("host confirmation escapes bidi without changing exact handoff metadata", async () => {
  const f = await fixture();
  try {
    const path = "contract\u202ets";
    const reason = "Review \u2066public contract\u2069";
    const nextStep = "Next \u200faction";
    await executeTodo({ action: "update", id: f.id, handoff: { nextSteps: [nextStep],
      files: [{ path, value: "unknown", reason }] } }, f.ctx);
    const preview = await previewHandoffAdvice(f.ctx, f.id);
    assert.equal((await applyHandoffAdvice(f.ctx, preview, [{ path }])).status, "applied");
    const message = f.messages[0]!;
    assert.doesNotMatch(message, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    assert.ok(message.includes("\\u202e"));
    const confirmed = JSON.parse(message);
    assert.equal(confirmed.nextAction, nextStep);
    assert.equal(confirmed.changes[0].original.path, path);
    assert.equal(confirmed.changes[0].proposed.reason, reason);
    assert.equal(getVisibleTasks()[0]!.handoff!.files.find(file => file.path === path)?.reason, reason);
  } finally { await f.close(); }
});

test("host CAS revalidates unknown-only even for trusted callers", async () => {
  const f = await fixture();
  try {
    const snapshot = captureTodoHandoffAdvice(f.ctx, f.id);
    const before = getTodoCompactionSnapshot();
    const result = await applyTodoHandoffAdviceCAS(f.ctx, snapshot,
      [{ path: "keep.ts", value: "skip", reason: "Cannot overwrite" }], () => {});
    assert.equal(result.isError, true);
    assert.deepEqual(getTodoCompactionSnapshot(), before);
  } finally { await f.close(); }
});

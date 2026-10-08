import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classify, configureClassifier, resetClassifierForTest, type ClassifyResult } from "pi-maestro-teammate/v1/classify";
import * as supervision from "pi-maestro-teammate/v1/supervision";
import { publishTeammateHostBoundary } from "../../pi-maestro-teammate/src/runs/host-observers.ts";
import { todoProgressDomain } from "../src/classifier/domains.ts";
import { DEFAULT_TODO_REVIEW_CONFIG, normalizeTodoReviewConfig, TodoReviewMonitor, type TodoProgressLabel } from "../src/advisor/todo-review.ts";
import { TodoReviewHost } from "../src/advisor/todo-review-host.ts";
import registerAdvisor, { setAdvisorConfigWriteBarrierForTest, setAdvisorTeammateRuntimeForTest } from "../src/advisor/extension.ts";
import { executeTodo, initTodo, onSessionStart, onSessionShutdown, registerTodoActor, type TodoContext, type TodoTask } from "../src/tools/todo.ts";

const cfg = { ...DEFAULT_TODO_REVIEW_CONFIG, enabled: true, cooldownMs: 0 };
function task(id = "1", actor = "root"): TodoTask {
  return { id, subject: "Fix leak; verify tests", description: "Acceptance: no leaked connection", status: "in_progress", blockedBy: [], skills: [], resourceUris: [],
    createdBy: { id: "root", kind: "root", label: "root" }, assignee: { id: actor, kind: actor === "root" ? "root" : "teammate", label: actor },
    createdAt: 1, updatedAt: 1, activeStartedAt: 1 };
}
function setup(overrides = {}) {
  let now = 0;
  const monitor = new TodoReviewMonitor({ ...cfg, ...overrides }, () => now);
  const todo = task(); monitor.sync([todo]);
  const step = () => { monitor.start("root", "session"); monitor.end("root"); };
  return { monitor, todo, step, time: (n: number) => { now += n; } };
}
const looping: ClassifyResult<TodoProgressLabel> = { label: "looping", confidence: 1, layer: "rule" };
const uncertain: ClassifyResult<TodoProgressLabel> = { label: "uncertain", confidence: 0, layer: "degraded", degradedReason: "timeout" };
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); };
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "test condition timed out"); await flush(); }
}

test("explicit config defaults preserve disabled behavior and bounded integers", () => {
  assert.equal(normalizeTodoReviewConfig(undefined).enabled, false);
  assert.equal(cfg.reviewSteps, 12); assert.equal(cfg.reviewActiveMs, 480000);
  assert.equal(cfg.reflectionSteps, 6); assert.equal(cfg.unresolvedSteps, 24); assert.equal(cfg.unresolvedActiveMs, 900000);
  const normalized = normalizeTodoReviewConfig({ enabled: true, reviewSteps: 2.9, reviewActiveMs: Infinity, sameFailureLimit: -1, cooldownMs: -3, maxReviewsPerTask: 1e9, mode: "invalid" });
  assert.equal(normalized.reviewSteps, 2); assert.equal(normalized.reviewActiveMs, 480000);
  assert.equal(normalized.sameFailureLimit, 1); assert.equal(normalized.cooldownMs, 0);
  assert.equal(normalized.maxReviewsPerTask, 10000); assert.equal(normalized.mode, "active");
});
test("12 iterations at turn_end, not tools; captures one in-flight review", () => {
  const { monitor, step } = setup();
  for (let i = 0; i < 11; i++) step();
  assert.equal(monitor.capture("root"), undefined);
  monitor.start("root", "session");
  for (let i = 0; i < 30; i++) monitor.outcome("root", "read", { path: "same" }, "same", false);
  assert.equal(monitor.capture("root"), undefined);
  monitor.end("root"); const ticket = monitor.capture("root"); assert.ok(ticket);
  assert.equal(ticket.input.steps, 12); assert.equal(Object.hasOwn(ticket.input, "verifiedProgress"), false);
  assert.equal(monitor.capture("root"), undefined);
  monitor.reset();
});
test("8 minutes effective execution marks due without any tool result; review only at boundary", async () => {
  const monitor = new TodoReviewMonitor({ ...cfg, reviewActiveMs: 10, reviewSteps: 10000 });
  monitor.sync([task()]); monitor.start("root", "session");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal([...monitor.states.values()][0]?.due, true);
  assert.equal([...monitor.states.values()][0]?.reviews, 0);
  monitor.end("root"); assert.ok(monitor.capture("root")); monitor.reset();
});
test("user/capacity/dependency/tool waits and offline time are not effective work", () => {
  const { monitor, time } = setup(); monitor.start("root", "session"); time(100);
  for (const reason of ["user", "capacity", "dependency", "tool:long"]) { monitor.pause("root", reason, true); time(600000); monitor.pause("root", reason, false); }
  monitor.offline("root"); time(600000); monitor.start("root", "session"); time(100); monitor.end("root");
  const state = [...monitor.states.values()][0]!; assert.equal(state.activeMs, 200); assert.equal(state.steps, 1);
  assert.equal(monitor.capture("root"), undefined); monitor.reset();
});
test("advancing or reassigning during an iteration does not count toward the replacement task", () => {
  const { monitor, todo } = setup(); monitor.start("root", "session");
  const next = task("2"); monitor.sync([{ ...todo, status: "completed" }, next]); monitor.end("root");
  assert.equal([...monitor.states.values()].find((state) => state.taskId === "2")?.steps, 0);
  monitor.start("root", "session"); monitor.sync([{ ...next, assignee: { kind: "teammate", id: "child", label: "child" } }]); monitor.end("root"); monitor.end("child");
  assert.equal([...monitor.states.values()].find((state) => state.actor === "child")?.steps, 0); monitor.reset();
});
test("same-problem 3 failures trigger, unrelated errors and successful intervening tools do not", () => {
  const { monitor } = setup();
  const failure = (path: string) => { monitor.start("root", "session"); monitor.outcome("root", "bash", { command: path }, "exit 1", true); monitor.end("root"); };
  failure("a"); failure("b"); failure("c"); assert.equal(monitor.capture("root"), undefined);
  failure("same"); failure("same"); assert.equal(monitor.capture("root"), undefined);
  failure("same"); const ticket = monitor.capture("root"); assert.ok(ticket); assert.equal(ticket.input.sameFailures, 3); monitor.reset();
});
test("reflection precedes external advice by six steps; token/context changes are not evidence", () => {
  const { monitor, todo, step } = setup(); for (let i = 0; i < 12; i++) step();
  const reflection = monitor.capture("root")!; assert.equal(monitor.decide(reflection, looping), "reflect");
  monitor.delivered(reflection, "reflect"); monitor.release(reflection);
  monitor.sync([{ ...todo, context: "different narration", updatedAt: 99 }]);
  for (let i = 0; i < 5; i++) { step(); assert.equal(monitor.capture("root"), undefined); }
  step(); const external = monitor.capture("root")!; assert.ok(external); assert.equal(monitor.decide(external, looping), "escalate"); monitor.reset();
});
test("new actual outcomes block +6 escalation; unresolved 24 steps may still be reviewed", () => {
  const { monitor, step } = setup(); for (let i = 0; i < 12; i++) step();
  const ticket = monitor.capture("root")!; monitor.delivered(ticket, "reflect"); monitor.release(ticket);
  monitor.start("root", "session"); monitor.outcome("root", "read", { path: "new-source" }, "new evidence", false); monitor.end("root");
  for (let i = 0; i < 5; i++) step(); assert.equal(monitor.capture("root"), undefined);
  for (let i = 0; i < 6; i++) step(); const unresolved = monitor.capture("root")!;
  assert.ok(unresolved); assert.equal(monitor.decide(unresolved, looping), "escalate"); monitor.reset();
});
test("15-minute unresolved effective threshold escalates only after reflection", () => {
  const { monitor, time, step } = setup(); for (let i = 0; i < 12; i++) step();
  const reflection = monitor.capture("root")!; monitor.delivered(reflection, "reflect"); monitor.release(reflection);
  time(900000); step(); const ticket = monitor.capture("root")!; assert.ok(ticket); assert.equal(monitor.decide(ticket, looping), "escalate"); monitor.reset();
});
test("on-track/noop clears suspicion; uncertain/low confidence/degraded only reflect", () => {
  for (const result of [uncertain, { ...looping, confidence: 0.2 }]) {
    const { monitor, step } = setup(); for (let i = 0; i < 12; i++) step(); const ticket = monitor.capture("root")!;
    assert.equal(monitor.decide(ticket, result), "reflect"); monitor.delivered(ticket, "reflect"); monitor.release(ticket);
    for (let i = 0; i < 6; i++) step(); const escalated = monitor.capture("root")!; assert.equal(monitor.decide(escalated, result), undefined); monitor.reset();
  }
  const { monitor, step } = setup(); for (let i = 0; i < 12; i++) step(); const ticket = monitor.capture("root")!;
  assert.equal(monitor.decide(ticket, { label: "on-track", confidence: .9, layer: "jev" }), undefined); monitor.release(ticket); step(); assert.equal(monitor.capture("root"), undefined); monitor.reset();
});
for (const mutation of ["task-evidence", "complete", "reassign", "activation", "config", "session", "new-outcome"] as const) {
  for (const oldFirst of [true, false]) test(`${mutation}: stale result cannot deliver (${oldFirst ? "old first" : "old last"})`, async () => {
    const { monitor, todo, step } = setup({ reviewSteps: 1 }); step(); const old = monitor.capture("root")!;
    const staleDecision = async () => { await Promise.resolve(); assert.equal(monitor.fresh(old), false); assert.equal(monitor.decide(old, looping), undefined); monitor.release(old); };
    if (mutation === "task-evidence") monitor.sync([{ ...todo, description: "changed acceptance" }]);
    else if (mutation === "complete") monitor.sync([{ ...todo, status: "completed" }]);
    else if (mutation === "reassign") monitor.sync([{ ...todo, assignee: { id: "child", kind: "teammate", label: "child" } }]);
    else if (mutation === "activation") monitor.sync([{ ...todo, activeStartedAt: 2 }]);
    else if (mutation === "config") { monitor.reset({ ...cfg, reviewSteps: 1 }); monitor.sync([todo]); }
    else if (mutation === "session") { monitor.offline("root"); monitor.start("root", "other-session"); }
    else { monitor.start("root", "session"); monitor.outcome("root", "read", { path: "new" }, "new", false); }
    const work = () => { monitor.start("root", "new"); monitor.end("root"); const current = monitor.capture("root"); if (current) { assert.ok(monitor.fresh(current)); assert.equal(monitor.decide(current, looping), "reflect"); } };
    if (oldFirst) { await staleDecision(); work(); } else { work(); await staleDecision(); }
    monitor.reset();
  });
}
test("unrelated Todo changes preserve same-task evidence and one-flight admission", () => {
  const { monitor, todo, step } = setup({ reviewSteps: 1 }); step(); const ticket = monitor.capture("root")!;
  monitor.sync([todo, { ...task("unrelated"), status: "completed", summary: "changed" }]);
  assert.ok(monitor.fresh(ticket)); assert.equal(monitor.capture("root"), undefined); monitor.reset();
});
test("cooldown, per-task budgets and bounded retention survive task acceptance edits", () => {
  const { monitor, todo, step, time } = setup({ reviewSteps: 1, maxReviewsPerTask: 1, cooldownMs: 100 }); step();
  const ticket = monitor.capture("root")!; monitor.release(ticket); time(101); step();
  assert.equal(monitor.capture("root"), undefined);
  monitor.sync([{ ...todo, description: "edited acceptance" }]); step(); assert.equal(monitor.capture("root"), undefined);
  for (let i = 0; i < 100; i++) monitor.sync([task(String(i))]); assert.ok(monitor.states.size <= 64);
  monitor.reset(); assert.equal(monitor.states.size, 0);
});
test("todo-progress validates label/confidence; host wait terminal, untrusted narration provisional", () => {
  assert.equal(todoProgressDomain.decide({ progress: { type: "choice", choice: "invented", confidence: .9 } }), undefined);
  for (const confidence of [NaN, -1, 2]) assert.equal(todoProgressDomain.decide({ progress: { type: "choice", choice: "looping", confidence } }), undefined);
  const input = { task: "I am waiting", steps: 12, activeMs: 1, sameFailures: 0, failureLimit: 3, outcomes: [], waiting: false, verifiedProgress: false };
  assert.equal(todoProgressDomain.rules(input)?.terminal, false);
  assert.deepEqual(todoProgressDomain.rules({ ...input, waiting: true }), { label: "waiting", terminal: true });
});
test("classifier off, shadow, JEV on-track and timeout fallback actually use the shared engine", async () => {
  resetClassifierForTest(); let calls = 0; const shadows: unknown[] = [];
  const input = { task: "task", steps: 12, activeMs: 0, sameFailures: 0, failureLimit: 3, outcomes: [], waiting: false, verifiedProgress: false };
  const fetchFn: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ answers: { progress: { type: "choice", choice: "on-track", confidence: .9 } } })); };
  configureClassifier({ enabled: false, fetchFn }); assert.equal((await classify(todoProgressDomain, input)).confidence, 0); assert.equal(calls, 0);
  const base = { enabled: true, hostVersion: "0.98.0", apiKey: "test-key", fetchFn, domains: { "todo-progress": "shadow" as const }, onShadow: (record: unknown) => shadows.push(record) };
  configureClassifier(base); assert.equal((await classify(todoProgressDomain, input)).label, "uncertain"); await until(() => shadows.length === 1); assert.equal(calls, 1);
  configureClassifier({ ...base, domains: { "todo-progress": "jev" } }); assert.equal((await classify(todoProgressDomain, input)).label, "on-track");
  configureClassifier({ ...base, timeoutMs: 5, domains: { "todo-progress": "jev" }, fetchFn: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) });
  const keepAlive = setTimeout(() => {}, 100);
  try { const failed = await classify(todoProgressDomain, input); assert.equal(failed.layer, "degraded"); assert.equal(failed.confidence, 0); }
  finally { clearTimeout(keepAlive); resetClassifierForTest(); }
});

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
function fakePi() {
  const handlers = new Map<string, Handler[]>(); const bus = new Map<string, Array<(payload: unknown) => void>>();
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const busEvents: Array<{ name: string; payload: unknown }> = [];
  const notices: string[] = [];
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>(); let tools: string[] = [];
  const pi = { on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    events: { on(name: string, handler: (payload: unknown) => void) { bus.set(name, [...bus.get(name) ?? [], handler]); return () => {}; }, emit(name: string, payload: unknown) { busEvents.push({ name, payload }); for (const handler of bus.get(name) ?? []) handler(payload); } },
    registerTool(tool: { name: string }) { tools.push(tool.name); }, registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, options.handler); },
    getActiveTools: () => tools, setActiveTools: (value: string[]) => { tools = value; }, getThinkingLevel: () => "low", appendEntry() {},
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); } } as unknown as ExtensionAPI;
  async function emit(name: string, event: Record<string, unknown>, ctx: ExtensionContext) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); }
  return { pi, emit, sent, commands, busEvents, notices };
}
test("host adapter uses root boundaries, excludes user waits, and rejects replaced child/origin events", async () => {
  const { pi, emit } = fakePi(); let now = 0; const tickets: string[] = [];
  const tasks = [task(), task("2", "child")];
  const ctx = { sessionManager: { getSessionId: () => "session", getSessionFile: () => "parent.jsonl" } } as unknown as ExtensionContext;
  const host = new TodoReviewHost(pi, { ...cfg, reviewSteps: 1 }, { enabled: () => true, context: () => ctx, getTasks: () => tasks, now: () => now, review: (ticket) => tickets.push(ticket.actor) }); host.reset({ ...cfg, reviewSteps: 1 });
  await emit("turn_start", {}, ctx); await emit("ui_prompt_start", {}, ctx); now += 900000; await emit("ui_prompt_end", {}, ctx); await emit("turn_end", {}, ctx);
  assert.deepEqual(tickets, ["root"]); assert.equal([...host.monitor.states.values()].find((state) => state.actor === "root")?.activeMs, 0);
  const boundary = (sequence: number, type: string, parentSessionFile = "parent.jsonl") => publishTeammateHostBoundary({ correlationId: "child", incarnation: String(sequence), sequence, parentSessionFile, runtimeGeneration: sequence, event: { type }, steer: () => true });
  boundary(2, "turn_start"); boundary(1, "turn_start"); boundary(1, "turn_end"); assert.deepEqual(tickets, ["root"]);
  boundary(2, "turn_end"); assert.deepEqual(tickets, ["root", "child"]);
  host.reset({ ...cfg, reviewSteps: 1 }); boundary(3, "turn_start", "old.jsonl"); boundary(3, "turn_end", "old.jsonl"); assert.equal(tickets.length, 2);
  pi.events.emit("teammate:started", { correlationId: "child", projection: { sessionId: "session" }, spawnedBy: "parent-child" });
  boundary(4, "turn_start", "spawner-or-fork-checkpoint.jsonl"); boundary(4, "turn_end", "spawner-or-fork-checkpoint.jsonl");
  assert.equal(tickets.length, 3, "current root roster admits nested bound children even with a different parentSessionFile");
  host.close(); boundary(5, "turn_start"); boundary(5, "turn_end"); assert.equal(tickets.length, 3);
});

async function extensionHarness(mode: "active" | "shadow" = "active") {
  const cwd = await mkdtemp(join(tmpdir(), "todo-review-e2e-")); await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "advisor.json"), JSON.stringify({ enabled: true, model: "reviewer/independent", cooldownMs: 0, todoReview: { ...cfg, mode, reviewSteps: 2, reflectionSteps: 2, maxReviewsPerTask: 3 } }));
  const harness = fakePi(); const models = [{ provider: "executor", id: "main" }, { provider: "reviewer", id: "independent" }];
  const ctx = { cwd, model: models[0], modelRegistry: { refresh: async () => {}, getAvailable: () => models }, sessionManager: { getSessionId: () => "root-session", getSessionFile: () => "parent.jsonl", getEntries: () => [] }, ui: { notify(message: string) { harness.notices.push(message); }, setStatus() {} } } as unknown as ExtensionContext;
  initTodo(harness.pi); const todoCtx: TodoContext = { cwd, sessionManager: { getEntries: () => [] }, ui: { setStatus() {} } }; onSessionStart(todoCtx);
  await executeTodo({ action: "create", subject: "Fix leak", description: "Acceptance: verify no leaked connection" }, todoCtx);
  await executeTodo({ action: "update", id: "1", status: "in_progress" }, todoCtx);
  registerTodoActor({ id: "child", kind: "teammate", label: "child" });
  await executeTodo({ action: "create", subject: "Child fix", assignee: "child" }, todoCtx);
  await executeTodo({ action: "update", id: "2", status: "in_progress" }, todoCtx);
  const requests: unknown[] = [];
  setAdvisorTeammateRuntimeForTest({ supervision, runTeammate: async (params) => { requests.push(params); return [{ agent: "analyst", exitCode: 0, messages: [], model: "reviewer/independent", structuredOutput: { status: "concern", message: "Verify a different hypothesis." } }]; } });
  resetClassifierForTest(); registerAdvisor(harness.pi); await harness.emit("session_start", {}, ctx); await harness.emit("before_agent_start", {}, ctx);
  return { ...harness, ctx, requests, todoCtx, async close() { await harness.emit("session_shutdown", {}, ctx); onSessionShutdown(todoCtx); setAdvisorTeammateRuntimeForTest(undefined); resetClassifierForTest(); await rm(cwd, { recursive: true, force: true }); } };
}
for (const actor of ["root", "child"]) test(`actual Advisor queue: ${actor} reflection then independent escalation, no double legacy review`, async () => {
  const h = await extensionHarness(); const childMessages: string[] = []; let sequence = 100;
  const step = async (error = false) => {
    if (actor === "root") {
      await h.emit("turn_start", {}, h.ctx);
      await h.emit("tool_call", { toolCallId: "call", toolName: "bash", input: { command: "test same" } }, h.ctx);
      await h.emit("tool_result", { toolCallId: "call", toolName: "bash", input: { command: "test same" }, content: "same failure", isError: error }, h.ctx);
      await h.emit("turn_end", {}, h.ctx);
    } else {
      const event = (type: string, extra = {}) => publishTeammateHostBoundary({ correlationId: "child", incarnation: "child-process", sequence, parentSessionFile: "parent.jsonl", runtimeGeneration: 1, event: { type, ...extra }, steer: (message) => { childMessages.push(message); return true; } });
      event("turn_start"); event("tool_execution_start", { toolCallId: "call", toolName: "bash", args: { command: "test same" } }); event("tool_execution_end", { toolCallId: "call", toolName: "bash", result: "same failure", isError: error }); event("turn_end");
    }
    await flush();
  };
  try {
    await step(true); assert.equal(h.sent.length + childMessages.length, 0); await step(true);
    await until(() => h.sent.length + childMessages.length === 1); assert.equal(h.requests.length, 0, "reflection must not dispatch a second model");
    const text = actor === "root" ? JSON.stringify(h.sent[0]) : childMessages[0]!; assert.match(text, /session_history/); assert.match(text, /same failure/);
    await step(true); assert.equal(h.requests.length, 0); await step(true);
    await until(() => h.requests.length === 1); await until(() => h.sent.length + childMessages.length === 2);
    assert.equal(actor === "root" ? childMessages.length : h.sent.length, 0, "target only the actor owning the Todo");
    assert.match(JSON.stringify(h.requests[0]), /reviewer\/independent/); assert.match(JSON.stringify(h.requests[0]), /"thinking":"low"/);
    if (actor === "root") assert.match(JSON.stringify(h.sent), /"triggerTurn":false/);
  } finally { sequence++; await h.close(); }
});
test("task shadow records semantic classification without injection or Advisor dispatch", async () => {
  const h = await extensionHarness("shadow");
  configureClassifier({ enabled: true, hostVersion: "0.98.0", apiKey: "test-key", domains: { "todo-progress": "jev" },
    fetchFn: async () => new Response(JSON.stringify({ answers: { progress: { type: "choice", choice: "on-track", confidence: .9 } } })) });
  try {
    for (let i = 0; i < 3; i++) { await h.emit("turn_start", {}, h.ctx); await h.emit("turn_end", {}, h.ctx); await flush(); }
    assert.equal(h.sent.length, 0); assert.equal(h.requests.length, 0);
    const events = h.busEvents.filter(event => event.name === supervision.SUPERVISION_EVENT);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.payload, { source: "advisor", kind: "verdict", severity: "info", target: "root",
      verdict: { status: "on-track" }, timestamp: (events[0]?.payload as supervision.SupervisionEvent).timestamp,
      meta: { checkpoint: "todo_progress", taskId: "1", shadow: true, confidence: .9, layer: "jev" } });
    await h.commands.get("advisor")!("status", h.ctx);
    assert.match(h.notices.at(-1)!, /TODO shadow records: 1/);
    assert.match(h.notices.at(-1)!, /last TODO: #1 @root · on-track · confidence 0.9 · jev · shadow/);
  } finally { await h.close(); }
});

test("compaction/model fencing preserves effective time, evidence and finite budgets", () => {
  const { monitor, todo, step, time } = setup({ reviewSteps: 1, maxReviewsPerTask: 1 });
  time(100); step(); const ticket = monitor.capture("root")!;
  monitor.fence(); assert.equal(monitor.fresh(ticket), false);
  time(900000); monitor.sync([todo]); step();
  assert.equal(monitor.capture("root"), undefined, "fencing is not a new task review budget");
  assert.equal([...monitor.states.values()][0]?.reviews, 1); monitor.reset();
});
test("untrusted JEV waiting and low-confidence on-track cannot authorize an exempt wait", () => {
  for (const result of [{ label: "waiting", confidence: .99, layer: "jev" }, { label: "on-track", confidence: .1, layer: "jev" }, { label: "on-track", confidence: 1, layer: "degraded", degradedReason: "timeout" }] satisfies ClassifyResult<TodoProgressLabel>[]) {
    const { monitor, step } = setup({ reviewSteps: 1 }); step(); const ticket = monitor.capture("root")!;
    assert.equal(monitor.decide(ticket, result), "reflect"); monitor.reset();
  }
});
for (const actor of ["root", "child"] as const) for (const oldFirst of [true, false]) {
  test(`actual classifier race ${actor}: model/config fence (${oldFirst ? "old first" : "old last"})`, async () => {
    const h = await extensionHarness(); const replies: Array<(response: Response) => void> = []; const childMessages: string[] = [];
    configureClassifier({ enabled: true, hostVersion: "0.98.0", apiKey: "test-key", domains: { "todo-progress": "jev" }, fetchFn: async () => new Promise<Response>((resolve) => replies.push(resolve)) });
    const step = async () => {
      if (actor === "root") { await h.emit("turn_start", {}, h.ctx); await h.emit("turn_end", {}, h.ctx); }
      else {
        for (const type of ["turn_start", "turn_end"]) publishTeammateHostBoundary({ correlationId: "child", incarnation: "process", sequence: 200, parentSessionFile: "parent.jsonl", runtimeGeneration: 1, event: { type }, steer: (message) => { childMessages.push(message); return true; } });
      }
      await flush();
    };
    const reply = () => new Response(JSON.stringify({ answers: { progress: { type: "choice", choice: "looping", confidence: .9 } } }));
    try {
      await step(); await step(); await until(() => replies.length === 1);
      await h.emit("model_select", { model: h.ctx.model }, h.ctx);
      await step(); await until(() => replies.length === 2);
      if (oldFirst) { replies[0]!(reply()); await flush(); assert.equal(h.sent.length + childMessages.length, 0); replies[1]!(reply()); }
      else { replies[1]!(reply()); await until(() => h.sent.length + childMessages.length === 1); replies[0]!(reply()); }
      await until(() => h.sent.length + childMessages.length === 1); await flush();
      assert.equal(h.sent.length + childMessages.length, 1, "obsolete classifier must not deliver, release or overwrite the replacement review");
      assert.equal(h.requests.length, 0, "fresh first intervention remains reflection only");
    } finally { for (const resolve of replies) resolve(reply()); await h.close(); }
  });
}

for (const change of ["new-iteration", "failed-outcome", "unlisted-outcome"] as const) {
  test(`review snapshot revision rejects ${change} and stale releases cannot unlock its successor`, () => {
    const { monitor, step } = setup({ reviewSteps: 1 });
    step(); const old = monitor.capture("root")!;
    monitor.start("root", "session");
    if (change !== "new-iteration") monitor.outcome("root", change === "failed-outcome" ? "bash" : "mcp", { command: "inspect" }, "new result", change === "failed-outcome");
    monitor.end("root");
    assert.equal(monitor.fresh(old), false);
    assert.equal(monitor.decide(old, looping), undefined);
    monitor.release(old);
    const next = monitor.capture("root")!;
    assert.ok(monitor.fresh(next));
    monitor.release(old);
    assert.equal(monitor.capture("root"), undefined, "late old cleanup cannot release the next ticket");
    assert.equal(monitor.decide(next, looping), "reflect");
    monitor.reset();
  });
}

for (const actor of ["root", "child"] as const) {
  test(`actual classifier progress race ${actor}: unlisted outcome invalidates an awaited verdict`, async () => {
    const h = await extensionHarness(); const replies: Array<(response: Response) => void> = []; const childMessages: string[] = [];
    configureClassifier({ enabled: true, hostVersion: "0.98.0", apiKey: "test-key", domains: { "todo-progress": "jev" }, fetchFn: async () => new Promise<Response>(resolve => replies.push(resolve)) });
    const step = async (outcome = false) => {
      if (actor === "root") {
        await h.emit("turn_start", {}, h.ctx);
        if (outcome) await h.emit("tool_result", { toolCallId: "progress", toolName: "mcp", input: {}, content: "new evidence", isError: false }, h.ctx);
        await h.emit("turn_end", {}, h.ctx);
      } else {
        const event = (type: string, extra = {}) => publishTeammateHostBoundary({ correlationId: "child", incarnation: "process", sequence: 200, parentSessionFile: "parent.jsonl", runtimeGeneration: 1, event: { type, ...extra }, steer: message => { childMessages.push(message); return true; } });
        event("turn_start");
        if (outcome) event("tool_execution_end", { toolCallId: "progress", toolName: "mcp", result: "new evidence", isError: false });
        event("turn_end");
      }
      await flush();
    };
    const reply = () => new Response(JSON.stringify({ answers: { progress: { type: "choice", choice: "looping", confidence: .9 } } }));
    try {
      await step(); await step(); await until(() => replies.length === 1);
      await step(true); replies[0]!(reply()); await flush();
      assert.equal(h.sent.length + childMessages.length, 0, "old verdict cannot ignore a newer outcome");
      await step(); await until(() => replies.length === 2); replies[1]!(reply());
      await until(() => h.sent.length + childMessages.length === 1);
    } finally { for (const resolve of replies) resolve(reply()); await h.close(); }
  });
}

for (const queueNewFirst of [false, true]) {
  test(`config durable authority: stale staged save cannot overwrite the newer save (${queueNewFirst ? "new queued" : "old settled"})`, async () => {
    const h = await extensionHarness();
    const path = join(h.ctx.cwd, ".pi", "advisor.json");
    const original = await readFile(path, "utf8");
    let staged = false;
    let release!: () => void;
    setAdvisorConfigWriteBarrierForTest(() => { staged = true; return new Promise<void>(resolve => { release = resolve; }); });
    try {
      const old = h.commands.get("advisor")!("off", h.ctx);
      await until(() => staged);
      await h.emit("session_before_switch", {}, h.ctx);
      await h.emit("session_start", {}, h.ctx);
      await h.emit("before_agent_start", {}, h.ctx);
      assert.equal(await readFile(path, "utf8"), original, "staged bytes have not replaced the live file");
      setAdvisorConfigWriteBarrierForTest(undefined);
      const next = queueNewFirst ? h.commands.get("advisor")!("todo mode shadow", h.ctx) : undefined;
      release(); await old;
      if (next) await next; else await h.commands.get("advisor")!("todo mode shadow", h.ctx);
      const final = JSON.parse(await readFile(path, "utf8"));
      assert.equal(final.enabled, true, "obsolete off request must never reach the durable configuration");
      assert.equal(final.todoReview.mode, "shadow");
      assert.deepEqual(await readdir(join(h.ctx.cwd, ".pi")), ["advisor.json"], "temporary writes cleaned up");
    } finally { setAdvisorConfigWriteBarrierForTest(undefined); release?.(); await h.close(); }
  });
}

test("config durable replacement rejects non-regular targets and preserves the active config", async () => {
  const h = await extensionHarness(); const path = join(h.ctx.cwd, ".pi", "advisor.json");
  try {
    await rm(path); await mkdir(path);
    await h.commands.get("advisor")!("off", h.ctx);
    assert.deepEqual(await readdir(path), []);
    await h.commands.get("advisor")!("status", h.ctx);
    assert.match(h.notices.at(-1)!, /ADVISOR on/);
    assert.match(h.notices.join("\n"), /regular file/);
    assert.deepEqual(await readdir(join(h.ctx.cwd, ".pi")), ["advisor.json"]);
  } finally { await h.close(); }
});

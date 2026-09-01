import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { readFile } from "node:fs/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  LoopParams,
  LoopScheduler,
  registerLoop,
  parseLoopDuration,
  formatJob,
  resolveLoopId,
  LOOP_UPDATE_EVENT,
  LOOP_QUERY_EVENT,
  type LoopJobSnapshot,
  type LoopRunResult,
} from "../src/tools/loop.ts";

interface FakeTimer {
  callback: () => void;
  cleared: boolean;
  unref(): void;
}

function createHarness(
  execute?: (job: LoopJobSnapshot) => Promise<LoopRunResult>,
  onUpdate?: (jobs: LoopJobSnapshot[]) => void,
  onTerminal?: (job: LoopJobSnapshot, outcome: "failed" | "completed") => void,
) {
  const timers: FakeTimer[] = [];
  let now = 1_000;
  const scheduler = new LoopScheduler({
    execute: execute ?? (async () => ({ ok: true, summary: "ok" })),
    now: () => now,
    setTimer(callback) {
      const timer: FakeTimer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer) {
      (timer as unknown as FakeTimer).cleared = true;
    },
    onUpdate,
    onTerminal,
  });

  return {
    scheduler,
    timers,
    advance(ms: number) { now += ms; },
    fire(index: number) {
      const timer = timers[index];
      assert.ok(timer, `missing timer ${index}`);
      assert.equal(timer.cleared, false, `timer ${index} was cleared`);
      timer.callback();
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("loop schema enforces action-specific required fields and millisecond units", () => {
  assert.equal(Check(LoopParams, { action: "list" }), true);
  assert.equal(Check(LoopParams, { action: "create" }), false);
  assert.equal(Check(LoopParams, { action: "create", kind: "prompt", task: "check", intervalMs: 1_000 }), true);
  assert.equal(Check(LoopParams, { action: "create", kind: "prompt", task: "check", intervalMs: "1s" }), false);
  assert.equal(Check(LoopParams, { action: "cancel" }), false);
  assert.equal(Check(LoopParams, { action: "cancel", loopId: "loop-1" }), true);
  assert.match(String((LoopParams.properties.intervalMs as { description?: string }).description), /milliseconds/);
});

test("loop schedules the first run after the configured delay", () => {
  const harness = createHarness();
  const job = harness.scheduler.create({
    kind: "prompt",
    task: "check status",
    intervalMs: 5_000,
    maxRuns: 2,
  });

  assert.equal(job.status, "scheduled");
  assert.equal(job.runCount, 0);
  assert.equal(job.nextRunAt, 6_000);
  assert.equal(harness.timers.length, 1);
});

test("loop uses fixed delay and never overlaps executions", async () => {
  const resolvers: Array<(result: LoopRunResult) => void> = [];
  const harness = createHarness(() => new Promise((resolve) => resolvers.push(resolve)));
  const created = harness.scheduler.create({ kind: "shell", task: "npm test", intervalMs: 1_000, maxRuns: 2 });

  harness.advance(1_000);
  harness.fire(0);
  assert.equal(harness.scheduler.list()[0].status, "running");
  assert.equal(harness.timers.length, 1, "no next timer while the run is active");

  resolvers[0]({ ok: true, summary: "first done" });
  await flush();
  const afterFirst = harness.scheduler.list()[0];
  assert.equal(afterFirst.status, "scheduled");
  assert.equal(afterFirst.runCount, 1);
  assert.equal(harness.timers.length, 2);

  harness.advance(1_000);
  harness.fire(1);
  resolvers[1]({ ok: true, summary: "second done" });
  await flush();
  const completed = harness.scheduler.list()[0];
  assert.equal(completed.id, created.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.runCount, 2);
  assert.equal(harness.timers.length, 2);
});

test("failed execution stops the loop without scheduling another run", async () => {
  const harness = createHarness(async () => ({ ok: false, summary: "exit 1" }));
  harness.scheduler.create({ kind: "shell", task: "false", intervalMs: 1_000, maxRuns: 5 });

  harness.fire(0);
  await flush();
  const failed = harness.scheduler.list()[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.runCount, 1);
  assert.equal(failed.lastResult, "exit 1");
  assert.equal(harness.timers.length, 1);
});

test("cancel during an awaited execution fences the late result", async () => {
  let resolveRun!: (result: LoopRunResult) => void;
  const updates: LoopJobSnapshot[][] = [];
  const harness = createHarness(
    () => new Promise((resolve) => { resolveRun = resolve; }),
    (jobs) => updates.push(jobs),
  );
  const created = harness.scheduler.create({
    kind: "shell", task: "slow", intervalMs: 1_000, maxRuns: 3,
  });

  harness.fire(0);
  assert.equal(harness.scheduler.cancel(created.id)?.status, "cancelled");
  const updateCount = updates.length;
  resolveRun({ ok: true, summary: "too late" });
  await flush();

  const cancelled = harness.scheduler.list()[0];
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.runCount, 0);
  assert.equal(cancelled.lastResult, undefined);
  assert.equal(harness.timers.length, 1, "late completion must not schedule another timer");
  assert.equal(updates.length, updateCount, "late completion must not publish a stale update");
});

test("cancel and shutdown clear timers and prevent future runs", () => {
  const harness = createHarness();
  const first = harness.scheduler.create({ kind: "prompt", task: "one", intervalMs: 1_000 });
  const second = harness.scheduler.create({ kind: "prompt", task: "two", intervalMs: 1_000 });

  assert.equal(harness.scheduler.cancel(first.id)?.status, "cancelled");
  assert.equal(harness.timers[0].cleared, true);
  harness.scheduler.shutdown();
  assert.equal(harness.timers[1].cleared, true);
  assert.deepEqual(harness.scheduler.list(), []);
  assert.equal(second.status, "scheduled");
});

test("reset makes a scheduler reusable after session replacement shutdown", () => {
  const harness = createHarness();
  harness.scheduler.create({ kind: "prompt", task: "old", intervalMs: 1_000 });
  harness.scheduler.shutdown();
  assert.throws(() => harness.scheduler.create({ kind: "prompt", task: "blocked", intervalMs: 1_000 }), /shut down/);
  harness.scheduler.reset();
  const next = harness.scheduler.create({ kind: "prompt", task: "new session", intervalMs: 1_000 });
  assert.equal(next.status, "scheduled");
  assert.equal(harness.scheduler.list().length, 1);
});

test("shutdown prevents an in-flight execution from reviving the loop", async () => {
  let resolveRun!: (result: LoopRunResult) => void;
  const harness = createHarness(() => new Promise((resolve) => { resolveRun = resolve; }));
  harness.scheduler.create({ kind: "shell", task: "long-running", intervalMs: 1_000, maxRuns: 3 });

  harness.fire(0);
  assert.equal(harness.scheduler.list()[0].status, "running");
  harness.scheduler.shutdown();
  resolveRun({ ok: true, summary: "late completion" });
  await flush();

  assert.deepEqual(harness.scheduler.list(), []);
  assert.equal(harness.timers.length, 1, "late completion must not schedule another timer");
});

test("duration parser accepts explicit units and rejects ambiguous values", () => {
  assert.equal(parseLoopDuration("1500ms"), 1_500);
  assert.equal(parseLoopDuration("2s"), 2_000);
  assert.equal(parseLoopDuration("1.5m"), 90_000);
  assert.equal(parseLoopDuration("2h"), 7_200_000);
  assert.equal(parseLoopDuration("10"), undefined);
  assert.equal(parseLoopDuration("soon"), undefined);
});

// Invariant: status display MUST pair a stable glyph with the status text
// (ui-conventions-004), and times MUST be human-readable relative values.
test("formatJob pairs glyph with status text and uses relative times", () => {
  const harness = createHarness();
  harness.scheduler.create({ kind: "shell", task: "echo hi\n  second line", intervalMs: 60_000, maxRuns: 4 });
  const formatted = formatJob(harness.scheduler.list()[0], 31_000);

  assert.match(formatted, /○ loop-/, "scheduled glyph + id");
  assert.match(formatted, /\bscheduled\b/);
  assert.match(formatted, /next in 30s/, "relative next-run time");
  assert.match(formatted, /"echo hi second line"/, "flattened task preview");
  assert.doesNotMatch(formatted, /Z/, "no raw ISO timestamp");
});

test("formatJob marks terminal outcomes and truncates long results", async () => {
  const harness = createHarness(async () => ({ ok: false, summary: "x".repeat(300) }));
  harness.scheduler.create({ kind: "shell", task: "fail", intervalMs: 1_000, maxRuns: 3 });
  harness.fire(0);
  await flush();
  const formatted = formatJob(harness.scheduler.list()[0], 2_000);

  assert.match(formatted, /✗/, "failed glyph");
  assert.match(formatted, /\bfailed\b/);
  assert.match(formatted, /last 1s ago/);
  const resultPart = formatted.split("result=")[1].split(" log=")[0];
  assert.ok(resultPart.length <= 121, "result truncated to ~120 chars");
});

test("resolveLoopId resolves exact ids and unique prefixes, rejects ambiguity", () => {
  const jobs: LoopJobSnapshot[] = [
    { id: "loop-1-abc", kind: "shell", task: "a", intervalMs: 1_000, maxRuns: 1, runCount: 0, status: "scheduled", createdAt: 1 },
    { id: "loop-2-def", kind: "shell", task: "b", intervalMs: 1_000, maxRuns: 1, runCount: 0, status: "scheduled", createdAt: 2 },
  ];
  assert.deepEqual(resolveLoopId("loop-2-def", jobs), { id: "loop-2-def" });
  assert.deepEqual(resolveLoopId("loop-2", jobs), { id: "loop-2-def" }, "unique prefix resolves");
  assert.ok("error" in resolveLoopId("loop-", jobs), "ambiguous prefix reports error");
  assert.ok("error" in resolveLoopId("nope", jobs), "unknown id reports error");
});

test("loop is registered only by pi-maestro-flow", async () => {
  const flowIndex = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const teammateIndex = await readFile(new URL("../../pi-maestro-teammate/src/extension/index.ts", import.meta.url), "utf8");
  const teammateSchemas = await readFile(new URL("../../pi-maestro-teammate/src/extension/schemas.ts", import.meta.url), "utf8");

  assert.match(flowIndex, /registerLoop\(pi\)/);
  assert.doesNotMatch(teammateIndex, /teammate-loop|registerCommand\("loop"/);
  assert.doesNotMatch(teammateSchemas, /TeammateLoopParams/);
});

test("onUpdate fires on create, cancel, and run completion", async () => {
  const updates: LoopJobSnapshot[][] = [];
  const harness = createHarness(
    async () => ({ ok: true, summary: "done" }),
    (jobs) => updates.push(jobs),
  );

  // create fires onUpdate
  const job = harness.scheduler.create({ kind: "shell", task: "echo hi", intervalMs: 1_000, maxRuns: 1 });
  assert.equal(updates.length, 1, "onUpdate after create");
  assert.equal(updates[0].length, 1);
  assert.equal(updates[0][0].status, "scheduled");

  // run completion fires onUpdate
  harness.fire(0);
  await flush();
  assert.equal(updates.length, 2, "onUpdate after run completion");
  assert.equal(updates[1][0].status, "completed");

  // cancel fires onUpdate
  const second = harness.scheduler.create({ kind: "prompt", task: "x", intervalMs: 1_000 });
  assert.equal(updates.length, 3, "onUpdate after second create");
  harness.scheduler.cancel(second.id);
  assert.equal(updates.length, 4, "onUpdate after cancel");
  assert.equal(updates[3].find((j) => j.id === second.id)?.status, "cancelled");
  void job;
});

test("onUpdate fires on failed run", async () => {
  const updates: LoopJobSnapshot[][] = [];
  const harness = createHarness(
    async () => ({ ok: false, summary: "boom" }),
    (jobs) => updates.push(jobs),
  );
  harness.scheduler.create({ kind: "shell", task: "false", intervalMs: 1_000, maxRuns: 3 });
  assert.equal(updates.length, 1);

  harness.fire(0);
  await flush();
  assert.equal(updates.length, 2, "onUpdate after failed run");
  assert.equal(updates[1][0].status, "failed");
});

// Invariant: terminal outcomes MUST be announced once (ui-conventions-007) —
// failures must not be silently discoverable only via list.
test("onTerminal fires exactly once per terminal outcome", async () => {
  const terminals: Array<{ id: string; outcome: string }> = [];
  const failed = createHarness(
    async () => ({ ok: false, summary: "boom" }),
    undefined,
    (job, outcome) => terminals.push({ id: job.id, outcome }),
  );
  failed.scheduler.create({ kind: "shell", task: "x", intervalMs: 1_000, maxRuns: 3 });
  failed.fire(0);
  await flush();
  assert.deepEqual(terminals, [{ id: failed.scheduler.list()[0].id, outcome: "failed" }]);

  const completed = createHarness(
    async () => ({ ok: true, summary: "done" }),
    undefined,
    (job, outcome) => terminals.push({ id: job.id, outcome }),
  );
  completed.scheduler.create({ kind: "shell", task: "y", intervalMs: 1_000, maxRuns: 1 });
  completed.fire(0);
  await flush();
  assert.equal(terminals.length, 2);
  assert.deepEqual(terminals[1], { id: completed.scheduler.list()[0].id, outcome: "completed" });
});

test("terminal outcomes are announced via loop-event messages", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /onTerminal\(job, outcome\)/, "registerLoop wires onTerminal");
  assert.match(source, /customType:\s*"loop-event"/, "announcement uses loop-event customType");
  assert.match(source, /registerMessageRenderer\("loop-event"/, "registers loop-event renderer");
});

test("event constants are exported", () => {
  assert.equal(LOOP_UPDATE_EVENT, "loop:update");
  assert.equal(LOOP_QUERY_EVENT, "loop:query");
});

test("registerLoop publishes authoritative snapshots on scheduler updates and queries", async () => {
  type Handler = (...args: any[]) => unknown;
  type RenderComponent = { render(width: number): string[] };
  type RenderTheme = { fg(name: string, text: string): string; bold(text: string): string };
  type LoopToolResult = {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
    details?: { jobs?: LoopJobSnapshot[] };
  };
  type LoopTool = {
    execute(id: string, params: Record<string, unknown>): Promise<LoopToolResult>;
    renderCall?(args: Record<string, unknown>, theme: RenderTheme, context: { isPartial?: boolean }): RenderComponent;
    renderResult?(
      result: LoopToolResult,
      options: { expanded: boolean; isPartial?: boolean },
      theme: RenderTheme,
      context: { args: Record<string, unknown>; isError?: boolean },
    ): RenderComponent;
  };
  const eventHandlers = new Map<string, Handler>();
  const lifecycleHandlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: { jobs: LoopJobSnapshot[] } }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  let tool: LoopTool | undefined;
  const pi = {
    events: {
      on(event: string, handler: Handler) {
        eventHandlers.set(event, handler);
        return () => eventHandlers.delete(event);
      },
      emit(event: string, payload: { jobs: LoopJobSnapshot[] }) {
        emitted.push({ event, payload });
      },
    },
    appendEntry(type: string, data: unknown) {
      entries.push({ type, data });
    },
    sendMessage() {},
    registerTool(value: LoopTool) {
      tool = value;
    },
    registerCommand() {},
    registerMessageRenderer() {},
    on(event: string, handler: Handler) {
      lifecycleHandlers.set(event, handler);
      return () => lifecycleHandlers.delete(event);
    },
  };

  registerLoop(pi as never);
  assert.ok(tool);
  assert.ok(eventHandlers.has(LOOP_QUERY_EVENT));

  eventHandlers.get(LOOP_QUERY_EVENT)!();
  assert.deepEqual(emitted.at(-1), { event: LOOP_UPDATE_EVENT, payload: { jobs: [] } });

  const created = await tool.execute("create-loop", {
    action: "create",
    kind: "prompt",
    task: "check status",
    intervalMs: 60_000,
    maxRuns: 2,
  });
  const job = created.details?.jobs?.[0];
  assert.ok(job);
  assert.equal(emitted.at(-1)?.event, LOOP_UPDATE_EVENT);
  assert.equal(emitted.at(-1)?.payload.jobs[0]?.id, job.id);
  assert.equal(emitted.at(-1)?.payload.jobs[0]?.status, "scheduled");
  assert.equal(entries.at(-1)?.type, "loop-state");

  const listed = await tool.execute("list-loops", { action: "list" });
  const listedText = listed.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(listedText, /next in (?:60s|1m)/, "list must use wall-clock time instead of Array.map's index argument");
  assert.doesNotMatch(listedText, /20697d|next in \d{4,}d/);

  const renderTheme: RenderTheme = {
    fg: (_name, text) => text,
    bold: (text) => text,
  };
  assert.ok(tool.renderCall);
  assert.ok(tool.renderResult);
  const call = tool.renderCall({ action: "create", kind: "prompt", intervalMs: 60_000 }, renderTheme, { isPartial: true }).render(80);
  assert.match(call[0], /loop create prompt · every 1m/);
  assert.deepEqual(tool.renderCall({ action: "create" }, renderTheme, { isPartial: false }).render(80), []);

  const card = tool.renderResult(created, { expanded: false, isPartial: false }, renderTheme, { args: { action: "create" } }).render(100);
  assert.match(card[0], /^╭ ✓ loop create · created loop-.*─╮$/);
  assert.match(card[1], /^│ ○ loop-.* · scheduled\s+│$/);
  assert.match(card[2], /^│ prompt · every 1m · runs 0\/2\s+│$/);
  assert.match(card[3], /^│ task check status\s+│$/);
  assert.match(card.at(-1) ?? "", /^╰─+╯$/);
  assert.ok(card.every((line) => visibleWidth(line) === 99), "loop cards must leave the terminal's final column empty");
  assert.deepEqual(
    tool.renderResult(created, { expanded: false, isPartial: true }, renderTheme, { args: { action: "create" } }).render(100),
    [],
  );

  const rejected = await tool.execute("invalid-loop", { action: "create" });
  const errorCard = tool.renderResult(
    rejected,
    { expanded: false, isPartial: false },
    renderTheme,
    { args: { action: "create" }, isError: true },
  ).render(100);
  assert.match(errorCard[0], /^╭ ✕ loop create · kind, task, and intervalMs are required.*╮$/);
  assert.match(errorCard[1], /^│ kind, task, and intervalMs are required for create\.\s+│$/);
  assert.ok(errorCard.every((line) => visibleWidth(line) === 99));

  for (let index = 0; index < 8; index++) {
    await tool.execute(`create-extra-${index}`, {
      action: "create",
      kind: "prompt",
      task: `extra ${index}`,
      intervalMs: 60_000,
      maxRuns: 1,
    });
  }
  const many = await tool.execute("list-many", { action: "list" });
  const manyCard = tool.renderResult(many, { expanded: false, isPartial: false }, renderTheme, { args: { action: "list" } }).render(100);
  assert.ok(manyCard.some((line) => line.includes("… 2 more loops · expand for details")));
  assert.equal(manyCard.filter((line) => /^├─+┤$/.test(line)).length, 7, "seven jobs plus the overflow marker consume the eight-group budget");

  const updateCount = emitted.length;
  eventHandlers.get(LOOP_QUERY_EVENT)!();
  assert.equal(emitted.length, updateCount + 1);
  assert.deepEqual(emitted.at(-1)?.payload.jobs, emitted.at(-2)?.payload.jobs);

  await tool.execute("cancel-loop", { action: "cancel", loopId: job.id });
  assert.equal(emitted.at(-1)?.payload.jobs[0]?.status, "cancelled");
  lifecycleHandlers.get("session_shutdown")?.({ reason: "quit" });
});

// Invariant: prompt loops MUST use pi.sendMessage (system notification), not
// pi.sendUserMessage (fake user message that blocks the conversation).
test("prompt loop uses sendMessage, not sendUserMessage", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /customType:\s*"loop-tick"/, "prompt tick uses customType loop-tick");
  assert.match(source, /triggerTurn:\s*true/, "prompt tick triggers a turn");
  assert.doesNotMatch(source, /sendUserMessage/, "must not use sendUserMessage");
});

// Invariant: active loops MUST be re-announced after compaction so the agent
// retains awareness of scheduled work.
test("session_compact re-announces active loops", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /session_compact/, "registers session_compact handler");
  assert.match(source, /customType:\s*"loop-active"/, "re-announce uses loop-active customType");
});

test("registers message renderer and event query handler", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /registerMessageRenderer\("loop-tick"/, "registers loop-tick renderer");
  assert.match(source, /LOOP_QUERY_EVENT/, "registers query event handler");
});

test("restore rebuilds a job from snapshot and reschedules", () => {
  const harness = createHarness();
  const snapshot: LoopJobSnapshot = {
    id: "loop-x-abc",
    kind: "shell",
    task: "echo restored",
    intervalMs: 5_000,
    maxRuns: 5,
    runCount: 2,
    status: "scheduled",
    createdAt: 500,
    cwd: "/tmp",
  };
  const restored = harness.scheduler.restore(snapshot);
  assert.equal(restored.id, "loop-x-abc");
  assert.equal(restored.runCount, 2, "preserves runCount");
  assert.equal(restored.status, "scheduled");
  assert.equal(restored.nextRunAt, 6_000, "reschedules from now + interval");
  assert.equal(harness.timers.length, 1, "creates a timer");
  assert.equal(harness.scheduler.list().length, 1);
});

test("restore skips completed, cancelled, and exhausted jobs", () => {
  const harness = createHarness();
  const base = { kind: "shell" as const, task: "x", intervalMs: 1_000, maxRuns: 3, createdAt: 100 };

  const completed = harness.scheduler.restore({ ...base, id: "a", runCount: 3, status: "completed" });
  assert.equal(completed.status, "completed", "completed not restored");

  const cancelled = harness.scheduler.restore({ ...base, id: "b", runCount: 1, status: "cancelled" });
  assert.equal(cancelled.status, "cancelled", "cancelled not restored");

  const failed = harness.scheduler.restore({ ...base, id: "c", runCount: 1, status: "failed" });
  assert.equal(failed.status, "failed", "failed not restored");

  assert.equal(harness.scheduler.list().length, 0, "no jobs added");
  assert.equal(harness.timers.length, 0, "no timers created");
});

test("restore fires onUpdate", () => {
  const updates: LoopJobSnapshot[][] = [];
  const harness = createHarness(undefined, (jobs) => updates.push(jobs));
  harness.scheduler.restore({
    id: "loop-r-1", kind: "prompt", task: "tick", intervalMs: 2_000,
    maxRuns: 4, runCount: 1, status: "scheduled", createdAt: 100,
  });
  assert.equal(updates.length, 1, "onUpdate fired by restore");
  assert.equal(updates[0][0].id, "loop-r-1");
});

test("pause clears timers but keeps jobs", () => {
  const harness = createHarness();
  harness.scheduler.create({ kind: "shell", task: "a", intervalMs: 1_000 });
  harness.scheduler.create({ kind: "prompt", task: "b", intervalMs: 2_000 });
  assert.equal(harness.timers.length, 2);

  harness.scheduler.pause();
  assert.equal(harness.timers[0].cleared, true, "first timer cleared");
  assert.equal(harness.timers[1].cleared, true, "second timer cleared");
  assert.equal(harness.scheduler.list().length, 2, "jobs still present");
  assert.equal(harness.scheduler.list()[0].nextRunAt, undefined, "nextRunAt cleared");
});

// Invariant: loop state MUST be persisted via appendEntry so it survives
// session resume/reload.
test("persists loop state via appendEntry and restores on session_start", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /appendEntry\("loop-state"/, "persists via appendEntry");
  assert.match(source, /session_start/, "registers session_start handler");
  assert.match(source, /customType.*loop-state|loop-state.*customType/s, "scans for loop-state entries");
  assert.match(source, /scheduler\.restore/, "calls restore on session_start");
});

// Invariant: session_shutdown MUST be reason-aware — reload pauses (timers
// re-created on session_start), other reasons fully shut down.
test("session_shutdown is reason-aware", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /event\.reason\s*===\s*"reload"/, "checks shutdown reason");
  assert.match(source, /scheduler\.pause\(\)/, "pauses on reload");
  assert.match(source, /scheduler\.shutdown\(\)/, "shuts down on other reasons");
});

test("shell loop jobs get logDir, prompt loops do not", () => {
  const harness = createHarness();
  const shellJob = harness.scheduler.create({ kind: "shell", task: "echo hi", intervalMs: 1_000 });
  assert.ok(shellJob.logDir, "shell job has logDir");
  assert.match(shellJob.logDir, /pi-loops/, "logDir under pi-loops");
  assert.ok(shellJob.logDir.includes(shellJob.id), "logDir contains loop id");

  const promptJob = harness.scheduler.create({ kind: "prompt", task: "tick", intervalMs: 1_000 });
  assert.equal(promptJob.logDir, undefined, "prompt job has no logDir");
});

test("restore sets logDir for shell loops", () => {
  const harness = createHarness();
  const restored = harness.scheduler.restore({
    id: "loop-s-1", kind: "shell", task: "echo", intervalMs: 1_000,
    maxRuns: 3, runCount: 0, status: "scheduled", createdAt: 100,
  });
  assert.ok(restored.logDir, "restored shell job has logDir");
  assert.match(restored.logDir, /loop-s-1/, "logDir contains loop id");
});

// Invariant: shell loop output MUST be written to per-run log files so
// results survive session shutdown.
test("shell execution writes run logs", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /run-\$\{job\.runCount \+ 1\}\.log/, "writes per-run log file");
  assert.match(source, /mkdirSync\(job\.logDir/, "creates log directory");
});

// Invariant: on quit, active shell loops with remaining runs MUST be handed
// off to a detached scheduler process.
test("quit spawns detached scheduler for shell loops", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /spawnDetachedScheduler/, "calls spawnDetachedScheduler");
  assert.match(source, /event\.reason\s*===\s*"quit"/, "checks for quit reason");
  assert.match(source, /detached:\s*process\.platform\s*!==\s*"win32"/, "detached on non-Windows");
  assert.match(source, /child\.unref\(\)/, "unrefs child process");
});

// Invariant: the generated scheduler script MUST be self-contained (pure
// Node.js builtins, no pi imports).
test("scheduler script uses only Node builtins", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /scheduler\.mjs/, "generates scheduler.mjs");
  assert.match(source, /execFileSync/, "script uses execFileSync");
  // The script template must not import from @earendil-works
  const scriptMatch = source.match(/const script = `([\s\S]*?)`;\s*\n\s*fs\.writeFileSync/);
  assert.ok(scriptMatch, "found script template");
  assert.doesNotMatch(scriptMatch[1], /@earendil-works/, "no pi imports in script");
});

// Invariant: registry.json MUST use atomic writes (tmp + rename) to prevent
// corruption from concurrent access.
test("registry uses atomic writes", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /renameSync/, "atomic rename in writeRegistry");
  assert.match(source, /registry\.json/, "registry path defined");
});

// Invariant: on fresh startup, the extension MUST check for independent loops
// still running from a previous session.
test("startup discovers independent loops via registry", async () => {
  const source = await readFile(new URL("../src/tools/loop.ts", import.meta.url), "utf8");
  assert.match(source, /event\.reason\s*===\s*"startup"/, "checks startup reason");
  assert.match(source, /readRegistry\(\)/, "reads registry on startup");
  assert.match(source, /isPidAlive/, "checks if loop process is alive");
});

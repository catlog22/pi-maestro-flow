import assert from "node:assert/strict";
import test from "node:test";
import { SchedulerCore, type SchedulerTimerHandle } from "../src/public/v1/scheduler.ts";

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  unref(): void;
}

function createHarness(onError?: (error: unknown, id: string) => void) {
  const timers: FakeTimer[] = [];
  let now = 1_000;
  const scheduler = new SchedulerCore({
    now: () => now,
    setTimer(callback, delayMs) {
      const timer: FakeTimer = { callback, delayMs, cleared: false, unref() {} };
      timers.push(timer);
      return timer as unknown as SchedulerTimerHandle;
    },
    clearTimer(timer) {
      (timer as unknown as FakeTimer).cleared = true;
    },
    onError,
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

test("uses fixed delay and keeps each ID single-flight", async () => {
  let active = 0;
  let maxActive = 0;
  const resolvers: Array<() => void> = [];
  const harness = createHarness();
  harness.scheduler.schedule({
    id: "work",
    intervalMs: 500,
    async run() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active--;
    },
  });

  assert.equal(harness.timers[0].delayMs, 500);
  harness.advance(500);
  harness.fire(0);
  harness.timers[0].callback();
  assert.equal(maxActive, 1);
  assert.equal(harness.timers.length, 1, "no timer is armed while the run is active");

  resolvers[0]();
  await flush();
  assert.equal(harness.timers[1].delayMs, 500, "the next delay starts after completion");
});

test("can schedule the first run immediately", () => {
  const harness = createHarness();
  harness.scheduler.schedule({ id: "now", intervalMs: 500, immediate: true, run() {} });
  assert.equal(harness.timers[0].delayMs, 0);
});

test("cancel aborts an awaited run and fences its late completion", async () => {
  let resolveRun!: () => void;
  let signal: AbortSignal | undefined;
  const harness = createHarness();
  harness.scheduler.schedule({
    id: "cancel-me",
    intervalMs: 500,
    run(context) {
      signal = context.signal;
      return new Promise<void>((resolve) => { resolveRun = resolve; });
    },
  });

  harness.fire(0);
  assert.equal(signal?.aborted, false);
  assert.equal(harness.scheduler.cancel("cancel-me"), true);
  assert.equal(signal?.aborted, true);
  resolveRun();
  await flush();
  assert.equal(harness.scheduler.has("cancel-me"), false);
  assert.equal(harness.timers.length, 1, "the stale completion cannot rearm the task");
});

test("pause clears timers and resume rearms a full fixed delay", () => {
  const harness = createHarness();
  harness.scheduler.schedule({ id: "paused", intervalMs: 750, run() {} });
  harness.scheduler.pause();
  assert.equal(harness.scheduler.isPaused, true);
  assert.equal(harness.timers[0].cleared, true);

  harness.scheduler.resume();
  assert.equal(harness.scheduler.isPaused, false);
  assert.equal(harness.timers[1].delayMs, 750);
});

test("resume waits for an aborted invocation to settle before rearming", async () => {
  let resolveRun!: () => void;
  let runs = 0;
  const harness = createHarness();
  harness.scheduler.schedule({
    id: "slow",
    intervalMs: 400,
    run() {
      runs++;
      return new Promise<void>((resolve) => { resolveRun = resolve; });
    },
  });

  harness.fire(0);
  harness.scheduler.pause();
  harness.scheduler.resume();
  assert.equal(harness.timers.length, 1, "resume cannot overlap the in-flight invocation");
  assert.equal(runs, 1);

  resolveRun();
  await flush();
  assert.equal(harness.timers[1].delayMs, 400);
});

test("shutdown aborts work and permanently prevents late revival", async () => {
  let resolveRun!: () => void;
  let signal: AbortSignal | undefined;
  const harness = createHarness();
  harness.scheduler.schedule({
    id: "shutdown",
    intervalMs: 300,
    run(context) {
      signal = context.signal;
      return new Promise<void>((resolve) => { resolveRun = resolve; });
    },
  });
  harness.fire(0);
  harness.scheduler.shutdown();
  assert.equal(signal?.aborted, true);
  assert.equal(harness.scheduler.isShutdown, true);
  resolveRun();
  await flush();
  assert.equal(harness.timers.length, 1);
  assert.throws(
    () => harness.scheduler.schedule({ id: "late", intervalMs: 1, run() {} }),
    /shut down/,
  );
});

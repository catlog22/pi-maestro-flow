import assert from "node:assert/strict";
import test from "node:test";
import {
  createMonitorSessionStartup,
  type MonitorSessionStartupTimer,
} from "../src/extension/monitor-session-startup.ts";

function timerHarness() {
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  const timer: MonitorSessionStartupTimer = {
    setTimeout(callback) {
      const handle = { callback, cancelled: false };
      scheduled.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      (handle as unknown as { cancelled: boolean }).cancelled = true;
    },
  };
  return {
    timer,
    fireNext() {
      const handle = scheduled.shift();
      assert.ok(handle, "expected startup timeout");
      if (!handle.cancelled) handle.callback();
    },
    pending: () => scheduled.filter((handle) => !handle.cancelled).length,
  };
}

function invocation() {
  return {
    requestId: "monitor-eval-1",
    correlationId: "monitor-correlation",
    promptSequence: 1,
    sessionIdentity: {},
  };
}

test("successful background tool.execute waits for a later evaluator identity", async () => {
  const timers = timerHarness();
  let resolveToolExecute!: (result: { isError?: boolean }) => void;
  const startup = createMonitorSessionStartup({
    dispatch: () => new Promise((resolve) => { resolveToolExecute = resolve; }),
    isRootFenceCurrent: () => true,
    timer: timers.timer,
  });
  startup.start();
  await Promise.resolve();
  assert.equal(timers.pending(), 1);
  const pending = await Promise.race([
    startup.promise.then(() => "resolved"),
    Promise.resolve("pending"),
  ]);
  assert.equal(pending, "pending", "accepted dispatch must not imply identity publication");

  const bound = invocation();
  assert.equal(startup.accept(bound), true);
  assert.deepEqual(await startup.promise, bound);
  resolveToolExecute({ isError: false });
  await Promise.resolve();
  assert.equal(timers.pending(), 0, "identity publication clears the startup timer");
});

test("a real background dispatch error rejects immediately", async () => {
  const timers = timerHarness();
  const startup = createMonitorSessionStartup({
    dispatch: async () => ({ isError: true, content: [{ type: "text", text: "spawn failed" }] }),
    isRootFenceCurrent: () => true,
    timer: timers.timer,
  });
  startup.start();
  await assert.rejects(startup.promise, /spawn failed/);
  assert.equal(timers.pending(), 0);
});

test("missing identity is bounded and fail-closed under an injected timer", async () => {
  const timers = timerHarness();
  const startup = createMonitorSessionStartup({
    dispatch: async () => ({ isError: false }),
    isRootFenceCurrent: () => true,
    timer: timers.timer,
  });
  startup.start();
  await Promise.resolve();
  assert.equal(timers.pending(), 1);
  timers.fireNext();
  await assert.rejects(startup.promise, /did not publish a session identity/);
});

test("root fence loss fails closed at the same bounded startup deadline", async () => {
  const timers = timerHarness();
  const startup = createMonitorSessionStartup({
    dispatch: async () => ({ isError: false }),
    isRootFenceCurrent: () => false,
    timer: timers.timer,
  });
  startup.start();
  await Promise.resolve();
  timers.fireNext();
  await assert.rejects(startup.promise, /session changed before its session identity was published/);
});

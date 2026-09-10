import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_STATUS_HEARTBEAT_MS,
  buildBackgroundStatusHeartbeatMessage,
  createBackgroundStatusHeartbeat,
  type BackgroundStatusSnapshot,
} from "../src/extension/background-status-heartbeat.ts";

class FakeScheduler {
  #nextId = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly delays = new Map<number, number>();

  setTimeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const id = this.#nextId++;
    this.callbacks.set(id, callback);
    this.delays.set(id, delayMs);
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    const id = timer as unknown as number;
    this.callbacks.delete(id);
    this.delays.delete(id);
  };

  fire(id = [...this.callbacks.keys()][0]): void {
    assert.ok(id !== undefined, "expected a scheduled heartbeat");
    const callback = this.callbacks.get(id);
    assert.ok(callback, `missing timer ${id}`);
    this.callbacks.delete(id);
    this.delays.delete(id);
    callback();
  }
}

function activeSnapshot(): BackgroundStatusSnapshot {
  return {
    teammates: [{
      id: "agent-1",
      label: "reviewer",
      status: "running",
      phase: "tool-execution",
      lastActivityAt: 9_000,
    }],
    bashJobs: [{
      id: "bg-1",
      command: "npm test",
      status: "running",
      startedAt: 8_000,
    }],
  };
}

test("background heartbeat content is explicit monitoring-only state", () => {
  const message = buildBackgroundStatusHeartbeatMessage({
    ...activeSnapshot(),
    teammates: [
      ...activeSnapshot().teammates,
      { id: "done", label: "finished", status: "completed" },
    ],
  }, 10_000);

  assert.match(message.content, /NOT a task completion notification/);
  assert.match(message.content, /1 teammate\(s\), 1 bash_bg job\(s\)/);
  assert.match(message.content, /@reviewer: running \/ tool-execution · activity 1s ago/);
  assert.match(message.content, /bash_bg bg-1: running · npm test/);
  assert.match(message.content, /no task was completed by this heartbeat/);
  assert.doesNotMatch(message.content, /@finished/);
  assert.equal(message.details.monitoringOnly, true);
  assert.equal(message.details.completion, false);
  assert.deepEqual(message.details.teammateIds, ["agent-1"]);
  assert.deepEqual(message.details.bashJobIds, ["bg-1"]);
});

test("settled sessions emit one heartbeat and wait for the triggered turn to settle again", () => {
  const scheduler = new FakeScheduler();
  const delivered: string[] = [];
  const controller = createBackgroundStatusHeartbeat({
    capture: activeSnapshot,
    deliver: (message) => {
      delivered.push(message.content);
      return true;
    },
    now: () => 10_000,
    scheduler,
  });

  controller.markSessionSettled();
  assert.equal(scheduler.callbacks.size, 1);
  assert.deepEqual([...scheduler.delays.values()], [BACKGROUND_STATUS_HEARTBEAT_MS]);
  scheduler.fire();
  assert.equal(delivered.length, 1);
  assert.equal(scheduler.callbacks.size, 0);

  controller.refresh();
  assert.equal(scheduler.callbacks.size, 0, "a delivered trigger owns the next turn boundary");
  controller.markSessionSettled();
  assert.equal(scheduler.callbacks.size, 1);
  controller.markSessionActive();
  assert.equal(scheduler.callbacks.size, 0);
});

test("background state changes arm and cancel the timer only while the session is settled", () => {
  const scheduler = new FakeScheduler();
  let snapshot: BackgroundStatusSnapshot = { teammates: [], bashJobs: [] };
  const controller = createBackgroundStatusHeartbeat({
    capture: () => snapshot,
    deliver: () => true,
    intervalMs: 100,
    scheduler,
  });

  controller.markSessionSettled();
  assert.equal(scheduler.callbacks.size, 0);
  snapshot = activeSnapshot();
  controller.refresh();
  assert.equal(scheduler.callbacks.size, 1);
  snapshot = { teammates: [], bashJobs: [] };
  controller.refresh();
  assert.equal(scheduler.callbacks.size, 0);

  snapshot = activeSnapshot();
  controller.markSessionActive();
  controller.refresh();
  assert.equal(scheduler.callbacks.size, 0);
});

test("reset fences stale timers and failed delivery retries with a fresh interval", () => {
  const scheduler = new FakeScheduler();
  let deliveries = 0;
  const controller = createBackgroundStatusHeartbeat({
    capture: activeSnapshot,
    deliver: () => {
      deliveries += 1;
      return false;
    },
    intervalMs: 100,
    scheduler,
  });

  controller.markSessionSettled();
  const stale = [...scheduler.callbacks.values()][0];
  assert.ok(stale);
  controller.reset();
  stale();
  assert.equal(deliveries, 0, "a prior session generation cannot deliver");

  controller.markSessionSettled();
  scheduler.fire();
  assert.equal(deliveries, 1);
  assert.equal(scheduler.callbacks.size, 1, "a rejected send remains eligible for a later retry");
});

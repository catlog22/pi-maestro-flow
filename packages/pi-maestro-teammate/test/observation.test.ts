import assert from "node:assert/strict";
import test from "node:test";
import {
  getObservationProvider,
  observeTargets,
  registerObservationProvider,
  type ObservationProvider,
  type ObservationSnapshot,
  type ObservationWaitOptions,
} from "../src/public/v1/observation.ts";

function snapshot(kind: string, id: string, status = "running"): ObservationSnapshot {
  return {
    target: { kind, id },
    found: true,
    nativeStatus: status,
    phase: status === "completed" ? "settled" : "active",
    ...(status === "completed" ? { outcome: "success" as const, waitStatus: "completed" as const } : {}),
    summary: `${kind}:${id}:${status}`,
    updatedAt: Date.now(),
  };
}

function provider(kind: string, wait: (id: string, options: ObservationWaitOptions) => Promise<ObservationSnapshot>): ObservationProvider {
  return {
    kind,
    capabilities: { inspect: true, wait: true },
    snapshot: (id) => snapshot(kind, id),
    wait,
  };
}

test("status observes mixed providers in target order", async () => {
  const disposeAgent = registerObservationProvider(provider("test-agent", async (id) => snapshot("test-agent", id, "completed")));
  const disposeJob = registerObservationProvider(provider("test-job", async (id) => snapshot("test-job", id, "completed")));
  try {
    const result = await observeTargets({
      action: "status",
      targets: [
        { kind: "test-job", id: "build" },
        { kind: "test-agent", id: "review" },
      ],
    });
    assert.equal(result.reason, "snapshot");
    assert.deepEqual(result.observations.map((item) => item.target), [
      { kind: "test-job", id: "build" },
      { kind: "test-agent", id: "review" },
    ]);
  } finally {
    disposeAgent();
    disposeJob();
  }
});

test("all waits for every provider", async () => {
  const disposeAgent = registerObservationProvider(provider("test-all-agent", async (id) => snapshot("test-all-agent", id, "completed")));
  const disposeJob = registerObservationProvider(provider("test-all-job", async (id) => snapshot("test-all-job", id, "completed")));
  try {
    const result = await observeTargets({
      action: "wait",
      waitMode: "all",
      timeoutMs: 1_000,
      targets: [
        { kind: "test-all-agent", id: "review" },
        { kind: "test-all-job", id: "build" },
      ],
    });
    assert.equal(result.reason, "all");
    assert.deepEqual(result.observations.map((item) => item.waitStatus), ["completed", "completed"]);
  } finally {
    disposeAgent();
    disposeJob();
  }
});

test("any aborts unfinished provider waits", async () => {
  let slowAborted = false;
  const disposeFast = registerObservationProvider(provider("test-fast", async (id) => snapshot("test-fast", id, "completed")));
  const disposeSlow = registerObservationProvider(provider("test-slow", (id, options) => new Promise((resolve) => {
    options.signal.addEventListener("abort", () => {
      slowAborted = true;
      resolve(snapshot("test-slow", id));
    }, { once: true });
  })));
  try {
    const result = await observeTargets({
      action: "wait",
      waitMode: "any",
      timeoutMs: 1_000,
      targets: [
        { kind: "test-fast", id: "first" },
        { kind: "test-slow", id: "second" },
      ],
    });
    assert.equal(result.reason, "any");
    assert.equal(result.observations[0]?.waitStatus, "completed");
    assert.equal(result.observations[1]?.phase, "active");
    assert.equal(slowAborted, true);
  } finally {
    disposeFast();
    disposeSlow();
  }
});

test("outer timeout is bounded and leaves target lifecycle active", async () => {
  const dispose = registerObservationProvider(provider("test-timeout", (_id, options) => new Promise((resolve) => {
    options.signal.addEventListener("abort", () => resolve(snapshot("test-timeout", "slow")), { once: true });
  })));
  try {
    const startedAt = Date.now();
    const result = await observeTargets({
      action: "wait",
      targets: [{ kind: "test-timeout", id: "slow" }],
      timeoutMs: 20,
    });
    assert.equal(result.reason, "timeout");
    assert.equal(result.observations[0]?.waitStatus, "timeout");
    assert.equal(result.observations[0]?.phase, "active");
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    dispose();
  }
});

test("provider disposal cannot remove a newer replacement", () => {
  const first = provider("test-replace", async (id) => snapshot("test-replace", id));
  const second = provider("test-replace", async (id) => snapshot("test-replace", id));
  const disposeFirst = registerObservationProvider(first);
  const disposeSecond = registerObservationProvider(second);
  disposeFirst();
  assert.equal(getObservationProvider("test-replace"), second);
  disposeSecond();
  assert.equal(getObservationProvider("test-replace"), undefined);
});

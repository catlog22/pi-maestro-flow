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

test("count settles in completion order and aborts only unfinished observation waits", async () => {
  let slowAborted = false;
  const delayedProvider = (kind: string, delayMs: number) => provider(kind, (id, options) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(snapshot(kind, id, "completed")), delayMs);
    options.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      if (kind === "test-count-slow") slowAborted = true;
      resolve(snapshot(kind, id));
    }, { once: true });
  }));
  const disposeSlow = registerObservationProvider(delayedProvider("test-count-slow", 5_000));
  const disposeFast = registerObservationProvider(delayedProvider("test-count-fast", 5));
  const disposeMedium = registerObservationProvider(delayedProvider("test-count-medium", 20));
  try {
    const result = await observeTargets({
      action: "wait",
      waitMode: "count",
      waitCount: 2,
      timeoutMs: 1_000,
      targets: [
        { kind: "test-count-slow", id: "slow" },
        { kind: "test-count-fast", id: "fast" },
        { kind: "test-count-medium", id: "medium" },
      ],
    });
    assert.equal(result.reason, "count");
    assert.deepEqual(result.observations.map((item) => item.target.id), ["slow", "fast", "medium"]);
    assert.deepEqual(result.observations.map((item) => item.waitStatus), [undefined, "completed", "completed"]);
    assert.equal(result.observations[0]?.phase, "active");
    assert.equal(slowAborted, true);
  } finally {
    disposeSlow();
    disposeFast();
    disposeMedium();
  }
});

test("external abort reaches an in-flight provider without converting target lifecycle to terminal", async () => {
  let providerAborted = false;
  const dispose = registerObservationProvider(provider("test-external-abort", (id, options) => new Promise((resolve) => {
    options.signal.addEventListener("abort", () => {
      providerAborted = true;
      resolve(snapshot("test-external-abort", id));
    }, { once: true });
  })));
  const controller = new AbortController();
  try {
    const waiting = observeTargets({
      action: "wait",
      targets: [{ kind: "test-external-abort", id: "still-running" }],
      timeoutMs: 60_000,
    }, controller.signal);
    await Promise.resolve();
    controller.abort();
    const result = await waiting;
    assert.equal(result.reason, "aborted");
    assert.equal(result.observations[0]?.phase, "active");
    assert.equal(result.observations[0]?.waitStatus, "aborted");
    assert.equal(providerAborted, true);
  } finally {
    dispose();
  }
});

test("abort before provider startup prevents the queued wait from running", async () => {
  let waitCalls = 0;
  const dispose = registerObservationProvider(provider("test-pre-start-abort", async (id) => {
    waitCalls += 1;
    return snapshot("test-pre-start-abort", id, "completed");
  }));
  const controller = new AbortController();
  try {
    const waiting = observeTargets({
      action: "wait",
      targets: [{ kind: "test-pre-start-abort", id: "not-started" }],
      timeoutMs: 60_000,
    }, controller.signal);
    controller.abort();
    const result = await waiting;
    await Promise.resolve();
    assert.equal(result.reason, "aborted");
    assert.equal(waitCalls, 0);
  } finally {
    dispose();
  }
});

test("all treats provider failures and unknown kinds as settled while preserving error identity", async () => {
  const dispose = registerObservationProvider(provider("test-reject", async () => {
    throw new Error("provider exploded");
  }));
  try {
    const result = await observeTargets({
      action: "wait",
      waitMode: "all",
      timeoutMs: 1_000,
      targets: [
        { kind: "test-reject", id: "broken" },
        { kind: "missing-provider", id: "unknown" },
      ],
    });
    assert.equal(result.reason, "all");
    assert.deepEqual(result.observations.map((item) => item.waitStatus), ["failed", "not-found"]);
    assert.deepEqual(result.observations.map((item) => item.found), [false, false]);
    assert.match(result.observations[0]?.error ?? "", /provider exploded/);
    assert.match(result.observations[1]?.error ?? "", /No observation provider/);
  } finally {
    dispose();
  }
});

test("duplicate targets remain positional and invoke the provider independently", async () => {
  let waits = 0;
  const dispose = registerObservationProvider(provider("test-duplicate", async (id) => {
    waits += 1;
    return snapshot("test-duplicate", id, "completed");
  }));
  try {
    const result = await observeTargets({
      action: "wait",
      waitMode: "all",
      targets: [
        { kind: "test-duplicate", id: "same" },
        { kind: "test-duplicate", id: "same" },
      ],
      timeoutMs: 1_000,
    });
    assert.equal(result.reason, "all");
    assert.equal(waits, 2);
    assert.equal(result.observations.length, 2);
    assert.deepEqual(result.observations.map((item) => item.target.id), ["same", "same"]);
  } finally {
    dispose();
  }
});

test("count validation rejects missing and out-of-range thresholds", async () => {
  await assert.rejects(
    observeTargets({ action: "wait", waitMode: "count", targets: [{ kind: "test", id: "one" }] }),
    /waitCount must be between 1 and the number of targets/,
  );
  await assert.rejects(
    observeTargets({
      action: "wait",
      waitMode: "count",
      waitCount: 2,
      targets: [{ kind: "test", id: "one" }],
    }),
    /waitCount must be between 1 and the number of targets/,
  );
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

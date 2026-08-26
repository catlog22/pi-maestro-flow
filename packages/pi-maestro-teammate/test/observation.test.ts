import assert from "node:assert/strict";
import test from "node:test";
import {
  formatObserveResult,
  getObservationProvider,
  observeTargets,
  registerObservationProvider,
  type ObservationProvider,
  type ObservationReadOptions,
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

test("view=turns is forwarded to provider snapshots and restricted to status", async () => {
  let received: ObservationReadOptions | undefined;
  const dispose = registerObservationProvider({
    kind: "test-turns",
    capabilities: { inspect: true, wait: true },
    snapshot: (id, options) => {
      received = options;
      return snapshot("test-turns", id, "completed");
    },
    wait: async (id) => snapshot("test-turns", id, "completed"),
  });
  try {
    const result = await observeTargets({
      action: "status",
      targets: [{ kind: "test-turns", id: "w" }],
      view: "turns",
      turn: 3,
    });
    assert.equal(result.reason, "snapshot");
    assert.equal(received?.view, "turns");
    assert.equal(received?.turn, 3);
    await assert.rejects(
      observeTargets({ action: "wait", targets: [{ kind: "test-turns", id: "w" }], view: "turns" }),
      /view="turns" is supported only for the status action/,
    );
    await assert.rejects(
      observeTargets({ action: "watch", targets: [{ kind: "test-turns", id: "w" }], view: "turns" }),
      /view="turns" is supported only for the status action/,
    );
    await assert.rejects(
      observeTargets({ action: "status", targets: [{ kind: "test-turns", id: "w" }], turn: 1 }),
      /turn requires view="turns"/,
    );
    await assert.rejects(
      observeTargets({ action: "status", targets: [{ kind: "test-turns", id: "w" }], view: "other" as never }),
      /view must be "live", "turns", "session", or "todos"/,
    );
  } finally {
    dispose();
  }
});

test("view=session forwards target cursors and restricts actions", async () => {
  let received: ObservationReadOptions | undefined;
  const dispose = registerObservationProvider({
    kind: "test-session-view",
    capabilities: { inspect: true, wait: true },
    snapshot: (id, options) => {
      received = options;
      return snapshot("test-session-view", id);
    },
    wait: async (id) => snapshot("test-session-view", id, "completed"),
  });
  try {
    await observeTargets({
      action: "status",
      targets: [{ kind: "test-session-view", id: "window", cursor: "cursor-1" }],
      view: "session",
    });
    assert.equal(received?.view, "session");
    assert.equal(received?.cursor, "cursor-1");
    await assert.rejects(
      observeTargets({ action: "wait", targets: [{ kind: "test-session-view", id: "window" }], view: "session" }),
      /view="session" is supported only for status and watch actions/,
    );
    await assert.rejects(
      observeTargets({ action: "diagnose", targets: [{ kind: "test-session-view", id: "window" }], view: "session" }),
      /view="session" is supported only for status and watch actions/,
    );
    await assert.rejects(
      observeTargets({ action: "status", targets: [{ kind: "test-session-view", id: "window", cursor: "cursor-1" }] }),
      /target cursor requires view="session"/,
    );
  } finally {
    dispose();
  }
});

test("view=todos forwards the view and restricts actions to workspace status/watch", async () => {
  let received: ObservationReadOptions | undefined;
  const dispose = registerObservationProvider({
    kind: "workspace",
    capabilities: { inspect: true, wait: true },
    snapshot: (id, options) => {
      received = options;
      return snapshot("workspace", id);
    },
    wait: async (id) => snapshot("workspace", id, "completed"),
  });
  try {
    await observeTargets({
      action: "status",
      targets: [{ kind: "workspace", id: "window" }],
      view: "todos",
    });
    assert.equal(received?.view, "todos");
    await assert.rejects(
      observeTargets({ action: "wait", targets: [{ kind: "workspace", id: "window" }], view: "todos" }),
      /view="todos" is supported only for status and watch actions/,
    );
    await assert.rejects(
      observeTargets({ action: "diagnose", targets: [{ kind: "workspace", id: "window" }], view: "todos" }),
      /view="todos" is supported only for status and watch actions/,
    );
    await assert.rejects(
      observeTargets({ action: "status", targets: [{ kind: "teammate", id: "worker" }], view: "todos" }),
      /view="todos" requires workspace targets/,
    );
  } finally {
    dispose();
  }
});

test("diagnose requests canonical provider detail without changing snapshot semantics", async () => {
  let received: ObservationReadOptions | undefined;
  const dispose = registerObservationProvider({
    kind: "test-diagnose",
    capabilities: { inspect: true, wait: true },
    snapshot: (id, options) => {
      received = options;
      return {
        ...snapshot("test-diagnose", id),
        diagnosis: {
          version: 1,
          lifecycle: "running",
          health: "stalled",
          phase: "settling",
          activity: "running",
          toolActivity: "active",
          resultReady: false,
          reasonCode: "awaiting-agent-settled",
          trigger: {
            version: 1,
            source: "unknown",
            confidence: "unknown",
            sender: { kind: "unknown" },
          },
          fallbackDisposition: "ineligible",
        },
      };
    },
    wait: async (id) => snapshot("test-diagnose", id, "completed"),
  });
  try {
    const result = await observeTargets({
      action: "diagnose",
      targets: [{ kind: "test-diagnose", id: "worker" }],
      detail: "full",
    });
    assert.equal(result.action, "diagnose");
    assert.equal(result.reason, "snapshot");
    assert.equal(received?.diagnose, true);
    assert.equal(result.observations[0]?.diagnosis?.reasonCode, "awaiting-agent-settled");
    const formatted = formatObserveResult(result);
    assert.match(formatted.join("\n"), /lifecycle=running phase=settling health=stalled activity=running tool=active/);
    assert.match(formatted.join("\n"), /trigger: source=unknown confidence=unknown sender=unknown/);
    assert.match(formatted.join("\n"), /last-message: unavailable/);
    await assert.rejects(
      observeTargets({ action: "diagnose", targets: [{ kind: "test-diagnose", id: "worker" }], timeoutMs: 1 }),
      /timeoutMs is supported only for wait and watch/,
    );
    await assert.rejects(
      observeTargets({ action: "diagnose", targets: [{ kind: "test-diagnose", id: "worker" }], view: "turns" }),
      /view="turns" is supported only for the status action/,
    );
  } finally {
    dispose();
  }
});

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

test("validation rejects action-inapplicable parameters and oversized lines", async () => {
  const target = [{ kind: "test", id: "one" }];
  await assert.rejects(
    observeTargets({ action: "watch", targets: target, until: "completed", timeoutMs: 10 }),
    /supported only for the wait action/,
  );
  await assert.rejects(
    observeTargets({ action: "status", targets: target, timeoutMs: 10 }),
    /supported only for wait and watch actions/,
  );
  await assert.rejects(
    observeTargets({ action: "wait", targets: target, waitCount: 1 }),
    /requires waitMode="count"/,
  );
  await assert.rejects(
    observeTargets({ action: "status", targets: target, lines: 501 }),
    /between 1 and 500/,
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

// --- watch: persistent observation returns the transition timeline ---

test("watch polls targets and returns status transitions until deadline", async () => {
  let calls = 0;
  const dispose = registerObservationProvider({
    kind: "test-watch",
    capabilities: { inspect: true, wait: true },
    snapshot: (id) => {
      calls += 1;
      // First call: running; later calls: completed (transition recorded once)
      return snapshot("test-watch", id, calls === 1 ? "running" : "completed");
    },
    wait: async (id) => snapshot("test-watch", id, "completed"),
  });
  try {
    const result = await observeTargets({
      action: "watch",
      targets: [{ kind: "test-watch", id: "job" }],
      timeoutMs: 250,
    });
    assert.equal(result.action, "watch");
    // Initial running snapshot + transition to completed
    assert.ok(result.observations.length >= 2, `expected >= 2 transitions, got ${result.observations.length}`);
    assert.equal(result.observations[0]?.nativeStatus, "running");
    assert.ok(result.observations.some((o) => o.nativeStatus === "completed"));
  } finally {
    dispose();
  }
});

test("watch records revision changes while lifecycle status stays unchanged", async () => {
  let calls = 0;
  const dispose = registerObservationProvider({
    kind: "test-watch-revision",
    capabilities: { inspect: true, wait: true },
    snapshot: (id, options) => {
      calls += 1;
      assert.equal(options.view, "session");
      return {
        ...snapshot("test-watch-revision", id),
        revision: calls === 1 ? "revision-1" : "revision-2",
      };
    },
    wait: async (id) => snapshot("test-watch-revision", id, "completed"),
  });
  try {
    const result = await observeTargets({
      action: "watch",
      targets: [{ kind: "test-watch-revision", id: "window" }],
      view: "session",
      timeoutMs: 250,
    });
    assert.deepEqual(result.observations.map((item) => item.revision), ["revision-1", "revision-2"]);
  } finally {
    dispose();
  }
});

test("watch respects abort signal", async () => {
  const dispose = registerObservationProvider(provider("test-watch-abort", async (id) => snapshot("test-watch-abort", id, "running")));
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await observeTargets({
      action: "watch",
      targets: [{ kind: "test-watch-abort", id: "job" }],
      timeoutMs: 10_000,
    }, controller.signal);
    assert.equal(result.reason, "aborted");
  } finally {
    dispose();
  }
});

// --- until: wait for terminal completion ---

test("until option is forwarded to providers", async () => {
  let receivedUntil: string | undefined;
  const dispose = registerObservationProvider({
    kind: "test-until",
    capabilities: { inspect: true, wait: true },
    snapshot: (id) => snapshot("test-until", id, "running"),
    wait: async (_id, options) => {
      receivedUntil = options.until;
      return snapshot("test-until", "job", "completed");
    },
  });
  try {
    await observeTargets({
      action: "wait",
      until: "completed",
      targets: [{ kind: "test-until", id: "job" }],
      timeoutMs: 1_000,
    });
    assert.equal(receivedUntil, "completed");
  } finally {
    dispose();
  }
});

test("formatObserveResult renders last results unconditionally; verbose keeps the multiline text", () => {
  const observation: ObservationSnapshot = {
    target: { kind: "teammate", id: "job" },
    found: true,
    nativeStatus: "sleeping",
    phase: "settled",
    lastResult: "first line\nsecond line",
    summary: "done",
    updatedAt: Date.now(),
  };
  const result = {
    action: "status" as const,
    reason: "snapshot" as const,
    observations: [observation],
    durationMs: 1,
  };

  const verbose = formatObserveResult(result, true).join("\n");
  assert.match(verbose, /--- last result ---/);
  assert.match(verbose, /first line\n  second line/);
  // Non-verbose still surfaces the result, flattened to one excerpt line so a
  // polling observer can tell "finished" from "not started" without asking for
  // detail. The full multiline text is reserved for verbose.
  const nonVerbose = formatObserveResult(result, false).join("\n");
  assert.match(nonVerbose, /result: first line second line/);
  assert.doesNotMatch(nonVerbose, /--- last result ---/);
});

test("formatObserveResult excerpts a long non-verbose last result and keeps it whole in verbose", () => {
  const longText = "word ".repeat(60).trim(); // 299 chars, past the 240-char excerpt bound
  const observation: ObservationSnapshot = {
    target: { kind: "teammate", id: "job" },
    found: true,
    nativeStatus: "sleeping",
    phase: "settled",
    lastResult: longText,
    summary: "done",
    updatedAt: Date.now(),
  };
  const result = {
    action: "status" as const,
    reason: "snapshot" as const,
    observations: [observation],
    durationMs: 1,
  };

  // Non-verbose flattens whitespace and truncates to the excerpt bound, ending
  // with an ellipsis so a shortened result never reads as a complete one.
  const nonVerbose = formatObserveResult(result, false).join("\n");
  assert.match(nonVerbose, /result: word word/);
  assert.match(nonVerbose, /…$/m);
  const excerptLine = nonVerbose.split("\n").find((line) => line.startsWith("  result: ")) ?? "";
  // Excerpt body (minus "  result: " prefix and trailing ellipsis) is the bound.
  assert.ok(excerptLine.length - "  result: ".length - 1 <= 240);

  // Verbose keeps the full text, untruncated and on its own block.
  const verbose = formatObserveResult(result, true).join("\n");
  assert.match(verbose, /--- last result ---/);
  assert.ok(verbose.includes(longText));
});

test("formatObserveResult renders structured output only in verbose detail", () => {
  const observation: ObservationSnapshot = {
    target: { kind: "teammate", id: "job" },
    found: true,
    nativeStatus: "sleeping",
    phase: "settled",
    waitStatus: "completed",
    terminalStatus: "completed",
    structuredOutput: { verdict: "ok", count: 2 },
    summary: "done",
    updatedAt: Date.now(),
  };
  const result = {
    action: "status" as const,
    reason: "snapshot" as const,
    observations: [observation],
    durationMs: 1,
  };

  const verbose = formatObserveResult(result, true).join("\n");
  assert.match(verbose, /--- structured output ---/);
  assert.match(verbose, /"verdict": "ok"/);
  assert.match(verbose, /"count": 2/);

  const compact = formatObserveResult(result, false).join("\n");
  assert.doesNotMatch(compact, /structured output/);
  assert.match(compact, /teammate:job/);
});

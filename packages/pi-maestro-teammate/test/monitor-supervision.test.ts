import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MONITOR_CONFIG,
  addBinding,
  buildAnalysisTrendBlock,
  computeDriftScore,
  createEngineState,
  deriveMonitorMetrics,
  engineTick,
  formatEngineStatusBar,
  formatMonitorMetrics,
  heuristicCheck,
  normalizeMonitorConfig,
  sendInterventionWithRetry,
  type EngineAgentInfo,
  type MonitorEngineState,
} from "../src/extension/monitor.ts";
import {
  appendMonitorLedgerRecord,
  deriveMonitorLedgerState,
  loadMonitorLedger,
  reconcileMonitorLedger,
  type MonitorLedgerRecord,
} from "../src/extension/monitor-ledger.ts";

// ---------------------------------------------------------------------------
// Config normalization
// ---------------------------------------------------------------------------

test("normalizeMonitorConfig applies defaults", () => {
  const config = normalizeMonitorConfig(undefined, { env: {} });
  assert.deepEqual(config, DEFAULT_MONITOR_CONFIG);
  assert.equal(config.tickMs, 15_000);
  assert.equal(config.stallIdleSeconds, 60);
  assert.equal(config.interventionCooldownMs, 60_000);
  assert.equal(config.maxRetries, 2);
  assert.equal(config.escalationThreshold, 2);
  assert.equal(config.autoResume, true);
});

test("normalizeMonitorConfig merges settings source", () => {
  const config = normalizeMonitorConfig({
    tickMs: 5_000,
    stallIdleSeconds: 30,
    escalationThreshold: 3,
    ledgerEnabled: false,
    autoResume: false,
  }, { env: {} });
  assert.equal(config.tickMs, 5_000);
  assert.equal(config.stallIdleSeconds, 30);
  assert.equal(config.escalationThreshold, 3);
  assert.equal(config.ledgerEnabled, false);
  assert.equal(config.autoResume, false);
  // Untouched fields keep defaults.
  assert.equal(config.maxRetries, 2);
});

test("normalizeMonitorConfig env overrides win and ignore garbage", () => {
  const config = normalizeMonitorConfig({ tickMs: 5_000 }, {
    env: {
      PI_MONITOR_TICK_MS: "3000",
      PI_MONITOR_STALL_IDLE_SECONDS: "not-a-number",
      PI_MONITOR_LEDGER: "off",
      PI_MONITOR_AUTO_RESUME: "0",
    } as NodeJS.ProcessEnv,
  });
  assert.equal(config.tickMs, 3_000, "env beats settings");
  assert.equal(config.stallIdleSeconds, 60, "garbage env ignored");
  assert.equal(config.ledgerEnabled, false);
  assert.equal(config.autoResume, false);
});

// ---------------------------------------------------------------------------
// Ledger round-trip
// ---------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "monitor-ledger-"));
}

test("ledger append/load round-trip with normalization", async () => {
  const root = await tempRoot();
  try {
    const appended = await appendMonitorLedgerRecord(root, {
      kind: "intervention",
      action: "steer",
      status: "sent",
      target: "owner:abc123",
      traceId: "trace-1",
      reason: "drift",
      message: "Please refocus on the objective.",
    });
    assert.ok(appended.id);
    assert.ok(appended.at);

    const loaded = await loadMonitorLedger(root);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.records[0]!.kind, "intervention");
    assert.equal(loaded.records[0]!.target, "owner:abc123");
    assert.equal(loaded.records[0]!.reason, "drift");
    assert.equal(loaded.records[0]!.traceId, "trace-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger tolerates missing file and trailing partial line", async () => {
  const root = await tempRoot();
  try {
    const empty = await loadMonitorLedger(root);
    assert.equal(empty.records.length, 0);

    // Trailing partial line (crash mid-append) is a warning, not an error.
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "monitor-ledger.jsonl"), '{"kind":"binding","action":"enter","status":"active","target":"cid-1"}\n{"kind":"intervent', "utf8");
    const loaded = await loadMonitorLedger(root);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0]!, /trailing corrupt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger derive read-model: binding lifecycle + counts", async () => {
  const root = await tempRoot();
  try {
    await appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-a", metadata: { displayName: "window-a", mode: "auto" } });
    await appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-b", metadata: { displayName: "window-b", mode: "custom", customPrompt: "check tests" } });
    await appendMonitorLedgerRecord(root, { kind: "intervention", action: "steer", status: "sent", target: "cid-a", traceId: "t1", reason: "drift" });
    await appendMonitorLedgerRecord(root, { kind: "outcome", action: "resolve", status: "recovered", target: "cid-a", traceId: "t1" });
    await appendMonitorLedgerRecord(root, { kind: "delivery", action: "dead-letter", status: "failed", target: "cid-b", traceId: "t2", attempts: 3 });
    await appendMonitorLedgerRecord(root, { kind: "binding", action: "exit", status: "user-exit", target: "cid-b" });
    await appendMonitorLedgerRecord(root, { kind: "analysis", action: "verdict", status: "drift", target: "cid-a" });

    const loaded = await loadMonitorLedger(root);
    const state = deriveMonitorLedgerState(loaded.records);

    assert.equal(state.records, 7);
    assert.equal(state.bindings.length, 2);
    assert.equal(state.activeBindings.length, 1);
    assert.equal(state.activeBindings[0]!.target, "cid-a");
    assert.equal(state.disconnectedBindings.length, 0);

    const a = state.bindings.find((b) => b.target === "cid-a")!;
    assert.equal(a.interventionCount, 1);
    assert.equal(a.outcomeCount, 1);
    assert.equal(a.escalated, false);

    const b = state.bindings.find((b) => b.target === "cid-b")!;
    assert.equal(b.status, "user-exit");
    assert.equal(b.mode, "custom");
    assert.equal(b.customPrompt, "check tests");

    assert.equal(state.interventions.length, 1);
    assert.equal(state.outcomes.length, 1);
    assert.equal(state.deadLetters.length, 1);
    assert.equal(state.analyses.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger reconcile marks orphaned active bindings disconnected", async () => {
  const root = await tempRoot();
  try {
    await appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-live", metadata: { displayName: "live" } });
    await appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-orphan", metadata: { displayName: "orphan" } });

    const reconciled = await reconcileMonitorLedger(root, { liveTargets: ["cid-live"], nowMs: Date.now() });
    assert.equal(reconciled.records.length, 1);
    assert.equal(reconciled.records[0]!.target, "cid-orphan");
    assert.equal(reconciled.records[0]!.status, "disconnected");

    const state = deriveMonitorLedgerState((await loadMonitorLedger(root)).records);
    assert.equal(state.activeBindings.length, 1);
    assert.equal(state.activeBindings[0]!.target, "cid-live");
    assert.equal(state.disconnectedBindings.length, 1);
    assert.equal(state.disconnectedBindings[0]!.target, "cid-orphan");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger is durable across readers with lock", async () => {
  const root = await tempRoot();
  try {
    // Concurrent appends must not drop records (directory lock serializes).
    await Promise.all([
      appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-1" }),
      appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-2" }),
      appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-3" }),
    ]);
    const loaded = await loadMonitorLedger(root);
    assert.equal(loaded.records.length, 3);
    const text = await readFile(join(root, ".pi", "monitor-ledger.jsonl"), "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Engine: delivery retry + dead-letter
// ---------------------------------------------------------------------------

function engineInfo(name: string, status: string, idle = 5): EngineAgentInfo {
  return {
    correlationId: `cid-${name}`,
    name,
    status,
    idleSeconds: idle,
    outputTail: ["working"],
    objective: "Build the API",
    hasPendingInteractions: false,
  };
}

test("sendInterventionWithRetry delivers on first attempt", async () => {
  const result = await sendInterventionWithRetry(
    () => true,
    "continue",
    "steer",
    2,
    1,
    { sleepFn: async () => { throw new Error("should not sleep"); } },
  );
  assert.deepEqual(result, { delivered: true, attempts: 1 });
});

test("sendInterventionWithRetry retries then succeeds", async () => {
  let calls = 0;
  const result = await sendInterventionWithRetry(
    () => { calls += 1; return calls >= 3; },
    "continue",
    "steer",
    2,
    1,
    { sleepFn: async () => {} },
  );
  assert.deepEqual(result, { delivered: true, attempts: 3 });
  assert.equal(calls, 3);
});

test("sendInterventionWithRetry dead-letters after maxRetries", async () => {
  let calls = 0;
  const result = await sendInterventionWithRetry(
    () => { calls += 1; return false; },
    "continue",
    "steer",
    2,
    1,
    { sleepFn: async () => {} },
  );
  assert.deepEqual(result, { delivered: false, attempts: 3 });
  assert.equal(calls, 3);
});

test("engineTick dead-letters an unreachable target and notifies main", async () => {
  const engine = createEngineState();
  const notified: string[] = [];
  const ledger: MonitorLedgerRecord[] = [];
  addBinding(engine, "owner:gone", "far-away", "auto");

  engine.callbacks = {
    getAgentInfo: () => engineInfo("far-away", "running", 120),
    sendIntervention: () => false, // always unreachable
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
    recordLedger: (record) => { ledger.push(record); },
  };

  const count = await engineTick(engine);
  assert.equal(count, 0, "undelivered interventions do not count");
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /failed after 3 attempt/);
  const deadLetter = ledger.find((r) => r.kind === "delivery");
  assert.ok(deadLetter);
  assert.equal(deadLetter!.status, "failed");
  assert.equal(deadLetter!.attempts, 3);
  assert.ok(deadLetter!.traceId);
});

// ---------------------------------------------------------------------------
// Engine: intervention outcome closed loop
// ---------------------------------------------------------------------------

function makeStalledEngine(opts: { ledger?: MonitorLedgerRecord[]; notified?: string[] } = {}): MonitorEngineState {
  const engine = createEngineState();
  engine.config.escalationThreshold = 2;
  engine.config.pendingOutcomeEvalMs = 1; // evaluate immediately
  engine.config.retryBackoffMs = 1;
  addBinding(engine, "cid-slow", "slow", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("slow", "running", 120),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { opts.notified?.push(msg); },
    ...(opts.ledger ? { recordLedger: (record) => { opts.ledger!.push(record); } } : {}),
  };
  return engine;
}

test("engineTick pending intervention resolves recovered when agent resumes", async () => {
  const engine = createEngineState();
  engine.config.pendingOutcomeEvalMs = 1;
  engine.config.retryBackoffMs = 1;
  addBinding(engine, "cid-slow", "slow", "auto");

  let idle = 120;
  engine.callbacks = {
    getAgentInfo: () => engineInfo("slow", "running", idle),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: () => {},
  };

  // Tick 1: stalled → intervention sent, pending set.
  assert.equal(await engineTick(engine), 1);
  const binding = engine.bindings.get("cid-slow")!;
  assert.ok(binding.pendingIntervention);
  // Backdate so the outcome eval window (pendingOutcomeEvalMs) has elapsed.
  binding.pendingIntervention!.at = Date.now() - 1_000;

  // Agent resumes work (idle resets) — outcome recovered, pending cleared.
  idle = 5;
  assert.equal(await engineTick(engine), 0);
  assert.equal(binding.pendingIntervention, undefined);
  assert.equal(binding.interventionStreak, 0);
});

test("engineTick escalates after repeated unresolved interventions", async () => {
  const engine = createEngineState();
  engine.config.escalationThreshold = 2;
  engine.config.pendingOutcomeEvalMs = 1;
  engine.config.retryBackoffMs = 1;
  engine.config.interventionCooldownMs = 1;
  const notified: string[] = [];
  const ledger: MonitorLedgerRecord[] = [];
  addBinding(engine, "cid-slow", "slow", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("slow", "running", 120),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
    recordLedger: (record) => { ledger.push(record); },
  };

  // Tick 1: intervention sent.
  assert.equal(await engineTick(engine), 1);
  const binding = engine.bindings.get("cid-slow")!;
  binding.pendingIntervention!.at = Date.now() - 1_000;
  // Tick 2: still stalled → repeated (streak 1), no new intervention (cooldown).
  assert.equal(await engineTick(engine), 0);
  assert.equal(binding.interventionStreak, 1);
  binding.pendingIntervention!.at = Date.now() - 1_000;
  // Tick 3: still stalled → repeated (streak 2) → escalation + notifyMain.
  assert.equal(await engineTick(engine), 0);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /still stalled after 2 intervention/);

  const outcomes = ledger.filter((r) => r.kind === "outcome");
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]!.status, "repeated");
  assert.equal(outcomes[1]!.status, "escalated");
  assert.equal(outcomes[1]!.traceId, outcomes[0]!.traceId, "escalation shares the intervention trace");

  assert.equal(binding.pendingIntervention, undefined, "escalation clears pending");
  assert.equal(binding.interventionStreak, 2);
});

test("engineTick records verdict flips only on change", async () => {
  const engine = createEngineState();
  const ledger: MonitorLedgerRecord[] = [];
  addBinding(engine, "cid-ok", "ok", "auto");
  let verdict: { status: "drift" | "on-track"; action: "none" | "send" } = { status: "on-track", action: "none" };
  engine.callbacks = {
    getAgentInfo: () => engineInfo("ok", "running", 0),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: () => {},
    analyze: async () => verdict,
    recordLedger: (record) => { ledger.push(record); },
  };

  await engineTick(engine);
  await engineTick(engine);
  const analyses = ledger.filter((r) => r.kind === "analysis");
  assert.equal(analyses.length, 1, "unchanged verdict must not re-append");
  assert.equal(analyses[0]!.status, "on-track");

  verdict = { status: "drift", action: "send" };
  await engineTick(engine);
  const afterFlip = ledger.filter((r) => r.kind === "analysis");
  assert.equal(afterFlip.length, 2);
  assert.equal(afterFlip[1]!.status, "drift");
});

test("engineTick records binding enter/exit and intervention ledger events", async () => {
  const engine = createEngineState();
  engine.config.retryBackoffMs = 1;
  const ledger: MonitorLedgerRecord[] = [];
  const engineKey = "cid-x";
  addBinding(engine, engineKey, "window-x", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("x", "running", 120),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: () => {},
    recordLedger: (record) => { ledger.push(record); },
  };

  // Enter record is buffered until the engine starts (callbacks wired).
  assert.equal(engine.pendingLedgerRecords.length, 1, "enter buffered before engine start");

  await engineTick(engine);
  const enters = ledger.filter((r) => r.kind === "binding" && r.action === "enter");
  assert.equal(enters.length, 1, "buffered enter flushed on first tick");
  const sent = ledger.filter((r) => r.kind === "intervention" && r.status === "injected");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.traceId);

  // Agent gone → exit record.
  engine.callbacks.getAgentInfo = () => undefined;
  await engineTick(engine);
  const gone = ledger.find((r) => r.kind === "binding" && r.status === "gone");
  assert.ok(gone);
  assert.equal(engine.bindings.size, 0);
});

// ---------------------------------------------------------------------------
// Engine: drift signal field (history + decay-weighted score + elevation)
// ---------------------------------------------------------------------------

test("computeDriftScore decays old verdicts and counts on-track negatively", () => {
  const now = 1_000_000;
  const halfLifeMs = 60_000;
  // Pure drift at t=0 → score ≈ 1 (weight 1).
  const fresh = computeDriftScore([{ at: now - 1_000, verdict: "drift" }], now, { halfLifeMs });
  assert.ok(fresh > 0.9 && fresh <= 1, `fresh drift ≈ 1, got ${fresh}`);
  // Old drift decays toward zero.
  const old = computeDriftScore([{ at: now - 10 * halfLifeMs, verdict: "drift" }], now, { halfLifeMs });
  assert.ok(old < 0.01, `old drift ≈ 0, got ${old}`);
  // On-track offsets drift.
  const mixed = computeDriftScore([
    { at: now - 1_000, verdict: "drift" },
    { at: now - 2_000, verdict: "on-track" },
  ], now, { halfLifeMs });
  assert.ok(mixed < 1 && mixed > 0, `mixed ≈ 0.5, got ${mixed}`);
  // Empty history → 0.
  assert.equal(computeDriftScore([], now, { halfLifeMs }), 0);
});

test("buildAnalysisTrendBlock injects verdict sequence and elevation note", () => {
  const block = buildAnalysisTrendBlock([
    { at: 0, verdict: "on-track" },
    { at: 0, verdict: "drift" },
    { at: 0, verdict: "drift" },
  ], 2.4);
  assert.match(block, /on-track · drift · drift/);
  assert.match(block, /score: 2\.40/);
  assert.match(block, /ELEVATED/);

  const calm = buildAnalysisTrendBlock([{ at: 0, verdict: "on-track" }], -0.5);
  assert.match(calm, /on-track/);
  assert.doesNotMatch(calm, /ELEVATED/);

  assert.equal(buildAnalysisTrendBlock([], 0), "", "no history → no block");
});

test("engineTick elevates binding on repeated drift and notifies once", async () => {
  const engine = createEngineState();
  engine.config.pendingOutcomeEvalMs = 1;
  const notified: string[] = [];
  addBinding(engine, "cid-drift", "wanderer", "auto");
  let verdict: { status: "drift" | "on-track"; action: "none" | "send" } = { status: "drift", action: "none" };
  engine.callbacks = {
    getAgentInfo: () => engineInfo("wanderer", "running", 0),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
    analyze: async () => verdict,
  };

  // Tick 1: drift → score ~1, not elevated yet.
  await engineTick(engine);
  const binding = engine.bindings.get("cid-drift")!;
  assert.ok(binding.driftScore > 0.9, `score ≈ 1, got ${binding.driftScore}`);
  assert.equal(binding.elevated, false);
  assert.equal(notified.length, 0);

  // Tick 3: drift accumulates → score ≈ 3 → elevated + notify once.
  await engineTick(engine);
  await engineTick(engine);
  assert.equal(binding.elevated, true);
  assert.equal(notified.length, 1);
  assert.match(notified[0]!, /drift trend rising/);

  // Tick 4: still drift → stays elevated, no repeated notification.
  await engineTick(engine);
  assert.equal(notified.length, 1, "elevation must notify only on transition");
});

test("engineTick clears elevation when score decays below threshold", async () => {
  const engine = createEngineState();
  const notified: string[] = [];
  addBinding(engine, "cid-drift2", "wanderer2", "auto");
  let verdict: { status: "drift" | "on-track"; action: "none" | "send" } = { status: "drift", action: "none" };
  engine.callbacks = {
    getAgentInfo: () => engineInfo("wanderer2", "running", 0),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
    analyze: async () => verdict,
  };

  await engineTick(engine);
  await engineTick(engine);
  await engineTick(engine);
  const binding = engine.bindings.get("cid-drift2")!;
  assert.equal(binding.elevated, true);
  assert.equal(notified.length, 1);

  // Backdate the history so old drift decays, then long on-track streak.
  binding.analysisHistory = binding.analysisHistory.map((record) => ({ ...record, at: Date.now() - 30 * 60_000 }));
  verdict = { status: "on-track", action: "none" };
  for (let i = 0; i < 12; i++) await engineTick(engine);
  assert.equal(binding.elevated, false, "score decayed below clear threshold");
  assert.equal(notified.length, 1, "clearing elevation must not notify");
});

// ---------------------------------------------------------------------------
// Metrics derivation (ledger read-model → supervision metrics)
// ---------------------------------------------------------------------------

test("deriveMonitorMetrics computes rates from ledger records", () => {
  const state = deriveMonitorLedgerState([
    // 4 interventions
    { kind: "intervention", action: "steer", status: "sent", target: "a", traceId: "t1" },
    { kind: "intervention", action: "steer", status: "sent", target: "a", traceId: "t2" },
    { kind: "intervention", action: "steer", status: "sent", target: "a", traceId: "t3" },
    { kind: "intervention", action: "steer", status: "sent", target: "b", traceId: "t4" },
    // outcomes: 2 recovered, 1 escalated, 1 failed
    { kind: "outcome", action: "resolve", status: "recovered", target: "a", traceId: "t1" },
    { kind: "outcome", action: "resolve", status: "recovered", target: "a", traceId: "t2" },
    { kind: "outcome", action: "resolve", status: "escalated", target: "a", traceId: "t3" },
    { kind: "outcome", action: "resolve", status: "failed", target: "b", traceId: "t4" },
    // delivery failures
    { kind: "delivery", action: "dead-letter", status: "failed", target: "b", traceId: "t5", attempts: 3 },
    // analysis: 3 verdicts, 1 drift
    { kind: "analysis", action: "verdict", status: "on-track", target: "a" },
    { kind: "analysis", action: "verdict", status: "drift", target: "a" },
    { kind: "analysis", action: "verdict", status: "on-track", target: "a" },
  ]);
  const metrics = deriveMonitorMetrics(state);
  assert.equal(metrics.interventions, 4);
  assert.equal(metrics.recovered, 2);
  assert.equal(metrics.repeated, 0);
  assert.equal(metrics.escalated, 1);
  assert.equal(metrics.failed, 1);
  assert.equal(metrics.deadLetters, 1);
  assert.equal(metrics.analysisVerdicts, 3);
  assert.equal(metrics.driftVerdicts, 1);
  assert.equal(metrics.resolutionRate, 1, "all interventions resolved");
  assert.equal(metrics.recoveryRate, 2 / 4, "2 of 4 terminal outcomes recovered");
  assert.equal(metrics.escalationRate, 1 / 4);
  assert.equal(metrics.driftRate, 1 / 3);
});

test("deriveMonitorMetrics is empty-safe", () => {
  const metrics = deriveMonitorMetrics({
    records: 0,
    bindings: [],
    interventions: [],
    outcomes: [],
    deadLetters: [],
    analyses: [],
  });
  assert.equal(metrics.interventions, 0);
  assert.equal(metrics.resolutionRate, 0);
  assert.equal(metrics.recoveryRate, 0);
  assert.equal(metrics.escalationRate, 0);
  assert.equal(metrics.driftRate, 0);
});

test("formatMonitorMetrics renders a compact report", () => {
  const metrics = deriveMonitorMetrics(deriveMonitorLedgerState([
    { kind: "intervention", action: "steer", status: "sent", target: "a", traceId: "t1" },
    { kind: "outcome", action: "resolve", status: "recovered", target: "a", traceId: "t1" },
    { kind: "analysis", action: "verdict", status: "drift", target: "a" },
  ]));
  const lines = formatMonitorMetrics(metrics);
  assert.match(lines[0]!, /MONITOR metrics · 3 ledger records/);
  assert.match(lines.join("\n"), /1 recovered/);
  assert.match(lines.join("\n"), /drift rate 100%/);
  assert.match(lines.join("\n"), /recovery rate 100%/);
});

// ---------------------------------------------------------------------------
// Context-pressure-aware intervention (P2)
// ---------------------------------------------------------------------------

test("heuristicCheck downgrades stalled window intervention to compact request", () => {
  const info: EngineAgentInfo = {
    correlationId: "owner:x",
    name: "busy-window",
    status: "running",
    idleSeconds: 120,
    outputTail: [],
    objective: "window 2 agents",
    hasPendingInteractions: false,
    contextPressure: 92,
    kind: "window",
  };
  const result = heuristicCheck(info, 80);
  assert.equal(result.needsIntervention, true);
  assert.equal(result.reason, "stalled");
  assert.match(result.message!, /compact before continuing/);
  assert.match(result.message!, /92%/);
});

test("heuristicCheck keeps normal stalled message under pressure threshold", () => {
  const info: EngineAgentInfo = {
    correlationId: "owner:x",
    name: "calm-window",
    status: "running",
    idleSeconds: 120,
    outputTail: [],
    objective: "window 2 agents",
    hasPendingInteractions: false,
    contextPressure: 55,
    kind: "window",
  };
  const result = heuristicCheck(info, 80);
  assert.equal(result.needsIntervention, true);
  assert.doesNotMatch(result.message!, /compact/);

  // No pressure info → normal message.
  const without = heuristicCheck({ ...info, contextPressure: undefined });
  assert.doesNotMatch(without.message!, /compact/);
});

test("heuristicCheck compact downgrade respects per-binding threshold", () => {
  const info: EngineAgentInfo = {
    correlationId: "owner:x",
    name: "w",
    status: "running",
    idleSeconds: 120,
    outputTail: [],
    objective: "",
    hasPendingInteractions: false,
    contextPressure: 70,
    kind: "window",
  };
  const relaxed = heuristicCheck(info, 65);
  assert.match(relaxed.message!, /compact before continuing/);
  const strict = heuristicCheck(info, 75);
  assert.doesNotMatch(strict.message!, /compact/);
});

test("normalizeMonitorConfig exposes contextCompactThresholdPercent", () => {
  const config = normalizeMonitorConfig({ contextCompactThresholdPercent: 65 }, { env: {} });
  assert.equal(config.contextCompactThresholdPercent, 65);
  assert.equal(DEFAULT_MONITOR_CONFIG.contextCompactThresholdPercent, 80);
});

// ---------------------------------------------------------------------------
// Goal objection on escalation (closure evidence chain)
// ---------------------------------------------------------------------------

test("engineTick posts a goal objection when an escalated binding is goal-linked", async () => {
  const engine = createEngineState();
  engine.config.escalationThreshold = 2;
  engine.config.pendingOutcomeEvalMs = 1;
  engine.config.retryBackoffMs = 1;
  engine.config.interventionCooldownMs = 1;
  const notified: string[] = [];
  const objections: Array<{ goalId: string; summary: string }> = [];
  addBinding(engine, "cid-goal", "worker-window", "auto", undefined, { goalId: "goal-9" });
  engine.callbacks = {
    getAgentInfo: () => engineInfo("worker-window", "running", 120),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
    postGoalObjection: (goalId, summary) => { objections.push({ goalId, summary }); },
  };

  assert.equal(await engineTick(engine), 1);
  const binding = engine.bindings.get("cid-goal")!;
  binding.pendingIntervention!.at = Date.now() - 1_000;
  await engineTick(engine); // repeated (streak 1)
  binding.pendingIntervention!.at = Date.now() - 1_000;
  await engineTick(engine); // repeated (streak 2) → escalated + objection

  assert.equal(notified.length, 1);
  assert.equal(objections.length, 1);
  assert.equal(objections[0]!.goalId, "goal-9");
  assert.match(objections[0]!.summary, /stalled after 2 intervention/);
});

test("engineTick skips goal objection when binding has no goal", async () => {
  const engine = createEngineState();
  engine.config.escalationThreshold = 1;
  engine.config.pendingOutcomeEvalMs = 1;
  engine.config.retryBackoffMs = 1;
  engine.config.interventionCooldownMs = 1;
  const objections: Array<{ goalId: string }> = [];
  addBinding(engine, "cid-nogoal", "plain-window", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("plain-window", "running", 120),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: () => {},
    postGoalObjection: (goalId) => { objections.push({ goalId }); },
  };

  await engineTick(engine);
  const binding = engine.bindings.get("cid-nogoal")!;
  binding.pendingIntervention!.at = Date.now() - 1_000;
  await engineTick(engine);
  assert.equal(objections.length, 0);
});

// ---------------------------------------------------------------------------
// Deep boundary tests (review round)
// ---------------------------------------------------------------------------

test("escalation cooldown suppresses repeated escalation for 5 minutes", async () => {
  const engine = createEngineState();
  engine.config.escalationThreshold = 1; // escalate on first repeat
  engine.config.pendingOutcomeEvalMs = 1;
  engine.config.retryBackoffMs = 1;
  engine.config.interventionCooldownMs = 1;
  const notified: string[] = [];
  addBinding(engine, "cid-esc2", "w", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("w", "running", 120),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
  };

  // Escalation 1: streak 1 ≥ threshold 1 → escalated, lastEscalatedAt set.
  await engineTick(engine);
  const binding = engine.bindings.get("cid-esc2")!;
  binding.pendingIntervention!.at = Date.now() - 1_000;
  await engineTick(engine);
  assert.equal(notified.length, 1);
  assert.ok(binding.lastEscalatedAt > 0);

  // A new intervention cycle starts (cooldown elapsed) and repeats again —
  // but escalation is suppressed while within ESCALATION_COOLDOWN_MS.
  binding.lastInterventionAt = 0;
  binding.deliveryGate.reset();
  await engineTick(engine); // new intervention (streak stays 1, pending cleared by escalation)
  assert.equal(notified.length, 1, "no escalation yet");
  binding.pendingIntervention!.at = Date.now() - 1_000;
  binding.lastInterventionAt = 0;
  binding.deliveryGate.reset();
  await engineTick(engine); // repeated → streak 2 → threshold hit, but cooldown active
  assert.equal(notified.length, 1, "escalation suppressed by cooldown");
  assert.ok(binding.pendingIntervention, "repeated keeps pending (still under observation)");

  // After the escalation cooldown elapses, the next repeat escalates again.
  binding.lastEscalatedAt = Date.now() - 6 * 60_000;
  binding.lastInterventionAt = 0;
  binding.deliveryGate.reset();
  await engineTick(engine);
  binding.pendingIntervention!.at = Date.now() - 1_000;
  binding.lastInterventionAt = 0;
  binding.deliveryGate.reset();
  await engineTick(engine);
  assert.equal(notified.length, 2, "escalation resumes after cooldown");
});

test("drift score history is bounded to ANALYSIS_HISTORY_MAX", async () => {
  const engine = createEngineState();
  addBinding(engine, "cid-hist", "h", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("h", "running", 0),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: () => {},
    analyze: async () => ({ status: "drift", action: "none" }),
  };
  for (let i = 0; i < 30; i++) await engineTick(engine);
  const binding = engine.bindings.get("cid-hist")!;
  assert.ok(binding.analysisHistory.length <= 20, `history bounded, got ${binding.analysisHistory.length}`);
});

test("engineTick guards against overlapping ticks", async () => {
  const engine = createEngineState();
  addBinding(engine, "cid-slow2", "slow", "auto");
  let releaseAnalysis!: () => void;
  const analysisGate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  engine.callbacks = {
    getAgentInfo: () => engineInfo("slow", "running", 0),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: () => {},
    analyze: async () => { await analysisGate; return { status: "on-track", action: "none" }; },
  };

  const first = engineTick(engine);
  // Second tick while the first is still awaiting analysis → skipped.
  const second = engineTick(engine);
  releaseAnalysis();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 0);
  assert.equal(b, 0, "overlapping tick must be a no-op");
  assert.equal(engine.ticking, false, "ticking flag released after completion");
});

test("formatEngineStatusBar shows elevated indicator", () => {
  const engine = createEngineState();
  engine.startedAt = Date.now() - 30_000;
  addBinding(engine, "cid-1", "a", "auto");
  engine.bindings.get("cid-1")!.elevated = true;
  const bar = formatEngineStatusBar(engine);
  assert.match(bar, /MON 1/);
  assert.match(bar, /elevated/);
});

test("ledger lock recovers from a stale lock directory", async () => {
  const root = await tempRoot();
  try {
    // Simulate a crashed writer: stale lock dir with old mtime.
    const lockDir = join(root, ".pi", "monitor-ledger.jsonl.lock");
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await writeFile(join(lockDir, "owner"), `9999\n${old.toISOString()}\n`, "utf8");
    const now = Date.now();
    await Promise.all([utimes(lockDir, old, old), utimes(join(lockDir, "owner"), old, old)]);

    const appended = await appendMonitorLedgerRecord(root, { kind: "binding", action: "enter", status: "active", target: "cid-stale-lock" });
    assert.ok(appended.id);
    const loaded = await loadMonitorLedger(root);
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0]!.target, "cid-stale-lock");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger append is tolerant of record garbage via normalization", async () => {
  const root = await tempRoot();
  try {
    const appended = await appendMonitorLedgerRecord(root, {
      kind: "binding",
      action: "enter",
      status: "active",
      target: "cid-x",
      message: "m".repeat(2_000), // over cap → truncated
      metadata: {},
    } as unknown as MonitorLedgerRecord);
    assert.ok((appended.message ?? "").length <= 801, "message truncated to cap");
    // Empty metadata survives as an empty object (matches pi-peer stripEmpty
    // semantics — only undefined/""/[] are stripped at the top level).
    assert.deepEqual(appended.metadata ?? {}, {});

    // Corrupt kind is rejected by the module, not silently written.
    await assert.rejects(
      appendMonitorLedgerRecord(root, { kind: "bogus", action: "x" } as unknown as MonitorLedgerRecord),
      /valid kind/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

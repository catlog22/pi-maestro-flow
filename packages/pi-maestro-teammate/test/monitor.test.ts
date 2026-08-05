import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierWait,
  createMonitorModeState,
  formatBarrierCompact,
  formatCompact,
  formatHeader,
  formatStatusBar,
  formatVerbose,
  startMonitorMode,
  stopMonitorMode,
  validateMonitorParams,
  // Engine
  createEngineState,
  addBinding,
  removeBinding,
  clearBindings,
  heuristicCheck,
  canIntervene,
  recordIntervention,
  engineTick,
  stopEngine,
  formatEngineStatusBar,
  buildAutoAnalysisPrompt,
  buildCustomAnalysisPrompt,
  parseAnalysisResult,
  INTERVENTION_COOLDOWN_MS,
  MONITOR_MAX_TARGETS,
  MONITOR_STATUS_REFRESH_MS,
  type BarrierEntry,
  type MonitorTargetSnapshot,
  type MonitorParams,
  type EngineAgentInfo,
  type MonitorBinding,
  type EngineCallbacks,
} from "../src/extension/monitor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function snap(name: string, agentStatus: string, idle = 5): MonitorTargetSnapshot {
  return { name, found: true, agentStatus, idleSeconds: idle, summary: `${name} doing work` };
}

function notFound(name: string): MonitorTargetSnapshot {
  return { name, found: false, error: "not found", summary: "" };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateMonitorParams rejects empty targets", () => {
  const params: MonitorParams = { action: "status", targets: [] };
  assert.match(validateMonitorParams(params) ?? "", /At least one target/);
});

test("validateMonitorParams rejects too many targets", () => {
  const params: MonitorParams = {
    action: "status",
    targets: Array.from({ length: MONITOR_MAX_TARGETS + 1 }, (_, i) => `t${i}`),
  };
  assert.match(validateMonitorParams(params) ?? "", /Too many targets/);
});

test("validateMonitorParams rejects count mode without waitCount", () => {
  const params: MonitorParams = { action: "wait", targets: ["a"], waitMode: "count" };
  assert.match(validateMonitorParams(params) ?? "", /waitCount/);
});

test("validateMonitorParams accepts valid params", () => {
  assert.equal(validateMonitorParams({ action: "status", targets: ["a"] }), undefined);
  assert.equal(validateMonitorParams({ action: "wait", targets: ["a", "b"], waitMode: "all" }), undefined);
  assert.equal(validateMonitorParams({ action: "wait", targets: ["a"], waitMode: "count", waitCount: 1 }), undefined);
});

// ---------------------------------------------------------------------------
// Compact formatting
// ---------------------------------------------------------------------------

test("formatCompact produces one line per target", () => {
  const targets = [snap("dev-api", "running", 3), snap("dev-ui", "completed", 45)];
  const lines = formatCompact(targets);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /■ dev-api 3s/);
  assert.match(lines[1], /✓ dev-ui 45s/);
});

test("formatCompact handles not-found targets", () => {
  const lines = formatCompact([notFound("ghost")]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /✗ ghost not-found/);
});

test("formatVerbose includes detail lines", () => {
  const target: MonitorTargetSnapshot = {
    ...snap("w", "running"),
    detail: ["line 1", "line 2"],
  };
  const lines = formatVerbose([target]);
  assert.ok(lines.length >= 3); // header + 2 detail lines
  assert.match(lines[1], /  line 1/);
});

test("formatHeader shows counts", () => {
  const targets = [snap("a", "running"), snap("b", "completed"), snap("c", "failed")];
  const header = formatHeader(targets);
  assert.match(header, /3 targets/);
  assert.match(header, /1 active/);
  assert.match(header, /1 done/);
  assert.match(header, /1 failed/);
});

// ---------------------------------------------------------------------------
// Status bar formatting
// ---------------------------------------------------------------------------

test("formatStatusBar shows active/total and elapsed", () => {
  const targets = [snap("a", "running"), snap("b", "completed")];
  const startedAt = Date.now() - 30_000;
  const bar = formatStatusBar(targets, startedAt);
  assert.match(bar, /MON 1\/2/);
  assert.match(bar, /30s/);
});

// ---------------------------------------------------------------------------
// Barrier wait
// ---------------------------------------------------------------------------

test("barrierWait: all mode waits for every target", async () => {
  const ac = new AbortController();
  const entries: BarrierEntry[] = [
    { name: "a", promise: Promise.resolve({ status: "completed", output: ["done a"] }) },
    { name: "b", promise: Promise.resolve({ status: "completed", output: ["done b"] }) },
  ];
  const { settled, exitReason } = await barrierWait(entries, "all", 1, ac);
  assert.equal(settled.length, 2);
  assert.match(exitReason, /all 2\/2/);
});

test("barrierWait: any mode resolves on first settlement", async () => {
  const ac = new AbortController();
  let resolveB!: (v: { status: string; output: string[] }) => void;
  const entries: BarrierEntry[] = [
    { name: "a", promise: Promise.resolve({ status: "completed", output: ["fast"] }) },
    { name: "b", promise: new Promise((r) => { resolveB = r; }) },
  ];
  const { settled, exitReason } = await barrierWait(entries, "any", 1, ac);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].name, "a");
  assert.match(exitReason, /first of 2/);
  // Clean up the dangling promise
  resolveB({ status: "aborted", output: [] });
});

test("barrierWait: count mode resolves at k settlements", async () => {
  const ac = new AbortController();
  const entries: BarrierEntry[] = [
    { name: "a", promise: Promise.resolve({ status: "completed", output: [] }) },
    { name: "b", promise: Promise.resolve({ status: "completed", output: [] }) },
    { name: "c", promise: new Promise(() => {}) }, // never resolves
  ];
  const { settled, exitReason } = await barrierWait(entries, "count", 2, ac);
  assert.equal(settled.length, 2);
  assert.match(exitReason, /2\/3 settled/);
});

test("barrierWait: handles rejected promises", async () => {
  const ac = new AbortController();
  const entries: BarrierEntry[] = [
    { name: "a", promise: Promise.reject(new Error("boom")) },
  ];
  const { settled } = await barrierWait(entries, "all", 1, ac);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, "error");
});

test("barrierWait: empty entries resolves immediately", async () => {
  const ac = new AbortController();
  const { settled, exitReason } = await barrierWait([], "all", 1, ac);
  assert.equal(settled.length, 0);
  assert.match(exitReason, /no targets/);
});

test("formatBarrierCompact produces compact output", () => {
  const settled = [
    { name: "a", status: "completed", output: ["API done"] },
    { name: "b", status: "failed", output: ["crashed"] },
  ];
  const lines = formatBarrierCompact(settled, "all 2/2 settled", 5000);
  assert.match(lines[0], /BARRIER all 2\/2 settled · 5s/);
  assert.match(lines[1], /✓ a completed/);
  assert.match(lines[2], /✗ b failed/);
});

// ---------------------------------------------------------------------------
// Monitor mode state
// ---------------------------------------------------------------------------

test("createMonitorModeState starts inactive", () => {
  const ms = createMonitorModeState();
  assert.equal(ms.active, false);
  assert.equal(ms.targets.length, 0);
  assert.equal(ms.timer, undefined);
});

test("startMonitorMode activates and stopMonitorMode deactivates", () => {
  const ms = createMonitorModeState();
  const captured: MonitorTargetSnapshot[][] = [];

  startMonitorMode(
    ms,
    ["a", "b"],
    false,
    () => [snap("a", "running"), snap("b", "running")],
    (snapshot) => { captured.push(snapshot); },
  );

  assert.equal(ms.active, true);
  assert.deepEqual(ms.targets, ["a", "b"]);
  assert.ok(ms.timer !== undefined);
  assert.equal(captured.length, 1); // initial capture

  stopMonitorMode(ms);
  assert.equal(ms.active, false);
  assert.equal(ms.timer, undefined);
});

test("startMonitorMode skips unchanged periodic snapshots", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const ms = createMonitorModeState();
  const initial = [snap("a", "running")];
  let nextSnapshot = initial;
  const refreshed: MonitorTargetSnapshot[][] = [];

  startMonitorMode(
    ms,
    ["a"],
    false,
    () => nextSnapshot,
    (snapshot) => { refreshed.push(snapshot); },
  );

  t.mock.timers.tick(MONITOR_STATUS_REFRESH_MS);
  assert.equal(refreshed.length, 1, "the same array reference must not refresh");
  assert.equal(ms.lastSnapshot, initial);

  nextSnapshot = [snap("a", "running")];
  t.mock.timers.tick(MONITOR_STATUS_REFRESH_MS);
  assert.equal(refreshed.length, 1, "equal shallow content must not refresh");
  assert.equal(ms.lastSnapshot, initial);

  nextSnapshot = [snap("a", "running", 6)];
  t.mock.timers.tick(MONITOR_STATUS_REFRESH_MS);
  assert.equal(refreshed.length, 2, "changed content must refresh");
  assert.equal(ms.lastSnapshot, nextSnapshot);

  stopMonitorMode(ms);
});

test("startMonitorMode replaces previous monitor", () => {
  const ms = createMonitorModeState();
  const noop = () => {};

  startMonitorMode(ms, ["a"], false, () => [snap("a", "running")], noop);
  const firstTimer = ms.timer;

  startMonitorMode(ms, ["b"], false, () => [snap("b", "running")], noop);
  assert.notEqual(ms.timer, firstTimer);
  assert.deepEqual(ms.targets, ["b"]);

  stopMonitorMode(ms);
});

// ===========================================================================
// Engine: binding management
// ===========================================================================

function engineInfo(name: string, status: string, idle = 5): EngineAgentInfo {
  return {
    correlationId: `cid-${name}`,
    name,
    status,
    idleSeconds: idle,
    outputTail: ["working on stuff"],
    objective: "Build the API",
    hasPendingInteractions: false,
  };
}

test("addBinding creates a 1:1 binding", () => {
  const engine = createEngineState();
  const r1 = addBinding(engine, "cid-1", "dev-api", "auto");
  assert.equal(r1.ok, true);
  assert.equal(engine.bindings.size, 1);

  // Duplicate rejected
  const r2 = addBinding(engine, "cid-1", "dev-api", "auto");
  assert.equal(r2.ok, false);
  assert.match(r2.error ?? "", /already has a monitor/);
});

test("removeBinding and clearBindings work", () => {
  const engine = createEngineState();
  addBinding(engine, "cid-1", "a", "auto");
  addBinding(engine, "cid-2", "b", "custom", "check coverage");
  assert.equal(engine.bindings.size, 2);

  assert.equal(removeBinding(engine, "cid-1"), true);
  assert.equal(engine.bindings.size, 1);

  clearBindings(engine);
  assert.equal(engine.bindings.size, 0);
});

test("binding stores custom prompt", () => {
  const engine = createEngineState();
  addBinding(engine, "cid-1", "a", "custom", "Ensure tests pass");
  const binding = engine.bindings.get("cid-1");
  assert.equal(binding?.mode, "custom");
  assert.equal(binding?.customPrompt, "Ensure tests pass");
});

// ===========================================================================
// Engine: heuristic checks
// ===========================================================================

test("heuristicCheck detects stalled agent", () => {
  const result = heuristicCheck(engineInfo("a", "running", 120));
  assert.equal(result.needsIntervention, true);
  assert.equal(result.reason, "stalled");
});

test("heuristicCheck detects failed agent (notify only)", () => {
  const result = heuristicCheck(engineInfo("a", "failed"));
  assert.equal(result.needsIntervention, false);
  assert.equal(result.notifyOnly, true);
  assert.equal(result.reason, "failed");
});

test("heuristicCheck detects interaction needed (notify only)", () => {
  const info = { ...engineInfo("a", "running"), hasPendingInteractions: true };
  const result = heuristicCheck(info);
  assert.equal(result.notifyOnly, true);
  assert.equal(result.reason, "interaction-needed");
});

test("heuristicCheck passes healthy agent", () => {
  const result = heuristicCheck(engineInfo("a", "running", 5));
  assert.equal(result.needsIntervention, false);
  assert.equal(result.notifyOnly, undefined);
});

// ===========================================================================
// Engine: intervention cooldown
// ===========================================================================

test("canIntervene respects cooldown", () => {
  const engine = createEngineState();
  addBinding(engine, "cid-1", "a", "auto");
  const binding = engine.bindings.get("cid-1")!;

  // Fresh binding — can intervene
  assert.equal(canIntervene(binding, Date.now()), true);

  // Record intervention
  recordIntervention(binding, "stalled", "continue", "steer");
  assert.equal(binding.interventions.length, 1);

  // Immediately after — cannot intervene
  assert.equal(canIntervene(binding, Date.now()), false);

  // After cooldown — can intervene
  assert.equal(canIntervene(binding, Date.now() + INTERVENTION_COOLDOWN_MS + 1), true);
});

test("intervention log is trimmed", () => {
  const engine = createEngineState();
  addBinding(engine, "cid-1", "a", "auto");
  const binding = engine.bindings.get("cid-1")!;

  for (let i = 0; i < 25; i++) {
    recordIntervention(binding, "stalled", `msg ${i}`, "steer");
  }
  assert.ok(binding.interventions.length <= 20);
});

// ===========================================================================
// Engine: tick
// ===========================================================================

test("engineTick removes gone agents and intervenes on stalled", async () => {
  const engine = createEngineState();
  const sent: Array<{ cid: string; msg: string }> = [];
  const notified: string[] = [];

  addBinding(engine, "cid-gone", "ghost", "auto");
  addBinding(engine, "cid-stalled", "slow", "auto");

  engine.callbacks = {
    getAgentInfo: (cid) => {
      if (cid === "cid-stalled") return engineInfo("slow", "running", 120);
      return undefined; // gone
    },
    sendIntervention: (cid, msg) => { sent.push({ cid, msg }); return true; },
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
  };

  const count = await engineTick(engine);

  // Gone agent removed
  assert.equal(engine.bindings.has("cid-gone"), false);
  // Stalled agent got intervention
  assert.equal(count, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].msg, /stalled/);
});

test("engineTick awaits asynchronous intervention acknowledgement", async () => {
  const engine = createEngineState();
  let acknowledged = false;
  addBinding(engine, "remote-owner:cid", "remote", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("remote", "running", 120),
    sendIntervention: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      acknowledged = true;
      return true;
    },
    onStatusUpdate: () => {},
    notifyMain: () => {},
  };

  const count = await engineTick(engine);
  assert.equal(acknowledged, true);
  assert.equal(count, 1);
  assert.equal(engine.bindings.get("remote-owner:cid")?.interventions.length, 1);
});

test("engineTick drops an analysis result after its binding is replaced", async () => {
  const engine = createEngineState();
  const sent: string[] = [];
  let signalAnalysisStarted!: () => void;
  const analysisStarted = new Promise<void>((resolve) => { signalAnalysisStarted = resolve; });
  let resolveAnalysis!: (result: { status: "drift"; action: "send"; message: string }) => void;
  const analysis = new Promise<{ status: "drift"; action: "send"; message: string }>(
    (resolve) => { resolveAnalysis = resolve; },
  );
  addBinding(engine, "cid-reused", "original", "auto");
  const original = engine.bindings.get("cid-reused")!;
  engine.callbacks = {
    getAgentInfo: () => engineInfo("original", "running", 0),
    sendIntervention: (_cid, message) => { sent.push(message); return true; },
    onStatusUpdate: () => {},
    notifyMain: () => {},
    analyze: async () => {
      signalAnalysisStarted();
      return analysis;
    },
  };

  const tick = engineTick(engine);
  await analysisStarted;
  removeBinding(engine, "cid-reused");
  addBinding(engine, "cid-reused", "replacement", "auto");
  resolveAnalysis({ status: "drift", action: "send", message: "stale steer" });

  assert.equal(await tick, 0);
  assert.deepEqual(sent, []);
  assert.equal(original.driftDetected, false);
  assert.equal(engine.bindings.get("cid-reused")?.driftDetected, false);
});

test("engineTick drops an analysis result after the engine stops", async () => {
  const engine = createEngineState();
  const sent: string[] = [];
  let signalAnalysisStarted!: () => void;
  const analysisStarted = new Promise<void>((resolve) => { signalAnalysisStarted = resolve; });
  let resolveAnalysis!: (result: { status: "drift"; action: "send"; message: string }) => void;
  const analysis = new Promise<{ status: "drift"; action: "send"; message: string }>(
    (resolve) => { resolveAnalysis = resolve; },
  );
  addBinding(engine, "cid-stop", "stopping", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("stopping", "running", 0),
    sendIntervention: (_cid, message) => { sent.push(message); return true; },
    onStatusUpdate: () => {},
    notifyMain: () => {},
    analyze: async () => {
      signalAnalysisStarted();
      return analysis;
    },
  };

  const tick = engineTick(engine);
  await analysisStarted;
  stopEngine(engine);
  resolveAnalysis({ status: "drift", action: "send", message: "stale after stop" });

  assert.equal(await tick, 0);
  assert.deepEqual(sent, []);
});

test("engineTick notifies main for failed agents", async () => {
  const engine = createEngineState();
  const notified: string[] = [];

  addBinding(engine, "cid-fail", "broken", "auto");
  engine.callbacks = {
    getAgentInfo: () => engineInfo("broken", "failed"),
    sendIntervention: () => true,
    onStatusUpdate: () => {},
    notifyMain: (msg) => { notified.push(msg); },
  };

  await engineTick(engine);
  assert.equal(notified.length, 1);
  assert.match(notified[0], /failed/);
});

// ===========================================================================
// Engine: status bar
// ===========================================================================

test("formatEngineStatusBar shows bindings and fixes", () => {
  const engine = createEngineState();
  engine.startedAt = Date.now() - 30_000;
  addBinding(engine, "cid-1", "a", "auto");
  const binding = engine.bindings.get("cid-1")!;
  recordIntervention(binding, "drift", "fix it", "steer");

  const bar = formatEngineStatusBar(engine);
  assert.match(bar, /MON 1/);
  assert.match(bar, /30s/);
  assert.match(bar, /1 fix/);
});

test("formatEngineStatusBar shows drift indicator", () => {
  const engine = createEngineState();
  engine.startedAt = Date.now();
  addBinding(engine, "cid-1", "a", "auto");
  engine.bindings.get("cid-1")!.driftDetected = true;

  const bar = formatEngineStatusBar(engine);
  assert.match(bar, /drift/);
});

// ===========================================================================
// Analysis prompts and parsing
// ===========================================================================

test("buildAutoAnalysisPrompt includes objective and output", () => {
  const prompt = buildAutoAnalysisPrompt("Build API", ["line 1", "line 2"]);
  assert.match(prompt, /Build API/);
  assert.match(prompt, /line 1/);
  assert.match(prompt, /JSON/);
});

test("buildCustomAnalysisPrompt includes custom requirements", () => {
  const prompt = buildCustomAnalysisPrompt("Check coverage > 80%", "Build API", ["output"]);
  assert.match(prompt, /Check coverage/);
  assert.match(prompt, /Build API/);
  assert.match(prompt, /JSON/);
});

test("parseAnalysisResult handles valid JSON", () => {
  const result = parseAnalysisResult('{"status": "drift", "reason": "off track", "action": "send", "message": "fix it"}');
  assert.equal(result?.status, "drift");
  assert.equal(result?.action, "send");
  assert.equal(result?.message, "fix it");
});

test("parseAnalysisResult handles JSON in markdown", () => {
  const result = parseAnalysisResult('```json\n{"status": "on-track", "action": "none"}\n```');
  assert.equal(result?.status, "on-track");
  assert.equal(result?.action, "none");
});

test("parseAnalysisResult returns undefined for garbage", () => {
  assert.equal(parseAnalysisResult("not json at all"), undefined);
  assert.equal(parseAnalysisResult(""), undefined);
  assert.equal(parseAnalysisResult("{broken"), undefined);
});

test("parseAnalysisResult defaults unknown status to on-track", () => {
  const result = parseAnalysisResult('{"status": "unknown"}');
  assert.equal(result?.status, "on-track");
});

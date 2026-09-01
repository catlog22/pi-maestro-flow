import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  barrierWait,
  activePromptLoopIdsFromPayload,
  applyMonitorModeContext,
  appendMonitorModeContext,
  createMonitorModeState,
  formatBarrierCompact,
  formatCompact,
  formatHeader,
  formatStatusBar,
  formatVerbose,
  startMonitorMode,
  stopMonitorMode,
  stripMonitorModeContext,
  validateMonitorParams,
  MONITOR_MAX_TARGETS,
  MONITOR_STATUS_REFRESH_MS,
  type BarrierEntry,
  type MonitorTargetSnapshot,
  type MonitorParams,
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

test("root Monitor command entry points exclude the legacy evaluator runtime", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /MONITOR_SESSION|PI_TEAMMATE_MONITOR|monitorSessionAgent|MonitorSessionEvaluator/);
  assert.doesNotMatch(source, /MonitorController|monitorController|monitorEngine|monitorLedger/);
  assert.equal(source.match(/pi\.registerCommand\("monitor"/g)?.length, 1);
  assert.equal(source.match(/pi\.registerCommand\("teammate-send"/g)?.length, 1);
  assert.match(source, /kind: "workspace",[\s\S]*?capabilities: \{ inspect: true, wait: true, cancel: false, message: true, supervise: true \}/);
  assert.match(source, /pi\.events\.on\("bash-bg:update", applyBashBgSnapshot\)/);
  assert.match(source, /workspaceMainSessionDeliveryDecision\(\s*command\.action,\s*workspaceBackgroundJobs/);
  assert.match(source, /deliverAs: delivery\.deliverAs/);
  assert.match(source, /steer deferred as follow_up while foreground bash_bg is active/);
  assert.match(source, /if \(trimmed === ""\)[\s\S]*?requestWindowMode\("enter"\)/);
  assert.match(source, /applyMonitorModeContext\(withDepth, monitorInteractionModeActive\)/);
  assert.doesNotMatch(source, /guardMonitorModeToolCall/);
  assert.match(source, /options\.view === "turns"\) return teammateTurnsSnapshot\(id, options\);/);
  assert.match(source, /options\.view === "turns"\) return workspaceTurnsSnapshot\(owner, target, detail, lines, options\);/);
  assert.match(source, /\.\.\.\(options\.view \? \{ view: options\.view \} : \{\}\)/);
  assert.match(source, /async requestWindowMode\(action\)[\s\S]*?enterMonitorInteractionMode\(\)[\s\S]*?setViewMode\("windows"\)/);
  assert.doesNotMatch(source, /autoResume|setMonitored|monitoredEndpointIds/);
  assert.match(source, /workspaceProtocolCommandId\(request\.messageId\)/);
  assert.match(source, /publishWorkspaceWindowTerminalResult[\s\S]*?current\.ownerNonce === endpoint\.ownerNonce/);
  assert.doesNotMatch(source, /publishWorkspaceWindowTerminalResult[\s\S]*?current\?\.contentRevision === endpoint\.contentRevision/);
  assert.match(source, /pi\.on\("session_start"[\s\S]*?exitMonitorInteractionMode\(\)/);
  assert.match(source, /pi\.on\("session_shutdown"[\s\S]*?exitMonitorInteractionMode\(\)/);
  assert.doesNotMatch(source, /monitorControllerInstance\.shutdown/);
  assert.match(source, /const target: ObservationTarget = \{\s*kind: "workspace",\s*id,\s*\.\.\.\(options\.cursor \? \{ cursor: options\.cursor \} : \{\}\),\s*\};/);
  assert.match(source, /workspaceObservationSnapshot[\s\S]*?await refreshWorkspacePeerOwners\(\);[\s\S]*?if \(!ownsRootSessionFence\(fence\)\)[\s\S]*?error: "stale-root-session"/);
  assert.match(source, /waitForWorkspaceObservation[\s\S]*?options\.until !== "completed"[\s\S]*?last\.nativeStatus === "result-ready"/);
  assert.match(source, /event\.source !== "interactive"[\s\S]*?event\.text\.trim\(\) !== "monitor"/);
  assert.match(source, /if \(trimmed === "exit" \|\| trimmed === "stop"\)/);
  assert.doesNotMatch(source, /trimmed === "resume"|trimmed === "metrics"|custom:<prompt>/);
  assert.match(source, /if \(trimmed === "status"\)/);
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
// Monitor control context
// ---------------------------------------------------------------------------

test("monitor mode context is persistent, structured, idempotent, and supervision-only", () => {
  const injected = appendMonitorModeContext("base prompt");
  assert.match(injected, /<monitor_mode>/);

  const sections = [
    "## Role and authority",
    "## Complete-project orchestration",
    "## Tool routing",
    "## Recurring supervision",
    "## Message timing and exit",
  ];
  let previous = -1;
  for (const section of sections) {
    const index = injected.indexOf(section);
    assert.ok(index > previous, `${section} must appear once in the expected order`);
    assert.equal(injected.lastIndexOf(section), index, `${section} must be unique`);
    previous = index;
  }

  assert.match(injected, /delegates all project implementation, file edits, shell commands/);
  assert.match(injected, /one read-only planning or technical-lead worker/);
  assert.match(injected, /execute a phase DAG/);
  assert.match(injected, /settled windows alone do not prove project success/);
  assert.match(injected, /Release or deployment is not implied by implementation/);

  assert.match(injected, /workspace-window only for local Pi workers/);
  assert.match(injected, /provider=herdr requires an already-running local Herdr session/);
  assert.match(injected, /remote:<runId>/);
  assert.match(injected, /monitor list\/get\/wait for normalized attention-first state/);
  assert.match(injected, /observe only for raw provider snapshots, turns\/todos\/diagnose views, or multi-target all\/any\/count barriers/);
  assert.match(injected, /teammate-list view=inbox reads persisted messages/);
  assert.match(injected, /flow-schedule create then start/);
  assert.match(injected, /exact correlated Flow report remains completion authority/);

  assert.match(injected, /deferred condition followed by an action/);
  assert.match(injected, /one bounded prompt loop for the complete phase, never one loop per target and never a shell loop/);
  assert.match(injected, /revalidate the exact owner after every await before intervening/);
  assert.match(injected, /cancel the current loop, and only then delegate an explicitly authorized non-idempotent action exactly once/);
  assert.match(injected, /queued until the next turn boundary/);
  assert.match(injected, /\/monitor exit does not stop them/);

  assert.equal(appendMonitorModeContext(injected), injected);
});

test("monitor mode context can be removed without disturbing surrounding prompt content", () => {
  const injected = appendMonitorModeContext("before\n\nafter");
  assert.equal(stripMonitorModeContext(injected), "before\n\nafter");
  assert.equal(applyMonitorModeContext(injected, false), "before\n\nafter");
  assert.equal(applyMonitorModeContext("base", true), appendMonitorModeContext("base"));
  assert.equal(stripMonitorModeContext("base"), "base");
});

test("activePromptLoopIdsFromPayload keeps only active prompt loops", () => {
  assert.equal(activePromptLoopIdsFromPayload(undefined), undefined);
  assert.deepEqual(activePromptLoopIdsFromPayload({ jobs: [
    { id: "loop-monitor", kind: "prompt", status: "scheduled" },
    { id: "loop-running", kind: "prompt", status: "running" },
    { id: "loop-complete", kind: "prompt", status: "completed" },
    { id: "loop-shell", kind: "shell", status: "scheduled" },
    { id: "", kind: "prompt", status: "running" },
    { id: "loop-monitor", kind: "prompt", status: "scheduled" },
  ] }), ["loop-monitor", "loop-running"]);
});

test("monitor communication uses tool-local capability gates without global interception", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const monitorSource = await readFile(new URL("../src/extension/monitor.ts", import.meta.url), "utf8");
  const lifecycleSource = await readFile(new URL("../src/extension/monitor-window-lifecycle.ts", import.meta.url), "utf8");
  const coreSource = await readFile(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf8");
  const proxySource = await readFile(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8");
  const peerSource = await readFile(new URL("../src/extension/workspace-peers.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /guardMonitorModeToolCall/);
  assert.doesNotMatch(source, /pi\.on\("tool_call", \(event\) => \{\n\s*if \(!monitorInteractionModeActive\)/);
  assert.match(source, /new MonitorToolExposureController\(pi/);
  assert.match(source, /local: \[sendTool, localListTool, localObserveTool\]/);
  assert.match(source, /monitor: \[sendTool, listTool, observeTool\]/);
  assert.match(source, /exclusiveNames: \["monitor", "workspace-window", "remote-worker"\]/);
  assert.match(source, /monitorInteractionModeActive = true[\s\S]*?monitorToolExposure\?\.enter\(\)/);
  assert.match(source, /monitorInteractionModeActive = false[\s\S]*?monitorToolExposure\?\.exit\(\)/);
  // Sending is not Monitor-gated; window discovery (teammate-list) is.
  assert.doesNotMatch(source, /before addressing another window/);
  assert.doesNotMatch(proxySource, /crossSessionError\("Cross-window teammate-send"\)/);
  assert.match(source, /Cross-window teammate-list views are available only after the user enters Monitor mode/);
  assert.match(source, /hasCrossWindowTarget[\s\S]*?ownsMonitorCommunication\(monitorCapture\)/);
  assert.doesNotMatch(source, /\/teammate-send is available only after entering Monitor mode/);
  assert.match(source, /pi\.registerCommand\("teammate-send"[\s\S]*?source: "user"/);
  assert.match(source, /correlationId: `owner:\$\{owner\.ownerId\}:\$\{agent\.correlationId\}`[\s\S]*?bindable: true/);
  assert.match(proxySource, /authorizeCrossSession\?\.\(\) === true/);
  assert.match(proxySource, /crossSessionError\("teammate-list"\)/);
  assert.doesNotMatch(peerSource, /Reply with teammate-send/);
  assert.match(coreSource, /LOCAL_TEAMMATE_LIST_DESCRIPTION/);
  assert.match(coreSource, /LOCAL_OBSERVE_DESCRIPTION/);
  assert.match(source, /name: "monitor"/);
  assert.match(source, /Use observe when you need raw provider snapshots, turns\/todos\/diagnose views, or an all\/any\/count barrier/);
  assert.match(source, /name: "workspace-window"/);
  assert.match(source, /const monitorCapture = captureMonitorCommunication\(\);[\s\S]*?workspace-window is available only after the user enters Monitor mode/);
  assert.match(source, /managedWindowSessionName\(request\.name\)/);
  assert.match(source, /createHandle: \(\) => workspaceWindowCompletionHandle\(randomUUID\(\)\.replace\(\/-\/g, ""\)\)/);
  assert.match(source, /messageId: handle\.requestMessageId,[\s\S]*?source: "monitor",[\s\S]*?messageKind: "request",[\s\S]*?terminalResultRequested: true/);
  // Durability-provider absence degrades to passive delivery instead of failing the send.
  assert.match(source, /class WorkspaceTerminalDurabilityUnavailableError extends Error/);
  assert.match(source, /!\(error instanceof WorkspaceTerminalDurabilityUnavailableError\)[\s\S]*?Terminal completion reservation failed/);
  assert.match(source, /without canonical completion tracking/);
  assert.match(source, /targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER/);
  assert.match(source, /accepted: delivery\.delivered && delivery\.receipt\?\.publicationStage === "accepted"/);
  assert.match(source, /Result: \$\{created\.handle\.resource\}/);
  assert.match(lifecycleSource, /Workspace window \$\{name\} was closed by its Monitor owner/);
  assert.match(source, /MANAGED_WINDOW_TERMINAL_DEADLINE_MS/);
  assert.match(source, /Workspace worker runtime died without publishing a canonical terminal envelope/);
  assert.match(source, /targetSessionId: fence\.sessionId/);
  assert.match(source, /buildManagedWindowPiArgs\(\{ sessionName, presentation, forkSessionFile \}\)/);
  assert.match(source, /stdio: presentation === "headless" \? \["pipe", "ignore", "ignore"\] : "ignore"/);
  assert.match(source, /type: "get_state"/);
  assert.match(source, /window\.terminationRequested = true;[\s\S]*?termination\.terminate\(\)/);
  assert.match(source, /window\.settled = true;[\s\S]*?publishWorkspaceTerminalCompletion\(request, terminal\)[\s\S]*?window\.terminalPublished = true;[\s\S]*?stopManagedWindow\(window\.name\)/);
  assert.match(source, /window\.completionHandle[\s\S]*?window\.terminalDeadlineAt !== undefined[\s\S]*?!window\.terminalPublished/);
  assert.match(source, /bindHandle: \(window, handle\) => \{ window\.completionHandle = handle; \},[\s\S]*?deliverObjective:[\s\S]*?routeSessionMessage\(\{/);
  assert.match(source, /owner\.sessionName === window\.sessionName/);
  assert.doesNotMatch(source, /terminal result request registered for the launched root task/);
  assert.match(lifecycleSource, /assertAdmission\(authority, window, admittedOwner, request\.name, "workspace registration"\)/);
  assert.match(source, /left\.ownerId === right\.ownerId[\s\S]*?left\.ownerNonce === right\.ownerNonce[\s\S]*?left\.pid === right\.pid/);
  assert.match(source, /const owners = await refreshWorkspacePeerOwnersStrict\(\)/);
  assert.match(source, /terminateManagedWindowProcess\([\s\S]*?window,[\s\S]*?authorization\.authorize/);
  assert.match(source, /const exited = window\.pid !== undefined && !managedWindowPidIsAlive\(window\.pid\)/);
  assert.match(source, /const status = await terminateManagedWindowProcess\([\s\S]*?window,[\s\S]*?authorization\.authorize,[\s\S]*?terminationStarted = true/);
  assert.match(source, /createHerdrWindow\(\{[\s\S]*?piArgs: buildManagedWindowPiArgs/);
  assert.match(source, /closeHerdrWindowExact\(window\.runtime\.capture/);
  assert.match(source, /if \(window\.runtime\.provider === "native" && window\.presentation === "interactive"\) \{[\s\S]*?refreshWorkspacePeerOwnersStrict\(\)/);
  assert.match(source, /hasNativeInteractiveWindows[\s\S]*?window\.runtime\.provider === "native"[\s\S]*?terminateManagedWindowProcess/);
  assert.match(source, /provider: request\.provider \?\? "native"/);
  assert.match(source, /provider=herdr creates an interactive Pi workspace in an already-running local Herdr session/);
  assert.doesNotMatch(source, /monitorController/);
  assert.match(source, /if \(managedWindows\.get\(name\) === window\) managedWindows\.delete\(name\)/);
  assert.match(source, /termination\.outcome/);
  assert.match(source, /return terminateProcessTreeByPid\(owner\.pid\)/);
  assert.match(source, /status = await terminateProcessTreeByPid\(owner\.pid\)/);
  assert.match(source, /pi\.registerTool\(workspaceWindowTool\)/);
  assert.match(source, /name: "remote-worker"/);
  assert.match(source, /pi\.registerTool\(remoteWorkerTool\)/);
  assert.match(source, /kind: "remote",[\s\S]*?capabilities: \{ inspect: true, wait: true, cancel: true, message: true, supervise: true \}/);
  assert.match(source, /params\.to\.startsWith\("remote:"\)/);
  assert.match(source, /use remote-worker close/);
  assert.match(source, /shutdownRemoteMonitorBinding\(\)/);
  assert.match(source, /agentRole: `remote worker[\s\S]*?kind: "remote"/);
  assert.match(source, /\/monitor status — render the same normalized projector as monitor list[\s\S]*?executeMonitorQuery\(\{ action: "list" \}/);
  assert.match(monitorSource, /workspace-window only for local Pi workers/);
  assert.match(monitorSource, /provider=herdr requires an already-running local Herdr session/);
  assert.match(monitorSource, /remote-worker targets/);
  assert.match(monitorSource, /Create already delivers the objective/);
  assert.match(monitorSource, /at most once per target per tick/);
  assert.match(monitorSource, /never resend it without later target-side injection/);
  assert.match(monitorSource, /never close discovered external peers/);
  assert.match(monitorSource, /queued until the next turn boundary/);
  assert.match(source, /message\(s\) arrived during this/);
  assert.match(source, /end the turn to receive it/);
  assert.match(source, /queued while a tool was running/);
  assert.match(coreSource, /teammate-list with view="inbox"/);
  assert.match(source, /The create call already delivers its objective to the worker/);
  assert.match(source, /do not resend that objective/);
  assert.match(source, /Terminal results remain retrievable after process exit through the handle's immutable agent:\/\/ resource/);
  assert.match(source, /Read a settled result with the resource tool using the returned agent:\/\/ URI/);
  assert.match(monitorSource, /appendMonitorModeContext/);
  assert.doesNotMatch(source, /MonitorRuntime|MonitorController/);
  assert.match(coreSource, /view="turns"/);
  assert.match(source, /pi\.events\.on\("loop:update", applyLoopSnapshot\)/);
  assert.match(source, /pi\.events\.emit\("loop:query", undefined\)/);
  assert.match(source, /notifyMonitorModeClosed/);
  assert.match(source, /extension\.monitorLoopsContinue/);
  assert.match(source, /const MONITOR_ESCAPE_TAP_WINDOW_MS = 500;/);
  assert.match(source, /matchesKey\(data, "escape"\) \|\| isKeyRelease\(data\) \|\| isKeyRepeat\(data\)/);
  assert.match(source, /monitorEscapeTapAt <= MONITOR_ESCAPE_TAP_WINDOW_MS[\s\S]*?requestWindowMode\("exit"\)[\s\S]*?consume: true/);
  assert.match(source, /pi\.on\("session_start"[\s\S]*?installMonitorEscapeTap\(ctx\.ui\)/);
  assert.match(source, /pi\.on\("session_shutdown"[\s\S]*?uninstallMonitorEscapeTap\(\)/);
  assert.match(source, /The first Esc is always passed through/);
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

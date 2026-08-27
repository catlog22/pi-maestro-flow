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

test("monitor mode context is persistent, idempotent, and supervision-only", () => {
  const injected = appendMonitorModeContext("base prompt");
  assert.match(injected, /<monitor_mode>/);
  assert.match(injected, /monitor control window/);
  assert.match(injected, /workspace-window only for local Pi worker windows/);
  assert.match(injected, /remote-worker targets/);
  assert.match(injected, /remote:<runId>/);
  assert.match(injected, /Never attempt to close discovered external peer windows/);
  assert.match(injected, /observe local peers as kind=workspace and remote runs as kind=remote/);
  assert.match(injected, /flow-schedule-todo-binding capability/);
  assert.match(injected, /observe with view=todos on workspace targets/);
  assert.match(injected, /display-only and never completion authority/);
  assert.match(injected, /no Todo instruction or binding is created/);
  assert.match(injected, /exact report remains the completion authority/);
  assert.match(injected, /Todo gate evidence waits up to 30 seconds/);
  assert.match(injected, /duplicate work is acceptable/);
  assert.match(injected, /view=inbox to read persisted cross-window and remote messages/);
  assert.match(injected, /objective is delivered by create/);
  assert.match(injected, /intervene only on new evidence of stall, drift, or failure/);
  assert.match(injected, /at most one intervention per target per tick/);
  assert.match(injected, /Do not send routine acknowledgements or status pings/);
  assert.match(injected, /Never repeat that message while it remains queued or accepted/);
  assert.match(injected, /queued and injected only at the next turn boundary/);
  assert.match(injected, /one bounded prompt loop for the complete target set/);
  assert.match(injected, /loop with action=list/);
  assert.match(injected, /not stopped by \/monitor exit/);
  assert.match(injected, /Do not implement project work/);
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
  const coreSource = await readFile(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf8");
  const proxySource = await readFile(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8");
  const peerSource = await readFile(new URL("../src/extension/workspace-peers.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /guardMonitorModeToolCall/);
  assert.doesNotMatch(source, /pi\.on\("tool_call", \(event\) => \{\n\s*if \(!monitorInteractionModeActive\)/);
  assert.match(source, /new MonitorToolExposureController\(pi/);
  assert.match(source, /local: \[sendTool, localListTool, localObserveTool\]/);
  assert.match(source, /monitor: \[sendTool, listTool, observeTool\]/);
  assert.match(source, /exclusiveNames: \["workspace-window", "remote-worker"\]/);
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
  assert.match(source, /name: "workspace-window"/);
  assert.match(source, /const monitorCapture = captureMonitorCommunication\(\);[\s\S]*?workspace-window is available only after the user enters Monitor mode/);
  assert.match(source, /const sessionName = managedWindowSessionName\(name\)/);
  assert.match(source, /const completionHandle = workspaceWindowCompletionHandle\(randomUUID\(\)\.replace\(\/-\/g, ""\)\)/);
  assert.match(source, /messageId: completionHandle\.requestMessageId,[\s\S]*?source: "monitor",[\s\S]*?messageKind: "request",[\s\S]*?terminalResultRequested: true/);
  // Durability-provider absence degrades to passive delivery instead of failing the send.
  assert.match(source, /class WorkspaceTerminalDurabilityUnavailableError extends Error/);
  assert.match(source, /!\(error instanceof WorkspaceTerminalDurabilityUnavailableError\)[\s\S]*?Terminal completion reservation failed/);
  assert.match(source, /without canonical completion tracking/);
  assert.match(source, /targetCorrelationId: WORKSPACE_MAIN_SESSION_MARKER/);
  assert.match(source, /delivery\.receipt\?\.publicationStage !== "accepted"/);
  assert.match(source, /Result: \$\{completionHandle\.resource\}/);
  assert.match(source, /outcome: "cancelled",[\s\S]*?Workspace window \$\{name\} was closed by its Monitor owner/);
  assert.match(source, /MANAGED_WINDOW_TERMINAL_DEADLINE_MS/);
  assert.match(source, /Workspace worker runtime died without publishing a canonical terminal envelope/);
  assert.match(source, /targetSessionId: fence\.sessionId/);
  assert.match(source, /buildManagedWindowPiArgs\(\{ sessionName, presentation, forkSessionFile \}\)/);
  assert.match(source, /stdio: presentation === "headless" \? \["pipe", "ignore", "ignore"\] : "ignore"/);
  assert.match(source, /type: "get_state"/);
  assert.match(source, /window\.terminationRequested = true;[\s\S]*?termination\.terminate\(\)/);
  assert.match(source, /window\.settled = true;[\s\S]*?publishWorkspaceTerminalCompletion\(request, terminal\)[\s\S]*?window\.terminalPublished = true;[\s\S]*?stopManagedWindow\(window\.name\)/);
  assert.match(source, /window\.completionHandle[\s\S]*?window\.terminalDeadlineAt !== undefined[\s\S]*?!window\.terminalPublished/);
  assert.match(source, /spawned\.window\.completionHandle = completionHandle;[\s\S]*?routeSessionMessage\(\{/);
  assert.match(source, /owner\.sessionName === window\.sessionName/);
  assert.doesNotMatch(source, /terminal result request registered for the launched root task/);
  assert.match(source, /managedWindows\.get\(name\) !== spawned\.window \|\| !exactManagedWindowOwner\(spawned\.window\)/);
  assert.match(source, /owner\.ownerId === window\.ownerId[\s\S]*?owner\.ownerNonce === window\.ownerNonce[\s\S]*?owner\.pid === window\.pid/);
  assert.match(source, /await refreshWorkspacePeerOwnersStrict\(\)[\s\S]*?terminateManagedWindowProcess\(window\)/);
  assert.match(source, /const exited = window\.pid !== undefined && !managedWindowPidIsAlive\(window\.pid\)/);
  assert.match(source, /const status = await terminateManagedWindowProcess\(window\)/);
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
  assert.match(source, /remoteRuns\.length} remote/);
  assert.match(monitorSource, /workspace-window only for local Pi worker windows/);
  assert.match(monitorSource, /remote-worker targets/);
  assert.match(monitorSource, /objective is delivered by create/);
  assert.match(monitorSource, /at most one intervention per target per tick/);
  assert.match(monitorSource, /Never repeat that message while it remains queued or accepted/);
  assert.match(monitorSource, /Never attempt to close discovered external peer windows/);
  assert.match(monitorSource, /injected only at the next turn boundary/);
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

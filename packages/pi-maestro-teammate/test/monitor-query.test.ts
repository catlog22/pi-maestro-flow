import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Check } from "typebox/value";
import { MonitorQueryParams } from "../src/extension/schemas.ts";
import {
  MONITOR_QUERY_MAX_TIMEOUT_MS,
  observeMonitorRemoteWindowsForRevalidation,
  revalidateMonitorRemoteWindowCaptures,
  runMonitorQuery,
  type MonitorQueryAuthorityFence,
  type MonitorQueryDependencies,
  type MonitorQuerySnapshot,
} from "../src/extension/monitor.ts";
import { reduceMonitorWindowStateV1 } from "../src/extension/monitor-window-state.ts";
import type { MonitorWindowJsonValueV1 } from "../src/public/v1/monitor-window-state.ts";
import {
  REMOTE_WINDOW_TRANSPORT_VERSION,
  type RemoteWindowCapture,
  type RemoteWindowObserveResult,
} from "../src/remote/protocol.ts";
import { SESSION_ENDPOINT_VERSION, type SessionEndpoint } from "../src/sessions/session-core.ts";
import { WORKSPACE_PEER_PROTOCOL_VERSION } from "../src/sessions/workspace-peer-core.ts";

const WORKSPACE = "a".repeat(64);
const OWNER_A = "b".repeat(32);
const OWNER_B = "c".repeat(32);
const NONCE_A = "d".repeat(32);
const NONCE_B = "e".repeat(32);

function endpoint(ownerId: string, ownerNonce: string, status: SessionEndpoint["status"] = "running"): SessionEndpoint {
  return {
    version: SESSION_ENDPOINT_VERSION,
    id: `endpoint:${ownerId}`,
    kind: "root",
    scope: "workspace-peer",
    transport: "workspace-peer-v1",
    status,
    capabilities: ["inspect"],
    ordinal: 0,
    contentRevision: `${ownerNonce}:${status}`,
    workspaceId: WORKSPACE,
    ownerId,
    ownerNonce,
    sessionName: `window-${ownerId.slice(0, 4)}`,
  };
}

function snapshot(options: {
  firstNonce?: string;
  firstStatus?: SessionEndpoint["status"];
  firstAttention?: "info" | "warning" | "error";
  firstFacetData?: MonitorWindowJsonValueV1;
} = {}): MonitorQuerySnapshot {
  const firstEndpoint = endpoint(OWNER_A, options.firstNonce ?? NONCE_A, options.firstStatus);
  const secondEndpoint = endpoint(OWNER_B, NONCE_B);
  const firstIdentity = {
    workspaceId: WORKSPACE,
    ownerId: OWNER_A,
    ownerNonce: options.firstNonce ?? NONCE_A,
    endpointId: firstEndpoint.id,
  };
  const firstFacet = options.firstAttention || options.firstFacetData ? [{
    kind: "test",
    target: { identity: firstIdentity },
    revision: options.firstAttention ? `attention:${options.firstAttention}` : "data",
    data: options.firstFacetData ?? null,
    ...(options.firstAttention ? {
      attention: [{
        code: "needs-attention",
        severity: options.firstAttention,
        message: "Review this window.",
      }],
    } : {}),
  }] : [];
  const state = reduceMonitorWindowStateV1({
    observedAt: 1_000,
    windows: [
      { endpoint: firstEndpoint, facets: firstFacet },
      { endpoint: secondEndpoint },
    ],
  });
  return {
    state,
    targets: [{
      target: `owner:${OWNER_A}`,
      aliases: ["first"],
      identity: firstIdentity,
      timeline: [{ group: "root-session", entries: [{ at: 900, label: "assistant", detail: "first-only" }] }],
    }, {
      target: `owner:${OWNER_B}`,
      aliases: ["second"],
      identity: {
        workspaceId: WORKSPACE,
        ownerId: OWNER_B,
        ownerNonce: NONCE_B,
        endpointId: secondEndpoint.id,
      },
      timeline: [{ group: "root-session", entries: [{ at: 800, label: "assistant", detail: "second-only" }] }],
    }],
  };
}

function harness(snapshots: MonitorQuerySnapshot[]) {
  let authority: MonitorQueryAuthorityFence | undefined = {
    rootGeneration: 1,
    sessionId: "session-a",
    workspaceId: WORKSPACE,
    sourceId: "session-a",
    monitorGeneration: 1,
  };
  let index = 0;
  const dependencies: MonitorQueryDependencies = {
    captureAuthority: () => authority ? { ...authority } : undefined,
    isAuthorityCurrent: (capture) => Boolean(authority
      && capture.rootGeneration === authority.rootGeneration
      && capture.sessionId === authority.sessionId
      && capture.workspaceId === authority.workspaceId
      && capture.sourceId === authority.sourceId
      && capture.monitorGeneration === authority.monitorGeneration),
    read: async () => snapshots[Math.min(index, snapshots.length - 1)]!,
    waitForWake: async () => { index++; },
  };
  return {
    dependencies,
    replaceAuthority(next: MonitorQueryAuthorityFence | undefined) { authority = next; },
  };
}

const signal = () => new AbortController().signal;

function remoteCapture(label: string, ownerNonce = `nonce-${label}`): RemoteWindowCapture {
  return {
    workspaceRef: `workspace-${label}`,
    authorityId: `authority-${label}`,
    gatewayWorkerId: "gateway-worker",
    gatewayInstanceNonce: "gateway-instance",
    monitorOwnerNonce: "monitor-owner",
    workspaceId: WORKSPACE,
    ownerId: `owner-${label}`,
    ownerNonce,
    generation: 1,
    transportVersion: REMOTE_WINDOW_TRANSPORT_VERSION,
    capabilities: ["observe"],
    cancel: false,
  };
}

function remoteObservation(capture: RemoteWindowCapture): RemoteWindowObserveResult {
  return {
    capture,
    owner: {
      version: WORKSPACE_PEER_PROTOCOL_VERSION,
      kind: "owner",
      workspaceId: capture.workspaceId,
      normalizedCwd: "/workspace",
      ownerId: capture.ownerId,
      ownerNonce: capture.ownerNonce,
      pid: 1,
      publishedAt: 1,
      agents: [],
      settled: [],
    },
    observedAt: 1,
  };
}

test("monitor query schema keeps list/get/wait single-window and rejects observe-style barriers", () => {
  assert.equal(Check(MonitorQueryParams, { action: "list" }), true);
  assert.equal(Check(MonitorQueryParams, { action: "list", detail: "full" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "get", target: `owner:${OWNER_A}`, detail: "full" }), true);
  assert.equal(Check(MonitorQueryParams, { action: "get" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "wait", target: `owner:${OWNER_A}`, until: "settled", timeoutMs: 10 }), true);
  assert.equal(Check(MonitorQueryParams, { action: "wait", target: `owner:${OWNER_A}`, timeoutMs: MONITOR_QUERY_MAX_TIMEOUT_MS }), true);
  assert.equal(Check(MonitorQueryParams, { action: "wait", target: `owner:${OWNER_A}`, timeoutMs: MONITOR_QUERY_MAX_TIMEOUT_MS + 1 }), false);
  assert.equal(Check(MonitorQueryParams, { action: "wait", until: "change" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "get", target: "first", until: "attention" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "list", targets: ["first"], waitMode: "all" }), false);
});

test("monitor runtime rejects timer overflow and accepts the maximum without scheduling an immediate timeout", async () => {
  const accepted = await runMonitorQuery(
    { action: "wait", target: "first", cursor: "previous", timeoutMs: MONITOR_QUERY_MAX_TIMEOUT_MS },
    harness([snapshot()]).dependencies,
    signal(),
  );
  assert.equal(accepted.status, "ok");

  const state = harness([snapshot()]);
  let reads = 0;
  state.dependencies.read = async () => { reads++; return snapshot(); };
  const rejected = await runMonitorQuery(
    { action: "wait", target: "first", timeoutMs: MONITOR_QUERY_MAX_TIMEOUT_MS + 1 },
    state.dependencies,
    signal(),
  );
  assert.equal(rejected.status, "aborted");
  assert.match(rejected.reason ?? "", new RegExp(String(MONITOR_QUERY_MAX_TIMEOUT_MS)));
  assert.equal(reads, 0, "invalid runtime input is rejected before any snapshot or timer");
});

test("monitor list is attention-first and summary never carries multi-window timelines", async () => {
  const state = harness([snapshot({ firstAttention: "error" })]);
  const result = await runMonitorQuery({ action: "list" }, state.dependencies, signal());
  assert.equal(result.status, "ok");
  assert.equal(result.windows[0]?.target, `owner:${OWNER_A}`);
  assert.equal(result.windows.length, 2);
  assert.ok(result.windows.every((window) => window.timeline === undefined));
});

test("monitor get returns one exact complete card and full includes only that window timeline", async () => {
  const state = harness([snapshot()]);
  const full = await runMonitorQuery({ action: "get", target: "first", detail: "full" }, state.dependencies, signal());
  assert.equal(full.status, "ok");
  assert.equal(full.windows.length, 1);
  assert.equal(full.windows[0]?.target, `owner:${OWNER_A}`);
  assert.equal(full.windows[0]?.window.identity.ownerNonce, NONCE_A);
  assert.equal(full.windows[0]?.timeline?.[0]?.entries[0]?.detail, "first-only");
  assert.doesNotMatch(JSON.stringify(full), /second-only/);

  const summary = await runMonitorQuery({ action: "get", target: "first" }, state.dependencies, signal());
  assert.equal(summary.windows[0]?.timeline, undefined);
});

test("monitor wait observes one window change and retains its exact target", async () => {
  const state = harness([snapshot(), snapshot({ firstStatus: "settled" })]);
  const result = await runMonitorQuery({ action: "wait", target: "first", until: "change", timeoutMs: 100 }, state.dependencies, signal());
  assert.equal(result.status, "ok");
  assert.equal(result.windows[0]?.target, `owner:${OWNER_A}`);
  assert.equal(result.windows[0]?.window.window.lifecycle.status, "settled");
});

test("window cursor uses the reducer canonical hash across facet key-order permutations", async () => {
  const first = await runMonitorQuery(
    { action: "get", target: "first" },
    harness([snapshot({ firstFacetData: { alpha: 1, nested: { beta: 2, gamma: 3 } } })]).dependencies,
    signal(),
  );
  const second = await runMonitorQuery(
    { action: "get", target: "first" },
    harness([snapshot({ firstFacetData: { nested: { gamma: 3, beta: 2 }, alpha: 1 } })]).dependencies,
    signal(),
  );
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(first.windows[0]?.cursor, second.windows[0]?.cursor);
});

test("monitor wait deadline covers an unresponsive first snapshot read", async () => {
  const state = harness([snapshot()]);
  state.dependencies.read = async () => new Promise<never>(() => {});
  const startedAt = Date.now();
  const result = await runMonitorQuery(
    { action: "wait", target: "first", until: "change", timeoutMs: 20 },
    state.dependencies,
    signal(),
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.windows.length, 0);
  assert.ok(Date.now() - startedAt < 500);
});

test("monitor wait deadline covers every later snapshot read and retains the last exact card", async () => {
  const state = harness([snapshot()]);
  let reads = 0;
  state.dependencies.read = async () => {
    if (reads++ === 0) return snapshot();
    return new Promise<never>(() => {});
  };
  state.dependencies.waitForWake = async () => {};
  const startedAt = Date.now();
  const result = await runMonitorQuery(
    { action: "wait", target: "first", until: "change", timeoutMs: 20 },
    state.dependencies,
    signal(),
  );
  assert.equal(result.status, "timeout");
  assert.equal(result.windows[0]?.window.identity.ownerNonce, NONCE_A);
  assert.ok(Date.now() - startedAt < 500);
});

test("a later snapshot read failure stays aborted and retains the last exact card", async () => {
  const state = harness([snapshot()]);
  let reads = 0;
  state.dependencies.read = async () => {
    if (reads++ === 0) return snapshot();
    throw new Error("second read failed");
  };
  state.dependencies.waitForWake = async () => {};

  const result = await runMonitorQuery(
    { action: "wait", target: "first", until: "change", timeoutMs: 100 },
    state.dependencies,
    signal(),
  );
  assert.equal(result.status, "aborted");
  assert.equal(result.windows[0]?.window.identity.ownerNonce, NONCE_A);
  assert.match(result.reason ?? "", /second read failed/);
});

test("authority rotation wins over a coincident snapshot deadline", async () => {
  const state = harness([snapshot()]);
  let reads = 0;
  state.dependencies.read = async () => {
    if (reads++ === 0) return snapshot();
    setTimeout(() => state.replaceAuthority(undefined), 5);
    return new Promise<never>(() => {});
  };
  state.dependencies.waitForWake = async () => {};

  const result = await runMonitorQuery(
    { action: "wait", target: "first", until: "change", timeoutMs: 30 },
    state.dependencies,
    signal(),
  );
  assert.equal(result.status, "stale");
  assert.equal(result.windows[0]?.window.identity.ownerNonce, NONCE_A);
  assert.match(result.reason ?? "", /generation changed|session/);
});

test("monitor wait returns stale for owner replacement instead of following the selector", async () => {
  const state = harness([snapshot(), snapshot({ firstNonce: NONCE_B })]);
  const result = await runMonitorQuery({ action: "wait", target: "first", until: "change", timeoutMs: 100 }, state.dependencies, signal());
  assert.equal(result.status, "stale");
  assert.equal(result.windows[0]?.window.identity.ownerNonce, NONCE_A);
  assert.match(result.reason ?? "", /owner was replaced|disappeared/);
});

test("Monitor exit/re-enter generation fences a sleeping query", async () => {
  const state = harness([snapshot(), snapshot({ firstStatus: "settled" })]);
  const originalWait = state.dependencies.waitForWake!;
  state.dependencies.waitForWake = async (capture, timeoutMs, waitSignal) => {
    await originalWait(capture, timeoutMs, waitSignal);
    state.replaceAuthority({ ...capture, monitorGeneration: capture.monitorGeneration + 2 });
  };
  const result = await runMonitorQuery({ action: "wait", target: "first", until: "change", timeoutMs: 100 }, state.dependencies, signal());
  assert.equal(result.status, "stale");
  assert.match(result.reason ?? "", /generation changed/);
});

test("monitor tool is root-only, exposure-controlled, and does not import Flow", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const monitorSource = await readFile(new URL("../src/extension/monitor.ts", import.meta.url), "utf8");
  const childReturn = source.indexOf("return; // Child mode done");
  const tool = source.indexOf('name: "monitor"');
  assert.ok(childReturn >= 0 && tool > childReturn);
  assert.match(source, /exclusiveNames: \["monitor", "workspace-window", "remote-worker"\]/);
  assert.match(source, /discoverWorkspacePeers\(publisher\.identity, \{\s*cleanupStale: true,\s*includeSelf: true/);
  assert.match(source, /selectMonitorVisibleRootEndpoints\(\s*monitorRegistry\.listEndpoints\(\),\s*publisher\.identity/);
  assert.match(source, /endpoint\.scope !== "local" && endpoint\.scope !== "workspace-peer"/);
  assert.match(source, /currentRemoteMonitorRuns\(\)\.entries\(\)/);
  assert.match(source, /readMonitorWindowFacets\([\s\S]*?signal,\s*timeoutMs: MONITOR_WINDOW_FACET_READ_TIMEOUT_MS/);
  assert.match(source, /await workspacePeerLifecycle;\s*if \(!ownsMonitorQueryAuthority\(authority\)\)[\s\S]*?workspacePeerPublisher === publisher && ownsMonitorQueryAuthority\(authority\)/);
  assert.doesNotMatch(monitorSource, /pi-maestro-flow|packages\/pi-maestro-flow/);
});

test("initial SSH observe failure is excluded while a healthy captured peer remains fail-closed", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /Initial SSH observe is fail-soft[\s\S]*?if \(!target \|\| !startingCapture\) return \[\];/);

  const healthy = remoteCapture("healthy");
  const observations = await observeMonitorRemoteWindowsForRevalidation([
    { endpointId: "healthy-endpoint", target: "healthy-target", startingCapture: healthy },
  ], {
    observe: async () => remoteObservation(healthy),
    isCurrent: () => true,
  });
  assert.doesNotThrow(() => revalidateMonitorRemoteWindowCaptures(observations, () => healthy));
});

test("multi-SSH final capture sweep rejects A rotating while B observation is blocked", async () => {
  const captureA = remoteCapture("a");
  const captureB = remoteCapture("b");
  const currentCaptures = new Map([
    ["target-a", captureA],
    ["target-b", captureB],
  ]);
  let releaseB!: () => void;
  const bBlocked = new Promise<void>((resolve) => { releaseB = resolve; });
  let markAObserved!: () => void;
  const aObserved = new Promise<void>((resolve) => { markAObserved = resolve; });

  const pending = observeMonitorRemoteWindowsForRevalidation([
    { endpointId: "endpoint-a", target: "target-a", startingCapture: captureA },
    { endpointId: "endpoint-b", target: "target-b", startingCapture: captureB },
  ], {
    observe: async (target) => {
      if (target === "target-a") {
        markAObserved();
        return remoteObservation(captureA);
      }
      await bBlocked;
      return remoteObservation(captureB);
    },
    isCurrent: () => true,
  });

  await aObserved;
  currentCaptures.set("target-a", remoteCapture("a", "rotated-owner-nonce"));
  releaseB();
  const observations = await pending;

  assert.throws(
    () => revalidateMonitorRemoteWindowCaptures(observations, (target) => currentCaptures.get(target)),
    /Remote window endpoint-a changed owner/,
  );
});

test("workspace and SSH owners are revalidated together before a no-await final sweep", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  const facetRead = source.indexOf("const facets = await readMonitorWindowFacets");
  const aggregateObserve = source.indexOf("const [remoteWindowObservations, finalWorkspaceDiscovery] = await Promise.all", facetRead);
  const remoteSweep = source.indexOf("revalidateMonitorRemoteWindowCaptures(", aggregateObserve);
  const workspaceMap = source.indexOf("const finalVisibleWorkspaceEndpoints", remoteSweep);
  const reduction = source.indexOf("for (const item of reductionItems)", workspaceMap);
  const firstClaimText = "sameMonitorRootSessionClaim(item.endpoint, finalEndpoint)";
  const finalClaimText = "sameMonitorRootSessionClaim(finalEndpoint, current)";
  const firstClaim = source.indexOf(firstClaimText, reduction);
  const finalClaim = source.indexOf(finalClaimText, firstClaim);
  assert.ok(facetRead >= 0 && aggregateObserve > facetRead, "final owner observations start only after facets settle");
  assert.ok(remoteSweep > aggregateObserve
    && workspaceMap > remoteSweep
    && reduction > workspaceMap
    && firstClaim > reduction
    && finalClaim > firstClaim,
    "remote and workspace owners are synchronously swept before and during reduction");
  const finalSweepSource = source.slice(remoteSweep, finalClaim + finalClaimText.length);
  assert.doesNotMatch(finalSweepSource, /\bawait\b/);
  assert.match(finalSweepSource, /finalWorkspaceDiscovery\.peers/);
  assert.match(finalSweepSource, /sameMonitorRootSessionClaim\(item\.endpoint, finalEndpoint\)/);
  assert.match(finalSweepSource, /sameMonitorRootSessionClaim\(finalEndpoint, current\)/);
});

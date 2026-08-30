import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Check } from "typebox/value";
import { MonitorQueryParams } from "../src/extension/schemas.ts";
import {
  runMonitorQuery,
  type MonitorQueryAuthorityFence,
  type MonitorQueryDependencies,
  type MonitorQuerySnapshot,
} from "../src/extension/monitor.ts";
import { reduceMonitorWindowStateV1 } from "../src/extension/monitor-window-state.ts";
import { SESSION_ENDPOINT_VERSION, type SessionEndpoint } from "../src/sessions/session-core.ts";

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
} = {}): MonitorQuerySnapshot {
  const firstEndpoint = endpoint(OWNER_A, options.firstNonce ?? NONCE_A, options.firstStatus);
  const secondEndpoint = endpoint(OWNER_B, NONCE_B);
  const firstIdentity = {
    workspaceId: WORKSPACE,
    ownerId: OWNER_A,
    ownerNonce: options.firstNonce ?? NONCE_A,
    endpointId: firstEndpoint.id,
  };
  const firstFacet = options.firstAttention ? [{
    kind: "test",
    target: { identity: firstIdentity },
    revision: `attention:${options.firstAttention}`,
    data: null,
    attention: [{
      code: "needs-attention",
      severity: options.firstAttention,
      message: "Review this window.",
    }],
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

test("monitor query schema keeps list/get/wait single-window and rejects observe-style barriers", () => {
  assert.equal(Check(MonitorQueryParams, { action: "list" }), true);
  assert.equal(Check(MonitorQueryParams, { action: "list", detail: "full" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "get", target: `owner:${OWNER_A}`, detail: "full" }), true);
  assert.equal(Check(MonitorQueryParams, { action: "get" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "wait", target: `owner:${OWNER_A}`, until: "settled", timeoutMs: 10 }), true);
  assert.equal(Check(MonitorQueryParams, { action: "wait", until: "change" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "get", target: "first", until: "attention" }), false);
  assert.equal(Check(MonitorQueryParams, { action: "list", targets: ["first"], waitMode: "all" }), false);
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
  assert.match(source, /endpoint\.kind === "root" && \(endpoint\.scope === "workspace-peer" \|\| endpoint\.scope === "ssh-window"\)/);
  assert.match(source, /currentRemoteMonitorRuns\(\)\.entries\(\)/);
  assert.doesNotMatch(monitorSource, /pi-maestro-flow|packages\/pi-maestro-flow/);
});

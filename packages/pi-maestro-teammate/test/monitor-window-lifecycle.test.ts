import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MonitorWindowLifecycleService,
  type MonitorWindowLifecycleAdapter,
} from "../src/extension/monitor-window-lifecycle.ts";

type Authority = { rootGeneration: number; monitorGeneration: number };
type Owner = { ownerId: string; ownerNonce: string };
type Handle = { id: string };
type Delivery = { published: boolean; accepted: boolean; error?: string };
type Window = {
  name: string;
  owner: Owner;
  handle?: Handle;
  monitorManaged: boolean;
  closeRequested: boolean;
};

const OWNER_A: Owner = { ownerId: "owner-a", ownerNonce: "nonce-a" };
const OWNER_B: Owner = { ownerId: "owner-a", ownerNonce: "nonce-b" };

function harness(overrides: Partial<MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery>> = {}) {
  let authority: Authority | undefined = { rootGeneration: 1, monitorGeneration: 1 };
  const window: Window = {
    name: "worker",
    owner: OWNER_A,
    monitorManaged: true,
    closeRequested: false,
  };
  let currentWindow: Window | undefined = window;
  const calls = {
    spawn: 0,
    wait: 0,
    refresh: 0,
    deliver: 0,
    stop: 0,
    commit: 0,
    finalize: 0,
  };
  const adapter: MonitorWindowLifecycleAdapter<Authority, Window, Owner, Handle, Delivery> = {
    captureAuthority: () => authority ? { ...authority } : undefined,
    isAuthorityCurrent: (capture) => Boolean(authority
      && capture.rootGeneration === authority.rootGeneration
      && capture.monitorGeneration === authority.monitorGeneration),
    createHandle: () => ({ id: "handle" }),
    spawn: async () => { calls.spawn++; return { ok: true, window }; },
    isCurrentWindow: (candidate) => currentWindow === candidate,
    waitForOwner: async () => { calls.wait++; return OWNER_A; },
    refreshOwners: async () => { calls.refresh++; },
    exactOwner: (candidate) => candidate.owner,
    sameOwner: (left, right) => left.ownerId === right.ownerId && left.ownerNonce === right.ownerNonce,
    bindHandle: (candidate, handle) => { candidate.handle = handle; },
    deliverObjective: async () => { calls.deliver++; return { published: true, accepted: true }; },
    deliveryState: (delivery) => delivery,
    commitPublished: () => { calls.commit++; },
    lookup: (name) => currentWindow?.name === name ? currentWindow : undefined,
    handleOf: (candidate) => candidate.handle,
    isMonitorManaged: (candidate) => candidate.monitorManaged,
    markCloseRequested: (candidate, requested) => { candidate.closeRequested = requested; },
    stopExact: async (candidate) => {
      calls.stop++;
      if (currentWindow !== candidate) return { ok: false, error: "exact window was replaced" };
      currentWindow = undefined;
      return { ok: true, status: "stopped" };
    },
    finalizeCancelled: async () => { calls.finalize++; return true; },
    ...overrides,
  };
  return {
    calls,
    window,
    adapter,
    service: new MonitorWindowLifecycleService(adapter),
    replaceAuthority(next: Authority | undefined) { authority = next; },
    replaceWindow(next: Window | undefined) { currentWindow = next; },
  };
}

const request = {
  name: "worker",
  objective: "do the work",
  cwd: "/workspace",
  presentation: "headless" as const,
};
const signal = () => new AbortController().signal;

test("create fences Monitor exit/re-enter after an awaited owner admission and cleans the exact launch", async () => {
  let state!: ReturnType<typeof harness>;
  state = harness({
    waitForOwner: async () => {
      state.calls.wait++;
      state.replaceAuthority({ rootGeneration: 1, monitorGeneration: 3 });
      return OWNER_A;
    },
  });

  const result = await state.service.create(request, signal());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Monitor generation changed/);
  assert.equal(state.calls.stop, 1);
  assert.equal(state.calls.deliver, 0);
  assert.equal(state.calls.finalize, 0, "nothing was published before the fence failed");
});

test("create rejects owner replacement after awaited delivery and never follows the replacement", async () => {
  let state!: ReturnType<typeof harness>;
  state = harness({
    deliverObjective: async () => {
      state.calls.deliver++;
      state.window.owner = OWNER_B;
      return { published: true, accepted: true };
    },
  });

  const result = await state.service.create(request, signal());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /changed its exact owner/);
  assert.equal(state.calls.stop, 1);
  assert.equal(state.calls.commit, 0, "a replaced owner cannot commit admission");
  assert.equal(state.calls.finalize, 1, "published partial admission is cancelled during cleanup");
  assert.equal(result.handle?.id, "handle");
});

test("published but unaccepted partial admission is stopped and receives canonical cancelled cleanup", async () => {
  const state = harness({
    deliverObjective: async () => {
      state.calls.deliver++;
      return { published: true, accepted: false, error: "target did not accept" };
    },
  });

  const result = await state.service.create(request, signal());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /target did not accept/);
  assert.equal(state.calls.commit, 1, "published journal entry is committed before rollback");
  assert.equal(state.calls.stop, 1);
  assert.equal(state.calls.finalize, 1);
  assert.equal(result.completionPersisted, true);
  assert.equal(state.window.closeRequested, true);
});

test("close fences root replacement after stop and does not publish with stale authority", async () => {
  let state!: ReturnType<typeof harness>;
  state = harness({
    stopExact: async () => {
      state.calls.stop++;
      state.replaceAuthority({ rootGeneration: 2, monitorGeneration: 1 });
      return { ok: true, status: "stopped" };
    },
  });
  state.window.handle = { id: "handle" };

  const result = await state.service.close("worker");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Root session or Monitor generation changed/);
  assert.equal(state.calls.finalize, 0);
});

test("slash status and monitor list share one query execution path while both lifecycle entry points share one service", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /const executeMonitorQuery = [\s\S]*?runMonitorQuery\(params, monitorQueryDependencies, signal\)/);
  assert.match(source, /name: "monitor"[\s\S]*?executeMonitorQuery\(params, signal\)/);
  assert.match(source, /if \(trimmed === "status"\)[\s\S]*?executeMonitorQuery\(\{ action: "list" \}/);
  assert.equal(source.match(/monitorWindowLifecycle\.create\(/g)?.length, 2);
  assert.equal(source.match(/monitorWindowLifecycle\.close\(/g)?.length, 2);
  const monitorCommandStart = source.indexOf('pi.registerCommand("monitor"');
  const advisorCommandStart = source.indexOf('pi.registerCommand("advisor"');
  const slash = source.slice(monitorCommandStart, advisorCommandStart);
  assert.doesNotMatch(slash, /spawnManagedWindow\(|stopManagedWindow\(|waitForManagedWindowOwner\(|routeSessionMessage\(/);
});

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
    terminate: 0,
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
    stopExact: async (candidate, authorization) => {
      calls.stop++;
      if (!authorization.authorize()) return { ok: false, terminationStarted: false, error: "stale Monitor authority" };
      if (currentWindow !== candidate) return { ok: false, terminationStarted: false, error: "exact window was replaced" };
      calls.terminate++;
      currentWindow = undefined;
      return { ok: true, terminationStarted: true, status: "stopped" };
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

test("create passes provider selection unchanged through spawn and objective delivery", async () => {
  const providerRequest = {
    ...request,
    presentation: "interactive" as const,
    provider: "herdr" as const,
    herdrSession: "review",
  };
  const state = harness({
    spawn: async (received) => {
      state.calls.spawn++;
      assert.strictEqual(received, providerRequest);
      return { ok: true, window: state.window };
    },
    deliverObjective: async ({ request: received }) => {
      state.calls.deliver++;
      assert.strictEqual(received, providerRequest);
      return { published: true, accepted: true };
    },
  });

  const result = await state.service.create(providerRequest, signal());
  assert.equal(result.ok, true);
  assert.equal(state.calls.spawn, 1);
  assert.equal(state.calls.deliver, 1);
});

test("create authority loss rolls back only the exact spawned window", async () => {
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
  assert.equal(state.calls.terminate, 1, "exact-resource rollback survives Monitor authority loss");
  assert.equal(result.cleanup?.terminationStarted, true);
  assert.equal(state.calls.deliver, 0);
  assert.equal(state.calls.finalize, 0, "nothing was published before the fence failed");
});

test("create rollback never terminates a replacement window after authority loss", async () => {
  let state!: ReturnType<typeof harness>;
  const replacement: Window = {
    name: "worker",
    owner: OWNER_B,
    monitorManaged: true,
    closeRequested: false,
  };
  state = harness({
    waitForOwner: async () => {
      state.calls.wait++;
      state.replaceWindow(replacement);
      state.replaceAuthority({ rootGeneration: 1, monitorGeneration: 2 });
      return OWNER_A;
    },
  });

  const result = await state.service.create(request, signal());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Monitor generation changed/);
  assert.equal(state.calls.stop, 1);
  assert.equal(state.calls.terminate, 0, "exact-resource authorization rejects the replacement instance");
  assert.equal(result.cleanup?.terminationStarted, false);
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

test("close rejects delegation-owned windows before invoking stopExact", async () => {
  const state = harness();
  state.window.monitorManaged = false;

  const result = await state.service.close("worker");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not managed by Monitor/);
  assert.equal(state.calls.stop, 0);
  assert.equal(state.calls.terminate, 0);
});

test("close passes live authorization through stopExact and loss prevents termination", async () => {
  let state!: ReturnType<typeof harness>;
  state = harness({
    stopExact: async (_candidate, authorization) => {
      state.calls.stop++;
      assert.equal(authorization.scope, "monitor-authority");
      assert.deepEqual(authorization.authority, { rootGeneration: 1, monitorGeneration: 1 });
      state.replaceAuthority({ rootGeneration: 2, monitorGeneration: 1 });
      if (!authorization.authorize()) return { ok: false, terminationStarted: false, error: "stale Monitor authority" };
      state.calls.terminate++;
      return { ok: true, terminationStarted: true, status: "stopped" };
    },
  });
  state.window.handle = { id: "handle" };

  const result = await state.service.close("worker");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Root session or Monitor generation changed/);
  assert.equal(state.calls.stop, 1);
  assert.equal(state.calls.terminate, 0);
  assert.equal(result.terminationStarted, false);
  assert.equal(state.window.closeRequested, false, "a stale close rolls back when termination never started");
  assert.equal(state.calls.finalize, 0);
});

test("close retains closeRequested when termination started but stop reports failure", async () => {
  const state = harness({
    stopExact: async (_candidate, authorization) => {
      state.calls.stop++;
      assert.equal(authorization.scope, "monitor-authority");
      state.calls.terminate++;
      return { ok: false, terminationStarted: true, error: "termination outcome failed" };
    },
  });
  state.window.handle = { id: "handle" };

  const result = await state.service.close("worker");
  assert.equal(result.ok, false);
  assert.equal(result.terminationStarted, true);
  assert.equal(state.window.closeRequested, true);
  assert.equal(state.calls.finalize, 0);
});

test("slash status and monitor list share one query execution path while both lifecycle entry points share one service", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /const executeMonitorQuery = [\s\S]*?runMonitorQuery\(params, monitorQueryDependencies, signal\)/);
  assert.match(source, /name: "monitor"[\s\S]*?executeMonitorQuery\(params, signal\)/);
  assert.match(source, /if \(trimmed === "status"\)[\s\S]*?executeMonitorQuery\(\{ action: "list" \}/);
  assert.equal(source.match(/monitorWindowLifecycle\.create\(/g)?.length, 2);
  assert.equal(source.match(/monitorWindowLifecycle\.close\(/g)?.length, 2);
  assert.match(source, /await refreshWorkspacePeerOwnersStrict\(\);\s*assertAuthorized\("during"\)/);
  assert.match(source, /assertAuthorized\("before"\);[\s\S]*?const status = await terminateManagedWindowProcess\([\s\S]*?window,[\s\S]*?authorization\.authorize,[\s\S]*?terminationStarted = true/);
  const consumerStart = source.indexOf("consumer.start();");
  const publisherStart = source.indexOf("await publisher.start();");
  assert.notEqual(consumerStart, -1);
  assert.notEqual(publisherStart, -1);
  assert.ok(consumerStart < publisherStart, "the command consumer must be ready before the owner snapshot is published");
  assert.match(source, /const unbindWorkspacePeerRuntime = [\s\S]*?if \(changed\) refreshSessionEndpointDirectory\(\);/);
  assert.match(source, /catch \(error\) \{\s*unbindWorkspacePeerRuntime\(consumer\);/);
  assert.match(source, /if \(!registry\) \{\s*unbindWorkspacePeerRuntime\(\);/);
  const monitorCommandStart = source.indexOf('pi.registerCommand("monitor"');
  const advisorCommandStart = source.indexOf('pi.registerCommand("advisor"');
  const slash = source.slice(monitorCommandStart, advisorCommandStart);
  assert.doesNotMatch(slash, /spawnManagedWindow\(|stopManagedWindow\(|waitForManagedWindowOwner\(|routeSessionMessage\(/);
});

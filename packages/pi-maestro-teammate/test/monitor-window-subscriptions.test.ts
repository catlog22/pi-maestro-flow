import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Check } from "typebox/value";
import { MonitorQueryParams } from "../src/extension/schemas.ts";
import { MonitorWindowSubscriptions, MAX_MONITOR_WINDOW_SUBSCRIPTIONS, type MonitorWindowEvent } from "../src/extension/monitor-window-subscriptions.ts";
import type { MonitorQueryAuthorityFence, MonitorQuerySnapshot } from "../src/extension/monitor.ts";
import { reduceMonitorWindowStateV1 } from "../src/extension/monitor-window-state.ts";
import { SESSION_ENDPOINT_VERSION, SessionHostRegistry, type SessionEndpoint } from "../src/sessions/session-core.ts";

const identity = { workspaceId: "workspace", ownerId: "owner", ownerNonce: "nonce", endpointId: "endpoint" };
const target = "owner:owner";
function snapshot(options: { status?: SessionEndpoint["status"]; settleAt?: number; result?: string; completion?: string; outcome?: "completed" | "failed" | "no-result"; nonce?: string; generation?: number; sessionId?: string } = {}): MonitorQuerySnapshot {
  const exact = { ...identity, ownerNonce: options.nonce ?? identity.ownerNonce };
  const endpoint: SessionEndpoint = {
    version: SESSION_ENDPOINT_VERSION, id: exact.endpointId, kind: "root", scope: "workspace-peer", transport: "workspace-peer-v1",
    workspaceId: exact.workspaceId, ownerId: exact.ownerId, ownerNonce: exact.ownerNonce,
    sessionId: options.sessionId ?? "session", sourceId: options.sessionId ?? "session", generation: options.generation ?? 1,
    status: options.status ?? "running", capabilities: ["inspect"], ordinal: 0, contentRevision: "revision",
  };
  const workRef = { kind: "message", id: "work" };
  const state = reduceMonitorWindowStateV1({ observedAt: 100, windows: [{ endpoint, workRef,
    completion: options.completion ? [{ target: { identity: exact, workRef }, source: "canonical-completion", outcome: options.outcome ?? "completed", revision: options.completion, completedAt: 20 }] : [],
  }] });
  // Settlement is lifecycle evidence, deliberately independent of semantic cursor.
  if (options.settleAt !== undefined) state.windows[0]!.window.lifecycle.lastSettle = {
    at: options.settleAt, source: "lifecycle", ...(options.result === undefined ? {} : { lastResult: options.result }),
  };
  return { state, targets: [{ target, identity: exact, sessionId: endpoint.sessionId, sourceId: endpoint.sourceId, generation: endpoint.generation }] };
}
function harness(initial = snapshot()) {
  let current = initial;
  let generation = 1;
  const authority: MonitorQueryAuthorityFence = { rootGeneration: 1, sessionId: "root", workspaceId: "workspace", sourceId: "root", baseCwd: "/workspace", monitorGeneration: 1 };
  const events: MonitorWindowEvent[] = [];
  const errors: unknown[] = [];
  let reads = 0;
  const dependencies = {
    captureAuthority: () => ({ ...authority, monitorGeneration: generation }),
    isAuthorityCurrent: (capture: MonitorQueryAuthorityFence) => capture.monitorGeneration === generation
      && capture.rootGeneration === authority.rootGeneration && capture.sessionId === authority.sessionId,
    read: async () => { reads++; return current; },
    isTargetCurrent: (selected: MonitorQuerySnapshot["targets"][number]) => current.targets.some((item) => JSON.stringify(item) === JSON.stringify(selected)),
    notify: (event: MonitorWindowEvent) => { events.push(event); },
    onError: (error: unknown) => { errors.push(error); },
  };
  const hooks = new MonitorWindowSubscriptions(dependencies);
  return { hooks, dependencies, events, errors, set(next: MonitorQuerySnapshot) { current = next; }, rotate() { generation++; }, rotateRoot() { authority.rootGeneration++; authority.sessionId = "new-root"; }, reads: () => reads };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("schema exposes bounded selectable lifecycle hooks without arbitrary commands", () => {
  assert.ok(Check(MonitorQueryParams, { action: "subscribe", target }));
  assert.ok(Check(MonitorQueryParams, { action: "subscribe", target, events: ["running", "settled", "completed", "failed", "disconnected"] }));
  assert.ok(Check(MonitorQueryParams, { action: "subscriptions" }));
  assert.ok(Check(MonitorQueryParams, { action: "unsubscribe", subscriptionId: "exact" }));
  for (const input of [{ action: "subscribe" }, { action: "unsubscribe" }, { action: "subscribe", target, events: [] }, { action: "subscribe", target, events: ["completed", "completed"] }, { action: "get", target, events: ["completed"] }, { action: "subscribe", target, command: "echo" }, { action: "subscriptions", target }]) assert.equal(Check(MonitorQueryParams, input), false, JSON.stringify(input));
});

test("silent baseline, sleeping/no-result settle, repeated same-status settle and duplicate signals", async () => {
  const state = harness(snapshot({ status: "sleeping", settleAt: 1, completion: "old" }));
  const hook = await state.hooks.subscribe(target);
  assert.equal(state.events.length, 0);
  assert.equal(hook.identity.ownerNonce, "nonce");
  await state.hooks.refresh();
  assert.equal(state.events.length, 0);
  state.set(snapshot({ status: "sleeping", settleAt: 2 }));
  await state.hooks.refresh();
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((event) => event.event), ["settled"]);
  assert.equal(state.events[0]!.window.work.completion.outcome, "unknown");
  assert.equal(state.events[0]!.window.window.lifecycle.lastSettle!.lastResult, undefined);
  state.set(snapshot({ status: "sleeping", settleAt: 3 }));
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((event) => event.event), ["settled", "settled"]);
  assert.notEqual(state.events[0]!.eventId, state.events[1]!.eventId);
  state.set(snapshot({ status: "sleeping", settleAt: 3, completion: "new" }));
  await state.hooks.refresh();
  await state.hooks.refresh();
  assert.equal(state.events.at(-1)!.event, "completed");
  assert.equal(state.events.at(-1)!.window.work.completion.revision, "new");
});

test("completion is separate exact evidence; no-result is not completed and newer revisions wake", async () => {
  const state = harness();
  await state.hooks.subscribe(target);
  state.set(snapshot({ completion: "no-result", outcome: "no-result", settleAt: 1 }));
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((item) => item.event), ["settled"]);
  for (const revision of ["one", "one", "two", "one"]) {
    state.set(snapshot({ completion: revision, settleAt: 1 }));
    await state.hooks.refresh();
  }
  assert.deepEqual(state.events.map((item) => item.event), ["settled", "completed", "completed"]);
  state.set(snapshot({ completion: "failed", outcome: "failed" }));
  await state.hooks.refresh();
  assert.equal(state.events.at(-1)!.event, "failed");
});

test("selected running event and exact address only", async () => {
  const state = harness(snapshot({ status: "sleeping" }));
  await assert.rejects(state.hooks.subscribe("alias"), /Exact workspace owner/);
  await state.hooks.subscribe(target, ["running"]);
  state.set(snapshot());
  await state.hooks.refresh();
  state.set(snapshot({ settleAt: 1, completion: "done" }));
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((item) => item.event), ["running"]);
});

for (const replacement of [{ nonce: "replacement" }, { generation: 2 }, { sessionId: "other" }]) {
  test(`target replacement disconnects once and never follows: ${JSON.stringify(replacement)}`, async () => {
    const state = harness();
    await state.hooks.subscribe(target);
    state.set(snapshot(replacement));
    await state.hooks.refresh();
    state.set(snapshot({ ...replacement, completion: "done" }));
    await state.hooks.refresh();
    assert.deepEqual(state.events.map((item) => item.event), ["disconnected"]);
    assert.equal(state.hooks.list().length, 0);
    assert.equal(state.events[0]!.subscription.identity.ownerNonce, "nonce");
  });
}

test("missing target disconnects once", async () => {
  const state = harness();
  await state.hooks.subscribe(target);
  state.set({ state: reduceMonitorWindowStateV1({ windows: [], observedAt: 2 }), targets: [] });
  await state.hooks.refresh();
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((item) => item.event), ["disconnected"]);
});

test("root generation rotation and exit fence deferred registration", async () => {
  for (const stop of ["rotate", "rotateRoot", "clear"] as const) {
    const state = harness();
    const pending = deferred<MonitorQuerySnapshot>();
    state.dependencies.read = () => pending.promise;
    const registering = state.hooks.subscribe(target);
    if (stop === "rotate") state.rotate(); else if (stop === "rotateRoot") state.rotateRoot(); else state.hooks.clear();
    pending.resolve(snapshot({ completion: "late" }));
    await assert.rejects(registering, /authority changed/);
    assert.deepEqual(state.hooks.list(), []);
    assert.equal(state.events.length, 0);
  }
});

test("unregister, exit and generation rotation suppress late refresh callbacks", async () => {
  for (const stop of ["unsubscribe", "clear", "rotate", "rotateRoot"] as const) {
    const state = harness();
    const hook = await state.hooks.subscribe(target);
    const pending = deferred<MonitorQuerySnapshot>();
    state.dependencies.read = () => pending.promise;
    const refreshing = state.hooks.refresh();
    await Promise.resolve();
    if (stop === "unsubscribe") state.hooks.unsubscribe(hook.subscriptionId);
    else if (stop === "clear") state.hooks.clear(); else if (stop === "rotateRoot") state.rotateRoot(); else state.rotate();
    pending.resolve(snapshot({ completion: "late" }));
    await refreshing;
    assert.equal(state.events.length, 0);
    assert.deepEqual(state.hooks.list(), []);
  }
});

test("exact owner is revalidated after read await before event publication", async () => {
  const state = harness();
  await state.hooks.subscribe(target);
  const pending = deferred<MonitorQuerySnapshot>();
  state.dependencies.read = () => pending.promise;
  const refreshing = state.hooks.refresh();
  await Promise.resolve();
  state.set(snapshot({ nonce: "rotated" }));
  pending.resolve(snapshot({ completion: "stale-success" }));
  await refreshing;
  assert.deepEqual(state.events.map((item) => item.event), ["disconnected"]);
});

test("burst refresh is single flight plus trailing read and errors retry", async () => {
  const state = harness();
  await state.hooks.subscribe(target);
  const pending = deferred<MonitorQuerySnapshot>();
  let calls = 0;
  state.dependencies.read = async () => { calls++; return calls === 1 ? pending.promise : snapshot(); };
  const first = state.hooks.refresh();
  await Promise.resolve();
  for (let i = 0; i < 20; i++) assert.equal(state.hooks.refresh(), first);
  pending.resolve(snapshot());
  await first;
  assert.equal(calls, 2);
  const failure = new Error("transient");
  state.dependencies.read = async () => { throw failure; };
  await state.hooks.refresh();
  assert.deepEqual(state.errors, [failure]);
  assert.equal(state.hooks.list().length, 1);
  state.set(snapshot({ completion: "retry" }));
  state.dependencies.read = async () => snapshot({ completion: "retry" });
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((item) => item.event), ["completed"]);
});

test("clearing hooks suppresses diagnostics from an obsolete failing read", async () => {
  const state = harness();
  await state.hooks.subscribe(target);
  const pending = deferred<void>();
  state.dependencies.read = async () => { await pending.promise; throw new Error("obsolete"); };
  const refreshing = state.hooks.refresh();
  await Promise.resolve();
  state.hooks.clear();
  pending.resolve();
  await refreshing;
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.events, []);
});

test("subscription bound is rechecked after concurrent admission awaits", async () => {
  const state = harness();
  const results = await Promise.allSettled(Array.from({ length: MAX_MONITOR_WINDOW_SUBSCRIPTIONS + 1 }, () => state.hooks.subscribe(target)));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, MAX_MONITOR_WINDOW_SUBSCRIPTIONS);
  assert.equal(state.hooks.list().length, MAX_MONITOR_WINDOW_SUBSCRIPTIONS);
});

test("wiring uses registry wake hints and existing low-cost refresh, fenced notifications and cleanup", async () => {
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /monitorRegistry\.subscribe\(\(\) => \{\s*void monitorWindowSubscriptions\.refresh\(\)/);
  assert.match(source, /customType: "monitor-window-event"/);
  assert.match(source, /triggerTurn: true, deliverAs: "steer"/);
  assert.match(source, /monitorWindowSubscriptions\.list\(\)\.length[\s\S]*?refreshWorkspacePeerOwners\(\)\.then[\s\S]*?ownsMonitorQueryAuthority\(authority\)/);
  const cheap = source.slice(source.indexOf("const buildMonitorSubscriptionSnapshot"), source.indexOf("const monitorQueryDependencies"));
  assert.doesNotMatch(cheap, /readMonitorWindowFacets|discoverWorkspacePeers|executeMonitorQuery|windows\.list\(/);
  assert.match(cheap, /current\.sessionId === target\.sessionId[\s\S]*?current\.generation === target\.generation/);
  const exit = source.slice(source.indexOf("const exitMonitorInteractionMode"), source.indexOf("const notifyMonitorModeClosed"));
  assert.match(exit, /monitorWindowSubscriptions\.clear\(\)/);
  assert.match(source, /pi\.on\("session_shutdown", async \(event\) => \{\s*monitorWindowSubscriptions\.clear\(\)/);
  assert.match(source, /window\.terminalPublished = true;\s*void monitorWindowSubscriptions\.refresh\(\)/);
  assert.match(cheap, /managed\?\.terminalPublished \? managed\.terminalResult : undefined/);
  assert.match(source, /const disposers: Array<\(\) => void> = \[disposeMonitorWindowHooks\]/);
});

test("lifecycle sequence detects two sleeping settles in the same millisecond and root starts without child agents", async () => {
  const initial = snapshot({ status: "sleeping", settleAt: 1 });
  initial.targets = initial.targets.map((item) => ({ ...item, runningRevision: "lifecycle:1", settlementRevision: "lifecycle:2" }));
  const state = harness(initial);
  await state.hooks.subscribe(target, ["running", "settled"]);
  const next = snapshot({ status: "sleeping", settleAt: 1 });
  next.targets = next.targets.map((item) => ({ ...item, runningRevision: "lifecycle:3", settlementRevision: "lifecycle:4" }));
  state.set(next);
  await state.hooks.refresh();
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((item) => [item.event, item.sourceRevision]), [["running", "lifecycle:3"], ["settled", "lifecycle:4"]]);
});

test("an old cleared flight cannot erase or commit into a new generation flight", async () => {
  const state = harness();
  await state.hooks.subscribe(target);
  const old = deferred<MonitorQuerySnapshot>();
  state.dependencies.read = () => old.promise;
  const oldFlight = state.hooks.refresh();
  await Promise.resolve();
  state.hooks.clear();
  state.rotate();
  state.dependencies.read = async () => snapshot();
  await state.hooks.subscribe(target);
  const current = deferred<MonitorQuerySnapshot>();
  state.dependencies.read = () => current.promise;
  const currentFlight = state.hooks.refresh();
  await Promise.resolve();
  old.resolve(snapshot({ completion: "stale" }));
  await oldFlight;
  assert.equal(state.hooks.refresh(), currentFlight);
  assert.equal(state.events.length, 0);
  state.set(snapshot({ completion: "current" }));
  current.resolve(snapshot({ completion: "current" }));
  await currentFlight;
  assert.deepEqual(state.events.map((item) => item.event), ["completed"]);
});

test("real directory and thread subscriptions drive deduplicated hooks, disposer stops wiring", async () => {
  const state = harness();
  const endpoint: SessionEndpoint = {
    version: SESSION_ENDPOINT_VERSION, id: identity.endpointId, workspaceId: identity.workspaceId,
    ownerId: identity.ownerId, ownerNonce: identity.ownerNonce, sessionId: "session", sourceId: "session", generation: 1,
    kind: "root", scope: "workspace-peer", transport: "workspace-peer-v1", status: "running", capabilities: ["inspect"], ordinal: 0, contentRevision: "one",
  };
  const registry = new SessionHostRegistry({ endpoints: [endpoint] });
  const dispose = registry.subscribe(() => { void state.hooks.refresh(); }, { emitCurrent: false });
  await state.hooks.subscribe(target);
  state.set(snapshot({ completion: "done" }));
  registry.replaceEndpoints([{ ...endpoint, contentRevision: "two" }]);
  await state.hooks.refresh();
  registry.thread.record({ messageId: "message", workspaceId: "workspace", peerOwnerId: "owner", peerOwnerNonce: "nonce",
    direction: "outgoing", source: "monitor", mode: "steer", body: "work", status: "queued", createdAt: 1, updatedAt: 1 });
  await state.hooks.refresh();
  assert.deepEqual(state.events.map((event) => event.event), ["completed"]);
  assert.equal(state.events[0]!.subscription.generation, 1);
  const reads = state.reads();
  dispose();
  registry.thread.transition("message", "outgoing", "injected", 2);
  registry.replaceEndpoints([]);
  await Promise.resolve();
  assert.equal(state.reads(), reads);
});

test("incomplete target generation fences fail closed", async () => {
  const initial = snapshot();
  initial.targets = initial.targets.map((item) => ({ ...item, generation: undefined }));
  const state = harness(initial);
  await assert.rejects(state.hooks.subscribe(target), /session\/generation identity is unavailable/);
});

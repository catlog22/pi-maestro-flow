import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canProxySendTo, rootDispatchAncestor } from "../src/extension/index.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

function makeState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
}

function addAgent(state: TeammateState, name: string, spawnedBy?: string): string {
  const correlationId = randomUUID();
  const now = Date.now();
  state.activeRuns.set(correlationId, {
    agent: "worker",
    name,
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    ...(spawnedBy ? { spawnedBy } : {}),
  });
  state.namedAgents.set(name, correlationId);
  return correlationId;
}

/**
 *   treeA: rootA ─ midA ─ leafA
 *                └ siblingA
 *   treeB: rootB
 */
function makeTrees() {
  const state = makeState();
  const rootA = addAgent(state, "rootA");
  const midA = addAgent(state, "midA", rootA);
  const leafA = addAgent(state, "leafA", midA);
  const siblingA = addAgent(state, "siblingA", rootA);
  const rootB = addAgent(state, "rootB");
  return { state, rootA, midA, leafA, siblingA, rootB };
}

test("rootDispatchAncestor walks to the top of a tree", () => {
  const { state, rootA, midA, leafA, rootB } = makeTrees();
  assert.equal(rootDispatchAncestor(state, leafA), rootA);
  assert.equal(rootDispatchAncestor(state, midA), rootA);
  assert.equal(rootDispatchAncestor(state, rootA), rootA);
  assert.equal(rootDispatchAncestor(state, rootB), rootB);
});

test("rootDispatchAncestor terminates on a spawnedBy cycle", () => {
  const state = makeState();
  const first = addAgent(state, "first");
  const second = addAgent(state, "second", first);
  state.activeRuns.get(first)!.spawnedBy = second;
  assert.ok([first, second].includes(rootDispatchAncestor(state, first)));
});

test("aborting is limited to what the requester itself dispatched", () => {
  const { state, rootA, midA, leafA, siblingA, rootB } = makeTrees();

  assert.equal(canProxySendTo(state, midA, leafA, "abort").allowed, true, "own descendant");

  // Upward: an agent must not be able to terminate what created it.
  assert.equal(canProxySendTo(state, midA, rootA, "abort").allowed, false);
  // Sideways: a peer's subtree is not the requester's to tear down.
  assert.equal(canProxySendTo(state, midA, siblingA, "abort").allowed, false);
  // Across trees: the case with no legitimate reading at all.
  assert.equal(canProxySendTo(state, midA, rootB, "abort").allowed, false);

  assert.match(canProxySendTo(state, midA, rootB, "abort").reason ?? "", /subtree/);
});

test("messaging stays open across the requester's own dispatch tree", () => {
  const { state, rootA, midA, leafA, siblingA, rootB } = makeTrees();

  // Peer coordination is the normal pattern, so siblings and ancestors are fine.
  for (const target of [rootA, leafA, siblingA]) {
    assert.equal(canProxySendTo(state, midA, target, "follow_up").allowed, true);
  }
  assert.equal(canProxySendTo(state, midA, rootB, "follow_up").allowed, false);
  assert.match(canProxySendTo(state, midA, rootB, "follow_up").reason ?? "", /different dispatch tree/);
});

test("the root tool is unrestricted and self-targeting is always allowed", () => {
  const { state, midA, rootB } = makeTrees();
  // No requester means the call came from the root tool, driven by the user.
  assert.equal(canProxySendTo(state, undefined, rootB, "abort").allowed, true);
  assert.equal(canProxySendTo(state, midA, midA, "abort").allowed, true);
});

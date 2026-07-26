import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { handleProxyRequest, checkActiveAgentBudget } from "../src/extension/index.ts";
import { checkDepthGuard, MAX_DEFAULT_DEPTH } from "../src/runs/execution.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

function makeState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
}

function makeAgent(correlationId: string, depth: number, overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  const now = Date.now();
  return {
    agent: "worker",
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth,
    status: "running",
    sleepMs: 0,
    ...overrides,
  };
}

const stubPi = {
  events: { emit() {} },
  sendMessage() {},
} as never;

/** Drives one nested dispatch and returns the reply payload. */
async function dispatchNested(state: TeammateState, parentCid: string): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  await handleProxyRequest(
    stubPi,
    state,
    { type: "teammate_proxy_request", tool: "teammate", requestId: randomUUID(), params: { agent: "worker", task: "noop" } },
    (msg) => { captured = msg as Record<string, unknown>; },
    parentCid,
  );
  assert.ok(captured, "handleProxyRequest must reply");
  return captured;
}

test("checkDepthGuard rejects at the configured ceiling, not below it", () => {
  assert.equal(checkDepthGuard(0).allowed, true);
  assert.equal(checkDepthGuard(MAX_DEFAULT_DEPTH - 1).allowed, true);
  assert.equal(checkDepthGuard(MAX_DEFAULT_DEPTH).allowed, false);
  assert.equal(checkDepthGuard(MAX_DEFAULT_DEPTH).current, MAX_DEFAULT_DEPTH);
  assert.equal(checkDepthGuard(MAX_DEFAULT_DEPTH).max, MAX_DEFAULT_DEPTH);
});

test("depth guard is independent of PI_TEAMMATE_DEPTH in the current process", () => {
  // Nested dispatches run inside the root process, whose environment never
  // carries a depth. Reading it there is what made the guard a no-op.
  const previous = process.env.PI_TEAMMATE_DEPTH;
  process.env.PI_TEAMMATE_DEPTH = "0";
  try {
    assert.equal(checkDepthGuard(MAX_DEFAULT_DEPTH).allowed, false);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_DEPTH;
    else process.env.PI_TEAMMATE_DEPTH = previous;
  }
});

test("a proxied dispatch is rejected once its spawner already sits at the ceiling", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, MAX_DEFAULT_DEPTH - 1));

  const reply = await dispatchNested(state, parentCid);
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nesting depth exceeded/i);
  assert.match(result.content[0].text, new RegExp(`current=${MAX_DEFAULT_DEPTH}`));
  // The rejected dispatch must not have registered an agent.
  assert.equal(state.activeRuns.size, 1);
});

test("a proxied dispatch below the ceiling is not rejected by the depth guard", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, 0));

  const reply = await dispatchNested(state, parentCid);
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };

  // The dispatch may still fail for unrelated reasons in this stubbed
  // environment, but never with the depth-guard message.
  if (result.isError) {
    assert.doesNotMatch(result.content[0].text, /nesting depth exceeded/i);
  }
});

test("the active-agent budget counts live agents across the whole tree", () => {
  const state = makeState();
  const previous = process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
  process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = "3";
  try {
    assert.deepEqual(checkActiveAgentBudget(state), { allowed: true, active: 0, max: 3 });

    for (const status of ["running", "pending", "sleeping"] as const) {
      const cid = randomUUID();
      state.activeRuns.set(cid, makeAgent(cid, 0, { status }));
    }
    assert.equal(checkActiveAgentBudget(state).active, 3);
    assert.equal(checkActiveAgentBudget(state).allowed, false);

    // Settled agents release their slot.
    const settled = randomUUID();
    state.activeRuns.set(settled, makeAgent(settled, 0, { status: "failed" }));
    assert.equal(checkActiveAgentBudget(state).active, 3);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
    else process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = previous;
  }
});

test("a proxied dispatch is rejected when the agent budget is exhausted", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, 0));
  const previous = process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
  process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = "1";
  try {
    const reply = await dispatchNested(state, parentCid);
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /agent budget exhausted/i);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
    else process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = previous;
  }
});

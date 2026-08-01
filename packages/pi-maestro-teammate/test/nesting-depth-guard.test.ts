import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
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
async function dispatchNested(
  state: TeammateState,
  parentCid: string,
  claimed?: Record<string, unknown>,
  params: Record<string, unknown> = { tasks: [{ agent: "worker", prompt: "noop" }] },
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  await handleProxyRequest(
    stubPi,
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: randomUUID(),
      params,
      ...claimed,
    },
    (msg) => { captured = msg as Record<string, unknown>; },
    parentCid,
  );
  assert.ok(captured, "handleProxyRequest must reply");
  return captured;
}

test("checkDepthGuard rejects at the configured ceiling, not below it", () => {
  assert.equal(MAX_DEFAULT_DEPTH, 2);
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

test("a child cannot escape the ceiling by claiming a shallower parent", async () => {
  // The depth a dispatch is measured against comes from its spawner's record,
  // so a child that could name any correlationId could re-parent itself onto a
  // depth-0 agent and keep nesting forever.
  const state = makeState();
  const deepCid = randomUUID();
  const shallowCid = randomUUID();
  state.activeRuns.set(deepCid, makeAgent(deepCid, MAX_DEFAULT_DEPTH - 1));
  state.activeRuns.set(shallowCid, makeAgent(shallowCid, 0));

  for (const claim of [{ parentCid: shallowCid }, { correlationId: shallowCid }]) {
    const reply = await dispatchNested(state, deepCid, claim);
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true, `claim ${JSON.stringify(claim)} must not be honoured`);
    assert.match(result.content[0].text, /nesting depth exceeded/i);
  }
});

test("a claim inside the spawner's own subtree is still honoured", async () => {
  // Graph task children legitimately identify themselves this way.
  const state = makeState();
  const graphCid = randomUUID();
  const taskCid = randomUUID();
  state.activeRuns.set(graphCid, makeAgent(graphCid, MAX_DEFAULT_DEPTH - 2));
  state.activeRuns.set(taskCid, makeAgent(taskCid, MAX_DEFAULT_DEPTH - 1, { spawnedBy: graphCid }));

  const reply = await dispatchNested(state, graphCid, { correlationId: taskCid });
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true, "the task child's own depth must govern");
  assert.match(result.content[0].text, /nesting depth exceeded/i);
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

test("a proxied graph reserves every child slot before registration", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, 0));
  const previous = process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
  process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = "2";
  try {
    const reply = await dispatchNested(state, parentCid, undefined, {
      tasks: [
        { agent: "worker", prompt: "first" },
        { agent: "worker", prompt: "second" },
      ],
    });
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /2 more requested.*max 2/i);
    assert.equal(state.activeRuns.size, 1, "rejection must happen before graph/task registration");
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
    else process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = previous;
  }
});

test("P4: root and proxy graphs register every task before emitting started events", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");

  // Both registration loops must finish the full graph before any synchronous
  // TEAMMATE_STARTED_EVENT emit, so a listener re-entering admission sees the
  // complete live tally and cannot pass the budget against a partial count.
  const rootRegister = source.match(
    /if \(isMultiTask\) \{\s*\n\s*normalizedTasks\.forEach\(\(task, index\) => \{\s*\n[\s\S]*?state\.activeRuns\.set\(childId, childAgent\);\s*\n\s*if \(task\.name\) bindAgentName\(state, task\.name, childId\);\s*\n\s*\}\);\s*\n\s*\/\/ Register the whole graph before emitting any started event/,
  );
  assert.ok(rootRegister, "root graph registration must be separated from started-event emission");

  const proxyRegister = source.match(
    /normalizedTasks\?\.forEach\(\(task, index\) => \{\s*\n[\s\S]*?state\.activeRuns\.set\(childId, childAgent\);\s*\n\s*if \(task\.name\) bindAgentName\(state, task\.name, childId\);\s*\n\s*\}\);\s*\n\s*\/\/ Same P4 ordering/,
  );
  assert.ok(proxyRegister, "proxy graph registration must be separated from started-event emission");

  // The proxy must not expose an external onChildStatus callback before the
  // whole graph is registered either.
  const statusAfter = source.match(
    /\/\/ After the whole graph is registered: an onChildStatus callback can\s*\n\s*\/\/ synchronously trigger further dispatches[\s\S]*?reportChildStatus\("running"\);/,
  );
  assert.ok(statusAfter, "proxy onChildStatus must fire after full registration");
});

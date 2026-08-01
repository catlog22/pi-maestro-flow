import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { handleProxyRequest, checkActiveAgentBudget } from "../src/extension/index.ts";
import { appendTeammateDepthContext } from "../src/extension/teammate-core.ts";
import { parseProxyTeammateParams } from "../src/extension/teammate-proxy.ts";
import {
  checkDepthGuard,
  MAX_DEFAULT_DEPTH,
  rootChildMaxDispatchDepth,
  nestedChildMaxDispatchDepth,
  dispatchAllowed,
  agentDispatchBudget,
} from "../src/runs/execution.ts";
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
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8");

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

// ---------------------------------------------------------------------------
// Per-dispatch nesting budget (maxNestingDepth)
// ---------------------------------------------------------------------------

test("root dispatch budgets: 0 forbids nesting, default keeps the global ceiling", () => {
  assert.equal(rootChildMaxDispatchDepth(), MAX_DEFAULT_DEPTH - 1);
  assert.equal(rootChildMaxDispatchDepth(0), 0);
  assert.equal(rootChildMaxDispatchDepth(1), 1);
  assert.equal(rootChildMaxDispatchDepth(MAX_DEFAULT_DEPTH), MAX_DEFAULT_DEPTH - 1);
  assert.equal(rootChildMaxDispatchDepth(99), MAX_DEFAULT_DEPTH - 1);
});

test("nested budgets shrink along the chain and never exceed the parent's", () => {
  // Default parent budget at the first nesting level leaves no room below.
  assert.equal(nestedChildMaxDispatchDepth(1, 1), 0);
  assert.equal(nestedChildMaxDispatchDepth(1, 1, 1), 0);
  assert.equal(nestedChildMaxDispatchDepth(1, 1, 0), 0);
  // A larger parent budget passes through, clamped by the global ceiling.
  assert.equal(nestedChildMaxDispatchDepth(2, 1, 2), 1);
  assert.equal(nestedChildMaxDispatchDepth(2, 1, 1), 1);
  // Exhausted budgets stay at the floor even when the call re-grants.
  assert.equal(nestedChildMaxDispatchDepth(0, 1, 2), 0);
});

test("dispatchAllowed respects both the parent budget and the global ceiling", () => {
  assert.equal(dispatchAllowed(1, 0), true);
  assert.equal(dispatchAllowed(1, 1), true);
  assert.equal(dispatchAllowed(1, 2), false);
  assert.equal(dispatchAllowed(0, 1), false);
  // The global ceiling caps oversized budgets the same way checkDepthGuard does.
  assert.equal(dispatchAllowed(99, MAX_DEFAULT_DEPTH), false);
});

test("legacy agent records fall back to the global ceiling budget", () => {
  assert.equal(agentDispatchBudget({}), MAX_DEFAULT_DEPTH - 1);
  assert.equal(agentDispatchBudget({ maxDispatchDepth: 0 }), 0);
});

test("a proxied dispatch from a maxNestingDepth-0 parent is rejected as disabled", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, 0, { maxDispatchDepth: 0 }));

  const reply = await dispatchNested(state, parentCid);
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /maxNestingDepth: 0/i);
  assert.doesNotMatch(result.content[0].text, /nesting depth exceeded/i);
  assert.equal(state.activeRuns.size, 1, "a rejected dispatch must not register an agent");
});

test("a budget-0 parent at the ceiling still reports the nesting prohibition", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, MAX_DEFAULT_DEPTH - 1, { maxDispatchDepth: 0 }));

  const reply = await dispatchNested(state, parentCid);
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /maxNestingDepth: 0/i);
});

test("a legacy ceiling parent keeps the original depth-exceeded message", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, MAX_DEFAULT_DEPTH - 1));

  const reply = await dispatchNested(state, parentCid);
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nesting depth exceeded/i);
  assert.doesNotMatch(result.content[0].text, /maxNestingDepth/i);
});

test("a parent with budget 1 at depth 0 is not rejected by the budget", async () => {
  const state = makeState();
  const parentCid = randomUUID();
  state.activeRuns.set(parentCid, makeAgent(parentCid, 0, { maxDispatchDepth: 1 }));

  const reply = await dispatchNested(state, parentCid);
  const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
  // The stub environment may fail the dispatch for unrelated reasons (agent
  // resolution), but never with a budget message.
  if (result.isError) {
    assert.doesNotMatch(result.content[0].text, /nesting depth exceeded|maxNestingDepth: 0/i);
  }
});

test("proxy parameter parsing carries maxNestingDepth through", () => {
  assert.equal(parseProxyTeammateParams({ tasks: [{ prompt: "noop" }], maxNestingDepth: 0 })?.maxNestingDepth, 0);
  assert.equal(parseProxyTeammateParams({ tasks: [{ prompt: "noop" }], maxNestingDepth: 2 })?.maxNestingDepth, 2);
});

test("out-of-range maxNestingDepth is rejected with the unified normalization message", async () => {
  // Range validation lives only in normalizeTeammateParams (coding-009): the
  // proxy path must surface the same message as the root path.
  for (const value of [3, -1]) {
    const state = makeState();
    const parentCid = randomUUID();
    state.activeRuns.set(parentCid, makeAgent(parentCid, 0));

    const reply = await dispatchNested(state, parentCid, undefined, {
      tasks: [{ agent: "worker", prompt: "noop" }],
      maxNestingDepth: value,
    });
    const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /maxNestingDepth must be an integer between 0 and 2/);
    assert.equal(state.activeRuns.size, 1, "rejection must happen before agent registration");
  }
});

test("depth context prompt reports a disabled nesting budget explicitly", () => {
  const disabled = appendTeammateDepthContext("base", 1, 0);
  assert.match(disabled, /maxNestingDepth: 0/i);
  assert.match(disabled, /intentionally unavailable/i);

  // Legacy signature keeps the previous remaining-depth semantics.
  const main = appendTeammateDepthContext("base", 0);
  assert.match(main, /Remaining teammate depth: 2/);
  assert.match(main, /delegate through the teammate tool for 2 more levels/);
  const firstLevel = appendTeammateDepthContext("base", 1);
  assert.match(firstLevel, /Remaining teammate depth: 1/);
  const terminal = appendTeammateDepthContext("base", 2);
  assert.match(terminal, /terminal teammate level/i);
  assert.doesNotMatch(terminal, /maxNestingDepth: 0/i);
});

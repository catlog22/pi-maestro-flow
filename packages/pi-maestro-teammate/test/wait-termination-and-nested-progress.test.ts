import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  waitForTeammate,
  hasTeammateWidgetWork,
  TEAMMATE_STALL_TIMEOUT_MS,
  TEAMMATE_PENDING_STALL_TIMEOUT_MS,
  TEAMMATE_WAIT_POLL_FLOOR_MS,
  TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS,
} from "../src/extension/index.ts";
import type { ActiveAgent, AgentStatus, TeammateState, TeammateInteractionRecord } from "../src/shared/types.ts";

function makeState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
}

function addAgent(
  state: TeammateState,
  name: string,
  status: AgentStatus,
  idleMs: number,
  overrides: Partial<ActiveAgent> = {},
): ActiveAgent {
  const cid = randomUUID();
  const now = Date.now();
  const agent: ActiveAgent = {
    agent: "worker",
    name,
    correlationId: cid,
    startedAt: now - idleMs,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now - idleMs,
    depth: 0,
    status,
    sleepMs: 0,
    ...overrides,
  };
  state.activeRuns.set(cid, agent);
  state.namedAgents.set(name, cid);
  return agent;
}

/** Counts timer scheduling so a busy-poll regression fails loudly. */
async function withTimerCount<T>(run: () => Promise<T>): Promise<{ result: T; scheduled: number }> {
  const original = globalThis.setTimeout;
  let scheduled = 0;
  const countedSetTimeout: typeof setTimeout = Object.assign(
    (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
      scheduled += 1;
      return original(...args);
    },
    { __promisify__: original.__promisify__ },
  );
  globalThis.setTimeout = countedSetTimeout;
  try {
    return { result: await run(), scheduled };
  } finally {
    globalThis.setTimeout = original;
  }
}

test("a long-idle pending graph task terminates the wait instead of polling forever", async () => {
  // `pending` tasks stop refreshing lastActivityAt while queued. A stall check
  // scoped to `running` left them with no terminating condition, and the
  // already-elapsed deadline clamped the re-poll delay to 1ms.
  const state = makeState();
  addAgent(state, "queued", "pending", TEAMMATE_PENDING_STALL_TIMEOUT_MS + 1_000);

  const { result, scheduled } = await withTimerCount(() =>
    waitForTeammate(state, { name: "queued" }),
  );

  assert.equal(result.status, "stalled");
  assert.ok(scheduled <= 2, `expected the fast path, saw ${scheduled} timers scheduled`);
});

test("a pending task inside its grace window is not yet called stalled", async () => {
  const state = makeState();
  addAgent(state, "queued", "pending", TEAMMATE_STALL_TIMEOUT_MS + 1_000);

  // Past the running-agent ceiling but well inside the queued-work ceiling:
  // waiting on a dependency is expected, so it must not resolve immediately.
  const result = await waitForTeammate(state, { name: "queued", timeoutMs: 120 });
  assert.equal(result.status, "timeout");
});

test("a retrying agent that stopped reporting is treated as stalled", async () => {
  const state = makeState();
  addAgent(state, "flaky", "retrying", TEAMMATE_STALL_TIMEOUT_MS + 1_000);

  const result = await waitForTeammate(state, { name: "flaky" });
  assert.equal(result.status, "stalled");
});

test("an active retry deadline prevents a healthy backoff from being called stalled", async () => {
  const state = makeState();
  const now = Date.now();
  addAgent(state, "backoff", "retrying", TEAMMATE_STALL_TIMEOUT_MS + 1_000, {
    retry: {
      attempt: 10,
      maxRetries: 10,
      nextRetryAt: now + 1_000,
      lastError: "Provider returned error: 503",
    },
  });

  assert.equal(hasTeammateWidgetWork(state, now), true);
  const result = await waitForTeammate(state, { name: "backoff", timeoutMs: 50 });
  assert.equal(result.status, "timeout");
});

test("an agent awaiting a relayed permission is never reported as stalled", async () => {
  const state = makeState();
  const pendingInteractions = new Map<string, TeammateInteractionRecord>([
    ["req-1", {
      requestId: "req-1",
      interaction: "permission",
      createdAt: Date.now() - 90_000,
      payload: { toolName: "bash" },
    }],
  ]);
  addAgent(state, "asker", "running", TEAMMATE_STALL_TIMEOUT_MS + 60_000, { pendingInteractions });

  // Blocked on a human, not stopped reporting. Calling it stalled told the
  // model to terminate a healthy agent.
  const result = await waitForTeammate(state, { name: "asker", timeoutMs: 120 });
  assert.equal(result.status, "timeout");
});

test("an omitted timeoutMs still yields a bounded wait", async () => {
  assert.ok(TEAMMATE_WAIT_DEFAULT_TIMEOUT_MS > 0);
  assert.ok(TEAMMATE_WAIT_POLL_FLOOR_MS >= 100, "the re-poll floor must exclude busy looping");

  const state = makeState();
  addAgent(state, "fresh", "running", 0);

  // Resolves via the stall ceiling rather than hanging for the session.
  const started = Date.now();
  const result = await waitForTeammate(state, { name: "fresh", timeoutMs: 100 });
  assert.equal(result.status, "timeout");
  assert.ok(Date.now() - started >= 90);
});

test("waiting on a settled agent short-circuits without scheduling a timer", async () => {
  const state = makeState();
  addAgent(state, "done", "sleeping", 0);

  const { result, scheduled } = await withTimerCount(() =>
    waitForTeammate(state, { name: "done" }),
  );
  assert.equal(result.status, "completed");
  assert.equal(scheduled, 0);
});

test("until=completed does not settle on result-ready, only on terminal state", async () => {
  const state = makeState();
  const now = Date.now();
  addAgent(state, "worker-c", "running", 100, {
    resultReadyAt: now, // result is ready but agent keeps running
  });

  // result-ready present: default waiter settles immediately
  const defaultResult = await waitForTeammate(state, { name: "worker-c", timeoutMs: 60 });
  assert.equal(defaultResult.status, "result-ready");

  // until=completed must NOT settle on result-ready; it times out instead
  const completedWait = waitForTeammate(state, { name: "worker-c", timeoutMs: 80, until: "completed" });
  // Transition the agent to sleeping (terminal) mid-wait
  setTimeout(() => {
    const agent = [...state.activeRuns.values()].find((a) => a.name === "worker-c");
    if (agent) agent.status = "sleeping";
  }, 20);
  const completedResult = await completedWait;
  assert.equal(completedResult.status, "completed");
});

test("until=completed on an already-settled agent returns its terminal status", async () => {
  const state = makeState();
  addAgent(state, "worker-done", "sleeping", 1_000);

  const result = await waitForTeammate(state, { name: "worker-done", until: "completed" });
  assert.equal(result.status, "completed");
});

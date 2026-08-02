import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  sweepStalledAgents,
  teammateWaiters,
  statusForWatchTarget,
  watchTargetStalledAt,
  TEAMMATE_STALL_NOTIFY_IDLE_MS,
  TEAMMATE_STALL_TIMEOUT_MS,
  TEAMMATE_PENDING_STALL_TIMEOUT_MS,
} from "../src/extension/index.ts";
import type {
  ActiveAgent,
  AgentRetryState,
  TeammateInteractionRecord,
  TeammateState,
} from "../src/shared/types.ts";
import type { PendingTeammateWaiter } from "../src/extension/teammate-helpers.ts";

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
  name: string | undefined,
  overrides: Partial<ActiveAgent> = {},
): ActiveAgent {
  const correlationId = overrides.correlationId ?? randomUUID();
  const now = Date.now();
  const agent: ActiveAgent = {
    agent: "worker",
    ...(name ? { name } : {}),
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    ...overrides,
  };
  state.activeRuns.set(correlationId, agent);
  if (name) state.namedAgents.set(name, correlationId);
  return agent;
}

interface Notification {
  message: string;
  agent: ActiveAgent;
}

function collectNotifications(): { notifications: Notification[]; notify: (message: string, agent: ActiveAgent) => void } {
  const notifications: Notification[] = [];
  return {
    notifications,
    notify: (message, agent) => notifications.push({ message, agent }),
  };
}

// --- Edge-triggering and dedup ---------------------------------------------

test("a background agent silent past the notification window is notified once", () => {
  const state = makeState();
  const agent = addAgent(state, "quiet", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 10_000,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].agent, agent);
  assert.match(notifications[0].message, /idle 70s/);
  assert.match(notifications[0].message, /"quiet"/);

  // Edge-triggered: a second sweep on the same episode must not re-notify.
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1, "one-shot per stall episode");
});

test("a background agent inside the notification window is not notified", () => {
  const state = makeState();
  addAgent(state, "fresh", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS + 1_000,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0);
});

test("a foreground agent (no notifyOnStall) is never push-notified", () => {
  const state = makeState();
  addAgent(state, "fg", { lastActivityAt: Date.now() - 10 * 60_000 });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0);
});

// --- Episode lifecycle ------------------------------------------------------

test("resuming activity clears the marker so a later stall episode notifies again", () => {
  const state = makeState();
  const agent = addAgent(state, "flaky", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 10_000,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1);

  // Activity resumes: lastActivityAt refreshes, the episode ends.
  agent.lastActivityAt = Date.now();
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1, "no notification for the healthy moment");

  // A new silent spell is a fresh episode and may notify again.
  agent.lastActivityAt = Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 20_000;
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 2);
});

test("a settled agent clears the marker and never notifies", () => {
  const state = makeState();
  const agent = addAgent(state, "done", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 10_000,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1);

  agent.status = "completed";
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1, "terminal is not a stall");
  assert.equal(state.stallNotified?.has(agent.correlationId), false, "marker cleared on terminal");
});

// --- Active waiter ----------------------------------------------------------

function registerFakeWaiter(state: TeammateState, correlationId: string): void {
  const waiter: PendingTeammateWaiter = {
    resolve: () => undefined,
    until: "result-ready",
  };
  const byAgent = teammateWaiters.get(state) ?? new Map<string, Set<PendingTeammateWaiter>>();
  const waiters = byAgent.get(correlationId) ?? new Set<PendingTeammateWaiter>();
  waiters.add(waiter);
  byAgent.set(correlationId, waiters);
  teammateWaiters.set(state, byAgent);
}

test("an agent with an active waiter is skipped: the wait already reports the stall", () => {
  const state = makeState();
  const agent = addAgent(state, "waited", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 10_000,
  });
  registerFakeWaiter(state, agent.correlationId);
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0, "wait path covers the blocked caller");
  assert.equal(state.stallNotified?.has(agent.correlationId), false);

  // Once the wait is over, a stall episode may notify again.
  const byAgent = teammateWaiters.get(state)!;
  byAgent.delete(agent.correlationId);
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1);
});

// --- Canonical exemptions are shared with the wait path ---------------------

test("an agent blocked on a pending interaction is never reported stalled", () => {
  const state = makeState();
  const pendingInteractions = new Map<string, TeammateInteractionRecord>([
    ["r1", { requestId: "r1", interaction: "permission", createdAt: Date.now(), payload: {} }],
  ]);
  addAgent(state, "asker", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 60_000,
    pendingInteractions,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0, "waiting on a human is not a stall");
});

test("an agent holding a consumable result is never reported stalled", () => {
  const state = makeState();
  const agent = addAgent(state, "ready", {
    notifyOnStall: true,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 60_000,
    resultReadyAt: Date.now() - 1_000,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0, "the result is consumable via the wait path");
  assert.equal(
    state.resultReadyNotified?.has(agent.correlationId),
    undefined,
    "the sweep must not consume the one-shot result-ready notice a later waiter is entitled to",
  );
});

test("a retrying agent inside its retry window is not reported stalled", () => {
  const state = makeState();
  const retry: AgentRetryState = {
    attempt: 1,
    maxRetries: 3,
    nextRetryAt: Date.now() + 30_000,
    lastError: "rate limit",
  };
  addAgent(state, "retryer", {
    notifyOnStall: true,
    status: "retrying",
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 60_000,
    retry,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0, "a scheduled retry is expected silence");
});

// --- Pending ceiling --------------------------------------------------------

test("a pending agent notifies only after the 5-minute pending ceiling", () => {
  const state = makeState();
  const { notifications, notify } = collectNotifications();

  addAgent(state, "queued", {
    notifyOnStall: true,
    status: "pending",
    lastActivityAt: Date.now() - TEAMMATE_PENDING_STALL_TIMEOUT_MS + 5_000,
  });
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 0, "queued work is expected to wait");

  addAgent(state, "queued-long", {
    notifyOnStall: true,
    status: "pending",
    lastActivityAt: Date.now() - TEAMMATE_PENDING_STALL_TIMEOUT_MS - 5_000,
  });
  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1, "queued work must not wait without a ceiling");
});

// --- Nested dispatch --------------------------------------------------------

test("a nested child that stalls notifies the caller with nested mode context", () => {
  const state = makeState();
  const child = addAgent(state, "leaf", {
    notifyOnStall: true,
    spawnedBy: "parent-cid",
    depth: 1,
    lastActivityAt: Date.now() - TEAMMATE_STALL_NOTIFY_IDLE_MS - 10_000,
  });
  const { notifications, notify } = collectNotifications();

  sweepStalledAgents(state, notify);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].agent, child);
});

// --- Threshold override is single-source, wait path unchanged ----------------

test("watchTargetStalledAt applies the override to running agents only", () => {
  const state = makeState();
  const now = Date.now();
  const running = addAgent(state, "run", {
    notifyOnStall: true,
    lastActivityAt: now - 40_000,
  });
  const pending = addAgent(state, "pend", {
    notifyOnStall: true,
    status: "pending",
    lastActivityAt: now - 40_000,
  });

  const target = (agent: ActiveAgent) => ({ kind: "agent" as const, agent });

  // Default wait-path threshold still resolves at 30s.
  assert.equal(statusForWatchTarget(target(running), now, state), "stalled");
  // The push channel's longer window does not.
  assert.equal(statusForWatchTarget(target(running), now, state, TEAMMATE_STALL_NOTIFY_IDLE_MS), undefined);
  // The override must not shorten the pending ceiling: 40s is inside 5min.
  assert.equal(statusForWatchTarget(target(pending), now, state, TEAMMATE_STALL_NOTIFY_IDLE_MS), undefined);
  // Pending still resolves after its own ceiling, override or not.
  const pendingOld = addAgent(state, "pend-old", {
    notifyOnStall: true,
    status: "pending",
    lastActivityAt: now - TEAMMATE_PENDING_STALL_TIMEOUT_MS - 1_000,
  });
  assert.equal(statusForWatchTarget(target(pendingOld), now, state, TEAMMATE_STALL_NOTIFY_IDLE_MS), "stalled");

  // watchTargetStalledAt honors the override directly (fresh agent, no idle offset).
  const fresh = addAgent(state, "fresh", {
    notifyOnStall: true,
    lastActivityAt: now,
  });
  assert.equal(
    watchTargetStalledAt(target(fresh), state, TEAMMATE_STALL_NOTIFY_IDLE_MS) - now,
    TEAMMATE_STALL_NOTIFY_IDLE_MS,
  );
  assert.equal(watchTargetStalledAt(target(fresh), state) - now, TEAMMATE_STALL_TIMEOUT_MS);
});

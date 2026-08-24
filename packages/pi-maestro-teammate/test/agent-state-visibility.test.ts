import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  buildAgentList,
  bindAgentName,
  enforceWakeableAgentBudget,
  findSettledAgent,
  handleProxyRequest,
  hasTeammateWidgetWork,
  killAgent,
  renderAgentSelectorPanel,
  renderAgentStatusWidget,
  recordSettledAgent,
  reclaimResultReadyAgents,
  settleAgent,
  statusForWatchTarget,
  sweepFailedAgents,
  FAILED_AGENT_RETENTION_MS,
  RESULT_READY_RECLAIM_MS,
  waitForTeammate,
  SETTLED_AGENT_MEMO_LIMIT,
  TEAMMATE_STALL_TIMEOUT_MS,
  WAKEABLE_AGENT_BUDGET,
} from "../src/extension/index.ts";
import { TEAMMATE_COMPLETE_EVENT } from "../src/shared/types.ts";
import type { ActiveAgent, TeammateInteractionRecord, TeammateState } from "../src/shared/types.ts";

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

// --- OBS-4: the list text is the model's only view of liveness -------------

test("a silent agent is labelled stalled in the text the model reads", () => {
  const state = makeState();
  addAgent(state, "quiet", { lastActivityAt: Date.now() - TEAMMATE_STALL_TIMEOUT_MS - 5_000 });

  const { text } = buildAgentList(state, "active");
  assert.match(text, /STALLED idle \d+s/);
});

test("a freshly active agent carries no idle noise", () => {
  const state = makeState();
  addAgent(state, "busy", { lastActivityAt: Date.now() });

  const { text } = buildAgentList(state, "active");
  assert.doesNotMatch(text, /STALLED/);
  assert.doesNotMatch(text, /idle \d+s/);
});

test("an agent holding a consumable result is never called stalled", () => {
  const state = makeState();
  addAgent(state, "ready", {
    lastActivityAt: Date.now() - TEAMMATE_STALL_TIMEOUT_MS - 60_000,
    resultReadyAt: Date.now() - 1_000,
  });

  const { entries, text } = buildAgentList(state, "active");
  assert.equal(entries[0].resultReadyAt !== undefined, true);
  assert.match(text, /result ready/);
  assert.doesNotMatch(text, /STALLED/);
});

// --- OBS-2: pendingInteractions was recorded and never shown ---------------

test("an agent blocked on a prompt says so instead of looking stalled", () => {
  const state = makeState();
  const pendingInteractions = new Map<string, TeammateInteractionRecord>([
    ["r1", { requestId: "r1", interaction: "permission", createdAt: Date.now(), payload: {} }],
    ["r2", { requestId: "r2", interaction: "question", createdAt: Date.now(), payload: {} }],
  ]);
  addAgent(state, "asker", {
    lastActivityAt: Date.now() - TEAMMATE_STALL_TIMEOUT_MS - 60_000,
    pendingInteractions,
  });

  const { entries, text } = buildAgentList(state, "active");
  assert.equal(entries[0].pendingInteractions, 2);
  assert.match(text, /awaiting 2 prompts/);
  assert.doesNotMatch(text, /STALLED/, "waiting on a human is not a stall");
});

test("a single pending prompt reads in the singular", () => {
  const state = makeState();
  addAgent(state, "asker", {
    pendingInteractions: new Map([
      ["r1", { requestId: "r1", interaction: "permission", createdAt: Date.now(), payload: {} }],
    ]),
  });

  assert.match(buildAgentList(state, "active").text, /awaiting 1 prompt(?!s)/);
});

// --- OBS-5: a settled agent must stay distinguishable from a typo ----------

test("waiting on an agent that already failed reports the failure, not not-found", async () => {
  const state = makeState();
  addAgent(state, "doomed");
  const cid = state.namedAgents.get("doomed")!;
  settleAgent(state, cid, 1, "exploded during step 3");

  // While the tombstone is shown, the failure is reported from live state.
  const shown = await waitForTeammate(state, { name: "doomed" });
  assert.equal(shown.status, "failed");

  // ...and after the retention sweep it is still not mistaken for a typo.
  sweepFailedAgents(state, Date.now() + FAILED_AGENT_RETENTION_MS + 1);
  assert.equal(state.activeRuns.size, 0);

  const result = await waitForTeammate(state, { name: "doomed" });
  assert.equal(result.status, "failed");
  assert.match(result.output.join("\n"), /already failed \d+s ago/);
});

test("an agent that never existed still reports not-found", async () => {
  const state = makeState();
  const result = await waitForTeammate(state, { name: "never-dispatched" });
  assert.equal(result.status, "not-found");
});

test("settled agents are recallable by name and by id prefix", () => {
  const state = makeState();
  const agent = addAgent(state, "scout", { lastResult: "found it" });
  recordSettledAgent(state, agent, "completed");

  assert.equal(findSettledAgent(state, "scout")?.status, "completed");
  assert.equal(findSettledAgent(state, "@scout")?.lastResult, "found it");
  assert.equal(findSettledAgent(state, agent.correlationId.slice(0, 8))?.name, "scout");
  assert.equal(findSettledAgent(state, "someone-else"), undefined);
});

test("settled agents retain work and transcript recovery detail", () => {
  const state = makeState();
  const agent = addAgent(state, "scout", {
    task: "Inspect the auth flow",
    sessionFile: "C:/sessions/scout.jsonl",
    outputLog: ["[00:00:01] ~ read", "assistant detail"],
  });
  recordSettledAgent(state, agent, "completed");

  const settled = findSettledAgent(state, "scout");
  assert.equal(settled?.task, "Inspect the auth flow");
  assert.equal(settled?.sessionFile, "C:/sessions/scout.jsonl");
  assert.deepEqual(settled?.outputLog, ["[00:00:01] ~ read", "assistant detail"]);
  agent.outputLog.push("late mutation");
  assert.equal(settled?.outputLog?.includes("late mutation"), false);
});

test("the settled memo is bounded and drops the oldest first", () => {
  const state = makeState();
  const first = addAgent(state, "first");
  recordSettledAgent(state, first, "failed");

  for (let i = 0; i < SETTLED_AGENT_MEMO_LIMIT; i += 1) {
    recordSettledAgent(state, addAgent(state, `filler-${i}`), "completed");
  }

  assert.equal(state.recentlySettled?.size, SETTLED_AGENT_MEMO_LIMIT);
  assert.equal(findSettledAgent(state, first.correlationId), undefined);
  assert.equal(findSettledAgent(state, "filler-0")?.status, "completed");
});

// --- ISS-20260726-008: the widget's failure display was unreachable --------

const plainTheme = {
  fg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
} as never;

test("a failed agent reaches the widget instead of vanishing with the event", () => {
  const state = makeState();
  addAgent(state, "broken", { status: "failed", failedAt: Date.now() });

  const lines = renderAgentStatusWidget([...state.activeRuns.values()], 80, plainTheme).join("\n");
  assert.match(lines, /✗/, "the failure marker must render");
  assert.match(lines, /1 failed/);
  assert.match(lines, /broken/);
});

test("a failed row is pinned past the visible limit", () => {
  // The anchor exists so the one run that needs attention is never the row
  // that got truncated away.
  const state = makeState();
  for (let i = 0; i < 10; i += 1) addAgent(state, `worker-${i}`);
  const failedAt = Date.now() - 60_000;
  addAgent(state, "broken", {
    status: "failed",
    failedAt,
    lastActivityAt: failedAt,
  });

  const lines = renderAgentStatusWidget([...state.activeRuns.values()], 80, plainTheme).join("\n");
  assert.match(lines, /broken/, "the failed row outranks the running ones");
  assert.match(lines, /more/, "and the truncation notice still appears");
});

test("a failed agent keeps the widget alive until it is swept", () => {
  const state = makeState();
  addAgent(state, "broken", { status: "failed", failedAt: Date.now() });

  assert.equal(hasTeammateWidgetWork(state), true);
  assert.equal(
    hasTeammateWidgetWork(state, Date.now() + FAILED_AGENT_RETENTION_MS + 1),
    false,
    "and stops being work once its window closes",
  );
});

// --- REL-4: a published result that never confirms its lifecycle -----------

test("an agent stuck running with a published result is eventually retired", () => {
  const state = makeState();
  const cid = addAgent(state, "orphan", {
    resultReadyAt: Date.now() - RESULT_READY_RECLAIM_MS - 1_000,
    lastResult: "the answer",
  }).correlationId;

  assert.deepEqual(reclaimResultReadyAgents(state), [cid]);
  assert.equal(state.activeRuns.get(cid)?.status, "sleeping", "retired, not killed — its result is still usable");
  assert.equal(state.activeRuns.get(cid)?.lastResult, "the answer");
});

test("retiring a reclaimed agent publishes a complete event so cockpit rows converge", () => {
  const state = makeState();
  const startedAt = Date.now();
  const cid = addAgent(state, "orphan", {
    startedAt,
    resultReadyAt: startedAt + 1_000,
    lastResult: "the answer",
  }).correlationId;
  const events: Array<{ channel: string; payload: unknown }> = [];
  const pi = {
    events: {
      emit(channel: string, payload: unknown) {
        events.push({ channel, payload });
      },
    },
  } as never;

  assert.deepEqual(reclaimResultReadyAgents(state, pi, startedAt + RESULT_READY_RECLAIM_MS + 1_000), [cid]);
  const complete = events.find((e) => e.channel === TEAMMATE_COMPLETE_EVENT);
  assert.ok(complete, "a reclaim must publish TEAMMATE_COMPLETE_EVENT");
  const payload = complete.payload as Record<string, unknown>;
  assert.equal(payload.correlationId, cid);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.wakeable, true, "wakeable=true keeps the row visible as sleeping in the cockpit");
  assert.equal(payload.cancelled, undefined);
});

test("an agent whose result was just published is left alone", () => {
  const state = makeState();
  addAgent(state, "fresh", { resultReadyAt: Date.now() });
  assert.deepEqual(reclaimResultReadyAgents(state), []);

  // ...and one that never published anything is not this mechanism's business.
  const other = makeState();
  addAgent(other, "plain");
  assert.deepEqual(reclaimResultReadyAgents(other), []);
});

// --- REL-8: result-ready is an edge, not a level ---------------------------

test("result-ready is reported once, then the wait waits for the real terminal state", async () => {
  const state = makeState();
  const resultReadyAt = Date.now();
  const agent = addAgent(state, "worker", {
    resultReadyAt,
    lastActivityAt: resultReadyAt - TEAMMATE_STALL_TIMEOUT_MS - 1_000,
  });

  const first = await waitForTeammate(state, { name: "worker" });
  assert.equal(first.status, "result-ready");

  // Waiting again is how a caller asks for the terminal state. Handing back
  // `result-ready` forever meant `completed` was unreachable. The old activity
  // timestamp must not turn the still-valid lifecycle confirmation window into
  // a false stall after that one-shot notice is consumed.
  const second = await waitForTeammate(state, { name: "worker", timeoutMs: 120 });
  assert.equal(second.status, "timeout");

  agent.status = "sleeping";
  assert.equal((await waitForTeammate(state, { name: "worker" })).status, "completed");
});

test("a wakeable agent that failed stays sleeping but projects failed", async () => {
  const state = makeState();
  const now = Date.now();
  addAgent(state, "doomed-sleep", {
    status: "sleeping",
    lastOutcome: { status: "failed", message: "boom", settledAt: now },
    lastResult: "boom",
    sleptAt: now,
  });
  const agent = state.activeRuns.get(state.namedAgents.get("doomed-sleep")!)!;

  assert.equal(statusForWatchTarget({ kind: "agent", agent }, Date.now(), state), "failed");
  const waited = await waitForTeammate(state, { name: "doomed-sleep" });
  assert.equal(waited.status, "failed");
  assert.match(waited.output.join("\n"), /failed/);
});

test("a successful sleeping agent still projects completed", async () => {
  const state = makeState();
  const now = Date.now();
  addAgent(state, "fine-sleep", {
    status: "sleeping",
    lastOutcome: { status: "completed", message: "done", settledAt: now },
    lastResult: "done",
    sleptAt: now,
  });
  const agent = state.activeRuns.get(state.namedAgents.get("fine-sleep")!)!;
  assert.equal(statusForWatchTarget({ kind: "agent", agent }, Date.now(), state), "completed");
});

test("a cleared result-ready re-arms the notice for the next result", async () => {
  const state = makeState();
  const agent = addAgent(state, "worker", { resultReadyAt: Date.now() });
  assert.equal((await waitForTeammate(state, { name: "worker" })).status, "result-ready");

  settleAgent(state, agent.correlationId, 0);
  assert.equal(state.resultReadyNotified?.has(agent.correlationId), false);
});

// --- REL-7: a stolen name used to be silent --------------------------------

test("taking over a live agent's name is recorded on both agents", () => {
  const state = makeState();
  const first = addAgent(state, "reviewer");
  const second = addAgent(state, undefined);
  bindAgentName(state, "reviewer", second.correlationId);

  assert.equal(state.namedAgents.get("reviewer"), second.correlationId, "names stay last-wins");
  assert.match(first.outputLog.join("\n"), /taken over/);
  assert.match(first.outputLog.join("\n"), new RegExp(`reviewer#${first.correlationId.slice(0, 8)}`));
  assert.match(second.outputLog.join("\n"), /already held/);
});

test("a retired agent still owns its name, because it is still wakeable", () => {
  const state = makeState();
  const first = addAgent(state, "reviewer");
  settleAgent(state, first.correlationId, 0);
  assert.equal(first.status, "sleeping");

  const second = addAgent(state, undefined);
  bindAgentName(state, "reviewer", second.correlationId);
  assert.match(second.outputLog.join("\n"), /already held/, "a sleeping agent can still be messaged by name");
});

test("rebinding a name whose holder is gone is not a collision", () => {
  const state = makeState();
  const first = addAgent(state, "reviewer");
  settleAgent(state, first.correlationId, 1);
  sweepFailedAgents(state, Date.now() + FAILED_AGENT_RETENTION_MS + 1);

  const second = addAgent(state, undefined);
  bindAgentName(state, "reviewer", second.correlationId);
  assert.doesNotMatch(second.outputLog.join("\n"), /already held/);
});

test("retiring the previous name holder does not unbind the current holder", () => {
  const state = makeState();
  const first = addAgent(state, "worker");
  const second = addAgent(state, undefined);
  bindAgentName(state, "worker", second.correlationId);
  assert.equal(state.namedAgents.get("worker"), second.correlationId);

  // onChildClosed / session teardown pass the displaced agent's display name
  // into killAgent. That must not wipe @worker off the current holder.
  killAgent(state, first.correlationId, first.name, "completed", false);
  assert.equal(state.namedAgents.get("worker"), second.correlationId);
  assert.equal(state.activeRuns.has(second.correlationId), true);
  assert.equal(state.activeRuns.has(first.correlationId), false);
});

// --- REL-6: a failed cohort member blocked every sibling from retiring -----

test("a failed graph tombstone does not block sleeping sibling eviction", () => {
  const state = makeState();
  const controller = new AbortController();
  const ok = addAgent(state, "task-a", { abortController: controller, status: "sleeping", sleptAt: Date.now() });
  const bad = addAgent(state, "task-b", { abortController: controller, status: "failed", failedAt: Date.now() });

  const evicted = enforceWakeableAgentBudget(
    state,
    Date.now() + WAKEABLE_AGENT_BUDGET.namedTtlMs + 1,
  );
  assert.ok(evicted.includes(ok.correlationId));
  assert.equal(state.activeRuns.has(bad.correlationId), true, "diagnostic tombstone remains visible");

  const now = Date.now() + FAILED_AGENT_RETENTION_MS + 1;
  assert.deepEqual(sweepFailedAgents(state, now), [bad.correlationId]);
});

// --- ARCH-3: nested dispatches never published their lifecycle -------------

test("a nested dispatch publishes the completion event root dispatches publish", async () => {
  // Subscribers use this event to retire the row, stop the widget timer and run
  // the wakeable budget. Nested dispatches never emitted it, so every nested
  // agent stayed on screen as a ghost for the rest of the session.
  const state = makeState();
  const parent = addAgent(state, "parent");
  const events: Array<Record<string, unknown>> = [];
  const spyPi = {
    events: {
      emit(name: string, payload: Record<string, unknown>) {
        if (name === TEAMMATE_COMPLETE_EVENT) events.push(payload);
      },
    },
    sendMessage() {},
  } as never;

  await handleProxyRequest(
    spyPi,
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "req-nested",
      params: { tasks: [{ agent: "worker", prompt: "noop" }], background: false },
    },
    () => {},
    parent.correlationId,
  );

  assert.equal(events.length, 1, "exactly one completion event per nested dispatch");
  assert.equal("id" in events[0], false, "nested IPC requestId is not a tool-call id");
  assert.equal(typeof events[0].correlationId, "string");
  assert.notEqual(events[0].correlationId, parent.correlationId, "the event names the nested agent");
  assert.equal(typeof events[0].durationMs, "number");
});

test("the retrying widget shows attempt and next retry countdown", () => {
  const state = makeState();
  const now = Date.now();
  const retrying = addAgent(state, "flaky", {
    status: "retrying",
    retry: {
      attempt: 10,
      maxRetries: 10,
      nextRetryAt: now + 16_000,
      lastError: "Error: Connection error.",
    },
  });
  const rendered = renderAgentStatusWidget(
    [retrying],
    100,
    { fg: (_name: string, text: string) => text, bold: (text: string) => text },
  ).join("\n");

  assert.match(rendered, /retry 10\/10 in (?:16s|15s)/);
  assert.match(rendered, /retrying/);
});

// --- ARCH-8: retrying read as a healthy green "Running" in the selector ----

test("the Alt+R selector distinguishes retrying from running", () => {
  const rows = (["running", "retrying"] as const).map((status, index) => ({
    correlationId: `cid-${index}`,
    agent: "worker",
    label: `w${index}`,
    status,
    startedAt: Date.now(),
    depth: 0,
    treePrefix: "",
    recentTools: [],
  }));

  const panel = renderAgentSelectorPanel(rows, 0, "", 80).join("\n");
  assert.match(panel, /Running · retrying/);
  // Green is reserved for an agent that is actually making progress.
  assert.doesNotMatch(panel, /\x1b\[32mRunning · retrying/);
});

test("a terminal status arriving after the agent settled corrects its history, and only upward", () => {
  const state = makeState();
  const agent = addAgent(state, "retrying");
  const { correlationId } = agent;

  // The run settles first; the caller's cancellation is processed after the
  // agent has already left activeRuns.
  killAgent(state, correlationId, agent.name, "completed", false);
  assert.equal(state.recentlySettled?.get(correlationId)?.status, "completed");
  assert.equal(state.activeRuns.has(correlationId), false);

  // The settled result carries the cancellation, so this history must too —
  // otherwise observe reports a run as completed that its own result reports as
  // terminated.
  killAgent(state, correlationId, agent.name, "terminated", false);
  assert.equal(state.recentlySettled?.get(correlationId)?.status, "terminated");

  // Only upward: a late `completed` is the value used when nothing said
  // otherwise, and letting it overwrite a positive assertion would make the
  // recorded outcome a race between event orderings.
  killAgent(state, correlationId, agent.name, "completed", false);
  assert.equal(state.recentlySettled?.get(correlationId)?.status, "terminated");

  // A run with no settled record is left alone rather than invented.
  killAgent(state, randomUUID(), undefined, "terminated", false);
  assert.equal(state.recentlySettled?.size, 1);
});

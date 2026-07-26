import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createTeammateInteractionQueue,
  TEAMMATE_INTERACTION_QUEUE_LIMIT,
  TEAMMATE_INTERACTION_TIMEOUT_MS,
} from "../src/extension/index.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

const stubPi = { events: { emit() {} }, sendMessage() {} } as never;

function makeState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
}

function addAgent(state: TeammateState, name: string): string {
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
  });
  state.namedAgents.set(name, correlationId);
  return correlationId;
}

/** A ctx whose approval prompt is opened but never answered. */
function unansweredCtx(opened: { count: number }): never {
  return {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      select: () => { opened.count += 1; return new Promise<string>(() => {}); },
      input: () => { opened.count += 1; return new Promise<string>(() => {}); },
    },
  } as never;
}

function permissionEvent(correlationId: string): Record<string, unknown> {
  return {
    type: "teammate_interaction_request",
    requestId: randomUUID(),
    interaction: "permission",
    correlationId,
    payload: { toolName: "bash", input: { command: "ls" } },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Reply = { result?: { action?: string; error?: string } };

test("an unanswered prompt stops holding its own child indefinitely", async () => {
  const state = makeState();
  const cid = addAgent(state, "asker");
  const opened = { count: 0 };
  const queue = createTeammateInteractionQueue(stubPi, state, 60);

  const replies: Reply[] = [];
  queue.enqueue(permissionEvent(cid), (msg) => replies.push(msg as Reply), unansweredCtx(opened), cid);

  assert.equal(queue.pendingCount(), 1);
  await delay(200);

  assert.equal(replies.length, 1);
  assert.equal(replies[0].result?.action, "cancel");
  assert.match(replies[0].result?.error ?? "", /No answer within/);
  assert.equal(queue.pendingCount(), 0);
});

test("a request queued behind an unanswered prompt is still bounded", async () => {
  // The terminal is a single resource, so the second prompt legitimately never
  // opens. What must not happen is its child waiting forever for an answer that
  // is structurally unreachable — that is the nested hang.
  const state = makeState();
  const first = addAgent(state, "first");
  const second = addAgent(state, "second");
  const opened = { count: 0 };
  const ctx = unansweredCtx(opened);
  const queue = createTeammateInteractionQueue(stubPi, state, 60);

  const secondReplies: Reply[] = [];
  queue.enqueue(permissionEvent(first), () => {}, ctx, first);
  queue.enqueue(permissionEvent(second), (msg) => secondReplies.push(msg as Reply), ctx, second);

  await delay(200);

  assert.equal(secondReplies.length, 1, "the queued request must be answered on its child's behalf");
  assert.equal(secondReplies[0].result?.action, "cancel");
  assert.equal(opened.count, 1, "only the front request may seize the terminal");
  assert.equal(queue.pendingCount(), 0);
});

test("killing an agent settles its queued request instead of prompting for it", async () => {
  const state = makeState();
  const first = addAgent(state, "first");
  const doomed = addAgent(state, "doomed");
  const opened = { count: 0 };
  const ctx = unansweredCtx(opened);
  const queue = createTeammateInteractionQueue(stubPi, state, 60_000);

  const doomedReplies: Reply[] = [];
  queue.enqueue(permissionEvent(first), () => {}, ctx, first);
  queue.enqueue(permissionEvent(doomed), (msg) => doomedReplies.push(msg as Reply), ctx, doomed);

  assert.equal(queue.cancelForAgent(doomed, "The teammate was terminated."), 1);

  assert.equal(doomedReplies.length, 1);
  assert.equal(doomedReplies[0].result?.action, "cancel");
  assert.match(doomedReplies[0].result?.error ?? "", /terminated/);
  assert.equal(queue.pendingCount(), 1, "the unrelated request keeps its place");

  await delay(20);
  assert.equal(opened.count, 1, "a killed agent's prompt must never open");
});

test("a settled request is never answered twice", async () => {
  const state = makeState();
  const cid = addAgent(state, "asker");
  const queue = createTeammateInteractionQueue(stubPi, state, 40);

  const replies: Reply[] = [];
  queue.enqueue(permissionEvent(cid), (msg) => replies.push(msg as Reply), unansweredCtx({ count: 0 }), cid);

  await delay(120);
  assert.equal(queue.cancelForAgent(cid, "late cancel"), 0);
  await delay(60);
  assert.equal(replies.length, 1);
});

test("a full queue declines newcomers rather than growing without bound", async () => {
  const state = makeState();
  const cid = addAgent(state, "asker");
  const ctx = unansweredCtx({ count: 0 });
  const queue = createTeammateInteractionQueue(stubPi, state, 60_000);

  for (let i = 0; i < TEAMMATE_INTERACTION_QUEUE_LIMIT; i += 1) {
    queue.enqueue(permissionEvent(cid), () => {}, ctx, cid);
  }
  assert.equal(queue.pendingCount(), TEAMMATE_INTERACTION_QUEUE_LIMIT);

  const overflow: Reply[] = [];
  queue.enqueue(permissionEvent(cid), (msg) => overflow.push(msg as Reply), ctx, cid);

  assert.equal(overflow.length, 1);
  assert.match(overflow[0].result?.error ?? "", /Too many teammate interactions/);
  assert.equal(queue.pendingCount(), TEAMMATE_INTERACTION_QUEUE_LIMIT);
});

function structuredOutputRequest(correlationId: string): Record<string, unknown> {
  return {
    type: "teammate_interaction_request",
    requestId: randomUUID(),
    interaction: "permission",
    correlationId,
    payload: { toolName: "structured_output", input: { path: "out.json" } },
  };
}

test("an auto-approved request settles without consuming the queue", async () => {
  const state = makeState();
  const cid = addAgent(state, "asker");
  state.activeRuns.get(cid)!.expectsStructuredOutput = true;
  const opened = { count: 0 };
  const queue = createTeammateInteractionQueue(stubPi, state, 60_000);

  const replies: Reply[] = [];
  queue.enqueue(structuredOutputRequest(cid), (msg) => replies.push(msg as Reply), unansweredCtx(opened), cid);

  await delay(20);
  assert.equal(replies[0]?.result?.action, "allow_once");
  assert.equal(opened.count, 0);
  assert.equal(queue.pendingCount(), 0, "the queue must release the slot once answered");
});

test("an agent without a schema cannot reach the structured_output grant", async () => {
  // The tool name is whatever the child says it is. The auto-approval exists
  // because a headless child has no UI to approve with — not as a way for any
  // child to skip approval by picking the right name.
  const state = makeState();
  const cid = addAgent(state, "asker");
  const opened = { count: 0 };
  const queue = createTeammateInteractionQueue(stubPi, state, 60);

  const replies: Reply[] = [];
  queue.enqueue(structuredOutputRequest(cid), (msg) => replies.push(msg as Reply), unansweredCtx(opened), cid);

  await delay(200);
  assert.notEqual(replies[0]?.result?.action, "allow_once");
  assert.equal(opened.count, 1, "it goes to the human like any other permission");
});

test("the default interaction ceiling is bounded and generous", () => {
  assert.ok(TEAMMATE_INTERACTION_TIMEOUT_MS > 0);
  assert.ok(TEAMMATE_INTERACTION_TIMEOUT_MS >= 60_000, "a human needs time to read the prompt");
});

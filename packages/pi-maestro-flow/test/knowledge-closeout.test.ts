import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completedKnowledgeSessions, createKnowledgeCloseoutRequester, stagedKnowledgeCloseoutTarget } from "../src/knowledge/closeout.ts";

function harness() {
  const sent: Array<{ message: { content: unknown }; options: unknown }> = [];
  const pi = { sendMessage(message: { content: unknown }, options: unknown) { sent.push({ message, options }); } } as Pick<ExtensionAPI, "sendMessage">;
  let hostSessionId = "pi-chat";
  const sessionManager = { getSessionId: () => hostSessionId } as ExtensionContext["sessionManager"];
  const requester = createKnowledgeCloseoutRequester(pi);
  return { sent, pi, sessionManager, replaceSession: () => hostSessionId = "new-chat",
    request: (ctx: Pick<ExtensionContext, "hasUI">, targets: Parameters<typeof requester>[1]) => requester({ ...ctx, sessionManager }, targets),
  };
}

test("terminal completion selects every Session once, never intermediate Run receipts", () => {
  assert.deepEqual(completedKnowledgeSessions([{ operation: "run-complete-and-seal", sessionId: "s-1" }]), []);
  assert.deepEqual(completedKnowledgeSessions([
    { operation: "session-complete", sessionId: "s-1" },
    { operation: "session-complete", sessionId: "s-2" },
    { operation: "session-complete", sessionId: "s-1" },
  ], "s-1"), ["s-1", "s-2"]);
  assert.deepEqual(completedKnowledgeSessions([], "legacy-session"), ["legacy-session"]);
  assert.deepEqual(completedKnowledgeSessions([{ operation: "session-complete" }], undefined, "canonical-current"), ["canonical-current"]);
  assert.deepEqual(completedKnowledgeSessions([{ operation: "session-complete" }]), []);
  assert.deepEqual(completedKnowledgeSessions([{ operation: "run-complete-and-seal" }], undefined, "canonical-current"), []);
});

test("owner closeout wakes an interactive follow-up for direct Ask, with fixed actions and safety gates", () => {
  const h = harness();
  assert.equal(h.request({ hasUI: true }, [{ sessionId: "s-1", candidateIds: ["KDC-b", "KDC-a"] }]), true);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  const content = String(h.sent[0].message.content);
  assert.match(content, /"candidateIds":\["KDC-a","KDC-b"\]/);
  for (const text of ["knowledge-closeout.md", "ask-user-question", "Ask itself is the human review", "do not ask the human to run CLI review", "publication authorization explicitly together", "generic review consent is not publication approval", "Machine advice/timeouts are not authorization", "retain backlog", "identity/evidence/fresh-receipt gates", "Never auto-promote or use --all"]) {
    assert.ok(content.includes(text), text);
  }
});

test("duplicate completion, deferral and changed pending counts do not re-ask unchanged IDs", () => {
  const h = harness();
  const ctx = { hasUI: true };
  assert.equal(h.request(ctx, [{ sessionId: "s-1", candidateIds: ["a", "b"] }]), true);
  assert.equal(h.request(ctx, [{ sessionId: "s-1", candidateIds: ["b", "a", "a"] }]), false);
  assert.equal(h.request(ctx, [{ sessionId: "s-1", candidateIds: ["a"] }]), false);
  assert.equal(h.request(ctx, [{ sessionId: "s-1", candidateIds: ["a", "b", "c"] }]), true);
  assert.match(String(h.sent[1].message.content), /"candidateIds":\["c"\]/);
  assert.equal(h.request(ctx, [{ sessionId: "s-2", candidateIds: ["a"] }]), true);
});

test("self-evolve and Workflow share deduplication, but a new chat may review retained backlog", () => {
  const h = harness();
  const targets = [{ sessionId: "s-1", candidateIds: ["a"] }];
  assert.equal(h.request({ hasUI: true }, targets), true);
  const workflowRequester = createKnowledgeCloseoutRequester(h.pi);
  assert.equal(workflowRequester({ hasUI: true, sessionManager: h.sessionManager }, targets), false);
  h.replaceSession();
  assert.equal(workflowRequester({ hasUI: true, sessionManager: h.sessionManager }, targets), true);
  assert.equal(h.sent.length, 2);
});

test("empty backlog, workers and non-dialog modes never start a closeout turn", () => {
  const h = harness();
  const target = [{ sessionId: "s-1", candidateIds: ["a"] }];
  assert.equal(h.request({ hasUI: true }, []), false);
  assert.equal(h.request({ hasUI: true }, [{ sessionId: "s-1", candidateIds: [] }]), false);
  assert.equal(h.request({ hasUI: false }, target), false);
  const previous = process.env.PI_TEAMMATE_CHILD;
  try {
    process.env.PI_TEAMMATE_CHILD = "1";
    assert.equal(h.request({ hasUI: true }, target), false);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previous;
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.request({ hasUI: true }, target), true, "a non-dialog read must not consume the interactive request");
});

test("stage receipts use canonical identity, not Pi IDs, and leave Run workers to terminal closeout", () => {
  assert.deepEqual(stagedKnowledgeCloseoutTarget('{"session_id":"ksyn-one","candidate_id":"KDC-one"}'), { sessionId: "ksyn-one", candidateIds: ["KDC-one"] });
  assert.deepEqual(stagedKnowledgeCloseoutTarget('Staged KDC-one on ksyn-one (session source); pending'), { sessionId: "ksyn-one", candidateIds: ["KDC-one"] });
  for (const output of ['{"candidate_id":"KDC-one"}', '{"session_id":"pi-chat"}', '{}', 'not a receipt', '{"session_id":"s-1","run_id":"r-1","candidate_id":"KDC-one"}', 'Staged KDC-one on s-1/r-1']) {
    assert.equal(stagedKnowledgeCloseoutTarget(output), undefined, output);
  }
});

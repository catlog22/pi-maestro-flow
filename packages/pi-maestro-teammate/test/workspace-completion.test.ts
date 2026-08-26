import assert from "node:assert/strict";
import test from "node:test";
import {
  bindWorkspaceCompletionHandle,
  createWorkspaceWindowTerminalResult,
  decodeWorkspaceWindowTerminalResult,
  encodeWorkspaceWindowTerminalResult,
  validateWorkspaceCompletionCorrelation,
  workspaceWindowCompletionHandle,
  workspaceWindowTerminalResultMessageId,
} from "pi-maestro-teammate/v1/workspace-completion";

const MESSAGE_ID = "9".repeat(32);
const OWNER = {
  workspaceId: "f".repeat(64),
  ownerId: "1".repeat(32),
  ownerNonce: "2".repeat(32),
};

test("workspace completion handle is deterministic and binds message, dispatch, owner, and canonical resource", () => {
  const handle = workspaceWindowCompletionHandle(MESSAGE_ID);
  assert.equal(handle.messageId, MESSAGE_ID);
  assert.equal(handle.requestMessageId, MESSAGE_ID);
  assert.equal(handle.dispatchId, MESSAGE_ID);
  assert.equal(handle.correlationId, MESSAGE_ID);
  assert.match(handle.resource, /^agent:\/\/[a-f0-9]{64}$/);

  const correlation = bindWorkspaceCompletionHandle(MESSAGE_ID, OWNER);
  assert.deepEqual(validateWorkspaceCompletionCorrelation(correlation), correlation);
  assert.equal(validateWorkspaceCompletionCorrelation({ ...correlation, dispatchId: "8".repeat(32) }), undefined);
  assert.equal(validateWorkspaceCompletionCorrelation({ ...correlation, owner: { ...OWNER, ownerNonce: "bad" } }), undefined);
});

test("workspace terminal protocol preserves failed, cancelled, and no-result outcomes without treating them as completion", () => {
  const values = [
    createWorkspaceWindowTerminalResult({ requestMessageId: MESSAGE_ID, outcome: "failed", error: "runtime failed", settledAt: 10 }),
    createWorkspaceWindowTerminalResult({ requestMessageId: MESSAGE_ID, outcome: "cancelled", error: "operator cancelled", settledAt: 11 }),
    createWorkspaceWindowTerminalResult({ requestMessageId: MESSAGE_ID, outcome: "no-result", settledAt: 12 }),
  ];
  for (const value of values) {
    assert.deepEqual(decodeWorkspaceWindowTerminalResult(encodeWorkspaceWindowTerminalResult(value)), value);
    assert.equal(value.outcome === "completed", false);
  }
  assert.match(workspaceWindowTerminalResultMessageId(MESSAGE_ID), /^[a-f0-9]{32}$/);
  assert.throws(
    () => createWorkspaceWindowTerminalResult({ requestMessageId: MESSAGE_ID, outcome: "failed" }),
    /validation/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { adaptAcpRuntimeSignalV2, adaptPiRuntimeSignalV2, adaptRemoteRunEventV2 } from "../src/runtime-v2/adapters.ts";
import type { ActorAddressV2 } from "../src/runtime-v2/contracts.ts";
import type { RemoteRunEvent } from "../src/remote/types.ts";

const actor: ActorAddressV2 = {
  version: 2,
  revision: 1,
  workspaceId: "workspace-a",
  actorKind: "remote",
  actorId: "run-a",
  generation: 1,
};
const context = { streamId: "run-a", actor, occurredAt: 10 };

test("Pi adapter emits tool, result, settled, and process-reclaimed events", () => {
  assert.equal(adaptPiRuntimeSignalV2({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, context)[0]?.kind, "tool.started");
  assert.deepEqual(
    adaptPiRuntimeSignalV2({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: true }, context).map((event) => event.kind),
    ["tool.finished"],
  );
  assert.equal(adaptPiRuntimeSignalV2({ type: "result_published", publicationId: "p1" }, context)[0]?.kind, "result.published");
  assert.equal(adaptPiRuntimeSignalV2({ type: "agent_settled", outcome: "completed" }, context)[0]?.kind, "run.settled");
  assert.equal(adaptPiRuntimeSignalV2({ type: "process_reclaimed", processId: "42", exitCode: 0, signal: null }, context)[0]?.kind, "process.reclaimed");
});

test("Pi turn/tool endings and close never infer a completed run", () => {
  assert.deepEqual(adaptPiRuntimeSignalV2({ type: "turn_end" }, context), []);
  assert.deepEqual(adaptPiRuntimeSignalV2({ type: "close" }, context), []);
  const toolEnd = adaptPiRuntimeSignalV2({ type: "tool_end", toolCallId: "t1", toolName: "read" }, context);
  assert.deepEqual(toolEnd.map((event) => event.kind), ["tool.finished"]);
  assert.equal(toolEnd.some((event) => event.kind === "run.settled"), false);
});

test("ACP adapter requires an explicit run_settled signal for terminal outcome", () => {
  assert.deepEqual(adaptAcpRuntimeSignalV2({ type: "turn_end" }, context), []);
  assert.deepEqual(adaptAcpRuntimeSignalV2({ type: "close" }, context), []);
  const toolEnd = adaptAcpRuntimeSignalV2({ type: "tool_end", toolCallId: "t1", toolName: "shell" }, context);
  assert.deepEqual(toolEnd.map((event) => event.kind), ["tool.finished"]);
  assert.equal(adaptAcpRuntimeSignalV2({ type: "run_settled", outcome: "failed", error: "failed" }, context)[0]?.kind, "run.settled");
  assert.equal(adaptAcpRuntimeSignalV2({ type: "process_reclaimed", processId: "9", exitCode: 1, signal: null }, context)[0]?.kind, "process.reclaimed");
});

test("text and token usage stay on the observation plane instead of the broker journal", () => {
  const base = {
    workerId: "worker-a",
    instanceNonce: "nonce-a",
    runId: "run-a",
    generation: 1,
    updatedAt: 10,
  };
  const text = {
    ...base,
    type: "run/event",
    sequence: 1,
    event: { type: "text", text: "streamed token" },
  } satisfies RemoteRunEvent;
  const usage = {
    ...base,
    type: "run/event",
    sequence: 2,
    event: { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } },
  } satisfies RemoteRunEvent;
  assert.deepEqual(adaptRemoteRunEventV2(text, "pi-rpc", { streamId: context.streamId, actor }), []);
  assert.deepEqual(adaptRemoteRunEventV2(usage, "acp", { streamId: context.streamId, actor }), []);
});

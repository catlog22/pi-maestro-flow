import assert from "node:assert/strict";
import test from "node:test";
import { settleAcpRun } from "../src/cli-tools/local-acp.ts";
import type { RemoteRunHandle } from "../src/remote/driver.ts";
import { createRemoteRunSnapshot } from "../src/remote/state.ts";
import type { RemoteRunCancelParams, RemoteRunInputParams } from "../src/remote/protocol.ts";
import type {
  RemoteDriverEvent,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunResultEvent,
  RemoteRunSnapshot,
} from "../src/remote/types.ts";
import type { CliToolConfig } from "../src/cli-tools/cli-tools-config.ts";

const CAPTURE: RemoteRunCapture = {
  workerId: "local-test",
  instanceNonce: "instance-1",
  runId: "run-1",
  generation: 1,
  monitorOwnerNonce: "monitor-1",
  targetId: "cli:mock",
};

const TOOL_CONFIG: CliToolConfig = { enabled: true, command: "mock" };

/** Replays a fixed event list; nothing here reaches a real CLI subprocess. */
class ReplayHandle implements RemoteRunHandle {
  readonly capture = CAPTURE;
  cancelled = false;

  constructor(private readonly events_: readonly RemoteRunEvent[]) {}

  snapshot(): RemoteRunSnapshot {
    return createRemoteRunSnapshot(this.capture, this.cancelled ? "cancelled" : "running");
  }

  async *events(): AsyncGenerator<RemoteRunEvent> {
    for (const event of this.events_) yield event;
  }

  async input(request: RemoteRunInputParams) {
    return { accepted: false, effectiveMode: request.mode, receipt: "queued" as const };
  }

  async cancel(_request: RemoteRunCancelParams) {
    this.cancelled = true;
    return { accepted: true, status: "cancelled" as const };
  }

  async close(): Promise<void> {}
}

let sequence = 0;

function progress(event: RemoteDriverEvent): RemoteRunEvent {
  return { ...CAPTURE, type: "run/event", sequence: ++sequence, event, updatedAt: Date.now() };
}

function tool(toolCallId: string, toolName: string, phase: "start" | "end"): RemoteRunEvent {
  return progress({ type: "tool", tool: { toolCallId, toolName, phase } });
}

/** A lifecycle transition: what the driver emits once the ACP handshake lands. */
function state(status: RemoteRunSnapshot["status"]): RemoteRunEvent {
  return { ...CAPTURE, type: "run/state", sequence: ++sequence, status, updatedAt: Date.now() };
}

function settledEvent(status: RemoteRunResultEvent["status"], result?: string): RemoteRunEvent {
  return {
    ...CAPTURE,
    type: "run/result",
    sequence: ++sequence,
    status,
    updatedAt: Date.now(),
    ...(result === undefined ? {} : { result }),
  };
}

function settle(
  events: readonly RemoteRunEvent[],
  onProgress?: NonNullable<Parameters<typeof settleAcpRun>[1]["onProgress"]>,
) {
  return settleAcpRun(new ReplayHandle(events), {
    tool: "mock",
    config: TOOL_CONFIG,
    prompt: "do the thing",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
}

test("settleAcpRun reports ACP text, tools, and usage as live progress", async () => {
  const updates: Array<Parameters<NonNullable<Parameters<typeof settleAcpRun>[1]["onProgress"]>>[0]> = [];
  await settle([
    state("running"),
    progress({ type: "text", text: "checking repository" }),
    tool("call-1", "bash", "start"),
    progress({ type: "usage", usage: { inputTokens: 10, outputTokens: 4 } }),
    tool("call-1", "bash", "end"),
    settledEvent("completed", "done"),
  ], (update) => updates.push(update));

  assert.ok(updates.some((update) => update.phase === "prompting" && update.lastMessage === "checking repository"));
  assert.ok(updates.some((update) => update.phase === "tool-execution"
    && update.recentTools.some((tool) => tool.name === "bash" && tool.status === "running")));
  assert.ok(updates.some((update) => update.tokens === 14));
  assert.ok(updates.some((update) => update.recentTools.some((tool) => tool.name === "bash" && tool.status === "completed")));
});

test("settleAcpRun isolates a throwing progress observer", async () => {
  const run = await settle([state("running"), settledEvent("completed", "done")], () => {
    throw new Error("observer failed");
  });
  assert.equal(run.status, "completed");
});

test("settleAcpRun counts a tool that reached phase end", async () => {
  const run = await settle([
    tool("call-1", "edit_file", "start"),
    tool("call-1", "edit_file", "end"),
    settledEvent("failed"),
  ]);
  assert.deepEqual([...run.completedTools], ["edit_file"]);
  assert.equal(run.inFlightToolCount, 0);
  assert.equal(run.sawActivity, true);
});

test("settleAcpRun reports a started-but-unfinished tool as in flight", async () => {
  const run = await settle([
    tool("call-1", "edit_file", "start"),
    tool("call-1", "edit_file", "end"),
    tool("call-2", "run_command", "start"),
    settledEvent("failed"),
  ]);
  assert.deepEqual([...run.completedTools], ["edit_file"]);
  assert.equal(run.inFlightToolCount, 1);
});

test("settleAcpRun deduplicates a tool that ends twice", async () => {
  const run = await settle([
    tool("call-1", "edit_file", "start"),
    tool("call-1", "edit_file", "end"),
    tool("call-1", "edit_file", "end"),
    settledEvent("completed", "done"),
  ]);
  assert.deepEqual([...run.completedTools], ["edit_file"]);
  assert.equal(run.inFlightToolCount, 0);
});

test("settleAcpRun returns the protocol result status", async () => {
  const run = await settle([settledEvent("completed", "all done")]);
  assert.equal(run.status, "completed");
  assert.equal(run.result, "all done");
  assert.equal(run.settlementAuthority, "authoritative");
});

test("settleAcpRun reports an exhausted stream as unsettled", async () => {
  const run = await settle([tool("call-1", "edit_file", "start")]);
  assert.equal(run.status, "lost");
  assert.equal(run.settlementAuthority, "unknown");
  assert.equal(run.inFlightToolCount, 1);
});

test("settleAcpRun reports no activity for an empty stream", async () => {
  const run = await settle([]);
  assert.equal(run.sawActivity, false);
  assert.deepEqual([...run.completedTools], []);
  assert.equal(run.inFlightToolCount, 0);
});

test("settleAcpRun does not count a lifecycle state event as activity", async () => {
  // What a CLI that answered `initialize` and `session/new` and then died on a
  // bad flag produces: the handshake's state transition, then a failure. The
  // host reads `sawActivity` to decide whether a fresh attempt would repeat
  // work, so a completed handshake must not count as work.
  const run = await settle([state("running"), settledEvent("failed")]);
  assert.equal(run.sawActivity, false);
  assert.deepEqual([...run.completedTools], []);
  assert.equal(run.inFlightToolCount, 0);
});

test("settleAcpRun pairs tool ids so an end without a start leaves the other tool in flight", async () => {
  // The driver names a `tool_call_update` whose `tool_call` it never saw, so an
  // end can arrive alone. Subtracting set sizes cancels it against the genuinely
  // outstanding call-1 and reports nothing in flight.
  const run = await settle([
    tool("call-1", "edit_file", "start"),
    tool("call-2", "run_command", "end"),
    settledEvent("failed"),
  ]);
  assert.deepEqual([...run.completedTools], ["run_command"]);
  assert.equal(run.inFlightToolCount, 1);
});

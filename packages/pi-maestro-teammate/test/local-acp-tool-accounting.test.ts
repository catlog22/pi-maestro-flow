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

function settle(events: readonly RemoteRunEvent[]) {
  return settleAcpRun(new ReplayHandle(events), {
    tool: "mock",
    config: TOOL_CONFIG,
    prompt: "do the thing",
    cwd: process.cwd(),
    signal: new AbortController().signal,
  });
}

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

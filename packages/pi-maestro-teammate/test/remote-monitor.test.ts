import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteConfig } from "../src/remote/config.ts";
import type { RemoteRunCancelResult, RemoteRunInputResult } from "../src/remote/protocol.ts";
import type { RemoteRunCapture, RemoteRunSnapshot } from "../src/remote/types.ts";
import type { RemoteWorkerStartRequest, RemoteWorkerWaitOptions } from "../src/remote/worker-manager.ts";
import {
  RemoteMonitorSession,
  type RemoteWorkerManagerLike,
} from "../src/extension/remote-monitor.ts";
import type { RemoteHistoryEntry } from "../src/sessions/remote-history.ts";

const config: RemoteConfig = {
  version: 2,
  hosts: {
    linux: {
      host: "worker.example.test",
      user: "worker",
      port: 22,
      hostKeySha256: `SHA256:${"a".repeat(32)}`,
    },
  },
  targets: {
    "linux/pi": {
      host: "linux",
      cwd: "/srv/project",
      driver: "pi-rpc",
      command: ["pi"],
    },
  },
};

function snapshot(capture: RemoteRunCapture, status: RemoteRunSnapshot["status"] = "running", sequence = 0): RemoteRunSnapshot {
  return {
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    targetId: capture.targetId,
    status,
    lastSequence: sequence,
    updatedAt: 1_000 + sequence,
  };
}

class FakeManager implements RemoteWorkerManagerLike {
  readonly monitorOwnerNonce = "monitor-owner";
  readonly captures: RemoteRunCapture[] = [];
  readonly state = new Map<string, RemoteRunSnapshot>();
  readonly sent: Array<{ mode: string; capture: RemoteRunCapture; message: string }> = [];
  readonly cancelled: RemoteRunCapture[] = [];
  closed = false;
  startGate?: Promise<void>;
  sendError?: Error;
  sendGate?: Promise<void>;
  waitError?: Error;

  async start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture> {
    await this.startGate;
    const capture: RemoteRunCapture = {
      workerId: "worker-1",
      instanceNonce: "instance-1",
      runId: `run-${this.captures.length + 1}`,
      generation: 1,
      monitorOwnerNonce: this.monitorOwnerNonce,
      targetId: request.targetId,
    };
    this.captures.push(capture);
    this.state.set(capture.runId, snapshot(capture));
    return { ...capture };
  }

  snapshot(capture: RemoteRunCapture): RemoteRunSnapshot {
    const value = this.state.get(capture.runId);
    if (!value) throw new Error("missing snapshot");
    return { ...value };
  }

  snapshots(): RemoteRunSnapshot[] {
    return [...this.state.values()].map((value) => ({ ...value }));
  }

  async wait(capture: RemoteRunCapture, _options?: RemoteWorkerWaitOptions): Promise<RemoteRunSnapshot> {
    if (this.waitError) throw this.waitError;
    return this.snapshot(capture);
  }

  async followUp(capture: RemoteRunCapture, message: string): Promise<RemoteRunInputResult> {
    await this.sendGate;
    if (this.sendError) throw this.sendError;
    this.sent.push({ mode: "follow_up", capture: { ...capture }, message });
    return { accepted: true, effectiveMode: "follow_up", receipt: "queued" };
  }

  async steer(capture: RemoteRunCapture, message: string): Promise<RemoteRunInputResult> {
    await this.sendGate;
    if (this.sendError) throw this.sendError;
    this.sent.push({ mode: "steer", capture: { ...capture }, message });
    return { accepted: true, effectiveMode: "steer", receipt: "injected" };
  }

  async cancel(capture: RemoteRunCapture): Promise<RemoteRunCancelResult> {
    this.cancelled.push({ ...capture });
    return { accepted: true, status: "cancelled" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function harness() {
  const manager = new FakeManager();
  const persisted: RemoteHistoryEntry[] = [];
  let current = true;
  let now = 2_000;
  const session = new RemoteMonitorSession({
    config,
    manager,
    isCurrent: () => current,
    persist: (entry) => persisted.push(entry),
    now: () => ++now,
    commandIdFactory: () => `command-${now}`,
  });
  return { manager, session, persisted, setCurrent: (value: boolean) => { current = value; } };
}

test("remote Monitor lifecycle exposes configured targets and stable owned run targets", async () => {
  const { manager, session, persisted } = harness();
  assert.deepEqual(session.targets(), [{ id: "linux/pi", hostId: "linux", driver: "pi-rpc", cwd: "/srv/project" }]);

  const run = await session.create({ targetId: "linux/pi", name: "review", objective: "Review the API" });
  assert.equal(run.target, "remote:run-1");
  assert.equal(session.capture(run.target)?.monitorOwnerNonce, manager.monitorOwnerNonce);
  assert.equal(session.capture("owner:run-1"), undefined);

  const receipt = await session.send(run.target, "follow_up", "Include tests", "status", "message-1", "steer");
  assert.equal(receipt.receipt, "queued");
  assert.deepEqual(manager.sent.map((entry) => entry.mode), ["follow_up"]);
  assert.deepEqual(persisted.filter((entry) => entry.entryId === "message-1").map((entry) => [entry.revision, entry.status, entry.requestedMode, entry.effectiveMode]), [
    [1, "queued", "steer", "follow_up"],
  ]);

  await assert.rejects(session.closeRun("remote:not-owned"), /not owned/);
  assert.equal(manager.cancelled.length, 0);
  const closed = await session.closeRun(run.target);
  assert.equal(closed.accepted, true);
  assert.equal(manager.cancelled[0]?.runId, "run-1");
});

test("remote create revalidates the root owner after await and rolls back stale admission", async () => {
  const { manager, session, setCurrent } = harness();
  let release!: () => void;
  manager.startGate = new Promise<void>((resolve) => { release = resolve; });
  const creating = session.create({ targetId: "linux/pi", name: "stale", objective: "Do work" });
  setCurrent(false);
  release();
  await assert.rejects(creating, /originating Monitor session changed/);
  assert.equal(manager.cancelled.length, 1);
  assert.equal(manager.cancelled[0]?.monitorOwnerNonce, manager.monitorOwnerNonce);
});

test("remote observation maps tail/full detail and terminal outcomes canonically", async () => {
  const { manager, session, persisted } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "build", objective: "Build release" });
  const capture = session.capture(run.target)!;
  session.recordEvent(capture, {
    type: "run/event",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence: 1,
    updatedAt: 1_001,
    event: { type: "text", text: "line one\nline two" },
  });
  session.recordEvent(capture, {
    type: "run/result",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence: 2,
    updatedAt: 1_002,
    status: "completed",
    result: "release built",
    structuredOutput: { artifact: "dist.zip" },
  });
  const completed = snapshot(capture, "completed", 2);
  manager.state.set(capture.runId, completed);
  session.recordSnapshot(capture, completed);

  const summary = session.observation(run.target, { detail: "summary", lines: 1 });
  assert.equal(summary.phase, "settled");
  assert.equal(summary.outcome, "success");
  assert.equal(summary.waitStatus, "completed");
  assert.equal(summary.detail, undefined);

  const tail = session.observation(run.target, { detail: "tail", lines: 2 });
  assert.deepEqual(tail.detail, ["release built", "Structured output: {\"artifact\":\"dist.zip\"}"]);
  assert.equal(tail.lastResult, "release built");

  const full = session.observation(run.target, { detail: "full", lines: 4 });
  assert.deepEqual(full.structuredOutput, { artifact: "dist.zip" });
  assert.match(full.detail?.[0] ?? "", /target=remote:run-1/);
  assert.equal(persisted.some((entry) => entry.kind === "result" && entry.body.includes("release built") && entry.body.includes("dist.zip")), true);
});

test("remote observation view=turns groups driver events into turns and expands one turn", async () => {
  const { manager, session } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "review", objective: "Review" });
  const capture = session.capture(run.target)!;
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 1, updatedAt: 1_001, event: { type: "text", text: "reading the file now" },
  });
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 2, updatedAt: 1_002, event: { type: "tool", tool: { toolCallId: "t1", toolName: "read", phase: "start" } },
  });
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 3, updatedAt: 1_003, event: { type: "tool", tool: { toolCallId: "t1", toolName: "read", phase: "end", summary: "file contents" } },
  });
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 4, updatedAt: 1_004, event: { type: "text", text: "editing now" },
  });

  const turns = session.observation(run.target, { detail: "full", lines: 20, view: "turns" });
  assert.equal(turns.found, true);
  assert.match(turns.summary ?? "", /review · running · 2 turns · last 4 events \(bounded ring\)/);
  assert.ok(turns.detail?.some((line) => line.startsWith("Turn 1 · reading the file now")));
  assert.ok(turns.detail?.some((line) => line.startsWith("Turn 2 · editing now")));

  const turn1 = session.observation(run.target, { detail: "full", lines: 20, view: "turns", turn: 1 });
  assert.match(turn1.summary ?? "", /Turn 1 · reading the file now · 3 rows · 1 tools/);
  assert.ok(turn1.detail?.includes("[assistant] reading the file now"));
  assert.ok(turn1.detail?.includes("[tool] read (running)"));
  assert.ok(turn1.detail?.some((row) => row.startsWith("[result]") && row.includes("read") && row.includes("file contents")));

  const missing = session.observation(run.target, { detail: "full", lines: 20, view: "turns", turn: 9 });
  assert.match(missing.summary ?? "", /Turn 9 not found \(2 turns\)/);
});

test("remote observation view=turns coalesces streaming text chunks into one turn (RV-001)", async () => {
  const { session } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "chat", objective: "Chat" });
  const capture = session.capture(run.target)!;
  // A single assistant message arrives as three agent_message_chunk deltas.
  for (const [seq, chunk] of [["1", "Hello "], ["2", "world"], ["3", "!"]] as const) {
    session.recordEvent(capture, {
      type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
      sequence: Number(seq), updatedAt: 1_000 + Number(seq), event: { type: "text", text: chunk },
    });
  }

  const turns = session.observation(run.target, { detail: "full", lines: 20, view: "turns" });
  assert.match(turns.summary ?? "", /1 turn · last 3 events \(bounded ring\)/);
  assert.ok(turns.detail?.some((line) => line.startsWith("Turn 1 · Hello")));
});

test("remote observation view=session paginates driver events with a cursor", async () => {
  const { manager, session } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "build", objective: "Build" });
  const capture = session.capture(run.target)!;
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 1, updatedAt: 1_001, event: { type: "text", text: "first" },
  });
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 2, updatedAt: 1_002, event: { type: "tool", tool: { toolCallId: "t1", toolName: "bash", phase: "start" } },
  });

  const first = session.observation(run.target, { detail: "full", lines: 20, view: "session" });
  assert.equal(first.page?.kind, "remote-session");
  assert.equal(first.page?.items.length, 2);
  const cursor = first.page?.nextCursor;
  assert.ok(cursor);

  // Grow the ring with two more events and continue from the cursor.
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 3, updatedAt: 1_003, event: { type: "tool", tool: { toolCallId: "t1", toolName: "bash", phase: "end" } },
  });
  session.recordEvent(capture, {
    type: "run/event", workerId: capture.workerId, instanceNonce: capture.instanceNonce, runId: capture.runId, generation: capture.generation,
    sequence: 4, updatedAt: 1_004, event: { type: "text", text: "second" },
  });

  const next = session.observation(run.target, { detail: "full", lines: 20, view: "session", cursor: cursor });
  assert.equal(next.page?.items.length, 2);
  assert.equal((next.page?.items[0] as { cursor: number }).cursor, 3);
  assert.equal((next.page?.items[1] as { cursor: number }).cursor, 4);
});

test("remote send failures persist one terminal redacted receipt without a pending revision", async () => {
  const { manager, session, persisted } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "send", objective: "Send safely" });
  const secret = "monitor-secret-marker-7f2d";
  manager.sendError = new Error(`transport failed API_TOKEN=${secret}`);

  await assert.rejects(
    session.send(run.target, "follow_up", "Continue", "coordination", "message-failed"),
    /Remote message delivery failed \(Error\)\./,
  );

  const revisions = persisted.filter((entry) => entry.entryId === "message-failed");
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]?.status, "rejected");
  assert.equal(revisions[0]?.revision, 1);
  assert.doesNotMatch(JSON.stringify(revisions), new RegExp(secret));
});

test("remote timeout and owner replacement never leave pending history", async () => {
  const timeoutHarness = harness();
  const timeoutRun = await timeoutHarness.session.create({ targetId: "linux/pi", name: "timeout", objective: "Timeout safely" });
  const timeoutError = new Error("timed out API_TOKEN=monitor-timeout-secret");
  timeoutError.name = "AbortError";
  timeoutHarness.manager.sendError = timeoutError;
  await assert.rejects(timeoutHarness.session.send(
    timeoutRun.target,
    "follow_up",
    "Continue",
    "coordination",
    "message-timeout",
  ));
  const timeoutEntries = timeoutHarness.persisted.filter((entry) => entry.entryId === "message-timeout");
  assert.deepEqual(timeoutEntries.map((entry) => entry.status), ["timeout"]);
  assert.equal(timeoutEntries.some((entry) => entry.status === "pending"), false);
  assert.doesNotMatch(JSON.stringify(timeoutEntries), /monitor-timeout-secret/);

  const staleHarness = harness();
  const staleRun = await staleHarness.session.create({ targetId: "linux/pi", name: "stale-send", objective: "Fence safely" });
  let release!: () => void;
  staleHarness.manager.sendGate = new Promise<void>((resolve) => { release = resolve; });
  const sending = staleHarness.session.send(
    staleRun.target,
    "follow_up",
    "Continue",
    "coordination",
    "message-stale",
  );
  staleHarness.setCurrent(false);
  release();
  await assert.rejects(sending, /originating Monitor session changed/);
  assert.deepEqual(staleHarness.persisted.filter((entry) => entry.entryId === "message-stale"), []);
});

test("remote observation wait redacts rejected transport errors", async () => {
  const { manager, session } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "wait", objective: "Wait safely" });
  const secret = "monitor-secret-marker-a8b1";
  manager.waitError = new Error(`ssh failed password=${secret}`);

  await assert.rejects(
    session.waitObservation(run.target, {
      detail: "summary",
      lines: 20,
      deadline: Date.now() + 1_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Remote observation wait failed \(Error\)\./);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("remote observations bound multibyte detail, result, and structured output while redacting errors", async () => {
  const { session, persisted } = harness();
  const run = await session.create({ targetId: "linux/pi", name: "bounded", objective: "Bound output" });
  const capture = session.capture(run.target)!;
  const secret = "monitor-secret-marker-9a4c";
  session.recordEvent(capture, {
    type: "run/event",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence: 1,
    updatedAt: 1_001,
    event: { type: "text", text: `${"🙂".repeat(20_000)}\n${"x".repeat(40_000)}` },
  });
  session.recordEvent(capture, {
    type: "run/result",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence: 2,
    updatedAt: 1_002,
    status: "failed",
    result: "r".repeat(20_000),
    error: `child stderr API_TOKEN=${secret}`,
    structuredOutput: { payload: "界".repeat(20_000) },
  });

  const observation = session.observation(run.target, { detail: "full", lines: 500 });
  const detailBytes = (observation.detail ?? []).reduce((total, line) => total + Buffer.byteLength(line, "utf8"), 0);
  assert.ok(detailBytes <= 32 * 1024);
  assert.ok(Buffer.byteLength(observation.lastResult ?? "", "utf8") <= 8 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(observation.structuredOutput), "utf8") <= 21 * 1024);
  assert.match(JSON.stringify(observation.structuredOutput), /truncated/);
  assert.doesNotMatch(JSON.stringify({ observation, persisted }), new RegExp(secret));
  assert.match(persisted.find((entry) => entry.kind === "result")?.body ?? "", /Remote run failed \(Error\)\./);
});

test("remote session shutdown cancels only active captured runs before closing its manager", async () => {
  const { manager, session } = harness();
  const active = await session.create({ targetId: "linux/pi", name: "active", objective: "Active" });
  const terminal = await session.create({ targetId: "linux/pi", name: "done", objective: "Done" });
  const terminalCapture = session.capture(terminal.target)!;
  const completed = snapshot(terminalCapture, "completed", 1);
  manager.state.set(terminalCapture.runId, completed);
  session.recordSnapshot(terminalCapture, completed);

  await session.shutdown();
  assert.deepEqual(manager.cancelled.map((capture) => capture.runId), [session.capture(active.target)?.runId]);
  assert.equal(manager.closed, true);
  await assert.rejects(session.send(active.target, "steer", "late", "coordination"), /closed/);
});

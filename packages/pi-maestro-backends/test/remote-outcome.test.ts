import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptReclamation } from "pi-maestro-backend-core/v1/backend";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { foldRemoteOutcome, type RemoteOutcomeInput } from "../src/remote/outcome.ts";
import type {
  RemoteDriverEvent,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteStatus,
  RemoteTerminalStatus,
} from "../src/remote/types.ts";

/** Every event on the wire carries the same run identity; only the payload differs. */
const IDENTITY = { workerId: "w-1", instanceNonce: "n-1", runId: "run-1", generation: 1 };

const SPEC: TeammateRunSpec = { agent: "general", task: "do the thing" };

const LOST_REASON = "remote run lost before the daemon confirmed release";
const DROPPED_REASON = "the remote connection dropped before the daemon confirmed release";

/** One event without the envelope fields the helper below fills in. */
type EventSeed =
  | { type: "run/state"; status: RemoteStatus }
  | { type: "run/event"; event: RemoteDriverEvent }
  | {
    type: "run/result";
    status: RemoteTerminalStatus;
    result?: string;
    error?: string;
    structuredOutput?: unknown;
  };

/**
 * Build a run's event stream, numbering sequences from 1 the way the wire does.
 *
 * @param seeds - event payloads in arrival order.
 * @returns the full events, envelope fields included.
 */
function events(...seeds: readonly EventSeed[]): RemoteRunEvent[] {
  return seeds.map((seed, index): RemoteRunEvent => {
    const envelope = { ...IDENTITY, sequence: index + 1, updatedAt: 1_000 + index };
    switch (seed.type) {
      case "run/state": return { ...envelope, type: "run/state", status: seed.status };
      case "run/event": return { ...envelope, type: "run/event", event: seed.event };
      case "run/result": return { ...envelope, ...seed };
    }
  });
}

/**
 * The terminal snapshot `manager.wait` would have settled with.
 *
 * @param status - the status the run was last seen in.
 * @param lastSequence - the highest sequence the snapshot accounts for.
 * @returns the snapshot.
 */
function snapshot(status: RemoteStatus, lastSequence: number): RemoteRunSnapshot {
  return { ...IDENTITY, status, lastSequence, updatedAt: 2_000 };
}

/**
 * A fold input with the fields a case does not care about already filled.
 *
 * @param overrides - the case's own events, snapshot, and any other field it varies.
 * @returns the complete input.
 */
function input(
  overrides: Partial<RemoteOutcomeInput> & Pick<RemoteOutcomeInput, "events" | "snapshot">,
): RemoteOutcomeInput {
  return {
    spec: SPEC,
    correlationId: "corr-1",
    model: "remote-model",
    startedAt: 100,
    settledAt: 350,
    turns: 1,
    disconnectedBeforeResult: false,
    ...overrides,
  };
}

/**
 * The diagnostic reason, or undefined when the attempt was reclaimed.
 *
 * @param reclamation - the settled reclamation verdict.
 * @returns the reason an unreaped attempt carries.
 */
function unreapedReason(reclamation: AttemptReclamation): string | undefined {
  return reclamation.status === "unreaped" ? reclamation.reason : undefined;
}

/**
 * A tool event seed.
 *
 * @param toolCallId - the call this phase belongs to.
 * @param phase - which end of the call this event reports.
 * @returns the seed.
 */
function toolSeed(toolCallId: string, phase: "start" | "end"): EventSeed {
  return { type: "run/event", event: { type: "tool", tool: { toolCallId, toolName: "read_file", phase } } };
}

test("a completed remote run is reclaimed", async () => {
  const outcome = foldRemoteOutcome(input({
    events: events({ type: "run/result", status: "completed", result: "the answer" }),
    snapshot: snapshot("completed", 1),
  }));
  assert.equal(outcome.result.terminalStatus, "completed");
  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.result.messages[0]?.content, "the answer");
  assert.equal(outcome.recovery.settlementAuthority, "authoritative");
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});

test("a lost remote run is not reported as reclaimed", async () => {
  const outcome = foldRemoteOutcome(input({
    events: events({ type: "run/result", status: "lost", error: "the worker stopped answering" }),
    snapshot: snapshot("lost", 1),
  }));
  assert.equal(outcome.result.terminalStatus, "failed");
  assert.equal(outcome.recovery.settlementAuthority, "unknown");
  assert.equal(outcome.recovery.externalReplayRisk, true);
  assert.deepEqual(await outcome.reclamation, { status: "unreaped", reason: LOST_REASON });
});

test("a connection that dropped before the terminal result is not reported as reclaimed", async () => {
  const outcome = foldRemoteOutcome(input({
    events: events({ type: "run/state", status: "running" }),
    snapshot: snapshot("running", 1),
    disconnectedBeforeResult: true,
  }));
  const reclamation = await outcome.reclamation;
  assert.equal(reclamation.status, "unreaped");
  assert.equal(unreapedReason(reclamation), DROPPED_REASON);
  // Losing the run and losing the connection are handled differently, so the
  // two faults must stay tellable apart from the reason alone.
  assert.notEqual(unreapedReason(reclamation), LOST_REASON);
});

test("reclamation is decided per run rather than answered once", async () => {
  const completed = foldRemoteOutcome(input({
    events: events({ type: "run/result", status: "completed", result: "the answer" }),
    snapshot: snapshot("completed", 1),
  }));
  const lost = foldRemoteOutcome(input({
    events: events({ type: "run/result", status: "lost" }),
    snapshot: snapshot("lost", 1),
  }));
  const dropped = foldRemoteOutcome(input({
    events: events({ type: "run/state", status: "running" }),
    snapshot: snapshot("running", 1),
    disconnectedBeforeResult: true,
  }));
  const reclamations = await Promise.all([completed.reclamation, lost.reclamation, dropped.reclamation]);
  // A stub answering `reclaimed` for everything passes any single-case
  // assertion; only one run seeing both verdicts rules it out.
  assert.equal(new Set(reclamations.map((reclamation) => reclamation.status)).size, 2);
});

test("a cancelled remote run reads as terminated", async () => {
  const outcome = foldRemoteOutcome(input({
    events: events({ type: "run/result", status: "cancelled" }),
    snapshot: snapshot("cancelled", 1),
  }));
  assert.equal(outcome.result.terminalStatus, "terminated");
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});

test("tool calls are counted by id pairing, not by event arrival", () => {
  const outcome = foldRemoteOutcome(input({
    events: events(
      toolSeed("a", "start"),
      toolSeed("b", "start"),
      toolSeed("a", "end"),
      toolSeed("c", "start"),
      // A redelivered start for a call that already ended: counting arrivals
      // would report five or four calls where only three exist.
      toolSeed("a", "start"),
      { type: "run/result", status: "completed", result: "the answer" },
    ),
    snapshot: snapshot("completed", 6),
  }));
  assert.equal(outcome.recovery.completedToolCount, 1);
  assert.equal(outcome.recovery.inFlightToolCount, 2);
  assert.equal(outcome.result.toolCount, 1);
});

test("remote usage events fold into the attempt usage", () => {
  const outcome = foldRemoteOutcome(input({
    events: events(
      { type: "run/event", event: { type: "usage", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } } },
      { type: "run/event", event: { type: "usage", usage: { inputTokens: 3, totalTokens: 99 } } },
      { type: "run/result", status: "completed", result: "the answer" },
    ),
    snapshot: snapshot("completed", 3),
    turns: 4,
  }));
  const usage = outcome.result.usage;
  assert.equal(usage.inputTokens, 13);
  assert.equal(usage.outputTokens, 5);
  assert.ok(Math.abs(usage.cost - 0.01) < 1e-9, `cost was ${usage.cost}`);
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.cacheWriteTokens, 0);
  assert.equal(usage.turns, 4);
  // The provider's own `totalTokens` is a sum of the other two; folding it in
  // anywhere would count the same tokens twice.
  assert.notEqual(usage.inputTokens + usage.outputTokens, 117);
});

test("a run with no result event settles without authority", () => {
  const outcome = foldRemoteOutcome(input({
    events: events(
      { type: "run/state", status: "running" },
      { type: "run/event", event: { type: "text", text: "partway through" } },
    ),
    snapshot: snapshot("lost", 2),
  }));
  assert.equal(outcome.recovery.settlementAuthority, "unknown");
  assert.equal(outcome.recovery.externalReplayRisk, true);
  // The run emitted activity, so the failure is not an infrastructure exit that
  // happened before anything ran.
  assert.equal(outcome.recovery.preActivityInfrastructureExit, false);
});

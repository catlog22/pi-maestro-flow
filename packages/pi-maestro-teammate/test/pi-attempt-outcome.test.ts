import assert from "node:assert/strict";
import test from "node:test";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import { outcomeOf } from "../src/backends/pi-subprocess.ts";
import {
  attemptReclamations,
  attemptRecoveryFacts,
  type AttemptSettlementCapability,
} from "../src/runs/pi-subprocess-attempt.ts";

/**
 * Turning a Pi attempt into the contract's `AttemptOutcome`.
 *
 * Both dispatch paths settle through this, so its fallbacks are what the host's
 * replay fence reads when an attempt recorded nothing about itself. The unsafe
 * reading is the correct one there: an attempt whose effects nobody observed
 * must block recovery, not clear it.
 */

function resultOf(name: string): SingleResult {
  return {
    agent: "general",
    task: name,
    exitCode: 0,
    messages: [],
    usage: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, cost: 0, turns: 1,
    },
    model: "provider/model",
    correlationId: `c-${name}`,
    durationMs: 1,
  };
}

test("an attempt that recorded nothing reports its effects as unobserved", async () => {
  const outcome = outcomeOf(resultOf("unrecorded"));
  // Not "clean": nothing was observed, so the fence must block rather than
  // conclude that no tool ran.
  assert.equal(outcome.recovery.settlementAuthority, "unknown");
  assert.equal(outcome.recovery.externalReplayRisk, true);
  assert.equal(outcome.recovery.completedToolCount, 0);
  assert.equal(outcome.recovery.inFlightToolCount, 0);
  assert.equal(outcome.recovery.preActivityInfrastructureExit, false);
});

test("an attempt with no recorded reclamation is treated as reaped", async () => {
  // A run that never registered a termination controller had no child left to
  // reap; reporting it unreaped would fence a failover for a process that does
  // not exist.
  assert.deepEqual(await outcomeOf(resultOf("no-reclamation")).reclamation, { status: "reclaimed" });
});

test("Pi's settlement vocabulary maps onto the contract's", () => {
  // The union is closed and mapped exhaustively, so a new Pi marker fails to
  // compile rather than degrading silently into "unknown".
  const cases: readonly [AttemptSettlementCapability, string][] = [
    ["agent_settled", "authoritative"],
    ["legacy", "inferred"],
    ["unknown", "unknown"],
  ];
  for (const [capability, expected] of cases) {
    const result = resultOf(`settle-${capability}`);
    attemptRecoveryFacts.set(result, {
      settlementCapability: capability,
      completedToolCount: 2,
      inFlightToolCount: 1,
      preActivityInfrastructureExit: false,
      externalReplayRisk: false,
    });
    const outcome = outcomeOf(result);
    assert.equal(outcome.recovery.settlementAuthority, expected, capability);
    assert.equal(outcome.recovery.completedToolCount, 2);
    assert.equal(outcome.recovery.inFlightToolCount, 1);
  }
});

test("a reclamation the runtime refused is reported with its reason", async () => {
  const result = resultOf("unreaped");
  attemptReclamations.set(
    result,
    Promise.resolve({ status: "unreaped", reason: "child ignored SIGKILL" }),
  );
  const reclamation = await outcomeOf(result).reclamation;
  assert.equal(reclamation.status, "unreaped");
  assert.match((reclamation as { reason: string }).reason, /child ignored SIGKILL/);
});

test("a forced but confirmed reclamation counts as reaped", async () => {
  // The host's only question is whether a stale runtime can still deliver
  // callbacks. A forced kill answers that exactly as a graceful exit does.
  const result = resultOf("forced");
  attemptReclamations.set(result, Promise.resolve({ status: "reclaimed", forced: true }));
  assert.deepEqual(await outcomeOf(result).reclamation, { status: "reclaimed" });
});

test("an unreaped report without a reason still names one", async () => {
  const result = resultOf("reasonless");
  attemptReclamations.set(result, Promise.resolve({ status: "unreaped" }));
  const reclamation = await outcomeOf(result).reclamation;
  assert.deepEqual(reclamation, { status: "unreaped", reason: "unspecified" });
});

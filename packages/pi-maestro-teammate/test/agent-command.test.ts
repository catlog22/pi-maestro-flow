import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { TEAMMATE_MESSAGE_EVENT } from "../src/shared/types.ts";
import {
  TEAMMATE_INTERRUPT_NOTICE,
  applyTeammateAgentCommand,
  type TeammateAgentCommandPayload,
} from "../src/extension/teammate-core.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

interface Emitted {
  name: string;
  payload: Record<string, unknown>;
}

function makeHarness() {
  const emitted: Emitted[] = [];
  const pi = {
    events: {
      emit: (name: string, payload: unknown) => {
        emitted.push({ name, payload: payload as Record<string, unknown> });
      },
    },
  };
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
  const addAgent = (overrides: Partial<ActiveAgent> = {}): ActiveAgent => {
    const now = Date.now();
    const agent: ActiveAgent = {
      agent: "worker",
      name: "worker",
      correlationId: randomUUID(),
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
    state.activeRuns.set(agent.correlationId, agent);
    return agent;
  };
  const deliveries: Array<{ correlationId: string; label: string; message: string }> = [];
  const deliver = async (
    correlationId: string,
    label: string,
    message: string,
  ): Promise<{ delivered: boolean; error?: string }> => {
    deliveries.push({ correlationId, label, message });
    return { delivered: true };
  };
  const command = (overrides: Partial<TeammateAgentCommandPayload>): TeammateAgentCommandPayload => ({
    correlationId: "missing",
    action: "interrupt",
    ...overrides,
  });
  const feedback = (): Array<Record<string, unknown>> =>
    emitted.filter((entry) => entry.name === TEAMMATE_MESSAGE_EVENT).map((entry) => entry.payload);
  return { pi, state, addAgent, deliver, command, feedback, deliveries };
}

test("interrupt delivers the canned continue notice to a running agent", async () => {
  const h = makeHarness();
  const agent = h.addAgent();
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, h.command({ correlationId: agent.correlationId }));

  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].correlationId, agent.correlationId);
  assert.equal(h.deliveries[0].label, "worker");
  assert.equal(h.deliveries[0].message, TEAMMATE_INTERRUPT_NOTICE);
  assert.equal(h.feedback().length, 0, "successful delivery emits no extra feedback");
});

test("steer delivers the user's message verbatim", async () => {
  const h = makeHarness();
  const agent = h.addAgent();
  await applyTeammateAgentCommand(
    h.state,
    h.pi,
    h.deliver,
    h.command({ correlationId: agent.correlationId, action: "steer", message: "retry with verbose output" }),
  );

  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].message, "retry with verbose output");
});

test("steer without a message is rejected with an isSend error feedback", async () => {
  const h = makeHarness();
  const agent = h.addAgent();
  await applyTeammateAgentCommand(
    h.state,
    h.pi,
    h.deliver,
    h.command({ correlationId: agent.correlationId, action: "steer" }),
  );

  assert.equal(h.deliveries.length, 0);
  const [entry] = h.feedback();
  assert.ok(entry);
  assert.equal(entry.isSend, true);
  assert.equal(entry.sendError, true);
  assert.equal(entry.mode, "steer");
  assert.match(String(entry.message), /requires a message/);
});

test("an unknown or non-live agent is rejected without touching the delivery path", async () => {
  const h = makeHarness();
  const gone = h.addAgent();
  h.state.activeRuns.delete(gone.correlationId);
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, h.command({ correlationId: gone.correlationId }));

  assert.equal(h.deliveries.length, 0);
  const [entry] = h.feedback();
  assert.equal(entry.sendError, true);
  assert.match(String(entry.message), /not running/);

  const failed = h.addAgent({ status: "failed" });
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, h.command({ correlationId: failed.correlationId }));
  assert.equal(h.deliveries.length, 0, "failed agents cannot receive commands");
});

test("a failed delivery surfaces the delivery error as feedback", async () => {
  const h = makeHarness();
  const agent = h.addAgent();
  await applyTeammateAgentCommand(h.state, h.pi, async () => ({ delivered: false, error: "lease held by another window" }), h.command({ correlationId: agent.correlationId }));

  const [entry] = h.feedback();
  assert.ok(entry);
  assert.equal(entry.sendError, true);
  assert.match(String(entry.message), /lease held by another window/);
});

test("malformed payloads are ignored silently", async () => {
  const h = makeHarness();
  const agent = h.addAgent();
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, null);
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, { correlationId: 42 });
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, h.command({ correlationId: agent.correlationId, action: "abort" as never }));
  await applyTeammateAgentCommand(h.state, h.pi, h.deliver, h.command({ correlationId: agent.correlationId, action: "steer-misspelled" as never }));
  // An unknown action must not degrade into a real interrupt: no delivery,
  // no feedback — the malformed command is dropped with zero side effects.
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.feedback().length, 0);
});

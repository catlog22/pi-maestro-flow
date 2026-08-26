import assert from "node:assert/strict";
import test from "node:test";
import {
  deliverDurableFailureWithFallback,
  notifyBackgroundFailure,
  safeSendMessage,
} from "../src/extension/index.ts";

const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

test("background promise failures emit completion and trigger a turn", () => {
  const emitted: unknown[] = [];
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const pi = {
    events: { emit: (...args: unknown[]) => emitted.push(args) },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => sent.push({ message, options }),
  };

  notifyBackgroundFailure(pi as never, "tool-id", "general", "cid", new Error("boom"));
  assert.equal(emitted.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "teammate-complete");
  assert.match(String(sent[0].message.content), /boom/);
  assert.match(String(sent[0].message.content), /agent=general/);
  assert.match(String(sent[0].message.content), /correlationId=cid/);
  assert.match(String(sent[0].message.content), /phase=background-promise/);
  assert.equal(sent[0].options.triggerTurn, true);
});

test("background failure fallback completion retains its dispatch projection", async () => {
  const emitted: unknown[][] = [];
  const projection = {
    workspaceId: "w".repeat(64),
    sessionId: "session-a",
    sourceId: "source-a",
    generation: 3,
  };
  const pi = {
    events: { emit: (...args: unknown[]) => emitted.push(args) },
    sendMessage() {},
  };

  await deliverDurableFailureWithFallback({
    publishDurableFailure: async () => false,
    ownsDispatchGeneration: () => true,
    fallback: () => notifyBackgroundFailure(
      pi as never,
      "tool-id",
      "general",
      "cid",
      new Error("boom"),
      undefined,
      projection,
    ),
  });

  assert.deepEqual((emitted[0]?.[1] as { projection?: unknown }).projection, projection);
});

test("late durable-failure resolve is fenced before direct fallback", async () => {
  let resolvePublication!: (durable: boolean) => void;
  const publication = new Promise<boolean>((resolve) => { resolvePublication = resolve; });
  let current = true;
  let fallbacks = 0;
  const delivery = deliverDurableFailureWithFallback({
    publishDurableFailure: () => publication,
    ownsDispatchGeneration: () => current,
    fallback: () => { fallbacks += 1; },
  });

  current = false;
  resolvePublication(false);
  await delivery;
  assert.equal(fallbacks, 0);
});

test("late durable-failure rejection is fenced before logging or direct fallback", async () => {
  let rejectPublication!: (error: unknown) => void;
  const publication = new Promise<boolean>((_resolve, reject) => { rejectPublication = reject; });
  let current = true;
  let fallbacks = 0;
  let reported = 0;
  const delivery = deliverDurableFailureWithFallback({
    publishDurableFailure: () => publication,
    ownsDispatchGeneration: () => current,
    fallback: () => { fallbacks += 1; },
    onDurabilityError: () => { reported += 1; },
  });

  current = false;
  rejectPublication(new Error("late failure"));
  await delivery;
  assert.equal(fallbacks, 0);
  assert.equal(reported, 0);
});

test("background failure notification survives a stale extension ctx", () => {
  const emitted: unknown[] = [];
  const pi = {
    events: { emit: (...args: unknown[]) => emitted.push(args) },
    sendMessage: () => {
      throw new Error(STALE_CTX_MESSAGE);
    },
  };

  // The .catch background path must never escalate into an unhandled
  // rejection that kills the pi process after session replacement.
  assert.doesNotThrow(() => {
    notifyBackgroundFailure(pi as never, "tool-id", "general", "cid", new Error("boom"));
  });
  // State settlement (eventBus emit) is not guarded by assertActive and must
  // still happen even though the notification was dropped.
  assert.equal(emitted.length, 1);
});

test("safeSendMessage drops stale-ctx sends and contains unexpected errors", () => {
  const stalePi = {
    sendMessage: () => {
      throw new Error(STALE_CTX_MESSAGE);
    },
  };
  assert.doesNotThrow(() => {
    safeSendMessage(stalePi as never, { customType: "x", content: "y", display: true });
  });

  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const brokenPi = {
      sendMessage: () => {
        throw new Error("host rejected the message");
      },
    };
    assert.doesNotThrow(() => {
      safeSendMessage(brokenPi as never, { customType: "x", content: "y", display: true });
    });
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]), /host rejected the message/);
  } finally {
    console.error = original;
  }
});

test("P1: safeSendMessage reports non-delivery instead of only swallowing it", () => {
  const stalePi = {
    sendMessage: () => {
      throw new Error(STALE_CTX_MESSAGE);
    },
  };
  assert.equal(safeSendMessage(stalePi as never, { customType: "x", content: "y", display: true }), false);
  assert.equal(safeSendMessage({ sendMessage() {} } as never, { customType: "x", content: "y", display: true }), true);

  const logged: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => logged.push(args);
  try {
    safeSendMessage(stalePi as never, { customType: "x", content: "y", display: true });
  } finally {
    console.warn = original;
  }
  assert.equal(logged.length, 1);
  assert.match(String(logged[0]), /notification dropped/);
});

test("P1: a dropped background failure marks the agent record inspectable", async () => {
  const correlationId = (await import("node:crypto")).randomUUID();
  const now = Date.now();
  const agent = {
    agent: "general", correlationId, startedAt: now,
    abortController: new AbortController(), inbox: [], outputLog: [],
    lastActivityAt: now, depth: 0, status: "running", sleepMs: 0,
  };
  const state = {
    baseCwd: process.cwd(), currentSessionId: null,
    namedAgents: new Map<string, string>(),
    activeRuns: new Map<string, typeof agent>([[correlationId, agent]]),
  };
  const stalePi = {
    events: { emit() {} },
    sendMessage: () => { throw new Error(STALE_CTX_MESSAGE); },
  };

  notifyBackgroundFailure(stalePi as never, "tool-id", "general", correlationId, new Error("boom"), state as never);

  assert.ok(
    agent.outputLog.some((line) => /notification dropped/.test(line)),
    "the settled record must say the completion notification was dropped",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  executeAsk,
  type AskAnswer,
} from "../src/tools/ask.ts";
import {
  registerAskTransport,
  type AskTransport,
  type AskTransportCancelReason,
  type AskTransportResult,
} from "../src/ask-transport.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRaceHarness() {
  let finishLocal: ((answers: AskAnswer[] | undefined) => void) | undefined;
  let customOpened = false;
  const ui = {
    custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, finish: (value: T | undefined) => void) => unknown) {
      customOpened = true;
      return new Promise<T | undefined>((resolve) => {
        finishLocal = (answers) => resolve(answers as T | undefined);
        const finish = (value: T | undefined) => resolve(value);
        factory({ requestRender() {} }, { fg: (_name: string, text: string) => text }, {}, finish);
      });
    },
    onTerminalInput() { return () => {}; },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/race",
    sessionManager: { getSessionFile: () => "/tmp/race/session.jsonl" },
    ui,
  } as unknown as ExtensionContext;
  return {
    ctx,
    get customOpened() { return customOpened; },
    answerLocal(answers: AskAnswer[]) { finishLocal?.(answers); },
    cancelLocal() { finishLocal?.(undefined); },
  };
}

function answer(label: string): AskAnswer[] {
  return [{ question: "Pick", selected: [], text: label }];
}

function transportFixture(result: ReturnType<typeof deferred<AskTransportResult>>) {
  const cancellations: AskTransportCancelReason[] = [];
  const transport: AskTransport = {
    open(request) {
      assert.equal(request.toolCallId, "raw-call-1");
      assert.equal(request.questions[0]?.question, "Pick");
      assert.equal(request.cwd, "/tmp/race");
      return {
        promise: result.promise,
        cancel(reason) { cancellations.push(reason); },
      };
    },
  };
  return { transport, cancellations };
}

test("remote answer wins and cancels the local TUI", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  try {
    const pending = executeAsk({ questions: [{ question: "Pick", options: [{ label: "A" }] }] }, harness.ctx, { toolCallId: "raw-call-1" });
    remote.resolve({ status: "answered", answers: answer("mobile") });
    const result = await pending;
    assert.deepEqual(result.details, { answers: answer("mobile") });
    assert.equal(harness.customOpened, true);
    assert.deepEqual(fixture.cancellations, []);
  } finally {
    dispose();
  }
});

test("cancelling the local TUI cancels the mobile endpoint", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  try {
    const pending = executeAsk({ questions: [{ question: "Pick" }] }, harness.ctx, { toolCallId: "raw-call-1" });
    harness.cancelLocal();
    const result = await pending;
    assert.deepEqual(result.details, { answers: [], cancelled: true });
    assert.deepEqual(fixture.cancellations, ["cancelled"]);
    remote.resolve({ status: "answered", answers: answer("late-mobile") });
  } finally {
    dispose();
  }
});

test("invalid remote answers do not win the race", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  try {
    const pending = executeAsk({ questions: [{ question: "Pick", options: [{ label: "A" }] }] }, harness.ctx, { toolCallId: "raw-call-1" });
    remote.resolve({ status: "answered", answers: [{ question: "Wrong", selected: ["not-an-option"] }] });
    harness.answerLocal(answer("A"));
    const result = await pending;
    assert.deepEqual(result.details, { answers: answer("A") });
    assert.deepEqual(fixture.cancellations, ["transport_error", "tui_answered"]);
  } finally {
    dispose();
  }
});
test("local TUI answer wins and cancels the remote request", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  try {
    const pending = executeAsk({ questions: [{ question: "Pick", options: [{ label: "A" }] }] }, harness.ctx, { toolCallId: "raw-call-1" });
    harness.answerLocal(answer("tui"));
    const result = await pending;
    assert.deepEqual(result.details, { answers: answer("tui") });
    assert.deepEqual(fixture.cancellations, ["tui_answered"]);
    remote.resolve({ status: "answered", answers: answer("late") });
  } finally {
    dispose();
  }
});

test("multi-question remote answers preserve the full Flow result", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const cancellations: AskTransportCancelReason[] = [];
  const dispose = registerAskTransport({
    open(request) {
      assert.equal(request.questions.length, 2);
      assert.equal(request.questions[1]?.options?.[0]?.label, "B");
      return { promise: remote.promise, cancel(reason) { cancellations.push(reason); } };
    },
  });
  try {
    const pending = executeAsk({
      questions: [
        { question: "First" },
        { question: "Second", options: [{ label: "B" }] },
      ],
    }, harness.ctx, { toolCallId: "raw-call-1" });
    remote.resolve({
      status: "answered",
      answers: [
        { question: "First", selected: [], text: "one" },
        { question: "Second", selected: ["B"] },
      ],
    });
    const result = await pending;
    assert.deepEqual(result.details, {
      answers: [
        { question: "First", selected: [], text: "one" },
        { question: "Second", selected: ["B"] },
      ],
    });
    assert.deepEqual(cancellations, []);
  } finally {
    dispose();
  }
});

test("both endpoints cancelling preserves the existing cancelled result", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  try {
    const pending = executeAsk({ questions: [{ question: "Pick" }] }, harness.ctx, { toolCallId: "raw-call-1" });
    harness.cancelLocal();
    remote.resolve({ status: "cancelled" });
    const result = await pending;
    assert.deepEqual(result.details, { answers: [], cancelled: true });
  } finally {
    dispose();
  }
});
test("parent abort cancels remote and returns the existing cancelled result", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  const controller = new AbortController();
  try {
    const pending = executeAsk({ questions: [{ question: "Pick" }] }, harness.ctx, { toolCallId: "raw-call-1", signal: controller.signal });
    controller.abort();
    remote.resolve({ status: "cancelled" });
    const result = await pending;
    assert.deepEqual(result.details, { answers: [], cancelled: true });
    assert.ok(fixture.cancellations.includes("aborted"));
  } finally {
    dispose();
  }
});

test("transport registration is disposable and native TUI remains the fallback", async () => {
  const harness = createRaceHarness();
  const remote = deferred<AskTransportResult>();
  const fixture = transportFixture(remote);
  const dispose = registerAskTransport(fixture.transport);
  dispose();
  const pending = executeAsk({ questions: [{ question: "Pick" }] }, harness.ctx, { toolCallId: "raw-call-1" });
  harness.answerLocal(answer("native"));
  const result = await pending;
  assert.deepEqual(result.details, { answers: answer("native") });
  remote.resolve({ status: "cancelled" });
});

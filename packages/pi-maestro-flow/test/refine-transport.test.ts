import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createRefineSession,
  openRefinePanel,
  type RefineSession,
} from "../src/tools/plan-refine.ts";
import type {
  RefineTransportAction,
  RefineTransportEvent,
  RefineTransportRequest,
} from "../src/refine-transport.ts";
import { registerRefineTransport } from "../src/refine-transport.ts";

const PLAN = "# Plan\n\n- Step one\n- Step two";

interface Harness {
  readonly events: RefineTransportEvent[];
  readonly request: () => RefineTransportRequest | undefined;
  actions(action: RefineTransportAction): Promise<void>;
  /** Drive the local overlay to a terminal decision, as a TUI user would. */
  closeOverlay(result: { action: "apply" | "discard" | "cancel" }): void;
  cancelCount: () => number;
  dispose(): void;
}

/** Minimal TUI stub that hands the overlay factory back so tests can drive it. */
function overlayUi() {
  let done: ((result: unknown) => void) | undefined;
  const ui = {
    custom<T>(factory: (tui: { requestRender(): void }, theme: unknown, kb: unknown, finish: (r: T) => void) => unknown) {
      return new Promise<T | undefined>((resolve) => {
        done = resolve as (result: unknown) => void;
        factory({ requestRender() {} }, {}, {}, (result: T) => resolve(result));
      });
    },
    notify() {},
  };
  return { ui, close: (result: unknown) => done?.(result) };
}

function harness(options?: { accept?: boolean }): Harness {
  const events: RefineTransportEvent[] = [];
  let request: RefineTransportRequest | undefined;
  let resolveHandle!: (value: { action: "apply" | "discard" | "cancel" }) => void;
  const done = new Promise<{ action: "apply" | "discard" | "cancel" }>((resolve) => {
    resolveHandle = resolve;
  });
  let cancelCount = 0;
  const dispose = registerRefineTransport({
    open(incoming) {
      if (options?.accept === false) return undefined;
      request = incoming;
      return {
        promise: done,
        emit(event) { events.push(event); },
        finish(result) { resolveHandle(result); },
        cancel() { cancelCount += 1; },
      };
    },
  });
  return {
    events,
    request: () => request,
    async actions(action) {
      assert.ok(request, `transport was never opened (events=${events.length})`);
      await request.handleAction(action);
    },
    closeOverlay: (result) => resolveHandle(result),
    cancelCount: () => cancelCount,
    dispose,
  };
}

function stubPi(): ExtensionAPI {
  return { on() { return () => {}; }, ui: { notify() {} } } as unknown as ExtensionAPI;
}

function refineContextWith(ui: unknown) {
  return {
    cwd: "/repo",
    hasUI: true,
    ui,
    mode: "tui",
    model: { provider: "p", id: "m" },
    modelRegistry: {},
    isProjectTrusted: true,
    sessionManager: { getSessionId: () => "session-1" },
  } as unknown as Parameters<typeof openRefinePanel>[1];
}

test("remote refine opens with an authoritative snapshot before any user action", async () => {
  const h = harness();
  const overlay = overlayUi();
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), { markdown: PLAN, revision: 4 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const types = h.events.map((event) => event.type);
    // opening handshake, then the overlay's first authoritative snapshot.
    assert.deepEqual(types, ["status", "status", "snapshot", "snapshot"]);
    const sequences = h.events.map((event) => event.sequence);
    assert.deepEqual(sequences, [1, 2, 3, 4], "sequences must be monotonically increasing");
    const snapshot = h.events[2];
    assert.equal(snapshot?.type, "snapshot");
    if (snapshot?.type !== "snapshot") throw new Error("expected snapshot");
    assert.equal(snapshot.snapshot.revision, 4);
    assert.equal(snapshot.snapshot.target.sessionId, "session-1");
    assert.equal(snapshot.snapshot.target.normalizedCwd, "/repo");
    assert.ok(snapshot.snapshot.refineSessionId.startsWith("refine:/repo:"));
    overlay.close({ action: "cancel", session: createRefineSession("reviewer", "p/m") });
    await pending;
  } finally {
    h.dispose();
  }
});

test("a remote discard intent drives the local overlay to its own discard outcome", async () => {
  const h = harness();
  const overlay = overlayUi();
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), { markdown: PLAN, revision: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await h.actions({ type: "discard", actionId: "a-discard" });
    // The overlay authority closes with discard; the transport only mirrors it.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const outcome = await pending;
    assert.equal(outcome.action, "discard");
  } finally {
    h.dispose();
  }
});

test("duplicate action ids are relayed once", async () => {
  const h = harness();
  const overlay = overlayUi();
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), { markdown: PLAN, revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const action: RefineTransportAction = { type: "snapshot_request", actionId: "a-1" };
    await h.actions(action);
    await h.actions(action);
    const results = h.events.filter((event) => event.type === "action_result");
    assert.equal(results.length, 1, "the duplicate action id is not relayed twice");
    overlay.close({ action: "cancel", session: createRefineSession("reviewer", "p/m") });
    await pending;
  } finally {
    h.dispose();
  }
});

test("apply stays a presentation request: no terminal until the caller finalizes", async () => {
  const h = harness();
  const overlay = overlayUi();
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), { markdown: PLAN, revision: 7 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await h.actions({ type: "apply", actionId: "a-apply", turnId: "turn-1" });
    // No turn exists yet, so the overlay keeps running and emits no terminal.
    assert.equal(h.events.some((event) => event.type === "terminal"), false);
    overlay.close({ action: "cancel", session: createRefineSession("reviewer", "p/m") });
    await pending;
  } finally {
    h.dispose();
  }
});

test("the business terminal reaches the mirror even after the local overlay closed", async () => {
  const h = harness();
  const overlay = overlayUi();
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), { markdown: PLAN, revision: 13 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    overlay.close({ action: "discard", session: createRefineSession("reviewer", "p/m") });
    const outcome = await pending;
    assert.equal(outcome.action, "discard");
    // The mirror must stay attached until finalize: cancelling the transport here
    // would detach the Host pending entry and silently drop the terminal frame.
    assert.equal(h.cancelCount(), 0);
    assert.ok(outcome.finalize, "a remote session must expose finalize");
    outcome.finalize?.({ action: "discard", terminal: "discarded" });
    const terminal = h.events.find((event) => event.type === "terminal");
    assert.equal(terminal?.type, "terminal");
    if (terminal?.type !== "terminal") throw new Error("expected terminal");
    assert.equal(terminal.status, "discarded");
  } finally {
    h.dispose();
  }
});

test("a failing transport never removes the local refine path", async () => {
  const events: RefineTransportEvent[] = [];
  const overlay = overlayUi();
  const dispose = registerRefineTransport({
    open() {
      return {
        promise: Promise.reject(new Error("transport exploded")),
        emit(event) { events.push(event); },
        finish() {},
        cancel() {},
      };
    },
  });
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), { markdown: PLAN, revision: 9 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The overlay still exists and owns the outcome.
    overlay.close({ action: "cancel", session: createRefineSession("reviewer", "p/m") });
    const outcome = await pending;
    assert.equal(outcome.action, "cancel");
    assert.ok(events.length > 0, "the mirror still received the opening handshake");
  } finally {
    dispose();
  }
});

test("without a registered transport the local TUI path is used unchanged", async () => {
  const h = harness({ accept: false });
  const overlay = overlayUi();
  try {
    const session: RefineSession = createRefineSession("reviewer", "p/m");
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), {
      markdown: PLAN,
      session,
      revision: 3,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    overlay.close({ action: "cancel", session });
    const outcome = await pending;
    assert.equal(outcome.action, "cancel");
    assert.equal(outcome.finalize, undefined);
    assert.equal(h.events.length, 0);
  } finally {
    h.dispose();
  }
});

test("an aborted parent signal does not fabricate a remote cancellation", async () => {
  const h = harness();
  const overlay = overlayUi();
  const controller = new AbortController();
  try {
    const pending = openRefinePanel(stubPi(), refineContextWith(overlay.ui), {
      markdown: PLAN,
      revision: 11,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const outcome = await pending;
    // The overlay resolves as cancel; the transport never emits its own terminal.
    assert.equal(outcome.action, "cancel");
    assert.equal(h.events.some((event) => event.type === "terminal"), false);
  } finally {
    h.dispose();
  }
});

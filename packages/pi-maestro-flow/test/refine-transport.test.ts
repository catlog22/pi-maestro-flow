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
  settle(result: { action: "apply" | "discard" | "cancel"; turnId?: string }): void;
  disposed: () => number;
  dispose(): void;
}

function harness(options?: { accept?: boolean }): Harness {
  const events: RefineTransportEvent[] = [];
  let request: RefineTransportRequest | undefined;
  let resolveHandle!: (value: { action: "apply" | "discard" | "cancel"; turnId?: string }) => void;
  const done = new Promise<{ action: "apply" | "discard" | "cancel"; turnId?: string }>((resolve) => {
    resolveHandle = resolve;
  });
  let cancelled = 0;
  const dispose = registerRefineTransport({
    open(incoming) {
      if (options?.accept === false) return undefined;
      request = incoming;
      return {
        promise: done,
        emit(event) { events.push(event); },
        finish(result) { resolveHandle(result); },
        cancel() { cancelled += 1; },
      };
    },
  });
  return {
    events,
    request: () => request,
    async actions(action) {
      assert.ok(request, "transport was never opened");
      await request.handleAction(action);
    },
    settle: (result) => resolveHandle(result),
    disposed: () => cancelled,
    dispose,
  };
}

function stubPi(): ExtensionAPI {
  return {
    on() { return () => {}; },
    ui: { notify() {} },
  } as unknown as ExtensionAPI;
}

const refineContext = {
  cwd: "/repo",
  hasUI: false,
  ui: { notify() {} },
  mode: "plan",
  model: { provider: "p", id: "m" },
  modelRegistry: {},
  isProjectTrusted: true,
  sessionManager: { getSessionId: () => "session-1" },
} as unknown as Parameters<typeof openRefinePanel>[1];

test("remote refine opens with an authoritative snapshot before any user action", async () => {
  const h = harness();
  try {
    const pending = openRefinePanel(stubPi(), refineContext, { markdown: PLAN, revision: 4 });
    await new Promise((resolve) => setImmediate(resolve));
    const types = h.events.map((event) => event.type);
    // status(ready) precedes the snapshot so a client that only understands
    // status still sees a well-formed handshake.
    assert.deepEqual(types, ["status", "status", "snapshot"]);
    const snapshot = h.events[2];
    assert.equal(snapshot?.type, "snapshot");
    if (snapshot?.type !== "snapshot") throw new Error("expected snapshot");
    assert.equal(snapshot.snapshot.revision, 4);
    assert.equal(snapshot.snapshot.highWaterSequence, 2);
    assert.equal(snapshot.snapshot.status, "ready");
    // Exact target and identity must be present for the transport relay.
    assert.equal(snapshot.snapshot.target.sessionId, "session-1");
    assert.equal(snapshot.snapshot.target.normalizedCwd, "/repo");
    assert.ok(snapshot.snapshot.refineSessionId.startsWith("refine:/repo:"));
    h.settle({ action: "cancel" });
    await pending;
  } finally {
    h.dispose();
  }
});

test("duplicate action ids are not executed twice and do not emit a second result", async () => {
  const h = harness();
  try {
    const pending = openRefinePanel(stubPi(), refineContext, { markdown: PLAN, revision: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const action: RefineTransportAction = {
      type: "snapshot_request",
      actionId: "a-1",
    };
    await h.actions(action);
    await h.actions(action);
    const snapshots = h.events.filter((event) => event.type === "snapshot");
    assert.equal(snapshots.length, 2, "one open snapshot plus one explicit request");
    const results = h.events.filter((event) => event.type === "action_result");
    assert.equal(results.length, 0, "snapshot_request carries no action result");
    h.settle({ action: "cancel" });
    await pending;
  } finally {
    h.dispose();
  }
});

test("apply is a presentation request only: the business terminal waits for finalize", async () => {
  const h = harness();
  try {
    const pending = openRefinePanel(stubPi(), refineContext, { markdown: PLAN, revision: 7 });
    await new Promise((resolve) => setImmediate(resolve));
    // No turn has been produced, so apply must be rejected as invalid state.
    await h.actions({ type: "apply", actionId: "a-apply", turnId: "turn-1" });
    const rejected = h.events.find((event) => event.type === "action_result");
    assert.equal(rejected?.type, "action_result");
    if (rejected?.type !== "action_result") throw new Error("expected action_result");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.errorCode, "invalid_state");
    assert.equal(h.events.some((event) => event.type === "terminal"), false);

    h.settle({ action: "cancel" });
    const outcome = await pending;
    // Local/TUI results never expose finalize; only remote apply would.
    assert.equal(outcome.action, "cancel");
  } finally {
    h.dispose();
  }
});

test("a session that is already terminal rejects further actions with session_terminal", async () => {
  const h = harness();
  try {
    const pending = openRefinePanel(stubPi(), refineContext, { markdown: PLAN, revision: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    await h.actions({ type: "cancel", actionId: "a-cancel" });
    assert.equal(h.events.some((event) => event.type === "terminal"), true);
    await h.actions({ type: "snapshot_request", actionId: "a-late" });
    const late = h.events.filter((event) => event.type === "action_result").at(-1);
    assert.equal(late?.type, "action_result");
    if (late?.type !== "action_result") throw new Error("expected action_result");
    assert.equal(late.errorCode, "session_terminal");
    h.settle({ action: "cancel" });
    await pending;
  } finally {
    h.dispose();
  }
});

test("without a registered transport the local TUI path is used unchanged", async () => {
  const h = harness({ accept: false });
  try {
    const session: RefineSession = createRefineSession("reviewer", "p/m");
    // The stub context has hasUI false, so the overlay resolves as cancel; this
    // still proves no remote transport intercepted the panel.
    const outcome = await openRefinePanel(stubPi(), refineContext, {
      markdown: PLAN,
      session,
      revision: 3,
    });
    assert.equal(outcome.action, "cancel");
    assert.equal(outcome.finalize, undefined);
    assert.equal(h.events.length, 0);
  } finally {
    h.dispose();
  }
});

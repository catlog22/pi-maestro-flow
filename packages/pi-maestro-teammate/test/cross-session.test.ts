import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { handleProxyRequest } from "../src/extension/index.ts";
import type { SessionMessageRequest, SessionMessageResult } from "../src/sessions/session-core.ts";
import {
  formatWorkspacePeerWindowListings,
  type WorkspacePeerWindowListing,
} from "../src/extension/workspace-peers.ts";
import { SessionSendOverlay, type SessionSelectionRow, type SessionSendOverlayResult } from "../src/tui/session-send-overlay.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

function row(overrides: Partial<SessionSelectionRow> = {}): SessionSelectionRow {
  return {
    correlationId: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "remote-window",
    agentRole: "window · 1 agents",
    status: "running",
    idleSeconds: 0,
    source: "remote:aaaaaa",
    kind: "window",
    ownerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bindable: true,
    ...overrides,
  };
}

test("session send overlay selects a peer window and submits the message", () => {
  let result: SessionSendOverlayResult | null | undefined;
  const overlay = new SessionSendOverlay({
    getSessions: () => [
      row({ correlationId: "local", displayName: "current", bindable: false, ownerId: "local", source: "local" }),
      row(),
    ],
    close: (value) => { result = value; },
  });
  overlay.setRequestRender(() => {});

  // Non-bindable local rows are removed from the picker. Select the peer,
  // enter the message, and submit it.
  overlay.handleInput(" ");
  const preview = overlay.render(120).join("\n");
  assert.match(preview, /remote-window.*id=aaaaaaaa/);
  assert.match(preview, /ID: owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);

  overlay.handleInput("\t");
  overlay.handleInput("check the deployment");
  overlay.handleInput("\r");

  assert.deepEqual(result, {
    target: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "check the deployment",
  });
});

test("session send overlay submits a canonical remote agent target", () => {
  let result: SessionSendOverlayResult | null | undefined;
  const target = "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:agent-correlation-id";
  const overlay = new SessionSendOverlay({
    getSessions: () => [row({
      correlationId: target,
      displayName: "audit-agent",
      agentRole: "reviewer",
      kind: "agent",
    })],
    close: (value) => { result = value; },
  });
  overlay.setRequestRender(() => {});

  overlay.handleInput(" ");
  assert.match(overlay.render(120).join("\n"), /ID: owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:agent-correlation-id/);
  overlay.handleInput("\t");
  overlay.handleInput("review the change");
  overlay.handleInput("\r");

  assert.deepEqual(result, { target, message: "review the change" });
});

test("session send overlay refuses an empty message and accepts portable Escape encodings", () => {
  for (const escape of ["\x1b", "\x1b[27u", "\x1b[27;1;27~"]) {
    let result: SessionSendOverlayResult | null | undefined;
    const overlay = new SessionSendOverlay({ getSessions: () => [row()], close: (value) => { result = value; } });
    overlay.setRequestRender(() => {});

    overlay.handleInput(" ");
    overlay.handleInput("\r");
    overlay.handleInput("\r");
    assert.equal(result, undefined, "empty message must not close the overlay");
    assert.match(overlay.render(100).join("\n"), /Enter a message first/);

    overlay.handleInput(escape);
    assert.equal(result, undefined, "editing Escape must return to the session picker");
    overlay.handleInput(escape);
    assert.equal(result, null, "top-level Escape must close the overlay");
  }
});

test("session send overlay accepts Kitty navigation, editing, and printable input", () => {
  let result: SessionSendOverlayResult | null | undefined;
  const overlay = new SessionSendOverlay({
    getSessions: () => [row(), row({ correlationId: "owner:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", displayName: "second-window" })],
    close: (value) => { result = value; },
  });
  overlay.setRequestRender(() => {});

  overlay.handleInput("\x1b[1;1B");
  overlay.handleInput("\x1b[32u");
  overlay.handleInput("\x1b[9u");
  overlay.handleInput("\x1b[104u");
  overlay.handleInput("\x1b[105u");
  overlay.handleInput("\x1b[13u");

  assert.deepEqual(result, {
    target: "owner:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    message: "hi",
  });
});

test("session send overlay keeps wide labels inside the frame", () => {
  const overlay = new SessionSendOverlay({
    getSessions: () => [row({ displayName: "审查窗口🚀", source: "远端" })],
    close: () => {},
  });
  const lines = overlay.render(40);
  assert.ok(lines.every((line) => visibleWidth(line) <= 40), lines.join("\n"));
});

function proxyState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
}

const pi = new Proxy({
  events: { on: () => () => {}, emit() {} },
  sendMessage() {},
}, {
  get(target, property) {
    if (property in target) return target[property as keyof typeof target];
    return () => {};
  },
}) as unknown as ExtensionAPI;

const WORKSPACE_LISTING: WorkspacePeerWindowListing = {
  target: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ownerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sessionName: "mw-dddddddddddddddddddddddddddddddd-review-window",
  displayName: "review-window",
  status: "running",
  agentCount: 1,
  activeAgents: [{
    role: "reviewer",
    name: "audit",
    status: "running",
    objective: "Check the release boundary",
    summary: "Reviewing delivery semantics",
  }],
  publishedAt: 1_000,
};

async function proxyWorkspace(
  tool: string,
  params: Record<string, unknown>,
  send?: (target: string, message: string, mode: "steer" | "follow_up") => Promise<boolean>,
  stateValue: TeammateState = proxyState(),
  sessionSend?: (request: SessionMessageRequest) => Promise<SessionMessageResult>,
  allowCrossSession = true,
  spawnedBy?: string,
): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> | undefined;
  await handleProxyRequest(
    pi,
    stateValue,
    { tool, requestId: `${tool}-workspace-request`, params },
    (message) => { response = message as Record<string, unknown>; },
    spawnedBy,
    [],
    undefined,
    undefined,
    {},
    undefined,
    send,
    async () => [WORKSPACE_LISTING],
    sessionSend,
    undefined,
    { authorizeCrossSession: () => allowCrossSession },
  );
  assert.ok(response);
  return response;
}

test("regular child proxy rejects cross-window list and observe but allows send", async () => {
  const deniedList = await proxyWorkspace(
    "teammate-list",
    { view: "windows" },
    undefined,
    proxyState(),
    undefined,
    false,
  );
  assert.equal((deniedList.result as { isError?: boolean }).isError, true);

  // Sending is not Monitor-gated: window discovery is, so a reachable
  // cross-window target id was either discovered in Monitor mode or carried
  // by an incoming workspace message (the non-Monitor reply path).
  let sendCalled = false;
  const allowedSend = await proxyWorkspace(
    "teammate-send",
    { to: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", message: "hello" },
    async () => {
      sendCalled = true;
      return true;
    },
    proxyState(),
    undefined,
    false,
  );
  assert.equal(sendCalled, true);
  assert.equal((allowedSend.result as { isError?: boolean }).isError, false);

  const deniedObserve = await proxyWorkspace(
    "observe",
    { action: "status", targets: [{ kind: "workspace", id: "review-window" }] },
    undefined,
    proxyState(),
    undefined,
    false,
  );
  assert.equal((deniedObserve.result as { isError?: boolean }).isError, true);
});

test("child proxy normalizes legacy status to coordination when routing to @root", async () => {
  let captured: SessionMessageRequest | undefined;
  const routed = await proxyWorkspace(
    "teammate-send",
    { to: "@root", message: "audit ready", kind: "status" },
    undefined,
    proxyState(),
    async (request) => {
      captured = request;
      return {
        delivered: true,
        transport: "local-root",
        receipt: {
          requestedMode: "steer",
          effectiveMode: "steer",
          deliveryStage: "injected",
        },
      };
    },
  );

  assert.equal(captured?.selector, "@root");
  assert.equal(captured?.messageKind, "coordination");
  assert.equal(captured?.mode, "steer");
  const result = routed.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(result.isError, false);
  assert.match(result.content?.[0]?.text ?? "", /injected.*root session/i);
});

test("child proxy blocks routine root coordination unless the dispatch explicitly authorizes it", async () => {
  const correlationId = "child-root-policy";
  const state = proxyState();
  const child = {
    agent: "explorer",
    correlationId,
    task: "Inspect the code and return one final result.",
    startedAt: 1,
    lastActivityAt: 1,
    status: "running",
    inbox: [],
    outputLog: [],
    abortController: new AbortController(),
    sleepMs: 0,
    depth: 0,
  } as ActiveAgent;
  state.activeRuns.set(correlationId, child);

  let deliveries = 0;
  const sessionSend = async (): Promise<SessionMessageResult> => {
    deliveries += 1;
    return { delivered: true, transport: "local-root" };
  };
  const denied = await proxyWorkspace(
    "teammate-send",
    { to: "@root", message: "incremental finding" },
    undefined,
    state,
    sessionSend,
    true,
    correlationId,
  );
  const deniedResult = denied.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(deniedResult.isError, true);
  assert.match(deniedResult.content?.[0]?.text ?? "", /Return findings in the final result/);
  assert.equal(deliveries, 0);

  child.task = "Report the consolidated answer with teammate-send to @root.";
  const authorized = await proxyWorkspace(
    "teammate-send",
    { to: "@root", message: "consolidated result" },
    undefined,
    state,
    sessionSend,
    true,
    correlationId,
  );
  assert.equal((authorized.result as { isError?: boolean }).isError, false);
  assert.equal(deliveries, 1);

  child.task = "Inspect the code and return one final result.";
  const blocker = await proxyWorkspace(
    "teammate-send",
    { to: "@root", message: "Need a user decision", kind: "request" },
    undefined,
    state,
    sessionSend,
    true,
    correlationId,
  );
  assert.equal((blocker.result as { isError?: boolean }).isError, false);
  assert.equal(deliveries, 2);
});

test("nested proxy dispatch preserves root session routing at deeper levels", async () => {
  const source = await readFile(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /workspacePeerSend,\s*workspacePeerList,\s*sessionSend,\s*\);/,
    "recursive handleProxyRequest must forward sessionSend so depth-3 children retain @root routing",
  );
});

test("root and child proxy window views share bounded contextual formatting", async () => {
  const listed = await proxyWorkspace("teammate-list", { view: "windows" });
  const listResult = listed.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(listResult.isError, false);
  assert.equal(listResult.content?.[0]?.text, formatWorkspacePeerWindowListings([WORKSPACE_LISTING]));
  assert.match(listResult.content?.[0]?.text ?? "", /name="review-window"/);
  assert.match(listResult.content?.[0]?.text ?? "", /name="audit" role="reviewer" status=running/);
  assert.match(listResult.content?.[0]?.text ?? "", /objective="Check the release boundary"/);
  assert.match(listResult.content?.[0]?.text ?? "", /summary="Reviewing delivery semantics"/);
  assert.match(listResult.content?.[0]?.text ?? "", /target=owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);

  const [rootSource, proxySource] = await Promise.all([
    readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf8"),
  ]);
  assert.match(rootSource, /formatWorkspacePeerWindowListings\(entries\)/);
  assert.match(proxySource, /formatWorkspacePeerWindowListings\(entries\)/);
  assert.match(rootSource, /triggerTurn: sessionMessageTriggersTurn\(effectiveMessageKind\)/);
  assert.match(rootSource, /messageKind: effectiveMessageKind,\s*preparedDelivery:/);
});

test("child proxy preserves queued delivery receipts and timeout ambiguity", async () => {
  const target = "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const queued = await proxyWorkspace(
    "teammate-send",
    { to: target, message: "report status", mode: "steer", kind: "status" },
    undefined,
    proxyState(),
    async (request) => {
      assert.equal(request.mode, "steer");
      assert.equal(request.messageKind, "coordination");
      return {
        delivered: true,
        receipt: {
          requestedMode: "steer",
          effectiveMode: "steer",
          deliveryStage: "queued",
          publicationStage: "accepted",
          messageId: "queued-message",
        },
      };
    },
  );
  const queuedResult = queued.result as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
    details?: { receipt?: { messageId?: string } };
  };
  assert.equal(queuedResult.isError, false);
  assert.match(queuedResult.content?.[0]?.text ?? "", /requested steer, effective steer/);
  assert.match(queuedResult.content?.[0]?.text ?? "", /may not yet be consumed; do not resend/);
  assert.equal(queuedResult.details?.receipt?.messageId, "queued-message");

  const timedOut = await proxyWorkspace(
    "teammate-send",
    { to: target, message: "correct the task", mode: "follow_up" },
    undefined,
    proxyState(),
    async () => ({
      delivered: false,
      error: "Timed out waiting for the peer.",
      receipt: { publicationStage: "published", messageId: "maybe-delivered" },
    }),
  );
  const timeoutResult = timedOut.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(timeoutResult.isError, true);
  assert.match(timeoutResult.content?.[0]?.text ?? "", /may still have been delivered/);
  assert.match(timeoutResult.content?.[0]?.text ?? "", /view=inbox before retrying/);
});

test("child proxy sends from a regular agent", async () => {
  const sent: Array<{ target: string; message: string; mode: string }> = [];
  const sendResult = await proxyWorkspace(
    "teammate-send",
    {
      to: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:remote-cid",
      message: "hello from a regular agent",
      mode: "follow_up",
    },
    async (target, message, mode) => {
      sent.push({ target, message, mode });
      return true;
    },
  );
  const result = sendResult.result as { isError?: boolean; details?: { delivered?: boolean }; content?: Array<{ text?: string }> };
  assert.equal(result.isError, false);
  assert.equal(result.details?.delivered, true);
  assert.deepEqual(sent, [{
    target: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:remote-cid",
    message: "hello from a regular agent",
    mode: "follow_up",
  }]);
});

test("child proxy prefers a local owner-prefixed agent name", async () => {
  const target = "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const localState = proxyState();
  const correlationId = "local-owner-prefixed";
  const now = Date.now();
  localState.namedAgents.set(target, correlationId);
  localState.activeRuns.set(correlationId, {
    agent: "general",
    name: target,
    correlationId,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
  } as never);

  let remoteCalled = false;
  const envelope = await proxyWorkspace(
    "teammate-send",
    { to: target, message: "local message", mode: "follow_up" },
    async () => {
      remoteCalled = true;
      return true;
    },
    localState,
  );
  const result = envelope.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(remoteCalled, false);
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /no restorable runtime/);
});

test("child proxy rejects cross-session abort", async () => {
  const resultEnvelope = await proxyWorkspace(
    "teammate-send",
    { to: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mode: "abort" },
    async () => true,
  );
  const result = resultEnvelope.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? "", /abort is local-only/);
});

test("child proxy routes local teammate-send through the session host callback", async () => {
  const localState = proxyState();
  const now = Date.now();
  localState.namedAgents.set("worker", "local-worker");
  localState.activeRuns.set("local-worker", {
    agent: "general",
    name: "worker",
    correlationId: "local-worker",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
  } as never);
  const routed: unknown[] = [];

  const envelope = await proxyWorkspace(
    "teammate-send",
    { to: "worker", message: "use the registry", mode: "follow_up" },
    undefined,
    localState,
    async (request) => {
      routed.push(request);
      return { delivered: true, receipt: { mode: "follow_up" } };
    },
  );
  const result = envelope.result as { isError?: boolean; details?: { delivered?: boolean } };
  assert.equal(result.isError, false);
  assert.equal(result.details?.delivered, true);
  assert.deepEqual(routed, [{
    selector: "worker",
    targetCorrelationId: "local-worker",
    senderCorrelationId: undefined,
    message: "use the registry",
    mode: "follow_up",
    messageKind: "coordination",
    provenance: {
      version: 1,
      messageId: "teammate-send-workspace-request",
      source: "session-router",
      messageKind: "coordination",
      deliveryMode: "follow_up",
      confidence: "verified",
      sender: {
        kind: "root-agent",
        ownerId: `process-${process.pid}`,
        label: "main",
      },
    },
  }]);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { handleProxyRequest } from "../src/extension/index.ts";
import { SessionSendOverlay, type SessionSendOverlayResult } from "../src/tui/session-send-overlay.ts";
import type { MonitorSessionRow } from "../src/tui/monitor-overlay.ts";
import type { TeammateState } from "../src/shared/types.ts";

function row(overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    correlationId: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "remote-window",
    agentRole: "window · 1 agents",
    status: "running",
    idleSeconds: 0,
    source: "remote:aaaaaa",
    bound: false,
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
  overlay.handleInput("\t");
  overlay.handleInput("check the deployment");
  overlay.handleInput("\r");

  assert.deepEqual(result, {
    target: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    message: "check the deployment",
  });
});

test("session send overlay refuses an empty message and supports cancellation", () => {
  let result: SessionSendOverlayResult | null | undefined;
  const overlay = new SessionSendOverlay({ getSessions: () => [row()], close: (value) => { result = value; } });
  overlay.setRequestRender(() => {});

  overlay.handleInput(" ");
  overlay.handleInput("\r");
  overlay.handleInput("\r");
  assert.equal(result, undefined, "empty message must not close the overlay");
  assert.match(overlay.render(100).join("\n"), /Enter a message first/);

  overlay.handleInput("\x1b");
  overlay.handleInput("\x1b");
  assert.equal(result, null);
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

async function proxyWorkspace(
  tool: string,
  params: Record<string, unknown>,
  send?: (target: string, message: string, mode: "steer" | "follow_up") => Promise<boolean>,
  stateValue: TeammateState = proxyState(),
  sessionSend?: (request: { selector: string; message: string; mode: "steer" | "follow_up" | "abort" }) => Promise<{
    delivered: boolean;
    error?: string;
    receipt?: { mode?: string; wasSleeping?: boolean; terminatedCount?: number };
  }>,
): Promise<Record<string, unknown>> {
  let response: Record<string, unknown> | undefined;
  await handleProxyRequest(
    pi,
    stateValue,
    { tool, requestId: `${tool}-workspace-request`, params },
    (message) => { response = message as Record<string, unknown>; },
    undefined,
    [],
    undefined,
    undefined,
    {},
    undefined,
    send,
    async () => [{
      target: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ownerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionName: "review-window",
      status: "running" as const,
      agentCount: 1,
      publishedAt: Date.now(),
    }],
    sessionSend,
  );
  assert.ok(response);
  return response;
}

test("child proxy lists peer windows and sends from a regular agent", async () => {
  const listed = await proxyWorkspace("teammate-list", { view: "windows" });
  const listResult = listed.result as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(listResult.isError, false);
  assert.match(listResult.content?.[0]?.text ?? "", /target=owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);

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
  const routed: Array<{ selector: string; message: string; mode: string }> = [];

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
  }]);
});

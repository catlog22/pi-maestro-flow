import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  cancelProxyDispatch,
  createChildProxyRequest,
  handleProxyRequest,
  killAgentTree,
  rejectAllChildProxyRequests,
  resolveChildProxyRequest,
  waitForTeammate,
  type ChildProxyPendingRequests,
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

function makeState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map<string, ActiveAgent>(),
    namedAgents: new Map<string, string>(),
  };
}

function addAgent(state: TeammateState, name: string, overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  const correlationId = overrides.correlationId ?? randomUUID();
  const now = Date.now();
  const agent: ActiveAgent = {
    agent: "worker",
    name,
    correlationId,
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
  state.activeRuns.set(correlationId, agent);
  state.namedAgents.set(name, correlationId);
  return agent;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for proxy test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// --- child side: giving up must be announced, not just local ---------------

test("a timed-out proxy request tells the root it gave up", async () => {
  const pending: ChildProxyPendingRequests = new Map();
  const sent: Array<Record<string, unknown>> = [];
  const requestId = randomUUID();

  await assert.rejects(
    createChildProxyRequest(
      pending,
      requestId,
      { type: "teammate_proxy_request", tool: "teammate", requestId },
      (message, callback) => { sent.push(message); callback(null); return true; },
      40,
    ),
    /timed out/,
  );

  const cancel = sent.find((m) => m.type === "teammate_proxy_cancel");
  assert.ok(cancel, "the root must learn the requester is gone");
  assert.equal(cancel.requestId, requestId);
  assert.equal(cancel.reason, "timeout");
  assert.equal(pending.size, 0);
});

test("an aborted proxy request also announces itself", async () => {
  const pending: ChildProxyPendingRequests = new Map();
  const sent: Array<Record<string, unknown>> = [];
  const requestId = randomUUID();
  const controller = new AbortController();

  const inFlight = createChildProxyRequest(
    pending,
    requestId,
    { type: "teammate_proxy_request", tool: "teammate", requestId },
    (message, callback) => { sent.push(message); callback(null); return true; },
    60_000,
    controller.signal,
  );
  controller.abort();

  await assert.rejects(inFlight, (error: Error) => error.name === "AbortError");
  assert.equal(sent.find((m) => m.type === "teammate_proxy_cancel")?.reason, "aborted");
});

test("session cleanup announces every abandoned proxy request", async () => {
  const pending: ChildProxyPendingRequests = new Map();
  const sent: Array<Record<string, unknown>> = [];
  const requestId = randomUUID();
  const inFlight = createChildProxyRequest(
    pending,
    requestId,
    { type: "teammate_proxy_request", tool: "teammate", requestId },
    (message, callback) => { sent.push(message); callback(null); return true; },
    60_000,
  );

  rejectAllChildProxyRequests(pending, new Error("session shutdown"));

  await assert.rejects(inFlight, /session shutdown/);
  assert.equal(sent.find((message) => message.type === "teammate_proxy_cancel")?.reason, "aborted");
  assert.equal(pending.size, 0);
});

test("a request answered in time announces nothing", async () => {
  const pending: ChildProxyPendingRequests = new Map();
  const sent: Array<Record<string, unknown>> = [];
  const requestId = randomUUID();

  const inFlight = createChildProxyRequest(
    pending,
    requestId,
    { type: "teammate_proxy_request", tool: "teammate", requestId },
    (message, callback) => { sent.push(message); callback(null); return true; },
    60_000,
  );
  // Through the real resolution path, which is also what clears the timer —
  // calling the raw resolve leaves it armed and holds the process open.
  assert.equal(resolveChildProxyRequest(pending, requestId, { ok: true }), true);
  await inFlight;

  assert.equal(sent.some((m) => m.type === "teammate_proxy_cancel"), false);
  assert.equal(pending.size, 0);
});

// --- root side: the announcement must actually tear the agent down ---------

test("cancelling a dispatch kills the agent it created and its subtree", () => {
  const state = makeState();
  const requestId = randomUUID();
  const nested = addAgent(state, "nested");
  const grandchild = addAgent(state, "grandchild", {
    spawnedBy: nested.correlationId,
    abortController: nested.abortController,
  });
  state.proxyDispatchByRequest = new Map([[requestId, nested.correlationId]]);
  const cancelledInteractions: string[] = [];
  state.cancelInteractions = (correlationId) => { cancelledInteractions.push(correlationId); };
  state.resultReadyNotified = new Set([nested.correlationId, grandchild.correlationId]);

  const killed = cancelProxyDispatch(state, requestId);
  assert.ok(killed.includes(nested.correlationId));
  assert.ok(killed.includes(grandchild.correlationId), "an orphaned subtree goes with it");
  assert.equal(state.proxyDispatchByRequest.size, 0);
  assert.deepEqual(new Set(cancelledInteractions), new Set([nested.correlationId, grandchild.correlationId]));
  assert.equal(state.recentlySettled?.get(nested.correlationId)?.status, "terminated");
  assert.equal(state.recentlySettled?.get(grandchild.correlationId)?.status, "terminated");
  assert.equal(state.resultReadyNotified.size, 0);
});

test("task abort follows descendants without expanding through controller identity", () => {
  const state = makeState();
  const task = addAgent(state, "task");
  const sibling = addAgent(state, "sibling", { abortController: task.abortController });
  const descendant = addAgent(state, "descendant", { spawnedBy: task.correlationId });
  const requestId = randomUUID();
  state.proxyDispatchByRequest = new Map([[requestId, descendant.correlationId]]);

  const killed = new Set(killAgentTree(state, task.correlationId));
  assert.deepEqual(killed, new Set([task.correlationId, descendant.correlationId]));
  assert.equal(state.activeRuns.has(sibling.correlationId), true);
  assert.equal(state.cancelledProxyDispatches?.get(requestId), descendant.correlationId);
});

test("an unknown or already-settled request cancels nothing", () => {
  const state = makeState();
  assert.deepEqual(cancelProxyDispatch(state, randomUUID()), []);

  // Registered but the agent already left: a late cancel must not reach
  // whatever else is running.
  const survivor = addAgent(state, "survivor");
  state.proxyDispatchByRequest = new Map([[randomUUID(), "already-gone"]]);
  assert.deepEqual(cancelProxyDispatch(state, [...state.proxyDispatchByRequest.keys()][0]), []);
  assert.equal(state.activeRuns.has(survivor.correlationId), true);
});

test("duplicate in-flight proxy requestId is rejected without replacing ownership", async () => {
  const state = makeState();
  const requestId = randomUUID();
  state.pendingProxyDispatchRequests = new Set([requestId]);
  const replies: any[] = [];
  await handleProxyRequest(
    {} as ExtensionAPI, state,
    { type: "teammate_proxy_request", tool: "teammate", requestId, params: {
      tasks: [{ agent: "general", prompt: "duplicate" }], background: true,
    } },
    (message) => replies.push(message), undefined, [],
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /duplicate in-flight/i);
  assert.equal(state.pendingProxyDispatchRequests.has(requestId), true);
});

test("cancelling during proxy admission prevents registration and spawn", async () => {
  const state = makeState();
  const requestId = randomUUID();
  const replies: unknown[] = [];
  let spawns = 0;

  const handling = handleProxyRequest(
    {} as ExtensionAPI,
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId,
      params: {
        tasks: [{ agent: "general", prompt: "must not launch" }],
        background: false,
      },
    },
    (message) => replies.push(message),
    undefined,
    [],
    undefined,
    undefined,
    {
      spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never,
    },
  );

  assert.equal(state.pendingProxyDispatchRequests?.has(requestId), true);
  assert.deepEqual(cancelProxyDispatch(state, requestId), []);
  await handling;

  assert.equal(spawns, 0);
  assert.equal(state.activeRuns.size, 0);
  assert.equal(state.proxyDispatchByRequest?.has(requestId) ?? false, false);
  assert.equal(state.pendingProxyDispatchRequests?.has(requestId) ?? false, false);
  assert.match(JSON.stringify(replies), /cancelled before launch/i);
});

test("nested fork proxy propagates a protocol-closed snapshot until background settlement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-fork-"));
  const sourcePath = path.join(root, "parent.jsonl");
  const spawningToolCallId = "nested-spawn-call";
  fs.writeFileSync(sourcePath, [
    { type: "session", version: 3, id: "parent-session", timestamp: new Date().toISOString(), cwd: root },
    {
      type: "message",
      id: "user-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "delegate" }] },
    },
    {
      type: "message",
      id: "spawning-entry",
      parentId: "user-entry",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: spawningToolCallId, name: "teammate", arguments: {} }],
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const state = makeState();
  const parent = addAgent(state, "parent", {
    correlationId: "parent-id",
    sessionFile: sourcePath,
    sessionId: "parent-session",
  });
  let stdout: PassThrough | undefined;
  let spawnedChild: ChildProcess | undefined;
  let propagatedParentSession: string | undefined;
  const spawnChildProcess = ((_command: string, _args: readonly string[], options: { env?: Record<string, string> }) => {
    const child = new EventEmitter() as ChildProcess;
    spawnedChild = child;
    stdout = new PassThrough();
    propagatedParentSession = options.env?.PI_TEAMMATE_PARENT_SESSION;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  let response: { result?: { isError?: boolean } } | undefined;

  try {
    await handleProxyRequest(
      new Proxy({ events: { on: () => () => {}, emit() {} }, sendMessage() {} }, {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => {};
        },
      }) as unknown as ExtensionAPI,
      state,
      {
        type: "teammate_proxy_request",
        tool: "teammate",
        requestId: "fork-background",
        spawningToolCallId,
        params: {
          tasks: [{ agent: "general", prompt: "nested work", context: "fork" }],
          background: true,
        },
      },
      (message) => { response = message as typeof response; },
      parent.correlationId,
      [],
      undefined,
      undefined,
      { spawnChildProcess },
    );

    await waitUntil(() => propagatedParentSession !== undefined);
    assert.equal(response?.result?.isError, false);
    assert.notEqual(propagatedParentSession, sourcePath);
    assert.equal(fs.existsSync(propagatedParentSession!), true, "background execution must retain its snapshot");
    const snapshotContent = fs.readFileSync(propagatedParentSession!, "utf8");
    assert.match(snapshotContent, /user-entry/);
    assert.doesNotMatch(snapshotContent, /spawning-entry|nested-spawn-call/);

    stdout!.write(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "nested done" }] },
    })}\n`);
    stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    stdout!.end();
    spawnedChild!.emit("exit", 0, null);
    spawnedChild!.emit("close", 0, null);
    await waitUntil(() => !fs.existsSync(propagatedParentSession!));
  } finally {
    stdout?.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested fork proxy fails closed without a spawning tool-call id", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-proxy-fork-invalid-"));
  const sourcePath = path.join(root, "parent.jsonl");
  fs.writeFileSync(sourcePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "parent-session",
    timestamp: new Date().toISOString(),
    cwd: root,
  })}\n`);
  const state = makeState();
  const parent = addAgent(state, "parent", { correlationId: "parent-id", sessionFile: sourcePath });
  const replies: Array<{ result?: { isError?: boolean; content?: Array<{ text?: string }> } }> = [];
  let spawns = 0;

  try {
    await handleProxyRequest(
      {} as ExtensionAPI,
      state,
      {
        type: "teammate_proxy_request",
        tool: "teammate",
        requestId: "fork-invalid",
        params: { tasks: [{ agent: "general", prompt: "nested work", context: "fork" }] },
      },
      (message) => replies.push(message as typeof replies[number]),
      parent.correlationId,
      [],
      undefined,
      undefined,
      { spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never },
    );
    assert.equal(spawns, 0);
    assert.equal(state.activeRuns.size, 1, "invalid fork admission must not mutate the agent registry");
    assert.equal(replies[0]?.result?.isError, true);
    assert.match(replies[0]?.result?.content?.[0]?.text ?? "", /fork-snapshot-invalid \(invalid-options\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- REL-5: a proxied wait must be interruptible ---------------------------

test("aborting the requester ends its proxied wait immediately", async () => {
  const state = makeState();
  const requester = addAgent(state, "requester");
  addAgent(state, "target");

  const waiting = waitForTeammate(
    state,
    { name: "target", timeoutMs: 60_000 },
    requester.abortController.signal,
  );
  requester.abortController.abort();

  assert.equal((await waiting).status, "aborted");
});

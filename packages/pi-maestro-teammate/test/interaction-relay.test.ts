import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createTeammateDirectChildRequestHandler,
  handleChildInteractionRequest,
  handleChildRpcUiRequest,
  resolveAgentCorrelationId,
  settleAgent,
} from "../src/extension/index.ts";
import { dispatchChildIpcMessage } from "../src/runs/execution.ts";
import {
  getTeammateChildExtensions,
  getTeammateChildToolBroker,
  getTeammatePermissionBroker,
  registerTeammateChildExtension,
  registerTeammateChildToolBroker,
  registerTeammatePermissionBroker,
} from "../src/runs/child-extensions.ts";
import type { ActiveAgent, TeammateState } from "../src/shared/types.ts";

function createState(): { state: TeammateState; agent: ActiveAgent } {
  const agent: ActiveAgent = {
    agent: "delegate",
    name: "reviewer",
    correlationId: "child-12345678",
    startedAt: Date.now(),
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: Date.now(),
    status: "running",
    sleepMs: 0,
  };
  return {
    agent,
    state: {
      baseCwd: "D:/workspace",
      currentSessionId: "main",
      activeRuns: new Map([[agent.correlationId, agent]]),
      namedAgents: new Map([[agent.name!, agent.correlationId]]),
    },
  };
}

function createPi() {
  const messages: unknown[] = [];
  const events: unknown[] = [];
  const pi = {
    sendMessage(message: unknown) { messages.push(message); },
    events: { emit(name: string, payload: unknown) { events.push({ name, payload }); } },
  } as unknown as ExtensionAPI;
  return { pi, messages, events };
}

test("teammate permission request is displayed, captured, and replied to", async () => {
  const { state, agent } = createState();
  const { pi, messages, events } = createPi();
  const replies: unknown[] = [];
  let promptTitle = "";
  const ctx = {
    hasUI: true,
    ui: {
      async select(title: string) {
        promptTitle = title;
        assert.equal(agent.pendingInteractions?.has("permission-1"), true);
        return "Always allow";
      },
    },
  } as unknown as ExtensionContext;

  await handleChildInteractionRequest(pi, state, {
    type: "teammate_interaction_request",
    requestId: "permission-1",
    interaction: "permission",
    correlationId: agent.correlationId,
    payload: {
      toolName: "bash",
      input: { command: "npm test" },
      reason: "Approval required",
      suggestion: "Bash(npm test)",
    },
  }, (message) => replies.push(message), ctx);

  assert.match(promptTitle, /@reviewer requests bash/);
  assert.equal(agent.pendingInteractions?.size, 0);
  assert.equal(messages.length, 1);
  assert.equal(events.length, 1);
  assert.deepEqual(replies, [{
    type: "teammate_interaction_response",
    requestId: "permission-1",
    result: { action: "always_allow" },
  }]);
});

test("teammate AskUserQuestion captures option and free-text answers", async () => {
  const { state, agent } = createState();
  const { pi } = createPi();
  const replies: any[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      async select(_title: string, options: string[]) { return options[0]; },
      async input() { return "Use the nearest region"; },
    },
  } as unknown as ExtensionContext;

  await handleChildInteractionRequest(pi, state, {
    type: "teammate_interaction_request",
    requestId: "question-1",
    interaction: "question",
    correlationId: agent.correlationId,
    payload: {
      questions: [
        {
          header: "Deploy",
          question: "Which strategy?",
          options: [{ label: "Preset", description: "Fast" }, { label: "Custom" }],
        },
        { header: "Notes", question: "Any constraints?" },
      ],
    },
  }, (message) => replies.push(message), ctx);

  assert.equal(replies[0].type, "teammate_interaction_response");
  assert.equal(replies[0].result.action, "answer");
  assert.deepEqual(replies[0].result.answers, [
    { question: "Which strategy?", header: "Deploy", selected: ["Preset"] },
    { question: "Any constraints?", header: "Notes", selected: [], text: "Use the nearest region" },
  ]);
});

test("child IPC dispatch treats teammate interactions as reply-capable requests", () => {
  const requests: unknown[] = [];
  const events: unknown[] = [];
  const message = { type: "teammate_interaction_request", requestId: "request-1" };
  const kind = dispatchChildIpcMessage(
    message,
    (event) => requests.push(event),
    (event) => events.push(event),
    () => undefined,
  );
  assert.equal(kind, "request");
  assert.deepEqual(requests, [message]);
  assert.deepEqual(events, []);
});

test("child IPC dispatch fails closed immediately when a direct runner omits its request handler", () => {
  const replies: any[] = [];
  const events: unknown[] = [];
  const permissionKind = dispatchChildIpcMessage(
    {
      type: "teammate_interaction_request",
      requestId: "missing-handler-permission",
      interaction: "permission",
    },
    undefined,
    (event) => events.push(event),
    (reply) => replies.push(reply),
  );
  const proxyKind = dispatchChildIpcMessage(
    { type: "teammate_proxy_request", requestId: "missing-handler-proxy", tool: "todo" },
    undefined,
    (event) => events.push(event),
    (reply) => replies.push(reply),
  );

  assert.equal(permissionKind, "request");
  assert.equal(proxyKind, "request");
  assert.equal(events.length, 2, "unhandled requests remain observable as lifecycle events");
  assert.equal(replies[0].result.action, "deny");
  assert.match(replies[0].result.reason, /no parent child-request handler/i);
  assert.equal(replies[1].result.isError, true);
});

test("headless main session denies permission interactions", async () => {
  const { state, agent } = createState();
  const { pi } = createPi();
  const replies: any[] = [];
  await handleChildInteractionRequest(pi, state, {
    type: "teammate_interaction_request",
    requestId: "permission-headless",
    interaction: "permission",
    correlationId: agent.correlationId,
    payload: { toolName: "write", input: { path: "src/app.ts" } },
  }, (message) => replies.push(message), { hasUI: false } as ExtensionContext);
  assert.equal(replies[0].result.action, "deny");
});

test("headless parent still runs the authoritative broker for silent allows", async () => {
  const { state, agent } = createState();
  const { pi, messages } = createPi();
  const replies: any[] = [];
  const unregister = registerTeammatePermissionBroker(async () => ({ action: "allow_once" }));
  try {
    await handleChildInteractionRequest(pi, state, {
      type: "teammate_interaction_request",
      requestId: "permission-headless-broker",
      interaction: "permission",
      correlationId: agent.correlationId,
      payload: {
        authorization: "parent",
        toolName: "read",
        input: { path: "README.md" },
      },
    }, (message) => replies.push(message), {
      hasUI: false,
      cwd: state.baseCwd,
    } as ExtensionContext);
    assert.equal(replies[0].result.action, "allow_once");
    assert.equal(messages.length, 0);
  } finally {
    unregister();
  }
});

test("direct execution child bridge replies to permissions and rejects nested proxy calls without hanging", async () => {
  const { pi } = createPi();
  const ctx = { hasUI: false, cwd: "D:/workspace" } as ExtensionContext;
  const unregister = registerTeammatePermissionBroker(async (request) => {
    assert.equal(request.toolName, "read");
    return { action: "allow_once" };
  });
  try {
    const handler = createTeammateDirectChildRequestHandler(pi, ctx);
    const permissionReply = await new Promise<any>((resolve) => handler({
      type: "teammate_interaction_request",
      requestId: "direct-permission",
      interaction: "permission",
      correlationId: "direct-child",
      payload: {
        authorization: "parent",
        toolName: "read",
        input: { path: "README.md" },
      },
    }, resolve));
    assert.deepEqual(permissionReply, {
      type: "teammate_interaction_response",
      requestId: "direct-permission",
      result: { action: "allow_once" },
    });

    const proxyReply = await new Promise<any>((resolve) => handler({
      type: "teammate_proxy_request",
      requestId: "direct-proxy",
      tool: "teammate",
      params: {},
    }, resolve));
    assert.equal(proxyReply.type, "teammate_proxy_result");
    assert.equal(proxyReply.requestId, "direct-proxy");
    assert.equal(proxyReply.result.isError, true);
  } finally {
    unregister();
  }
});

test("direct execution child bridge dispatches registered extension tools with trusted actor identity", async () => {
  const { pi } = createPi();
  const ctx = { hasUI: false, cwd: "D:/workspace" } as ExtensionContext;
  const { state, agent } = createState();
  const unregister = registerTeammateChildToolBroker("todo", async (request) => {
    assert.equal(request.input.subject, "Child task");
    assert.deepEqual(request.actor, {
      correlationId: agent.correlationId,
      name: agent.name,
      agent: agent.agent,
    });
    return {
      content: [{ type: "text", text: "created" }],
      details: { id: "todo-1" },
    };
  });
  try {
    const handler = createTeammateDirectChildRequestHandler(pi, ctx, { state });
    const reply = await new Promise<any>((resolve) => handler({
      type: "teammate_proxy_request",
      requestId: "direct-todo",
      correlationId: agent.correlationId,
      tool: "todo",
      params: { action: "create", subject: "Child task" },
    }, resolve));
    assert.equal(reply.type, "teammate_proxy_result");
    assert.equal(reply.result.content[0].text, "created");
  } finally {
    unregister();
  }
});

test("child extension registration replacement is generation-owned and old disposal cannot remove the replacement", () => {
  const path = "D:/extensions/flow.ts";
  const disposeOld = registerTeammateChildExtension(path, { tools: ["old-tool"] });
  const disposeCurrent = registerTeammateChildExtension(path, { tools: ["todo"] });

  assert.deepEqual(
    getTeammateChildExtensions().filter((registration) => registration.path === path),
    [{ path, tools: ["todo"] }],
  );
  disposeOld();
  assert.deepEqual(
    getTeammateChildExtensions().filter((registration) => registration.path === path),
    [{ path, tools: ["todo"] }],
  );
  disposeCurrent();
  assert.deepEqual(
    getTeammateChildExtensions().filter((registration) => registration.path === path),
    [],
  );
});

test("child tool broker rejects foreign collisions and same-owner replacement survives stale disposal", async () => {
  const first = async () => ({ content: [{ type: "text" as const, text: "first" }] });
  const current = async () => ({ content: [{ type: "text" as const, text: "current" }] });
  const disposeFirst = registerTeammateChildToolBroker("owned-test", first, { owner: "test-owner" });
  const disposeCurrent = registerTeammateChildToolBroker("owned-test", current, { owner: "test-owner" });

  assert.equal(getTeammateChildToolBroker("owned-test"), current);
  disposeFirst();
  assert.equal(getTeammateChildToolBroker("owned-test"), current);
  assert.throws(
    () => registerTeammateChildToolBroker("owned-test", first, { owner: "foreign-owner" }),
    /conflicting teammate child tool broker/i,
  );
  disposeCurrent();
  assert.equal(getTeammateChildToolBroker("owned-test"), undefined);
});

test("permission broker rejects foreign collisions and disposal restores fail-closed fallback", () => {
  const first = async () => ({ action: "allow_once" as const });
  const current = async () => ({ action: "deny" as const, reason: "current" });
  const disposeFirst = registerTeammatePermissionBroker(first, { owner: "test-permission-owner" });
  const disposeCurrent = registerTeammatePermissionBroker(current, { owner: "test-permission-owner" });

  assert.equal(getTeammatePermissionBroker(), current);
  disposeFirst();
  assert.equal(getTeammatePermissionBroker(), current);
  assert.throws(
    () => registerTeammatePermissionBroker(first, { owner: "foreign-permission-owner" }),
    /conflicting teammate permission broker/i,
  );
  disposeCurrent();
  assert.equal(getTeammatePermissionBroker(), undefined);
});

test("disposed child tool broker falls back immediately instead of retaining stale authority", async () => {
  const { pi } = createPi();
  const ctx = { hasUI: false, cwd: "D:/workspace" } as ExtensionContext;
  const dispose = registerTeammateChildToolBroker("ephemeral-test", async () => ({
    content: [{ type: "text", text: "handled" }],
  }));
  dispose();

  const handler = createTeammateDirectChildRequestHandler(pi, ctx);
  const reply = await new Promise<any>((resolve) => handler({
    type: "teammate_proxy_request",
    requestId: "disposed-proxy",
    tool: "ephemeral-test",
    params: {},
  }, resolve));
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /unavailable in this direct runtime/i);
});

test("official child RPC UI requests are answered through the parent dialog UI", async () => {
  const replies: unknown[] = [];
  await handleChildRpcUiRequest({
    type: "teammate_rpc_ui_request",
    id: "rpc-select-1",
    method: "select",
    title: "Choose",
    options: ["A", "B"],
  }, (message) => replies.push(message), {
    hasUI: true,
    ui: { async select() { return "B"; } },
  } as unknown as ExtensionContext);
  assert.deepEqual(replies, [{ type: "extension_ui_response", id: "rpc-select-1", value: "B" }]);
});

test("terminal failures are removed while successful agents remain wakeable by correlation ID", () => {
  const failed = createState();
  settleAgent(failed.state, failed.agent.correlationId, 1, "failed");
  assert.equal(failed.state.activeRuns.size, 0);
  assert.equal(failed.state.namedAgents.size, 0);

  const successful = createState();
  successful.state.namedAgents.clear();
  settleAgent(successful.state, successful.agent.correlationId, 0, "done");
  assert.equal(successful.agent.status, "sleeping");
  assert.equal(
    resolveAgentCorrelationId(successful.state, successful.agent.correlationId.slice(0, 8)),
    successful.agent.correlationId,
  );
});

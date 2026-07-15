import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  handleChildInteractionRequest,
  handleChildRpcUiRequest,
  resolveAgentCorrelationId,
  settleAgent,
} from "../src/extension/index.ts";
import { dispatchChildIpcMessage } from "../src/runs/execution.ts";
import { registerTeammatePermissionBroker } from "../src/runs/child-extensions.ts";
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

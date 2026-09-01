import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleChildInteractionRequest } from "pi-maestro-teammate/v1/extension";
import { dispatchChildIpcMessage } from "pi-maestro-teammate/v1/execution";
import { registerTeammatePermissionBroker } from "pi-maestro-teammate/v1/child-extensions";
import type { ActiveAgent, TeammateState } from "pi-maestro-teammate/v1/types";
import { requestTeammateInteraction } from "../src/permissions/teammate-relay.ts";

test("teammate relay reports synchronous IPC send failures explicitly", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
  process.env.PI_TEAMMATE_CHILD = "1";
  Object.defineProperty(process, "send", {
    configurable: true,
    value() { throw new Error("IPC channel closed"); },
  });
  try {
    const result = await requestTeammateInteraction("question", {}, 50);
    assert.deepEqual(result, {
      ok: false,
      reason: "send-failed",
      error: "IPC channel closed",
    });
  } finally {
    if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
    else delete (process as typeof process & { send?: unknown }).send;
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("teammate relay reports asynchronous IPC callback failures explicitly", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
  process.env.PI_TEAMMATE_CHILD = "1";
  Object.defineProperty(process, "send", {
    configurable: true,
    value(_message: unknown, callback: (error: Error | null) => void) {
      queueMicrotask(() => callback(new Error("IPC callback failed")));
      return true;
    },
  });
  try {
    const result = await requestTeammateInteraction("permission", {}, 50);
    assert.deepEqual(result, {
      ok: false,
      reason: "send-failed",
      error: "IPC callback failed",
    });
  } finally {
    if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
    else delete (process as typeof process & { send?: unknown }).send;
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("teammate relay reports response timeout separately from send failure", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
  process.env.PI_TEAMMATE_CHILD = "1";
  Object.defineProperty(process, "send", {
    configurable: true,
    value() { return true; },
  });
  const keepAlive = setTimeout(() => {}, 50);
  try {
    const result = await requestTeammateInteraction("question", {}, 5);
    assert.deepEqual(result, { ok: false, reason: "timeout" });
  } finally {
    clearTimeout(keepAlive);
    if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
    else delete (process as typeof process & { send?: unknown }).send;
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("teammate relay announces requestId cancellation before settling an abort", async () => {
  const previousChild = process.env.PI_TEAMMATE_CHILD;
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
  const sent: Array<Record<string, unknown>> = [];
  process.env.PI_TEAMMATE_CHILD = "1";
  Object.defineProperty(process, "send", {
    configurable: true,
    value(message: Record<string, unknown>) { sent.push(message); return true; },
  });
  const controller = new AbortController();
  try {
    const pending = requestTeammateInteraction("question", {}, 60_000, controller.signal);
    controller.abort();
    const cancellation = sent.at(-1);
    assert.equal(cancellation?.type, "teammate_proxy_cancel");
    assert.equal(cancellation?.requestId, sent[0]?.requestId);
    assert.equal(cancellation?.reason, "aborted");
    assert.deepEqual(await pending, { ok: false, reason: "aborted" });
    assert.equal(sent.filter((message) => message.type === "teammate_proxy_cancel").length, 1);
  } finally {
    if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
    else delete (process as typeof process & { send?: unknown }).send;
    if (previousChild === undefined) delete process.env.PI_TEAMMATE_CHILD;
    else process.env.PI_TEAMMATE_CHILD = previousChild;
  }
});

test("real teammate child IPC resumes permission and AskUserQuestion calls", async () => {
  const child = fork(new URL("./fixtures/teammate-interaction-child.ts", import.meta.url), {
    env: {
      ...process.env,
      PI_TEAMMATE_CHILD: "1",
      PI_TEAMMATE_CORRELATION_ID: "ipc-e2e-child",
    },
    execArgv: ["--experimental-transform-types"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  const exitPromise = once(child, "exit");
  const requests: Array<Record<string, unknown>> = [];
  const displayedMessages: unknown[] = [];
  const emittedEvents: unknown[] = [];
  const pendingWasVisible: boolean[] = [];
  const agent: ActiveAgent = {
    agent: "general",
    name: "ipc-reviewer",
    correlationId: "ipc-e2e-child",
    startedAt: Date.now(),
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: Date.now(),
    status: "running",
    sleepMs: 0,
  };
  const state: TeammateState = {
    baseCwd: process.cwd(),
    currentSessionId: "main",
    activeRuns: new Map([[agent.correlationId, agent]]),
    namedAgents: new Map([[agent.name!, agent.correlationId]]),
  };
  const pi = {
    sendMessage(message: unknown) { displayedMessages.push(message); },
    events: { emit(name: string, payload: unknown) { emittedEvents.push({ name, payload }); } },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      async select(title: string, options: string[]) {
        const currentRequest = requests.at(-1);
        pendingWasVisible.push(
          typeof currentRequest?.requestId === "string"
          && agent.pendingInteractions?.has(currentRequest.requestId) === true,
        );
        return title.includes("requests bash") ? "Allow once" : options[0];
      },
    },
  } as unknown as ExtensionContext;
  const unregisterBroker = registerTeammatePermissionBroker(async (request) => {
    const currentRequest = requests.at(-1);
    pendingWasVisible.push(
      typeof currentRequest?.requestId === "string"
      && agent.pendingInteractions?.has(currentRequest.requestId) === true,
    );
    assert.equal(request.toolName, "bash");
    assert.deepEqual(request.input, { command: "npm test" });
    return { action: "allow_once", updatedInput: { command: "npm test -- --runInBand" } };
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const fixtureStartupTimeoutMs = process.platform === "win32" ? 60_000 : 20_000;
    let timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for teammate fixture startup. ${stderr}`));
    }, fixtureStartupTimeoutMs);

    child.on("message", (message: unknown) => {
      dispatchChildIpcMessage(
        message as Record<string, unknown>,
        (request, reply) => {
          if (requests.length === 0) {
            clearTimeout(timer);
            timer = setTimeout(() => {
              reject(new Error(`Timed out waiting for teammate interaction replies. ${stderr}`));
            }, 5_000);
          }
          requests.push(request);
          void handleChildInteractionRequest(pi, state, request, reply, ctx)
            .then(() => {
              // A late duplicate must be ignored by the child's request map.
              reply({
                type: "teammate_interaction_response",
                requestId: request.requestId,
                result: { action: "deny" },
              });
            })
            .catch(reject);
        },
        (event) => {
          if (event.type !== "fixture_result") return;
          clearTimeout(timer);
          resolve(event);
        },
        (reply) => child.send(reply as never),
      );
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) return;
      clearTimeout(timer);
      reject(new Error(`Teammate fixture exited with code ${code}. ${stderr}`));
    });
  });

  try {
    const event = await result;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.interaction), ["permission", "question"]);
    assert.ok(requests.every((request) => request.correlationId === "ipc-e2e-child"));
    assert.deepEqual(pendingWasVisible, [true, true]);
    assert.equal(agent.pendingInteractions?.size, 0);
    assert.equal(displayedMessages.length, 1);
    assert.equal(emittedEvents.length, 2);
    assert.deepEqual(event.permission, {
      allowed: true,
      input: { command: "npm test -- --runInBand" },
    });
    assert.deepEqual(event.question, {
      answers: [{
        question: "Which strategy?",
        header: "Deploy",
        selected: ["Preset"],
      }],
    });
    await exitPromise;
  } finally {
    unregisterBroker();
    if (child.exitCode === null) child.kill();
  }
});

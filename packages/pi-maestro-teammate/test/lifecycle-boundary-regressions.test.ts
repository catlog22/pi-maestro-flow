import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension, {
  cancelProxyDispatch,
  enforceWakeableAgentBudget,
  handleProxyRequest,
  settleAgent,
  switchConversationSession,
  waitForTeammate,
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import {
  confirmParked,
  createChildLease,
  requestPark,
  transferToMain,
} from "../src/runs/session-handoff.ts";
import type { ActiveAgent, Details, TeammateState } from "../src/shared/types.ts";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Details;
};

type RegisteredTool = {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: Record<string, unknown>,
  ): Promise<ToolResult>;
};

function createHarness(runtimeOptions: TeammateRuntimeOptions = {}) {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
  let teammate: RegisteredTool | undefined;
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  const pi = new Proxy({
    events: {
      on() { return () => {}; },
      emit(event: string, payload: Record<string, unknown>) { emitted.push({ event, payload }); },
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      const entries = hooks.get(name) ?? [];
      entries.push(handler);
      hooks.set(name, entries);
      return () => {};
    },
    registerTool(tool: RegisteredTool & { name: string }) {
      if (tool.name === "teammate") teammate = tool;
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, command);
    },
    sendMessage() {},
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });
  registerTeammateExtension(pi as unknown as ExtensionAPI, runtimeOptions);
  assert.ok(teammate);
  return { teammate, emitted, hooks, commands };
}

function context(): Record<string, unknown> {
  return {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "test-session",
    },
  };
}

function resultReadyTurn(text: string): Record<string, unknown> {
  const message = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
  return { type: "turn_end", message, toolResults: [] };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createProxyPi(
  emitted: Array<{ event: string; payload: Record<string, unknown> }>,
  messages: Array<Record<string, unknown>> = [],
): ExtensionAPI {
  return new Proxy({
    events: {
      on() { return () => {}; },
      emit(event: string, payload: Record<string, unknown>) { emitted.push({ event, payload }); },
    },
    sendMessage(message: Record<string, unknown>) { messages.push(message); },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  }) as unknown as ExtensionAPI;
}

function createProxyState(): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: null,
    activeRuns: new Map(),
    namedAgents: new Map(),
  };
}

test("a terminal requester reclaims nested dispatches and pending admissions", () => {
  const state = createProxyState();
  const parentController = new AbortController();
  const nestedController = new AbortController();
  const now = Date.now();
  const parent: ActiveAgent = {
    agent: "general",
    correlationId: "parent",
    startedAt: now,
    abortController: parentController,
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
  };
  const nested: ActiveAgent = {
    agent: "general",
    correlationId: "nested",
    startedAt: now,
    abortController: nestedController,
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    spawnedBy: "parent",
    depth: 1,
    status: "running",
    sleepMs: 0,
  };
  state.activeRuns.set(parent.correlationId, parent);
  state.activeRuns.set(nested.correlationId, nested);
  state.pendingProxyDispatchRequests = new Set(["pending-request"]);
  state.pendingProxyDispatchParents = new Map([["pending-request", "parent"]]);
  state.proxyDispatchByRequest = new Map([["running-request", "nested"]]);

  settleAgent(state, "parent", 1, "parent failed", false);

  assert.equal(nestedController.signal.aborted, true);
  assert.equal(state.activeRuns.has("nested"), false);
  assert.equal(state.pendingProxyDispatchRequests.has("pending-request"), false);
  assert.equal(state.pendingProxyDispatchParents.has("pending-request"), false);
  assert.equal(state.proxyDispatchByRequest.has("running-request"), false);
  assert.equal(state.recentlySettled?.get("nested")?.status, "terminated");
});

test("failed graph tombstone does not pin sleeping sibling eviction", () => {
  const state = createProxyState();
  const graphController = new AbortController();
  const now = Date.now();
  const failed: ActiveAgent = {
    agent: "general", name: "failed", correlationId: "failed-task", startedAt: now - 10_000,
    abortController: new AbortController(), graphAbortController: graphController,
    inbox: [], outputLog: [], lastActivityAt: now - 10_000, failedAt: now,
    depth: 0, status: "failed", sleepMs: 0,
  };
  const sleeping: ActiveAgent = {
    agent: "general", name: "sleeping", correlationId: "sleeping-task", startedAt: now - 10_000,
    abortController: new AbortController(), graphAbortController: graphController,
    inbox: [], outputLog: [], lastActivityAt: 0, sleptAt: 0,
    depth: 0, status: "sleeping", sleepMs: 0,
  };
  state.activeRuns.set(failed.correlationId, failed);
  state.activeRuns.set(sleeping.correlationId, sleeping);

  assert.deepEqual(enforceWakeableAgentBudget(state, now), [sleeping.correlationId]);
  assert.equal(state.activeRuns.has(failed.correlationId), true);
  assert.equal(state.activeRuns.has(sleeping.correlationId), false);
});

test("root teammate rejects a pre-aborted dispatch before registration or spawn", async () => {
  let spawns = 0;
  const { teammate, emitted } = createHarness({
    spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never,
  });
  const controller = new AbortController();
  controller.abort();

  const result = await teammate.execute(
    "pre-abort",
    { tasks: [{ agent: "general", prompt: "do not run" }], background: false },
    controller.signal,
    undefined,
    context(),
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cancelled before start/i);
  assert.equal(spawns, 0);
  assert.equal(emitted.some(({ event }) => event === "teammate:started"), false);
  assert.equal(emitted.some(({ event }) => event === "teammate:complete"), false);
});

test("root graph budget rejection happens before registry mutation or spawn", async () => {
  const previous = process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
  process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = "1";
  let spawns = 0;
  try {
    const { teammate, emitted } = createHarness({
      spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never,
    });
    const result = await teammate.execute(
      "budget",
      {
        tasks: [
          { agent: "general", prompt: "first" },
          { agent: "general", prompt: "second" },
        ],
        background: false,
      },
      new AbortController().signal,
      undefined,
      context(),
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /2 more requested.*max 1/i);
    assert.equal(spawns, 0);
    assert.equal(emitted.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS;
    else process.env.PI_TEAMMATE_MAX_ACTIVE_AGENTS = previous;
  }
});

test("root emits complete only after result-ready receives lifecycle confirmation", async () => {
  let child: ChildProcess | undefined;
  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
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
    queueMicrotask(() => {
      stdout!.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ready" }] },
      })}\n`);
      stdout!.write(`${JSON.stringify(resultReadyTurn("ready"))}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({ spawnChildProcess, resultReadyGraceMs: 500 });

  const result = await teammate.execute(
    "result-ready",
    { tasks: [{ agent: "general", prompt: "answer" }], background: false },
    new AbortController().signal,
    undefined,
    context(),
  );

  assert.equal(result.details.results[0].lifecyclePending, true);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 0);

  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(40);

  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.exitCode, 0);
  assert.equal(completed[0].payload.wakeable, true);
});

test("root background spawn failure publishes one completion and clears live state", async () => {
  const { teammate, emitted } = createHarness({
    spawnChildProcess: (() => { throw new Error("spawn unavailable"); }) as never,
    onRunOptionsCreated(options) {
      options.waitForRetry = async () => false;
    },
  });

  const result = await teammate.execute(
    "background-spawn-failure",
    {
      tasks: [{ agent: "general", name: "spawn-failure", prompt: "fail" }],
      background: true,
    },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.equal(result.isError, false);

  await delay(100);
  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.exitCode, 1);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  assert.equal(
    [...state.activeRuns.values()].some((agent) =>
      agent.status === "running" || agent.status === "pending" || agent.status === "retrying"
    ),
    false,
  );
  assert.equal(
    [...state.activeRuns.values()].find((agent) => agent.name === "spawn-failure")?.status,
    "failed",
  );
});

test("root cycle rejection settles every graph task and aggregate without spawning", async () => {
  let spawns = 0;
  const { teammate, emitted } = createHarness({
    spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never,
  });

  const result = await teammate.execute(
    "cycle",
    {
      tasks: [
        { agent: "general", name: "left", prompt: "left", dependsOn: ["right"] },
        { agent: "general", name: "right", prompt: "right", dependsOn: ["left"] },
      ],
      background: false,
    },
    new AbortController().signal,
    undefined,
    context(),
  );

  assert.equal(result.isError, true);
  assert.equal(spawns, 0);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  assert.equal(
    [...state.activeRuns.values()].some((agent) =>
      agent.status === "running" || agent.status === "pending" || agent.status === "retrying"
    ),
    false,
  );
  assert.deepEqual(
    [...state.activeRuns.values()]
      .filter((agent) => agent.name === "left" || agent.name === "right")
      .map((agent) => agent.status)
      .sort(),
    ["failed", "failed"],
  );
});

test("mixed root graph settlement does not abort successful sibling controllers", async () => {
  let spawnIndex = 0;
  let graphSignal: AbortSignal | undefined;
  let taskSignals: AbortSignal[] = [];
  const spawnChildProcess = (() => {
    const index = spawnIndex++;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (index === 0) stdout.write(`${JSON.stringify(resultReadyTurn("successful sibling"))}\n`);
      else stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Invalid API key" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate } = createHarness({
    spawnChildProcess,
    onRunOptionsCreated(options) {
      graphSignal = options.signal;
      taskSignals = options.taskSignals ?? [];
    },
  });

  const result = await teammate.execute(
    "mixed-controller-scope",
    { tasks: [
      { agent: "general", name: "successful", prompt: "succeed" },
      { agent: "general", name: "failed", prompt: "fail" },
    ], background: false },
    new AbortController().signal,
    undefined,
    context(),
  );

  assert.equal(result.isError, true);
  assert.equal(taskSignals.length, 2);
  assert.equal(graphSignal?.aborted, false);
  assert.equal(taskSignals.every((signal) => !signal.aborted), true);
});

test("proxy single emits complete only after result-ready lifecycle confirmation", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const state = createProxyState();
  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
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
    queueMicrotask(() => stdout!.write(`${JSON.stringify(resultReadyTurn("nested ready"))}\n`));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const replies: unknown[] = [];

  await handleProxyRequest(
    createProxyPi(emitted),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "proxy-single",
      params: {
        tasks: [{ agent: "general", prompt: "answer" }],
        background: false,
      },
    },
    (message) => replies.push(message),
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess, resultReadyGraceMs: 500 },
  );

  assert.equal(replies.length, 1);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 0);

  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(40);

  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  assert.equal("id" in completed[0].payload, false, "nested IPC requestId is not a root tool-call id");
});

test("proxy graph waits for every terminal task and preserves physical lifecycle identity", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const state = createProxyState();
  const children: Array<{ child: ChildProcess; stdout: PassThrough; sessionId: string }> = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const sessionId = `physical-${children.length}`;
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
    children.push({ child, stdout, sessionId });
    queueMicrotask(() => {
      child.emit("message", { type: "teammate_session_ready", sessionId });
      stdout.write(`${JSON.stringify(resultReadyTurn(sessionId))}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const handling = handleProxyRequest(
    createProxyPi(emitted),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "proxy-graph",
      params: {
        tasks: [
          { agent: "general", name: "left", prompt: "left" },
          { agent: "general", name: "right", prompt: "right" },
        ],
        background: false,
      },
    },
    () => {},
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess, resultReadyGraceMs: 500 },
  );

  await delay(30);
  assert.equal(children.length, 2);
  assert.deepEqual(
    [...state.activeRuns.values()]
      .map((agent) => agent.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId))
      .sort(),
    ["physical-0", "physical-1"],
  );
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 0);

  children[0].stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(30);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 0);

  children[1].stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await handling;
  await delay(40);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
});

test("mixed nested graph settlement preserves successful sibling wakeability", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const state = createProxyState();
  let spawnIndex = 0;
  const spawnChildProcess = (() => {
    const index = spawnIndex++;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (index === 0) stdout.write(`${JSON.stringify(resultReadyTurn("nested success"))}\n`);
      else stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Invalid API key" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  await handleProxyRequest(
    createProxyPi(emitted), state,
    { type: "teammate_proxy_request", tool: "teammate", requestId: "nested-mixed", params: {
      tasks: [
        { agent: "general", name: "nested-success", prompt: "succeed" },
        { agent: "general", name: "nested-failure", prompt: "fail" },
      ],
      background: false,
    } },
    () => {}, undefined, [], undefined, undefined, { spawnChildProcess },
  );

  const successful = [...state.activeRuns.values()].find((agent) => agent.name === "nested-success");
  const failed = [...state.activeRuns.values()].find((agent) => agent.name === "nested-failure");
  // The reply lands at result publication; the success child's agent_end is a
  // separate event that settles its lifecycle shortly after.
  const deadline = Date.now() + 2_000;
  while (successful?.status !== "sleeping" && Date.now() < deadline) await delay(10);
  assert.equal(successful?.status, "sleeping");
  assert.equal(successful?.abortController.signal.aborted, false);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.abortController.signal.aborted, false);
});

test("cancelling a nested background dispatch fences late completion publication", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const state = createProxyState();
  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => stdout!.write(`${JSON.stringify(resultReadyTurn("late result"))}\n`));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const requestId = "cancelled-background";

  await handleProxyRequest(
    createProxyPi(emitted, messages), state,
    { type: "teammate_proxy_request", tool: "teammate", requestId, params: {
      tasks: [{ agent: "general", name: "late", prompt: "finish later" }], background: true,
    } },
    () => {}, undefined, [], undefined, undefined,
    { spawnChildProcess, resultReadyGraceMs: 500 },
  );

  await delay(30);
  assert.ok(state.proxyDispatchByRequest?.has(requestId));
  assert.equal(cancelProxyDispatch(state, requestId).length, 1);
  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(40);

  assert.equal(emitted.some(({ event }) => event === "teammate:complete"), false);
  assert.equal(messages.some((message) => message.customType === "teammate-complete"), false);
  assert.equal(state.cancelledProxyDispatches?.has(requestId) ?? false, false);
});

test("root retry cancellation records terminated state and a cancelled complete event", async () => {
  const controller = new AbortController();
  let spawns = 0;
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({
    spawnChildProcess,
    onRunOptionsCreated(options) {
      options.waitForRetry = async () => {
        controller.abort();
        return false;
      };
    },
  });

  const result = await teammate.execute(
    "retry-abort",
    { tasks: [{ agent: "general", name: "retrying", prompt: "retry" }], background: false },
    controller.signal,
    undefined,
    context(),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.results[0].terminalStatus, "terminated");
  assert.equal(spawns, 1);
  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.cancelled, true);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  assert.equal([...state.recentlySettled?.values() ?? []].find((entry) => entry.name === "retrying")?.status, "terminated");
});

test("root graph retry cancellation keeps aggregate event and registry terminal status aligned", async () => {
  const controller = new AbortController();
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({
    spawnChildProcess,
    onRunOptionsCreated(options) {
      options.waitForRetry = async () => {
        controller.abort();
        return false;
      };
    },
  });

  const result = await teammate.execute(
    "graph-retry-abort",
    {
      tasks: [
        { agent: "general", name: "retry-a", prompt: "retry a" },
        { agent: "general", name: "retry-b", prompt: "retry b" },
      ],
      background: false,
    },
    controller.signal,
    undefined,
    context(),
  );

  assert.equal(result.isError, false);
  assert.equal(result.details.results.every((entry) => entry.terminalStatus === "terminated"), true);
  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.cancelled, true);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  const aggregateId = completed[0].payload.correlationId as string;
  assert.equal(state.recentlySettled?.get(aggregateId)?.status, "terminated");
});

test("root DAG skip writes failed settled history for the never-spawned task", async () => {
  let spawns = 0;
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
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
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Invalid API key" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({ spawnChildProcess });

  const result = await teammate.execute(
    "dag-skip",
    {
      tasks: [
        { agent: "general", name: "seed", prompt: "fail" },
        { agent: "general", name: "dependent", prompt: "use {seed}", dependsOn: ["seed"] },
      ],
      background: false,
    },
    new AbortController().signal,
    undefined,
    context(),
  );

  assert.equal(result.isError, true);
  assert.equal(spawns, 1);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  assert.equal([...state.recentlySettled?.values() ?? []].find((entry) => entry.name === "dependent")?.status, "failed");
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
});

test("settled wait preserves terminated instead of reducing it", async () => {
  const state = createProxyState();
  state.recentlySettled = new Map([["terminated-agent", {
    correlationId: "terminated-agent", agent: "general", name: "cancelled",
    status: "terminated", settledAt: Date.now(), lastResult: "cancelled by requester",
  }]]);
  const result = await waitForTeammate(state, { name: "cancelled", timeoutMs: 100 });
  assert.equal(result.status, "terminated");
  assert.match(result.output.join("\n"), /already terminated/);
});

test("conversation switch treats a cancelled replacement as failure", async () => {
  let switched = false;
  await assert.rejects(
    switchConversationSession({
      async switchSession() { return { cancelled: true }; },
    }, "C:/sessions/agent.jsonl", () => { switched = true; }),
    /cancelled before replacement completed/i,
  );
  assert.equal(switched, false);
});

test("handoff shutdown is compensated when session replacement then fails", async () => {
  const { hooks, commands } = createHarness();
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  const controller = new AbortController();
  const lease = transferToMain(confirmParked(requestPark(createChildLease())));
  const agent: ActiveAgent = {
    agent: "general",
    name: "attached",
    correlationId: "attached-agent",
    startedAt: Date.now(),
    abortController: controller,
    inbox: [],
    outputLog: [],
    lastActivityAt: Date.now(),
    depth: 0,
    status: "running",
    sleepMs: 0,
    sessionFile: "C:/sessions/child.jsonl",
    lease,
    promptSeq: 1,
    sendControl: () => true,
  };
  state.activeRuns.set(agent.correlationId, agent);
  state.namedAgents.set(agent.name!, agent.correlationId);
  state.mainSessionFile = "C:/sessions/main.jsonl";
  const shutdown = hooks.get("session_shutdown")?.[0];
  const command = commands.get("teammate-session");
  assert.ok(shutdown);
  assert.ok(command);

  await assert.rejects(async () => command.handler("", {
    sessionManager: { getSessionFile: () => agent.sessionFile },
    waitForIdle: async () => {},
    ui: { notify() {} },
    async switchSession() {
      await shutdown();
      throw new Error("replacement failed after old session shutdown");
    },
  }), /replacement failed/);

  assert.equal(controller.signal.aborted, true);
  assert.equal(state.activeRuns.size, 0);
  assert.equal(state.namedAgents.size, 0);
  assert.equal(state.handoffSwitching, false);
  assert.equal(state.recentlySettled?.get(agent.correlationId)?.status, "terminated");
});

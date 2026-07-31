import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension, {
  handleProxyRequest,
  switchConversationSession,
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

function createProxyPi(emitted: Array<{ event: string; payload: Record<string, unknown> }>): ExtensionAPI {
  return new Proxy({
    events: {
      on() { return () => {}; },
      emit(event: string, payload: Record<string, unknown>) { emitted.push({ event, payload }); },
    },
    sendMessage() {},
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

  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
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

  await handleProxyRequest(
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
  await delay(40);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
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

  assert.equal(result.isError, true);
  assert.equal(spawns, 1);
  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.cancelled, true);
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  assert.equal([...state.recentlySettled?.values() ?? []].find((entry) => entry.name === "retrying")?.status, "terminated");
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

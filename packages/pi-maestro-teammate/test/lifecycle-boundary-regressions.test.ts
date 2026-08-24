import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTeammateExtension, {
  cancelProxyDispatch,
  enforceWakeableAgentBudget,
  handleProxyRequest,
  settleAgent,
  deferAgentContextMessage,
  takeDeferredAgentContext,
  restoreDeferredAgentContext,
  shouldPublishAdditionalTurn,
  switchConversationSession,
  waitForTeammate,
  type TeammateRuntimeOptions,
} from "../src/extension/index.ts";
import type { RunTeammateOptions } from "../src/runs/execution.ts";
import { createWorkspacePeerPaths, createWorkspacePeerRuntime } from "../src/extension/workspace-peers.ts";
import { getObservationProvider, registerObservationProvider } from "../src/public/v1/observation.ts";
import {
  confirmParked,
  createChildLease,
  requestPark,
  transferToMain,
} from "../src/runs/session-handoff.ts";
import type { ActiveAgent, AgentProgress, Details, SingleResult, TeammateState } from "../src/shared/types.ts";

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

type SpawnChildProcess = NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

function confirmFakeKills(spawnChildProcess: SpawnChildProcess): SpawnChildProcess {
  return ((...args: Parameters<SpawnChildProcess>) => {
    const child = spawnChildProcess(...args);
    const kill = child.kill.bind(child);
    child.kill = ((...killArgs: Parameters<ChildProcess["kill"]>) => {
      const killed = kill(...killArgs);
      if (killed && child.exitCode === null) {
        setImmediate(() => {
          if (child.exitCode !== null) return;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      }
      return killed;
    }) as ChildProcess["kill"];
    return child;
  }) as SpawnChildProcess;
}

function createHarness(runtimeOptions: TeammateRuntimeOptions = {}) {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ];
  if (runtimeOptions.spawnChildProcess) {
    runtimeOptions = {
      ...runtimeOptions,
      spawnChildProcess: confirmFakeKills(runtimeOptions.spawnChildProcess),
    };
  }
  let teammate: RegisteredTool | undefined;
  let teammateSend: RegisteredTool | undefined;
  let observeTool: { execute(...args: unknown[]): Promise<Record<string, any>> } | undefined;
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const messageOptions: Array<Record<string, unknown> | undefined> = [];
  const hooks = new Map<string, Array<(...args: any[]) => unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  let activeTools: string[] = [];
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
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
      if (tool.name === "teammate") teammate = tool;
      if (tool.name === "teammate-send") teammateSend = tool;
      if (tool.name === "observe") {
        observeTool = tool as unknown as { execute(...args: unknown[]): Promise<Record<string, any>> };
      }
    },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, command);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      messages.push(message);
      messageOptions.push(options);
    },
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
  });
  registerTeammateExtension(pi as unknown as ExtensionAPI, runtimeOptions);
  assert.ok(teammate);
  assert.ok(teammateSend);
  assert.ok(observeTool);
  return { teammate, teammateSend, observeTool, emitted, messages, messageOptions, hooks, commands };
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

/** Elastic wait: fixed sleeps race the loaded event loop under --test-concurrency. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await delay(10);
  }
}

test("immediate reload waits for workspace peer startup before shutdown cleanup", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-peer-reload-"));
  const { hooks } = createHarness();
  const sessionStart = hooks.get("session_start")?.[0];
  const sessionShutdown = hooks.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };

  try {
    const ctx = {
      cwd: project,
      hasUI: false,
      ui: { setWidget() {} },
      modelRegistry: { getAvailable: () => [] },
      sessionManager: {
        getEntries: () => [],
        getSessionFile: () => undefined,
        getSessionId: () => "peer-reload-session",
        getSessionName: () => "peer-reload",
      },
    };
    sessionStart({ reason: "new" }, ctx);
    await sessionShutdown({ reason: "reload" }, ctx);

    assert.equal(
      errors.some((args) => String(args[0]).includes("managed-window shutdown discovery failed")),
      false,
    );
    const ownersDir = createWorkspacePeerPaths(project).ownersDir;
    const ownerFiles = fs.existsSync(ownersDir)
      ? fs.readdirSync(ownersDir).filter((entry) => entry.endsWith(".json"))
      : [];
    assert.deepEqual(ownerFiles, []);
  } finally {
    console.error = originalError;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("root session publishes bounded assistant, tool, and lifecycle progress", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-root-progress-"));
  const { hooks } = createHarness();
  const sessionStart = hooks.get("session_start")?.[0];
  const sessionShutdown = hooks.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);
  const ctx = {
    cwd: project,
    hasUI: false,
    ui: { setWidget() {} },
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => undefined,
      getSessionId: () => "root-progress-session",
      getSessionName: () => "root-progress",
    },
  };
  let started = false;

  try {
    sessionStart({ reason: "new" }, ctx);
    started = true;
    const ownersDir = createWorkspacePeerPaths(project).ownersDir;
    let ownerFile: string | undefined;
    await waitFor(() => {
      const entries = fs.existsSync(ownersDir)
        ? fs.readdirSync(ownersDir).filter((entry) => entry.endsWith(".json"))
        : [];
      ownerFile = entries[0] ? path.join(ownersDir, entries[0]) : undefined;
      return ownerFile !== undefined;
    });
    assert.ok(ownerFile);

    hooks.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
    hooks.get("turn_start")?.[0]?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
    hooks.get("message_update")?.[0]?.({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", delta: "private thinking" },
    }, ctx);
    hooks.get("message_update")?.[0]?.({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_start" },
    }, ctx);
    hooks.get("message_update")?.[0]?.({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "working on the peer snapshot" },
    }, ctx);
    hooks.get("tool_execution_start")?.[0]?.({
      type: "tool_execution_start",
      toolCallId: "tool-progress-1",
      toolName: "read",
      args: { secret: "raw args must not publish" },
    }, ctx);
    hooks.get("tool_execution_end")?.[0]?.({
      type: "tool_execution_end",
      toolCallId: "tool-progress-1",
      toolName: "read",
      isError: false,
      result: { content: "raw result must not publish" },
    }, ctx);
    hooks.get("turn_end")?.[0]?.({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
    hooks.get("agent_end")?.[0]?.({ type: "agent_end", messages: [] }, ctx);
    hooks.get("agent_settled")?.[0]?.({ type: "agent_settled" }, ctx);

    let snapshot: Record<string, any> | undefined;
    await waitFor(() => {
      try {
        snapshot = JSON.parse(fs.readFileSync(ownerFile!, "utf8")) as Record<string, any>;
        return snapshot.mainProgress?.events?.at(-1)?.phase === "agent_settled";
      } catch {
        return false;
      }
    });
    const serialized = JSON.stringify(snapshot?.mainProgress);
    assert.match(serialized, /working on the peer snapshot/);
    assert.doesNotMatch(serialized, /private thinking|raw args must not publish|raw result must not publish/);
    assert.deepEqual(
      snapshot?.mainProgress.events.filter((event: Record<string, unknown>) => event.kind === "tool"),
      [
        { kind: "tool", at: snapshot?.mainProgress.events[3].at, toolCallId: "tool-progress-1", toolName: "read", status: "running" },
        { kind: "tool", at: snapshot?.mainProgress.events[4].at, toolCallId: "tool-progress-1", toolName: "read", status: "completed" },
      ],
    );
    assert.ok(snapshot?.mainProgress.events.length <= 16);
    assert.equal(
      snapshot?.mainProgress.sequence - snapshot?.mainProgress.baseCursor,
      snapshot?.mainProgress.events.length,
      "main progress publishes absolute cursor metadata for the retained ring",
    );
    assert.ok(snapshot?.mainProgress.sequence >= snapshot?.mainProgress.events.length);

    const sequenceBeforeRollover = snapshot?.mainProgress.sequence as number;
    for (let index = 0; index < 20; index += 1) {
      hooks.get("turn_start")?.[0]?.({ type: "turn_start", turnIndex: index + 1, timestamp: Date.now() }, ctx);
    }
    await waitFor(() => {
      try {
        snapshot = JSON.parse(fs.readFileSync(ownerFile!, "utf8")) as Record<string, any>;
        return snapshot.mainProgress?.sequence >= sequenceBeforeRollover + 20;
      } catch {
        return false;
      }
    });
    assert.equal(snapshot?.mainProgress.events.length, 16);
    assert.equal(snapshot?.mainProgress.baseCursor, snapshot?.mainProgress.sequence - 16);
    assert.ok(snapshot?.mainProgress.baseCursor > 0, "ring rollover advances the absolute base cursor");
  } finally {
    if (started) await sessionShutdown({ reason: "quit" }, ctx);
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("workspace observation wait honors result-ready, completion, timeout, abort, and root fences", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-workspace-observe-"));
  const { hooks, commands } = createHarness();
  const sessionStart = hooks.get("session_start")?.[0];
  const sessionShutdown = hooks.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);
  const now = Date.now();
  const worker = {
    correlationId: "workspace-observe-worker",
    name: "observer-worker",
    agent: "general",
    status: "running" as "running" | "sleeping",
    startedAt: now,
    lastActivityAt: now,
    resultReadyAt: undefined as number | undefined,
  };
  const peer = createWorkspacePeerRuntime({
    cwd: project,
    publishThrottleMs: 0,
    getState: () => ({ sessionName: "workspace-observe-peer", agents: [worker], settled: [] }),
  });
  const ctx = {
    cwd: project,
    hasUI: false,
    ui: {
      setWidget() {},
      setStatus() {},
      notify() {},
      onTerminalInput: () => () => {},
    },
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => undefined,
      getSessionId: () => "workspace-observe-root",
      getSessionName: () => "workspace-observe-root",
    },
  };

  let rootShutdown = false;
  try {
    sessionStart({ reason: "new" }, ctx);
    const monitorCommand = commands.get("monitor");
    assert.ok(monitorCommand);
    await monitorCommand.handler("", ctx);
    await peer.start();
    const provider = getObservationProvider("workspace");
    assert.ok(provider);
    const discoveryDeadline = Date.now() + 2_000;
    let discovered = await provider.snapshot(`owner:${peer.identity.ownerId}`, { detail: "summary", lines: 20 });
    while (!discovered.found && Date.now() < discoveryDeadline) {
      await delay(20);
      discovered = await provider.snapshot(`owner:${peer.identity.ownerId}`, { detail: "summary", lines: 20 });
    }
    assert.equal(discovered.found, true);

    const readyWait = provider.wait(`owner:${peer.identity.ownerId}`, {
      detail: "summary",
      lines: 20,
      deadline: Date.now() + 2_000,
      until: "result-ready",
      signal: new AbortController().signal,
    });
    await delay(25);
    worker.resultReadyAt = Date.now();
    await peer.publishNow();
    const ready = await readyWait;
    assert.equal(ready.waitStatus, "result-ready");
    assert.equal(ready.phase, "active");

    worker.resultReadyAt = undefined;
    await peer.publishNow();
    const completedWait = provider.wait(`owner:${peer.identity.ownerId}`, {
      detail: "summary",
      lines: 20,
      deadline: Date.now() + 2_000,
      until: "completed",
      signal: new AbortController().signal,
    });
    await delay(25);
    worker.status = "sleeping";
    await peer.publishNow();
    const completed = await completedWait;
    assert.equal(completed.waitStatus, "completed");
    assert.equal(completed.phase, "settled");

    worker.status = "running";
    await peer.publishNow();
    const timedOut = await provider.wait(`owner:${peer.identity.ownerId}`, {
      detail: "summary",
      lines: 20,
      deadline: Date.now() + 40,
      until: "completed",
      signal: new AbortController().signal,
    });
    assert.equal(timedOut.waitStatus, "timeout");
    assert.equal(timedOut.phase, "active");

    const abortController = new AbortController();
    const abortedWait = provider.wait(`owner:${peer.identity.ownerId}`, {
      detail: "summary",
      lines: 20,
      deadline: Date.now() + 2_000,
      until: "completed",
      signal: abortController.signal,
    });
    abortController.abort();
    assert.equal((await abortedWait).waitStatus, "aborted");

    const staleWait = provider.wait(`owner:${peer.identity.ownerId}`, {
      detail: "summary",
      lines: 20,
      deadline: Date.now() + 2_000,
      until: "completed",
      signal: new AbortController().signal,
    });
    await sessionShutdown({ reason: "reload" }, ctx);
    rootShutdown = true;
    const stale = await staleWait;
    assert.equal(stale.waitStatus, "aborted");
    assert.equal(stale.error, "stale-root-session");
  } finally {
    if (!rootShutdown) await sessionShutdown({ reason: "reload" }, ctx);
    await peer.stop();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

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

test("remote working locations are rejected without Monitor mode", async () => {
  const { teammate } = createHarness();
  const single = await teammate.execute(
    "remote-location",
    { tasks: [{ agent: "general", cwd: "remote:linux-a/pi", prompt: "run remotely" }] },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.equal(single.isError, true);
  assert.match(single.content[0].text, /require active Monitor mode/);
});

test("graph tasks reject remote working locations", async () => {
  let spawns = 0;
  const { teammate } = createHarness({
    spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never,
  });
  const graph = await teammate.execute(
    "graph-remote-location",
    { tasks: [
      { agent: "general", cwd: "remote:linux-a/pi", prompt: "one" },
      { agent: "general", prompt: "two" },
    ] },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.equal(graph.isError, true);
  assert.match(graph.content[0].text, /only single-task dispatches/);
  assert.equal(spawns, 0);
});

test("generic teammate dispatch rejects the reserved Monitor evaluator name", async () => {
  let spawns = 0;
  const { teammate } = createHarness({
    spawnChildProcess: (() => { spawns += 1; throw new Error("must not spawn"); }) as never,
  });

  const direct = await teammate.execute(
    "ordinary-monitor-name",
    { tasks: [{ agent: "general", name: "monitor-session", prompt: "claim authority" }] },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.equal(direct.isError, true);
  assert.match(direct.content[0].text, /reserved for the host-owned Monitor evaluator/);

  const graph = await teammate.execute(
    "graph-monitor-name",
    { tasks: [
      { agent: "general", name: "worker", prompt: "ordinary" },
      { agent: "general", name: "monitor-session", prompt: "claim authority" },
    ] },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.equal(graph.isError, true);
  assert.match(graph.content[0].text, /reserved for the host-owned Monitor evaluator/);
  assert.equal(spawns, 0);
});

test("non-Monitor observe rejects aliased providers before provider execution", async () => {
  let calls = 0;
  const unregister = registerObservationProvider({
    kind: "workspace-alias",
    capabilities: { inspect: true, wait: true },
    snapshot(id) {
      calls++;
      return {
        target: { kind: "workspace-alias", id },
        found: true,
        nativeStatus: "running",
        phase: "active",
        summary: "must not execute",
        updatedAt: Date.now(),
      };
    },
    async wait(id) {
      calls++;
      return {
        target: { kind: "workspace-alias", id },
        found: true,
        nativeStatus: "running",
        phase: "active",
        summary: "must not execute",
        updatedAt: Date.now(),
      };
    },
  });
  try {
    const { observeTool } = createHarness();
    const result = await observeTool.execute(
      "local-observe-alias",
      { action: "status", targets: [{ kind: "workspace-alias", id: "peer" }] },
      new AbortController().signal,
      undefined,
      context(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /only local teammate and bash_bg targets/);
    assert.equal(calls, 0);
  } finally {
    unregister();
  }
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
    assert.deepEqual(
      emitted.filter(({ event }) => event.startsWith("teammate:")),
      [],
      "budget rejection must not mutate teammate lifecycle state; extension-level settings discovery is independent",
    );
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

function structuredSpawn(value: unknown): NonNullable<TeammateRuntimeOptions["spawnChildProcess"]> {
  return (() => {
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
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "structured-call", name: "structured_output", arguments: value }],
        },
      })}\n`);
      stdout.write(`${JSON.stringify({
        type: "tool_execution_end",
        toolName: "structured_output",
        toolCallId: "structured-call",
        isError: false,
      })}\n`);
      stdout.write(`${JSON.stringify({
        type: "agent_end",
        message: { role: "assistant", content: [] },
      })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
}

const structuredSchema = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
};

test("background single completion carries structuredResults for agent:// persistence", async () => {
  const { teammate, emitted } = createHarness({ spawnChildProcess: structuredSpawn({ verdict: "ok" }) });

  const result = await teammate.execute(
    "bg-structured",
    {
      tasks: [{ agent: "general", name: "bg-worker", prompt: "structured", outputSchema: structuredSchema }],
      background: true,
    },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.equal(result.isError, false);

  await delay(60);
  const completed = emitted.filter(({ event }) => event === "teammate:complete");
  assert.equal(completed.length, 1);
  const payload = completed[0].payload as {
    structuredResults?: Array<{ correlationId: string; originCwd: string; name?: string; structuredOutput: unknown }>;
  };
  assert.ok(Array.isArray(payload.structuredResults) && payload.structuredResults.length === 1);
  assert.equal(payload.structuredResults[0].originCwd, process.cwd());
  assert.equal(payload.structuredResults[0].name, "bg-worker");
  assert.deepEqual(payload.structuredResults[0].structuredOutput, { verdict: "ok" });
  assert.equal(typeof payload.structuredResults[0].correlationId, "string");
});

test("background completion keeps the cwd captured at dispatch admission", async () => {
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
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({ spawnChildProcess });
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  const origin = process.cwd();
  state.baseCwd = origin;

  await teammate.execute(
    "bg-origin",
    {
      tasks: [{ agent: "general", name: "origin-worker", prompt: "structured", outputSchema: structuredSchema }],
      background: true,
    },
    new AbortController().signal,
    undefined,
    context(),
  );
  state.baseCwd = path.join(origin, "other-workspace");
  const value = { verdict: "ok" };
  stdout!.write(`${JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "origin-call", name: "structured_output", arguments: value }],
    },
  })}\n`);
  stdout!.write(`${JSON.stringify({
    type: "tool_execution_end",
    toolName: "structured_output",
    toolCallId: "origin-call",
    isError: false,
  })}\n`);
  stdout!.write(`${JSON.stringify({ type: "agent_end", message: { role: "assistant", content: [] } })}\n`);
  await delay(60);

  const completion = emitted.find(({ event }) => event === "teammate:complete");
  const result = (completion?.payload.structuredResults as Array<{ originCwd: string }> | undefined)?.[0];
  assert.equal(result?.originCwd, origin);
});

test("observe full detail returns the structured output of a settled schema success", async () => {
  const { teammate, observeTool } = createHarness({ spawnChildProcess: structuredSpawn({ verdict: "ok" }) });

  await teammate.execute(
    "bg-structured-2",
    {
      tasks: [{ agent: "general", name: "observe-worker", prompt: "structured", outputSchema: structuredSchema }],
      background: true,
    },
    new AbortController().signal,
    undefined,
    context(),
  );
  await delay(60);

  const snap = await observeTool!.execute(
    "observe-1",
    { action: "status", targets: [{ kind: "teammate", id: "observe-worker" }], detail: "full", lines: 20 },
    new AbortController().signal,
    undefined,
    context(),
  );
  const observation = snap.details.result.observations[0] as {
    nativeStatus: string;
    terminalStatus?: string;
    waitStatus?: string;
    structuredOutput?: unknown;
  };
  assert.equal(observation.nativeStatus, "completed");
  assert.equal(observation.terminalStatus, "completed");
  assert.deepEqual(observation.structuredOutput, { verdict: "ok" });
  const output = (snap.details.output as string[]).join("\n");
  assert.match(output, /--- structured output ---/);
  assert.match(output, /"verdict": "ok"/);

  // Public snapshots are independent clones; mutating one cannot alter owner state.
  (observation.structuredOutput as { verdict: string }).verdict = "mutated";
  const compact = await observeTool!.execute(
    "observe-summary",
    { action: "status", targets: [{ kind: "teammate", id: "observe-worker" }], detail: "summary", lines: 20 },
    new AbortController().signal,
    undefined,
    context(),
  );
  const compactObservation = compact.details.result.observations[0] as Record<string, unknown>;
  assert.equal(Object.hasOwn(compactObservation, "structuredOutput"), false);
  assert.equal(Object.hasOwn(compactObservation, "lastResult"), false);
  assert.equal(Object.hasOwn(compactObservation, "detail"), false);
  assert.doesNotMatch((compact.details.output as string[]).join("\n"), /structured output/);

  const tail = await observeTool!.execute(
    "observe-tail",
    { action: "status", targets: [{ kind: "teammate", id: "observe-worker" }], detail: "tail", lines: 20 },
    new AbortController().signal,
    undefined,
    context(),
  );
  const tailObservation = tail.details.result.observations[0] as { structuredOutput?: unknown };
  assert.deepEqual(tailObservation.structuredOutput, { verdict: "ok" });
  const tailOutput = (tail.details.output as string[]).join("\n");
  assert.equal(tailOutput.match(/--- structured output ---/g)?.length, 1);

  const waited = await observeTool!.execute(
    "observe-wait-summary",
    {
      action: "wait",
      targets: [{ kind: "teammate", id: "observe-worker" }],
      detail: "summary",
      until: "completed",
      timeoutMs: 1_000,
    },
    new AbortController().signal,
    undefined,
    context(),
  );
  const waitedObservation = waited.details.result.observations[0] as Record<string, unknown>;
  assert.equal(Object.hasOwn(waitedObservation, "structuredOutput"), false);
  assert.equal(Object.hasOwn(waitedObservation, "detail"), false);
});

test("observe projects a wakeable failed agent as sleeping activity with failed terminal outcome", async () => {
  const { observeTool } = createHarness();
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  const now = Date.now();
  const cid = "sleep-failed-cid";
  state.activeRuns.set(cid, {
    agent: "worker",
    name: "sleep-failed",
    correlationId: cid,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "sleeping",
    sleepMs: 0,
    depth: 0,
    lastOutcome: { status: "failed", message: "boom", settledAt: now },
    lastResult: "boom",
  });
  state.namedAgents.set("sleep-failed", cid);

  const snap = await observeTool!.execute(
    "observe-2",
    { action: "status", targets: [{ kind: "teammate", id: "sleep-failed" }], detail: "full", lines: 20 },
    new AbortController().signal,
    undefined,
    context(),
  );
  const observation = snap.details.result.observations[0] as {
    nativeStatus: string;
    terminalStatus?: string;
    waitStatus?: string;
    outcome?: string;
  };
  assert.equal(observation.nativeStatus, "sleeping", "activity stays sleeping (wakeable)");
  assert.equal(observation.waitStatus, "failed");
  assert.equal(observation.terminalStatus, "failed");
  assert.equal(observation.outcome, "failure");
});

test("warm wake publishes every subsequent turn completion", async () => {
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
    queueMicrotask(() => {
      stdout!.write(`${JSON.stringify(resultReadyTurn("first turn"))}\n`);
      stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, teammateSend, emitted, messages } = createHarness({ spawnChildProcess });
  const ctx = context();

  await teammate.execute(
    "warm-root",
    { tasks: [{ agent: "general", name: "warm-worker", prompt: "first" }], background: false },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await waitFor(() => emitted.filter(({ event }) => event === "teammate:complete").length >= 1);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);

  const sent = await teammateSend.execute(
    "warm-send",
    { to: "warm-worker", message: "second", mode: "follow_up" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(sent.isError, false);
  stdout!.write(`${JSON.stringify({ type: "turn_start" })}\n`);
  stdout!.write(`${JSON.stringify(resultReadyTurn("second turn"))}\n`);
  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await waitFor(() => emitted.filter(({ event }) => event === "teammate:complete").length >= 2);

  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 2);
  assert.ok(
    messages.some((message) =>
      message.customType === "teammate-complete"
      && typeof message.content === "string"
      && message.content.endsWith("second turn")
    ),
    `expected second-turn completion message, got ${JSON.stringify(messages)}`,
  );
});

test("empty warm turn emits lifecycle completion without another model notification", async () => {
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
    queueMicrotask(() => {
      stdout!.write(`${JSON.stringify(resultReadyTurn("first turn"))}\n`);
      stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, teammateSend, emitted, messages } = createHarness({ spawnChildProcess });
  const ctx = context();

  await teammate.execute(
    "empty-warm-root",
    { tasks: [{ agent: "workflow-nyquist-auditor", name: "empty-warm-worker", prompt: "first" }], background: false },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await waitFor(() => emitted.filter(({ event }) => event === "teammate:complete").length >= 1);

  const sent = await teammateSend.execute(
    "empty-warm-send",
    { to: "empty-warm-worker", message: "record context", mode: "follow_up" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(sent.isError, false);
  stdout!.write(`${JSON.stringify({ type: "turn_start" })}\n`);
  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await waitFor(() => emitted.filter(({ event }) => event === "teammate:complete").length >= 2);

  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 2);
  assert.equal(
    messages.some((message) =>
      message.customType === "teammate-complete"
      && typeof message.content === "string"
      && /\(no output\)$/.test(message.content)
    ),
    false,
    JSON.stringify(messages),
  );
});

test("model-originated status is normalized to coordination and starts a turn", async () => {
  let stdin: PassThrough | undefined;
  const control: string[] = [];
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdin = new PassThrough();
    stdin.on("data", (chunk) => control.push(String(chunk)));
    Object.assign(child, {
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, teammateSend } = createHarness({ spawnChildProcess });
  const ctx = context();

  await teammate.execute(
    "status-context-root",
    { tasks: [{ agent: "general", name: "status-worker", prompt: "wait" }], background: true },
    new AbortController().signal,
    undefined,
    ctx,
  );
  const status = await teammateSend.execute(
    "status-context",
    { to: "status-worker", message: "audit ready", kind: "status" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(status.isError, false);
  assert.doesNotMatch(status.content[0]?.text ?? "", /stored as context/i);
  await waitFor(() => control.join("").includes("audit ready"));

  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  const correlationId = state.namedAgents.get("status-worker");
  assert.ok(correlationId);
  assert.equal(state.activeRuns.get(correlationId)?.deferredContextMessages, undefined);

  await teammateSend.execute(
    "status-context-abort",
    { to: "status-worker", mode: "abort" },
    new AbortController().signal,
    undefined,
    ctx,
  );
});

test("deferred status context is bounded and reserved atomically", () => {
  const agent = { deferredContextMessages: undefined } as unknown as ActiveAgent;
  deferAgentContextMessage(agent, "x".repeat(40_000));
  assert.equal(agent.deferredContextMessages?.length, 1);
  assert.ok((agent.deferredContextMessages?.[0]?.content.length ?? 0) <= 32_000);
  assert.match(agent.deferredContextMessages?.[0]?.content ?? "", /status context truncated/);

  const firstDelivery = takeDeferredAgentContext(agent);
  assert.equal(agent.deferredContextMessages, undefined);
  assert.equal(takeDeferredAgentContext(agent).length, 0, "a concurrent delivery cannot reserve the same context twice");
  deferAgentContextMessage(agent, "newer status");
  restoreDeferredAgentContext(agent, firstDelivery);
  const restored = ((value: ActiveAgent) => value.deferredContextMessages ?? [])(agent);
  assert.equal(restored.length, 2);
  assert.match(restored[0]?.content ?? "", /status context truncated/);
  assert.equal(restored[1]?.content, "newer status");

  const durableAgent = { deferredContextMessages: undefined } as unknown as ActiveAgent;
  const expectedIds = Array.from({ length: 17 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
  );
  expectedIds.forEach((messageId, index) => {
    deferAgentContextMessage(durableAgent, `status ${index}`, messageId);
  });
  assert.equal(durableAgent.deferredContextMessages?.length, 16);
  const retainedIds = (durableAgent.deferredContextMessages ?? []).flatMap((entry) => [
    ...(entry.messageId === undefined ? [] : [entry.messageId]),
    ...(entry.messageIds ?? []),
  ]);
  assert.deepEqual(new Set(retainedIds), new Set(expectedIds));
});

test("empty successful additional turns do not need a model notification", () => {
  const base = {
    exitCode: 0,
    terminalStatus: "completed",
    messages: [],
  } as unknown as SingleResult;
  assert.equal(shouldPublishAdditionalTurn(base), false);
  assert.equal(shouldPublishAdditionalTurn({
    ...base,
    messages: [{ role: "assistant", content: "updated" }],
  }), true);
  assert.equal(shouldPublishAdditionalTurn({
    ...base,
    messages: [{ role: "system", content: "diagnostic" }],
  }), true);
  const knownWarnings = new Set(["provider warning"]);
  assert.equal(shouldPublishAdditionalTurn({ ...base, warnings: ["provider warning"] }, knownWarnings), false);
  assert.equal(shouldPublishAdditionalTurn({ ...base, warnings: ["new warning"] }, knownWarnings), true);
  assert.equal(shouldPublishAdditionalTurn({ ...base, warnings: ["new warning"] }, knownWarnings), false);
  const multiWarningSet = new Set<string>();
  assert.equal(shouldPublishAdditionalTurn({ ...base, warnings: ["warning A", "warning B"] }, multiWarningSet), true);
  assert.deepEqual(multiWarningSet, new Set(["warning A", "warning B"]));
  assert.equal(shouldPublishAdditionalTurn({ ...base, warnings: ["warning A", "warning B"] }, multiWarningSet), false);
  assert.equal(shouldPublishAdditionalTurn({ ...base, exitCode: 1, terminalStatus: "failed" }), true);
});

test("closed runtime cold-resumes the same logical agent from its persisted session", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-cold-resume-"));
  const parentSession = path.join(tempDir, "parent.jsonl");
  fs.writeFileSync(parentSession, "{}\n");
  const spawnArgs: string[][] = [];
  const children: ChildProcess[] = [];
  const runOptions: RunTeammateOptions[] = [];
  let checkpoint = "";

  const spawnChildProcess = ((_command: string, args: string[]) => {
    spawnArgs.push([...args]);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: true,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      send(_message: unknown, callback?: (error: Error | null) => void) {
        callback?.(null);
        return true;
      },
      kill() { return true; },
    });
    children.push(child);
    queueMicrotask(() => {
      const sessionDir = args[args.indexOf("--session-dir") + 1];
      fs.mkdirSync(sessionDir, { recursive: true });
      checkpoint ||= path.join(sessionDir, "child.jsonl");
      fs.writeFileSync(checkpoint, "{}\n");
      child.emit("message", {
        type: "teammate_session_ready",
        sessionId: `child-${children.length}`,
        sessionFile: checkpoint,
      });
      stdout.write(`${JSON.stringify(resultReadyTurn(children.length === 1 ? "first" : "restored"))}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  try {
    const { teammate, teammateSend } = createHarness({
      spawnChildProcess,
      resultReadyGraceMs: 500,
      onRunOptionsCreated(options) { runOptions.push(options); },
    });
    const ctx = {
      ...context(),
      sessionManager: {
        getSessionFile: () => parentSession,
        getSessionId: () => "parent-session",
      },
    };
    const first = await teammate.execute(
      "cold-root",
      { tasks: [{ agent: "general", name: "cold-worker", prompt: "first" }], background: false },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(first.details.results[0].correlationId.length > 0, true);
    const logicalId = first.details.results[0].correlationId;

    Object.assign(children[0], { exitCode: 0 });
    children[0].emit("exit", 0, null);
    children[0].emit("close", 0, null);

    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ] as TeammateState;
    await waitFor(() => state.activeRuns.get(logicalId)?.status === "sleeping");
    const cold = state.activeRuns.get(logicalId);
    assert.equal(cold?.status, "sleeping");
    assert.equal(cold?.stdin, undefined);
    assert.equal(cold?.sessionFile, checkpoint);

    const delivery = await teammateSend.execute(
      "cold-send",
      { to: "cold-worker", message: "continue after close", mode: "follow_up" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(delivery.isError, false);
    assert.equal(spawnArgs.length, 2);
    const resumeArgs = spawnArgs[1];
    assert.equal(resumeArgs[resumeArgs.indexOf("--session") + 1], checkpoint);
    assert.equal(state.namedAgents.get("cold-worker"), logicalId);
    assert.equal(state.activeRuns.get(logicalId)?.runtimeGeneration, 2);
    const replacementStdin = state.activeRuns.get(logicalId)?.stdin;
    runOptions[0].onChildClosed?.(logicalId, 1, { code: 1, signal: null, settled: true });
    assert.equal(state.activeRuns.get(logicalId)?.runtimeGeneration, 2);
    assert.equal(state.activeRuns.get(logicalId)?.stdin, replacementStdin, "stale close cannot detach replacement runtime");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cold-resume failure restores deferred durable context", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teammate-cold-resume-failure-"));
  const parentSession = path.join(tempDir, "parent.jsonl");
  fs.writeFileSync(parentSession, "{}\n");
  let child: ChildProcess | undefined;
  let spawnCount = 0;
  let checkpoint = "";
  const spawnChildProcess = ((_command: string, args: string[]) => {
    spawnCount += 1;
    if (spawnCount > 1) throw new Error("resume spawn failed");
    child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: true,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      send(_message: unknown, callback?: (error: Error | null) => void) {
        callback?.(null);
        return true;
      },
      kill() { return true; },
    });
    queueMicrotask(() => {
      const sessionDir = args[args.indexOf("--session-dir") + 1];
      fs.mkdirSync(sessionDir, { recursive: true });
      checkpoint = path.join(sessionDir, "child.jsonl");
      fs.writeFileSync(checkpoint, "{}\n");
      child!.emit("message", {
        type: "teammate_session_ready",
        sessionId: "cold-failure-child",
        sessionFile: checkpoint,
      });
      stdout.write(`${JSON.stringify(resultReadyTurn("first"))}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  try {
    const { teammate, teammateSend } = createHarness({
      spawnChildProcess,
      resultReadyGraceMs: 500,
      onRunOptionsCreated(options) { options.waitForRetry = async () => false; },
    });
    const ctx = {
      ...context(),
      sessionManager: {
        getSessionFile: () => parentSession,
        getSessionId: () => "parent-session",
      },
    };
    const first = await teammate.execute(
      "cold-failure-root",
      { tasks: [{ agent: "general", name: "cold-failure-worker", prompt: "first" }], background: false },
      new AbortController().signal,
      undefined,
      ctx,
    );
    const logicalId = first.details.results[0].correlationId;
    Object.assign(child!, { exitCode: 0 });
    child!.emit("exit", 0, null);
    child!.emit("close", 0, null);

    const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
      Symbol.for("pi-maestro-teammate.root-registry")
    ] as TeammateState;
    await waitFor(() => state.activeRuns.get(logicalId)?.status === "sleeping");
    const sleeping = state.activeRuns.get(logicalId);
    assert.ok(sleeping);
    sleeping.deferredContextMessages = [{
      content: "trusted status",
      messageId: "00000000-0000-4000-8000-000000000099",
    }];

    const delivery = await teammateSend.execute(
      "cold-failure-send",
      { to: "cold-failure-worker", message: "continue", mode: "follow_up" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(delivery.isError, false);
    await waitFor(() => sleeping.deferredContextMessages?.[0]?.messageId === "00000000-0000-4000-8000-000000000099");
    assert.equal(spawnCount, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
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
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
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

test("nested omitted background uses the normalized foreground default", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const replies: Array<Record<string, unknown>> = [];
  const state = createProxyState();
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined, kill() { return true; },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify(resultReadyTurn("foreground result"))}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  await handleProxyRequest(
    createProxyPi(emitted, messages),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "default-foreground",
      params: { tasks: [{ agent: "general", name: "foreground", prompt: "return directly" }] },
    },
    (reply) => replies.push(reply as Record<string, unknown>),
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), foregroundMaxRunMs: 500 },
  );

  assert.equal(replies.length, 1);
  const result = replies[0].result as { content: Array<{ text: string }> };
  assert.match(result.content[0].text, /foreground result/);
  assert.doesNotMatch(result.content[0].text, /running in background|moved to background/);
  assert.equal(messages.some((message) => message.customType === "teammate-complete"), false);
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
    () => {}, undefined, [], undefined, undefined, {
      spawnChildProcess: confirmFakeKills(spawnChildProcess),
    },
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
  assert.equal(failed?.lastOutcome?.status, "failed");
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
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
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

test("root cancellation after authoritative failure records terminated state and a cancelled complete event", async () => {
  const controller = new AbortController();
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
        message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed: ECONNRESET" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end", willRetry: false })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      controller.abort();
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({ spawnChildProcess });

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

test("root graph cancellation after authoritative failure keeps aggregate event and registry terminal status aligned", async () => {
  const controller = new AbortController();
  const spawnChildProcess = (() => {
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
        message: { role: "assistant", stopReason: "error", errorMessage: "fetch failed: ECONNRESET" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end", willRetry: false })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      controller.abort();
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted } = createHarness({ spawnChildProcess });

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

test("result-ready survives a throttled settling update until a new turn or terminal state", async () => {
  let options: RunTeammateOptions | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined, kill() { return true; },
    });
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, hooks } = createHarness({
    spawnChildProcess,
    onRunOptionsCreated(created) { options = created; },
  });
  await teammate.execute(
    "result-edge",
    { tasks: [{ agent: "general", name: "edge-worker", prompt: "wait" }], background: true },
    new AbortController().signal,
    undefined,
    context(),
  );
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  const agent = [...state.activeRuns.values()].find((entry) => entry.name === "edge-worker")!;
  const base = {
    agent: "general",
    correlationId: agent.correlationId,
    taskIndex: 0,
    dependencies: [],
    status: "running",
    recentTools: [],
    toolCount: 0,
    tokens: 0,
    durationMs: 1,
    lastActivityAt: Date.now(),
    startedAt: Date.now(),
  } satisfies AgentProgress;
  const readyAt = Date.now();
  options!.onProgress?.({ ...base, phase: "result-ready", resultReadyAt: readyAt });
  options!.onProgress?.({ ...base, phase: "settling", resultReadyAt: undefined });
  assert.equal(agent.resultReadyAt, readyAt);
  await hooks.get("session_shutdown")?.[0]?.();
});

test("stale child requests cannot admit work after the parent session generation changes", async () => {
  let options: RunTeammateOptions | undefined;
  let spawns = 0;
  const spawnChildProcess = (() => {
    spawns++;
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
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, hooks } = createHarness({
    spawnChildProcess,
    onRunOptionsCreated(created) { options = created; },
  });
  await teammate.execute(
    "stale-request",
    { tasks: [{ agent: "general", name: "old-parent", prompt: "wait" }], background: true },
    new AbortController().signal,
    undefined,
    context(),
  );
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
  let reply: Record<string, unknown> | undefined;
  options!.onChildRequest?.({
    type: "teammate_proxy_request",
    tool: "teammate",
    requestId: "late-nested",
    params: { tasks: [{ agent: "general", prompt: "must not spawn" }] },
  }, (message) => { reply = message as Record<string, unknown>; });

  assert.equal(spawns, 1);
  assert.match(JSON.stringify(reply), /stale child request rejected/);
  await hooks.get("session_shutdown")?.[0]?.();
});

test("session shutdown fences terminal publication after an already-notified root result", async () => {
  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined, kill() { return true; },
    });
    queueMicrotask(() => stdout!.write(`${JSON.stringify(resultReadyTurn("old root result"))}\n`));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;
  const { teammate, emitted, messages, hooks } = createHarness({
    spawnChildProcess,
    resultReadyGraceMs: 500,
  });
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  state.currentSessionId = "session-A";
  state.sessionGeneration = 1;

  const acknowledgement = await teammate.execute(
    "old-root-call",
    { tasks: [{ agent: "general", name: "old-root", prompt: "finish after shutdown" }], background: true },
    new AbortController().signal,
    undefined,
    context(),
  );
  assert.match(acknowledgement.content[0].text, /running in background/);
  await delay(30);
  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
  assert.equal(messages.filter((message) => message.customType === "teammate-complete").length, 1);

  const shutdown = hooks.get("session_shutdown")?.[0];
  assert.ok(shutdown);
  await shutdown();
  state.currentSessionId = "session-B";
  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(40);

  assert.equal(emitted.filter(({ event }) => event === "teammate:complete").length, 1);
  assert.equal(messages.filter((message) => message.customType === "teammate-complete").length, 1);
});

test("session shutdown fences delayed nested completion from the replacement session", async () => {
  const { hooks } = createHarness();
  const state = (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("pi-maestro-teammate.root-registry")
  ] as TeammateState;
  state.currentSessionId = "session-A";
  state.sessionGeneration = 1;
  const observation = new AbortController();
  state.proxyObservationControllers = new Map([["old-observation", observation]]);
  state.pendingProxyDispatchRequests = new Set(["old-pending-request"]);
  state.pendingProxyDispatchParents = new Map([["old-pending-request", "old-parent"]]);
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const replies: Array<Record<string, unknown>> = [];
  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined, kill() { return true; },
    });
    queueMicrotask(() => stdout!.write(`${JSON.stringify(resultReadyTurn("old result"))}\n`));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  await handleProxyRequest(
    createProxyPi(emitted, messages),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "old-session-request",
      params: {
        tasks: [{ agent: "general", name: "old-session-agent", prompt: "finish after shutdown" }],
        background: true,
      },
    },
    (reply) => replies.push(reply as Record<string, unknown>),
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
  );
  await delay(30);
  assert.match(String((replies[0].result as { content: Array<{ text: string }> }).content[0].text), /running in background/);

  const shutdown = hooks.get("session_shutdown")?.[0];
  assert.ok(shutdown);
  await shutdown();
  state.currentSessionId = "session-B";
  assert.equal(state.sessionGeneration, 2);
  assert.equal(observation.signal.aborted, true);
  assert.equal(state.proxyObservationControllers?.size, 0);
  assert.equal(state.pendingProxyDispatchRequests?.size, 0);
  assert.equal(state.pendingProxyDispatchParents?.size, 0);

  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(40);

  assert.equal(emitted.some(({ event }) => event === "teammate:complete"), false);
  assert.equal(messages.some((message) => message.customType === "teammate-complete"), false);
  assert.equal(state.proxyDispatchByRequest?.has("old-session-request") ?? false, false);
});

test("nested background completion passively delivers teammate_complete_delivery to the parent child agent", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const controlMessages: Record<string, unknown>[] = [];
  const state = createProxyState();
  const parentCid = "parent-agent";
  const now = Date.now();
  const parent: ActiveAgent = {
    agent: "general",
    correlationId: parentCid,
    startedAt: now,
    sessionId: "parent-session",
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    sendControl(message) {
      controlMessages.push(message);
      return true;
    },
  };
  state.activeRuns.set(parentCid, parent);

  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => stdout!.write(`${JSON.stringify(resultReadyTurn("nested done"))}\n`));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const replies: unknown[] = [];
  await handleProxyRequest(
    createProxyPi(emitted, sentMessages),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "nested-background",
      parentCid,
      params: { tasks: [{ agent: "general", prompt: "answer" }], background: true },
    },
    (message) => replies.push(message),
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
  );

  assert.equal(replies.length, 1);
  assert.match(
    String((replies[0] as { result: { content: Array<{ text: string }> } }).result.content[0].text),
    /running in background/,
  );

  for (let attempt = 0; attempt < 40 && controlMessages.length === 0; attempt += 1) {
    await delay(25);
  }
  assert.equal(controlMessages.length, 1);
  assert.equal(controlMessages[0].type, "teammate_complete_delivery");
  assert.equal(controlMessages[0].correlationId, parentCid);
  assert.equal(controlMessages[0].sessionId, "parent-session");
  const envelope = controlMessages[0].envelope as Record<string, unknown>;
  assert.equal(envelope.customType, "teammate-complete");
  const results = (envelope.details as { results: Array<{ messages: Array<{ role: string; content: string }> }> }).results;
  assert.equal(results.length, 1);
  assert.equal(results[0].messages.some((message) => message.content.includes("nested done")), true);
  // reply_to=caller: the envelope goes to the dispatching child only, never
  // duplicated into the root session.
  assert.equal(sentMessages.filter((message) => message.customType === "teammate-complete").length, 0);

  // Duplicate terminal IPC cannot create a second writer for either session.
  stdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await delay(40);
  assert.equal(controlMessages.length, 1);
  assert.equal(sentMessages.filter((message) => message.customType === "teammate-complete").length, 0);
});

test("foreground nested completion does not double-deliver teammate_complete_delivery", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const controlMessages: Record<string, unknown>[] = [];
  const state = createProxyState();
  const parentCid = "parent-agent";
  const now = Date.now();
  const parent: ActiveAgent = {
    agent: "general",
    correlationId: parentCid,
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    sendControl(message) {
      controlMessages.push(message);
      return true;
    },
  };
  state.activeRuns.set(parentCid, parent);

  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => stdout!.write(`${JSON.stringify(resultReadyTurn("foreground done"))}\n`));
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const replies: unknown[] = [];
  await handleProxyRequest(
    createProxyPi(emitted, sentMessages),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "nested-foreground",
      parentCid,
      params: { tasks: [{ agent: "general", prompt: "answer" }], background: false },
    },
    (message) => replies.push(message),
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
  );

  assert.equal(replies.length, 1);
  assert.equal((replies[0] as { result: { isError?: boolean } }).result.isError, false);
  await delay(60);
  // In-window completion returns the result in the reply; no passive delivery.
  assert.equal(controlMessages.length, 0);
  assert.equal(sentMessages.some((message) => message.customType === "teammate-complete"), false);
});

test("nested background completion skips delivery when the parent session changes", async () => {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const controlMessages: Record<string, unknown>[] = [];
  const state = createProxyState();
  const parentCid = "parent-agent";
  const now = Date.now();
  const parent: ActiveAgent = {
    agent: "general",
    correlationId: parentCid,
    startedAt: now,
    sessionId: "parent-session",
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    depth: 0,
    status: "running",
    sleepMs: 0,
    sendControl(message) {
      controlMessages.push(message);
      return true;
    },
  };
  state.activeRuns.set(parentCid, parent);

  let stdout: PassThrough | undefined;
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
    stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    setTimeout(() => stdout!.write(`${JSON.stringify(resultReadyTurn("late done"))}\n`), 80);
    return child;
  }) as unknown as NonNullable<TeammateRuntimeOptions["spawnChildProcess"]>;

  const replies: unknown[] = [];
  await handleProxyRequest(
    createProxyPi(emitted, sentMessages),
    state,
    {
      type: "teammate_proxy_request",
      tool: "teammate",
      requestId: "nested-late-parent",
      parentCid,
      params: { tasks: [{ agent: "general", prompt: "answer" }], background: true },
    },
    (message) => replies.push(message),
    undefined,
    [],
    undefined,
    undefined,
    { spawnChildProcess: confirmFakeKills(spawnChildProcess), resultReadyGraceMs: 500 },
  );

  assert.match(
    String((replies[0] as { result: { content: Array<{ text: string }> } }).result.content[0].text),
    /running in background/,
  );
  // The child process remains live, but its active session no longer owns the
  // dispatch that requested this completion.
  parent.sessionId = "replacement-session";
  await delay(200);
  assert.equal(controlMessages.length, 0);
});

test("child bridge consumes teammate_complete_delivery and injects it locally", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8")
    + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8")
    + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8");
  assert.match(source, /type === "teammate_complete_delivery"/);
  assert.match(source, /m\.correlationId !== process\.env\.PI_TEAMMATE_CORRELATION_ID/);
  assert.match(source, /deliverySessionId !== bridge\.ctx\.sessionManager\.getSessionId\(\)/);
  assert.match(source, /safeSendMessage\(pi, envelope as never, \{ triggerTurn: true \}\)/);
  // Root side forwards the envelope over agent.sendControl only while the
  // dispatching child's session identity is unchanged.
  assert.match(source, /parentAgent\?\.sessionId === parentSessionId/);
  assert.match(source, /sessionId: parentSessionId/);
});

test("workspace delivery paths retain the originating root session fence", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
  const sender = source.slice(
    source.indexOf("const sendWorkspacePeerMessage"),
    source.indexOf("const prepareLocalAgentDelivery"),
  );
  assert.match(sender, /const authorized = \(\): boolean => request\.source === "monitor"[\s\S]*?request\.authorize\?\.\(\) === true/);
  assert.match(sender, /const fence = captureRootSessionFence\(\)/);
  assert.match(sender, /await workspacePeerLifecycle;\s+if \(!ownsRootSessionFence\(fence\)\)/);
  assert.match(sender, /await refreshWorkspacePeerOwners\(\);\s+if \(!ownsRootSessionFence\(fence\)\)/);
  assert.match(sender, /beforePublish\(prepared\) \{[\s\S]*?if \(!authorized\(\)\)[\s\S]*?if \(!ownsRootSessionFence\(fence\)\)/);
  assert.match(sender, /beforeCommit\(\) \{[\s\S]*?if \(!authorized\(\)\)[\s\S]*?if \(!ownsRootSessionFence\(fence\)\)/);
  assert.match(sender, /await waitForWorkspacePeerCommandResponse[\s\S]+if \(!ownsRootSessionFence\(fence\)\)/);

  const peers = source.slice(
    source.indexOf("const startWorkspacePeers"),
    source.indexOf("const enqueueChildInteraction"),
  );
  assert.match(peers, /const fence = captureRootSessionFence\(\)/);
  assert.match(peers, /const registry = sessionHostRegistry/);
  assert.match(peers, /targetSessionId: fence\.sessionId/);
  assert.match(peers, /await deliverLocalAgentMessage[\s\S]+if \(!ownsRootSessionFence\(fence\)\)/);
  assert.doesNotMatch(peers, /sessionHostRegistry\?\.thread/);

  const discovery = source.slice(
    source.indexOf("const refreshWorkspacePeerOwners ="),
    source.indexOf("const targetForWorkspaceBinding"),
  );
  assert.match(discovery, /reservation = \{ publisher, fence, promise \}/);
  assert.match(discovery, /workspacePeerPublisher !== publisher \|\| !ownsRootSessionFence\(fence\)/);
  assert.match(discovery, /if \(workspacePeerRefresh === reservation\) workspacePeerRefresh = undefined/);

  const localAgent = source.slice(
    source.indexOf("const deliverLocalAgentMessage"),
    source.indexOf("const deliverLocalRootEndpoint"),
  );
  assert.match(localAgent, /await host\.rollout\.deliver[\s\S]+if \(!ownsRootSessionFence\(fence\)\)/);

  const localRoot = source.slice(
    source.indexOf("const deliverLocalRootEndpoint"),
    source.indexOf("const deliverLocalAgentEndpoint"),
  );
  assert.match(localRoot, /endpoint\.sessionId !== state\.currentSessionId/);

  const route = source.slice(
    source.indexOf("const routeSessionMessage"),
    source.indexOf("const stopWorkspacePeers"),
  );
  assert.match(route, /const result = await registry\.send\(request\);\s+if \(!ownsRootSessionFence\(fence\)\)/);

  const advisor = source.slice(
    source.indexOf("async function runAdvisorReview"),
    source.indexOf("const monitorBindingRequest"),
  );
  assert.match(advisor, /const fence = captureRootSessionFence\(\)/);
  assert.match(advisor, /const evaluation = await runSupervisedEvaluation[\s\S]+if \(!ownsRootSessionFence\(fence\)\) return;/);
  assert.ok(
    advisor.indexOf("if (!ownsRootSessionFence(fence)) return;") < advisor.indexOf("advisorState.lastReviewAt"),
    "a stale advisor result must be rejected before shared state or message delivery",
  );

  const shutdown = source.slice(source.lastIndexOf('pi.on("session_shutdown"'));
  assert.ok(shutdown.indexOf("state.sessionGeneration =") < shutdown.indexOf("await "));
  assert.ok(shutdown.indexOf("state.currentSessionId = null") < shutdown.indexOf("await "));
});

test("model status addressed to @root is normalized and starts a root turn", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-root-status-"));
  const { teammateSend, messages, messageOptions, hooks } = createHarness();
  const sessionStart = hooks.get("session_start")?.[0];
  const sessionShutdown = hooks.get("session_shutdown")?.[0];
  assert.ok(sessionStart);
  assert.ok(sessionShutdown);
  const ctx = {
    ...context(),
    cwd: project,
    ui: { setWidget() {} },
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => undefined,
      getSessionId: () => "root-status-session",
      getSessionName: () => "root-status",
    },
  };

  try {
    await Promise.resolve(sessionStart({ reason: "new" }, ctx));
    const result = await teammateSend.execute(
      "root-status",
      { to: "@root", message: "audit ready", kind: "status" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /kind coordination/i);
    const index = messages.findIndex((message) => String(message.content).includes("audit ready"));
    assert.notEqual(index, -1);
    assert.equal(messageOptions[index]?.triggerTurn, true);
    assert.match(String(messages[index]?.content), /^\[teammate:coordination\] from main/);
  } finally {
    await Promise.resolve(sessionShutdown());
    fs.rmSync(project, { recursive: true, force: true });
  }
});

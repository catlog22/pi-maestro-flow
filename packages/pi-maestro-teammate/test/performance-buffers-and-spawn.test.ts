import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { AgentConfig } from "../src/agents/agents.ts";
import {
  AGENT_BUFFER_LIMITS,
  buildWatchOutput,
  createProgressFlushGate,
  enforceWakeableAgentBudget,
  flushProgressBatch,
  hasTeammateWidgetWork,
  killAgentTree,
  nextWakeableAgentExpiryDelay,
  retainBoundedAgentHistory,
  runWithProgressFlushCleanup,
  WAKEABLE_AGENT_BUDGET,
} from "../src/extension/index.ts";
import {
  EXECUTION_BUFFER_LIMITS,
  acquireRetryPersistenceGuard,
  appendBoundedTranscriptMessage,
  buildPiArgs,
  createUtf8LineDecoder,
  getPiSpawnCommand,
  isPiResultReadyTurn,
  releasePublishedTurnHistory,
  resolveModelSpecifier,
  runGraph,
  runSingleTeammate,
  runTeammate,
  validateModelSpecifier,
} from "../src/runs/execution.ts";
import { ModelCircuitBreaker } from "../src/models/model-circuit-breaker.ts";
import { NETWORK_RETRY_POLICY, classifyRetryError, retryDelayMs } from "../src/runs/retry.ts";
import type {
  ActiveAgent,
  AgentProgress,
  AgentProgressSnapshot,
  SingleResult,
  TeammateState,
  Usage,
} from "../src/shared/types.ts";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";

const baseAgentConfig: AgentConfig = {
  name: "general",
  description: "Delegate",
  tools: ["read"],
  systemPromptMode: "append",
  inheritProjectContext: true,
  inheritSkills: false,
  systemPrompt: "Delegate prompt",
  source: "builtin",
  filePath: "general.md",
};

type SpawnChildProcess = NonNullable<Parameters<typeof runSingleTeammate>[1]["spawnChildProcess"]>;
type MutableFakeProcess = Omit<ChildProcess, "exitCode"> & { exitCode: number | null };
type FakeSpawn = (command: string, args: readonly string[], options: SpawnOptions) => MutableFakeProcess;

function createFakeProcess(): MutableFakeProcess {
  return new EventEmitter() as MutableFakeProcess;
}

function isArgumentList(value: readonly string[] | SpawnOptions): value is readonly string[] {
  return Array.isArray(value);
}

function adaptFakeSpawn(factory: FakeSpawn): SpawnChildProcess {
  function spawn(command: string, options: SpawnOptions): ChildProcess;
  function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess;
  function spawn(
    command: string,
    argsOrOptions: readonly string[] | SpawnOptions = [],
    options: SpawnOptions = {},
  ): ChildProcess {
    return isArgumentList(argsOrOptions)
      ? factory(command, argsOrOptions, options)
      : factory(command, [], argsOrOptions);
  }

  return Object.assign(spawn, { spawn: nodeSpawn, sync: spawnSync });
}

function activeAgent(): ActiveAgent {
  const now = Date.now();
  return {
    agent: "general",
    name: "bounded",
    correlationId: "agent-bounded",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running",
    depth: 0,
    sleepMs: 0,
  };
}

function sleepingAgent(id: string, lastActivityAt: number, name?: string): ActiveAgent {
  const agent = activeAgent();
  agent.correlationId = id;
  if (name) agent.name = name;
  else delete agent.name;
  agent.status = "sleeping";
  agent.sleptAt = lastActivityAt;
  agent.lastActivityAt = lastActivityAt;
  return agent;
}

function pendingAgent(id: string, lastActivityAt: number): ActiveAgent {
  const agent = activeAgent();
  agent.correlationId = id;
  delete agent.name;
  agent.status = "pending";
  agent.lastActivityAt = lastActivityAt;
  return agent;
}

function teammateState(agents: ActiveAgent[]): TeammateState {
  return {
    baseCwd: process.cwd(),
    currentSessionId: "test-session",
    activeRuns: new Map(agents.map((agent) => [agent.correlationId, agent])),
    namedAgents: new Map(agents
      .filter((agent): agent is ActiveAgent & { name: string } => Boolean(agent.name))
      .map((agent) => [agent.name, agent.correlationId])),
  };
}

test("progress bursts coalesce before expensive flush and terminal state flushes immediately", () => {
  let expensiveFlushes = 0;
  const gate = createProgressFlushGate(() => { expensiveFlushes += 1; }, 10_000);
  try {
    gate.mark();
    assert.equal(expensiveFlushes, 1);
    for (let index = 0; index < 100; index += 1) gate.mark();
    assert.equal(expensiveFlushes, 1, "running burst must not trigger graph sort/broadcast/render work");
    gate.mark(true);
    assert.equal(expensiveFlushes, 2, "terminal progress must synchronously flush the coalesced state");
  } finally {
    gate.dispose();
  }
});

test("one progress flush applies every task delta but publishes one full graph snapshot", () => {
  const pending = new Map<number, number>();
  let latest: number | undefined;
  for (let index = 0; index < 5_000; index += 1) {
    pending.set(index % 8, index);
    latest = index;
  }
  const applied: number[] = [];
  const published: number[] = [];
  flushProgressBatch(pending, latest, (value) => applied.push(value), (value) => published.push(value));
  assert.equal(applied.length, 8, "only the latest delta per task should be applied");
  assert.deepEqual(published, [4_999], "the batch must project and broadcast exactly once");
  assert.equal(pending.size, 0);
});

test("root graph progress wiring projects and broadcasts only after the batch is applied", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8");
  const rootStart = source.indexOf("const pendingByTask = new Map<number, AgentProgress>();");
  const rootEnd = source.indexOf("onChildRequest:", rootStart);
  assert.ok(rootStart >= 0 && rootEnd > rootStart);
  const rootProgress = source.slice(rootStart, rootEnd);
  assert.match(rootProgress, /flushProgressBatch\(pendingByTask, latest, processProgress, publishProgress\)/);
  const applyStart = rootProgress.indexOf("const processProgress");
  const publishStart = rootProgress.indexOf("const publishProgress");
  assert.ok(applyStart >= 0 && publishStart > applyStart);
  assert.doesNotMatch(rootProgress.slice(applyStart, publishStart), /progressSnapshot\(\)|TEAMMATE_MESSAGE_EVENT|onUpdate\?\./);
  const publishBody = rootProgress.slice(publishStart);
  assert.equal(publishBody.match(/progressSnapshot\(\)/g)?.length, 1);
  assert.equal(publishBody.match(/TEAMMATE_MESSAGE_EVENT/g)?.length, 1);
  assert.equal(publishBody.match(/onUpdate\?\./g)?.length, 1);
  assert.match(publishBody, /if \(foregroundUpdateOpen\) \{\s*onUpdate\?\./);

  const childStatusStart = source.indexOf("const publishChildCallStatus");
  const childStatusEnd = source.indexOf("normalizedTasks.forEach((task, index) => {", childStatusStart);
  assert.ok(childStatusStart >= 0 && childStatusEnd > childStatusStart);
  assert.match(
    source.slice(childStatusStart, childStatusEnd),
    /if \(foregroundUpdateOpen\) \{\s*onUpdate\?\./,
  );
});

test("wakeable sleeping budget evicts anonymous LRU agents before named agents and aborts before registry cleanup", () => {
  const now = Date.now();
  const named = sleepingAgent("named", now - 10_000, "reviewer");
  const anonymous = Array.from(
    { length: WAKEABLE_AGENT_BUDGET.maxSleepingAgents + 2 },
    (_, index) => sleepingAgent(`anon-${index}`, now - 20_000 + index),
  );
  const state = teammateState([named, ...anonymous]);
  const registryVisibleAtAbort = new Map<string, boolean>();
  for (const agent of state.activeRuns.values()) {
    agent.abortController.signal.addEventListener("abort", () => {
      registryVisibleAtAbort.set(agent.correlationId, state.activeRuns.has(agent.correlationId));
    });
  }

  const evicted = enforceWakeableAgentBudget(state, now);
  assert.equal(state.activeRuns.size, WAKEABLE_AGENT_BUDGET.maxSleepingAgents);
  assert.ok(state.activeRuns.has(named.correlationId), "named wakeable agents are protected before anonymous agents");
  assert.equal(state.namedAgents.get("reviewer"), named.correlationId);
  assert.ok(evicted.includes("anon-0"));
  assert.ok(evicted.every((id) => registryVisibleAtAbort.get(id) === true));
});

test("wakeable TTL is longer for named agents and shared running cohorts are never evicted", () => {
  const now = Date.now();
  const anonymous = sleepingAgent("anonymous", now - WAKEABLE_AGENT_BUDGET.anonymousTtlMs - 1);
  const named = sleepingAgent("named", anonymous.lastActivityAt, "pinned-by-name");
  const sharedController = new AbortController();
  const sharedSleeping = sleepingAgent("shared-sleeping", now - WAKEABLE_AGENT_BUDGET.namedTtlMs - 1);
  const sharedRunning = activeAgent();
  sharedSleeping.abortController = sharedController;
  sharedRunning.abortController = sharedController;
  sharedRunning.correlationId = "shared-running";
  const state = teammateState([anonymous, named, sharedSleeping, sharedRunning]);

  assert.deepEqual(enforceWakeableAgentBudget(state, now), [anonymous.correlationId]);
  assert.ok(state.activeRuns.has(named.correlationId));
  assert.ok(state.activeRuns.has(sharedSleeping.correlationId));
  assert.equal(sharedController.signal.aborted, false);
  assert.equal(hasTeammateWidgetWork(state, now), true);

  sharedRunning.status = "sleeping";
  sharedRunning.sleptAt = now - WAKEABLE_AGENT_BUDGET.namedTtlMs - 1;
  sharedRunning.lastActivityAt = sharedRunning.sleptAt;
  const expired = enforceWakeableAgentBudget(state, now + WAKEABLE_AGENT_BUDGET.namedTtlMs);
  assert.ok(expired.includes(named.correlationId));
  assert.ok(expired.includes(sharedSleeping.correlationId));
  assert.ok(expired.includes(sharedRunning.correlationId));
  assert.equal(sharedController.signal.aborted, true);
  assert.equal(state.namedAgents.has("pinned-by-name"), false);
  assert.equal(nextWakeableAgentExpiryDelay(state, now), undefined);
});

test("widget work ignores sleeping agents after the visible grace period", () => {
  const now = Date.now();
  const oldSleeping = sleepingAgent("old", now - 60_001);
  const state = teammateState([oldSleeping]);
  assert.equal(hasTeammateWidgetWork(state, now), false);
  oldSleeping.sleptAt = now - 59_999;
  assert.equal(hasTeammateWidgetWork(state, now), true);
  oldSleeping.status = "running";
  oldSleeping.sleptAt = now - 120_000;
  assert.equal(hasTeammateWidgetWork(state, now), true);
});

test("widget work ignores pending agents after the grace period measured from last work", () => {
  const now = Date.now();
  const stalePending = pendingAgent("pending-old", now - 60_001);
  const state = teammateState([stalePending]);
  assert.equal(hasTeammateWidgetWork(state, now), false);
  stalePending.lastActivityAt = now - 59_999;
  assert.equal(hasTeammateWidgetWork(state, now), true);
  stalePending.status = "running";
  stalePending.lastActivityAt = now - 120_000;
  assert.equal(hasTeammateWidgetWork(state, now), true);
});

test("root progress cleanup flushes then disposes on success, error, and termination", async () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8");
  const teammateToolStart = source.indexOf("const tool: ToolDefinition<typeof TeammateParams");
  const executeStart = source.indexOf("async execute(", teammateToolStart);
  const executeEnd = source.indexOf("renderCall(args", executeStart);
  assert.ok(teammateToolStart >= 0 && executeStart > teammateToolStart && executeEnd > executeStart);
  const rootExecute = source.slice(executeStart, executeEnd);
  assert.equal(rootExecute.match(/runWithProgressFlushCleanup\(/g)?.length, 3);
  assert.doesNotMatch(rootExecute, /runSingleTeammate\(params, makeOptions\(\)\)/);

  for (const outcome of ["success", "error", "termination"] as const) {
    const lifecycle: string[] = [];
    const gate = {
      mark() {},
      flush() { lifecycle.push("flush"); },
      dispose() { lifecycle.push("dispose"); },
    };
    const run = async () => {
      if (outcome === "success") return outcome;
      const error = new Error(outcome);
      if (outcome === "termination") error.name = "AbortError";
      throw error;
    };

    if (outcome === "success") {
      assert.equal(await runWithProgressFlushCleanup(run, gate), outcome);
    } else {
      await assert.rejects(runWithProgressFlushCleanup(run, gate), { name: outcome === "termination" ? "AbortError" : "Error" });
    }
    assert.deepEqual(lifecycle, ["flush", "dispose"]);
  }

  let renders = 0;
  const terminalGate = createProgressFlushGate(() => { renders += 1; }, 60_000);
  terminalGate.mark(true);
  assert.equal(renders, 1);
  await runWithProgressFlushCleanup(async () => undefined, terminalGate);
  assert.equal(renders, 1, "cleanup after a terminal flush must not render twice");
});

test("proxy graph progress batches burst snapshots and synchronously publishes terminal state", () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-helpers.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-proxy.ts", import.meta.url), "utf-8") + fs.readFileSync(new URL("../src/extension/teammate-core.ts", import.meta.url), "utf-8");
  const proxyStart = source.indexOf("const pendingProgressByTask = new Map<number, AgentProgress>();");
  const proxyEnd = source.indexOf("onChildRequest:", proxyStart);
  assert.ok(proxyStart >= 0 && proxyEnd > proxyStart);
  const proxyProgress = source.slice(proxyStart, proxyEnd);
  assert.match(proxyProgress, /createProgressFlushGate\(/);
  assert.match(proxyProgress, /pendingProgressByTask\.set\(taskIndex, data\)/);
  assert.match(proxyProgress, /\.mark\(data\.status === "completed" \|\| data\.status === "failed"\)/);
  const callbackStart = proxyProgress.indexOf("onProgress: (data) =>");
  assert.ok(callbackStart >= 0);
  assert.doesNotMatch(proxyProgress.slice(callbackStart), /progressSnapshot\(\)/);

  const pending = new Map<number, number>();
  const snapshots: number[][] = [];
  const gate = createProgressFlushGate(() => {
    snapshots.push([...pending.values()].sort((left, right) => left - right));
    pending.clear();
  }, 60_000);
  try {
    pending.set(0, 0);
    gate.mark();
    for (let index = 1; index <= 5_000; index += 1) {
      pending.set(index % 8, index);
      gate.mark();
    }
    assert.equal(snapshots.length, 1, "non-terminal burst must not sort a full snapshot per event");
    pending.set(7, 5_001);
    gate.mark(true);
    assert.equal(snapshots.length, 2, "terminal progress must publish synchronously");
    assert.ok(snapshots[1].includes(5_001));
  } finally {
    gate.dispose();
  }
});

test("one overlay progress event requests at most one render", () => {
  const agent = activeAgent();
  const overlay = new AttachOverlay(agent, () => {}, () => new Map([[agent.correlationId, agent]]));
  let renders = 0;
  overlay.setRequestRender(() => { renders += 1; });
  const progress: AgentProgressSnapshot[] = [{
    agent: "general",
    correlationId: agent.correlationId,
    taskIndex: 0,
    dependencies: [],
    status: "running",
  }];
  try {
    overlay.applyProgressEvent(agent.correlationId, {
      progress,
      activeTools: [{ name: "read", status: "running", startedAt: Date.now() }],
      streamingText: "working",
      lines: [{ text: "read complete", kind: "tool" }],
    });
    assert.equal(renders, 1);
  } finally {
    overlay.dispose();
  }
});

test("sleeping agent history has byte and count bounds while watch retains last result", () => {
  const agent = activeAgent();
  agent.status = "sleeping";
  agent.sleptAt = Date.now();
  agent.inbox = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    from: "caller",
    to: "bounded",
    kind: "task" as const,
    payload: `message-${index}-${"界".repeat(10_000)}`,
    timestamp: index,
  }));
  agent.outputLog = Array.from({ length: 250 }, (_, index) => `line-${index}-${"界".repeat(10_000)}`);
  agent.lastResult = `final-${"界".repeat(200_000)}`;

  retainBoundedAgentHistory(agent, true);

  assert.ok(agent.inbox.length <= AGENT_BUFFER_LIMITS.sleepingInboxItems);
  assert.ok(agent.outputLog.length <= AGENT_BUFFER_LIMITS.sleepingLogLines);
  assert.ok(
    agent.inbox.reduce((total, entry) => total + Buffer.byteLength(entry.payload), 0)
      <= AGENT_BUFFER_LIMITS.inboxBytes,
  );
  assert.ok(
    agent.outputLog.reduce((total, line) => total + Buffer.byteLength(line), 0)
      <= AGENT_BUFFER_LIMITS.logBytes,
  );
  assert.ok(Buffer.byteLength(agent.lastResult ?? "") <= AGENT_BUFFER_LIMITS.lastResultBytes);
  const watch = buildWatchOutput({ kind: "agent", agent }, 20).join("\n");
  assert.match(watch, /last result/);
  assert.match(watch, /sleeping/);
});

test("agent history compacts sparse output logs without throwing", () => {
  const agent = activeAgent();
  agent.outputLog = ["first", "second"];
  agent.outputLog[10] = "latest";

  retainBoundedAgentHistory(agent);

  assert.deepEqual(agent.outputLog, ["first", "second", "latest"]);
});

test("transcript, decoder, stderr-adjacent stream limits are byte bounded", () => {
  const transcript: Array<{ role: string; content: string }> = [];
  for (let index = 0; index < EXECUTION_BUFFER_LIMITS.transcriptMessages + 20; index += 1) {
    appendBoundedTranscriptMessage(transcript, { role: "tool", content: "界".repeat(30_000) });
  }
  assert.ok(transcript.length <= EXECUTION_BUFFER_LIMITS.transcriptMessages);
  assert.ok(
    transcript.reduce((total, entry) => total + Buffer.byteLength(entry.content), 0)
      <= EXECUTION_BUFFER_LIMITS.transcriptBytes,
  );
  assert.ok(transcript.every(
    (entry) => Buffer.byteLength(entry.content) <= EXECUTION_BUFFER_LIMITS.transcriptMessageBytes,
  ));

  const decoder = createUtf8LineDecoder(8);
  assert.deepEqual(decoder.write(Buffer.from("abcdefghijk")), []);
  const [tail] = decoder.end();
  assert.equal(Buffer.byteLength(tail), 8);
  assert.equal(tail, "defghijk");
});

test("published turn result can survive while disposable transcript and tool history is released", () => {
  const messages = [{ role: "assistant", content: "published result" }];
  const published = [...messages];
  const progress: AgentProgress = {
    agent: "general",
    status: "completed",
    startedAt: Date.now(),
    durationMs: 1,
    toolCount: 1,
    recentTools: [{ name: "read", status: "completed" }],
    tokens: 10,
    lastActivityAt: Date.now(),
  };
  const usage: Usage = {
    inputTokens: 5,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    turns: 1,
  };

  releasePublishedTurnHistory(messages, progress, usage);

  assert.deepEqual(published, [{ role: "assistant", content: "published result" }]);
  assert.deepEqual(messages, []);
  assert.deepEqual(progress.recentTools, []);
  assert.equal(usage.turns, 0);
  assert.equal(usage.inputTokens + usage.outputTokens, 0);
});

test("Windows Pi fallback is shell-free and preserves hostile-looking argv as one item", () => {
  const argv = ["--model", "openai/gpt-5&whoami", "--mode", "rpc"];
  const spec = getPiSpawnCommand(argv, {
    platform: "win32",
    envBinary: null,
    entryPoint: null,
  });
  assert.equal(spec.command, "pi");
  assert.equal(spec.shell, false);
  assert.deepEqual(spec.args, argv);
  assert.notEqual(spec.command, "pi.cmd");

  assert.equal(validateModelSpecifier("openai/gpt-5.1-mini:latest"), "openai/gpt-5.1-mini:latest");
  for (const invalid of ["openai/gpt-5&whoami", "--help", "openai/gpt 5", "a/b/c", "x\n--tools"]) {
    assert.throws(() => validateModelSpecifier(invalid), /Invalid teammate model specifier/);
    assert.throws(
      () => buildPiArgs(baseAgentConfig, { agent: "general", model: invalid }, "prompt.md"),
      /Invalid teammate model specifier/,
    );
  }
});

test("teammate child processes are hidden on Windows", async () => {
  let windowsHide: boolean | undefined;
  const spawnChildProcess = adaptFakeSpawn((_command, _args, options) => {
    windowsHide = options.windowsHide;
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
      child.emit("exit", 0, null);
    });
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Do work", timeoutMs: 2_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(windowsHide, true);
});

test("invalid model input is rejected before a child process is spawned", async () => {
  const result = await runSingleTeammate(
    { agent: "general", task: "Do work", model: "openai/gpt-5&whoami" },
    { baseCwd: process.cwd() },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.messages[0]?.content ?? "", /Invalid teammate model specifier/);
});

test("model specifiers resolve provider shorthand and reject unavailable exact routes", () => {
  const models = [
    { id: "maestro-qwen/qwen3.8-max-preview" },
    { id: "deepseek/deepseek-v4-pro" },
  ];
  assert.equal(
    resolveModelSpecifier("maestro-qwen", models),
    "maestro-qwen/qwen3.8-max-preview",
  );
  assert.equal(
    resolveModelSpecifier("deepseek-v4-pro", models),
    "deepseek/deepseek-v4-pro",
  );
  assert.throws(
    () => resolveModelSpecifier("anthropic/claude-sonnet", models),
    /Unknown teammate model specifier/,
  );
});

test("network retry policy is bounded, progressive, and rejects permanent failures", () => {
  assert.equal(NETWORK_RETRY_POLICY.maxRetries, 10);
  assert.deepEqual(
    Array.from({ length: NETWORK_RETRY_POLICY.maxRetries }, (_, index) => retryDelayMs(index + 1)),
    [1_000, 2_000, 4_000, 8_000, 16_000, 16_000, 16_000, 16_000, 16_000, 16_000],
  );
  assert.equal(classifyRetryError("fetch failed: ECONNRESET"), "network");
  assert.equal(classifyRetryError("Error: Connection error."), "network");
  assert.equal(classifyRetryError("Provider returned error: 503"), "provider");
  assert.equal(classifyRetryError("402: Insufficient Balance"), "fallback-only");
  assert.equal(
    classifyRetryError("Teammate runtime error (phase=message_end): 402: Insufficient Balance"),
    "fallback-only",
  );
  assert.equal(classifyRetryError("Invalid API key"), "non-retryable");
  assert.equal(classifyRetryError("Authentication failed: token expired"), "non-retryable");
  assert.equal(classifyRetryError("context length exceeded"), "non-retryable");
  assert.equal(
    classifyRetryError("Timed out waiting for the first child agent event (agent=general, model=qwen, correlationId=abc, phase=first-activity); the child process started but did not report model activity."),
    "network",
    "first-activity timeout must be retryable",
  );
  assert.equal(
    classifyRetryError("Teammate runtime error (phase=message_end, agent=planner, model=qwen, correlationId=abc): some provider issue"),
    "non-retryable",
    "a generic runtime wrapper cannot make an unknown failure transient",
  );
  assert.equal(
    classifyRetryError("Teammate child process exited abnormally (agent=general, correlationId=abc, exit=1, signal=SIGKILL, elapsed=5000ms, tools=3)."),
    "non-retryable",
    "a local process exit is not itself a network failure",
  );
  assert.equal(
    classifyRetryError("Teammate child process error (agent=general, model=qwen, correlationId=abc, phase=child-error): read EPIPE"),
    "network",
    "the underlying transport code remains retryable",
  );
  assert.equal(
    classifyRetryError("Failed to spawn pi subprocess (agent=general, model=qwen, correlationId=abc, phase=spawn): ENOENT"),
    "non-retryable",
    "spawn failure must stay non-retryable",
  );
});

test("Pi result-ready marker accepts only a final assistant turn with no tool work", () => {
  assert.equal(isPiResultReadyTurn({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "completed analysis" }],
    },
    toolResults: [],
  }), true);
  assert.equal(isPiResultReadyTurn({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "not terminal" }] },
  }), false);
  assert.equal(isPiResultReadyTurn({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "toolCall", id: "call-1", name: "read" }],
    },
    toolResults: [],
  }), false);
  assert.equal(isPiResultReadyTurn({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
    },
    toolResults: [{ toolCallId: "call-1" }],
  }), false);
  assert.equal(isPiResultReadyTurn({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      errorMessage: "provider failed after producing partial text",
      content: [{ type: "text", text: "partial answer" }],
    },
    toolResults: [],
  }), false);
});

test("final turn_end publishes a wakeable result before agent_end settles lifecycle", async () => {
  const completions: string[] = [];
  const progress: AgentProgress[] = [];
  let stdout: PassThrough | undefined;
  let killed = false;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const childStdout = new PassThrough();
    stdout = childStdout;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: childStdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed = true; return true; },
    });
    queueMicrotask(() => {
      childStdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ready answer" }] },
      })}\n`);
      childStdout.write(`${JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "ready answer" }],
        },
        toolResults: [],
      })}\n`);
    });
    return child;
  });

  const result = await Promise.race([
    runSingleTeammate(
      { agent: "general", task: "Return before lifecycle confirmation", context: "fresh", timeoutMs: 2_000 },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        onProgress: (entry) => progress.push({ ...entry, recentTools: [...entry.recentTools] }),
        onTurnComplete: (entry) => completions.push(entry.messages.at(-1)?.content ?? ""),
      },
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("result-ready publication timed out")), 500)),
  ]);

  assert.equal(result.messages.at(-1)?.content, "ready answer");
  assert.equal(result.lifecyclePending, true);
  assert.equal(result.wakeable, true);
  assert.equal(killed, false);
  assert.deepEqual(completions, []);
  assert.equal(progress.at(-1)?.status, "running");
  assert.notEqual(progress.at(-1)?.resultReadyAt, undefined);

  if (!stdout) throw new Error("fake child stdout was not initialized");
  stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(completions, ["ready answer"]);
  assert.equal(progress.at(-1)?.status, "completed");
  assert.equal(progress.at(-1)?.resultReadyAt, undefined);
  assert.equal(killed, false, "fresh teammate must remain wakeable after lifecycle confirmation");
});

test("parallel graph waits for authoritative lifecycle after result publication", async () => {
  const stdoutStreams: PassThrough[] = [];
  let killed = 0;
  let spawnIndex = 0;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const index = spawnIndex++;
    const child = createFakeProcess();
    const stdout = new PassThrough();
    stdoutStreams.push(stdout);
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { killed++; return true; },
    });
    queueMicrotask(() => {
      const answer = `parallel-${index}`;
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: answer }] },
      })}\n`);
      stdout.write(`${JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: answer }],
        },
        toolResults: [],
      })}\n`);
    });
    return child;
  });

  let graphSettled = false;
  const graphPromise = runGraph(
    Array.from({ length: 4 }, (_, index) => ({
      agent: "general",
      prompt: `parallel task ${index}`,
      name: `parallel_${index}`,
      context: "fresh" as const,
      timeoutMs: 2_000,
    })),
    4,
    { baseCwd: process.cwd(), spawnChildProcess },
  ).then((results) => {
    graphSettled = true;
    return results;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawnIndex, 4);
  assert.equal(graphSettled, false, "result-ready must not settle the graph");
  assert.equal(killed, 0);
  for (const stream of stdoutStreams) stream.write(`${JSON.stringify({ type: "agent_end" })}\n`);

  const results = await graphPromise;
  assert.deepEqual(
    results.map((result) => result.messages.at(-1)?.content).sort(),
    ["parallel-0", "parallel-1", "parallel-2", "parallel-3"],
  );
  assert.equal(results.every((result) => result.lifecyclePending !== true), true);
  assert.equal(killed, 0);
});

test("runGraph forwards each task model and thinking level to child CLI arguments", async () => {
  const capturedArgs: string[][] = [];
  const stdoutStreams: PassThrough[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    capturedArgs.push([...args]);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    stdoutStreams.push(stdout);
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
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        },
        toolResults: [],
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  await runGraph([
    {
      agent: "general",
      prompt: "fast task",
      model: "provider/fast",
      thinking: "low",
      context: "fresh",
      timeoutMs: 2_000,
    },
    {
      agent: "analyst",
      prompt: "deep task",
      model: "provider/deep",
      thinking: "high",
      context: "fresh",
      timeoutMs: 2_000,
    },
  ], 2, { baseCwd: process.cwd(), spawnChildProcess });

  const selections = capturedArgs.map((args) => ({
    model: args[args.indexOf("--model") + 1],
    thinking: args[args.indexOf("--thinking") + 1],
  })).sort((left, right) => left.model.localeCompare(right.model));
  assert.deepEqual(selections, [
    { model: "provider/deep", thinking: "high" },
    { model: "provider/fast", thinking: "low" },
  ]);

  for (const stream of stdoutStreams) stream.write(`${JSON.stringify({ type: "agent_end" })}\n`);
});

test("public runTeammate rejects unavailable configured models before child launch", async () => {
  const cwd = fs.mkdtempSync(path.join(process.cwd(), ".tmp-routing-"));
  const configDir = path.join(cwd, ".pi");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "teammate-models.json"), JSON.stringify({
    version: 2,
    mappings: { analysis: "missing/model" },
    thinkingLevels: {},
  }));
  const capturedArgs: string[][] = [];
  const stdoutStreams: PassThrough[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    capturedArgs.push([...args]);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    stdoutStreams.push(stdout);
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
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
        toolResults: [],
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  try {
    await runTeammate({
      taskType: "analysis",
      tasks: [{ agent: "general", prompt: "Analyze" }],
    }, {
      baseCwd: cwd,
      modelCapabilities: [{ id: "provider/available", reasoning: true, thinkingLevels: ["low"] }],
      spawnChildProcess,
    });
    assert.equal(capturedArgs.length, 1);
    assert.equal(capturedArgs[0].includes("missing/model"), false);
  } finally {
    for (const stream of stdoutStreams) stream.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("DAG dependencies wait for authoritative upstream lifecycle", async () => {
  const stdoutStreams: PassThrough[] = [];
  let spawnIndex = 0;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const index = spawnIndex++;
    const child = createFakeProcess();
    const stdout = new PassThrough();
    stdoutStreams.push(stdout);
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined, kill() { return true; },
    });
    queueMicrotask(() => {
      const answer = index === 0 ? "seed result" : "dependent result";
      stdout.write(`${JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: answer }],
      } })}\n`);
      stdout.write(`${JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] },
        toolResults: [],
      })}\n`);
    });
    return child;
  });

  const graph = runGraph([
    { agent: "general", prompt: "produce seed", name: "seed", context: "fresh", timeoutMs: 2_000 },
    { agent: "general", prompt: "consume {seed}", name: "dependent", dependsOn: ["seed"], context: "fresh", timeoutMs: 2_000 },
  ], 2, { baseCwd: process.cwd(), spawnChildProcess });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawnIndex, 1, "dependent waits for upstream agent_end");
  stdoutStreams[0].write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawnIndex, 2);
  stdoutStreams[1].write(`${JSON.stringify({ type: "agent_end" })}\n`);
  const results = await graph;
  assert.deepEqual(results.map((result) => result.messages.at(-1)?.content), ["seed result", "dependent result"]);
});

test("process close after result publication confirms lifecycle exactly once", async () => {
  const completions: SingleResult[] = [];
  let child: MutableFakeProcess | undefined;
  let stdout: PassThrough | undefined;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const spawnedChild = createFakeProcess();
    const childStdout = new PassThrough();
    child = spawnedChild;
    stdout = childStdout;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: childStdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      childStdout.write(`${JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "close-ready" }],
        },
        toolResults: [],
      })}\n`);
    });
    return spawnedChild;
  });

  const result = await Promise.race([
    runSingleTeammate(
      { agent: "general", task: "Close after result", context: "fresh", timeoutMs: 2_000 },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        onTurnComplete: (entry) => completions.push(entry),
      },
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close-race publication timed out")), 500)),
  ]);
  assert.equal(result.lifecyclePending, true);

  if (!child) throw new Error("fake child was not initialized");
  child.exitCode = 0;
  child.emit("close", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(completions.length, 1);
  assert.equal(completions[0].wakeable, false);
  assert.equal(completions[0].lifecyclePending, undefined);
});

test("process error after result publication fails lifecycle without retracting the result", async () => {
  const completions: SingleResult[] = [];
  let child: MutableFakeProcess | undefined;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const spawnedChild = createFakeProcess();
    child = spawnedChild;
    const stdout = new PassThrough();
    Object.assign(spawnedChild, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() {
        spawnedChild.exitCode = 1;
        spawnedChild.emit("exit", 1, null);
        spawnedChild.emit("close", 1, null);
        return true;
      },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "result survives lifecycle error" }],
        },
        toolResults: [],
      })}\n`);
    });
    return spawnedChild;
  });

  const result = await Promise.race([
    runSingleTeammate(
      { agent: "general", task: "Error after result", context: "fresh", timeoutMs: 2_000 },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        onTurnComplete: (entry) => completions.push(entry),
      },
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("error-race publication timed out")), 500)),
  ]);
  assert.equal(result.messages.at(-1)?.content, "result survives lifecycle error");
  assert.equal(result.lifecyclePending, true);

  if (!child) throw new Error("fake child was not initialized");
  child.emit("error", new Error("late transport failure"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(completions.length, 1);
  assert.equal(completions[0].exitCode, 1);
  assert.equal(completions[0].wakeable, false);
  assert.match(completions[0].messages.at(-1)?.content ?? "", /late transport failure/);
});

test("child RPC sends the prompt without disabling Pi auto-retry", async () => {
  let written = "";
  const spawnChildProcess = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.on("data", (chunk) => { written += chunk.toString(); });
    Object.assign(child, {
      stdin, stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Do the work", context: "fork" },
    { baseCwd: process.cwd(), spawnChildProcess },
  );
  assert.equal(result.exitCode, 0);
  const commands = written.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(commands.some((c: Record<string, unknown>) => c.type === "set_auto_retry"), false,
    "Pi auto-retry must stay enabled; the parent no longer disables it");
  assert.deepEqual(commands[0], { type: "prompt", message: "Do the work" });
});

test("concurrent child retry overrides restore the original global setting once", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retry-guard-"));
  try {
    const settingsPath = path.join(tempDir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: "custom",
      retry: { enabled: true, maxRetries: 10, provider: { maxRetries: 0 } },
    }));
    const releaseFirst = acquireRetryPersistenceGuard(settingsPath);
    const releaseSecond = acquireRetryPersistenceGuard(settingsPath);

    fs.writeFileSync(settingsPath, JSON.stringify({
      theme: "custom",
      retry: { enabled: false, maxRetries: 10, provider: { maxRetries: 0 } },
    }));
    releaseFirst();
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).retry.enabled, false);
    releaseSecond();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(restored.theme, "custom");
    assert.deepEqual(restored.retry, {
      enabled: true,
      maxRetries: 10,
      provider: { maxRetries: 0 },
    });
    releaseSecond();
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, "utf8")).retry.enabled, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("teammate retries a transient network failure before succeeding", async () => {
  let attempts = 0;
  const retryDelays: number[] = [];
  const spawnChildProcess = adaptFakeSpawn(() => {
    attempts++;
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (attempts === 1) {
        child.emit("error", new Error("fetch failed: ECONNRESET"));
        return;
      }
      stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }] } })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Recover from a transient failure", context: "fork" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onRetry(retry) { retryDelays.push(retry.delayMs); },
      async waitForRetry(delayMs) { return delayMs === 1_000; },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(retryDelays, [1_000]);
  assert.match(result.messages.at(-1)?.content ?? "", /recovered/);
});

test("first-activity timeout remains a failure when the terminated child closes cleanly", async () => {
  let retries = 0;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() {
        queueMicrotask(() => child.emit("close", 0, null));
        return true;
      },
    });
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Detect a silent child", context: "fork" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      firstActivityTimeoutMs: 5,
      onRetry() { retries += 1; },
      async waitForRetry() { return false; },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(retries, 1);
  assert.match(result.messages.at(-1)?.content ?? "", /first child agent event/i);
});

test("teammate exhausts a primary model, falls back, and skips its open circuit on later runs", async () => {
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
  const launchedModels: string[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    const modelIndex = args.indexOf("--model");
    const model = modelIndex >= 0 ? args[modelIndex + 1] : "unknown";
    launchedModels.push(model);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (model === "provider/primary") {
        stdout.write(`${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "Provider returned error: 503 unavailable" },
        })}\n`);
        stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
        return;
      }
      stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fallback recovered" }] } })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });
  const params = {
    agent: "general",
    task: "Use a healthy model",
    model: "provider/primary",
    fallbackModels: ["provider/backup"],
    context: "fork" as const,
  };
  const options = {
    baseCwd: process.cwd(),
    modelCircuitBreaker: breaker,
    modelCapabilities: [
      { id: "provider/primary" },
      { id: "provider/backup" },
    ],
    spawnChildProcess,
    async waitForRetry() { return true; },
  };

  const first = await runSingleTeammate(params, options);
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.attemptedModels, ["provider/primary", "provider/backup"]);
  assert.deepEqual(launchedModels, [
    ...Array<string>(11).fill("provider/primary"),
    "provider/backup",
  ]);
  assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");

  launchedModels.length = 0;
  const second = await runSingleTeammate(params, options);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(launchedModels, ["provider/backup"]);
});

test("billing failures advance to the fallback model without retrying the exhausted provider", async () => {
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
  const launchedModels: string[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    const modelIndex = args.indexOf("--model");
    const model = args[modelIndex + 1];
    launchedModels.push(model);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (model === "provider/primary") {
        stdout.write(`${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "402: Insufficient Balance" },
        })}\n`);
      } else {
        stdout.write(`${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "fallback recovered" }] },
        })}\n`);
      }
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const options = {
    baseCwd: process.cwd(),
    modelCircuitBreaker: breaker,
    modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
    spawnChildProcess,
  };
  const params = {
    agent: "general",
    task: "Use a funded model",
    model: "provider/primary",
    fallbackModels: ["provider/backup"],
    context: "fork" as const,
  };

  const result = await runSingleTeammate(params, options);

  assert.equal(result.exitCode, 0);
  assert.equal(result.messages.at(-1)?.content, "fallback recovered");
  assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
  assert.deepEqual(launchedModels, ["provider/primary", "provider/backup"]);
  assert.equal(breaker.snapshot().find((entry) => entry.model === "provider/primary")?.state, "OPEN");

  launchedModels.length = 0;
  const second = await runSingleTeammate(params, options);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(launchedModels, ["provider/backup"]);
});

test("candidate failure does not publish a terminal lifecycle before fallback completes", async () => {
  const launchedModels: string[] = [];
  const completions: SingleResult[] = [];
  const controller = new AbortController();
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    const modelIndex = args.indexOf("--model");
    const model = args[modelIndex + 1];
    launchedModels.push(model);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (model === "provider/primary") {
        stdout.write(`${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "402: Insufficient Balance" },
        })}\n`);
      } else {
        stdout.write(`${JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "fallback recovered" }] },
        })}\n`);
      }
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "Use a funded model",
      model: "provider/primary",
      fallbackModels: ["provider/backup"],
      context: "fork",
    },
    {
      baseCwd: process.cwd(),
      modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
      spawnChildProcess,
      signal: controller.signal,
      onTurnComplete(result) {
        completions.push(result);
        if (result.exitCode !== 0) controller.abort();
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(launchedModels, ["provider/primary", "provider/backup"]);
  assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].exitCode, 0);
  assert.equal(controller.signal.aborted, false);
});

test("permanent provider failures override overlapping billing fallback markers", async () => {
  const launchedModels: string[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    const modelIndex = args.indexOf("--model");
    launchedModels.push(args[modelIndex + 1]);
    const child = createFakeProcess();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => child.emit(
      "error",
      new Error("402 Unauthorized: invalid API key; Insufficient Balance"),
    ));
    return child;
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "Do not reroute permanent failures",
    model: "provider/primary",
    fallbackModels: ["provider/backup"],
    context: "fork",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
    spawnChildProcess,
    async waitForRetry() { return true; },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(launchedModels, ["provider/primary"]);
  assert.equal(result.attemptedModels, undefined);
});

test("resolved model aliases are deduplicated before retry and breaker accounting", async () => {
  let attempts = 0;
  const breaker = new ModelCircuitBreaker({ threshold: 2 });
  const spawnChildProcess = adaptFakeSpawn(() => {
    attempts += 1;
    const child = createFakeProcess();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => child.emit("error", new Error("Provider returned error: 503 unavailable")));
    return child;
  });

  await runSingleTeammate({
    agent: "general",
    task: "Deduplicate aliases",
    model: "provider",
    fallbackModels: ["provider/model"],
    context: "fork",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/model" }],
    modelCircuitBreaker: breaker,
    spawnChildProcess,
    async waitForRetry() { return true; },
  });

  assert.equal(attempts, 11);
  assert.deepEqual(breaker.snapshot().find((entry) => entry.model === "provider/model"), {
    model: "provider/model",
    state: "CLOSED",
    consecutiveFailures: 1,
    halfOpenTrialInProgress: false,
  });
});

test("teammate stops after the initial attempt and ten transient retries", async () => {
  let attempts = 0;
  const retries: number[] = [];
  const spawnChildProcess = adaptFakeSpawn(() => {
    attempts++;
    const child = createFakeProcess();
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Bound transient retries", context: "fork" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onRetry(retry) { retries.push(retry.attempt); },
      async waitForRetry() { return true; },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(attempts, 11);
  assert.deepEqual(retries, Array.from({ length: 10 }, (_, index) => index + 1));
});

test("retry budget is shared across model candidates", async () => {
  const launchedModels: string[] = [];
  const retries: number[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    const modelIndex = args.indexOf("--model");
    launchedModels.push(args[modelIndex + 1]);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Provider returned error: 503 unavailable" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "Bound retries across fallbacks",
    model: "provider/primary",
    fallbackModels: ["provider/backup"],
    context: "fork",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
    spawnChildProcess,
    onRetry(retry) { retries.push(retry.attempt); },
    async waitForRetry() { return true; },
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(retries, Array.from({ length: 10 }, (_, index) => index + 1));
  assert.deepEqual(launchedModels, [
    ...Array<string>(11).fill("provider/primary"),
    "provider/backup",
  ]);
});

test("a failed attempt with completed tools falls back to the next model", async () => {
  const launchedModels: string[] = [];
  const retries: number[] = [];
  const spawnChildProcess = adaptFakeSpawn((_command, args) => {
    const modelIndex = args.indexOf("--model");
    launchedModels.push(args[modelIndex + 1]);
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "write", isError: false })}\n`);
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "Provider returned error: 503 unavailable" },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate({
    agent: "general",
    task: "Do not repeat side effects",
    model: "provider/primary",
    fallbackModels: ["provider/backup"],
    context: "fork",
  }, {
    baseCwd: process.cwd(),
    modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
    spawnChildProcess,
    onRetry(retry) { retries.push(retry.attempt); },
    async waitForRetry() { return true; },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.toolCount, 1);
  assert.deepEqual(retries, [], "same-model restart retry is suppressed after tool calls");
  assert.deepEqual(launchedModels, ["provider/primary", "provider/backup"],
    "model fallback must proceed even after tool calls");
  assert.match(result.messages.at(-1)?.content ?? "", /Model fallback/i);
});

test("connection error remains retryable when an abnormal-exit diagnostic follows it", async () => {
  let attempts = 0;
  const retryErrors: string[] = [];
  const spawnChildProcess = adaptFakeSpawn(() => {
    attempts += 1;
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      if (attempts === 1) {
        stdout.write(`${JSON.stringify({ type: "error", errorMessage: "Error: Connection error." })}\n`);
        child.emit("close", 1, null);
        return;
      }
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "recovered" }] },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Recover from connection loss", context: "fork" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onRetry(retry) { retryErrors.push(retry.error); },
      async waitForRetry() { return true; },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(attempts, 2);
  assert.match(retryErrors[0] ?? "", /Connection error/);
});

test("fresh agents publish follow-up turns while fork agents terminate after their first result", async () => {
  const completions: string[] = [];
  const progressUsage: Array<[number | undefined, number | undefined]> = [];
  let freshStdout: PassThrough | undefined;
  let freshKilled = false;
  const spawnFresh = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const stdin = new PassThrough();
    const childStdout = new PassThrough();
    freshStdout = childStdout;
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout: childStdout,
      stderr,
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { freshKilled = true; return true; },
    });
    setTimeout(() => {
      childStdout.write(`${JSON.stringify({ type: "message_end", message: { role: "user", content: "original prompt" } })}\n`);
      childStdout.write(`${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          model: "maestro-qwen/qwen3.8-max-preview",
          usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
        },
      })}\n`);
      childStdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }, 0);
    return child;
  });

  const first = await runSingleTeammate(
    { agent: "general", task: "original prompt", context: "fresh", timeoutMs: 2_000 },
    {
      baseCwd: process.cwd(),
      spawnChildProcess: spawnFresh,
      onProgress(progress) {
        progressUsage.push([progress.inputTokens, progress.outputTokens]);
      },
      onTurnComplete(result) {
        completions.push(result.messages.at(-1)?.content ?? "");
      },
    },
  );
  assert.deepEqual(first.messages.map((message) => message.content), ["first answer"]);
  assert.equal(first.model, "maestro-qwen/qwen3.8-max-preview");
  assert.equal(first.usage.inputTokens, 12);
  assert.equal(first.usage.outputTokens, 4);
  assert.equal(first.wakeable, true);
  assert.equal(freshKilled, false);

  if (!freshStdout) throw new Error("fresh fake stdout was not initialized");
  freshStdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(progressUsage.at(-1), [12, 4]);
  freshStdout.write(`${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "follow-up answer" }],
      usage: { input: 6, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
    },
  })}\n`);
  freshStdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(completions, ["first answer", "follow-up answer"]);
  assert.deepEqual(progressUsage.at(-1), [18, 7]);

  let forkKilled = false;
  const spawnFork = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() {
        forkKilled = true;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        return true;
      },
    });
    setTimeout(() => {
      stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fork answer" }] } })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }, 0);
    return child;
  });
  const fork = await runSingleTeammate(
    { agent: "general", task: "fork once", context: "fork", timeoutMs: 2_000 },
    { baseCwd: process.cwd(), spawnChildProcess: spawnFork },
  );
  assert.equal(fork.wakeable, false);
  assert.equal(forkKilled, true);
});

test("recursive abort follows descendants without expanding through controller identity", () => {
  const root = activeAgent();
  root.correlationId = "root";
  const child = activeAgent();
  child.correlationId = "child";
  child.spawnedBy = "root";
  const shared = activeAgent();
  shared.correlationId = "shared";
  shared.abortController = child.abortController;
  const grandchild = activeAgent();
  grandchild.correlationId = "grandchild";
  grandchild.spawnedBy = "child";
  const unrelated = activeAgent();
  unrelated.correlationId = "unrelated";
  const state = teammateState([root, child, shared, grandchild, unrelated]);
  state.namedAgents.set("child-name", "child");

  const terminated = new Set(killAgentTree(state, "root"));
  assert.deepEqual(terminated, new Set(["root", "child", "grandchild"]));
  assert.equal(root.abortController.signal.aborted, true);
  assert.equal(child.abortController.signal.aborted, true);
  assert.equal(grandchild.abortController.signal.aborted, true);
  assert.equal(state.activeRuns.has("shared"), true);
  assert.equal(state.activeRuns.has("unrelated"), true);
  assert.equal(state.namedAgents.has("child-name"), false);
});

test("structured_output tool completion settles the child without waiting for agent_end", async () => {
  const payload = {
    path: ["runtime"],
    findings: ["settled"],
    evidence: [{ ref: "src/runtime.ts:1", claim: "tool completed" }],
    candidate: { summary: "done", details: "done", actions: ["ship"], risks: [] },
    selfScore: 0.9,
    confidence: 0.9,
  };
  const schema = {
    type: "object",
    required: ["path", "findings", "evidence", "candidate", "selfScore", "confidence"],
    properties: {
      path: { type: "array", items: { type: "string" } },
      findings: { type: "array", items: { type: "string" } },
      evidence: { type: "array" },
      candidate: { type: "object" },
      selfScore: { type: "number" },
      confidence: { type: "number" },
    },
  };
  const progress: AgentProgress[] = [];
  let killed = false;
  let completionObserverCalled = false;
  const spawnChildProcess = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() {
        killed = true;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        return true;
      },
    });
    setTimeout(() => {
      stdout.write(`${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "toolCall", name: "structured_output", arguments: payload }] },
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "structured_output" })}\n`);
      stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolName: "structured_output", isError: false })}\n`);
      // These lines model stdout already buffered when settlement terminates
      // the child. None may restart progress or alter the published result.
      stdout.write(`${JSON.stringify({ type: "tool_result", toolName: "structured_output", content: "Structured output saved." })}\n`);
      stdout.write(`${JSON.stringify({ type: "turn_start" })}\n`);
      stdout.write(`${JSON.stringify({ type: "message_end", content: "late assistant wake" })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }, 0);
    return child;
  });

  const result = await Promise.race([
    runSingleTeammate(
      { agent: "general", task: "Return structured output", outputSchema: schema, timeoutMs: 2_000 },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        onProgress: (entry) => progress.push({ ...entry, recentTools: [...entry.recentTools] }),
        onTurnComplete() {
          completionObserverCalled = true;
          throw new Error("observer failed after publication");
        },
      },
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("settlement timed out")), 500)),
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.structuredOutput, payload);
  assert.equal(progress.at(-1)?.status, "completed");
  const completedIndex = progress.findIndex((entry) => entry.status === "completed");
  assert.ok(completedIndex >= 0);
  assert.equal(progress.slice(completedIndex + 1).length, 0, "terminal progress must be absorbing");
  assert.equal(result.messages.some((message) => /late assistant wake|Structured output saved/.test(message.content)), false);
  assert.equal(completionObserverCalled, true);
  assert.equal(killed, true, "settled child must be reclaimed after final structured output");
});

test("structured_output arguments are rejected when tool execution fails", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  };
  const spawnChildProcess = adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(), stdout, stderr: new PassThrough(), connected: false,
      exitCode: null, signalCode: null, pid: undefined,
      kill() { return true; },
    });
    queueMicrotask(() => {
      stdout.write(`${JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "toolCall",
            id: "structured-call",
            name: "structured_output",
            arguments: { answer: "not persisted" },
          }],
        },
      })}\n`);
      stdout.write(`${JSON.stringify({
        type: "tool_execution_end",
        toolName: "structured_output",
        toolCallId: "structured-call",
        isError: true,
      })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Return structured output", outputSchema: schema, timeoutMs: 2_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.structuredOutput, undefined);
  assert.match(result.messages.at(-1)?.content ?? "", /schema-valid value/);
});

test("parent rejects a schema-invalid structured output file", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  };
  const spawnChildProcess = adaptFakeSpawn((_command, _args, options) => {
    const child = createFakeProcess();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { return true; },
    });
    const outputFile = options.env?.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH;
    if (typeof outputFile !== "string") {
      throw new Error("structured output path was not provided to the fake child");
    }
    setTimeout(() => {
      fs.writeFileSync(outputFile, JSON.stringify({ ok: "not-a-boolean" }));
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }, 0);
    return child;
  });

  const result = await runSingleTeammate(
    { agent: "general", task: "Return structured output", outputSchema: schema, timeoutMs: 2_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.structuredOutput, undefined);
  assert.match(result.messages.at(-1)?.content ?? "", /schema-valid value/);
});

// --- Lane safety-net regressions: a lane must never wedge the caller forever ---

function spawnScriptedChild(
  script: (stdout: PassThrough) => void,
  onKill?: () => void,
): SpawnChildProcess {
  return adaptFakeSpawn(() => {
    const child = createFakeProcess();
    const stdout = new PassThrough();
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() {
        onKill?.();
        setImmediate(() => child.emit("close", null, "SIGTERM"));
        return true;
      },
    });
    queueMicrotask(() => script(stdout));
    return child;
  });
}

test("outputSchema lane settles with its published result when agent_end never arrives", async () => {
  let killed = 0;
  const spawnChildProcess = spawnScriptedChild(
    (stdout) => {
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ready answer" }] },
      })}\n`);
      stdout.write(`${JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ready answer" }] },
        toolResults: [],
      })}\n`);
    },
    () => { killed++; },
  );

  const result = await Promise.race([
    runSingleTeammate(
      {
        agent: "general",
        task: "Return structured output",
        context: "fresh",
        outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      },
      { baseCwd: process.cwd(), spawnChildProcess, resultReadyGraceMs: 40 },
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("outputSchema lane blocked past its grace period")), 1_000)),
  ]);

  assert.equal(result.lifecyclePending ?? false, false, "grace settlement must not leave the lane lifecycle-pending");
  assert.equal(result.exitCode, 1, "missing schema-valid structured_output settles as failed");
  assert.ok(result.messages.some((m) => m.content.includes("ready answer")), "published transcript is preserved");
  assert.ok(result.messages.some((m) => m.role === "system" && m.content.includes("structured_output")), "schema miss is noted");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(killed, 1, "child is terminated after grace settlement");
});

test("foreground wait settings never terminate a running child process", async () => {
  let killed = 0;
  let stdoutRef: PassThrough | undefined;
  const spawnChildProcess = spawnScriptedChild(
    (stdout) => {
      stdoutRef = stdout;
      stdout.write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "still working" }] },
      })}\n`);
    },
    () => { killed++; },
  );

  const pending = runSingleTeammate(
    { agent: "general", task: "Long review", context: "fresh", timeoutMs: 40 },
    { baseCwd: process.cwd(), spawnChildProcess, foregroundMaxRunMs: 40 },
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(killed, 0, "foreground wait expiry must not terminate the child");

  if (!stdoutRef) throw new Error("fake stdout was not initialized");
  stdoutRef.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.ok(result.messages.some((message) => message.content.includes("still working")));
});

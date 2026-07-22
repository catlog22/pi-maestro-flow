import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
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
  appendBoundedTranscriptMessage,
  buildPiArgs,
  createUtf8LineDecoder,
  getPiSpawnCommand,
  releasePublishedTurnHistory,
  resolveModelSpecifier,
  runTeammate,
  validateModelSpecifier,
} from "../src/runs/execution.ts";
import type { ActiveAgent, AgentProgress, AgentProgressSnapshot, TeammateState, Usage } from "../src/shared/types.ts";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";

const baseAgentConfig: AgentConfig = {
  name: "delegate",
  description: "Delegate",
  tools: ["read"],
  systemPromptMode: "append",
  inheritProjectContext: true,
  inheritSkills: false,
  systemPrompt: "Delegate prompt",
  source: "builtin",
  filePath: "delegate.md",
};

function activeAgent(): ActiveAgent {
  const now = Date.now();
  return {
    agent: "delegate",
    name: "bounded",
    correlationId: "agent-bounded",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running",
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
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
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

test("root progress cleanup flushes then disposes on success, error, and termination", async () => {
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
  const executeStart = source.indexOf("async execute(");
  const executeEnd = source.indexOf("renderCall(args", executeStart);
  assert.ok(executeStart >= 0 && executeEnd > executeStart);
  const rootExecute = source.slice(executeStart, executeEnd);
  assert.equal(rootExecute.match(/runWithProgressFlushCleanup\(/g)?.length, 3);
  assert.doesNotMatch(rootExecute, /runTeammate\(params, makeOptions\(\)\)/);

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
  const source = fs.readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
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
    agent: "delegate",
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
    agent: "delegate",
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
      () => buildPiArgs(baseAgentConfig, { agent: "delegate", model: invalid }, "prompt.md"),
      /Invalid teammate model specifier/,
    );
  }
});

test("invalid model input is rejected before a child process is spawned", async () => {
  const result = await runTeammate(
    { agent: "delegate", task: "Do work", model: "openai/gpt-5&whoami" },
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

test("fresh agents publish follow-up turns while fork agents terminate after their first result", async () => {
  const completions: string[] = [];
  let freshStdout: PassThrough | undefined;
  let freshKilled = false;
  const spawnFresh = (() => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    freshStdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout: freshStdout,
      stderr,
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { freshKilled = true; return true; },
    });
    setTimeout(() => {
      freshStdout!.write(`${JSON.stringify({ type: "message_end", message: { role: "user", content: "original prompt" } })}\n`);
      freshStdout!.write(`${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          model: "maestro-qwen/qwen3.8-max-preview",
          usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } },
        },
      })}\n`);
      freshStdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }, 0);
    return child;
  }) as NonNullable<Parameters<typeof runTeammate>[1]["spawnChildProcess"]>;

  const first = await runTeammate(
    { agent: "delegate", task: "original prompt", context: "fresh", timeoutMs: 2_000 },
    {
      baseCwd: process.cwd(),
      spawnChildProcess: spawnFresh,
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

  freshStdout!.write(`${JSON.stringify({ type: "turn_start" })}\n`);
  freshStdout!.write(`${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "follow-up answer" }],
      usage: { input: 6, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
    },
  })}\n`);
  freshStdout!.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(completions, ["first answer", "follow-up answer"]);

  let forkKilled = false;
  const spawnFork = (() => {
    const child = new EventEmitter() as ChildProcess;
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
  }) as NonNullable<Parameters<typeof runTeammate>[1]["spawnChildProcess"]>;
  const fork = await runTeammate(
    { agent: "delegate", task: "fork once", context: "fork", timeoutMs: 2_000 },
    { baseCwd: process.cwd(), spawnChildProcess: spawnFork },
  );
  assert.equal(fork.wakeable, false);
  assert.equal(forkKilled, true);
});

test("recursive abort removes descendants and every agent sharing their process controller", () => {
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
  assert.deepEqual(terminated, new Set(["root", "child", "shared", "grandchild"]));
  assert.equal(root.abortController.signal.aborted, true);
  assert.equal(child.abortController.signal.aborted, true);
  assert.equal(grandchild.abortController.signal.aborted, true);
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
  const spawnChildProcess = (() => {
    const child = new EventEmitter() as ChildProcess;
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
  }) as NonNullable<Parameters<typeof runTeammate>[1]["spawnChildProcess"]>;

  const result = await Promise.race([
    runTeammate(
      { agent: "swarm-ant", task: "Return structured output", outputSchema: schema, timeoutMs: 2_000 },
      {
        baseCwd: process.cwd(),
        allowInternalSwarmAnt: true,
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

test("parent rejects a schema-invalid structured output file", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  };
  const spawnChildProcess = ((_command: string, _args: readonly string[], options: Record<string, any>) => {
    const child = new EventEmitter() as ChildProcess;
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
    const outputFile = String(options.env.PI_TEAMMATE_STRUCTURED_OUTPUT_PATH);
    setTimeout(() => {
      fs.writeFileSync(outputFile, JSON.stringify({ ok: "not-a-boolean" }));
      stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
    }, 0);
    return child;
  }) as NonNullable<Parameters<typeof runTeammate>[1]["spawnChildProcess"]>;

  const result = await runTeammate(
    { agent: "swarm-ant", task: "Return structured output", outputSchema: schema, timeoutMs: 2_000 },
    { baseCwd: process.cwd(), allowInternalSwarmAnt: true, spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.structuredOutput, undefined);
  assert.match(result.messages.at(-1)?.content ?? "", /schema-valid value/);
});

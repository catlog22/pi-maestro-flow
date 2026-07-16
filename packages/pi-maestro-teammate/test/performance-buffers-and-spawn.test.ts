import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import type { AgentConfig } from "../src/agents/agents.ts";
import {
  AGENT_BUFFER_LIMITS,
  buildWatchOutput,
  createProgressFlushGate,
  retainBoundedAgentHistory,
  runWithProgressFlushCleanup,
} from "../src/extension/index.ts";
import {
  EXECUTION_BUFFER_LIMITS,
  appendBoundedTranscriptMessage,
  buildPiArgs,
  createUtf8LineDecoder,
  getPiSpawnCommand,
  releasePublishedTurnHistory,
  runTeammate,
  validateModelSpecifier,
} from "../src/runs/execution.ts";
import type { ActiveAgent, AgentProgress, AgentProgressSnapshot, Usage } from "../src/shared/types.ts";
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
  const callbackStart = proxyProgress.indexOf("onProgress: normalizedTasks");
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

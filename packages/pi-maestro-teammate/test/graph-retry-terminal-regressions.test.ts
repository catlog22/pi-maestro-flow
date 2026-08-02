import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  runGraph,
  runSingleTeammate,
  type NormalizedTask,
  type RunTeammateOptions,
} from "../src/runs/execution.ts";
import { aggregateTerminalStatuses } from "../src/extension/teammate-core.ts";
import type { AgentTerminalStatus, SingleResult } from "../src/shared/types.ts";
import { ModelCircuitBreaker } from "../src/models/model-circuit-breaker.ts";
import { classifyRetryError } from "../src/runs/retry.ts";

type SpawnSeam = NonNullable<RunTeammateOptions["spawnChildProcess"]>;

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: false,
    exitCode: null,
    signalCode: null,
    pid: undefined,
    kill() {
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return true;
    },
  });
  return child;
}

test("dependency-skipped DAG tasks publish a synthetic terminal completion", async () => {
  let spawns = 0;
  const completions: Array<{ result: SingleResult; status?: AgentTerminalStatus }> = [];
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = fakeChild();
    queueMicrotask(() => {
      (child.stdout as PassThrough).write(`${JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Invalid API key",
        },
      })}\n`);
      (child.stdout as PassThrough).write(`${JSON.stringify({ type: "agent_end" })}\n`);
    });
    return child;
  }) as unknown as SpawnSeam;
  const tasks: NormalizedTask[] = [
    { agent: "general", name: "seed", prompt: "fail" },
    { agent: "general", name: "dependent", prompt: "use {seed}", dependsOn: ["seed"] },
  ];

  const results = await runGraph(tasks, 2, {
    baseCwd: process.cwd(),
    taskCorrelationIds: ["seed-cid", "dependent-cid"],
    spawnChildProcess,
    onTurnComplete(result, status) { completions.push({ result, status }); },
  });

  assert.equal(spawns, 1);
  assert.equal(results[0].exitCode, 1);
  assert.equal(results[1].exitCode, 1);
  assert.match(results[1].messages[0].content, /Skipped: upstream dependency failed/);
  assert.deepEqual(completions.map(({ result }) => result.correlationId).sort(), ["dependent-cid", "seed-cid"]);
  assert.equal(completions.find(({ result }) => result.correlationId === "dependent-cid")?.status, "failed");
});

test("child process failures do not enter an outer retry backoff", async () => {
  let spawns = 0;
  let retryCallbacks = 0;
  const controller = new AbortController();
  const completions: Array<{ result: SingleResult; status?: AgentTerminalStatus }> = [];
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "let Pi own retry", context: "fresh" },
    {
      baseCwd: process.cwd(),
      signal: controller.signal,
      spawnChildProcess,
      onRetry() { retryCallbacks += 1; },
      onTurnComplete(entry, status) { completions.push({ result: entry, status }); },
    },
  );

  assert.equal(spawns, 1);
  assert.equal(retryCallbacks, 0);
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.exitCode, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, "failed");
});

async function assertTerminalScenario(
  name: string,
  spawnChildProcess: SpawnSeam,
  expectedExitCode: number,
): Promise<void> {
  const completions: SingleResult[] = [];
  const result = await runSingleTeammate(
    { agent: "general", task: name, context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      async waitForRetry() { return false; },
      onTurnComplete(entry) { completions.push(entry); },
    },
  );

  assert.equal(result.exitCode, expectedExitCode);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].correlationId, result.correlationId);
}

test("synchronous spawn failure publishes one terminal completion", { timeout: 5_000 }, async () => {
  await assertTerminalScenario(
    "spawn",
    (() => { throw new Error("spawn denied"); }) as unknown as SpawnSeam,
    1,
  );
});

test("clean child close publishes one terminal completion", { timeout: 5_000 }, async () => {
  await assertTerminalScenario(
    "close",
    (() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }) as unknown as SpawnSeam,
    0,
  );
});

test("child error publishes one terminal completion", { timeout: 5_000 }, async () => {
  await assertTerminalScenario(
    "error",
    (() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit("error", new Error("local child failure")));
      return child;
    }) as unknown as SpawnSeam,
    1,
  );
});

test("all pre-execution graph rejections publish synthetic terminal completions", async () => {
  const cases: Array<{ name: string; tasks: NormalizedTask[]; message: RegExp }> = [
    {
      name: "invalid reference",
      tasks: [{ agent: "general", name: "only", prompt: "only", dependsOn: ["missing"] }],
      message: /missing/i,
    },
    {
      name: "cycle",
      tasks: [
        { agent: "general", name: "left", prompt: "left", dependsOn: ["right"] },
        { agent: "general", name: "right", prompt: "right", dependsOn: ["left"] },
      ],
      message: /circular dependency/i,
    },
    {
      name: "duplicate",
      tasks: [
        { agent: "general", name: "same", prompt: "first" },
        { agent: "general", name: "same", prompt: "second" },
      ],
      message: /duplicate task name/i,
    },
  ];

  for (const graphCase of cases) {
    let spawns = 0;
    const completions: SingleResult[] = [];
    const ids = graphCase.tasks.map((_, index) => `${graphCase.name}-${index}`);
    const results = await runGraph(graphCase.tasks, 2, {
      baseCwd: process.cwd(),
      taskCorrelationIds: ids,
      spawnChildProcess: (() => { spawns += 1; return fakeChild(); }) as unknown as SpawnSeam,
      onTurnComplete(entry) { completions.push(entry); },
    });

    assert.equal(spawns, 0, graphCase.name);
    assert.equal(results.length, graphCase.tasks.length, graphCase.name);
    assert.equal(completions.length, graphCase.tasks.length, graphCase.name);
    assert.deepEqual(completions.map((entry) => entry.correlationId), ids, graphCase.name);
    assert.ok(results.every((entry) => entry.exitCode === 1), graphCase.name);
    assert.match(results[0].messages[0].content, graphCase.message, graphCase.name);
  }
});

test("provider failure returns directly without an outer retry cancellation phase", async () => {
  let spawns = 0;
  let retryCallbacks = 0;
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "single process failure", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onRetry() { retryCallbacks += 1; },
    },
  );

  assert.equal(spawns, 1);
  assert.equal(retryCallbacks, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.messages[0].content, /ECONNRESET/);
  assert.doesNotMatch(result.messages.map((message) => message.content).join("\n"), /retry backoff/i);
});

test("cancelling between fallback candidates returns terminated cancellation", async () => {
  const breaker = new ModelCircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
  const controller = new AbortController();
  const launchedModels: string[] = [];
  const completions: Array<{ result: SingleResult; status?: AgentTerminalStatus }> = [];
  const originalRecordFailure = breaker.recordRetryableFailure.bind(breaker);
  breaker.recordRetryableFailure = (acquisition) => {
    originalRecordFailure(acquisition);
    controller.abort();
  };
  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    launchedModels.push(args[args.indexOf("--model") + 1]);
    const child = fakeChild();
    queueMicrotask(() => {
      (child.stdout as PassThrough).write(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "402: Insufficient Balance" },
      })}\n`);
      (child.stdout as PassThrough).write(`${JSON.stringify({ type: "agent_end", willRetry: false })}\n`);
      (child.stdout as PassThrough).write(`${JSON.stringify({ type: "agent_settled" })}\n`);
    });
    return child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate({
    agent: "general", task: "cancel fallback", model: "provider/primary",
    fallbackModels: ["provider/backup"], context: "fork",
  }, {
    baseCwd: process.cwd(), signal: controller.signal,
    modelCircuitBreaker: breaker,
    modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
    spawnChildProcess,
    onTurnComplete(entry, status) { completions.push({ result: entry, status }); },
  });

  assert.deepEqual(launchedModels, ["provider/primary"]);
  assert.match(
    result.messages[0].content,
    /cancelled (?:before model candidate launch|during model fallback handoff)/i,
  );
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, "terminated");
});

test("rate_limit_exceeded variants remain retryable provider failures", () => {
  assert.equal(classifyRetryError("rate_limit_exceeded: retry later"), "provider");
  assert.equal(classifyRetryError("RATE LIMIT EXCEEDED"), "provider");
  assert.equal(classifyRetryError("rate-limit-exceeded"), "provider");
  assert.equal(classifyRetryError("429 Too Many Requests"), "provider");
});

test("DAG dependencies release at upstream result publication", async () => {
  const streams: PassThrough[] = [];
  let spawns = 0;
  const completions: Array<{ result: SingleResult; status?: AgentTerminalStatus }> = [];
  const spawnChildProcess = (() => {
    const index = spawns++;
    const child = fakeChild();
    const stdout = new PassThrough();
    Object.assign(child, { stdout });
    streams.push(stdout);
    queueMicrotask(() => {
      const text = index === 0 ? "seed result" : "dependent result";
      stdout.write(`${JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
        toolResults: [],
      })}\n`);
    });
    return child;
  }) as unknown as SpawnSeam;
  const graph = runGraph([
    { agent: "general", name: "seed", prompt: "seed", context: "fresh" },
    { agent: "general", name: "dependent", prompt: "use {seed}", dependsOn: ["seed"], context: "fresh" },
  ], 2, {
    baseCwd: process.cwd(),
    spawnChildProcess,
    resultReadyGraceMs: 60_000,
    onTurnComplete(result, status) { completions.push({ result, status }); },
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  // The seed's published result — not its agent_end — releases the dependent
  // and its {seed} variable (debug-notes-002).
  assert.equal(spawns, 2, "result publication must release the dependent");
  const results = await graph;
  assert.deepEqual(results.map((entry) => entry.messages.at(-1)?.content), ["seed result", "dependent result"]);
  assert.equal(completions.length, 0, "neither lifecycle has confirmed yet");

  streams[0].write(`${JSON.stringify({ type: "agent_end" })}\n`);
  streams[1].write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completions.length, 2, "lifecycle confirmation still settles both tasks");
  assert.equal(completions.every(({ status }) => status === "completed"), true);
});

test("graph rejection settles every task when progress observers throw", async () => {
  const completions: SingleResult[] = [];
  const results = await runGraph([
    { agent: "general", name: "left", prompt: "left", dependsOn: ["missing"] },
    { agent: "general", name: "right", prompt: "right", dependsOn: ["missing"] },
  ], 2, {
    baseCwd: process.cwd(),
    taskCorrelationIds: ["left-cid", "right-cid"],
    onProgress() { throw new Error("observer failed"); },
    onTurnComplete(result) { completions.push(result); },
  });

  assert.equal(results.length, 2);
  assert.equal(results.every((entry) => entry.exitCode === 1), true);
  assert.deepEqual(completions.map((entry) => entry.correlationId), ["left-cid", "right-cid"]);
});

test("post-publish lifecycle failure settles failed without revoking the consumable result", async () => {
  const children: ChildProcess[] = [];
  const spawnChildProcess = (() => {
    const child = fakeChild();
    children.push(child);
    queueMicrotask(() => {
      (child.stdout as PassThrough).write(`${JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "consumable answer" }] },
        toolResults: [],
      })}\n`);
    });
    return child;
  }) as unknown as SpawnSeam;
  const completions: Array<{ result: SingleResult; status?: AgentTerminalStatus }> = [];
  const results = await runGraph([
    { agent: "general", name: "only", prompt: "work", context: "fresh" },
  ], 1, {
    baseCwd: process.cwd(),
    spawnChildProcess,
    resultReadyGraceMs: 60_000,
    onTurnComplete(result, status) { completions.push({ result, status }); },
  });

  // The graph returned the published, consumable result.
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].lifecyclePending, true);
  assert.equal(results[0].messages.at(-1)?.content, "consumable answer");
  assert.equal(completions.length, 0);

  // The child crashes inside the lifecycle confirmation window: the terminal
  // record carries the failure even though the published result stood.
  children[0].emit("close", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, "failed");
  assert.equal(completions[0].result.exitCode, 1);
});

test("aggregateTerminalStatuses reflects terminal truth, not publish-time results", () => {
  assert.equal(aggregateTerminalStatuses(["completed", "completed"]), "completed");
  assert.equal(aggregateTerminalStatuses(["completed", "failed"]), "failed");
  assert.equal(aggregateTerminalStatuses(["terminated", "completed"]), "terminated");
  assert.equal(aggregateTerminalStatuses(["failed", "terminated"]), "failed");
  assert.equal(aggregateTerminalStatuses([undefined, "completed"]), "completed");
  assert.equal(aggregateTerminalStatuses([]), "completed");
});

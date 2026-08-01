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
import type { AgentTerminalStatus, SingleResult } from "../src/shared/types.ts";

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
    kill() { return true; },
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
  assert.equal(completions.find(({ result }) => result.correlationId === "dependent-cid")?.status, undefined);
});

test("cancelling retry backoff preserves terminated terminal classification", async () => {
  let spawns = 0;
  const controller = new AbortController();
  const completions: Array<{ result: SingleResult; status?: AgentTerminalStatus }> = [];
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "retry then cancel", context: "fresh" },
    {
      baseCwd: process.cwd(),
      signal: controller.signal,
      spawnChildProcess,
      onRetry() { controller.abort(); },
      async waitForRetry() { return false; },
      onTurnComplete(entry, status) { completions.push({ result: entry, status }); },
    },
  );

  assert.equal(spawns, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].status, "terminated");
  assert.equal(completions[0].result.correlationId, result.correlationId);
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

test("P3: cancelling retry backoff returns a cancellation result, not the provider error", async () => {
  let spawns = 0;
  const controller = new AbortController();
  const spawnChildProcess = (() => {
    spawns += 1;
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error("fetch failed: ECONNRESET")));
    return child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "retry then cancel", context: "fresh" },
    {
      baseCwd: process.cwd(),
      signal: controller.signal,
      spawnChildProcess,
      onRetry() { controller.abort(); },
      async waitForRetry() { return false; },
    },
  );

  assert.equal(spawns, 1);
  assert.equal(result.exitCode, 1);
  assert.match(result.messages[0].content, /cancelled during retry backoff/);
  // The cancellation leads the transcript; the provider diagnostics stay
  // behind it so the caller still has the root cause for detail.
  assert.ok(
    result.messages.some((m) => /ECONNRESET/.test(m.content)),
    "the original provider failure must remain in the transcript for detail",
  );
});

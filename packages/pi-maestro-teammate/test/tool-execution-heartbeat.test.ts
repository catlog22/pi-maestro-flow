import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { runSingleTeammate } from "../src/runs/execution.ts";
import type { AgentProgress } from "../src/shared/types.ts";

type SpawnSeam = NonNullable<Parameters<typeof runSingleTeammate>[1]["spawnChildProcess"]>;

interface FakeChildHandle {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  killed(): boolean;
  close(code: number | null, signal: NodeJS.Signals | null): void;
}

function createFakeChild(): FakeChildHandle {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    (child as { exitCode: number | null }).exitCode = code;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = signal;
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout,
    stderr,
    connected: false,
    exitCode: null,
    signalCode: null,
    pid: undefined,
    kill() {
      killed = true;
      queueMicrotask(() => close(null, "SIGTERM"));
      return true;
    },
  });
  return { child, stdout, stderr, killed: () => killed, close };
}

const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a long-running tool keeps progress activity fresh via heartbeat; the heartbeat stops once the tool completes", async () => {
  let handle: FakeChildHandle | undefined;
  const progressCalls: AgentProgress[] = [];

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      const commands = chunk.toString().trim().split("\n").filter(Boolean).map((raw) => JSON.parse(raw));
      for (const command of commands) {
        if (command.type !== "prompt" || command.id !== undefined) continue;
        // The tool starts and stays in flight: a busy bash script emits no
        // further child events until it completes.
        queueMicrotask(() => {
          handle!.stdout.write(line({ type: "agent_start" }));
          handle!.stdout.write(line({ type: "turn_start" }));
          handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
        });
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const resultPromise = runSingleTeammate(
    { agent: "general", task: "run a long bash script", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      toolExecutionHeartbeatMs: 15,
      onProgress: (progress) => progressCalls.push({
        ...progress,
        // Snapshot the timestamp: the runtime mutates the same progress object.
        lastActivityAt: progress.lastActivityAt ?? 0,
      }),
    },
  );

  // Wait for the tool to be in flight and for several heartbeat ticks.
  const heartbeatDeadline = Date.now() + 5_000;
  while (
    progressCalls.filter((entry) => entry.phase === "tool-execution").length < 3
    && Date.now() < heartbeatDeadline
  ) {
    await delay(20);
  }

  const toolCalls = progressCalls.filter((entry) => entry.phase === "tool-execution");
  assert.ok(toolCalls.length >= 3, `expected repeated tool-execution progress, got ${toolCalls.length}`);
  const lastActivity = toolCalls[toolCalls.length - 1].lastActivityAt ?? 0;
  assert.ok(
    Date.now() - lastActivity < 80,
    `heartbeat must keep lastActivityAt fresh (stale by ${Date.now() - lastActivity}ms)`,
  );
  // Activity must keep advancing across ticks — the stall clock stays reset.
  const activities = toolCalls.map((entry) => entry.lastActivityAt ?? 0);
  const advancing = activities.filter((value, index) => index === 0 || value > activities[index - 1]).length;
  assert.ok(advancing >= toolCalls.length - 1, "heartbeat ticks must advance lastActivityAt");

  // Complete the tool: the heartbeat must stop instead of running forever.
  handle!.stdout.write(line({ type: "tool_execution_end", toolName: "bash" }));
  await delay(20);
  assert.equal(
    progressCalls.at(-1)?.phase,
    "continuing",
    "silence after a completed tool belongs to model continuation, not tool execution",
  );
  const callsAtToolEnd = progressCalls.length;
  await delay(100); // several heartbeat periods
  assert.equal(
    progressCalls.length,
    callsAtToolEnd,
    "no progress events may be emitted after the last tool completes",
  );

  // Settle the turn and reap the child.
  handle!.stdout.write(line({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "bash finished" }] },
  }));
  handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
  handle!.stdout.write(line({ type: "agent_settled" }));
  await delay(20);
  handle!.close(0, null);

  const result = await resultPromise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.terminalStatus, "completed");
  assert.equal(handle!.killed(), false);
});

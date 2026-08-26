import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  findStructuredOutputSchemaHazard,
  resolveContainedCwd,
  runSingleTeammate,
  sendRpcMessage,
  teammateTempRoot,
} from "../src/runs/execution.ts";
import type { AgentProgress, SingleResult } from "../src/shared/types.ts";

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

const resultReadyTurnEnd = (text: string): Record<string, unknown> => ({
  type: "turn_end",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  toolResults: [],
});

// ---------------------------------------------------------------------------
// REL-4 — a published result must still confirm its lifecycle
// ---------------------------------------------------------------------------

test("interrupting steer waits for Pi abort acknowledgement and restarts the same session", async () => {
  let handle: FakeChildHandle | undefined;
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commands.push(command);

        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
          });
        } else if (command.type === "abort") {
          queueMicrotask(() => {
            // Pi may open an internal boundary before it publishes the aborted
            // message; this must not be mistaken for the correction prompt.
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", errorMessage: "Request aborted" },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "abort",
              success: true,
            }));
          });
        } else if (command.type === "prompt" && typeof command.id === "string") {
          queueMicrotask(() => {
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "prompt",
              success: true,
            }));
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "STEER_RESTART_OK" }] },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
          });
        }
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  const result = await runSingleTeammate(
    { agent: "general", task: "run a long tool", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onChildSpawned: (stream) => { stdin = stream; },
      onProgress: (progress) => {
        if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
        steerSent = true;
        assert.equal(sendRpcMessage(stdin, "replace the current work", "steer"), true);
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.terminalStatus, "completed");
  assert.equal(result.messages.at(-1)?.content, "STEER_RESTART_OK");
  assert.equal(handle!.killed(), false, "turn interruption must not terminate the logical teammate process");
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort", "prompt"]);
  assert.match(String(commands[1].id), /^teammate-steer-abort-/);
  assert.match(String(commands[2].id), /^teammate-steer-prompt-/);
  assert.equal(commands[2].message, "replace the current work");
});

test("late structured output from the aborted turn cannot settle an accepted steer", async () => {
  let handle: FakeChildHandle | undefined;
  const commandTypes: string[] = [];
  let stdinBuffer = "";
  const oldOutput = { marker: "OLD_TURN" };
  const newOutput = { marker: "CORRECTION_TURN" };

  const emitStructuredCall = (value: Record<string, string>): void => {
    handle!.stdout.write(line({
      type: "assistant",
      message: { content: [{ type: "toolCall", name: "structured_output", arguments: value }] },
    }));
    handle!.stdout.write(line({ type: "tool_execution_start", toolName: "structured_output" }));
  };

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commandTypes.push(String(command.type));

        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            emitStructuredCall(oldOutput);
          });
        } else if (command.type === "abort") {
          queueMicrotask(() => {
            // This is the old turn's terminal shortcut. It must be ignored
            // while the interrupt transaction owns settlement.
            handle!.stdout.write(line({
              type: "tool_execution_end",
              toolName: "structured_output",
              isError: false,
            }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", errorMessage: "Request aborted" },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "abort",
              success: true,
            }));
          });
        } else if (command.type === "prompt" && typeof command.id === "string") {
          queueMicrotask(() => {
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "prompt",
              success: true,
            }));
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            emitStructuredCall(newOutput);
            handle!.stdout.write(line({
              type: "tool_execution_end",
              toolName: "structured_output",
              isError: false,
            }));
          });
        }
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "return structured output",
      context: "fresh",
      outputSchema: {
        type: "object",
        properties: { marker: { type: "string" } },
        required: ["marker"],
      },
    },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onChildSpawned: (stream) => { stdin = stream; },
      onProgress: (progress) => {
        if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
        steerSent = true;
        assert.equal(sendRpcMessage(stdin, "replace the structured result", "steer"), true);
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.structuredOutput, newOutput);
  assert.notDeepEqual(result.structuredOutput, oldOutput);
  assert.deepEqual(commandTypes, ["prompt", "abort", "prompt"]);
});

test("managed steer fails when the child exits before the correction starts", async () => {
  let handle: FakeChildHandle | undefined;
  const commandTypes: string[] = [];
  let stdinBuffer = "";

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commandTypes.push(String(command.type));
        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
          });
        } else if (command.type === "abort") {
          queueMicrotask(() => {
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "abort",
              success: true,
            }));
          });
        } else if (command.type === "prompt" && typeof command.id === "string") {
          queueMicrotask(() => handle!.close(0, null));
        }
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  const result = await runSingleTeammate(
    { agent: "general", task: "run a long tool", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onChildSpawned: (stream) => { stdin = stream; },
      onProgress: (progress) => {
        if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
        steerSent = true;
        assert.equal(sendRpcMessage(stdin, "replace the current work", "steer"), true);
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.terminalStatus, "failed");
  assert.match(result.messages.at(-1)?.content ?? "", /exited before the correction prompt started/);
  assert.deepEqual(commandTypes, ["prompt", "abort", "prompt"]);
});

test("unacknowledged steer abort degrades to follow_up and the task continues", async () => {
  let handle: FakeChildHandle | undefined;
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commands.push(command);

        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
          });
        } else if (command.type === "abort") {
          // The child is blocked (long tool, permission prompt): the abort is
          // never acknowledged within the deadline.
        } else if (command.type === "follow_up") {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "TASK_CONTINUED" }] },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
          });
        }
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  // The fake child holds no real process handle and the degrade deadline is
  // unref'd, so keep the loop alive until the turn settles.
  const keepAlive = setInterval(() => {}, 10);
  let result: SingleResult;
  try {
    result = await runSingleTeammate(
      { agent: "general", task: "run a long tool", context: "fresh" },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        interruptingSteerTimeoutMs: 30,
        onChildSpawned: (stream) => { stdin = stream; },
        onProgress: (progress) => {
          if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
          steerSent = true;
          assert.equal(sendRpcMessage(stdin, "scope correction", "steer"), true);
        },
      },
    );
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(result.exitCode, 0, "an unacknowledged interrupt must not fail the task");
  assert.equal(result.terminalStatus, "completed");
  assert.equal(handle!.killed(), false, "a degraded steer must not terminate the child");
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort", "follow_up"]);
  assert.equal(commands[2].message, "scope correction");
  assert.equal(result.messages.at(-1)?.content, "TASK_CONTINUED");
  assert.ok(
    result.messages.some((entry) => entry.role === "system" && /Steer degraded to follow_up/.test(entry.content)),
    "the control error must stay visible in the transcript",
  );
});

test("rejected steer abort degrades to follow_up instead of failing the task", async () => {
  let handle: FakeChildHandle | undefined;
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commands.push(command);

        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
          });
        } else if (command.type === "abort") {
          queueMicrotask(() => {
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "abort",
              success: false,
            }));
          });
        } else if (command.type === "follow_up") {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "REJECTED_ABORT_CONTINUED" }] },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
          });
        }
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  // The fake child holds no real process handle; keep the loop alive while
  // waiting for the rejection response and the degraded follow_up.
  const keepAlive = setInterval(() => {}, 10);
  let result: SingleResult;
  try {
    result = await runSingleTeammate(
      { agent: "general", task: "run a long tool", context: "fresh" },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        interruptingSteerTimeoutMs: 500,
        onChildSpawned: (stream) => { stdin = stream; },
        onProgress: (progress) => {
          if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
          steerSent = true;
          assert.equal(sendRpcMessage(stdin, "scope correction", "steer"), true);
        },
      },
    );
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(result.exitCode, 0, "a rejected abort leaves the turn intact and must not fail it");
  assert.equal(result.terminalStatus, "completed");
  assert.equal(handle!.killed(), false);
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort", "follow_up"]);
  assert.equal(result.messages.at(-1)?.content, "REJECTED_ABORT_CONTINUED");
  assert.ok(
    result.messages.some(
      (entry) => entry.role === "system" && /Pi rejected the turn abort command/.test(entry.content),
    ),
  );
});

test("steer degrades when a new turn starts before abort acknowledgement", async () => {
  let handle: FakeChildHandle | undefined;
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commands.push(command);

        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
          });
        } else if (command.type === "abort") {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
            handle!.stdout.write(line({
              type: "response",
              id: command.id,
              command: "abort",
              success: true,
            }));
          });
        } else if (command.type === "follow_up") {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "LATE_STEER_DEGRADED" }] },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
          });
        }
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  const result = await runSingleTeammate(
    { agent: "general", task: "run a long tool", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onChildSpawned: (stream) => { stdin = stream; },
      onProgress: (progress) => {
        if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
        steerSent = true;
        assert.equal(sendRpcMessage(stdin, "scope correction", "steer"), true);
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort", "follow_up"]);
  assert.equal(commands[2].message, "scope correction");
  assert.ok(
    !commands.some((command) => typeof command.id === "string" && command.id.startsWith("teammate-steer-prompt-")),
    "a late abort ack must not inject a steer correction prompt into the next turn",
  );
  assert.ok(
    result.messages.some((entry) => entry.role === "system" && /turn advanced before abort was acknowledged/.test(entry.content)),
  );
});

test("swallowed settlement during an unacknowledged steer converges on degrade", async () => {
  let handle: FakeChildHandle | undefined;
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      stdinBuffer += chunk.toString();
      while (true) {
        const newline = stdinBuffer.indexOf("\n");
        if (newline < 0) break;
        const raw = stdinBuffer.slice(0, newline).trim();
        stdinBuffer = stdinBuffer.slice(newline + 1);
        if (!raw) continue;
        const command = JSON.parse(raw) as Record<string, unknown>;
        commands.push(command);

        if (command.type === "prompt" && command.id === undefined) {
          queueMicrotask(() => {
            handle!.stdout.write(line({ type: "agent_start" }));
            handle!.stdout.write(line({ type: "turn_start" }));
            handle!.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
          });
        } else if (command.type === "abort") {
          queueMicrotask(() => {
            // The turn completes naturally while the abort stays unacknowledged;
            // the settlement boundary is swallowed by the pending interrupt.
            handle!.stdout.write(line({ type: "tool_execution_end", toolName: "bash", isError: false }));
            handle!.stdout.write(line({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "NATURAL_COMPLETION" }] },
            }));
            handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
            handle!.stdout.write(line({ type: "agent_settled" }));
          });
        }
        // follow_up: the child is idle; the queued message waits for the next wake.
      }
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  let stdin: import("node:stream").Writable | undefined;
  let steerSent = false;
  // The fake child holds no real process handle and the degrade deadline is
  // unref'd, so keep the loop alive until the turn settles.
  const keepAlive = setInterval(() => {}, 10);
  let result: SingleResult;
  try {
    result = await runSingleTeammate(
      { agent: "general", task: "run a long tool", context: "fresh" },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        interruptingSteerTimeoutMs: 40,
        onChildSpawned: (stream) => { stdin = stream; },
        onProgress: (progress) => {
          if (steerSent || progress.phase !== "tool-execution" || !stdin) return;
          steerSent = true;
          assert.equal(sendRpcMessage(stdin, "scope correction", "steer"), true);
        },
      },
    );
  } finally {
    clearInterval(keepAlive);
  }

  assert.equal(result.exitCode, 0, "the swallowed natural completion must settle as success");
  assert.equal(result.terminalStatus, "completed");
  assert.equal(handle!.killed(), false);
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort", "follow_up"]);
  assert.ok(result.messages.some((entry) => entry.content === "NATURAL_COMPLETION"));
  assert.ok(
    result.messages.some((entry) => entry.role === "system" && /Steer degraded to follow_up/.test(entry.content)),
  );
});

test("REL-4: a silent child after result-ready settles on the lifecycle deadline", async () => {
  const completions: SingleResult[] = [];
  const progress: AgentProgress[] = [];
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
      }));
      handle!.stdout.write(line(resultReadyTurnEnd("final answer")));
      // Then the child wedges: no agent_end, no exit, no further output.
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "answer then hang", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      resultReadyGraceMs: 40,
      onProgress: (entry) => progress.push({ ...entry, recentTools: [...entry.recentTools] }),
      onTurnComplete: (entry) => completions.push(entry),
    },
  );

  // Publication semantics are unchanged: the result is handed over immediately.
  assert.equal(result.lifecyclePending, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.messages.at(-1)?.content, "final answer");
  assert.equal(handle!.killed(), false, "publication must not kill the child");
  assert.equal(completions.length, 0);

  await delay(160);

  assert.equal(completions.length, 1, "lifecycle must be bounded by the deadline");
  assert.equal(completions[0].exitCode, 0, "the deadline must not retract a published success");
  assert.equal(completions[0].terminalStatus, "terminated", "missing lifecycle confirmation is not a completed lifecycle");
  assert.match(completions[0].messages.at(-1)?.content ?? "", /never confirmed its lifecycle within 40ms/);
  assert.match(completions[0].messages.at(-1)?.content ?? "", /agent=general/);
  assert.equal(handle!.killed(), true, "the wedged child must be terminated");
  assert.equal(progress.at(-1)?.status, "terminated");
  assert.equal(progress.at(-1)?.resultReadyAt, undefined);
});

test("REL-4: agent_settled confirms lifecycle after agent_end", async () => {
  const completions: SingleResult[] = [];
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.stdout.write(line(resultReadyTurnEnd("quick answer")));
      handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
      setTimeout(() => handle!.stdout.write(line({ type: "agent_settled" })), 20);
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "answer and settle", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, resultReadyGraceMs: 80, onTurnComplete: (e) => completions.push(e) },
  );

  assert.equal(result.lifecyclePending, true);
  await delay(10);
  assert.equal(completions.length, 0, "agent_end must not settle before retry/compaction decisions finish");
  await delay(120);
  assert.equal(completions.length, 1);
  assert.equal(
    completions[0].messages.some((m) => /never confirmed its lifecycle/.test(m.content)),
    false,
    "agent_settled must cancel the lifecycle deadline",
  );
  assert.equal(handle!.killed(), false, "a fresh teammate stays wakeable after agent_settled");
});

test("each warm turn gets its own lifecycle confirmation deadline", async () => {
  const completions: SingleResult[] = [];
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.stdout.write(line(resultReadyTurnEnd("first")));
      handle!.stdout.write(line({ type: "agent_end" }));
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  await runSingleTeammate(
    { agent: "general", task: "two turns", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, resultReadyGraceMs: 25, onTurnComplete: (entry) => completions.push(entry) },
  );
  await delay(20);
  assert.equal(completions.length, 1);

  handle!.stdout.write(line({ type: "turn_start", turnIndex: 1 }));
  handle!.stdout.write(line(resultReadyTurnEnd("second")));
  await delay(70);
  assert.equal(completions.length, 2, "second warm turn must arm a fresh confirmation deadline");
  assert.match(completions[1].messages.at(-1)?.content ?? "", /never confirmed its lifecycle/);
});

test("agent_settled waits through retry and compaction phases", async () => {
  const completions: SingleResult[] = [];
  const phases: Array<AgentProgress["phase"]> = [];
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.stdout.write(line({ type: "agent_end", willRetry: true }));
      handle!.stdout.write(line({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "rate limited" }));
      handle!.stdout.write(line({ type: "auto_retry_end", success: true }));
      handle!.stdout.write(line({ type: "compaction_start", reason: "threshold" }));
      handle!.stdout.write(line({ type: "compaction_end", reason: "threshold", willRetry: true }));
      handle!.stdout.write(line({ type: "agent_start" }));
      handle!.stdout.write(line(resultReadyTurnEnd("recovered answer")));
      handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
      setTimeout(() => handle!.stdout.write(line({ type: "agent_settled" })), 20);
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "retry then compact", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      resultReadyGraceMs: 100,
      onProgress: (entry) => phases.push(entry.phase),
      onTurnComplete: (entry) => completions.push(entry),
    },
  );

  assert.equal(result.lifecyclePending, true);
  assert.equal(completions.length, 0);
  assert.ok(phases.includes("retrying"));
  assert.ok(phases.includes("compacting"));
  assert.ok(phases.includes("continuing"));
  await delay(80);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].exitCode, 0);
});

test("modern fallback reclaims a settled failed child before reusing its correlation identity", async () => {
  let spawns = 0;
  let alive = 0;
  let maxAlive = 0;
  const spawnChildProcess = (() => {
    const attempt = spawns++;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    alive++;
    maxAlive = Math.max(maxAlive, alive);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      alive--;
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    };
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      connected: false,
      exitCode: null,
      signalCode: null,
      pid: undefined,
      kill() { close(); return true; },
    });
    // A wakeable child with a retryable error first attempts the in-process
    // model switch; this child declines it, so the host must fall back to the
    // process-level sweep (which is what reclaims the failed child first).
    child.stdin!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          if (command.type === "set_model") {
            queueMicrotask(() => {
              stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: false,
              }));
            });
          }
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    queueMicrotask(() => {
      if (attempt === 0) {
        stdout.write(line({
          type: "message_end",
          message: { role: "assistant", stopReason: "error", errorMessage: "ECONNRESET" },
        }));
        stdout.write(line({ type: "agent_end", willRetry: false }));
        stdout.write(line({ type: "agent_settled" }));
      } else {
        stdout.write(line(resultReadyTurnEnd("fallback succeeded")));
        stdout.write(line({ type: "agent_end", willRetry: false }));
        stdout.write(line({ type: "agent_settled" }));
      }
    });
    return child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "fallback safely",
      model: "provider/primary",
      fallbackModels: ["provider/backup"],
      context: "fresh",
    },
    {
      baseCwd: process.cwd(),
      modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
      spawnChildProcess,
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
  assert.equal(spawns, 2);
  assert.equal(maxAlive, 1, "fallback must wait for physical reclamation of the failed child");
});

test("output-limit: length agent_end is not accepted as a successful teammate result", async () => {
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      const message = {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "partial response" }],
      };
      handle!.stdout.write(line({ type: "message_end", message }));
      handle!.stdout.write(line({ type: "turn_end", message, toolResults: [] }));
      handle!.stdout.write(line({ type: "agent_end", messages: [message] }));
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "truncate", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, outputLimitRecoveryTimeoutMs: 40 },
  );

  assert.equal(result.exitCode, 1);
  assert.ok(result.messages.some((message) => message.content === "partial response"));
  assert.match(result.messages.at(-1)?.content ?? "", /partial response was not accepted as success/);
  assert.equal(handle!.killed(), true);
});

test("output-limit: a continuation loop replaces length settlement with one final success", async () => {
  let handle: FakeChildHandle | undefined;
  const completions: SingleResult[] = [];
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      const partial = {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "partial response" }],
      };
      handle!.stdout.write(line({ type: "turn_end", message: partial, toolResults: [] }));
      handle!.stdout.write(line({ type: "agent_end", messages: [partial] }));
      setTimeout(() => {
        const final = {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "continued and complete" }],
        };
        handle!.stdout.write(line({ type: "agent_start" }));
        handle!.stdout.write(line({ type: "turn_end", message: final, toolResults: [] }));
        handle!.stdout.write(line({ type: "agent_end", messages: [final] }));
      }, 10);
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "recover", context: "fresh" },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      outputLimitRecoveryTimeoutMs: 80,
      onTurnComplete: (entry) => completions.push(entry),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.messages.some((message) => message.content === "partial response"));
  assert.ok(result.messages.some((message) => message.content === "continued and complete"));
  await delay(120);
  assert.equal(completions.length, 1);
  assert.equal(handle!.killed(), false, "fresh agents remain wakeable after the recovered turn");
});

test("output-limit: a child exit during recovery is not a success", async () => {
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      const partial = {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "partial response" }],
      };
      handle!.stdout.write(line({ type: "message_end", message: partial }));
      handle!.stdout.write(line({ type: "turn_end", message: partial, toolResults: [] }));
      handle!.stdout.write(line({ type: "agent_end", messages: [partial] }));
    });
    // The child exits cleanly (code 0) instead of continuing: the truncated
    // response must not be accepted as success. The delay lets the parent
    // process the agent_end and arm the recovery window first.
    setTimeout(() => handle!.close(0, null), 30);
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "truncate then exit", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, outputLimitRecoveryTimeoutMs: 2_000 },
  );

  assert.equal(result.exitCode, 1, "a truncated response cut short by child exit must fail");
  assert.ok(result.messages.some((message) => message.content === "partial response"));
  assert.match(result.messages.at(-1)?.content ?? "", /not accepted as success/);
  assert.equal(handle!.killed(), false, "an already-exited child needs no kill");
});

test("compaction recovery: agent_settled waits for the continuation turn", async () => {
  const parentSession = path.join(os.tmpdir(), `teammate-compaction-parent-${Date.now()}.jsonl`);
  fs.writeFileSync(parentSession, "{}\n");
  let handle: FakeChildHandle | undefined;
  const completions: SingleResult[] = [];
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.child.emit("message", {
        type: "teammate_compaction_state",
        recoveryId: "session:loop-critical",
        generation: 2,
        phase: "pending",
      });
      handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle!.stdout.write(line({ type: "agent_settled" }));
      setTimeout(() => {
        handle!.child.emit("message", {
          type: "teammate_compaction_state",
          recoveryId: "session:loop-critical",
          generation: 2,
          phase: "completed",
        });
        handle!.child.emit("message", {
          type: "teammate_compaction_state",
          recoveryId: "session:loop-critical",
          generation: 2,
          phase: "continuation",
        });
        handle!.stdout.write(line({ type: "agent_start" }));
        handle!.stdout.write(line({ type: "turn_start" }));
        handle!.child.emit("message", {
          type: "teammate_compaction_state",
          recoveryId: "session:loop-critical",
          generation: 2,
          phase: "pending",
        });
        handle!.child.emit("message", {
          type: "teammate_compaction_state",
          recoveryId: "session:older-recovery",
          generation: 1,
          phase: "pending",
        });
        handle!.stdout.write(line(resultReadyTurnEnd("continued after compaction")));
        handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
        handle!.stdout.write(line({ type: "agent_settled" }));
      }, 10);
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  try {
    const result = await runSingleTeammate(
      { agent: "general", task: "recover context", context: "fork" },
      {
        baseCwd: process.cwd(),
        parentSessionFile: parentSession,
        spawnChildProcess,
        outputLimitRecoveryTimeoutMs: 100,
        onTurnComplete: (entry) => completions.push(entry),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.messages.at(-1)?.content, "continued after compaction");
    assert.equal(completions.length, 1, "the interrupted empty boundary must not publish a result");
    assert.equal(handle!.killed(), true, "the non-wakeable fork is reclaimed only after the continuation settles");
  } finally {
    fs.rmSync(parentSession, { force: true });
  }
});

test("compaction recovery: a failed phase settles without a lifecycle boundary", async () => {
  let handle: FakeChildHandle | undefined;
  let spawnCount = 0;
  const spawnChildProcess = (() => {
    spawnCount += 1;
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.child.emit("message", {
        type: "teammate_compaction_state",
        recoveryId: "session:failed-compaction",
        generation: 1,
        phase: "pending",
      });
      handle!.child.emit("message", {
        type: "teammate_compaction_state",
        recoveryId: "session:failed-compaction",
        generation: 1,
        phase: "failed",
        reason: "compaction prompt rejected",
      });
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "recover context", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, outputLimitRecoveryTimeoutMs: 2_000 },
  );

  assert.equal(result.exitCode, 1);
  const diagnostic = result.messages.find((message) => /compaction recovery failed/.test(message.content));
  assert.ok(diagnostic, "the prompt failure diagnostic must be preserved in the transcript");
  assert.match(diagnostic.content, /compaction prompt rejected/);
  assert.equal(spawnCount, 1, "a terminal compaction failure must not replay the task in a fresh child");
  assert.equal(handle!.killed(), true, "the child must be reclaimed after terminal compaction failure");
});

test("compaction recovery: a missing continuation fails instead of publishing empty success", async () => {
  let handle: FakeChildHandle | undefined;
  let spawnCount = 0;
  const spawnChildProcess = (() => {
    spawnCount += 1;
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.child.emit("message", {
        type: "teammate_compaction_state",
        recoveryId: "session:stalled-compaction",
        generation: 1,
        phase: "pending",
      });
      handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle!.stdout.write(line({ type: "agent_settled" }));
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "recover context", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, outputLimitRecoveryTimeoutMs: 40 },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.messages.at(-1)?.content ?? "", /compaction recovery did not continue/);
  assert.equal(spawnCount, 1, "a lifecycle recovery timeout must not replay the task in a fresh child");
  assert.equal(handle!.killed(), true);
});

// ---------------------------------------------------------------------------
// OBS-6 / OBS-7 — terminal conditions must leave evidence
// ---------------------------------------------------------------------------

test("OBS-6: a foreground wait timeout never truncates the running child", async () => {
  const progress: AgentProgress[] = [];
  let handle: ReturnType<typeof createFakeChild> | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "partial work" }] },
      }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const pending = runSingleTeammate(
    { agent: "general", task: "continue in background", context: "fresh", timeoutMs: 60 },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onProgress: (entry) => progress.push({ ...entry, recentTools: [...entry.recentTools] }),
    },
  );

  await delay(120);
  assert.ok(handle);
  assert.equal(handle.killed(), false, "foreground wait expiry must not kill the child");
  assert.equal(progress.some((entry) => entry.status === "failed"), false);

  handle.stdout.write(line({ type: "agent_end" }));
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.ok(result.messages.some((message) => message.content === "partial work"));
});

test("OBS-7: a crash after assistant output keeps stderr, exit code and signal", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "made progress" }] },
      }));
      handle.stderr.write("FATAL ERROR: Reached heap limit Allocation failed\n");
      setTimeout(() => handle.close(137, "SIGKILL"), 10);
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "crash after output", context: "fresh", timeoutMs: 5_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 137);
  assert.ok(
    result.messages.some((m) => m.content === "made progress"),
    "pre-crash output must survive",
  );
  const crashEvidence = result.messages.find((m) => /exited abnormally/.test(m.content));
  assert.ok(crashEvidence, `no crash evidence in ${JSON.stringify(result.messages)}`);
  assert.equal(crashEvidence.role, "system");
  assert.match(crashEvidence.content, /exit=137/);
  assert.match(crashEvidence.content, /signal=SIGKILL/);
  assert.match(crashEvidence.content, /agent=general/);
  assert.match(crashEvidence.content, new RegExp(`correlationId=${result.correlationId}`));
  assert.match(crashEvidence.content, /Reached heap limit/);
});

test("OBS-7: a clean exit is never annotated as an abnormal termination", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "all good" }] },
      }));
      setTimeout(() => handle.close(0, null), 10);
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "exit cleanly", context: "fresh", timeoutMs: 5_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.messages.some((m) => /exited abnormally/.test(m.content)), false);
});

test("a bare runtime model id is normalized to its canonical provider/model id", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gpt-5.6-sol", // runtime events report a bare id without provider
          content: [{ type: "text", text: "resolved" }],
        },
      }));
      setTimeout(() => handle.close(0, null), 10);
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "report model", context: "fresh", timeoutMs: 5_000 },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      modelCapabilities: [{ id: "maestro-openai/gpt-5.6-sol" }],
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.model, "maestro-openai/gpt-5.6-sol");
});

test("an ambiguous bare model id stays bare instead of guessing a provider", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gpt-5.6-sol",
          content: [{ type: "text", text: "resolved" }],
        },
      }));
      setTimeout(() => handle.close(0, null), 10);
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "report model", context: "fresh", timeoutMs: 5_000 },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      modelCapabilities: [
        { id: "maestro-openai/gpt-5.6-sol" },
        { id: "maestro-qwen/gpt-5.6-sol" },
      ],
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.model, "gpt-5.6-sol");
});

test("OBS-7: stderr-only failures are reported once, not duplicated", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stderr.write("boom: could not start\n");
      setTimeout(() => handle.close(1, null), 10);
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "fail immediately", context: "fresh", timeoutMs: 5_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  const occurrences = result.messages.filter((m) => m.content.includes("boom: could not start")).length;
  assert.equal(occurrences, 1, `stderr repeated in ${JSON.stringify(result.messages)}`);
});

test("provider errors embedded in assistant events retain runtime location before schema settlement", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          model: "maestro-openai/gpt-5.6-sol",
          stopReason: "error",
          errorMessage: "Authentication failed: token expired",
          content: [],
        },
      }));
      handle.stdout.write(line({ type: "agent_end" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "return structured output",
      context: "fresh",
      timeoutMs: 5_000,
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  const runtimeError = result.messages.find((message) => message.content.includes("Authentication failed"));
  assert.ok(runtimeError, `provider error missing from ${JSON.stringify(result.messages)}`);
  assert.match(runtimeError.content, /phase=message_end/);
  assert.match(runtimeError.content, /agent=general/);
  assert.match(runtimeError.content, /model=maestro-openai\/gpt-5\.6-sol/);
  assert.match(runtimeError.content, new RegExp(`correlationId=${result.correlationId}`));
  assert.ok(result.messages.some((message) => /completed without calling structured_output/.test(message.content)));
});

test("invalid structured_output reports the failing instance and schema paths", async () => {
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "agent_end",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "structured_output",
            arguments: { count: "not-an-integer" },
          }],
        },
      }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "return structured output",
      context: "fresh",
      timeoutMs: 5_000,
      outputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      },
    },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  const validationError = result.messages.find((message) => message.content.includes("validation failed at"));
  assert.ok(validationError, `validation error missing from ${JSON.stringify(result.messages)}`);
  assert.match(validationError.content, /\/count/);
  assert.match(validationError.content, /schema=#\/properties\/count/);
  assert.match(validationError.content, /must be integer/);
});

// ---------------------------------------------------------------------------
// SO-RECOVERY — a wakeable child that ends without structured_output gets one
// bounded corrective continuation before the run settles as failed
// ---------------------------------------------------------------------------

function createCommandCapture(child: ChildProcess): Array<Record<string, unknown>> {
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";
  (child.stdin as PassThrough).on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString();
    while (true) {
      const newline = stdinBuffer.indexOf("\n");
      if (newline < 0) break;
      const raw = stdinBuffer.slice(0, newline).trim();
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (!raw) continue;
      commands.push(JSON.parse(raw) as Record<string, unknown>);
    }
  });
  return commands;
}

const recoveryId = (commands: Array<Record<string, unknown>>): Record<string, unknown> | undefined =>
  commands.find((command) =>
    command.type === "prompt" && /teammate-structured-output-recovery-/.test(String(command.id)));

const valueSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
};

const structuredToolEvents = (value: unknown): Array<Record<string, unknown>> => [
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "structured_output", arguments: value }],
    },
  },
  { type: "tool_execution_start", toolName: "structured_output" },
  { type: "tool_execution_end", toolName: "structured_output", isError: false },
];

test("missing structured_output resumes the child once and accepts the resubmitted value", async () => {
  let handle: FakeChildHandle | undefined;
  let commands: Array<Record<string, unknown>> = [];

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    commands = createCommandCapture(handle.child);
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      // The capture listener consumes the stream; re-dispatch the same chunk
      // to a handler that responds to the corrective prompt.
      const raw = chunk.toString().trim();
      if (!raw) return;
      const command = JSON.parse(raw) as Record<string, unknown>;
      if (command.type === "prompt" && typeof command.id === "string") {
        queueMicrotask(() => {
          handle!.stdout.write(line({
            type: "response",
            id: command.id,
            command: "prompt",
            success: true,
          }));
          handle!.stdout.write(line({ type: "agent_start" }));
          handle!.stdout.write(line({ type: "turn_start" }));
          for (const event of structuredToolEvents({ value: "recovered" })) {
            handle!.stdout.write(line(event));
          }
          handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
          handle!.stdout.write(line({ type: "agent_settled" }));
        });
      }
    });
    queueMicrotask(() => {
      handle!.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "plain json answer" }] },
      }));
      handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle!.stdout.write(line({ type: "agent_settled" }));
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "return structured output", context: "fresh", outputSchema: valueSchema },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.structuredOutput, { value: "recovered" });
  const recoveryPrompt = recoveryId(commands);
  assert.ok(recoveryPrompt, `corrective prompt missing from ${JSON.stringify(commands)}`);
  assert.match(String(recoveryPrompt.message), /Call the structured_output tool now/);
  assert.match(String(recoveryPrompt.message), /Do not repeat any other work/);
  assert.ok(
    result.messages.some((message) => /issued a bounded corrective prompt/.test(message.content)),
    `recovery diagnostic missing from ${JSON.stringify(result.messages)}`,
  );
});

test("missing structured_output recovery times out and settles as failed", async () => {
  let handle: FakeChildHandle | undefined;
  let commands: Array<Record<string, unknown>> = [];

  const spawnChildProcess = (() => {
    handle = createFakeChild();
    commands = createCommandCapture(handle.child);
    queueMicrotask(() => {
      handle!.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "plain json answer" }] },
      }));
      handle!.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle!.stdout.write(line({ type: "agent_settled" }));
      // The child stays silent: no response to the corrective prompt.
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "return structured output",
      context: "fresh",
      outputSchema: valueSchema,
    },
    { baseCwd: process.cwd(), spawnChildProcess, structuredOutputRecoveryTimeoutMs: 50 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.structuredOutput, undefined);
  assert.ok(recoveryId(commands), `corrective prompt missing from ${JSON.stringify(commands)}`);
  assert.ok(
    result.messages.some((message) =>
      /did not submit schema-valid structured_output after the corrective prompt/.test(message.content)),
    `timeout diagnostic missing from ${JSON.stringify(result.messages)}`,
  );
});

test("structured_output recovery is skipped for runtime failures, invalid submissions and fork contexts", async () => {
  const runScenario = async (params: {
    context: "fresh" | "fork";
    outputSchema?: Record<string, unknown>;
    resumeSessionFile?: string;
    events: (handle: FakeChildHandle) => void;
  }): Promise<{ result: SingleResult; commands: Array<Record<string, unknown>> }> => {
    let handle: FakeChildHandle | undefined;
    let commands: Array<Record<string, unknown>> = [];
    const spawnChildProcess = (() => {
      handle = createFakeChild();
      commands = createCommandCapture(handle.child);
      const scripted = handle;
      queueMicrotask(() => params.events(scripted));
      return handle!.child;
    }) as unknown as SpawnSeam;
    const result = await runSingleTeammate(
      {
        agent: "general",
        task: "return structured output",
        context: params.context,
        ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        ...(params.resumeSessionFile ? { resumeSessionFile: params.resumeSessionFile } : {}),
      },
    );
    return { result, commands };
  };

  // Provider failure: the run is already failed; never prompt a resubmission.
  const runtimeFailure = await runScenario({
    context: "fresh",
    outputSchema: valueSchema,
    events: (handle) => {
      handle.stdout.write(line({ type: "error", error: "Authentication failed: token expired" }));
      handle.stdout.write(line({ type: "agent_end" }));
    },
  });
  assert.equal(runtimeFailure.result.exitCode, 1);
  assert.equal(recoveryId(runtimeFailure.commands), undefined);

  // Invalid submission: the reject-and-correct contract already failed inside
  // the turn; report the field diagnostic instead of prompting again.
  const invalid = await runScenario({
    context: "fresh",
    outputSchema: valueSchema,
    events: (handle) => {
      handle.stdout.write(line({
        type: "agent_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "structured_output", arguments: { value: 42 } }],
        },
      }));
    },
  });
  assert.equal(invalid.result.exitCode, 1);
  assert.equal(recoveryId(invalid.commands), undefined);

  // Fork context: the child owns parent history; never resume it with a prompt.
  const resumeFile = path.join(teammateTempRoot(), `recovery-guard-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(resumeFile, "", "utf8");
  try {
    const fork = await runScenario({
      context: "fork",
      outputSchema: valueSchema,
      resumeSessionFile: resumeFile,
      events: (handle) => {
        handle.stdout.write(line({ type: "agent_end" }));
      },
    });
    assert.equal(fork.result.exitCode, 1);
    assert.equal(recoveryId(fork.commands), undefined);
  } finally {
    fs.rmSync(resumeFile, { force: true });
  }
});

// ---------------------------------------------------------------------------
// OBS-14 — toolCount shares the cumulative semantics of the token counters
// ---------------------------------------------------------------------------

test("OBS-14: toolCount accumulates across turns like the token counters", async () => {
  const progress: AgentProgress[] = [];
  const spawnChildProcess = (() => {
    const handle = createFakeChild();
    const toolTurn = (turn: number) => {
      handle.stdout.write(line({ type: "turn_start" }));
      for (let i = 0; i < 2; i += 1) {
        handle.stdout.write(line({ type: "tool_execution_start", toolName: `tool-${turn}-${i}` }));
        handle.stdout.write(line({ type: "tool_execution_end", toolName: `tool-${turn}-${i}`, content: "ok" }));
      }
    };
    queueMicrotask(() => {
      toolTurn(1);
      toolTurn(2);
      handle.stdout.write(line({ type: "agent_end" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  await runSingleTeammate(
    { agent: "general", task: "two tool turns", context: "fresh", timeoutMs: 5_000 },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      onProgress: (entry) => progress.push({ ...entry, recentTools: [...entry.recentTools] }),
    },
  );

  const last = progress.at(-1);
  assert.equal(last?.toolCount, 4, "cumulative tool count must span both turns");
  // recentTools stays turn-scoped, which is what the widget renders.
  const secondTurnStart = progress.findLastIndex((entry) => entry.recentTools.length === 0);
  assert.ok(secondTurnStart > 0, "each turn must reset the recent-tool window");
  assert.equal(last?.recentTools.length, 2, "the recent-tool window shows only the current turn");
});

// ---------------------------------------------------------------------------
// SEC-6 — params.cwd supports explicit external working directories
// ---------------------------------------------------------------------------

test("SEC-6: resolveContainedCwd accepts inside and external paths", () => {
  const base = process.cwd();
  const inside = resolveContainedCwd("src", base);
  assert.ok("cwd" in inside);
  assert.ok(inside.cwd.toLowerCase().endsWith(`${path.sep}src`.toLowerCase()));

  assert.deepEqual(resolveContainedCwd(undefined, base), { cwd: base });
  assert.ok("cwd" in resolveContainedCwd(base, base));

  for (const escape of ["..", path.join("..", ".."), path.resolve(base, "..")]) {
    const resolved = resolveContainedCwd(escape, base);
    assert.ok("cwd" in resolved, `external cwd not resolved: ${escape}`);
    assert.equal(resolved.cwd, fs.realpathSync.native(path.resolve(base, escape)));
  }
});

test("SEC-6: an out-of-project cwd reaches the child process", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teammate-outside-"));
  let spawnedCwd: string | undefined;
  const spawnChildProcess = ((_command: string, _args: readonly string[], options: { cwd?: string }) => {
    spawnedCwd = options.cwd;
    const handle = createFakeChild();
    queueMicrotask(() => handle.close(0, null));
    return handle.child;
  }) as unknown as SpawnSeam;

  try {
    const result = await runSingleTeammate(
      { agent: "general", task: "inspect an external project", cwd: outside, context: "fresh", timeoutMs: 5_000 },
      { baseCwd: process.cwd(), spawnChildProcess },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(spawnedCwd, fs.realpathSync.native(outside));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("SEC-6: a cwd inside the project still reaches the child process", async () => {
  let spawnedCwd: string | undefined;
  const spawnChildProcess = ((_command: string, _args: readonly string[], options: { cwd?: string }) => {
    spawnedCwd = options.cwd;
    const handle = createFakeChild();
    queueMicrotask(() => handle.close(0, null));
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "run in a subdirectory", cwd: "src", context: "fresh", timeoutMs: 5_000 },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 0);
  assert.ok(spawnedCwd, "a contained cwd must still be honoured");
  assert.ok(spawnedCwd.toLowerCase().endsWith(`${path.sep}src`.toLowerCase()));
});

// ---------------------------------------------------------------------------
// SEC-8 — model-authored JSON Schema cannot wedge the parent's main thread
// ---------------------------------------------------------------------------

test("SEC-8: catastrophic-backtracking patterns are rejected before spawn", async () => {
  let spawned = 0;
  const spawnChildProcess = (() => {
    spawned += 1;
    return createFakeChild().child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "return structured output",
      context: "fresh",
      outputSchema: {
        type: "object",
        properties: { token: { type: "string", pattern: "^(a+)+$" } },
      },
    },
    { baseCwd: process.cwd(), spawnChildProcess },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(spawned, 0);
  assert.match(result.messages[0].content, /catastrophic backtracking/);
});

test("SEC-8: oversized and over-nested schemas are rejected, benign ones pass", () => {
  assert.equal(
    findStructuredOutputSchemaHazard({ type: "object", properties: { id: { type: "string", pattern: "^[a-z0-9-]+$" } } }),
    undefined,
  );

  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 30; i += 1) deep = { type: "object", properties: { nested: deep } };
  assert.match(findStructuredOutputSchemaHazard(deep) ?? "", /nests deeper than/);

  assert.match(
    findStructuredOutputSchemaHazard({ type: "object", description: "x".repeat(70 * 1024) }) ?? "",
    /exceeds \d+ bytes/,
  );

  assert.match(
    findStructuredOutputSchemaHazard({
      type: "object",
      patternProperties: { "^(\\w+\\s?)*$": { type: "string" } },
    }) ?? "",
    /catastrophic backtracking/,
  );

  assert.match(
    findStructuredOutputSchemaHazard({ type: "string", pattern: `^${"a".repeat(400)}$` }) ?? "",
    /catastrophic backtracking/,
  );
});

test("SEC-8: hazard detection stays fast on the pathological input it guards against", () => {
  const started = process.hrtime.bigint();
  const hazard = findStructuredOutputSchemaHazard({
    type: "object",
    properties: { a: { type: "string", pattern: "^(a+)+$" } },
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(hazard);
  assert.ok(elapsed < 100, `hazard detection took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// SEC-9 — private scratch files live in a per-user root
// ---------------------------------------------------------------------------

test("SEC-9: the teammate scratch root is per-user on Windows", () => {
  const root = teammateTempRoot();
  assert.ok(path.isAbsolute(root));
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const localAppData = path.resolve(process.env.LOCALAPPDATA).toLowerCase();
    assert.ok(
      path.resolve(root).toLowerCase().startsWith(localAppData),
      `scratch root ${root} is not under %LOCALAPPDATA%`,
    );
  } else {
    assert.equal(root, path.join(os.tmpdir(), "pi-teammate"));
  }
});

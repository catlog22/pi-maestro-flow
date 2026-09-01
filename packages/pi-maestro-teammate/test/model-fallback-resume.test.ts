import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { runSingleTeammate } from "../src/runs/execution.ts";
import { ModelCircuitBreaker } from "../src/models/model-circuit-breaker.ts";

type SpawnSeam = NonNullable<Parameters<typeof runSingleTeammate>[1]["spawnChildProcess"]>;

interface FakeChildHandle {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  commands: Array<Record<string, unknown>>;
  close(code: number | null, signal: NodeJS.Signals | null): void;
}

function createFakeChild(): FakeChildHandle {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: Array<Record<string, unknown>> = [];
  let stdinBuffer = "";
  let closed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (closed) return;
    closed = true;
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
      queueMicrotask(() => close(null, "SIGTERM"));
      return true;
    },
  });
  child.stdin!.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString();
    while (true) {
      const newline = stdinBuffer.indexOf("\n");
      if (newline < 0) break;
      const raw = stdinBuffer.slice(0, newline).trim();
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (!raw) continue;
      try {
        commands.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Ignore malformed test lines.
      }
    }
  });
  return { child, stdout, stderr, commands, close };
}

const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function teammateTempRoot(): string {
  const root = path.join(os.tmpdir(), "pi-teammate-test-model-fallback-resume");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * A provider 503 failure settles the first candidate with an error assistant
 * message. When the child published a session checkpoint (teammate_session_ready
 * over IPC), the next candidate must be spawned with `--session <checkpoint>`
 * and its own `--model`, and the initial prompt must be the resume directive
 * rather than the original task text.
 */
test("B: a published session checkpoint makes failover resume under the next model", async () => {
  const checkpoint = path.join(teammateTempRoot(), `resume-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(checkpoint, "", "utf8");
  const spawned: Array<{ args: readonly string[] }> = [];
  let candidate = 0;
  const handles: FakeChildHandle[] = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    handles.push(handle);
    const index = candidate;
    candidate += 1;
    spawned.push({ args });
    if (index === 0) {
      // Candidate 1: publish session identity over IPC, then fail with 503.
      queueMicrotask(() => {
        handle.child.emit("message", {
          type: "teammate_session_ready",
          sessionId: "session-1",
          sessionFile: checkpoint,
        });
      });
      queueMicrotask(() => {
        handle.stdout.write(line({ type: "agent_start" }));
        handle.stdout.write(line({ type: "turn_start" }));
        handle.stdout.write(line({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "OpenAI API error (503)",
          },
        }));
        handle.stdout.write(line({ type: "agent_end", willRetry: false }));
        handle.stdout.write(line({ type: "agent_settled" }));
      });
      setTimeout(() => handle.close(1, null), 30);
    } else {
      // Candidate 2: succeed.
      queueMicrotask(() => {
        handle.stdout.write(line({ type: "agent_start" }));
        handle.stdout.write(line({ type: "turn_start" }));
        handle.stdout.write(line({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "RECOVERED" }] },
        }));
        handle.stdout.write(line({ type: "agent_end" }));
        handle.stdout.write(line({ type: "agent_settled" }));
      });
      setTimeout(() => handle.close(0, null), 30);
    }
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "original task text",
      model: "provider/primary",
      fallbackModels: ["provider/backup"],
    },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
      modelCircuitBreaker: new ModelCircuitBreaker(),
      enableRetryBackoff: false,
    },
  );

  clearInterval(keepAlive);
  try {
    // Both candidates were tried.
    assert.equal(spawned.length, 2);
    // Candidate 1: no --session, model primary.
    const firstArgs = spawned[0].args;
    assert.ok(firstArgs.includes("--model"), "candidate 1 carries --model");
    assert.ok(!firstArgs.includes("--session"), "candidate 1 does not resume");
    // Candidate 2: resumes the checkpoint under the backup model.
    const secondArgs = spawned[1].args;
    const sessionIndex = secondArgs.indexOf("--session");
    assert.ok(sessionIndex >= 0, `candidate 2 missing --session in ${JSON.stringify(secondArgs)}`);
    assert.equal(secondArgs[sessionIndex + 1], checkpoint);
    const modelIndex = secondArgs.indexOf("--model");
    assert.ok(modelIndex >= 0, "candidate 2 carries --model");
    assert.match(secondArgs[modelIndex + 1], /backup/);
    // The resume prompt replaces the original task text as the initial prompt.
    const initialPrompt = handles[1].commands.find((c) => c.type === "prompt");
    assert.ok(initialPrompt, "candidate 2 received an initial prompt");
    assert.match(String(initialPrompt.message), /Continue from that recorded state/);
    assert.ok(!String(initialPrompt.message).includes("original task text"));
    // The run succeeds through the resumed candidate.
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
  } finally {
    fs.rmSync(checkpoint, { force: true });
  }
});

/**
 * Without a published checkpoint the resume path is unavailable, so a
 * mid-run failure keeps the legacy fence behaviour: a completed tool blocks
 * failover entirely.
 */
test("B: without a checkpoint a completed tool still fences failover", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
      handle.stdout.write(line({ type: "tool_execution_end", toolName: "bash" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    setTimeout(() => handle.close(1, null), 30);
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "task",
      model: "provider/primary",
      fallbackModels: ["provider/backup"],
    },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
      modelCircuitBreaker: new ModelCircuitBreaker(),
      enableRetryBackoff: false,
    },
  );

  clearInterval(keepAlive);
  assert.equal(spawned.length, 1);
  assert.equal(result.exitCode, 1);
  assert.match(result.messages.at(-1)?.content ?? "", /side-effect replay fence/);
});

/**
 * A checkpoint that no longer exists on disk must not enable the resume
 * path; the failure falls back to the fence decision (no tools -> next model).
 */
test("B: a missing checkpoint file does not enable resume", async () => {
  const missing = path.join(teammateTempRoot(), `missing-${process.pid}-${Date.now()}.jsonl`);
  const spawned: Array<{ args: readonly string[] }> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    queueMicrotask(() => {
      handle.child.emit("message", {
        type: "teammate_session_ready",
        sessionId: "session-missing",
        sessionFile: missing,
      });
    });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    setTimeout(() => handle.close(1, null), 30);
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "task",
      model: "provider/primary",
      fallbackModels: ["provider/backup"],
    },
    {
      baseCwd: process.cwd(),
      spawnChildProcess,
      modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
      modelCircuitBreaker: new ModelCircuitBreaker(),
      enableRetryBackoff: false,
    },
  );

  // No tools completed, so the legacy path still tries the next candidate —
  // but without a --session flag (no resume).
  clearInterval(keepAlive);
  assert.equal(spawned.length, 2);
  const secondArgs = spawned[1].args;
  assert.ok(!secondArgs.includes("--session"), "missing checkpoint must not resume");
  assert.equal(result.exitCode, 1);
});

// ---------------------------------------------------------------------------
// A: in-process model switch (set_model over the live RPC channel)
// ---------------------------------------------------------------------------

/**
 * A wakeable child that settles a retryable provider error triggers the
 * in-process failover: the host sends `set_model`, Pi acknowledges, the
 * resume prompt goes over the same channel, and the turn settles as success
 * under the new model — all without spawning a second child.
 */
test("A: a structured-output child hot-swaps to the next model via set_model RPC", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];
  let stdinCommands: Array<Record<string, unknown>> = [];
  const progress: Array<{
    phase: string | undefined;
    requestedModel: string | undefined;
    lastMessage: string | undefined;
  }> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          stdinCommands.push(command);
          if (command.type === "set_model") {
            // Pi acknowledges the model switch over stdout.
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          } else if (command.type === "prompt" && typeof command.id === "string") {
            // The resume prompt starts a fresh turn that settles as success.
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "prompt",
                success: true,
              }));
              handle.stdout.write(line({ type: "agent_start" }));
              handle.stdout.write(line({ type: "turn_start" }));
              handle.stdout.write(line({
                type: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "toolCall", name: "structured_output", arguments: { value: "RECOVERED_IN_PLACE" } }],
                },
              }));
              handle.stdout.write(line({ type: "tool_execution_start", toolName: "structured_output" }));
              handle.stdout.write(line({ type: "tool_execution_end", toolName: "structured_output", isError: false }));
              handle.stdout.write(line({ type: "agent_end" }));
              handle.stdout.write(line({ type: "agent_settled" }));
            });
          }
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    // First turn: a legacy agent_end without willRetry and the modern
    // agent_settled boundary arrive together while model selection is pending.
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
      handle.stdout.write(line({ type: "tool_execution_end", toolName: "bash" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end" }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  try {
    const result = await Promise.race([
      runSingleTeammate(
        {
          agent: "general",
          task: "task",
          model: "provider/primary",
          fallbackModels: ["provider/backup"],
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
        {
          baseCwd: process.cwd(),
          spawnChildProcess,
          modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
          modelCircuitBreaker: new ModelCircuitBreaker(),
          enableRetryBackoff: false,
          onProgress: (entry) => progress.push({
            phase: entry.phase,
            requestedModel: entry.requestedModel,
            lastMessage: entry.lastMessage,
          }),
        },
      ),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("A TIMEOUT")), 8000)),
    ]);
    // Only one child was ever spawned: the switch happened in place.
    assert.equal(spawned.length, 1);
    const setModel = stdinCommands.find((command) => command.type === "set_model");
    assert.ok(setModel, `set_model missing from ${JSON.stringify(stdinCommands)}`);
    assert.equal(setModel.provider, "provider");
    assert.equal(setModel.modelId, "backup");
    assert.equal(
      stdinCommands.filter((command) => command.type === "set_model").length,
      1,
      "legacy agent_end plus agent_settled must share one failover decision",
    );
    const resumePrompt = stdinCommands.find(
      (command) => command.type === "prompt" && typeof command.id === "string",
    );
    assert.ok(resumePrompt, "resume prompt missing");
    assert.match(String(resumePrompt.message), /Continue from that recorded state/);
    // The run succeeded in place under the switched model.
    assert.equal(result.exitCode, 0);
    assert.equal(result.model, "provider/backup");
    assert.deepEqual(result.structuredOutput, { value: "RECOVERED_IN_PLACE" });
    assert.ok(
      progress.some((entry) =>
        entry.phase === "prompting"
        && entry.requestedModel === "provider/backup"
        && entry.lastMessage === undefined),
      `model-switch progress leaked across the resumed turn: ${JSON.stringify(progress)}`,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

/**
 * When Pi rejects the set_model command, the switch is abandoned and the
 * original failure settles as a failure (no second child, no hang).
 */
test("A: a rejected set_model settles the original failure", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];
  let stdinCommands: Array<Record<string, unknown>> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          stdinCommands.push(command);
          if (command.type === "set_model") {
            queueMicrotask(() => {
              handle.stdout.write(line({
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
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  try {
    const result = await runSingleTeammate(
      {
        agent: "general",
        task: "task",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
          modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
      },
    );
    // The rejected in-process switch falls back to the regular candidate
    // sweep: the backup model gets a fresh attempt, and its failure settles
    // the run.
    assert.equal(spawned.length, 2);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
  } finally {
    clearInterval(keepAlive);
  }
});

// ---------------------------------------------------------------------------
// A/B comparison: the same 503 mid-run failure through both failover paths
// ---------------------------------------------------------------------------

/**
 * A wakeable child (A: in-process hot swap) recovers without spawning a
 * second process; a dead child (B: cold restart) resumes the recorded session
 * under the next model via `--session`. Both keep completed tools in history
 * instead of replaying them, but A is strictly cheaper.
 */
test("A/B: in-process switch vs cold restart for the same 503 failure", async () => {
  const checkpoint = path.join(teammateTempRoot(), `ab-compare-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(checkpoint, "", "utf8");

  // --- Path A: child stays alive, set_model succeeds in place. ---
  let aSpawns = 0;
  let aStdioCommands: Array<Record<string, unknown>> = [];
  const aSpawn = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    aSpawns += 1;
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          aStdioCommands.push(command);
          if (command.type === "set_model") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          } else if (command.type === "prompt" && typeof command.id === "string") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "prompt",
                success: true,
              }));
              handle.stdout.write(line({ type: "agent_start" }));
              handle.stdout.write(line({ type: "turn_start" }));
              handle.stdout.write(line({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "A_RECOVERED" }] },
              }));
              handle.stdout.write(line({ type: "agent_end" }));
              handle.stdout.write(line({ type: "agent_settled" }));
            });
          }
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
      handle.stdout.write(line({ type: "tool_execution_end", toolName: "bash" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAliveA = setInterval(() => {}, 10);
  let resultA;
  try {
    resultA = await runSingleTeammate(
      {
        agent: "general",
        task: "compare",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess: aSpawn,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
      },
    );
  } finally {
    clearInterval(keepAliveA);
  }
  assert.equal(resultA.exitCode, 0);
  assert.equal(aSpawns, 1, "A must not spawn a second process");
  assert.ok(
    aStdioCommands.some((command) => command.type === "set_model"),
    "A must send set_model over the live channel",
  );
  assert.equal(resultA.model, "provider/backup");

  // --- Path B: child dies after publishing its session checkpoint; the next
  // candidate cold-restarts the recorded session under its own model. ---
  let bSpawns = 0;
  const bSpawnedArgs: Array<{ args: readonly string[] }> = [];
  const bSpawn = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    bSpawns += 1;
    bSpawnedArgs.push({ args });
    if (bSpawns === 1) {
      queueMicrotask(() => {
        handle.child.emit("message", {
          type: "teammate_session_ready",
          sessionId: "b-session",
          sessionFile: checkpoint,
        });
      });
      queueMicrotask(() => {
        handle.stdout.write(line({ type: "agent_start" }));
        handle.stdout.write(line({ type: "turn_start" }));
        handle.stdout.write(line({ type: "tool_execution_start", toolName: "bash" }));
        handle.stdout.write(line({ type: "tool_execution_end", toolName: "bash" }));
        handle.stdout.write(line({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "OpenAI API error (503)",
          },
        }));
        handle.stdout.write(line({ type: "agent_end", willRetry: false }));
        handle.stdout.write(line({ type: "agent_settled" }));
      });
      setTimeout(() => handle.close(1, null), 30);
    } else {
      queueMicrotask(() => {
        handle.stdout.write(line({ type: "agent_start" }));
        handle.stdout.write(line({ type: "turn_start" }));
        handle.stdout.write(line({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "B_RECOVERED" }] },
        }));
        handle.stdout.write(line({ type: "agent_end" }));
        handle.stdout.write(line({ type: "agent_settled" }));
      });
      setTimeout(() => handle.close(0, null), 30);
    }
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAliveB = setInterval(() => {}, 10);
  let resultB;
  try {
    resultB = await runSingleTeammate(
      {
        agent: "general",
        task: "compare",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess: bSpawn,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
      },
    );
  } finally {
    clearInterval(keepAliveB);
  }
  assert.equal(resultB.exitCode, 0);
  assert.equal(bSpawns, 2, "B must cold-restart with a second process");
  const bSecondArgs = bSpawnedArgs[1].args;
  const sessionIndex = bSecondArgs.indexOf("--session");
  assert.ok(sessionIndex >= 0, "B must resume the recorded session checkpoint");
  assert.equal(bSecondArgs[sessionIndex + 1], checkpoint);
  assert.equal(resultB.model, "provider/backup");

  // Both recovered the same 503; the completed tool stayed in the child's
  // recorded session rather than being replayed from scratch (asserted by
  // the single-process A path and the --session B path above).
  assert.equal(resultA.exitCode, 0);
  assert.equal(resultB.exitCode, 0);

  fs.rmSync(checkpoint, { force: true });
});

// ---------------------------------------------------------------------------
// Review-fix regressions (C1/C2/H1/M1)
// ---------------------------------------------------------------------------

/**
 * C1: after an in-process switch, the same provider error text from the new
 * model must NOT be deduplicated away. The dedup set is cleared on switch, so
 * a backup that also 503s settles as a real failure (exitCode 1), never a
 * false success.
 */
test("C1: a switched model reporting the same error text settles as failure", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];
  let stdinCommands: Array<Record<string, unknown>> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          stdinCommands.push(command);
          if (command.type === "set_model") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          } else if (command.type === "prompt" && typeof command.id === "string") {
            // The resume prompt starts a turn that fails with the SAME error
            // text the primary already reported.
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "prompt",
                success: true,
              }));
              handle.stdout.write(line({ type: "agent_start" }));
              handle.stdout.write(line({ type: "turn_start" }));
              handle.stdout.write(line({
                type: "message_end",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "OpenAI API error (503)",
                },
              }));
              handle.stdout.write(line({ type: "agent_end", willRetry: false }));
              handle.stdout.write(line({ type: "agent_settled" }));
            });
          }
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  try {
    const result = await runSingleTeammate(
      {
        agent: "general",
        task: "task",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
      },
    );
    // The same error text must not be deduplicated across the switch: the
    // backup's failure is a real failure. It settles the in-process trial,
    // falls back to the process-level sweep (a second process on backup),
    // which also fails — the run settles as failed, never a false success.
    assert.equal(result.exitCode, 1);
    assert.equal(spawned.length, 2);
    assert.ok(
      stdinCommands.some((command) => command.type === "set_model"),
      "the switch still happened",
    );
  } finally {
    clearInterval(keepAlive);
  }
});

/**
 * C2: the switch chain is bounded by the candidate list and never re-selects
 * a model already tried in this run. Both candidates failing repeatedly must
 * settle the run as failed — no infinite ping-pong, no duplicate set_model
 * for the same model.
 */
test("C2: repeated failures stay bounded and never re-select a tried model", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];
  let setModelCalls = 0;

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          if (command.type === "set_model") {
            setModelCalls += 1;
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          } else if (command.type === "prompt" && typeof command.id === "string") {
            // Every resumed turn fails again with the same provider error.
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "prompt",
                success: true,
              }));
              handle.stdout.write(line({ type: "agent_start" }));
              handle.stdout.write(line({ type: "turn_start" }));
              handle.stdout.write(line({
                type: "message_end",
                message: {
                  role: "assistant",
                  stopReason: "error",
                  errorMessage: "OpenAI API error (503)",
                },
              }));
              handle.stdout.write(line({ type: "agent_end", willRetry: false }));
              handle.stdout.write(line({ type: "agent_settled" }));
            });
          }
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  try {
    const result = await runSingleTeammate(
      {
        agent: "general",
        task: "task",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
      },
    );
    // primary 503 -> switch to backup -> backup 503 -> no more candidates:
    // exactly one in-process switch, then a process-level fallback attempt on
    // backup (which also fails and ends the run).
    assert.equal(result.exitCode, 1);
    assert.equal(setModelCalls, 1, "backup must not be re-selected after it failed");
    assert.equal(spawned.length, 2, "second process is the bounded process-level fallback");
  } finally {
    clearInterval(keepAlive);
  }
});

/**
 * H1: a rejected resume prompt after a successful set_model ack settles the
 * turn as a failure instead of hanging forever.
 */
test("H1: a rejected resume prompt settles instead of hanging", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    spawned.push({ args });
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          if (command.type === "set_model") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          } else if (command.type === "prompt" && typeof command.id === "string") {
            // The resume prompt itself is rejected by Pi.
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "prompt",
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
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  try {
    const result = await runSingleTeammate(
      {
        agent: "general",
        task: "task",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
      },
    );
    // The rejected resume prompt settles the failed turn (the rejected
    // switch then falls back to the process-level sweep on backup, which
    // also fails). No hang: the promise resolves.
    assert.equal(result.exitCode, 1);
    assert.equal(spawned.length, 2, "rejected resume prompt falls back to the process sweep");
    assert.deepEqual(result.attemptedModels, ["provider/primary", "provider/backup"]);
  } finally {
    clearInterval(keepAlive);
  }
});

/**
 * H2: set_model can succeed while the resumed turn never starts. The resume
 * phase has its own deadline and must project that diagnostic before close.
 */
test("H2: a silent resumed turn settles on the model-switch deadline", async () => {
  const spawned: Array<{ args: readonly string[] }> = [];
  const handles: FakeChildHandle[] = [];
  const progress: Array<{ status: string; lastMessage?: string }> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    handles.push(handle);
    spawned.push({ args });
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          if (command.type === "set_model") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          }
          // Deliberately ignore the resume prompt: Pi stays silent.
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const controller = new AbortController();
  type ProgressSnapshot = { status: string; lastMessage?: string };
  let resolveFailure!: (entry: ProgressSnapshot) => void;
  const failureObserved = new Promise<ProgressSnapshot>((resolve) => { resolveFailure = resolve; });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let run: ReturnType<typeof runSingleTeammate> | undefined;
  try {
    run = runSingleTeammate(
      {
        agent: "general",
        task: "task",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: new ModelCircuitBreaker(),
        enableRetryBackoff: false,
        modelSwitchAckTimeoutMs: 40,
        signal: controller.signal,
        onProgress: (entry) => {
          const snapshot = { status: entry.status, lastMessage: entry.lastMessage };
          progress.push(snapshot);
          if (
            snapshot.status === "failed"
            && /did not start the resumed turn under provider\/backup/.test(snapshot.lastMessage ?? "")
          ) resolveFailure(snapshot);
        },
      },
    );
    void run.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(
        `H2 TIMEOUT spawned=${JSON.stringify(spawned)} progress=${JSON.stringify(progress)}`,
      )), 5_000);
    });
    const terminal = await Promise.race([failureObserved, timeout]);

    assert.equal(terminal.status, "failed");
    assert.match(terminal.lastMessage ?? "", /did not start the resumed turn under provider\/backup/);
    assert.equal(spawned.length, 1);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    controller.abort();
    for (const handle of handles) handle.close(null, "SIGTERM");
    await run?.catch(() => undefined);
  }
});

/**
 * M1: breaker bookkeeping matches the B path — the original model that
 * failed (and was switched away from) is charged a retryable failure, while
 * the in-process successor that recovered is credited with success.
 */
test("M1: breaker records the failed original and the recovered successor", async () => {
  const breaker = new ModelCircuitBreaker();
  let stdinCommands: Array<Record<string, unknown>> = [];

  const spawnChildProcess = ((_command: string, args: readonly string[]) => {
    const handle = createFakeChild();
    handle.child.stdin!.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString().split("\n")) {
        if (!raw.trim()) continue;
        try {
          const command = JSON.parse(raw) as Record<string, unknown>;
          stdinCommands.push(command);
          if (command.type === "set_model") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "set_model",
                success: true,
              }));
            });
          } else if (command.type === "prompt" && typeof command.id === "string") {
            queueMicrotask(() => {
              handle.stdout.write(line({
                type: "response",
                id: command.id,
                command: "prompt",
                success: true,
              }));
              handle.stdout.write(line({ type: "agent_start" }));
              handle.stdout.write(line({ type: "turn_start" }));
              handle.stdout.write(line({
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "RECOVERED" }] },
              }));
              handle.stdout.write(line({ type: "agent_end" }));
              handle.stdout.write(line({ type: "agent_settled" }));
            });
          }
        } catch {
          // Ignore malformed test lines.
        }
      }
    });
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "agent_start" }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (503)",
        },
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  try {
    const result = await runSingleTeammate(
      {
        agent: "general",
        task: "task",
        model: "provider/primary",
        fallbackModels: ["provider/backup"],
      },
      {
        baseCwd: process.cwd(),
        spawnChildProcess,
        modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
        modelCircuitBreaker: breaker,
        enableRetryBackoff: false,
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.model, "provider/backup");
    const snapshots = Object.fromEntries(
      breaker.snapshot().map((entry) => [entry.model, entry]),
    );
    // Original failed once (switched away), successor succeeded.
    assert.equal(snapshots["provider/primary"]?.consecutiveFailures, 1);
    assert.equal(snapshots["provider/primary"]?.state, "CLOSED");
    assert.equal(snapshots["provider/backup"]?.consecutiveFailures, 0);
    assert.equal(snapshots["provider/backup"]?.state, "CLOSED");
  } finally {
    clearInterval(keepAlive);
  }
});

// Cleanup
// ---------------------------------------------------------------------------

test.after(() => {
  try {
    fs.rmSync(teammateTempRoot(), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

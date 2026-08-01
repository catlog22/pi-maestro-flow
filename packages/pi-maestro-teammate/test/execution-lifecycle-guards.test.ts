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

  assert.equal(completions.length, 1, "lifecycle must be confirmed by the deadline");
  assert.equal(completions[0].exitCode, 0, "the deadline must not retract a published success");
  assert.match(completions[0].messages.at(-1)?.content ?? "", /never confirmed its lifecycle within 40ms/);
  assert.match(completions[0].messages.at(-1)?.content ?? "", /agent=general/);
  assert.equal(handle!.killed(), true, "the wedged child must be terminated");
  assert.equal(progress.at(-1)?.status, "completed");
  assert.equal(progress.at(-1)?.resultReadyAt, undefined);
});

test("REL-4: a prompt agent_end still settles before the lifecycle deadline fires", async () => {
  const completions: SingleResult[] = [];
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild();
    queueMicrotask(() => {
      handle!.stdout.write(line(resultReadyTurnEnd("quick answer")));
      handle!.stdout.write(line({ type: "agent_end" }));
    });
    return handle!.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "answer and settle", context: "fresh" },
    { baseCwd: process.cwd(), spawnChildProcess, resultReadyGraceMs: 40, onTurnComplete: (e) => completions.push(e) },
  );

  assert.equal(result.lifecyclePending, true);
  await delay(160);
  assert.equal(completions.length, 1);
  assert.equal(
    completions[0].messages.some((m) => /never confirmed its lifecycle/.test(m.content)),
    false,
    "a confirmed lifecycle must not be annotated as a deadline expiry",
  );
  assert.equal(handle!.killed(), false, "a fresh teammate stays wakeable after agent_end");
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

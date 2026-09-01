import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  runSingleTeammate,
} from "../src/runs/execution.ts";
import { unwrapLeasedMessage, wrapLeasedMessage } from "../src/runs/session-handoff.ts";
import {
  AGENT_TURN_VERSION,
  unknownMessageProvenanceV1,
  type AgentTurnEvent,
  type AgentTurnTriggerContextV1,
} from "../src/shared/types.ts";
import { ModelCircuitBreaker } from "../src/models/model-circuit-breaker.ts";
import { foldAgentTurnEvents } from "../src/shared/turn-ledger.ts";

type SpawnSeam = NonNullable<Parameters<typeof runSingleTeammate>[1]["spawnChildProcess"]>;

interface FakeChildHandle {
  child: ChildProcess;
  stdout: PassThrough;
  commands: Array<Record<string, unknown>>;
}

function createFakeChild(
  onCommand: (command: Record<string, unknown>, handle: FakeChildHandle) => void,
): FakeChildHandle {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
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
  const handle = { child, stdout, commands };
  stdin.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString();
    while (true) {
      const newline = stdinBuffer.indexOf("\n");
      if (newline < 0) break;
      const raw = stdinBuffer.slice(0, newline).trim();
      stdinBuffer = stdinBuffer.slice(newline + 1);
      if (!raw) continue;
      const command = JSON.parse(raw) as Record<string, unknown>;
      commands.push(command);
      onCommand(command, handle);
    }
  });
  Object.assign(child, {
    stdin,
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
  return handle;
}

const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const acceptedInput = (command: Record<string, unknown>): string =>
  unwrapLeasedMessage(String(command.message)).message;

function stableContext(correlationId: string): AgentTurnTriggerContextV1 {
  return {
    version: AGENT_TURN_VERSION,
    turnId: "turn-stable-phase-3",
    correlationId,
    runtimeGeneration: 7,
    promptSeq: 3,
    trigger: unknownMessageProvenanceV1({
      messageId: "initial-message",
      messageKind: "task",
      deliveryMode: "prompt",
    }),
  };
}

function emitSuccessfulTurn(handle: FakeChildHandle, exactUserMessage: string, answer: string): void {
  handle.stdout.write(line({
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text: exactUserMessage }] },
  }));
  handle.stdout.write(line({ type: "turn_start" }));
  handle.stdout.write(line({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: answer }] },
  }));
  handle.stdout.write(line({
    type: "turn_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }] },
    toolResults: [],
  }));
  handle.stdout.write(line({ type: "agent_end", willRetry: false }));
  handle.stdout.write(line({ type: "agent_settled" }));
}

test("transport sidecar correlates the exact lease-unwrapped user text and keeps RPC metadata-free", async () => {
  const correlationId = "phase-3-exact";
  const context = stableContext(correlationId);
  const events: AgentTurnEvent[] = [];
  const lease = { owner: "child" as const, epoch: 4, nonce: "lease-nonce" };
  let handle: FakeChildHandle | undefined;
  const spawnChildProcess = (() => {
    handle = createFakeChild((command, childHandle) => {
      if (command.type !== "prompt") return;
      queueMicrotask(() => emitSuccessfulTurn(childHandle, acceptedInput(command), "done"));
    });
    return handle.child;
  }) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "exact task", context: "fork" },
    {
      baseCwd: process.cwd(),
      correlationId,
      initialTurnContext: context,
      initialLeaseToken: lease,
      recordTurnEvent: (event) => events.push(event),
      spawnChildProcess,
    },
  );
  await delay(20);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(handle!.commands[0]!).sort(), ["message", "type"]);
  assert.equal(handle!.commands[0]!.message, wrapLeasedMessage("exact task", lease));
  assert.equal(events.filter((event) => event.type === "trigger-enqueued").length, 1);
  assert.equal(events.filter((event) => event.type === "trigger-accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "turn-started").length, 1);
  assert.equal(events.filter((event) => event.type === "result-ready").length, 1);
  assert.equal(events.filter((event) => event.type === "turn-settled").length, 1);
  const folded = foldAgentTurnEvents(events);
  assert.equal(folded.rejected, 0);
  assert.equal(folded.ignored, 0);
  for (const event of events) {
    assert.equal(event.turnId, context.turnId);
    assert.equal(event.runtimeGeneration, context.runtimeGeneration);
    assert.equal(event.promptSeq, context.promptSeq);
  }
  const assistantMessages = events.flatMap((event) =>
    "lastMessage" in event && event.lastMessage?.role === "assistant" ? [event.lastMessage] : []
  );
  assert.ok(assistantMessages.length > 0);
  for (const message of assistantMessages) {
    assert.equal(message.provenance.source, "agent-runtime");
    assert.equal(message.provenance.confidence, "verified");
    assert.deepEqual(message.provenance.sender, { kind: "teammate-agent", correlationId });
  }
});

test("turn_end without an observed assistant message preserves the accepted user provenance", async () => {
  const correlationId = "phase-3-missing-assistant";
  const events: AgentTurnEvent[] = [];
  const spawnChildProcess = (() => createFakeChild((command, handle) => {
    if (command.type !== "prompt") return;
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: acceptedInput(command) }] },
      }));
      handle.stdout.write(line({ type: "turn_start" }));
      handle.stdout.write(line({ type: "turn_end", message: {}, toolResults: [] }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
  }).child) as unknown as SpawnSeam;

  await runSingleTeammate(
    { agent: "general", task: "missing assistant task", context: "fork" },
    {
      baseCwd: process.cwd(),
      correlationId,
      initialTurnContext: stableContext(correlationId),
      recordTurnEvent: (event) => events.push(event),
      spawnChildProcess,
    },
  );
  await delay(20);

  const turnEnded = events.find((event) => event.type === "turn-ended");
  assert.ok(turnEnded && turnEnded.type === "turn-ended");
  assert.equal(turnEnded.lastMessage.role, "user");
  assert.notEqual(turnEnded.lastMessage.provenance.source, "agent-runtime");
  assert.equal(events.some((event) =>
    "lastMessage" in event
    && event.lastMessage?.provenance.source === "agent-runtime"
  ), false);
});

test("streaming text deltas do not persist one progress event per token", async () => {
  const correlationId = "phase-3-stream-progress";
  const events: AgentTurnEvent[] = [];
  const spawnChildProcess = (() => createFakeChild((command, handle) => {
    if (command.type !== "prompt") return;
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: acceptedInput(command) }] },
      }));
      handle.stdout.write(line({ type: "turn_start" }));
      for (let index = 0; index < 200; index += 1) {
        handle.stdout.write(line({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        }));
      }
      handle.stdout.write(line({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }));
      handle.stdout.write(line({
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
        toolResults: [],
      }));
      handle.stdout.write(line({ type: "agent_end", willRetry: false }));
      handle.stdout.write(line({ type: "agent_settled" }));
    });
  }).child) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "stream task", context: "fork" },
    {
      baseCwd: process.cwd(),
      correlationId,
      initialTurnContext: stableContext(correlationId),
      recordTurnEvent: (event) => events.push(event),
      spawnChildProcess,
    },
  );
  await delay(20);

  assert.equal(result.exitCode, 0);
  const repeatedStreamingState = events.filter((event) =>
    event.type === "progress"
    && event.phase === "prompting"
    && event.toolActivity === "idle"
  );
  assert.ok(
    repeatedStreamingState.length <= 3,
    `expected bounded lifecycle progress, got ${repeatedStreamingState.length} entries for 200 text deltas`,
  );
  assert.equal(events.some((event) => event.type === "turn-settled"), true);
  assert.equal(foldAgentTurnEvents(events).rejected, 0);
});

test("raw turn_start and an unmatched user message never create logical identity", async () => {
  const events: AgentTurnEvent[] = [];
  const spawnChildProcess = (() => createFakeChild((command, handle) => {
    if (command.type !== "prompt") return;
    queueMicrotask(() => {
      handle.stdout.write(line({ type: "turn_start" }));
      emitSuccessfulTurn(handle, "internal recovery input", "unmatched remains anonymous");
    });
  }).child) as unknown as SpawnSeam;

  const result = await runSingleTeammate(
    { agent: "general", task: "external task", context: "fork" },
    {
      baseCwd: process.cwd(),
      correlationId: "phase-3-unmatched",
      initialTurnContext: stableContext("phase-3-unmatched"),
      recordTurnEvent: (event) => events.push(event),
      spawnChildProcess,
    },
  );
  await delay(20);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.map((event) => event.type), ["trigger-enqueued"]);
});

test("fallback candidates reuse stable identity, advance only loop offset, and emit one enqueue", async () => {
  const correlationId = "phase-3-fallback";
  const context = stableContext(correlationId);
  const events: AgentTurnEvent[] = [];
  const handles: FakeChildHandle[] = [];
  let candidate = 0;
  const spawnChildProcess = (() => {
    const index = candidate++;
    const handle = createFakeChild((command, childHandle) => {
      if (command.type !== "prompt") return;
      queueMicrotask(() => {
        childHandle.stdout.write(line({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: acceptedInput(command) }] },
        }));
        childHandle.stdout.write(line({ type: "turn_start" }));
        if (index === 0) {
          childHandle.stdout.write(line({ type: "agent_start" }));
          childHandle.stdout.write(line({ type: "turn_start" }));
          childHandle.stdout.write(line({ type: "agent_start" }));
          childHandle.stdout.write(line({ type: "turn_start" }));
          childHandle.stdout.write(line({
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: "OpenAI API error (503)" },
          }));
          childHandle.stdout.write(line({ type: "agent_end", willRetry: false }));
          childHandle.stdout.write(line({ type: "agent_settled" }));
        } else {
          childHandle.stdout.write(line({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "fallback done" }] },
          }));
          childHandle.stdout.write(line({
            type: "turn_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "fallback done" }],
            },
            toolResults: [],
          }));
          childHandle.stdout.write(line({ type: "agent_end", willRetry: false }));
          childHandle.stdout.write(line({ type: "agent_settled" }));
        }
      });
    });
    handles.push(handle);
    return handle.child;
  }) as unknown as SpawnSeam;

  const keepAlive = setInterval(() => {}, 10);
  const result = await runSingleTeammate(
    {
      agent: "general",
      task: "fallback task",
      context: "fork",
      model: "provider/primary",
      fallbackModels: ["provider/backup"],
    },
    {
      baseCwd: process.cwd(),
      correlationId,
      initialTurnContext: context,
      modelCapabilities: [{ id: "provider/primary" }, { id: "provider/backup" }],
      modelCircuitBreaker: new ModelCircuitBreaker(),
      enableRetryBackoff: false,
      recordTurnEvent: (event) => events.push(event),
      spawnChildProcess,
    },
  );
  clearInterval(keepAlive);
  await delay(20);

  assert.equal(result.exitCode, 0);
  assert.equal(handles.length, 2);
  assert.equal(events.filter((event) => event.type === "trigger-enqueued").length, 1);
  const accepted = events.filter((event) => event.type === "trigger-accepted");
  assert.deepEqual(accepted.map((event) => event.loopSeq), [0]);
  const started = events.filter((event) => event.type === "turn-started");
  assert.deepEqual(started.map((event) => event.loopSeq), [0, 1, 2, 3]);
  assert.ok(started.every((event) => event.turnId === context.turnId));
  assert.ok(started.every((event) => event.trigger === context.trigger));
  assert.equal(events.filter((event) => event.type === "failed").length, 0);
  assert.equal(events.filter((event) => event.type === "turn-settled").length, 1);
  const folded = foldAgentTurnEvents(events);
  assert.equal(folded.rejected, 0);
  assert.equal(folded.ignored, 0);
});

test("caller cancellation replaces buffered candidate settlement with canonical termination", async () => {
  const correlationId = "phase-3-cancel";
  const context = stableContext(correlationId);
  const events: AgentTurnEvent[] = [];
  const controller = new AbortController();
  const spawnChildProcess = (() => createFakeChild((command, handle) => {
    if (command.type !== "prompt") return;
    queueMicrotask(() => {
      handle.stdout.write(line({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: acceptedInput(command) }] },
      }));
      handle.stdout.write(line({ type: "turn_start" }));
    });
  }).child) as unknown as SpawnSeam;

  const running = runSingleTeammate(
    { agent: "general", task: "cancel task", context: "fork" },
    {
      baseCwd: process.cwd(),
      correlationId,
      initialTurnContext: context,
      signal: controller.signal,
      recordTurnEvent: (event) => events.push(event),
      spawnChildProcess,
    },
  );
  const deadline = Date.now() + 2_000;
  while (!events.some((event) => event.type === "turn-started") && Date.now() < deadline) {
    await delay(10);
  }
  controller.abort("focused cancellation");
  const result = await running;
  await delay(20);

  assert.equal(result.terminalStatus, "terminated");
  assert.equal(events.filter((event) => event.type === "terminated").length, 1);
  assert.equal(events.at(-1)?.type, "terminated");
  const folded = foldAgentTurnEvents(events);
  assert.equal(folded.rejected, 0);
  assert.equal(folded.ignored, 0);
});

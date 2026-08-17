import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureProcessTree,
  redactRemoteError,
  signalProcessTree,
  targetChildEnvironment,
  type ProcessTreeIdentity,
} from "./child-security.ts";
import type {
  RemoteDriver,
  RemoteDriverContext,
  RemoteRunHandle,
} from "./driver.ts";
import {
  REMOTE_MAX_LINE_BYTES,
  REMOTE_MAX_OBJECTIVE_BYTES,
  type RemoteRunCancelParams,
  type RemoteRunCancelResult,
  type RemoteRunInputParams,
  type RemoteRunInputResult,
  type RemoteRunStartParams,
} from "./protocol.ts";
import { applyRemoteRunEvent, createRemoteRunSnapshot } from "./state.ts";
import {
  ensurePrivateRemoteDirectory,
  REMOTE_PRIVATE_FILE_MODE,
} from "./journal.ts";
import type {
  RemoteDriverEvent,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteUsage,
} from "./types.ts";

export const PI_RPC_STDERR_LIMIT = 64 * 1024;
export const PI_RPC_EVENT_TEXT_LIMIT = 512 * 1024;
export const PI_RPC_RESULT_LIMIT = 512 * 1024;
export const PI_RPC_CANCEL_GRACE_MS = 2_000;
export const PI_RPC_EVENT_QUEUE_BYTES = 4 * 1024 * 1024;
export const PI_RPC_PENDING_INPUT_LIMIT = 64;
export const PI_RPC_PENDING_INPUT_BYTES = 1024 * 1024;

type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface PiRpcDriverOptions {
  scratchRoot?: string;
  cancelGraceMs?: number;
  eventQueueBytes?: number;
  spawnChild?: SpawnChild;
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: Array<{ value: T; bytes: number }> = [];
  readonly #waiters: Array<(value: IteratorResult<T>) => void> = [];
  readonly #maxBytes: number;
  readonly #sizeOf: (value: T) => number;
  readonly #onDrain: () => void;
  #queuedBytes = 0;
  #closed = false;

  constructor(maxBytes: number, sizeOf: (value: T) => number, onDrain: () => void) {
    this.#maxBytes = maxBytes;
    this.#sizeOf = sizeOf;
    this.#onDrain = onDrain;
  }

  get queuedBytes(): number { return this.#queuedBytes; }

  push(value: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return true;
    }
    const bytes = this.#sizeOf(value);
    if (bytes > this.#maxBytes || this.#queuedBytes + bytes > this.#maxBytes) return false;
    this.#values.push({ value, bytes });
    this.#queuedBytes += bytes;
    return true;
  }

  replaceAndClose(value: T): void {
    if (this.#closed) return;
    this.#values.splice(0);
    this.#queuedBytes = 0;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else {
      const bytes = this.#sizeOf(value);
      this.#values.push({ value, bytes });
      this.#queuedBytes = bytes;
    }
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#queuedBytes -= queued.bytes;
          this.#onDrain();
          return Promise.resolve({ done: false, value: queued.value });
        }
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    void error;
    return Number.POSITIVE_INFINITY;
  }
}

function appendUtf8Tail(current: string, addition: string, maxBytes: number): string {
  const combined = current + addition;
  const bytes = Buffer.byteLength(combined);
  if (bytes <= maxBytes) return combined;
  const buffer = Buffer.from(combined);
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function appendUtf8Head(current: string, addition: string, maxBytes: number): string {
  const combined = current + addition;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  return Buffer.from(combined).subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function writePrivateFile(filePath: string, content: string): void {
  const fd = fs.openSync(filePath, "wx", REMOTE_PRIVATE_FILE_MODE);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function buildRpcArgv(
  command: readonly [string, ...string[]],
  name: string,
  structuredOutput: boolean,
): { executable: string; args: string[] } {
  const executable = command[0];
  const args = [...command.slice(1)];
  const modeIndex = args.findIndex((argument) => argument === "--mode");
  if (modeIndex >= 0) {
    if (args[modeIndex + 1] !== "rpc") throw new Error("Trusted Pi command must use --mode rpc");
  } else {
    args.push("--mode", "rpc");
  }
  if (!args.includes("--name") && !args.includes("-n")) args.push("--name", name);
  if (structuredOutput) {
    args.push("--extension", fileURLToPath(new URL("../extension/structured-output.ts", import.meta.url)));
    const toolsIndex = args.findIndex((argument) => argument === "--tools");
    if (toolsIndex >= 0 && typeof args[toolsIndex + 1] === "string") {
      const tools = new Set(args[toolsIndex + 1].split(",").filter(Boolean));
      tools.add("structured_output");
      args[toolsIndex + 1] = [...tools].join(",");
    }
  }
  return { executable, args };
}

function validateTrustedTarget(request: RemoteRunStartParams, context: RemoteDriverContext): void {
  const target = context.target;
  if (request.targetId !== target.id
    || request.cwd !== target.cwd
    || request.driver !== target.driver
    || request.command.length !== target.command.length
    || request.command.some((argument, index) => argument !== target.command[index])) {
    throw new Error("Remote run request does not match the trusted configured target");
  }
  if (Buffer.byteLength(request.objective, "utf8") > REMOTE_MAX_OBJECTIVE_BYTES) {
    throw new Error("Remote objective exceeds the protocol limit");
  }
}

function boundedStructuredOutput(value: Record<string, unknown>): unknown {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= REMOTE_MAX_OBJECTIVE_BYTES ? value : undefined;
  } catch {
    return undefined;
  }
}

function extractUsage(value: unknown): RemoteUsage | undefined {
  if (!plainObject(value)) return undefined;
  const cost = plainObject(value.cost) ? value.cost : undefined;
  const usage: RemoteUsage = {};
  const input = value.inputTokens ?? value.input;
  const output = value.outputTokens ?? value.output;
  const total = value.totalTokens;
  const costUsd = value.costUsd ?? cost?.total;
  if (typeof input === "number" && Number.isFinite(input)) usage.inputTokens = input;
  if (typeof output === "number" && Number.isFinite(output)) usage.outputTokens = output;
  if (typeof total === "number" && Number.isFinite(total)) usage.totalTokens = total;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) usage.costUsd = costUsd;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

class PiRpcRunHandle implements RemoteRunHandle {
  readonly capture: RemoteRunCapture;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #queue: AsyncEventQueue<RemoteRunEvent>;
  readonly #scratchDirectory: string;
  readonly #cancelGraceMs: number;
  readonly #eventQueueBytes: number;
  readonly #processTree: ProcessTreeIdentity | undefined;
  #snapshot: RemoteRunSnapshot;
  #sequence = 0;
  #stderr = "";
  #result = "";
  #structuredOutput: unknown;
  #terminal = false;
  #cancelRequested = false;
  #closePromise: Promise<void>;
  #resolveClosed!: () => void;
  #stdoutBuffer = Buffer.alloc(0);
  #stdoutPaused = false;
  #pendingInputCount = 0;
  #pendingInputBytes = 0;
  #terminationPromise?: Promise<void>;

  constructor(
    capture: RemoteRunCapture,
    child: ChildProcessWithoutNullStreams,
    scratchDirectory: string,
    objective: string,
    cancelGraceMs: number,
    eventQueueBytes: number,
  ) {
    this.capture = Object.freeze({ ...capture });
    this.#child = child;
    this.#scratchDirectory = scratchDirectory;
    this.#cancelGraceMs = cancelGraceMs;
    this.#eventQueueBytes = eventQueueBytes;
    this.#processTree = captureProcessTree(child.pid);
    this.#queue = new AsyncEventQueue<RemoteRunEvent>(eventQueueBytes, serializedBytes, () => this.#resumeStdoutAfterDrain());
    this.#snapshot = createRemoteRunSnapshot(capture, "connecting");
    this.#closePromise = new Promise((resolve) => { this.#resolveClosed = resolve; });
    this.#bindChild();
    this.#emitState("running", "pi-rpc-started");
    void this.#writeCommand({ id: `start-${capture.runId}`, type: "prompt", message: objective }).catch((error) => {
      if (this.#cancelRequested || this.#terminal) return;
      this.#finish("failed", undefined, `Pi RPC prompt write failed: ${redactRemoteError(error)}`);
      this.#scheduleTreeTermination();
    });
  }

  snapshot(): RemoteRunSnapshot {
    return { ...this.#snapshot };
  }

  events(): AsyncIterable<RemoteRunEvent> {
    return this.#queue;
  }

  whenClosed(): Promise<void> {
    return this.#closePromise;
  }

  async input(request: RemoteRunInputParams): Promise<RemoteRunInputResult> {
    this.#assertOwnership(request.runId, request.generation, request.monitorOwnerNonce);
    if (this.#terminal) throw new Error("Remote run is already terminal");
    if (this.#cancelRequested) throw new Error("Remote run cancellation is already in progress");
    if (Buffer.byteLength(request.message, "utf8") > REMOTE_MAX_OBJECTIVE_BYTES) {
      throw new Error("Remote input exceeds the protocol limit");
    }
    const type = request.mode === "steer" ? "steer" : "follow_up";
    await this.#writeCommand({ id: request.commandId, type, message: request.message });
    return { accepted: true, effectiveMode: request.mode, receipt: "queued" };
  }

  async cancel(request: RemoteRunCancelParams): Promise<RemoteRunCancelResult> {
    this.#assertOwnership(request.runId, request.generation, request.monitorOwnerNonce);
    if (this.#terminal) return { accepted: false, status: this.#snapshot.status };
    if (!this.#cancelRequested) {
      this.#cancelRequested = true;
      try {
        await this.#writeCommand({ id: request.commandId, type: "abort" });
      } catch (error) {
        void error;
      }
      this.#scheduleTreeTermination();
    }
    return { accepted: true, status: this.#snapshot.status };
  }

  async close(): Promise<void> {
    if (!this.#terminal && !this.#cancelRequested) {
      await this.cancel({
        commandId: `close-${randomUUID()}`,
        runId: this.capture.runId,
        generation: this.capture.generation,
        monitorOwnerNonce: this.capture.monitorOwnerNonce,
        reason: "driver-close",
      });
    }
    await this.#closePromise;
  }

  #bindChild(): void {
    const stderrDecoder = new StringDecoder("utf8");
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = appendUtf8Tail(this.#stderr, stderrDecoder.write(chunk), PI_RPC_STDERR_LIMIT);
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#processStdout(chunk));
    this.#child.on("error", (error) => this.#finish("failed", undefined, `Pi RPC process error: ${redactRemoteError(error)}`));
    this.#child.on("close", (code, signal) => {
      this.#processStdout(Buffer.alloc(0), true);
      this.#stderr = appendUtf8Tail(this.#stderr, stderrDecoder.end(), PI_RPC_STDERR_LIMIT);
      if (!this.#terminal) {
        if (this.#cancelRequested) this.#finish("cancelled", undefined, undefined, signal ?? undefined);
        else if (code === 0) this.#finish("completed", this.#result.trim() || undefined);
        else {
          const stderrBytes = Buffer.byteLength(this.#stderr, "utf8");
          this.#finish(
            "failed",
            undefined,
            `Pi RPC process exited with code ${code ?? "null"} and signal ${signal ?? "none"}${stderrBytes > 0 ? ` (captured ${stderrBytes} stderr bytes)` : ""}`,
          );
        }
      }
      this.#cleanupScratch();
      this.#scheduleTreeTermination();
      void (this.#terminationPromise ?? Promise.resolve()).finally(() => this.#resolveClosed());
    });
  }

  #processStdout(chunk: Buffer, final = false): void {
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.length > REMOTE_MAX_LINE_BYTES && !this.#stdoutBuffer.includes(0x0a)) {
      this.#finish("failed", undefined, "Pi RPC stdout record exceeds the remote protocol limit");
      this.#signalTree("SIGKILL");
      return;
    }
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const record = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (record.length > REMOTE_MAX_LINE_BYTES) {
        this.#finish("failed", undefined, "Pi RPC stdout record exceeds the remote protocol limit");
        this.#signalTree("SIGKILL");
        return;
      }
      const line = record.length > 0 && record[record.length - 1] === 0x0d
        ? record.subarray(0, -1).toString("utf8")
        : record.toString("utf8");
      if (!line) continue;
      let event: unknown;
      try { event = JSON.parse(line); } catch {
        this.#finish("failed", undefined, "Pi RPC emitted invalid JSON");
        this.#signalTree("SIGKILL");
        return;
      }
      this.#processRpcEvent(event);
    }
    if (final && this.#stdoutBuffer.length > 0) {
      this.#finish("failed", undefined, "Pi RPC stdout ended with an incomplete JSONL record");
      this.#stdoutBuffer = Buffer.alloc(0);
    }
  }

  #processRpcEvent(value: unknown): void {
    if (!plainObject(value) || typeof value.type !== "string" || this.#terminal) return;
    switch (value.type) {
      case "message_update": {
        const update = plainObject(value.assistantMessageEvent) ? value.assistantMessageEvent : undefined;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          const delta = appendUtf8Head("", update.delta, PI_RPC_EVENT_TEXT_LIMIT);
          this.#result = appendUtf8Head(this.#result, delta, PI_RPC_RESULT_LIMIT);
          this.#emitProgress({ type: "text", text: delta });
        }
        break;
      }
      case "message_end": {
        const message = plainObject(value.message) ? value.message : undefined;
        const usage = extractUsage(message?.usage ?? value.usage);
        if (usage) this.#emitProgress({ type: "usage", usage });
        break;
      }
      case "usage": {
        const usage = extractUsage(value.usage);
        if (usage) this.#emitProgress({ type: "usage", usage });
        break;
      }
      case "tool_execution_start":
      case "tool_execution_end": {
        const toolName = appendUtf8Head("", typeof value.toolName === "string" ? value.toolName : "unknown", 4096);
        const toolCallId = appendUtf8Head("", typeof value.toolCallId === "string" ? value.toolCallId : "unknown", 4096);
        if (value.type === "tool_execution_start" && toolName === "structured_output" && plainObject(value.args)) {
          this.#structuredOutput = boundedStructuredOutput(value.args);
        }
        this.#emitProgress({
          type: "tool",
          tool: {
            toolCallId,
            toolName,
            phase: value.type === "tool_execution_start" ? "start" : "end",
            ...(value.isError === true ? { isError: true } : {}),
          },
        });
        break;
      }
      case "agent_start":
        if (this.#snapshot.status !== "running") this.#emitState("running", "agent_start");
        break;
      case "auto_retry_start":
      case "compaction_start":
      case "queue_update":
        this.#emitProgress({ type: "native", name: value.type });
        break;
      case "agent_settled":
        this.#finish("completed", this.#result.trim() || undefined);
        this.#child.stdin.end();
        this.#scheduleTreeTermination();
        break;
      case "extension_error":
      case "error": {
        const message = typeof value.message === "string"
          ? value.message
          : typeof value.error === "string" ? value.error : "Pi RPC reported an error";
        this.#emitProgress({
          type: "native",
          name: value.type,
          data: { message: redactRemoteError(message, { maximumBytes: 4096 }) },
        });
        break;
      }
    }
  }

  async #writeCommand(command: Record<string, unknown>): Promise<void> {
    if (!this.#child.stdin.writable) throw new Error("Pi RPC stdin is not writable");
    const line = `${JSON.stringify(command)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > REMOTE_MAX_LINE_BYTES) throw new Error("Pi RPC command exceeds the protocol limit");
    if (this.#pendingInputCount >= PI_RPC_PENDING_INPUT_LIMIT
      || this.#pendingInputBytes + bytes > PI_RPC_PENDING_INPUT_BYTES) {
      throw new Error("Pi RPC input queue limit reached");
    }
    this.#pendingInputCount += 1;
    this.#pendingInputBytes += bytes;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const complete = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this.#pendingInputCount -= 1;
        this.#pendingInputBytes -= bytes;
        if (error) reject(error);
        else resolve();
      };
      try {
        this.#child.stdin.write(line, (error) => complete(error));
      } catch (error) {
        complete(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #signalTree(signal: NodeJS.Signals): void {
    try {
      signalProcessTree(this.#processTree, signal);
      return;
    } catch (treeError) {
      try {
        this.#child.kill(signal);
        return;
      } catch (leaderError) {
        if (!this.#terminal && !this.#cancelRequested) {
          this.#finish(
            "failed",
            undefined,
            `Pi RPC process-tree termination failed: ${redactRemoteError(treeError)}; leader fallback failed: ${redactRemoteError(leaderError)}`,
          );
        }
      }
    }
  }

  #scheduleTreeTermination(): void {
    if (this.#terminationPromise) return;
    this.#signalTree("SIGTERM");
    this.#terminationPromise = new Promise((resolve) => {
      setTimeout(() => {
        this.#signalTree("SIGKILL");
        resolve();
      }, this.#cancelGraceMs);
    });
  }

  #resumeStdoutAfterDrain(): void {
    if (!this.#stdoutPaused || this.#terminal) return;
    if (this.#queue.queuedBytes > this.#eventQueueBytes / 4) return;
    this.#stdoutPaused = false;
    this.#child.stdout.resume();
  }

  #emitState(status: "running" | "waiting", nativeStatus?: string): void {
    this.#publish({
      type: "run/state",
      ...this.capture,
      sequence: ++this.#sequence,
      status,
      updatedAt: Date.now(),
      ...(nativeStatus ? { nativeStatus } : {}),
    });
  }

  #emitProgress(event: RemoteDriverEvent): void {
    this.#publish({
      type: "run/event",
      ...this.capture,
      sequence: ++this.#sequence,
      event,
      updatedAt: Date.now(),
    });
  }

  #finish(
    status: "completed" | "failed" | "cancelled",
    result?: string,
    error?: string,
    nativeStatus?: string,
  ): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#loadStructuredOutputFile();
    const redactedError = error === undefined
      ? undefined
      : redactRemoteError(error, { maximumBytes: 4096 });
    try {
      writePrivateFile(path.join(this.#scratchDirectory, "output.json"), `${JSON.stringify({ status, result, structuredOutput: this.#structuredOutput, error: redactedError })}\n`);
    } catch (writeError) {
      void writeError;
    }
    this.#publish({
      type: "run/result",
      ...this.capture,
      sequence: ++this.#sequence,
      status,
      updatedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
      ...(this.#structuredOutput === undefined ? {} : { structuredOutput: this.#structuredOutput }),
      ...(redactedError === undefined ? {} : { error: redactedError }),
      ...(nativeStatus === undefined ? {} : { nativeStatus }),
    });
    this.#queue.close();
  }

  #publish(event: RemoteRunEvent): void {
    if (this.#queue.push(event)) {
      this.#snapshot = applyRemoteRunEvent(this.#snapshot, event);
      if (!this.#terminal && !this.#stdoutPaused && this.#queue.queuedBytes >= this.#eventQueueBytes / 2) {
        this.#stdoutPaused = true;
        this.#child.stdout.pause();
      }
      return;
    }
    const overflow: RemoteRunEvent = {
      type: "run/result",
      ...this.capture,
      sequence: event.sequence,
      status: "failed",
      updatedAt: Date.now(),
      error: "Pi RPC event queue byte limit exceeded",
    };
    this.#terminal = true;
    this.#snapshot = applyRemoteRunEvent(this.#snapshot, overflow);
    this.#queue.replaceAndClose(overflow);
    this.#stdoutPaused = true;
    this.#child.stdout.pause();
    this.#scheduleTreeTermination();
  }

  #assertOwnership(runId: string, generation: number, monitorOwnerNonce: string): void {
    if (runId !== this.capture.runId
      || generation !== this.capture.generation
      || monitorOwnerNonce !== this.capture.monitorOwnerNonce) {
      throw new Error("Remote run ownership capture mismatch");
    }
  }

  #cleanupScratch(): void {
    try {
      fs.rmSync(this.#scratchDirectory, { recursive: true, force: true });
    } catch (error) {
      void error;
    }
  }

  #loadStructuredOutputFile(): void {
    const outputPath = path.join(this.#scratchDirectory, "output.json");
    try {
      const stat = fs.lstatSync(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > REMOTE_MAX_OBJECTIVE_BYTES) {
        throw new Error("Invalid Pi structured output file");
      }
      this.#structuredOutput = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#structuredOutput = undefined;
      }
    }
  }
}

export class PiRpcDriver implements RemoteDriver {
  readonly id = "pi-rpc" as const;
  readonly #scratchRoot: string;
  readonly #cancelGraceMs: number;
  readonly #eventQueueBytes: number;
  readonly #spawnChild: SpawnChild;
  readonly #handles = new Map<string, PiRpcRunHandle>();

  constructor(options: PiRpcDriverOptions = {}) {
    this.#scratchRoot = path.resolve(options.scratchRoot ?? path.join(os.tmpdir(), "pi-teammate-remote"));
    this.#cancelGraceMs = options.cancelGraceMs ?? PI_RPC_CANCEL_GRACE_MS;
    this.#eventQueueBytes = options.eventQueueBytes ?? PI_RPC_EVENT_QUEUE_BYTES;
    if (!Number.isSafeInteger(this.#eventQueueBytes) || this.#eventQueueBytes < 1024) {
      throw new Error("Pi RPC event queue byte limit must be a safe integer of at least 1024");
    }
    this.#spawnChild = options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    ensurePrivateRemoteDirectory(this.#scratchRoot);
  }

  async start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle> {
    validateTrustedTarget(request, context);
    const runId = randomUUID();
    const capture: RemoteRunCapture = {
      workerId: context.workerId,
      instanceNonce: context.instanceNonce,
      runId,
      generation: 1,
      monitorOwnerNonce: request.monitorOwnerNonce,
      targetId: request.targetId,
    };
    const scratchDirectory = path.join(this.#scratchRoot, runId);
    ensurePrivateRemoteDirectory(scratchDirectory);
    const promptPath = path.join(scratchDirectory, "prompt.txt");
    const schemaPath = path.join(scratchDirectory, "schema.json");
    const outputPath = path.join(scratchDirectory, "output.json");
    writePrivateFile(promptPath, request.objective);
    if (request.outputSchema !== undefined) {
      writePrivateFile(schemaPath, `${JSON.stringify(request.outputSchema)}\n`);
    }
    const command = buildRpcArgv(context.target.command, request.name, request.outputSchema !== undefined);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawnChild(command.executable, command.args, {
        cwd: context.target.cwd,
        detached: true,
        env: targetChildEnvironment(context.target.env, request.outputSchema === undefined
          ? undefined
          : {
              PI_TEAMMATE_STRUCTURED_SCHEMA_PATH: schemaPath,
              PI_TEAMMATE_STRUCTURED_OUTPUT_PATH: outputPath,
            }),
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      fs.rmSync(scratchDirectory, { recursive: true, force: true });
      throw error;
    }
    const handle = new PiRpcRunHandle(
      capture,
      child,
      scratchDirectory,
      fs.readFileSync(promptPath, "utf8"),
      this.#cancelGraceMs,
      this.#eventQueueBytes,
    );
    this.#handles.set(runId, handle);
    void handle.whenClosed().finally(() => {
      if (this.#handles.get(runId) === handle) this.#handles.delete(runId);
    });
    if (context.signal.aborted) {
      void handle.cancel({
        commandId: `signal-${randomUUID()}`,
        runId,
        generation: capture.generation,
        monitorOwnerNonce: capture.monitorOwnerNonce,
        reason: "driver-context-aborted",
      });
    } else {
      context.signal.addEventListener("abort", () => {
        void handle.cancel({
          commandId: `signal-${randomUUID()}`,
          runId,
          generation: capture.generation,
          monitorOwnerNonce: capture.monitorOwnerNonce,
          reason: "driver-context-aborted",
        });
      }, { once: true });
    }
    return handle;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#handles.values()].map((handle) => handle.close()));
    this.#handles.clear();
  }
}

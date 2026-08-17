import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  type ActiveSession,
  type AnyMessage,
  type ClientConnection,
  type InitializeRequest,
  type InitializeResponse,
  type PromptResponse,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk";
import {
  captureProcessTree,
  redactRemoteError,
  sanitizedChildEnvironment,
  signalProcessTree,
  targetChildEnvironment,
  type ProcessTreeIdentity,
} from "./child-security.ts";
import { AcpClientOperations } from "./acp-client-operations.ts";
import type { RemoteDriver, RemoteDriverContext, RemoteRunHandle } from "./driver.ts";
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
import type {
  RemoteDriverEvent,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteToolEvent,
  RemoteUsage,
} from "./types.ts";

export const ACP_STDERR_LIMIT = 64 * 1024;
export const ACP_EVENT_TEXT_LIMIT = 512 * 1024;
export const ACP_RESULT_LIMIT = 512 * 1024;
export const ACP_CANCEL_GRACE_MS = 2_000;
export const ACP_STARTUP_TIMEOUT_MS = 15_000;
export const ACP_PENDING_INPUT_LIMIT = 64;
export const ACP_PENDING_INPUT_BYTES = 1024 * 1024;
export const ACP_EVENT_QUEUE_BYTES = 4 * 1024 * 1024;

type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface AcpDriverOptions {
  cancelGraceMs?: number;
  startupTimeoutMs?: number;
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function appendUtf8Tail(current: string, addition: string, maxBytes: number): string {
  const combined = current + addition;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  const buffer = Buffer.from(combined, "utf8");
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}

function appendUtf8Head(current: string, addition: string, maxBytes: number): string {
  const combined = current + addition;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return Buffer.from(combined, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

function boundedData(value: unknown, maxBytes = 64 * 1024): unknown {
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized, "utf8") <= maxBytes ? value : { truncated: true };
  } catch {
    return undefined;
  }
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
  if (request.outputSchema !== undefined) throw new Error("ACP does not support structured output");
  if (Buffer.byteLength(request.objective, "utf8") > REMOTE_MAX_OBJECTIVE_BYTES) {
    throw new Error("Remote objective exceeds the protocol limit");
  }
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: AnyMessage): Promise<void> {
  if (!child.stdin.writable) return Promise.reject(new Error("ACP subprocess stdin is not writable"));
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > REMOTE_MAX_LINE_BYTES) {
    return Promise.reject(new Error("ACP outbound record exceeds the remote protocol limit"));
  }
  return new Promise((resolve, reject) => {
    try {
      child.stdin.write(line, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

/** Strict NDJSON framing supplied directly to the stable SDK client connection. */
function boundedAcpStream(
  child: ChildProcessWithoutNullStreams,
  onFatal: (error: Error) => void,
): Stream {
  let buffer = Buffer.alloc(0);
  let settled = false;
  let paused = false;
  let controller: ReadableStreamDefaultController<AnyMessage>;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    child.stdout.pause();
    onFatal(error);
    try {
      controller.error(error);
    } catch (controllerError) {
      void controllerError;
    }
  };
  const pump = () => {
    while (!settled) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > REMOTE_MAX_LINE_BYTES) {
        fail(new Error("ACP stdout record exceeds the remote protocol limit"));
        return;
      }
      const record = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      const normalized = record.length > 0 && record[record.length - 1] === 0x0d
        ? record.subarray(0, -1)
        : record;
      if (normalized.length === 0) {
        fail(new Error("ACP stdout emitted an empty record"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(normalized.toString("utf8"));
      } catch (error) {
        void error;
        fail(new Error("ACP stdout emitted malformed JSON"));
        return;
      }
      if (!plainObject(message) || message.jsonrpc !== "2.0") {
        fail(new Error("ACP stdout emitted an invalid JSON-RPC message"));
        return;
      }
      controller.enqueue(message as AnyMessage);
      if ((controller.desiredSize ?? 0) <= 0) {
        paused = true;
        child.stdout.pause();
        return;
      }
    }
    if (buffer.length > REMOTE_MAX_LINE_BYTES) fail(new Error("ACP stdout record exceeds the remote protocol limit"));
  };
  const readable = new ReadableStream<AnyMessage>({
    start(nextController) {
      controller = nextController;
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        pump();
      });
      child.stdout.once("end", () => {
        if (settled) return;
        if (buffer.length > 0) {
          fail(new Error("ACP stdout ended with an incomplete NDJSON record"));
          return;
        }
        settled = true;
        nextController.close();
      });
      child.stdout.once("error", (error) => fail(error));
    },
    pull(nextController) {
      controller = nextController;
      pump();
      if (!settled && paused && (nextController.desiredSize ?? 0) > 0) {
        paused = false;
        child.stdout.resume();
      }
    },
    cancel() {
      settled = true;
      child.stdout.pause();
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write: (message) => writeMessage(child, message),
    close() { child.stdin.end(); },
    abort() { child.stdin.destroy(); },
  });
  // Writable streams can emit an error in addition to invoking the write
  // callback. Keep a permanent listener so a concurrent child exit cannot
  // surface EPIPE as an uncaught EventEmitter error.
  child.stdin.on("error", (error) => fail(error));
  return { readable, writable };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

class AcpRunHandle implements RemoteRunHandle {
  readonly capture: RemoteRunCapture;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #cancelGraceMs: number;
  readonly #startupTimeoutMs: number;
  readonly #eventQueueBytes: number;
  readonly #queue: AsyncEventQueue<RemoteRunEvent>;
  readonly #processTree: ProcessTreeIdentity | undefined;
  readonly #operationController = new AbortController();
  readonly #connection: ClientConnection;
  readonly #operations: AcpClientOperations;
  readonly #closePromise: Promise<void>;
  readonly #toolNames = new Map<string, string>();
  readonly #endedTools = new Set<string>();
  #resolveClosed!: () => void;
  #session?: ActiveSession;
  #snapshot: RemoteRunSnapshot;
  #sequence = 0;
  #stderr = "";
  #result = "";
  #terminal = false;
  #cancelRequested = false;
  #prompting = false;
  #shuttingDown = false;
  #promptAbort?: AbortController;
  #pendingInputs: string[] = [];
  #pendingInputBytes = 0;
  #terminationPromise?: Promise<void>;
  #cancelFallback?: NodeJS.Timeout;

  private constructor(
    capture: RemoteRunCapture,
    child: ChildProcessWithoutNullStreams,
    context: RemoteDriverContext,
    cancelGraceMs: number,
    startupTimeoutMs: number,
    eventQueueBytes: number,
  ) {
    this.capture = Object.freeze({ ...capture });
    this.#child = child;
    this.#cancelGraceMs = cancelGraceMs;
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#eventQueueBytes = eventQueueBytes;
    this.#processTree = captureProcessTree(child.pid);
    this.#queue = new AsyncEventQueue<RemoteRunEvent>(eventQueueBytes, serializedBytes, () => undefined);
    this.#snapshot = createRemoteRunSnapshot(capture, "connecting");
    this.#closePromise = new Promise((resolve) => { this.#resolveClosed = resolve; });
    this.#operations = new AcpClientOperations({
      targetRoot: context.target.cwd,
      policy: context.target.acp,
      signal: this.#operationController.signal,
      isCancelling: () => this.#cancelRequested || this.#terminal,
      sessionId: () => this.#session?.sessionId,
    });
    const app = client({ name: "pi-maestro-teammate-bridge" })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => (
        this.#operations.requestPermission(params, signal)
      ))
      .onRequest(methods.client.fs.readTextFile, ({ params, signal }) => (
        this.#operations.readTextFile(params, signal)
      ))
      .onRequest(methods.client.fs.writeTextFile, ({ params, signal }) => (
        this.#operations.writeTextFile(params, signal)
      ))
      .onRequest(methods.client.terminal.create, ({ params, signal }) => (
        this.#operations.createTerminal(params, signal)
      ))
      .onRequest(methods.client.terminal.output, ({ params }) => this.#operations.terminalOutput(params))
      .onRequest(methods.client.terminal.waitForExit, ({ params, signal }) => (
        this.#operations.waitForTerminalExit(params, signal)
      ))
      .onRequest(methods.client.terminal.kill, ({ params }) => this.#operations.killTerminal(params))
      .onRequest(methods.client.terminal.release, ({ params }) => this.#operations.releaseTerminal(params));
    this.#bindChild();
    this.#connection = app.connect(boundedAcpStream(child, (error) => this.#protocolFailure(error)));
  }

  static async create(
    capture: RemoteRunCapture,
    child: ChildProcessWithoutNullStreams,
    request: RemoteRunStartParams,
    context: RemoteDriverContext,
    cancelGraceMs: number,
    startupTimeoutMs: number,
    eventQueueBytes: number,
  ): Promise<AcpRunHandle> {
    const handle = new AcpRunHandle(capture, child, context, cancelGraceMs, startupTimeoutMs, eventQueueBytes);
    try {
      await handle.#initialize(request);
      return handle;
    } catch (error) {
      handle.#finish("failed", undefined, error instanceof Error ? error.message : String(error));
      handle.#shutdownProcess();
      await handle.#closePromise;
      throw error;
    }
  }

  snapshot(): RemoteRunSnapshot { return { ...this.#snapshot }; }
  events(): AsyncIterable<RemoteRunEvent> { return this.#queue; }
  whenClosed(): Promise<void> { return this.#closePromise; }

  async input(request: RemoteRunInputParams): Promise<RemoteRunInputResult> {
    this.#assertOwnership(request.runId, request.generation, request.monitorOwnerNonce);
    if (this.#terminal) throw new Error("Remote run is already terminal");
    if (this.#cancelRequested) throw new Error("Remote run cancellation is already in progress");
    if (request.mode === "steer") throw new Error("ACP driver does not support steer input");
    if (Buffer.byteLength(request.message, "utf8") > REMOTE_MAX_OBJECTIVE_BYTES) {
      throw new Error("Remote input exceeds the protocol limit");
    }
    const messageBytes = Buffer.byteLength(request.message, "utf8");
    if (this.#pendingInputs.length >= ACP_PENDING_INPUT_LIMIT
      || this.#pendingInputBytes + messageBytes > ACP_PENDING_INPUT_BYTES) {
      throw new Error("Remote ACP follow-up queue limit reached");
    }
    this.#pendingInputs.push(request.message);
    this.#pendingInputBytes += messageBytes;
    return { accepted: true, effectiveMode: "follow_up", receipt: "queued" };
  }

  async cancel(request: RemoteRunCancelParams): Promise<RemoteRunCancelResult> {
    this.#assertOwnership(request.runId, request.generation, request.monitorOwnerNonce);
    if (this.#terminal) return { accepted: false, status: this.#snapshot.status };
    if (!this.#cancelRequested) {
      this.#cancelRequested = true;
      this.#pendingInputs = [];
      this.#pendingInputBytes = 0;
      if (this.#session) {
        try {
          await this.#connection.agent.notify(methods.agent.session.cancel, { sessionId: this.#session.sessionId });
        } catch (error) {
          void error;
        }
      }
      this.#scheduleCancellationFallback();
    }
    return { accepted: true, status: this.#snapshot.status };
  }

  async close(): Promise<void> {
    if (!this.#terminal) {
      await this.cancel({
        commandId: `close-${randomUUID()}`,
        runId: this.capture.runId,
        generation: this.capture.generation,
        monitorOwnerNonce: this.capture.monitorOwnerNonce,
        reason: "driver-close",
      });
    }
    this.#shutdownProcess();
    await this.#closePromise;
  }

  async #initialize(request: RemoteRunStartParams): Promise<void> {
    const response = await withTimeout(this.#connection.agent.request<InitializeResponse, InitializeRequest>(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: this.#operations.capabilities,
      clientInfo: { name: "pi-maestro-teammate", version: "1" },
    }), this.#startupTimeoutMs, "ACP initialize");
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`ACP protocol version mismatch: expected ${PROTOCOL_VERSION}, received ${response.protocolVersion}`);
    }
    this.#session = await withTimeout(
      this.#connection.agent.buildSession(request.cwd).start(),
      this.#startupTimeoutMs,
      "ACP session/new",
    );
    this.#emitState("running", "session/prompt");
    void this.#promptLoop(request.objective);
  }

  async #promptLoop(initial: string): Promise<void> {
    let prompt: string | undefined = initial;
    while (prompt !== undefined && !this.#terminal && !this.#cancelRequested) {
      this.#prompting = true;
      this.#promptAbort = new AbortController();
      try {
        void this.#session!.prompt(prompt, { cancellationSignal: this.#promptAbort.signal }).catch((error) => {
          void error;
        });
        let response: PromptResponse;
        for (;;) {
          const message = await this.#session!.nextUpdate();
          if (message.kind === "session_update") {
            this.#routeNotification(message.notification.sessionId, message.update);
            continue;
          }
          response = message.response;
          break;
        }
        this.#emitPromptUsage(response);
        if (!this.#handleStop(response)) return;
      } catch (error) {
        if (this.#cancelRequested) this.#finish("cancelled", this.#result.trim() || undefined, undefined, "cancelled");
        else this.#finish("failed", undefined, `ACP session/prompt failed: ${error instanceof Error ? error.message : String(error)}`);
        this.#shutdownProcess();
        return;
      } finally {
        this.#prompting = false;
        this.#promptAbort = undefined;
      }
      prompt = this.#pendingInputs.shift();
      if (prompt !== undefined) {
        this.#pendingInputBytes -= Buffer.byteLength(prompt, "utf8");
        this.#emitState("running", "session/prompt");
      }
    }
    if (this.#cancelRequested && !this.#terminal) this.#finish("cancelled", this.#result.trim() || undefined, undefined, "cancelled");
    this.#shutdownProcess();
  }

  #handleStop(response: PromptResponse): boolean {
    const result = this.#result.trim() || undefined;
    switch (response.stopReason) {
      case "end_turn":
        if (this.#pendingInputs.length > 0) return true;
        this.#finish("completed", result, undefined, response.stopReason);
        this.#shutdownProcess();
        return false;
      case "cancelled":
        this.#finish("cancelled", result, undefined, response.stopReason);
        this.#shutdownProcess();
        return false;
      case "refusal":
        this.#finish("failed", result, "ACP agent refused the prompt", response.stopReason);
        this.#shutdownProcess();
        return false;
      case "max_tokens":
      case "max_turn_requests":
        this.#finish("completed", result, undefined, response.stopReason);
        this.#shutdownProcess();
        return false;
    }
  }

  #routeNotification(sessionId: string, update: SessionUpdate): void {
    if (this.#terminal || !this.#session || sessionId !== this.#session.sessionId) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          const text = appendUtf8Head("", update.content.text, ACP_EVENT_TEXT_LIMIT);
          this.#result = appendUtf8Head(this.#result, text, ACP_RESULT_LIMIT);
          if (text) this.#emitProgress({ type: "text", text });
        } else {
          this.#emitProgress({ type: "native", name: update.sessionUpdate, data: boundedData(update) });
        }
        return;
      case "tool_call": {
        const toolName = appendUtf8Head("", update.name ?? update.title, 4096) || "unknown";
        this.#toolNames.set(update.toolCallId, toolName);
        this.#emitTool({ toolCallId: update.toolCallId, toolName, phase: "start" });
        if (update.status === "completed" || update.status === "failed") {
          this.#emitTool({ toolCallId: update.toolCallId, toolName, phase: "end", ...(update.status === "failed" ? { isError: true } : {}) });
        }
        return;
      }
      case "tool_call_update": {
        const toolName = appendUtf8Head("", update.name ?? update.title ?? this.#toolNames.get(update.toolCallId) ?? "unknown", 4096);
        this.#toolNames.set(update.toolCallId, toolName);
        if (update.status === "completed" || update.status === "failed") {
          this.#emitTool({ toolCallId: update.toolCallId, toolName, phase: "end", ...(update.status === "failed" ? { isError: true } : {}) });
        }
        return;
      }
      case "usage_update": {
        if (update.cost?.currency === "USD" && Number.isFinite(update.cost.amount)) {
          this.#emitProgress({ type: "usage", usage: { costUsd: update.cost.amount } });
        }
        this.#emitProgress({
          type: "native",
          name: update.sessionUpdate,
          data: boundedData({ used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) }),
        });
        return;
      }
      default:
        this.#emitProgress({ type: "native", name: update.sessionUpdate, data: boundedData(update) });
    }
  }

  #emitPromptUsage(response: PromptResponse): void {
    const value = response.usage;
    if (!value) return;
    const usage: RemoteUsage = {};
    if (Number.isFinite(value.inputTokens)) usage.inputTokens = value.inputTokens;
    if (Number.isFinite(value.outputTokens)) usage.outputTokens = value.outputTokens;
    if (Number.isFinite(value.totalTokens)) usage.totalTokens = value.totalTokens;
    if (Object.keys(usage).length > 0) this.#emitProgress({ type: "usage", usage });
  }

  #emitTool(tool: RemoteToolEvent): void {
    if (tool.phase === "end") {
      if (this.#endedTools.has(tool.toolCallId)) return;
      this.#endedTools.add(tool.toolCallId);
    }
    this.#emitProgress({ type: "tool", tool });
  }

  #bindChild(): void {
    const decoder = new StringDecoder("utf8");
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = appendUtf8Tail(this.#stderr, decoder.write(chunk), ACP_STDERR_LIMIT);
    });
    this.#child.once("error", (error) => this.#finish("failed", undefined, `ACP process error: ${redactRemoteError(error)}`));
    this.#child.once("close", (code, signal) => {
      this.#stderr = appendUtf8Tail(this.#stderr, decoder.end(), ACP_STDERR_LIMIT);
      if (!this.#terminal) {
        if (this.#cancelRequested) this.#finish("cancelled", this.#result.trim() || undefined, undefined, signal ?? "cancelled");
        else {
          const stderrBytes = Buffer.byteLength(this.#stderr, "utf8");
          this.#finish(
            "failed",
            undefined,
            `ACP process exited before completion with code ${code ?? "null"} and signal ${signal ?? "none"}${stderrBytes > 0 ? ` (captured ${stderrBytes} stderr bytes)` : ""}`,
          );
        }
      }
      this.#operations.close();
      this.#scheduleTreeTermination();
      void (this.#terminationPromise ?? Promise.resolve()).finally(() => this.#resolveClosed());
    });
  }

  #protocolFailure(error: Error): void {
    if (this.#shuttingDown || this.#cancelRequested || this.#terminal) return;
    this.#finish("failed", undefined, redactRemoteError(error));
    this.#signalTree("SIGKILL");
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
            `ACP process-tree termination failed: ${redactRemoteError(treeError)}; leader fallback failed: ${redactRemoteError(leaderError)}`,
          );
        }
      }
    }
  }

  #scheduleCancellationFallback(): void {
    if (this.#cancelFallback || this.#terminal || this.#shuttingDown) return;
    this.#cancelFallback = setTimeout(() => {
      this.#cancelFallback = undefined;
      if (this.#terminal || this.#shuttingDown) return;
      this.#promptAbort?.abort();
      this.#shutdownProcess();
    }, this.#cancelGraceMs);
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

  #shutdownProcess(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    if (this.#cancelFallback) {
      clearTimeout(this.#cancelFallback);
      this.#cancelFallback = undefined;
    }
    this.#session?.dispose();
    this.#operations.close();
    this.#operationController.abort();
    try {
      this.#connection.close();
    } catch (error) {
      void error;
    }
    try {
      this.#child.stdin.end();
    } catch (error) {
      void error;
    }
    this.#scheduleTreeTermination();
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
    if (this.#cancelFallback) {
      clearTimeout(this.#cancelFallback);
      this.#cancelFallback = undefined;
    }
    this.#publish({
      type: "run/result",
      ...this.capture,
      sequence: ++this.#sequence,
      status,
      updatedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error: redactRemoteError(error, { maximumBytes: 4096 }) }),
      ...(nativeStatus === undefined ? {} : { nativeStatus }),
    });
    this.#queue.close();
  }

  #publish(event: RemoteRunEvent): void {
    if (this.#queue.push(event)) {
      this.#snapshot = applyRemoteRunEvent(this.#snapshot, event);
      return;
    }
    const overflow: RemoteRunEvent = {
      type: "run/result",
      ...this.capture,
      sequence: event.sequence,
      status: "failed",
      updatedAt: Date.now(),
      error: "Remote ACP event queue byte limit exceeded",
    };
    this.#terminal = true;
    this.#snapshot = applyRemoteRunEvent(this.#snapshot, overflow);
    this.#queue.replaceAndClose(overflow);
    this.#scheduleTreeTermination();
  }

  #assertOwnership(runId: string, generation: number, monitorOwnerNonce: string): void {
    if (runId !== this.capture.runId
      || generation !== this.capture.generation
      || monitorOwnerNonce !== this.capture.monitorOwnerNonce) {
      throw new Error("Remote run ownership capture mismatch");
    }
  }
}

export class AcpDriver implements RemoteDriver {
  readonly id = "acp" as const;
  readonly #cancelGraceMs: number;
  readonly #startupTimeoutMs: number;
  readonly #eventQueueBytes: number;
  readonly #spawnChild: SpawnChild;
  readonly #handles = new Map<string, AcpRunHandle>();

  constructor(options: AcpDriverOptions = {}) {
    this.#cancelGraceMs = options.cancelGraceMs ?? ACP_CANCEL_GRACE_MS;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? ACP_STARTUP_TIMEOUT_MS;
    this.#eventQueueBytes = options.eventQueueBytes ?? ACP_EVENT_QUEUE_BYTES;
    if (!Number.isSafeInteger(this.#eventQueueBytes) || this.#eventQueueBytes < 1024) {
      throw new Error("ACP event queue byte limit must be a safe integer of at least 1024");
    }
    this.#spawnChild = options.spawnChild ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  }

  async start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle> {
    validateTrustedTarget(request, context);
    const capture: RemoteRunCapture = {
      workerId: context.workerId,
      instanceNonce: context.instanceNonce,
      runId: randomUUID(),
      generation: 1,
      monitorOwnerNonce: request.monitorOwnerNonce,
      targetId: request.targetId,
    };
    const child = this.#spawnChild(context.target.command[0], context.target.command.slice(1), {
      cwd: context.target.cwd,
      detached: true,
      env: targetChildEnvironment(context.target.env),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const handle = await AcpRunHandle.create(
      capture,
      child,
      request,
      context,
      this.#cancelGraceMs,
      this.#startupTimeoutMs,
      this.#eventQueueBytes,
    );
    this.#handles.set(capture.runId, handle);
    void handle.whenClosed().finally(() => {
      if (this.#handles.get(capture.runId) === handle) this.#handles.delete(capture.runId);
    });
    const cancel = () => void handle.cancel({
      commandId: `signal-${randomUUID()}`,
      runId: capture.runId,
      generation: capture.generation,
      monitorOwnerNonce: capture.monitorOwnerNonce,
      reason: "driver-context-aborted",
    });
    if (context.signal.aborted) cancel();
    else context.signal.addEventListener("abort", cancel, { once: true });
    return handle;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#handles.values()].map((handle) => handle.close()));
    this.#handles.clear();
  }
}

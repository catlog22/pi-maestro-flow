/** Gateway-owned asynchronous teammate task registry. */
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import type {
  RpcMessageMode,
  RunTeammateOptions,
  RunTeammateParams,
} from "pi-maestro-teammate/v1/execution";
import type { AgentProgress, SingleResult } from "pi-maestro-teammate/v1/types";
import {
  GATEWAY_HARD_LIMITS,
  GATEWAY_STATE_VERSION,
  type GatewayPrincipal,
  type GatewayResult,
  type GatewayTask,
  type GatewayTaskState,
} from "../contracts.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { GatewayEventJournal } from "../event-journal.ts";
import { GatewayPolicy, type GatewayPolicyOperation } from "../policy.ts";
import { principalKey } from "../principal.ts";
import { parseGatewayPrincipal } from "../validation.ts";
import { canonicalizeWorkspacePath, workspaceIdForPath } from "../state-paths.ts";
import {
  TaskJournal,
  type GatewayTaskJournalRecord,
  type TaskJournalOptions,
} from "../task-journal.ts";

export type GatewayTeammateSendMode = "steer" | "follow_up" | "interrupt";
export type GatewayTeammateAction = "start" | "list" | "observe" | "wait" | "send" | "cancel" | "result";

export interface GatewayTeammateControl {
  stdin?: Writable;
  /** Child IPC sender retained for hosts that need low-level control messages. */
  sendControl?: (message: Record<string, unknown>) => boolean;
  correlationId?: string;
  generation?: number;
}

/**
 * Host seam for an already-running Pi teammate runtime. A Gateway host injects
 * this port; the default adapter only calls the public v1 execution functions
 * and never constructs a second RemoteWorkerManager.
 */
export interface GatewayTeammatePort {
  runTeammate(params: RunTeammateParams, options: RunTeammateOptions): Promise<SingleResult[]>;
  send?(control: GatewayTeammateControl, message: string, mode: GatewayTeammateSendMode): boolean | Promise<boolean>;
  /** Narrow alternative useful to hosts that expose the public sender directly. */
  sendRpcMessage?(stdin: Writable, message: string, mode: RpcMessageMode): boolean | Promise<boolean>;
}

async function sendPublicRpcMessage(stdin: Writable, message: string, mode: RpcMessageMode): Promise<boolean> {
  const { sendRpcMessage } = await import("pi-maestro-teammate/v1/execution");
  return sendRpcMessage(stdin, message, mode);
}

export function createGatewayTeammatePort(): GatewayTeammatePort {
  return {
    async runTeammate(params, options) {
      const { runTeammate } = await import("pi-maestro-teammate/v1/execution");
      return runTeammate(params, options);
    },
    async send(control, message, mode) {
      if (!control.stdin) return false;
      return sendPublicRpcMessage(control.stdin, message, mode);
    },
  };
}

export interface GatewayTeammateServiceOptions {
  port?: GatewayTeammatePort;
  journal?: TaskJournal;
  journalPath?: string;
  journalOptions?: TaskJournalOptions;
  eventJournal?: GatewayEventJournal;
  /** Base directory used when a request omits cwd. */
  baseCwd?: string;
  policy?: GatewayPolicy;
  workspaceRoot?: string;
  maxEvents?: number;
  maxEventBytes?: number;
  maxResultItems?: number;
  maxResultBytes?: number;
  maxPageItems?: number;
  taskRetentionMs?: number;
  resultRetentionMs?: number;
  now?: () => number;
}

export interface GatewayTeammateStartInput {
  /** Public v1 params. */
  params?: RunTeammateParams;
  tasks?: RunTeammateParams["tasks"];
  /** Convenience single-task aliases for Gateway callers. */
  prompt?: string;
  objective?: string;
  task?: string;
  agent?: string;
  cwd?: string;
  workspace?: string;
  workspacePath?: string;
  workspaceId?: string;
  requestId?: string;
  /** Runtime-only options are never journaled. */
  options?: Partial<RunTeammateOptions>;
  runOptions?: Partial<RunTeammateOptions>;
  /** Durable collaboration binding, supplied only by SessionService. */
  gatewaySessionId?: string;
  gatewayMemberId?: string;
  [key: string]: unknown;
}

export interface GatewayTeammateListInput {
  cursor?: number | string;
  limit?: number;
  requestId?: string;
}

export interface GatewayTeammateObserveInput {
  taskId?: string;
  cursor?: number | string;
  afterCursor?: number | string;
  limit?: number;
  requestId?: string;
}

export interface GatewayTeammateWaitInput {
  taskId?: string;
  timeoutMs?: number;
  requestId?: string;
  signal?: AbortSignal;
}

export interface GatewayTeammateSendInput {
  taskId?: string;
  taskCorrelationId?: string;
  message: string;
  mode?: GatewayTeammateSendMode;
  requestId?: string;
}

export interface GatewayTeammateCancelInput {
  taskId?: string;
  reason?: string;
  requestId?: string;
}

export interface GatewayTeammateResultInput {
  taskId?: string;
  cursor?: number | string;
  afterCursor?: number | string;
  limit?: number;
  requestId?: string;
}

export interface GatewayTaskEvent {
  cursor: number;
  taskId: string;
  type: "state" | "progress" | "child" | "published" | "complete" | "send" | "cancel" | "error";
  at: number;
  data?: unknown;
}

export interface GatewayTaskEventPage {
  events: GatewayTaskEvent[];
  items: GatewayTaskEvent[];
  oldestCursor: number;
  nextCursor: number;
  hasMore: boolean;
  gap: boolean;
}

export interface GatewayTaskResultItem {
  cursor: number;
  correlationId: string;
  agent: string;
  name?: string;
  status: "completed" | "failed" | "cancelled";
  exitCode: number;
  model: string;
  durationMs: number;
  publicationId?: string;
  output?: string;
  messages?: Array<{ role: string; content: string }>;
  structuredOutput?: unknown;
  error?: string;
}

export interface GatewayTaskResultPage {
  taskId: string;
  status: GatewayTaskState;
  publicationId?: string;
  results: GatewayTaskResultItem[];
  items: GatewayTaskResultItem[];
  nextCursor: number;
  oldestCursor: number;
  hasMore: boolean;
  done: boolean;
}

export interface GatewayTeammateTaskView extends GatewayTask {
  workspaceId: string;
  eventCursor: number;
  resultCount: number;
  publicationId?: string;
}

export interface GatewayTeammateStartData {
  taskId: string;
  task: GatewayTeammateTaskView;
}

export interface GatewayTeammateListData {
  tasks: GatewayTeammateTaskView[];
  nextCursor: number;
}

export interface GatewayTeammateObserveData {
  task: GatewayTeammateTaskView;
  events: GatewayTaskEvent[];
  items: GatewayTaskEvent[];
  nextCursor: number;
  gap: boolean;
}

export interface GatewayTeammateWaitData {
  task: GatewayTeammateTaskView;
  done: boolean;
}

export interface GatewayTeammateSendData {
  taskId: string;
  delivered: boolean;
  mode: GatewayTeammateSendMode;
  taskCorrelationId?: string;
}

export interface GatewayTeammateCancelData {
  taskId: string;
  cancelled: boolean;
  alreadyTerminal?: boolean;
  task: GatewayTeammateTaskView;
}

export interface GatewayTeammateRequest {
  action: GatewayTeammateAction;
  [key: string]: unknown;
}

interface TaskEntry {
  id: string;
  principalId: string;
  workspaceId: string;
  sessionId?: string;
  memberId?: string;
  workspacePath: string;
  objective: string;
  cwd: string;
  params?: RunTeammateParams;
  runOptions?: Partial<RunTeammateOptions>;
  status: GatewayTaskState;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  publicationId?: string;
  controller: AbortController;
  controls: Map<string, GatewayTeammateControl>;
  progress: Map<string, AgentProgress>;
  events: GatewayTeammateEventBuffer;
  results: GatewayTaskResultItem[];
  cancelledRequested: boolean;
  releaseConcurrency?: () => void;
  completion?: Promise<void>;
  waiters: Set<() => void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function utf8Tail(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximum) return value;
  let start = bytes.byteLength - maximum;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function boundedValue(value: unknown, maximum: number, depth = 0): unknown {
  if (maximum <= 0) return undefined;
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return utf8Tail(value, maximum);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let bytes = 2;
    for (const item of value.slice(0, 64)) {
      const next = boundedValue(item, Math.max(1, maximum - bytes), depth + 1);
      const nextBytes = Buffer.byteLength(JSON.stringify(next) ?? "null", "utf8") + (result.length ? 1 : 0);
      if (bytes + nextBytes > maximum) break;
      result.push(next);
      bytes += nextBytes;
    }
    return result;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    let bytes = 2;
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      const next = boundedValue(item, Math.max(1, maximum - bytes), depth + 1);
      const nextBytes = Buffer.byteLength(JSON.stringify({ [key]: next }) ?? "{}", "utf8") + (Object.keys(result).length ? 1 : 0);
      if (bytes + nextBytes > maximum) break;
      result[key] = next;
      bytes += nextBytes;
    }
    return result;
  }
  return String(value).slice(0, maximum);
}

function boundedText(value: unknown, maximum = 8 * 1024): string | undefined {
  return typeof value === "string" ? utf8Tail(value, maximum) : undefined;
}

function positiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1 || (candidate as number) > maximum) {
    throw new Error(`${label} must be an integer in [1, ${maximum}]`);
  }
  return candidate as number;
}

function cursorValue(value: unknown, label = "cursor"): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function requestId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return requestId((value as Record<string, unknown>).requestId);
  return typeof value === "string" && value.trim() ? utf8Tail(value.trim(), 256) : undefined;
}

function taskIdValue(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("taskId must be a non-empty string");
  return value.trim();
}

function principalValue(value: unknown): GatewayPrincipal {
  return parseGatewayPrincipal(value);
}

function terminalStatus(status: GatewayTaskState): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "lost";
}

function operationResult<T>(
  data: T,
  principal: GatewayPrincipal,
  request: unknown,
  status: "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "lost" = "succeeded",
): GatewayResult<T> {
  return gatewayOk(data, { requestId: requestId(request) ?? randomUUID(), principalId: principalKey(principal), status });
}

function operationError<T = never>(
  code: string,
  message: string,
  principal: GatewayPrincipal,
  request: unknown,
  status: "failed" | "cancelled" | "lost" = "failed",
  data?: T,
): GatewayResult<T> {
  const base = gatewayError<T>({ code, message, retryable: false }, {
    requestId: requestId(request) ?? randomUUID(),
    principalId: principalKey(principal),
    status,
  });
  return data === undefined ? base : { ...base, data };
}

/** Small bounded cursor buffer used by each task. */
export class GatewayTeammateEventBuffer {
  readonly maxEvents: number;
  readonly maxBytes: number;
  private next = 1;
  private evictedThrough = 0;
  private readonly values: GatewayTaskEvent[] = [];
  private bytes = 0;

  constructor(maxEvents = 128, maxBytes = 256 * 1024) {
    this.maxEvents = positiveInteger(maxEvents, "maxEvents", 128, GATEWAY_HARD_LIMITS.maxTasks * 16);
    this.maxBytes = positiveInteger(maxBytes, "maxEventBytes", 256 * 1024, GATEWAY_HARD_LIMITS.maxOutputBytes);
  }

  append(input: Omit<GatewayTaskEvent, "cursor">): GatewayTaskEvent {
    const event = {
      ...input,
      cursor: this.next++,
      ...(input.data === undefined ? {} : { data: boundedValue(input.data, Math.max(1, this.maxBytes / 2)) }),
    } as GatewayTaskEvent;
    const encodedBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (encodedBytes > this.maxBytes) {
      event.data = boundedValue(event.data, Math.max(1, this.maxBytes - 256));
    }
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.values.push(event);
    this.bytes += size;
    while (this.values.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.values.shift();
      if (!removed) break;
      this.evictedThrough = removed.cursor;
      this.bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    }
    return clone(event);
  }

  page(afterCursor = 0, limit = this.maxEvents): GatewayTaskEventPage {
    const gap = afterCursor < this.evictedThrough;
    const eligible = this.values.filter((event) => event.cursor > afterCursor);
    const values = eligible.slice(0, limit).map(clone);
    const nextCursor = values.at(-1)?.cursor ?? afterCursor;
    return { events: values, items: values.map(clone), oldestCursor: this.values[0]?.cursor ?? this.next, nextCursor, hasMore: eligible.length > values.length, gap };
  }

  restore(events: readonly GatewayTaskEvent[]): void {
    let previous = 0;
    for (const raw of events) {
      if (!Number.isSafeInteger(raw.cursor) || raw.cursor <= previous) throw new Error("Persisted Monitor cursors are not strictly increasing");
      const event = clone(raw); const size = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (size > this.maxBytes) throw new Error("Persisted Monitor event exceeds the buffer bound");
      this.values.push(event); this.bytes += size; previous = event.cursor;
    }
    if (this.values.length) { this.evictedThrough = this.values[0]!.cursor - 1; this.next = this.values.at(-1)!.cursor + 1; }
    while (this.values.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.values.shift(); if (!removed) break; this.evictedThrough = removed.cursor; this.bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    }
  }

  latestCursor(): number {
    return this.next - 1;
  }
}

export class GatewayTeammateService {
  readonly port: GatewayTeammatePort;
  readonly journal: TaskJournal;
  readonly eventJournal: GatewayEventJournal;
  readonly policy?: GatewayPolicy;
  readonly baseCwd: string;
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;
  private readonly maxResultItems: number;
  private readonly maxResultBytes: number;
  private readonly maxPageItems: number;
  private readonly taskRetentionMs?: number;
  private readonly resultRetentionMs?: number;
  private readonly entries = new Map<string, TaskEntry>();
  private readyPromise?: Promise<void>;

  constructor(options: GatewayTeammateServiceOptions = {}) {
    this.port = options.port ?? createGatewayTeammatePort();
    this.baseCwd = canonicalizeWorkspacePath(options.baseCwd ?? options.workspaceRoot ?? process.cwd());
    this.policy = options.policy;
    this.now = options.now ?? (() => Date.now());
    this.taskRetentionMs = options.taskRetentionMs;
    this.resultRetentionMs = options.resultRetentionMs;
    for (const [label, value] of [["taskRetentionMs", this.taskRetentionMs], ["resultRetentionMs", this.resultRetentionMs]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${label} must be a positive safe integer`);
    }
    this.journal = options.journal ?? new TaskJournal({
      ...(options.journalOptions ?? {}),
      ...(options.journalPath === undefined ? { cwd: this.baseCwd } : { path: options.journalPath }),
      terminalRetentionMs: options.journalOptions?.terminalRetentionMs ?? this.taskRetentionMs,
      now: options.journalOptions?.now ?? this.now,
    });
    this.eventJournal = options.eventJournal ?? new GatewayEventJournal();
    this.maxEvents = positiveInteger(options.maxEvents, "maxEvents", 128, GATEWAY_HARD_LIMITS.maxTasks * 16);
    this.maxEventBytes = positiveInteger(options.maxEventBytes, "maxEventBytes", 256 * 1024, GATEWAY_HARD_LIMITS.maxOutputBytes);
    this.maxResultItems = positiveInteger(options.maxResultItems, "maxResultItems", GATEWAY_HARD_LIMITS.maxTasks, GATEWAY_HARD_LIMITS.maxTasks);
    this.maxResultBytes = positiveInteger(options.maxResultBytes, "maxResultBytes", 256 * 1024, GATEWAY_HARD_LIMITS.maxOutputBytes);
    this.maxPageItems = positiveInteger(options.maxPageItems, "maxPageItems", 64, GATEWAY_HARD_LIMITS.maxTasks);
  }

  async start(principalInput: GatewayPrincipal, input: GatewayTeammateStartInput | RunTeammateParams): Promise<GatewayResult<GatewayTeammateStartData>> {
    const principal = principalValue(principalInput);
    const startedAt = this.now();
    try {
      await this.ready();
      await this.pruneExpired();
      const request = this.normalizeStartInput(input);
      const params = request.params;
      const resolvedWorkspace = await this.resolveWorkspace(request, params, principal);
      const workspacePath = resolvedWorkspace.path;
      const workspaceId = resolvedWorkspace.id;
      await this.authorize(principal, workspacePath, "task");
      const releaseConcurrency = this.policy?.tryAcquire("task");
      if (this.policy && !releaseConcurrency) throw new Error("task concurrency limit reached");
      const id = randomUUID();
      const objective = utf8Tail(request.objective ?? params.tasks[0]?.prompt ?? "teammate task", 64 * 1024);
      const entry: TaskEntry = {
        id,
        principalId: principalKey(principal),
        workspaceId,
        workspacePath,
        ...(request.gatewaySessionId === undefined ? {} : { sessionId: request.gatewaySessionId }),
        ...(request.gatewayMemberId === undefined ? {} : { memberId: request.gatewayMemberId }),
        objective,
        cwd: workspacePath,
        params,
        runOptions: request.runOptions,
        status: "queued",
        createdAt: startedAt,
        updatedAt: startedAt,
        controller: new AbortController(),
        controls: new Map(),
        progress: new Map(),
        events: new GatewayTeammateEventBuffer(this.maxEvents, this.maxEventBytes),
        results: [],
        cancelledRequested: false,
        releaseConcurrency,
        waiters: new Set(),
      };
      this.entries.set(id, entry);
      try {
        await this.persist(entry);
      } catch (error) {
        this.entries.delete(id);
        releaseConcurrency?.();
        throw error;
      }
      this.appendEvent(entry, "state", { status: "queued" });
      // Deliberately detached: acceptance does not wait for the model process.
      entry.completion = this.runEntry(entry, principal);
      void entry.completion;
      return operationResult({ taskId: id, task: this.view(entry) }, principal, request, "accepted");
    } catch (error) {
      return operationError("task_start_failed", errorMessage(error), principal, input);
    }
  }

  async list(principalInput: GatewayPrincipal, input: GatewayTeammateListInput = {}): Promise<GatewayResult<GatewayTeammateListData>> {
    const principal = principalValue(principalInput);
    try {
      await this.ready();
      await this.pruneExpired();
      const after = cursorValue(input.cursor);
      const limit = positiveInteger(input.limit, "limit", this.maxPageItems, this.maxPageItems);
      const tasks = [...this.entries.values()]
        .filter((entry) => this.owns(entry, principal))
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(after, after + limit)
        .map((entry) => this.view(entry));
      const nextCursor = after + tasks.length;
      return operationResult({ tasks, nextCursor }, principal, input);
    } catch (error) {
      return operationError("task_list_failed", errorMessage(error), principal, input);
    }
  }

  async observe(principalInput: GatewayPrincipal, taskOrInput: string | GatewayTeammateObserveInput, input: GatewayTeammateObserveInput = {}): Promise<GatewayResult<GatewayTeammateObserveData>> {
    const principal = principalValue(principalInput);
    const request = typeof taskOrInput === "string" ? { ...input, taskId: taskOrInput } : taskOrInput;
    try {
      await this.ready();
      await this.pruneExpired();
      const entry = this.findOwned(request.taskId, principal);
      if (!entry) return operationError("task_not_found", "Gateway task was not found", principal, request);
      const after = cursorValue(request.afterCursor ?? request.cursor);
      const limit = positiveInteger(request.limit, "limit", this.maxPageItems, this.maxPageItems);
      const page = entry.events.page(after, limit);
      const data = { task: this.view(entry), ...page };
      return operationResult(data, principal, request);
    } catch (error) {
      return operationError("task_observe_failed", errorMessage(error), principal, request);
    }
  }

  async wait(principalInput: GatewayPrincipal, taskOrInput: string | GatewayTeammateWaitInput, input: GatewayTeammateWaitInput = {}): Promise<GatewayResult<GatewayTeammateWaitData>> {
    const principal = principalValue(principalInput);
    const request = typeof taskOrInput === "string" ? { ...input, taskId: taskOrInput } : taskOrInput;
    try {
      await this.ready();
      await this.pruneExpired();
      const entry = this.findOwned(request.taskId, principal);
      if (!entry) return operationError("task_not_found", "Gateway task was not found", principal, request);
      const done = terminalStatus(entry.status) || await this.waitForEntry(entry, request.timeoutMs, request.signal);
      // A terminal in-memory state is visible slightly before its durable
      // journal write completes; wait for that write before reporting done.
      if (done) await entry.completion;
      return operationResult({ task: this.view(entry), done }, principal, request);
    } catch (error) {
      return operationError("task_wait_failed", errorMessage(error), principal, request);
    }
  }

  async send(
    principalInput: GatewayPrincipal,
    taskOrInput: string | GatewayTeammateSendInput,
    messageOrMode?: string | GatewayTeammateSendMode | Omit<GatewayTeammateSendInput, "taskId">,
    modeInput?: GatewayTeammateSendMode,
  ): Promise<GatewayResult<GatewayTeammateSendData>> {
    const principal = principalValue(principalInput);
    const request: GatewayTeammateSendInput = typeof taskOrInput === "string"
      ? messageOrMode && typeof messageOrMode === "object"
        ? { ...messageOrMode, taskId: taskOrInput }
        : { taskId: taskOrInput, message: typeof messageOrMode === "string" && !isSendMode(messageOrMode) ? messageOrMode : "", ...(typeof messageOrMode === "string" && isSendMode(messageOrMode) ? { mode: messageOrMode } : modeInput === undefined ? {} : { mode: modeInput }) }
      : taskOrInput;
    try {
      await this.ready();
      await this.pruneExpired();
      const entry = this.findOwned(request.taskId, principal);
      if (!entry) return operationError("task_not_found", "Gateway task was not found", principal, request);
      if (terminalStatus(entry.status)) return operationError("task_not_running", "Gateway task is already terminal", principal, request);
      if (typeof request.message !== "string" || request.message.trim() === "") return operationError("invalid_message", "message must be non-empty", principal, request);
      const mode = request.mode ?? "follow_up";
      if (!isSendMode(mode)) return operationError("invalid_message_mode", "mode must be steer, follow_up, or interrupt", principal, request);
      const control = this.selectControl(entry, request.taskCorrelationId);
      if (!control) return operationError("task_not_running", "Gateway task has no live child control", principal, request);
      const delivered = await this.sendControl(control, request.message, mode);
      this.appendEvent(entry, "send", { mode, delivered, taskCorrelationId: control.correlationId });
      if (!delivered) return operationError("send_failed", "Gateway teammate child rejected the message", principal, request);
      return operationResult({ taskId: entry.id, delivered: true, mode, ...(control.correlationId === undefined ? {} : { taskCorrelationId: control.correlationId }) }, principal, request);
    } catch (error) {
      return operationError("task_send_failed", errorMessage(error), principal, request);
    }
  }

  async cancel(principalInput: GatewayPrincipal, taskOrInput: string | GatewayTeammateCancelInput, reasonInput?: string): Promise<GatewayResult<GatewayTeammateCancelData>> {
    const principal = principalValue(principalInput);
    const request: GatewayTeammateCancelInput = typeof taskOrInput === "string" ? { taskId: taskOrInput, ...(reasonInput === undefined ? {} : { reason: reasonInput }) } : taskOrInput;
    try {
      await this.ready();
      await this.pruneExpired();
      const entry = this.findOwned(request.taskId, principal);
      if (!entry) return operationError("task_not_found", "Gateway task was not found", principal, request);
      if (terminalStatus(entry.status)) {
        return operationResult({ taskId: entry.id, cancelled: entry.status === "cancelled", alreadyTerminal: true, task: this.view(entry) }, principal, request);
      }
      entry.cancelledRequested = true;
      const reason = boundedText(request.reason, 512) ?? "Cancelled by Gateway caller";
      entry.error = reason;
      entry.controller.abort(reason);
      this.setStatus(entry, "cancelled", reason);
      const controls = [...entry.controls.values()];
      for (const control of controls) {
        try {
          const sent = await this.sendControl(control, "", "interrupt", true);
          if (!sent) control.sendControl?.({ type: "abort" });
        } catch {
          control.sendControl?.({ type: "abort" });
        }
      }
      this.appendEvent(entry, "cancel", { reason });
      await this.persist(entry);
      this.notifyWaiters(entry);
      return operationResult({ taskId: entry.id, cancelled: true, task: this.view(entry) }, principal, request);
    } catch (error) {
      return operationError("task_cancel_failed", errorMessage(error), principal, request);
    }
  }

  async result(principalInput: GatewayPrincipal, taskOrInput: string | GatewayTeammateResultInput, input: GatewayTeammateResultInput = {}): Promise<GatewayResult<GatewayTaskResultPage>> {
    const principal = principalValue(principalInput);
    const request = typeof taskOrInput === "string" ? { ...input, taskId: taskOrInput } : taskOrInput;
    try {
      await this.ready();
      await this.pruneExpired();
      const entry = this.findOwned(request.taskId, principal);
      if (!entry) return operationError("task_not_found", "Gateway task was not found", principal, request);
      const after = cursorValue(request.afterCursor ?? request.cursor);
      const limit = positiveInteger(request.limit, "limit", this.maxPageItems, this.maxPageItems);
      const values = entry.results.filter((item) => item.cursor > after).slice(0, limit).map(clone);
      const page: GatewayTaskResultPage = {
        taskId: entry.id,
        status: entry.status,
        ...(entry.publicationId === undefined ? {} : { publicationId: entry.publicationId }),
        results: values,
        items: values.map(clone),
        nextCursor: values.at(-1)?.cursor ?? after,
        oldestCursor: entry.results[0]?.cursor ?? entry.results.length + 1,
        hasMore: entry.results.some((item) => item.cursor > (values.at(-1)?.cursor ?? after)),
        done: terminalStatus(entry.status) && (values.at(-1)?.cursor ?? after) >= entry.results.length,
      };
      return operationResult(page, principal, request);
    } catch (error) {
      return operationError("task_result_failed", errorMessage(error), principal, request);
    }
  }

  /** Session-scoped Monitor facade. Authorization is performed by MonitorService before entry. */
  async monitorList(sessionId: string): Promise<GatewayTeammateTaskView[]> {
    await this.ready(); await this.pruneExpired();
    return [...this.entries.values()].filter((entry) => entry.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt).map((entry) => this.view(entry));
  }
  async monitorObserve(sessionId: string, taskId: string, afterCursor = 0, limit = this.maxPageItems): Promise<GatewayTeammateObserveData> {
    await this.ready(); await this.pruneExpired(); const entry = this.findSessionEntry(sessionId, taskId); return { task: this.view(entry), ...entry.events.page(afterCursor, limit) };
  }
  async monitorWait(sessionId: string, taskId: string, timeoutMs?: number): Promise<GatewayTeammateWaitData> {
    await this.ready(); const entry = this.findSessionEntry(sessionId, taskId); const done = terminalStatus(entry.status) || await this.waitForEntry(entry, timeoutMs); if (done) await entry.completion; return { task: this.view(entry), done };
  }
  async monitorMessage(sessionId: string, taskId: string, message: string, mode: GatewayTeammateSendMode): Promise<boolean> {
    await this.ready(); const entry = this.findSessionEntry(sessionId, taskId); if (terminalStatus(entry.status)) throw new Error("Gateway task is already terminal");
    const control = this.selectControl(entry); if (!control) throw new Error("Gateway task has no live child control");
    const delivered = await this.sendControl(control, message, mode);
    // Retain only delivery metadata; control text never enters task evidence.
    this.appendEvent(entry, "send", { mode, delivered });
    return delivered;
  }
  async monitorCancel(sessionId: string, taskId: string, reason = "Cancelled by Monitor caller"): Promise<GatewayTeammateTaskView> {
    await this.ready(); const entry = this.findSessionEntry(sessionId, taskId); if (!terminalStatus(entry.status)) {
      entry.cancelledRequested = true; entry.error = utf8Tail(reason, 512); entry.controller.abort(entry.error); this.setStatus(entry, "cancelled", entry.error); this.appendEvent(entry, "cancel", { reason: entry.error });
      for (const control of entry.controls.values()) await this.sendControl(control, "", "interrupt", true).catch(() => false);
      await this.persist(entry); this.notifyWaiters(entry);
    }
    return this.view(entry);
  }
  async monitorResult(sessionId: string, taskId: string, afterCursor = 0, limit = this.maxPageItems): Promise<GatewayTaskResultPage> {
    await this.ready(); await this.pruneExpired(); const entry = this.findSessionEntry(sessionId, taskId);
    const eligible = entry.results.filter((item) => item.cursor > afterCursor); const values = eligible.slice(0, limit).map(clone); const nextCursor = values.at(-1)?.cursor ?? afterCursor;
    return { taskId: entry.id, status: entry.status, ...(entry.publicationId === undefined ? {} : { publicationId: entry.publicationId }), results: values, items: values.map(clone), oldestCursor: entry.results[0]?.cursor ?? entry.results.length + 1, nextCursor, hasMore: eligible.length > values.length, done: terminalStatus(entry.status) && nextCursor >= entry.results.length };
  }

  async shutdown(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!terminalStatus(entry.status)) {
        entry.cancelledRequested = true;
        entry.controller.abort("Gateway teammate service shutdown");
      }
    }
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.completion).filter((value): value is Promise<void> => value !== undefined));
  }

  /** Single action router used by MCP transport hosts. */
  async execute(principalInput: GatewayPrincipal, actionOrRequest: GatewayTeammateAction | GatewayTeammateRequest, input: Record<string, unknown> = {}): Promise<GatewayResult<unknown>> {
    const principal = principalValue(principalInput);
    const request = typeof actionOrRequest === "string" ? { ...input, action: actionOrRequest } : actionOrRequest;
    switch (request.action) {
      case "start": return this.start(principal, request as GatewayTeammateStartInput);
      case "list": return this.list(principal, request as GatewayTeammateListInput);
      case "observe": return this.observe(principal, request as GatewayTeammateObserveInput);
      case "wait": return this.wait(principal, request as GatewayTeammateWaitInput);
      case "send": return this.send(principal, request as unknown as GatewayTeammateSendInput);
      case "cancel": return this.cancel(principal, request as GatewayTeammateCancelInput);
      case "result": return this.result(principal, request as GatewayTeammateResultInput);
      default: return operationError("invalid_action", "Unsupported teammate action", principal, request);
    }
  }
  async handle(principal: GatewayPrincipal, request: GatewayTeammateRequest): Promise<GatewayResult<unknown>> { return this.execute(principal, request); }
  async dispatch(principal: GatewayPrincipal, request: GatewayTeammateRequest): Promise<GatewayResult<unknown>> { return this.execute(principal, request); }

  private async ready(): Promise<void> {
    this.readyPromise ??= this.loadJournal();
    return this.readyPromise;
  }

  private async loadJournal(): Promise<void> {
    const records = await this.journal.recover();
    for (const record of records) {
      if (this.entries.has(record.id)) continue;
      const entry: TaskEntry = {
        id: record.id,
        principalId: record.principalId,
        workspaceId: record.workspaceId,
        workspacePath: record.cwd,
        ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        ...(record.memberId === undefined ? {} : { memberId: record.memberId }),
        objective: "Recovered teammate task",
        cwd: record.cwd,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
        ...(record.error === undefined ? {} : { error: record.error }),
        ...(record.publicationId === undefined ? {} : { publicationId: record.publicationId }),
        controller: new AbortController(),
        controls: new Map(),
        progress: new Map(),
        events: new GatewayTeammateEventBuffer(this.maxEvents, this.maxEventBytes),
        results: Array.isArray(record.resultEvidence) ? record.resultEvidence as GatewayTaskResultItem[] : [],
        cancelledRequested: false,
        waiters: new Set(),
      };
      if (Array.isArray(record.monitorEvents)) entry.events.restore(record.monitorEvents as GatewayTaskEvent[]);
      if (entry.events.latestCursor() === 0) this.appendEvent(entry, "state", { status: record.status, ...(record.error === undefined ? {} : { error: record.error }) });
      else if (entry.sessionId) {
        for (const event of entry.events.page(0, this.maxEvents).events) this.publishEvent(entry, event);
      }
      this.entries.set(record.id, entry);
    }
  }

  private normalizeStartInput(input: GatewayTeammateStartInput | RunTeammateParams): { params: RunTeammateParams; objective?: string; workspacePath?: string; workspaceId?: string; runOptions?: Partial<RunTeammateOptions>; requestId?: string; gatewaySessionId?: string; gatewayMemberId?: string } {
    const source = input as GatewayTeammateStartInput & RunTeammateParams;
    const wrapper = source.params ? source : undefined;
    const candidate = wrapper?.params ?? (Array.isArray(source.tasks) ? source : undefined);
    const rawTasks = candidate?.tasks ?? (typeof source.prompt === "string" || typeof source.task === "string" ? [{ prompt: source.prompt ?? source.task ?? "", agent: source.agent }] : []);
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) throw new Error("teammate start requires at least one task");
    const defaultAgent = typeof source.agent === "string" && source.agent.trim() ? source.agent : "general";
    const tasks = rawTasks.map((task) => {
      if (!task || typeof task !== "object") throw new Error("teammate task must be an object");
      const value = task as unknown as Record<string, unknown>;
      const prompt = typeof value.prompt === "string" ? value.prompt : typeof value.task === "string" ? value.task : "";
      if (!prompt.trim()) throw new Error("teammate task prompt must be non-empty");
      return { ...value, prompt, ...(typeof value.agent === "string" && value.agent.trim() ? {} : { agent: defaultAgent }) } as RunTeammateParams["tasks"][number];
    });
    const params: RunTeammateParams = { ...(candidate ?? {}), tasks };
    const runOptions = (source.runOptions ?? source.options) as Partial<RunTeammateOptions> | undefined;
    return {
      params,
      ...(typeof source.objective === "string" ? { objective: source.objective } : {}),
      ...(typeof source.workspacePath === "string" ? { workspacePath: source.workspacePath } : typeof source.workspace === "string" ? { workspacePath: source.workspace } : {}),
      ...(typeof source.workspaceId === "string" ? { workspaceId: source.workspaceId } : {}),
      ...(runOptions === undefined ? {} : { runOptions }),
      ...(typeof source.requestId === "string" ? { requestId: source.requestId } : {}),
      ...(typeof source.gatewaySessionId === "string" ? { gatewaySessionId: source.gatewaySessionId } : {}),
      ...(typeof source.gatewayMemberId === "string" ? { gatewayMemberId: source.gatewayMemberId } : {}),
    };
  }

  private async resolveWorkspace(
    request: { params: RunTeammateParams; workspacePath?: string; workspaceId?: string },
    params: RunTeammateParams,
    principal: GatewayPrincipal,
  ): Promise<{ path: string; id: string }> {
    const requestedPath = request.workspacePath ?? params.cwd ?? params.tasks[0]?.cwd;
    const requested = request.workspaceId ?? requestedPath ?? this.baseCwd;
    if (!this.policy) {
      const path = canonicalizeWorkspacePath(requestedPath ?? this.baseCwd);
      return { path, id: request.workspaceId ?? workspaceIdForPath(path) };
    }
    const decision = await this.policy.authorizeWorkspace(principal, requested);
    if (!decision.allowed || decision.workspacePath === undefined || decision.workspaceId === undefined) throw new Error(decision.reason);
    if (request.workspaceId !== undefined && requestedPath !== undefined) {
      const pathDecision = await this.policy.authorizeWorkspace(principal, requestedPath);
      if (!pathDecision.allowed || pathDecision.workspacePath !== decision.workspacePath) throw new Error("workspaceId and workspacePath refer to different workspaces");
    }
    return { path: decision.workspacePath, id: decision.workspaceId };
  }

  private async authorize(principal: GatewayPrincipal, workspacePath: string, operation: GatewayPolicyOperation): Promise<void> {
    if (!this.policy) return;
    const decision = await this.policy.authorizeWorkspace(principal, workspacePath);
    if (!decision.allowed) throw new Error(decision.reason);
    void operation;
  }

  private owns(entry: TaskEntry, principal: GatewayPrincipal): boolean {
    if (entry.principalId !== principalKey(principal)) return false;
    if (principal.workspaceId !== undefined && principal.workspaceId !== entry.workspaceId && principal.workspaceId !== entry.workspacePath) return false;
    if (principal.workspacePath !== undefined) {
      try {
        const principalPath = canonicalizeWorkspacePath(principal.workspacePath);
        if (principalPath !== entry.workspacePath) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private findOwned(idInput: unknown, principal: GatewayPrincipal): TaskEntry | undefined {
    if (typeof idInput !== "string") return undefined;
    const entry = this.entries.get(idInput.trim());
    return entry && this.owns(entry, principal) ? entry : undefined;
  }
  private findSessionEntry(sessionId: string, taskId: string): TaskEntry {
    const entry = this.entries.get(taskId);
    if (!entry || entry.sessionId !== sessionId) throw new Error("Monitor handle was not found in this session");
    return entry;
  }

  private view(entry: TaskEntry): GatewayTeammateTaskView {
    return {
      version: GATEWAY_STATE_VERSION,
      id: entry.id,
      status: entry.status,
      objective: entry.objective,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.publicationId === undefined ? {} : { publicationId: entry.publicationId }),
      workspaceId: entry.workspaceId,
      eventCursor: entry.events.latestCursor(),
      resultCount: entry.results.length,
    };
  }

  private appendEvent(entry: TaskEntry, type: GatewayTaskEvent["type"], data?: unknown): void {
    const event = entry.events.append({ taskId: entry.id, type, at: this.now(), ...(data === undefined ? {} : { data }) });
    if (entry.sessionId) this.publishEvent(entry, event);
  }

  private publishEvent(entry: TaskEntry, event: GatewayTaskEvent): void {
    this.eventJournal.append({
      cursor: event.cursor,
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId!,
      handle: entry.id,
      kind: event.type,
      // Streaming has a tighter producer bound than polling evidence. Project
      // before append so an advisory child payload cannot break execution.
      payload: boundedValue(event.data ?? {}, 48 * 1024),
      at: event.at,
    });
  }

  private setStatus(entry: TaskEntry, status: GatewayTaskState, error?: string): void {
    if (terminalStatus(entry.status) && entry.status !== status) return;
    if (entry.status === status && error === undefined) return;
    entry.status = status;
    entry.updatedAt = this.now();
    if (status === "running") entry.startedAt ??= entry.updatedAt;
    if (terminalStatus(status)) entry.finishedAt ??= entry.updatedAt;
    if (error !== undefined) entry.error = utf8Tail(error, 16 * 1024);
    this.appendEvent(entry, "state", { status, ...(entry.error === undefined ? {} : { error: entry.error }) });
    if (terminalStatus(status)) {
      entry.releaseConcurrency?.();
      entry.releaseConcurrency = undefined;
    }
  }

  private notifyWaiters(entry: TaskEntry): void {
    if (!terminalStatus(entry.status)) return;
    for (const waiter of [...entry.waiters]) waiter();
    entry.waiters.clear();
  }

  private async runEntry(entry: TaskEntry, principal: GatewayPrincipal): Promise<void> {
    this.setStatus(entry, "running");
    const taskCorrelationIds = (entry.params?.tasks ?? []).map((_, index) => entry.params!.tasks.length === 1 ? entry.id : `${entry.id}:${index + 1}`);
    const supplied = entry.runOptions ?? {};
    const invoke = <T extends unknown[]>(callback: ((...args: T) => unknown) | undefined, ...args: T): void => {
      try { callback?.(...args); } catch { /* observer callbacks are advisory */ }
    };
    const options: RunTeammateOptions = {
      ...supplied,
      baseCwd: entry.cwd,
      taskCorrelationIds,
      signal: entry.controller.signal,
      onProgress: (progress) => {
        const correlationId = progress.correlationId ?? taskCorrelationIds[progress.taskIndex ?? 0];
        if (correlationId) entry.progress.set(correlationId, clone(progress));
        if (progress.status === "running" || progress.status === "retrying") this.setStatus(entry, "running");
        this.appendEvent(entry, "progress", this.projectProgress(progress));
        invoke(supplied.onProgress, progress);
      },
      onChildEvent: (event) => {
        this.appendEvent(entry, "child", boundedValue(event, this.maxEventBytes / 2));
        invoke(supplied.onChildEvent, event);
      },
      onChildSpawned: (stdin, sendControl, sessionDir, correlationId, generation) => {
        const key = correlationId ?? `${entry.id}:${entry.controls.size + 1}`;
        const control: GatewayTeammateControl = { stdin, sendControl, correlationId, generation };
        entry.controls.set(key, control);
        if (entry.cancelledRequested) {
          void this.sendControl(control, "", "interrupt", true).catch(() => undefined);
        }
        invoke(supplied.onChildSpawned, stdin, sendControl, sessionDir, correlationId, generation);
      },
      onResultPublished: async (result, originCwd) => {
        if (result.publicationId) entry.publicationId = utf8Tail(result.publicationId, 256);
        this.appendEvent(entry, "published", { publicationId: result.publicationId, correlationId: result.correlationId, originCwd: utf8Tail(originCwd, 4096) });
        const publication = supplied.onResultPublished;
        if (!publication) return;
        try { return await publication(result, originCwd); } catch { return undefined; }
      },
      onTurnComplete: (result, status) => {
        this.appendEvent(entry, "complete", { correlationId: result.correlationId, status: status ?? result.terminalStatus, exitCode: result.exitCode });
        invoke(supplied.onTurnComplete, result, status);
      },
      onChildClosed: (correlationId, generation, details) => {
        if (correlationId) {
          const current = entry.controls.get(correlationId);
          if (current?.generation === generation) entry.controls.delete(correlationId);
        }
        this.appendEvent(entry, "child", { correlationId, generation, closed: details });
        invoke(supplied.onChildClosed, correlationId, generation, details);
      },
    };
    try {
      const results = await this.port.runTeammate(entry.params!, options);
      entry.results = this.projectResults(results);
      const failed = results.some((result) => result.exitCode !== 0);
      const finalStatus: GatewayTaskState = entry.cancelledRequested || entry.controller.signal.aborted
        ? "cancelled"
        : failed ? "failed" : "completed";
      const failure = results.find((result) => result.exitCode !== 0);
      if (failure && !entry.error) entry.error = this.resultError(failure);
      this.setStatus(entry, finalStatus, entry.error);
      await this.persist(entry);
    } catch (error) {
      const message = errorMessage(error);
      this.setStatus(entry, entry.cancelledRequested || entry.controller.signal.aborted ? "cancelled" : "failed", message);
      this.appendEvent(entry, "error", { message });
      await this.persist(entry).catch(() => undefined);
    } finally {
      this.notifyWaiters(entry);
      entry.controls.clear();
      entry.releaseConcurrency?.();
      entry.releaseConcurrency = undefined;
      void principal;
    }
  }

  private projectProgress(progress: AgentProgress): unknown {
    return {
      correlationId: progress.correlationId,
      taskIndex: progress.taskIndex,
      agent: progress.agent,
      name: progress.name,
      status: progress.status,
      phase: progress.phase,
      toolCount: progress.toolCount,
      tokens: progress.tokens,
      durationMs: progress.durationMs,
      lastActivityAt: progress.lastActivityAt,
      startedAt: progress.startedAt,
      lastMessage: boundedText(progress.lastMessage),
      recentTools: boundedValue(progress.recentTools, 8 * 1024),
    };
  }

  private projectResults(results: SingleResult[]): GatewayTaskResultItem[] {
    const output: GatewayTaskResultItem[] = [];
    let bytes = 0;
    for (const [index, result] of results.entries()) {
      if (output.length >= this.maxResultItems) break;
      const messages = result.messages.slice(-32).map((message) => ({ role: utf8Tail(message.role, 128), content: utf8Tail(message.content, 8 * 1024) }));
      const item: GatewayTaskResultItem = {
        cursor: index + 1,
        correlationId: utf8Tail(result.correlationId, 256),
        agent: utf8Tail(result.agent, 256),
        ...(result.name === undefined ? {} : { name: utf8Tail(result.name, 256) }),
        status: result.exitCode === 0 ? "completed" : result.terminalStatus === "terminated" ? "cancelled" : "failed",
        exitCode: result.exitCode,
        model: utf8Tail(result.model, 256),
        durationMs: Math.max(0, result.durationMs),
        ...(result.publicationId === undefined ? {} : { publicationId: utf8Tail(result.publicationId, 256) }),
        ...(messages.length === 0 ? {} : { messages }),
        ...(result.structuredOutput === undefined ? {} : { structuredOutput: boundedValue(result.structuredOutput, 32 * 1024) }),
        ...(result.messages.at(-1)?.content === undefined ? {} : { output: utf8Tail(result.messages.at(-1)!.content, 16 * 1024) }),
        ...(result.exitCode === 0 ? {} : { error: this.resultError(result) }),
      };
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (bytes + size > this.maxResultBytes && output.length > 0) break;
      output.push(item);
      bytes += size;
    }
    return output;
  }

  private resultError(result: SingleResult): string {
    return utf8Tail(result.messages.at(-1)?.content ?? `Teammate exited with code ${result.exitCode}`, 16 * 1024);
  }

  private selectControl(entry: TaskEntry, correlationId?: string): GatewayTeammateControl | undefined {
    if (correlationId) return entry.controls.get(correlationId);
    return entry.controls.values().next().value as GatewayTeammateControl | undefined;
  }

  private async sendControl(control: GatewayTeammateControl, message: string, mode: GatewayTeammateSendMode, abort = false): Promise<boolean> {
    // Cancellation is a hard abort, not an empty interrupt prompt. Prefer the
    // public low-level sender when the host exposes one, then the captured IPC
    // control sender as a final fallback for runtimes without stdin.
    if (abort) {
      if (control.stdin && this.port.sendRpcMessage) return Boolean(await this.port.sendRpcMessage(control.stdin, message, "abort"));
      if (control.stdin && !this.port.send) return sendPublicRpcMessage(control.stdin, message, "abort");
      if (control.sendControl) return control.sendControl({ type: "abort" });
    }
    if (this.port.send) return Boolean(await this.port.send(control, message, mode));
    if (control.stdin && this.port.sendRpcMessage) return Boolean(await this.port.sendRpcMessage(control.stdin, message, mode));
    if (control.stdin) return sendPublicRpcMessage(control.stdin, message, mode);
    return false;
  }

  private async waitForEntry(entry: TaskEntry, timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
    if (terminalStatus(entry.status)) return true;
    if (signal?.aborted) throw new Error("Gateway task wait was aborted");
    const timeout = timeoutMs === undefined ? undefined : positiveInteger(timeoutMs, "timeoutMs", GATEWAY_HARD_LIMITS.maxExecTimeoutMs, GATEWAY_HARD_LIMITS.maxExecTimeoutMs);
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        entry.waiters.delete(done);
        resolve();
      };
      const onAbort = (): void => {
        if (timer) clearTimeout(timer);
        entry.waiters.delete(done);
        reject(new Error("Gateway task wait was aborted"));
      };
      entry.waiters.add(done);
      if (timeout !== undefined) {
        timer = setTimeout(() => {
          entry.waiters.delete(done);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, timeout);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      if (terminalStatus(entry.status)) done();
    });
    return terminalStatus(entry.status);
  }

  private async pruneExpired(): Promise<void> {
    await this.journal.prune();
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (!terminalStatus(entry.status)) continue;
      const finishedAt = entry.finishedAt ?? entry.updatedAt;
      if (this.resultRetentionMs !== undefined && finishedAt <= now - this.resultRetentionMs) entry.results = [];
      if (this.taskRetentionMs !== undefined && finishedAt <= now - this.taskRetentionMs) this.entries.delete(id);
    }
  }

  private async persist(entry: TaskEntry): Promise<void> {
    const record: GatewayTaskJournalRecord = {
      version: GATEWAY_STATE_VERSION,
      id: entry.id,
      status: entry.status,
      cwd: entry.cwd,
      workspaceId: entry.workspaceId,
      principalId: entry.principalId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
      ...(entry.publicationId === undefined ? {} : { publicationId: entry.publicationId }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId, memberId: entry.memberId, monitorEvents: entry.events.page(0, 512).events, resultEvidence: entry.results }),
    };
    await this.journal.upsert(record);
  }
}

function isSendMode(value: unknown): value is GatewayTeammateSendMode {
  return value === "steer" || value === "follow_up" || value === "interrupt";
}

function errorMessage(error: unknown): string {
  return utf8Tail(error instanceof Error ? error.message : String(error), 16 * 1024);
}

export const TeammateService = GatewayTeammateService;
export const createGatewayTeammateService = (options?: GatewayTeammateServiceOptions): GatewayTeammateService => new GatewayTeammateService(options);
export const createTeammateService = createGatewayTeammateService;

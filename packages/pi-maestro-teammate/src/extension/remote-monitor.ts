import { randomUUID } from "node:crypto";
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";

import type { RemoteConfig } from "../remote/config.ts";
import type {
  RemoteRunCancelResult,
  RemoteRunInputResult,
} from "../remote/protocol.ts";
import type {
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunResultEvent,
  RemoteRunSnapshot,
  RemoteStatus,
} from "../remote/types.ts";
import type {
  RemoteWorkerStartRequest,
  RemoteWorkerWaitOptions,
} from "../remote/worker-manager.ts";
import type {
  ObservationReadOptions,
  ObservationSnapshot,
  ObservationWaitOptions,
} from "../public/v1/observation.ts";
import {
  createRemoteHistoryEntry,
  REMOTE_HISTORY_MAX_ENTRIES,
  type RemoteHistoryEntry,
  type RemoteHistoryMode,
} from "../sessions/remote-history.ts";
import type { SessionMessageKind } from "../sessions/session-core.ts";

const REMOTE_MONITOR_MAX_DETAIL_LINES = 200;
const REMOTE_MONITOR_MAX_DETAIL_BYTES = 32 * 1024;
const REMOTE_MONITOR_MAX_DETAIL_LINE_BYTES = 8 * 1024;
const REMOTE_MONITOR_MAX_RESULT_BYTES = 8 * 1024;
const REMOTE_MONITOR_MAX_STRUCTURED_BYTES = 20 * 1024;
const REMOTE_MONITOR_TRUNCATED = "\n[truncated]";

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(REMOTE_MONITOR_TRUNCATED, "utf8");
  const prefix = Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - markerBytes))
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${prefix}${REMOTE_MONITOR_TRUNCATED}`;
}

function errorClass(error: unknown): string {
  const candidate = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate) ? candidate : "Error";
}

/** Raw remote error messages may contain stderr, argv, hosts, paths, or credentials. */
export function sanitizeRemoteMonitorError(error: unknown, operation = "operation"): string {
  const safeOperation = /^[a-z][a-z -]{0,63}$/i.test(operation) ? operation : "operation";
  return `Remote ${safeOperation} failed (${errorClass(error)}).`;
}

function failureHistoryStatus(error: unknown): "rejected" | "timeout" {
  if (error instanceof Error && (error.name === "AbortError" || /timeout|timed out/i.test(error.message))) return "timeout";
  return "rejected";
}

function boundedStructuredOutput(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") <= REMOTE_MONITOR_MAX_STRUCTURED_BYTES) return structuredClone(value);
    return Object.freeze({
      truncated: true,
      preview: truncateUtf8(serialized, REMOTE_MONITOR_MAX_STRUCTURED_BYTES - 128),
    });
  } catch {
    return Object.freeze({ truncated: true, preview: "[unserializable structured output]" });
  }
}

export interface RemoteWorkerManagerLike {
  readonly monitorOwnerNonce: string;
  start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture>;
  snapshot(capture: RemoteRunCapture): RemoteRunSnapshot;
  snapshots(): RemoteRunSnapshot[];
  wait(capture: RemoteRunCapture, options?: RemoteWorkerWaitOptions): Promise<RemoteRunSnapshot>;
  followUp(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult>;
  steer(capture: RemoteRunCapture, message: string, commandId?: string): Promise<RemoteRunInputResult>;
  cancel(capture: RemoteRunCapture, reason?: string, commandId?: string): Promise<RemoteRunCancelResult>;
  close(): Promise<void>;
}

export interface RemoteMonitorTargetListing {
  id: string;
  hostId: string;
  driver: "pi-rpc" | "acp";
  cwd: string;
}

export interface RemoteMonitorRunListing extends RemoteRunSnapshot {
  target: string;
  targetId: string;
  name?: string;
  objective?: string;
  createdAt: number;
}

export interface RemoteMonitorSessionOptions {
  config: RemoteConfig;
  manager: RemoteWorkerManagerLike;
  isCurrent: () => boolean;
  persist?: (entry: RemoteHistoryEntry) => void;
  now?: () => number;
  commandIdFactory?: () => string;
}

interface RemoteRunRecord {
  capture: RemoteRunCapture;
  snapshot: RemoteRunSnapshot;
  createdAt: number;
  name?: string;
  objective?: string;
  detail: string[];
  detailBytes: number;
  lastResult?: string;
  structuredOutput?: unknown;
  lastPersistedStatus?: RemoteStatus;
  lastPersistedSequence?: number;
}

function stableTarget(runId: string): string {
  return `remote:${runId}`;
}

function terminalStatus(status: RemoteStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "lost";
}

function boundedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable structured output]";
  }
}

function observationState(status: RemoteStatus): Pick<ObservationSnapshot, "phase" | "outcome" | "waitStatus" | "terminalStatus"> {
  switch (status) {
    case "completed": return { phase: "settled", outcome: "success", waitStatus: "completed", terminalStatus: status };
    case "failed": return { phase: "settled", outcome: "failure", waitStatus: "failed", terminalStatus: status };
    case "cancelled": return { phase: "settled", outcome: "aborted", waitStatus: "terminated", terminalStatus: status };
    case "lost": return { phase: "settled", outcome: "failure", waitStatus: "failed", terminalStatus: status };
    default: return { phase: "active" };
  }
}

export class RemoteMonitorSession {
  readonly #config: RemoteConfig;
  readonly #manager: RemoteWorkerManagerLike;
  readonly #isCurrent: () => boolean;
  readonly #persist?: (entry: RemoteHistoryEntry) => void;
  readonly #now: () => number;
  readonly #commandIdFactory: () => string;
  readonly #runs = new Map<string, RemoteRunRecord>();
  #persistedEntries = 0;
  #shutdown = false;

  constructor(options: RemoteMonitorSessionOptions) {
    this.#config = options.config;
    this.#manager = options.manager;
    this.#isCurrent = options.isCurrent;
    this.#persist = options.persist;
    this.#now = options.now ?? Date.now;
    this.#commandIdFactory = options.commandIdFactory ?? randomUUID;
  }

  get monitorOwnerNonce(): string {
    return this.#manager.monitorOwnerNonce;
  }

  targets(): RemoteMonitorTargetListing[] {
    this.#assertCurrent();
    return Object.entries(this.#config.targets)
      .map(([id, target]) => ({ id, hostId: target.host, driver: target.driver, cwd: target.cwd }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async create(request: RemoteWorkerStartRequest): Promise<RemoteMonitorRunListing> {
    this.#assertCurrent();
    const capture = await this.#manager.start(request);
    if (!this.#isCurrent()) {
      try {
        await this.#manager.cancel(capture, "monitor-session-changed-after-create");
      } catch (cleanupError) {
        throw new Error("The originating Monitor session changed before remote creation completed, and stale admission cleanup failed.", {
          cause: cleanupError,
        });
      }
      throw new Error("The originating Monitor session changed before remote creation completed.");
    }
    const snapshot = this.#manager.snapshot(capture);
    const record = this.#recordFor(capture, snapshot);
    record.name = request.name;
    record.objective = request.objective;
    this.#persistHistory({
      entryId: `${capture.runId}:create`,
      target: stableTarget(capture.runId),
      runId: capture.runId,
      targetId: capture.targetId,
      kind: "message",
      direction: "outgoing",
      source: "remote",
      messageKind: "coordination",
      requestedMode: "follow_up",
      effectiveMode: "follow_up",
      body: request.objective,
      status: "accepted",
      createdAt: record.createdAt,
      updatedAt: this.#now(),
      revision: 1,
    });
    this.recordSnapshot(capture, snapshot);
    return this.#listing(record);
  }

  list(): RemoteMonitorRunListing[] {
    this.#assertCurrent();
    return [...this.#runs.values()]
      .map((record) => this.#listing(record))
      .sort((left, right) => right.createdAt - left.createdAt || left.runId.localeCompare(right.runId));
  }

  capture(target: string): RemoteRunCapture | undefined {
    if (!target.startsWith("remote:") || target.length <= "remote:".length) return undefined;
    const record = this.#runs.get(target.slice("remote:".length));
    return record ? { ...record.capture } : undefined;
  }

  async send(
    target: string,
    mode: RemoteHistoryMode,
    message: string,
    messageKind: SessionMessageKind,
    commandId = this.#commandIdFactory(),
    requestedMode: RemoteHistoryMode = mode,
  ): Promise<RemoteRunInputResult> {
    this.#assertCurrent();
    const record = this.#requireTarget(target);
    const createdAt = this.#now();
    let receipt: RemoteRunInputResult;
    try {
      receipt = mode === "steer"
        ? await this.#manager.steer(record.capture, message, commandId)
        : await this.#manager.followUp(record.capture, message, commandId);
    } catch (error) {
      this.#assertCurrentAfterAwait("remote message delivery");
      this.#requireSameCapture(record.capture);
      const safeError = sanitizeRemoteMonitorError(error, "message delivery");
      this.#persistHistory({
        entryId: commandId,
        target,
        runId: record.capture.runId,
        targetId: record.capture.targetId,
        kind: "receipt",
        direction: "outgoing",
        source: "remote",
        messageKind,
        requestedMode,
        body: safeError,
        status: failureHistoryStatus(error),
        createdAt,
        updatedAt: this.#now(),
        revision: 1,
      });
      throw new Error(safeError, { cause: error });
    }
    this.#assertCurrentAfterAwait("remote message delivery");
    this.#requireSameCapture(record.capture);
    this.#persistHistory({
      entryId: commandId,
      target,
      runId: record.capture.runId,
      targetId: record.capture.targetId,
      kind: "receipt",
      direction: "outgoing",
      source: "remote",
      messageKind,
      requestedMode,
      effectiveMode: receipt.effectiveMode,
      body: message,
      status: receipt.accepted ? receipt.receipt : "rejected",
      createdAt,
      updatedAt: this.#now(),
      revision: 1,
    });
    return receipt;
  }

  async closeRun(target: string, reason = "monitor-remote-worker-close"): Promise<RemoteRunCancelResult> {
    this.#assertCurrent();
    const record = this.#requireTarget(target);
    const result = await this.#manager.cancel(record.capture, reason, this.#commandIdFactory());
    this.#assertCurrentAfterAwait("remote close");
    this.#requireSameCapture(record.capture);
    this.#persistLifecycle(record, `Remote close ${result.accepted ? "accepted" : "rejected"}; status=${result.status}.`);
    return result;
  }

  recordSnapshot(capture: RemoteRunCapture, snapshot: RemoteRunSnapshot): void {
    if (!this.#captureMatchesOwner(capture)) return;
    this.#assertSnapshotCapture(snapshot, capture);
    const record = this.#recordFor(capture, snapshot);
    record.snapshot = { ...snapshot };
    if (record.lastPersistedStatus !== snapshot.status || record.lastPersistedSequence !== snapshot.lastSequence) {
      record.lastPersistedStatus = snapshot.status;
      record.lastPersistedSequence = snapshot.lastSequence;
      this.#persistLifecycle(record, snapshot.summary
        ? `${snapshot.status}: ${snapshot.summary}`
        : `Remote run transitioned to ${snapshot.status}.`);
    }
  }

  recordEvent(capture: RemoteRunCapture, event: RemoteRunEvent): void {
    if (!this.#captureMatchesOwner(capture)) return;
    if (event.workerId !== capture.workerId
      || event.instanceNonce !== capture.instanceNonce
      || event.runId !== capture.runId
      || event.generation !== capture.generation) {
      throw new Error("Remote event does not match the owned run capture.");
    }
    const record = this.#runs.get(capture.runId);
    if (!record) return;
    if (event.type === "run/event") {
      const driverEvent = event.event;
      if (driverEvent.type === "text") this.#appendDetail(record, driverEvent.text);
      else if (driverEvent.type === "tool") {
        this.#appendDetail(record, `[tool/${driverEvent.tool.toolName}] ${driverEvent.tool.phase}${driverEvent.tool.summary ? `: ${driverEvent.tool.summary}` : ""}`);
      } else if (driverEvent.type === "usage") {
        this.#appendDetail(record, `[usage] ${driverEvent.usage.totalTokens ?? "unknown"} tokens`);
      }
      return;
    }
    if (event.type === "run/result") this.#recordResult(record, event);
  }

  observation(target: string, options: ObservationReadOptions): ObservationSnapshot {
    if (!this.#isCurrent()) return this.#missingObservation(target, "Remote Monitor owner is no longer current.");
    const record = this.#targetRecord(target);
    if (!record) return this.#missingObservation(target, `Remote run ${target} is not owned by this Monitor session.`);
    return this.#observationFor(record, options);
  }

  async waitObservation(target: string, options: ObservationWaitOptions): Promise<ObservationSnapshot> {
    this.#assertCurrent();
    const record = this.#requireTarget(target);
    const remaining = Math.max(1, options.deadline - this.#now());
    let snapshot: RemoteRunSnapshot;
    try {
      snapshot = await this.#manager.wait(record.capture, { timeoutMs: remaining, signal: options.signal });
    } catch (error) {
      this.#assertCurrentAfterAwait("remote observation wait");
      throw new Error(sanitizeRemoteMonitorError(error, "observation wait"), { cause: error });
    }
    this.#assertCurrentAfterAwait("remote observation wait");
    this.#requireSameCapture(record.capture);
    record.snapshot = { ...snapshot };
    return this.#observationFor(record, options);
  }

  async shutdown(reason = "monitor-session-shutdown"): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    const captures = [...this.#runs.values()]
      .filter((record) => !terminalStatus(record.snapshot.status))
      .map((record) => ({ ...record.capture }));
    await Promise.allSettled(captures.map((capture) => this.#manager.cancel(capture, reason, this.#commandIdFactory())));
    await this.#manager.close();
  }

  #recordFor(capture: RemoteRunCapture, snapshot: RemoteRunSnapshot): RemoteRunRecord {
    this.#assertSnapshotCapture(snapshot, capture);
    const existing = this.#runs.get(capture.runId);
    if (existing) {
      this.#assertCaptureEqual(existing.capture, capture);
      return existing;
    }
    if (!this.#captureMatchesOwner(capture)) throw new Error("Remote capture belongs to another Monitor owner.");
    const record: RemoteRunRecord = {
      capture: { ...capture },
      snapshot: { ...snapshot },
      createdAt: this.#now(),
      detail: [],
      detailBytes: 0,
    };
    this.#runs.set(capture.runId, record);
    return record;
  }

  #targetRecord(target: string): RemoteRunRecord | undefined {
    const capture = this.capture(target);
    return capture ? this.#runs.get(capture.runId) : undefined;
  }

  #requireTarget(target: string): RemoteRunRecord {
    const record = this.#targetRecord(target);
    if (!record) throw new Error(`Remote target ${JSON.stringify(target)} is not owned by this Monitor session.`);
    return record;
  }

  #requireSameCapture(capture: RemoteRunCapture): void {
    const record = this.#runs.get(capture.runId);
    if (!record) throw new Error("Remote run ownership was released during the operation.");
    this.#assertCaptureEqual(record.capture, capture);
  }

  #captureMatchesOwner(capture: RemoteRunCapture): boolean {
    return capture.monitorOwnerNonce === this.#manager.monitorOwnerNonce;
  }

  #assertCaptureEqual(left: RemoteRunCapture, right: RemoteRunCapture): void {
    if (left.monitorOwnerNonce !== right.monitorOwnerNonce
      || left.workerId !== right.workerId
      || left.instanceNonce !== right.instanceNonce
      || left.runId !== right.runId
      || left.generation !== right.generation
      || left.targetId !== right.targetId) {
      throw new Error("Remote run ownership capture changed.");
    }
  }

  #assertSnapshotCapture(snapshot: RemoteRunSnapshot, capture: RemoteRunCapture): void {
    if (snapshot.workerId !== capture.workerId
      || snapshot.instanceNonce !== capture.instanceNonce
      || snapshot.runId !== capture.runId
      || snapshot.generation !== capture.generation
      || (snapshot.targetId !== undefined && snapshot.targetId !== capture.targetId)) {
      throw new Error("Remote snapshot does not match the owned run capture.");
    }
  }

  #assertCurrent(): void {
    if (this.#shutdown) throw new Error("Remote Monitor session is closed.");
    if (!this.#isCurrent()) throw new Error("Remote Monitor owner is no longer current.");
  }

  #assertCurrentAfterAwait(operation: string): void {
    if (this.#shutdown || !this.#isCurrent()) {
      throw new Error(`The originating Monitor session changed during ${operation}.`);
    }
  }

  #listing(record: RemoteRunRecord): RemoteMonitorRunListing {
    return {
      ...record.snapshot,
      target: stableTarget(record.capture.runId),
      targetId: record.capture.targetId,
      ...(record.name ? { name: record.name } : {}),
      ...(record.objective ? { objective: record.objective } : {}),
      createdAt: record.createdAt,
    };
  }

  #appendDetail(record: RemoteRunRecord, value: string): void {
    const lines = value
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => truncateUtf8(line, REMOTE_MONITOR_MAX_DETAIL_LINE_BYTES));
    for (const line of lines) {
      record.detail.push(line);
      record.detailBytes += Buffer.byteLength(line, "utf8");
    }
    while (record.detail.length > REMOTE_MONITOR_MAX_DETAIL_LINES
      || record.detailBytes > REMOTE_MONITOR_MAX_DETAIL_BYTES) {
      const removed = record.detail.shift();
      if (removed === undefined) break;
      record.detailBytes -= Buffer.byteLength(removed, "utf8");
    }
  }

  #recordResult(record: RemoteRunRecord, event: RemoteRunResultEvent): void {
    const retainedStructured = boundedStructuredOutput(event.structuredOutput);
    const structured = boundedJson(retainedStructured);
    const safeError = event.error ? sanitizeRemoteMonitorError(new Error(event.error), "run") : undefined;
    const body = [
      safeError,
      event.result,
      structured === undefined ? undefined : `Structured output: ${structured}`,
    ].filter((value): value is string => Boolean(value)).join("\n") || `Remote run ${event.status}.`;
    record.lastResult = truncateUtf8(event.result ?? safeError ?? structured ?? `Remote run ${event.status}.`, REMOTE_MONITOR_MAX_RESULT_BYTES);
    record.structuredOutput = retainedStructured;
    this.#appendDetail(record, body);
    this.#persistHistory({
      entryId: `${record.capture.runId}:result:${event.sequence}`,
      target: stableTarget(record.capture.runId),
      runId: record.capture.runId,
      targetId: record.capture.targetId,
      kind: "result",
      direction: "incoming",
      source: "remote",
      messageKind: "status",
      requestedMode: "follow_up",
      effectiveMode: "follow_up",
      body,
      status: "accepted",
      createdAt: event.updatedAt,
      updatedAt: event.updatedAt,
      revision: 1,
    });
  }

  #persistLifecycle(record: RemoteRunRecord, body: string): void {
    const now = this.#now();
    this.#persistHistory({
      entryId: `${record.capture.runId}:lifecycle:${record.snapshot.lastSequence}:${record.snapshot.status}:${now}`,
      target: stableTarget(record.capture.runId),
      runId: record.capture.runId,
      targetId: record.capture.targetId,
      kind: "lifecycle",
      direction: "incoming",
      source: "remote",
      messageKind: "status",
      requestedMode: "follow_up",
      effectiveMode: "follow_up",
      body,
      status: "accepted",
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });
  }

  #persistHistory(input: Parameters<typeof createRemoteHistoryEntry>[0]): void {
    if (!this.#persist || !this.#isCurrent() || this.#persistedEntries >= REMOTE_HISTORY_MAX_ENTRIES) return;
    try {
      this.#persist(createRemoteHistoryEntry(input));
      this.#persistedEntries += 1;
    } catch (error) {
      console.error("[pi-maestro-teammate] remote Monitor history persistence failed:", sanitizeRemoteMonitorError(error, "history persistence"));
    }
  }

  #observationFor(record: RemoteRunRecord, options: ObservationReadOptions): ObservationSnapshot {
    const snapshot = record.snapshot;
    const state = observationState(snapshot.status);
    const metadata = `${record.name ?? stableTarget(snapshot.runId)} · ${snapshot.status} · ${record.capture.targetId}`;
    const detail = options.detail === "summary"
      ? undefined
      : options.detail === "tail"
        ? record.detail.slice(-options.lines)
        : [
            `target=${stableTarget(snapshot.runId)}`,
            `worker=${snapshot.workerId} generation=${snapshot.generation}`,
            `sequence=${snapshot.lastSequence} updated=${new Date(snapshot.updatedAt).toISOString()}`,
            ...(snapshot.degradedReason ? [`degraded=${snapshot.degradedReason}`] : []),
            ...record.detail.slice(-options.lines),
          ];
    return {
      target: { kind: "remote", id: stableTarget(snapshot.runId) },
      found: true,
      nativeStatus: snapshot.nativeStatus ?? snapshot.status,
      ...state,
      summary: snapshot.summary ? `${metadata} · ${snapshot.summary}` : metadata,
      ...(detail && detail.length > 0 ? { detail } : {}),
      updatedAt: snapshot.updatedAt,
      capabilities: { inspect: true, wait: true, cancel: true, message: true, supervise: true },
      ...(options.detail !== "summary" && record.lastResult ? { lastResult: record.lastResult } : {}),
      ...(options.detail === "full" && record.structuredOutput !== undefined
        ? { structuredOutput: structuredClone(record.structuredOutput) }
        : {}),
    };
  }

  #missingObservation(target: string, error: string): ObservationSnapshot {
    return {
      target: { kind: "remote", id: target },
      found: false,
      nativeStatus: "not-found",
      phase: "unknown",
      outcome: "failure",
      waitStatus: "not-found",
      summary: error,
      updatedAt: this.#now(),
      error,
      capabilities: { inspect: true, wait: true, cancel: true, message: true, supervise: true },
    };
  }
}

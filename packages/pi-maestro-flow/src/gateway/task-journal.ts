/** Durable, metadata-only journal for Gateway-owned teammate tasks. */
import { join } from "node:path";
import { GATEWAY_HARD_LIMITS, GATEWAY_STATE_VERSION, type GatewayTaskState } from "./contracts.ts";
import {
  canonicalizeWorkspacePath,
  gatewayTasksRoot,
  readGatewayJson,
  writeGatewayJsonAtomic,
  workspaceIdForPath,
} from "./state-paths.ts";

export const GATEWAY_TASK_JOURNAL_VERSION = GATEWAY_STATE_VERSION;
export const GATEWAY_TASK_JOURNAL_FILE = "journal.json";
export const GATEWAY_TASK_LOST_ERROR = "Gateway daemon restarted before the task reached a terminal state";
export const GATEWAY_TASK_TERMINAL_STATES = ["completed", "failed", "cancelled", "lost"] as const;

export type GatewayTaskJournalStatus = GatewayTaskState;

/**
 * Only non-secret task metadata is written. Prompts, options, child streams,
 * result payloads, and control messages intentionally do not appear here.
 */
export interface GatewayTaskJournalRecord {
  version: typeof GATEWAY_TASK_JOURNAL_VERSION;
  id: string;
  status: GatewayTaskJournalStatus;
  cwd: string;
  workspaceId: string;
  principalId: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  publicationId?: string;
  error?: string;
  /** Optional durable Monitor binding and bounded terminal evidence. */
  sessionId?: string;
  memberId?: string;
  monitorEvents?: unknown[];
  resultEvidence?: unknown[];
}

export interface GatewayTaskJournalEnvelope {
  version: typeof GATEWAY_TASK_JOURNAL_VERSION;
  tasks: GatewayTaskJournalRecord[];
}

export interface TaskJournalOptions {
  /** JSON file path. If omitted, use the workspace v1 task state root. */
  path?: string;
  /** Alias accepted by Gateway hosts that call this a journalPath. */
  journalPath?: string;
  cwd?: string;
  now?: () => number;
  maxTasks?: number;
  /** Remove terminal records after this duration. Active records are never pruned. */
  terminalRetentionMs?: number;
}

export class GatewayTaskJournalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayTaskJournalError";
  }
}

function positiveInteger(value: unknown, label: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new GatewayTaskJournalError(`${label} must be a positive safe integer`);
  }
  return candidate as number;
}

function safeString(value: unknown, label: string, maximum: number, fallback?: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new GatewayTaskJournalError(`${label} must be a non-empty string`);
  }
  const normalized = candidate.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximum) {
    throw new GatewayTaskJournalError(`${label} exceeds ${maximum} UTF-8 bytes`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return safeString(value, label, maximum);
}

function timestamp(value: unknown, label: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new GatewayTaskJournalError(`${label} must be a non-negative safe integer`);
  }
  return candidate as number;
}

function optionalTimestamp(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return timestamp(value, label, 0);
}

function status(value: unknown): GatewayTaskJournalStatus {
  // A few early daemon snapshots used GatewayResult status names. Normalize
  // those on read without ever writing them back.
  if (value === "accepted") return "queued";
  if (value === "succeeded") return "completed";
  if (value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "lost") {
    return value;
  }
  throw new GatewayTaskJournalError(`Invalid task journal status: ${String(value)}`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeRecord(value: unknown, now: number): GatewayTaskJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayTaskJournalError("Task journal record must be an object");
  }
  const source = value as Record<string, unknown>;
  const createdAt = timestamp(source.createdAt, "task.createdAt", now);
  const rawCwd = safeString(source.cwd ?? source.workspacePath, "task.cwd", 4096, process.cwd());
  let cwd = rawCwd;
  try { cwd = canonicalizeWorkspacePath(rawCwd); } catch { /* retain a legacy path for read-boundary recovery */ }
  const workspaceId = safeString(
    source.workspaceId ?? source.workspace ?? source.workspacePath,
    "task.workspaceId",
    256,
    workspaceIdForPath(cwd),
  );
  const record: GatewayTaskJournalRecord = {
    version: GATEWAY_TASK_JOURNAL_VERSION,
    id: safeString(source.id ?? source.taskId, "task.id", 128),
    status: status(source.status ?? "queued"),
    cwd,
    workspaceId,
    principalId: safeString(source.principalId ?? source.ownerId, "task.principalId", 256, "unknown"),
    createdAt,
    updatedAt: timestamp(source.updatedAt, "task.updatedAt", createdAt),
    ...(optionalTimestamp(source.startedAt, "task.startedAt") === undefined ? {} : { startedAt: optionalTimestamp(source.startedAt, "task.startedAt") }),
    ...(optionalTimestamp(source.finishedAt, "task.finishedAt") === undefined ? {} : { finishedAt: optionalTimestamp(source.finishedAt, "task.finishedAt") }),
    ...(optionalString(source.publicationId ?? source.resultPublicationId, "task.publicationId", 256) === undefined ? {} : { publicationId: optionalString(source.publicationId ?? source.resultPublicationId, "task.publicationId", 256) }),
    ...(optionalString(source.error, "task.error", 16 * 1024) === undefined ? {} : { error: optionalString(source.error, "task.error", 16 * 1024) }),
    ...(optionalString(source.sessionId, "task.sessionId", 128) === undefined ? {} : { sessionId: optionalString(source.sessionId, "task.sessionId", 128) }),
    ...(optionalString(source.memberId, "task.memberId", 128) === undefined ? {} : { memberId: optionalString(source.memberId, "task.memberId", 128) }),
    ...(Array.isArray(source.monitorEvents) ? { monitorEvents: structuredClone(source.monitorEvents.slice(-512)) } : {}),
    ...(Array.isArray(source.resultEvidence) ? { resultEvidence: structuredClone(source.resultEvidence.slice(0, GATEWAY_HARD_LIMITS.maxTasks)) } : {}),
  };
  if (record.finishedAt !== undefined && record.startedAt !== undefined && record.finishedAt < record.startedAt) {
    throw new GatewayTaskJournalError("task.finishedAt precedes task.startedAt");
  }
  return record;
}

function normalizeEnvelope(value: unknown, now: number, maxTasks: number): GatewayTaskJournalEnvelope {
  if (value === undefined) return { version: GATEWAY_TASK_JOURNAL_VERSION, tasks: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // A pre-envelope journal was simply an array of task records.
    if (Array.isArray(value)) {
      if (value.length > maxTasks) throw new GatewayTaskJournalError(`task journal exceeds ${maxTasks} tasks`);
      return { version: GATEWAY_TASK_JOURNAL_VERSION, tasks: value.map((record) => normalizeRecord(record, now)) };
    }
    throw new GatewayTaskJournalError("Task journal must be an object");
  }
  const source = value as Record<string, unknown>;
  if (source.version !== undefined && source.version !== GATEWAY_TASK_JOURNAL_VERSION) {
    throw new GatewayTaskJournalError(`Unsupported task journal version ${String(source.version)}`);
  }
  const rawTasks = source.tasks ?? source.records ?? [];
  if (!Array.isArray(rawTasks)) throw new GatewayTaskJournalError("Task journal tasks must be an array");
  if (rawTasks.length > maxTasks) throw new GatewayTaskJournalError(`task journal exceeds ${maxTasks} tasks`);
  const tasks = rawTasks.map((record) => normalizeRecord(record, now));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new GatewayTaskJournalError(`Duplicate task journal id ${task.id}`);
    seen.add(task.id);
  }
  return { version: GATEWAY_TASK_JOURNAL_VERSION, tasks };
}

function terminal(statusValue: GatewayTaskJournalStatus): boolean {
  return (GATEWAY_TASK_TERMINAL_STATES as readonly string[]).includes(statusValue);
}

/** Normalize a record from a previous process without resuming its work. */
export function markGatewayTaskLost(record: GatewayTaskJournalRecord, now: number, reason = GATEWAY_TASK_LOST_ERROR): GatewayTaskJournalRecord {
  if (terminal(record.status)) return clone(record);
  return {
    ...record,
    status: "lost",
    updatedAt: now,
    finishedAt: now,
    error: reason.slice(0, 16 * 1024),
  };
}

/** Metadata journal used by the Gateway teammate registry. */
export class TaskJournal {
  readonly path: string;
  readonly maxTasks: number;
  private readonly now: () => number;
  private readonly terminalRetentionMs?: number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: TaskJournalOptions | string = {}) {
    const normalized = typeof options === "string" ? { path: options } : options;
    const cwd = normalized.cwd ?? process.cwd();
    this.path = normalized.path ?? normalized.journalPath ?? join(gatewayTasksRoot(cwd), GATEWAY_TASK_JOURNAL_FILE);
    this.maxTasks = positiveInteger(normalized.maxTasks, "maxTasks", GATEWAY_HARD_LIMITS.maxTasks);
    if (this.maxTasks > GATEWAY_HARD_LIMITS.maxTasks) {
      throw new GatewayTaskJournalError(`maxTasks exceeds ${GATEWAY_HARD_LIMITS.maxTasks}`);
    }
    this.now = normalized.now ?? (() => Date.now());
    this.terminalRetentionMs = normalized.terminalRetentionMs;
    if (this.terminalRetentionMs !== undefined && (!Number.isSafeInteger(this.terminalRetentionMs) || this.terminalRetentionMs < 1)) {
      throw new GatewayTaskJournalError("terminalRetentionMs must be a positive safe integer");
    }
  }

  async read(): Promise<GatewayTaskJournalEnvelope> {
    const raw = await readGatewayJson<unknown>(this.path, 4 * 1024 * 1024);
    return clone(normalizeEnvelope(raw, this.now(), this.maxTasks));
  }
  async load(): Promise<GatewayTaskJournalEnvelope> { return this.read(); }

  async list(): Promise<GatewayTaskJournalRecord[]> {
    return (await this.read()).tasks;
  }

  async get(id: string): Promise<GatewayTaskJournalRecord | undefined> {
    const found = (await this.read()).tasks.find((task) => task.id === id);
    return found === undefined ? undefined : clone(found);
  }

  async upsert(record: GatewayTaskJournalRecord): Promise<GatewayTaskJournalRecord> {
    return this.mutate(async (envelope) => {
      const normalized = normalizeRecord(record, this.now());
      const index = envelope.tasks.findIndex((task) => task.id === normalized.id);
      if (index < 0 && envelope.tasks.length >= this.maxTasks) {
        throw new GatewayTaskJournalError(`task journal is full (${this.maxTasks})`);
      }
      if (index < 0) envelope.tasks.push(normalized);
      else envelope.tasks[index] = normalized;
      return clone(normalized);
    });
  }
  async save(record: GatewayTaskJournalRecord): Promise<GatewayTaskJournalRecord> { return this.upsert(record); }

  async update(id: string, patch: Partial<Omit<GatewayTaskJournalRecord, "version" | "id">>): Promise<GatewayTaskJournalRecord | undefined> {
    return this.mutate(async (envelope) => {
      const index = envelope.tasks.findIndex((task) => task.id === id);
      if (index < 0) return undefined;
      const next = normalizeRecord({ ...envelope.tasks[index], ...patch, id }, this.now());
      envelope.tasks[index] = next;
      return clone(next);
    });
  }

  /** Mark every queued/running record lost and persist the recovery fence. */
  async recover(reason = GATEWAY_TASK_LOST_ERROR): Promise<GatewayTaskJournalRecord[]> {
    return this.mutate(async (envelope) => {
      const now = this.now();
      let changed = false;
      envelope.tasks = envelope.tasks.map((record) => {
        const recovered = markGatewayTaskLost(record, now, reason);
        if (recovered.status !== record.status || recovered.updatedAt !== record.updatedAt) changed = true;
        return recovered;
      });
      // mutate always writes the envelope; retaining the write makes recovery
      // durable even when the caller only uses this method as its startup hook.
      void changed;
      return clone(envelope.tasks);
    });
  }
  async recoverInterrupted(reason = GATEWAY_TASK_LOST_ERROR): Promise<GatewayTaskJournalRecord[]> { return this.recover(reason); }

  /** Apply configured terminal retention without changing active records. */
  async prune(): Promise<GatewayTaskJournalRecord[]> {
    return this.mutate(async (envelope) => clone(envelope.tasks));
  }

  private async mutate<T>(operation: (envelope: GatewayTaskJournalEnvelope) => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const raw = await readGatewayJson<unknown>(this.path, 4 * 1024 * 1024);
      const envelope = normalizeEnvelope(raw, this.now(), this.maxTasks);
      this.pruneExpired(envelope);
      const result = await operation(envelope);
      this.pruneExpired(envelope);
      await writeGatewayJsonAtomic(this.path, envelope, { mode: 0o600, maximumBytes: 4 * 1024 * 1024 });
      return result;
    } finally {
      release();
    }
  }

  private pruneExpired(envelope: GatewayTaskJournalEnvelope): void {
    if (this.terminalRetentionMs === undefined) return;
    const cutoff = this.now() - this.terminalRetentionMs;
    envelope.tasks = envelope.tasks.filter((record) => !terminal(record.status) || (record.finishedAt ?? record.updatedAt) > cutoff);
  }
}

export const GatewayTaskJournal = TaskJournal;
export const createTaskJournal = (options?: TaskJournalOptions | string): TaskJournal => new TaskJournal(options);
export const createGatewayTaskJournal = createTaskJournal;
export const isGatewayTaskTerminal = terminal;
export const normalizeGatewayTaskJournal = (value: unknown, now = Date.now(), maxTasks = GATEWAY_HARD_LIMITS.maxTasks): GatewayTaskJournalEnvelope => normalizeEnvelope(value, now, maxTasks);

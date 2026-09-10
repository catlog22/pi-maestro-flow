/** Bounded per-execution and per-workspace recovery journal for Monitor events. */
import type { GatewayEventGap, GatewayEventPage, GatewayJournalEvent } from "./event-contracts.ts";

export interface GatewayEventJournalOptions {
  maxEventsPerExecution?: number;
  maxBytesPerExecution?: number;
  maxEventsPerWorkspace?: number;
  maxBytesPerWorkspace?: number;
  maxEventBytes?: number;
}

export interface GatewayEventAppendInput extends Omit<GatewayJournalEvent, "eventId"> {
  eventId?: string;
}

type Listener = (event: GatewayJournalEvent) => void;
interface Retained { event: GatewayJournalEvent; bytes: number; retained: boolean; }
interface ExecutionBucket {
  workspaceId: string;
  sessionId: string;
  nextCursor: number;
  evictedThrough: number;
  records: Retained[];
  bytes: number;
  listeners: Set<Listener>;
}
interface WorkspaceBucket { records: Retained[]; count: number; bytes: number; }

const MiB = 1024 * 1024;
function bound(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label} must be a positive safe integer`);
  return result;
}
function copy<T>(value: T): T { return structuredClone(value); }

export class GatewayEventJournal {
  readonly maxEventsPerExecution: number;
  readonly maxBytesPerExecution: number;
  readonly maxEventsPerWorkspace: number;
  readonly maxBytesPerWorkspace: number;
  readonly maxEventBytes: number;
  private readonly executions = new Map<string, ExecutionBucket>();
  private readonly workspaces = new Map<string, WorkspaceBucket>();

  constructor(options: GatewayEventJournalOptions = {}) {
    this.maxEventsPerExecution = bound(options.maxEventsPerExecution, 10_000, "maxEventsPerExecution");
    this.maxBytesPerExecution = bound(options.maxBytesPerExecution, 4 * MiB, "maxBytesPerExecution");
    this.maxEventsPerWorkspace = bound(options.maxEventsPerWorkspace, 20_000, "maxEventsPerWorkspace");
    this.maxBytesPerWorkspace = bound(options.maxBytesPerWorkspace, 8 * MiB, "maxBytesPerWorkspace");
    this.maxEventBytes = bound(options.maxEventBytes, 64 * 1024, "maxEventBytes");
    if (this.maxEventBytes > this.maxBytesPerExecution || this.maxEventBytes > this.maxBytesPerWorkspace) {
      throw new Error("maxEventBytes cannot exceed journal byte bounds");
    }
  }

  append(input: GatewayEventAppendInput): GatewayJournalEvent {
    this.validateInput(input);
    const cursor = input.cursor;
    const event: GatewayJournalEvent = copy({ ...input, eventId: input.eventId ?? `${input.handle}:${cursor}` });
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (bytes > this.maxEventBytes) throw new Error(`Gateway event exceeds ${this.maxEventBytes} bytes`);
    const bucket = this.execution(input.handle, input.workspaceId, input.sessionId, input.cursor);
    if (cursor !== bucket.nextCursor) throw new Error(`Event cursor must be ${bucket.nextCursor} for handle ${input.handle}`);
    const record: Retained = { event, bytes, retained: true };
    bucket.records.push(record); bucket.bytes += bytes; bucket.nextCursor = cursor + 1;
    const workspace = this.workspaces.get(input.workspaceId) ?? { records: [], count: 0, bytes: 0 };
    this.workspaces.set(input.workspaceId, workspace);
    workspace.records.push(record); workspace.count += 1; workspace.bytes += bytes;
    this.enforceExecution(bucket);
    this.enforceWorkspace(workspace);
    for (const listener of [...bucket.listeners]) listener(copy(event));
    return copy(event);
  }

  page(handle: string, afterCursor = 0, limit = this.maxEventsPerExecution, throughCursor = Number.MAX_SAFE_INTEGER): GatewayEventPage {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new Error("cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive safe integer");
    const bucket = this.executions.get(handle);
    if (!bucket) return { events: [], oldestCursor: 1, latestCursor: 0, nextCursor: afterCursor };
    this.compact(bucket);
    const oldestCursor = bucket.records[0]?.event.cursor ?? bucket.nextCursor;
    const latestCursor = bucket.nextCursor - 1;
    const gap = afterCursor < oldestCursor - 1 ? retentionGap(afterCursor, oldestCursor) : undefined;
    const effective = gap?.resumeCursor ?? afterCursor;
    const events = bucket.records
      .filter((record) => record.retained && record.event.cursor > effective && record.event.cursor <= throughCursor)
      .slice(0, limit)
      .map((record) => copy(record.event));
    return { events, oldestCursor, latestCursor, nextCursor: events.at(-1)?.cursor ?? effective, ...(gap ? { gap } : {}) };
  }

  watermark(handle: string): number { return (this.executions.get(handle)?.nextCursor ?? 1) - 1; }
  stats(handle?: string): { events: number; bytes: number } {
    if (handle) {
      const bucket = this.executions.get(handle); if (!bucket) return { events: 0, bytes: 0 };
      this.compact(bucket); return { events: bucket.records.length, bytes: bucket.bytes };
    }
    let events = 0; let bytes = 0;
    for (const workspace of this.workspaces.values()) { events += workspace.count; bytes += workspace.bytes; }
    return { events, bytes };
  }

  subscribe(handle: string, listener: Listener): () => void {
    const bucket = this.executions.get(handle);
    if (!bucket) throw new Error("Monitor handle was not found in the event journal");
    bucket.listeners.add(listener);
    return () => { bucket.listeners.delete(listener); };
  }

  remove(handle: string): void {
    const bucket = this.executions.get(handle); if (!bucket) return;
    for (const record of bucket.records) this.evictRecord(record, bucket);
    bucket.listeners.clear(); this.executions.delete(handle);
  }

  private execution(handle: string, workspaceId: string, sessionId: string, initialCursor: number): ExecutionBucket {
    let bucket = this.executions.get(handle);
    if (!bucket) {
      bucket = { workspaceId, sessionId, nextCursor: initialCursor, evictedThrough: initialCursor - 1, records: [], bytes: 0, listeners: new Set() };
      this.executions.set(handle, bucket);
    } else if (bucket.workspaceId !== workspaceId || bucket.sessionId !== sessionId) {
      throw new Error("Monitor handle cannot move between a workspace or session");
    }
    return bucket;
  }

  private validateInput(input: GatewayEventAppendInput): void {
    for (const [label, value] of [["workspaceId", input.workspaceId], ["sessionId", input.sessionId], ["handle", input.handle], ["kind", input.kind]] as const) {
      if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(`${label} must be a bounded non-empty string`);
    }
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 1) throw new Error("event cursor must be a positive safe integer");
    if (!Number.isSafeInteger(input.at) || input.at < 0) throw new Error("event timestamp must be a non-negative safe integer");
  }

  private enforceExecution(bucket: ExecutionBucket): void {
    this.compact(bucket);
    while (bucket.records.length > this.maxEventsPerExecution || bucket.bytes > this.maxBytesPerExecution) {
      const record = bucket.records.shift(); if (!record) break;
      if (record.retained) this.evictRecord(record, bucket, true);
    }
  }

  private enforceWorkspace(workspace: WorkspaceBucket): void {
    while (workspace.count > this.maxEventsPerWorkspace || workspace.bytes > this.maxBytesPerWorkspace) {
      const record = workspace.records.shift(); if (!record) break;
      if (!record.retained) continue;
      const bucket = this.executions.get(record.event.handle);
      if (bucket) this.evictRecord(record, bucket);
    }
    if (workspace.records.length > workspace.count * 2 + 64) workspace.records = workspace.records.filter((record) => record.retained);
  }

  private evictRecord(record: Retained, bucket: ExecutionBucket, alreadyRemoved = false): void {
    if (!record.retained) return;
    record.retained = false;
    bucket.bytes -= record.bytes;
    bucket.evictedThrough = Math.max(bucket.evictedThrough, record.event.cursor);
    if (!alreadyRemoved) {
      const index = bucket.records.indexOf(record); if (index >= 0) bucket.records.splice(index, 1);
    }
    const workspace = this.workspaces.get(record.event.workspaceId);
    if (workspace) { workspace.count -= 1; workspace.bytes -= record.bytes; }
  }

  private compact(bucket: ExecutionBucket): void {
    if (bucket.records.some((record) => !record.retained)) bucket.records = bucket.records.filter((record) => record.retained);
  }
}

export function retentionGap(afterCursor: number, oldestCursor: number): GatewayEventGap {
  return { reason: "retention", fromCursor: afterCursor + 1, toCursor: oldestCursor - 1, resumeCursor: oldestCursor - 1 };
}

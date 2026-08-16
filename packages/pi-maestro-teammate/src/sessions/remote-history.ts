import type { SessionMessageKind } from "./session-core.ts";

export const REMOTE_HISTORY_ENTRY_TYPE = "teammate-remote-history";
export const REMOTE_HISTORY_VERSION = 1 as const;
export const REMOTE_HISTORY_MAX_BODY_CHARS = 8_000;
export const REMOTE_HISTORY_MAX_ENTRIES = 8_192;

export type RemoteHistoryKind = "message" | "receipt" | "lifecycle" | "result";
export type RemoteHistoryDirection = "outgoing" | "incoming";
export type RemoteHistoryStatus = "pending" | "queued" | "injected" | "accepted" | "rejected" | "timeout";
export type RemoteHistoryMode = "follow_up" | "steer";

export interface RemoteHistoryEntry {
  version: typeof REMOTE_HISTORY_VERSION;
  entryId: string;
  target: string;
  runId: string;
  targetId: string;
  kind: RemoteHistoryKind;
  direction: RemoteHistoryDirection;
  source: "remote";
  messageKind?: SessionMessageKind;
  requestedMode: RemoteHistoryMode;
  effectiveMode?: RemoteHistoryMode;
  body: string;
  bodyTruncated: boolean;
  status: RemoteHistoryStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export type RemoteHistoryEntryInput = Omit<RemoteHistoryEntry, "version" | "body" | "bodyTruncated"> & {
  body: string;
};

function validToken(value: unknown, maxLength = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedBody(body: string): { body: string; bodyTruncated: boolean } {
  if (body.length <= REMOTE_HISTORY_MAX_BODY_CHARS) return { body, bodyTruncated: false };
  return { body: `${body.slice(0, REMOTE_HISTORY_MAX_BODY_CHARS)}...`, bodyTruncated: true };
}

export function createRemoteHistoryEntry(input: RemoteHistoryEntryInput): RemoteHistoryEntry {
  const bounded = boundedBody(input.body);
  return Object.freeze({
    version: REMOTE_HISTORY_VERSION,
    ...input,
    ...bounded,
  });
}

export function parseRemoteHistoryEntry(value: unknown): RemoteHistoryEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Partial<RemoteHistoryEntry>;
  if (entry.version !== REMOTE_HISTORY_VERSION
    || !validToken(entry.entryId, 512)
    || !validToken(entry.runId)
    || entry.target !== `remote:${entry.runId}`
    || !validToken(entry.targetId)
    || !["message", "receipt", "lifecycle", "result"].includes(String(entry.kind))
    || (entry.direction !== "outgoing" && entry.direction !== "incoming")
    || entry.source !== "remote"
    || (entry.messageKind !== undefined && !["message", "coordination", "request", "status", "supervision"].includes(entry.messageKind))
    || (entry.requestedMode !== "follow_up" && entry.requestedMode !== "steer")
    || (entry.effectiveMode !== undefined && entry.effectiveMode !== "follow_up" && entry.effectiveMode !== "steer")
    || typeof entry.body !== "string"
    || entry.body.length > REMOTE_HISTORY_MAX_BODY_CHARS + 3
    || typeof entry.bodyTruncated !== "boolean"
    || !["pending", "queued", "injected", "accepted", "rejected", "timeout"].includes(String(entry.status))
    || !Number.isSafeInteger(entry.createdAt) || (entry.createdAt ?? -1) < 0
    || !Number.isSafeInteger(entry.updatedAt) || (entry.updatedAt ?? -1) < (entry.createdAt ?? 0)
    || !Number.isSafeInteger(entry.revision) || (entry.revision ?? 0) < 1) return undefined;
  return Object.freeze({ ...entry }) as RemoteHistoryEntry;
}

export function remoteHistoryEntryData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  return entry.type === "custom" && entry.customType === REMOTE_HISTORY_ENTRY_TYPE ? entry.data : undefined;
}

export function rebuildRemoteHistory(values: readonly unknown[]): RemoteHistoryEntry[] {
  const latest = new Map<string, RemoteHistoryEntry>();
  for (const value of values) {
    const parsed = parseRemoteHistoryEntry(remoteHistoryEntryData(value));
    if (!parsed) continue;
    const previous = latest.get(parsed.entryId);
    if (!previous
      || parsed.revision > previous.revision
      || (parsed.revision === previous.revision && parsed.updatedAt > previous.updatedAt)) {
      latest.set(parsed.entryId, parsed);
    }
  }
  return [...latest.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.entryId.localeCompare(right.entryId))
    .slice(0, REMOTE_HISTORY_MAX_ENTRIES);
}

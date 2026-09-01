import { resolve } from "node:path";
import {
  getSessionHostDirectoryRefresh,
  getSessionHostRegistry,
} from "pi-maestro-teammate/v1/sessions";
import {
  inventorySessionTranscripts,
  type SessionTranscriptInventoryEntry,
} from "../session/session-export.ts";
import {
  guardedDeleteUsageHistory,
  inventoryUsageHistory,
  type UsageHistoryInventoryEntry,
  type UsageLiveSessionProtection,
} from "../providers/usage-history.ts";
import type {
  ManagedDataContext,
  ManagedDataItem,
  ManagedDataSource,
  ManagedDeleteRequest,
} from "./data-manager.ts";

function transcriptProtection(entry: SessionTranscriptInventoryEntry, cwd: string, context?: ManagedDataContext): string {
  const isCurrentFile = context?.currentSessionFile
    ? resolve(entry.path) === resolve(context.currentSessionFile)
    : false;
  const isCurrentId = Boolean(context?.currentSessionId && entry.sessionId === context.currentSessionId);
  if (isCurrentFile || isCurrentId) return "current session transcript is active";
  if (!entry.headerValid) return "invalid transcript header; host-owned";
  if (entry.cwd !== cwd) return "transcript cwd ownership does not match this workspace";
  return "host-owned transcript; inactivity is unproven";
}

function transcriptItem(entry: SessionTranscriptInventoryEntry, cwd: string, context?: ManagedDataContext): ManagedDataItem {
  const protectionReason = transcriptProtection(entry, cwd, context);
  return {
    id: entry.id,
    title: entry.sessionId ?? entry.fileName,
    detail: [
      `File: ${entry.path}`,
      `Session: ${entry.sessionId ?? "unknown"}`,
      `Cwd: ${entry.cwd ?? "unknown"}`,
      `Header: ${entry.headerValid ? "valid" : "invalid"}`,
    ].join("\n"),
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.modified.toISOString(),
    revision: entry.revision,
    cleanupEligible: false,
    protectionReason,
  };
}

/** Read-only inventory of host transcript files in the active session directory. */
export function createSessionHistoryDataSource(): ManagedDataSource {
  return {
    id: "session-history",
    label: "Session transcripts",
    async load(cwd, context) {
      const sessionDir = context?.currentSessionDir;
      const entries = sessionDir ? await inventorySessionTranscripts(sessionDir) : [];
      const items = entries.map((entry) => transcriptItem(entry, cwd, context));
      return {
        sourceId: "session-history",
        label: "Session transcripts",
        scope: sessionDir ? "Current session directory (read-only)" : "No active session directory",
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        items,
      };
    },
    async delete() {
      return false;
    },
  };
}

function usageItem(entry: UsageHistoryInventoryEntry): ManagedDataItem {
  const title = entry.sessionIds.length === 1 ? entry.sessionIds[0]! : entry.fileName;
  return {
    id: entry.id,
    title,
    detail: [
      `File: ${entry.path}`,
      `Sessions: ${entry.sessionIds.join(", ") || "unknown"}`,
      `Cwds: ${entry.cwds.join(", ") || "unknown"}`,
    ].join("\n"),
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.modified.toISOString(),
    revision: entry.revision,
    cleanupEligible: entry.cleanupEligible,
    ...(entry.protectionReason ? { protectionReason: entry.protectionReason } : {}),
  };
}

async function authoritativeLiveSessionProtection(): Promise<UsageLiveSessionProtection> {
  const refresh = getSessionHostDirectoryRefresh();
  const registry = getSessionHostRegistry();
  if (!refresh || !registry) return { evidenceAvailable: false };
  try {
    await refresh();
    const refreshed = getSessionHostRegistry();
    if (!refreshed || refreshed !== registry) return { evidenceAvailable: false };
    const liveSessionIds = new Set(
      refreshed.listEndpoints()
        .filter((endpoint) => endpoint.kind === "root"
          && endpoint.status !== "settled"
          && (endpoint.scope === "local" || endpoint.scope === "workspace-peer")
          && Boolean(endpoint.sessionId))
        .map((endpoint) => endpoint.sessionId!),
    );
    return { evidenceAvailable: true, liveSessionIds };
  } catch {
    return { evidenceAvailable: false };
  }
}

async function guardedUsageDelete(request: ManagedDeleteRequest) {
  const liveProtection = await authoritativeLiveSessionProtection();
  return guardedDeleteUsageHistory({
    cwd: request.cwd,
    itemId: request.itemId,
    revision: request.revision,
    ...(request.context.currentSessionId ? { currentSessionId: request.context.currentSessionId } : {}),
    liveProtection,
  });
}

/** Workspace-scoped usage history with revision-checked production deletion. */
export function createUsageHistoryDataSource(): ManagedDataSource {
  const source: ManagedDataSource = {
    id: "usage-history",
    label: "Usage history",
    async load(cwd, context) {
      const liveProtection = await authoritativeLiveSessionProtection();
      const entries = await inventoryUsageHistory(cwd, context?.currentSessionId, liveProtection);
      const items = entries.map(usageItem);
      return {
        sourceId: "usage-history",
        label: "Usage history",
        scope: "Current workspace ownership (global store inventory)",
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        items,
      };
    },
    async delete(cwd, itemId, context) {
      const effectiveContext: ManagedDataContext = context ?? { cwd, now: new Date() };
      const snapshot = await source.load(cwd, effectiveContext);
      const item = snapshot.items.find((candidate) => candidate.id === itemId);
      if (!item?.revision || item.protectionReason) return false;
      const result = await guardedUsageDelete({ cwd, itemId, revision: item.revision, item, context: effectiveContext });
      return result.status === "deleted";
    },
    guardedDelete: guardedUsageDelete,
  };
  return source;
}

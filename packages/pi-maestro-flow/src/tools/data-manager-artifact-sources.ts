import { resolve } from "node:path";
import { formatBytes } from "../session/session-export.ts";
import {
  deleteAgentOutput,
  getAgentOutputStoreUsage,
  guardedDeleteAgentOutput,
  type AgentOutputStoreEntry,
} from "../teammate/agent-output-store.ts";
import {
  guardedCleanupSpillOwner,
  listSpillOwnersForSessions,
  spillSessionDigest,
} from "../compaction/tool-result-spill.ts";
import { inventorySessionTranscripts } from "../session/session-export.ts";
import {
  guardedDeleteArtifactExport,
  listArtifactExportOwnership,
} from "./session-artifact-export-store.ts";
import type { ManagedDataItem, ManagedDataSource } from "./data-manager.ts";

function outputItem(entry: AgentOutputStoreEntry): ManagedDataItem {
  const task = entry.name ?? entry.agent ?? entry.correlationId;
  return {
    id: entry.id,
    title: task,
    detail: [
      `Resource: agent://${entry.publicationId ?? entry.correlationId}`,
      `Captured: ${entry.capturedAt}`,
      `Size: ${formatBytes(entry.sizeBytes)}`,
      `Preview: ${entry.preview || "(empty)"}`,
    ].join("\n"),
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.capturedAt,
    revision: entry.revision,
    cleanupEligible: !entry.pinned,
    ...(entry.pinned ? { protectionReason: "pinned by an unsettled completion manifest" } : {}),
  };
}

export function createTeammateOutputDataSource(): ManagedDataSource {
  return {
    id: "teammate-output",
    label: "Teammate outputs",
    async load(cwd) {
      const usage = await getAgentOutputStoreUsage(cwd);
      return {
        sourceId: "teammate-output",
        label: "Teammate outputs",
        scope: "Current workspace",
        totalBytes: usage.totalBytes,
        capacity: { used: usage.records, limit: usage.maxRecords },
        items: usage.entries.map(outputItem),
      };
    },
    delete(cwd, itemId) {
      return deleteAgentOutput(itemId, cwd);
    },
    async guardedDelete(request) {
      const status = await guardedDeleteAgentOutput(request.itemId, request.cwd, request.revision);
      return {
        status,
        ...(status === "deleted" ? { reclaimedBytes: request.item.sizeBytes } : {}),
        ...(status === "protected" ? { message: "publication became pinned" } : {}),
        ...(status === "stale" ? { message: "publication revision changed" } : {}),
      };
    },
  };
}

export function createArtifactExportDataSource(): ManagedDataSource {
  return {
    id: "artifact-export",
    label: "Artifact exports",
    async load(cwd) {
      const entries = await listArtifactExportOwnership(cwd);
      return {
        sourceId: "artifact-export",
        label: "Artifact exports",
        scope: "Managed /artifact Markdown exports in current workspace",
        totalBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
        items: entries.map((entry): ManagedDataItem => ({
          id: entry.id,
          title: entry.ownership?.target ?? entry.id,
          detail: entry.ownership
            ? [`Source: ${entry.ownership.source}`, `Target: ${entry.ownership.target}`, `Digest: ${entry.ownership.contentDigest}`].join("\n")
            : `Ownership sidecar: ${entry.sidecarPath}`,
          sizeBytes: entry.sizeBytes,
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          revision: entry.revision,
          cleanupEligible: !entry.protectionReason,
          ...(entry.protectionReason ? { protectionReason: entry.protectionReason } : {}),
        })),
      };
    },
    async delete(cwd, itemId) {
      const item = (await listArtifactExportOwnership(cwd)).find((entry) => entry.id === itemId);
      if (!item || item.protectionReason) return false;
      return await guardedDeleteArtifactExport(cwd, itemId, item.revision) === "deleted";
    },
    async guardedDelete(request) {
      const status = await guardedDeleteArtifactExport(request.cwd, request.itemId, request.revision);
      return {
        status,
        ...(status === "deleted" ? { reclaimedBytes: request.item.sizeBytes } : {}),
        ...(status === "protected" ? { message: "ownership store, sidecar, or target validation failed" } : {}),
        ...(status === "partial" ? { message: "owned pathnames were quarantined, but cleanup did not fully finish" } : {}),
      };
    },
  };
}

async function workspaceSpillSessionIds(cwd: string, sessionDir: string | undefined): Promise<Set<string>> {
  if (!sessionDir) return new Set();
  const workspace = resolve(cwd);
  const entries = await inventorySessionTranscripts(sessionDir);
  return new Set(entries.flatMap((entry) => entry.headerValid
    && entry.sessionId
    && entry.cwd
    && resolve(entry.cwd) === workspace
    ? [entry.sessionId]
    : []));
}

export function createToolSpillDataSource(): ManagedDataSource {
  return {
    id: "tool-spill",
    label: "Tool result spills",
    async load(cwd, context) {
      const allowedSessionIds = await workspaceSpillSessionIds(cwd, context?.currentSessionDir);
      const currentDigest = context?.currentSessionId ? spillSessionDigest(context.currentSessionId) : undefined;
      const entries = await listSpillOwnersForSessions(allowedSessionIds);
      const items = entries.map((entry): ManagedDataItem => {
        const current = currentDigest !== undefined && entry.marker?.sessionDigest === currentDigest;
        const protectionReason = current ? "current session spill owner" : entry.protectionReason;
        return {
          id: entry.id,
          title: entry.marker
            ? `Session ${entry.marker.sessionId}${entry.marker.writerId ? ` · writer ${entry.marker.writerId}` : ""}`
            : `Untrusted spill root ${entry.id}`,
          detail: entry.marker
            ? [`PID: ${entry.marker.pid} (${entry.processState})`, `Heartbeat: ${entry.marker.heartbeatAt}`, `Owner token: ${entry.marker.ownerToken}`].join("\n")
            : `Path: ${entry.root}`,
          sizeBytes: entry.sizeBytes,
          ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
          revision: entry.revision,
          cleanupEligible: !protectionReason && entry.processState === "dead",
          ...(protectionReason ? { protectionReason } : {}),
        };
      });
      return {
        sourceId: "tool-spill",
        label: "Tool result spills",
        scope: context?.currentSessionDir
          ? "Validated current-workspace sessions in the active transcript directory"
          : "No validated active transcript directory",
        totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
        items,
      };
    },
    async delete(cwd, itemId, context) {
      const authorizeSession = async (sessionId: string) => (await workspaceSpillSessionIds(cwd, context?.currentSessionDir)).has(sessionId);
      const allowedSessionIds = await workspaceSpillSessionIds(cwd, context?.currentSessionDir);
      const entry = (await listSpillOwnersForSessions(allowedSessionIds)).find((candidate) => candidate.id === itemId);
      if (!entry?.marker || entry.protectionReason) return false;
      return guardedCleanupSpillOwner({
        sessionId: entry.marker.sessionId,
        ...(entry.marker.writerId ? { writerId: entry.marker.writerId } : {}),
        expectedRevision: entry.revision,
        ...(context?.currentSessionId ? { currentSessionId: context.currentSessionId } : {}),
        authorizeSession: () => authorizeSession(entry.marker!.sessionId),
      });
    },
    async guardedDelete(request) {
      const allowedSessionIds = await workspaceSpillSessionIds(request.cwd, request.context.currentSessionDir);
      const entry = (await listSpillOwnersForSessions(allowedSessionIds)).find((candidate) => candidate.id === request.itemId);
      if (!entry?.marker) return { status: "protected", message: "spill owner is not associated with this workspace's validated transcripts" };
      if (entry.revision !== request.revision) return { status: "stale", message: "spill owner marker changed" };
      if (request.context.currentSessionId && entry.marker.sessionDigest === spillSessionDigest(request.context.currentSessionId)) {
        return { status: "protected", message: "current session spill owner" };
      }
      if (entry.processState !== "dead" || entry.protectionReason) {
        return { status: "protected", message: entry.protectionReason ?? "spill owner is not confirmed dead" };
      }
      const deleted = await guardedCleanupSpillOwner({
        sessionId: entry.marker.sessionId,
        ...(entry.marker.writerId ? { writerId: entry.marker.writerId } : {}),
        expectedRevision: request.revision,
        ...(request.context.currentSessionId ? { currentSessionId: request.context.currentSessionId } : {}),
        authorizeSession: async () => (await workspaceSpillSessionIds(request.cwd, request.context.currentSessionDir)).has(entry.marker!.sessionId),
      });
      return deleted
        ? { status: "deleted", reclaimedBytes: request.item.sizeBytes }
        : { status: "stale", message: "spill owner failed final revision/realpath/liveness validation" };
    },
  };
}

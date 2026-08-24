import { createHash } from "node:crypto";
import type {
  ObservationDetail,
  ObservationPage,
  ObservationSnapshot,
  ObservationTarget,
} from "../public/v1/observation.ts";
import {
  workspaceWindowLifecycle,
  type WorkspaceMainSessionProgressEvent,
  type WorkspaceOwnerSnapshot,
} from "./workspace-peers.ts";

const CURSOR_VERSION = 1 as const;
const CURSOR_MAX_CHARS = 2_048;
const SUMMARY_TEXT_CHARS = 120;

interface WorkspaceSessionCursor {
  version: typeof CURSOR_VERSION;
  incarnation: string;
  sequence: number;
  revision: number;
}

export interface WorkspaceSessionObservationItem {
  cursor: number;
  kind: WorkspaceMainSessionProgressEvent["kind"];
  at: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  status?: "running" | "completed" | "failed";
  phase?: "agent_start" | "turn_start" | "turn_end" | "agent_end" | "agent_settled";
  /** Raw agent_settled is a lifecycle fact, not business-work completion. */
  provisional?: boolean;
}

const SESSION_CAPABILITIES = {
  inspect: true,
  wait: false,
  cancel: false,
  message: true,
  supervise: true,
} as const;

export function workspaceSessionObservationSnapshot(
  owner: WorkspaceOwnerSnapshot,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
  cursor?: string,
): ObservationSnapshot {
  const lifecycle = workspaceWindowLifecycle(owner);
  const progress = owner.mainProgress;
  const incarnation = sessionIncarnation(owner);
  const sequence = progress?.sequence ?? 0;
  const progressRevision = progress?.revision ?? progress?.updatedAt ?? 0;
  const revision = `workspace-session:${incarnation}:${sequence}:${progressRevision}`;
  const nextCursor = encodeCursor({
    version: CURSOR_VERSION,
    incarnation,
    sequence,
    revision: progressRevision,
  });
  const requested = cursor === undefined ? undefined : decodeCursor(cursor);

  if (cursor !== undefined && (!requested || requested.incarnation !== incarnation)) {
    return cursorError(owner, target, revision, "Session cursor belongs to another workspace window incarnation.");
  }
  if (requested && (requested.sequence > sequence
    || (requested.sequence === sequence && requested.revision > progressRevision))) {
    return cursorError(owner, target, revision, "Session cursor is ahead of the published session progress.");
  }

  const baseCursor = progress?.baseCursor ?? 0;
  const requestedSequence = requested?.sequence ?? baseCursor;
  const gap = requestedSequence < baseCursor;
  const items = progress
    ? progress.events.flatMap((event, index) => {
        const absoluteCursor = progress.baseCursor + index + 1;
        const revisedAssistantTail = requested !== undefined
          && absoluteCursor === requestedSequence
          && index === progress.events.length - 1
          && event.kind === "assistant"
          && requested.revision < progressRevision;
        return absoluteCursor > requestedSequence || revisedAssistantTail
          ? [projectEvent(event, absoluteCursor)]
          : [];
      })
    : [];
  const page: ObservationPage = {
    kind: "workspace-session",
    nextCursor,
    ...(gap ? { gap: true } : {}),
    items: detail === "summary" ? [] : items,
  };
  const windowName = owner.sessionName ?? `window:${owner.ownerId.slice(0, 8)}`;
  const latest = items.at(-1) ?? (progress?.events.length
    ? projectEvent(progress.events.at(-1)!, progress.sequence)
    : undefined);
  const summary = latest
    ? `${windowName} session · ${describeEvent(latest, true)} · sequence ${sequence}${gap ? " · gap" : ""}`
    : `${windowName} session · no published activity · sequence ${sequence}${gap ? " · gap" : ""}`;
  const detailLines = detail === "summary"
    ? undefined
    : [
        ...(gap ? [`Session progress gap: requested ${requestedSequence}, retained from ${baseCursor}.`] : []),
        ...(items.length === 0 ? ["No new root-session activity published."] : items.slice(-Math.max(1, lines)).map((item) => describeEvent(item, false))),
        `next-cursor=${nextCursor}`,
      ];

  return {
    target,
    found: true,
    nativeStatus: lifecycle.status,
    phase: lifecycle.settled ? "settled" : "active",
    summary,
    ...(detailLines ? { detail: detailLines } : {}),
    revision,
    page,
    updatedAt: progress?.updatedAt ?? owner.publishedAt,
    capabilities: SESSION_CAPABILITIES,
  };
}

function cursorError(
  owner: WorkspaceOwnerSnapshot,
  target: ObservationTarget,
  revision: string,
  message: string,
): ObservationSnapshot {
  return {
    target,
    found: true,
    nativeStatus: "stale-cursor",
    phase: "unknown",
    outcome: "failure",
    summary: message,
    revision,
    updatedAt: owner.mainProgress?.updatedAt ?? owner.publishedAt,
    capabilities: SESSION_CAPABILITIES,
    error: "stale-session-cursor",
  };
}

function sessionIncarnation(owner: WorkspaceOwnerSnapshot): string {
  return createHash("sha256")
    .update(owner.workspaceId)
    .update("\0")
    .update(owner.ownerId)
    .update("\0")
    .update(owner.ownerNonce)
    .update("\0")
    .update(owner.sessionId ?? "")
    .digest("hex")
    .slice(0, 32);
}

function encodeCursor(cursor: WorkspaceSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): WorkspaceSessionCursor | undefined {
  if (!cursor || cursor.length > CURSOR_MAX_CHARS) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<WorkspaceSessionCursor>;
    if (parsed.version !== CURSOR_VERSION
      || typeof parsed.incarnation !== "string"
      || !/^[a-f0-9]{32}$/.test(parsed.incarnation)
      || typeof parsed.sequence !== "number"
      || !Number.isSafeInteger(parsed.sequence)
      || parsed.sequence < 0
      || typeof parsed.revision !== "number"
      || !Number.isSafeInteger(parsed.revision)
      || parsed.revision < 0) return undefined;
    return {
      version: CURSOR_VERSION,
      incarnation: parsed.incarnation,
      sequence: parsed.sequence,
      revision: parsed.revision,
    };
  } catch {
    return undefined;
  }
}

function projectEvent(
  event: WorkspaceMainSessionProgressEvent,
  cursor: number,
): WorkspaceSessionObservationItem {
  switch (event.kind) {
    case "assistant":
      return { cursor, kind: event.kind, at: event.at, text: event.text };
    case "tool":
      return {
        cursor,
        kind: event.kind,
        at: event.at,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        status: event.status,
      };
    case "lifecycle":
      return {
        cursor,
        kind: event.kind,
        at: event.at,
        phase: event.phase,
        ...(event.phase === "agent_settled" ? { provisional: true } : {}),
      };
  }
}

function describeEvent(item: WorkspaceSessionObservationItem, summary: boolean): string {
  switch (item.kind) {
    case "assistant": {
      const text = (item.text ?? "").replace(/\s+/g, " ").trim();
      const bounded = summary && text.length > SUMMARY_TEXT_CHARS
        ? `${text.slice(0, SUMMARY_TEXT_CHARS - 3)}...`
        : text;
      return `[${item.cursor}] assistant${bounded ? `: ${bounded}` : ""}`;
    }
    case "tool":
      return `[${item.cursor}] tool ${item.toolName ?? "unknown"} ${item.status ?? "unknown"}`;
    case "lifecycle":
      return `[${item.cursor}] lifecycle ${item.phase ?? "unknown"}${item.provisional ? " (provisional)" : ""}`;
  }
}

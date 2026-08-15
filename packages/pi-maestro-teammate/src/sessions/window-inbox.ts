import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  WindowThreadStore,
  type WindowThreadDirection,
  type WindowThreadEntry,
  type WindowThreadStatus,
} from "./session-core.ts";

const MAX_ARCHIVE_SESSION_FILES = 500;
const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_INBOX_ENTRIES = 100;
const MAX_INBOX_BODY_CHARS = 2_000;

export interface WindowInboxQuery {
  session?: string;
  peer?: string;
  direction?: WindowThreadDirection;
  status?: WindowThreadStatus;
  limit?: number;
}

export interface WindowInboxEntry {
  sessionId: string;
  sessionName?: string;
  sessionFile: string;
  current: boolean;
  messageId: string;
  peerOwnerId: string;
  direction: WindowThreadDirection;
  source: WindowThreadEntry["source"];
  messageKind?: WindowThreadEntry["messageKind"];
  mode: WindowThreadEntry["mode"];
  effectiveMode?: WindowThreadEntry["effectiveMode"];
  body: string;
  bodyTruncated: boolean;
  status: WindowThreadStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface WindowInboxResult {
  entries: WindowInboxEntry[];
  scannedSessionCount: number;
  matchedSessionCount: number;
  skippedSessionFileCount: number;
  archiveTruncated: boolean;
  selector?: string;
}

interface ArchivedWindowThreadSession {
  sessionId: string;
  sessionName?: string;
  sessionFile: string;
  current: boolean;
  mtimeMs: number;
  entries: readonly WindowThreadEntry[];
}

interface ArchiveCandidate {
  sessionFile: string;
  mtimeMs: number;
  size: number;
}

interface ArchiveScan {
  sessions: ArchivedWindowThreadSession[];
  skippedSessionFileCount: number;
  truncated: boolean;
}

function sessionMetadata(entries: readonly unknown[]): { sessionId?: string; sessionName?: string } {
  let sessionId: string | undefined;
  let sessionName: string | undefined;
  for (const value of entries) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry.type === "session" && typeof entry.id === "string" && entry.id) sessionId = entry.id;
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
      sessionName = entry.name.trim();
    }
  }
  return { sessionId, sessionName };
}

function normalizeSessionSelector(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("session:") ? trimmed.slice("session:".length) : trimmed;
}

function normalizePeerSelector(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("owner:")) return trimmed;
  return trimmed.slice("owner:".length).split(":", 1)[0] ?? "";
}

function sessionLabel(session: ArchivedWindowThreadSession): string {
  return session.sessionName ?? session.sessionId;
}

function selectSessions(
  sessions: readonly ArchivedWindowThreadSession[],
  selector: string | undefined,
): ArchivedWindowThreadSession[] {
  if (!selector) return sessions.filter((session) => session.entries.length > 0);
  const normalized = normalizeSessionSelector(selector);
  if (!normalized) throw new Error("Inbox session selector cannot be empty.");
  if (normalized === "current") {
    const current = sessions.find((session) => session.current);
    if (!current) throw new Error("The current session file is unavailable within the inbox scan budget.");
    return [current];
  }

  const exact = sessions.filter((session) =>
    session.sessionId === normalized || session.sessionName === normalized
  );
  const partial = exact.length > 0 ? exact : sessions.filter((session) =>
    session.sessionId.startsWith(normalized)
    || session.sessionName?.startsWith(normalized)
    || session.sessionName?.endsWith(`-${normalized}`)
  );
  if (partial.length === 0) throw new Error(`No workspace session matched ${JSON.stringify(selector)} within the inbox scan budget.`);
  if (partial.length > 1) {
    const candidates = partial.slice(0, 8).map((session) => `${sessionLabel(session)} (${session.sessionId.slice(0, 8)})`);
    throw new Error(`Workspace session selector ${JSON.stringify(selector)} is ambiguous: ${candidates.join(", ")}.`);
  }
  return partial;
}

function shouldParseLine(line: string, lineIndex: number): boolean {
  return lineIndex === 0
    || line.includes("session_info")
    || line.includes("teammate-window-thread")
    || line.includes("teammate-message");
}

async function loadArchivedSession(
  sessionFile: string,
  currentSessionFile: string,
  mtimeMs: number,
  admittedBytes: number,
): Promise<ArchivedWindowThreadSession | undefined> {
  if (admittedBytes < 1) return undefined;
  try {
    const entries: unknown[] = [];
    const input = fs.createReadStream(sessionFile, {
      encoding: "utf8",
      start: 0,
      end: admittedBytes - 1,
    });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineIndex = 0;
    for await (const line of lines) {
      if (shouldParseLine(line, lineIndex)) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          // A malformed unrelated revision must not hide the remaining archive.
        }
      }
      lineIndex += 1;
    }
    const metadata = sessionMetadata(entries);
    if (!metadata.sessionId) return undefined;
    const store = new WindowThreadStore({ limit: 10_000 });
    const threadEntries = store.rebuild(entries).entries;
    return {
      sessionId: metadata.sessionId,
      ...(metadata.sessionName ? { sessionName: metadata.sessionName } : {}),
      sessionFile,
      current: path.resolve(sessionFile) === currentSessionFile,
      mtimeMs,
      entries: threadEntries,
    };
  } catch {
    return undefined;
  }
}

function archiveCandidates(
  currentSessionFile: string,
  selector: string | undefined,
): { candidates: ArchiveCandidate[]; skippedSessionFileCount: number; truncated: boolean } {
  const resolvedCurrent = path.resolve(currentSessionFile);
  const sessionDir = path.dirname(resolvedCurrent);
  let skippedSessionFileCount = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return { candidates: [], skippedSessionFileCount: 1, truncated: false };
  }

  const candidates: ArchiveCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const sessionFile = path.join(sessionDir, entry.name);
    try {
      const stat = fs.statSync(sessionFile);
      candidates.push({ sessionFile, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      skippedSessionFileCount += 1;
    }
  }
  if (!candidates.some((candidate) => path.resolve(candidate.sessionFile) === resolvedCurrent) && fs.existsSync(resolvedCurrent)) {
    try {
      const stat = fs.statSync(resolvedCurrent);
      candidates.push({ sessionFile: resolvedCurrent, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      skippedSessionFileCount += 1;
    }
  }

  const normalized = selector === undefined ? undefined : normalizeSessionSelector(selector);
  const currentOnly = normalized === "current";
  const idLike = normalized !== undefined && /^[0-9a-f][0-9a-f-]{7,}$/i.test(normalized);
  const focused = currentOnly
    ? candidates.filter((candidate) => path.resolve(candidate.sessionFile) === resolvedCurrent)
    : idLike
      ? candidates.filter((candidate) => path.basename(candidate.sessionFile).includes(normalized))
      : candidates;
  const selected = focused.length > 0 ? focused : candidates;
  selected.sort((left, right) => right.mtimeMs - left.mtimeMs || left.sessionFile.localeCompare(right.sessionFile));
  const truncated = selected.length > MAX_ARCHIVE_SESSION_FILES;
  return {
    candidates: selected.slice(0, MAX_ARCHIVE_SESSION_FILES),
    skippedSessionFileCount,
    truncated,
  };
}

async function archivedSessions(currentSessionFile: string, selector: string | undefined): Promise<ArchiveScan> {
  const resolvedCurrent = path.resolve(currentSessionFile);
  const candidateScan = archiveCandidates(resolvedCurrent, selector);
  const sessions: ArchivedWindowThreadSession[] = [];
  let skippedSessionFileCount = candidateScan.skippedSessionFileCount;
  let truncated = candidateScan.truncated;
  let totalBytes = 0;
  const focused = selector !== undefined;
  const perFileBudget = focused ? MAX_ARCHIVE_TOTAL_BYTES : MAX_ARCHIVE_FILE_BYTES;

  for (const candidate of candidateScan.candidates) {
    if (candidate.size > perFileBudget || totalBytes + candidate.size > MAX_ARCHIVE_TOTAL_BYTES) {
      skippedSessionFileCount += 1;
      truncated = true;
      continue;
    }
    totalBytes += candidate.size;
    const session = await loadArchivedSession(
      candidate.sessionFile,
      resolvedCurrent,
      candidate.mtimeMs,
      candidate.size,
    );
    if (session) sessions.push(session);
    else skippedSessionFileCount += 1;
  }
  return { sessions, skippedSessionFileCount, truncated };
}

function projectInboxEntry(session: ArchivedWindowThreadSession, entry: WindowThreadEntry): WindowInboxEntry {
  const bodyTruncated = entry.body.length > MAX_INBOX_BODY_CHARS;
  return {
    sessionId: session.sessionId,
    ...(session.sessionName ? { sessionName: session.sessionName } : {}),
    sessionFile: session.sessionFile,
    current: session.current,
    messageId: entry.messageId,
    peerOwnerId: entry.peerOwnerId,
    direction: entry.direction,
    source: entry.source,
    ...(entry.messageKind ? { messageKind: entry.messageKind } : {}),
    mode: entry.mode,
    ...(entry.effectiveMode ? { effectiveMode: entry.effectiveMode } : {}),
    body: bodyTruncated ? `${entry.body.slice(0, MAX_INBOX_BODY_CHARS)}...` : entry.body,
    bodyTruncated,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
  };
}

export function resolveWindowInboxAnchor(
  mainSessionFile: string | null | undefined,
  contextSessionFile: string | null | undefined,
): string | undefined {
  return mainSessionFile ?? contextSessionFile ?? undefined;
}

export async function loadWorkspaceWindowInbox(
  currentSessionFile: string | null | undefined,
  query: WindowInboxQuery = {},
): Promise<WindowInboxResult> {
  if (!currentSessionFile) throw new Error("Window inbox is unavailable because the current session file is unknown.");
  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INBOX_ENTRIES) {
    throw new Error(`Inbox limit must be an integer between 1 and ${MAX_INBOX_ENTRIES}.`);
  }
  const peer = query.peer === undefined ? undefined : normalizePeerSelector(query.peer);
  if (query.peer !== undefined && !peer) throw new Error("Inbox peer selector cannot be empty.");

  const archive = await archivedSessions(currentSessionFile, query.session);
  const selected = selectSessions(archive.sessions, query.session);
  const entries = selected.flatMap((session) => session.entries
    .filter((entry) => query.direction === undefined || entry.direction === query.direction)
    .filter((entry) => query.status === undefined || entry.status === query.status)
    .filter((entry) => peer === undefined || entry.peerOwnerId === peer || entry.peerOwnerId.startsWith(peer))
    .map((entry) => projectInboxEntry(session, entry)))
    .sort((left, right) =>
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || left.sessionId.localeCompare(right.sessionId)
      || left.messageId.localeCompare(right.messageId)
    )
    .slice(0, limit);
  return {
    entries,
    scannedSessionCount: archive.sessions.length,
    matchedSessionCount: new Set(entries.map((entry) => entry.sessionId)).size,
    skippedSessionFileCount: archive.skippedSessionFileCount,
    archiveTruncated: archive.truncated,
    ...(query.session ? { selector: query.session } : {}),
  };
}

function indentBody(body: string): string {
  return body.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

export function formatWorkspaceWindowInbox(result: WindowInboxResult): string {
  const warning = result.archiveTruncated
    ? " Archive scan reached its byte or file budget; narrow the query with session."
    : "";
  if (result.entries.length === 0) {
    const empty = result.selector
      ? `No persisted window messages matched session ${JSON.stringify(result.selector)}.`
      : "No persisted window messages matched the inbox filters.";
    return `${empty}${warning}`;
  }
  const header = `Window inbox: ${result.entries.length} message${result.entries.length === 1 ? "" : "s"} across ${result.matchedSessionCount} session${result.matchedSessionCount === 1 ? "" : "s"}.${warning}`;
  const rows = result.entries.map((entry) => {
    const session = entry.sessionName ?? entry.sessionId.slice(0, 8);
    const time = new Date(entry.updatedAt).toISOString();
    const effectiveMode = entry.effectiveMode ?? "unknown";
    const metadata = `${time} | session=${session} | ${entry.direction}/${entry.status} | source=${entry.source} | kind=${entry.messageKind ?? "message"} | requested=${entry.mode} | effective=${effectiveMode} | peer=owner:${entry.peerOwnerId} | id=${entry.messageId}`;
    return `${metadata}\n${indentBody(entry.body)}`;
  });
  return [header, ...rows].join("\n");
}

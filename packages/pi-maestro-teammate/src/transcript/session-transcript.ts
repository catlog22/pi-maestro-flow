/**
 * TranscriptService — reads a teammate's pi session file and projects it into
 * display rows for the transcript viewer.
 *
 * Data model: each teammate runs as an isolated pi subprocess with its own
 * session file (JSONL entry tree) at a deterministic per-correlation location
 * under the parent session's root (see execution-infra getTeammateSessionRoot /
 * correlationSessionDirectoryName). The parent knows the exact file at runtime
 * via the teammate_session_ready IPC; cold starts derive it from the parent
 * session file. This module only READS session files — no IPC, no protocol.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  correlationSessionDirectoryName,
  getTeammateSessionRoot,
} from "../runs/execution-infra.ts";
import {
  TEAMMATE_SESSION_CUSTOM_TYPE,
  type HistoricalAgentRecord,
  type TranscriptLoad,
  type TranscriptRow,
} from "../shared/transcript.ts";

/** Tool argument serialization cap — full args stay in the session file. */
const MAX_TOOL_ARGS_TEXT = 4096;
/** Fallback display cap for raw log lines in memory mode. */
/** Best-effort local shapes for coding-agent custom messages (not exported
 *  from the package root; session files are parsed without validation so the
 *  shapes are treated as loose). */
interface BashExecutionMessageShape {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  timestamp?: number;
}

interface CustomMessageShape {
  role: "custom";
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display: boolean;
  timestamp?: number;
}

type MessageShape =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessageShape
  | CustomMessageShape;

const MAX_MEMORY_LOG_LINES = 500;

export interface TranscriptSource {
  correlationId: string;
  /** Live session file reported via teammate_session_ready IPC. */
  sessionFile?: string;
  /** Parent session file — cold-start derivation of the per-correlation dir. */
  parentSessionFile?: string;
  lastResult?: string;
  outputLog?: string[];
}

/**
 * Resolve the session file for an agent: runtime-reported path first, then
 * cold-start derivation from the parent session file. Returns null when the
 * agent has no persisted session.
 */
export function resolveSessionFile(source: TranscriptSource): string | null {
  if (source.sessionFile && fs.existsSync(source.sessionFile)) {
    return source.sessionFile;
  }
  if (source.parentSessionFile && fs.existsSync(source.parentSessionFile)) {
    const root = getTeammateSessionRoot(source.parentSessionFile);
    if (root) {
      const dir = path.join(
        root,
        correlationSessionDirectoryName(source.correlationId),
      );
      const file = findLatestSessionFile(dir);
      if (file) return file;
    }
  }
  return null;
}

/** Newest *.jsonl in a directory, or null. Per-candidate fail-soft:
 *  non-files and unreadable stats are skipped, never thrown. */
export function findLatestSessionFile(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name);
    try {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // File vanished between readdir and stat (or unreadable) — skip it.
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  return candidates[0]?.file ?? null;
}

/**
 * First *.jsonl in a directory whose summary validates (real session header),
 * newest first. Used by history scans so a crashed-empty file cannot shadow a
 * valid older session in the same directory.
 */
export function findValidSessionFile(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name);
    try {
      candidates.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // Skip vanished/unreadable candidates.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
  for (const { file } of candidates) {
    const summary = summarizeSessionFile(file);
    if (summary) return file;
  }
  return null;
}

/**
 * Load the full conversation for an agent from its session file and project it
 * into display rows. Falls back to in-memory activity when no session file is
 * available.
 *
 * Display ordering walks the parent chain from the last written entry to root
 * (chronological, compaction entries kept in place as boundary meta rows).
 * pi's buildContextEntries is NOT used: it reorders compaction to the front
 * and drops summarized prefixes for LLM context, which is wrong for a viewer.
 */
export async function loadTranscript(source: TranscriptSource): Promise<TranscriptLoad> {
  const file = resolveSessionFile(source);
  if (!file) return loadTranscriptFromMemory(source);
  try {
    const content = fs.readFileSync(file, "utf8");
    const fileEntries = parseSessionEntries(content);
    const entries = fileEntries.filter(
      (entry): entry is SessionEntry =>
        entry.type !== "session" &&
        "id" in entry &&
        typeof entry.id === "string",
    );
    if (entries.length === 0) return loadTranscriptFromMemory(source);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const chain = buildSessionPath(entries, byId);
    const rows: TranscriptRow[] = [];
    for (const entry of chain) {
      try {
        rows.push(...entryToRows(entry));
      } catch {
        // A syntactically valid but malformed entry must not drop the whole
        // disk transcript — surface it as a meta row and keep the rest.
        rows.push({
          kind: "meta",
          role: "system",
          text: "⚠ unreadable entry",
          timestamp: 0,
          entryId: entry.id,
        });
      }
    }
    // anchorId = the last entry that actually produced a row, so consumers
    // can always find the anchor among the returned rows.
    let anchorId: string | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.entryId) {
        anchorId = rows[i]!.entryId!;
        break;
      }
    }
    return {
      rows,
      anchorId,
      source: "session",
      compacted: chain.some((entry) => entry.type === "compaction"),
      sessionFile: file,
    };
  } catch {
    return loadTranscriptFromMemory(source);
  }
}

/**
 * Root→leaf chain from the last written entry (child sessions are append-only
 * during a run and never branch mid-run). Cycle-guarded for hand-edited files.
 */
export function buildSessionPath(
  entries: SessionEntry[],
  byId: Map<string, SessionEntry>,
): SessionEntry[] {
  const leaf = entries[entries.length - 1];
  if (!leaf) return [];
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

/** Session entry → display rows. Non-message entries collapse to meta rows. */
export function entryToRows(entry: SessionEntry): TranscriptRow[] {
  switch (entry.type) {
    case "message":
      return projectMessage(entry);
    case "compaction":
      return [
        metaRow(
          entry.timestamp,
          `↕ compacted ${entry.tokensBefore} tokens — ${firstLine(entry.summary)}`,
          entry.id,
        ),
      ];
    case "branch_summary":
      return entry.summary
        ? [metaRow(entry.timestamp, `↳ branch — ${firstLine(entry.summary)}`, entry.id)]
        : [];
    case "model_change":
      return [
        metaRow(entry.timestamp, `Model · ${entry.provider}/${entry.modelId}`, entry.id),
      ];
    case "thinking_level_change":
      return [metaRow(entry.timestamp, `Thinking · ${entry.thinkingLevel}`, entry.id)];
    case "custom_message":
      // display:false is pi's "hidden entirely" contract — never surface it.
      if (entry.display !== true) return [];
      return [
        {
          kind: "system",
          role: "custom",
          text: extractContentText(entry.content),
          timestamp: Date.parse(entry.timestamp) || 0,
          entryId: entry.id,
        },
      ];
    default:
      // custom / label / session_info are display or state entries.
      return [];
  }
}

/** One pi message → rows (assistant blocks split by block type). */
export function projectMessage(entry: SessionMessageEntry): TranscriptRow[] {
  const message = entry.message as MessageShape | null | undefined;
  const base = {
    entryId: entry.id,
    timestamp:
      message && typeof message.timestamp === "number"
        ? message.timestamp
        : Date.parse(entry.timestamp) || 0,
  };

  if (!message || typeof message !== "object") return [];

  if (message.role === "user") {
    return [
      {
        ...base,
        kind: "user",
        role: "user",
        text: extractContentText(message.content),
      },
    ];
  }

  if (message.role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const rows: TranscriptRow[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking") {
        rows.push({
          ...base,
          kind: "thinking",
          role: "assistant",
          text: block.thinking,
        });
      } else if (block.type === "toolCall") {
        rows.push({
          ...base,
          kind: "tool",
          role: "assistant",
          text: serializeToolArgs(block.arguments),
          toolName: block.name,
          toolCallId: block.id,
        });
      } else if (block.type === "text") {
        rows.push({
          ...base,
          kind: "assistant",
          role: "assistant",
          text: block.text,
          model: message.model,
        });
      }
    }
    if (rows.length === 0) {
      // Tool-only turns still deserve a row for continuity.
      rows.push({
        ...base,
        kind: "assistant",
        role: "assistant",
        text: "",
        model: message.model,
      });
    }
    return rows;
  }

  if (message.role === "toolResult") {
    return [
      {
        ...base,
        kind: "tool_result",
        role: "toolResult",
        text: extractContentText(message.content),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        isError: message.isError,
      },
    ];
  }

  // Coding-agent custom roles: bash executions (the ! command) and
  // extension-injected custom messages. Session files are parsed without
  // validation, so keep these loose and fail-soft.
  if (message.role === "bashExecution") {
    const output = typeof message.output === "string" ? message.output : "";
    const exit = typeof message.exitCode === "number"
      ? ` · exit ${message.exitCode}`
      : message.cancelled
        ? " · cancelled"
        : "";
    const text = [`$ ${message.command}`, ...output.split("\n").slice(0, 3)]
      .filter((line) => line.trim() !== "")
      .join("\n") + exit;
    return [{ ...base, kind: "system", role: "bashExecution", text }];
  }

  if (message.role === "custom") {
    // display:false is pi's "hidden entirely" contract.
    if (message.display !== true) return [];
    return [
      {
        ...base,
        kind: "system",
        role: "custom",
        text: extractContentText(message.content),
      },
    ];
  }

  return [];
}

/** Best-effort fallback when no session file exists (e.g. --no-session). */
export function loadTranscriptFromMemory(source: TranscriptSource): TranscriptLoad {
  const rows: TranscriptRow[] = [];
  const log = source.outputLog ?? [];
  const bounded = log.length > MAX_MEMORY_LOG_LINES
    ? log.slice(-MAX_MEMORY_LOG_LINES)
    : log;
  for (const line of bounded) {
    // Same heuristic as the attach overlay: inbound arrows are system lines,
    // timestamped entries are tool activity, everything else is info.
    const kind: TranscriptRow["kind"] = line.includes("◀ ")
      ? "system"
      : /\[\d{2}:\d{2}:\d{2}\]/.test(line)
        ? "tool"
        : "system";
    rows.push({ kind, role: "system", text: line, timestamp: 0 });
  }
  if (source.lastResult) {
    rows.push({
      kind: "assistant",
      role: "assistant",
      text: source.lastResult,
      timestamp: 0,
    });
  }
  return { rows, anchorId: null, source: "memory", compacted: false };
}

// ---------------------------------------------------------------------------
// History recovery (cold starts)
// ---------------------------------------------------------------------------

export interface WorkspaceSessionScan {
  sessionFile: string;
  sessionId?: string;
  startedAt?: number;
  /** File mtime — deterministic tie-breaker for newest-first ordering. */
  mtimeMs: number;
  messageCount: number;
  firstMessage: string;
}

/**
 * Enumerate teammate sessions under the parent session root (directory = the
 * per-correlation session dir). Used to rebuild the history registry after a
 * process restart, for sessions that predate custom-entry recording.
 */
export function scanWorkspaceSessionDirs(parentSessionFile: string): WorkspaceSessionScan[] {
  const root = getTeammateSessionRoot(parentSessionFile);
  if (!root) return [];
  let dirs: string[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(root, dirent.name));
  } catch {
    return [];
  }
  const scans: WorkspaceSessionScan[] = [];
  for (const dir of dirs) {
    const file = findValidSessionFile(dir);
    if (!file) continue;
    const summary = summarizeSessionFile(file);
    if (summary) scans.push(summary);
  }
  return scans.sort(
    (a, b) =>
      (b.startedAt ?? 0) - (a.startedAt ?? 0)
      || b.mtimeMs - a.mtimeMs
      || a.sessionFile.localeCompare(b.sessionFile),
  );
}

/**
 * Header + active-chain summary of one session file, or null when the file is
 * not a valid session (missing/positional header, unreadable). Only the active
 * leaf chain contributes messages — abandoned branches are excluded, matching
 * what loadTranscript displays.
 */
export function summarizeSessionFile(file: string): WorkspaceSessionScan | null {
  try {
    const stat = fs.statSync(file);
    const fileEntries = parseSessionEntries(fs.readFileSync(file, "utf8"));
    // A valid session file starts with a session header carrying a string id
    // (upstream authority: SessionManager.create writes the header first).
    const header = fileEntries[0];
    if (
      !header
      || header.type !== "session"
      || typeof (header as { id?: unknown }).id !== "string"
    ) {
      return null;
    }
    const entries = fileEntries.filter(
      (entry): entry is SessionEntry =>
        entry.type !== "session" &&
        "id" in entry &&
        typeof entry.id === "string",
    );
    if (entries.length === 0) return null;
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const chain = buildSessionPath(entries, byId);
    const messages = chain.filter((entry) => entry.type === "message");
    const first =
      messages.length > 0
        ? firstMessageText(messages[0] as SessionMessageEntry)
        : "";
    return {
      sessionFile: file,
      sessionId: (header as { id?: string }).id,
      startedAt:
        typeof (header as { timestamp?: string }).timestamp === "string"
          ? Date.parse((header as { timestamp: string }).timestamp) || undefined
          : undefined,
      mtimeMs: stat.mtimeMs,
      messageCount: messages.length,
      firstMessage: first,
    };
  } catch {
    return null;
  }
}

/**
 * Rebuild historical agent records from parent-session custom entries.
 * Entries with a mismatched customType or invalid shape are skipped.
 */
export function parseTeammateSessionRecords(entries: SessionEntry[]): HistoricalAgentRecord[] {
  const records: HistoricalAgentRecord[] = [];
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== TEAMMATE_SESSION_CUSTOM_TYPE
    ) {
      continue;
    }
    const data = entry.data as Partial<HistoricalAgentRecord> | undefined;
    if (!data || typeof data.agent !== "string") continue;
    const record: HistoricalAgentRecord = {
      agent: data.agent,
      startedAt:
        typeof data.startedAt === "number"
          ? data.startedAt
          : Date.parse(entry.timestamp) || 0,
      status:
        data.status === "failed" || data.status === "terminated"
          ? data.status
          : "completed",
    };
    if (typeof data.correlationId === "string") {
      record.correlationId = data.correlationId;
    }
    if (typeof data.name === "string") record.name = data.name;
    if (typeof data.sessionFile === "string") {
      record.sessionFile = data.sessionFile;
    }
    if (typeof data.lastActivityAt === "number") {
      record.lastActivityAt = data.lastActivityAt;
    }
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

function metaRow(timestamp: string, text: string, entryId?: string): TranscriptRow {
  return {
    kind: "meta",
    role: "system",
    text,
    timestamp: Date.parse(timestamp) || 0,
    ...(entryId ? { entryId } : {}),
  };
}

function extractContentText(
  content: string | Array<TextContent | ImageContent> | undefined,
): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  // Malformed persisted data (e.g. numeric content) must not throw — render
  // an empty row rather than surfacing an unreadable-entry meta row.
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(`[image:${block.mimeType}]`);
    }
  }
  return parts.join("\n");
}

function serializeToolArgs(args: Record<string, unknown>): string {
  if (args === undefined || args === null) return "";
  try {
    const text = JSON.stringify(args, null, 2);
    return text.length > MAX_TOOL_ARGS_TEXT
      ? `${text.slice(0, MAX_TOOL_ARGS_TEXT)}…`
      : text;
  } catch {
    return String(args);
  }
}

function firstLine(text: string): string {
  const first = text.split("\n", 1)[0] ?? "";
  return first.length > 120 ? `${first.slice(0, 120)}…` : first;
}

function firstMessageText(entry: SessionMessageEntry): string {
  const message = entry.message as
    | { role?: string; content?: unknown; timestamp?: number }
    | undefined;
  const content = message?.content;
  if (typeof content === "string") return firstLine(content);
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    return firstLine(text);
  }
  return "";
}

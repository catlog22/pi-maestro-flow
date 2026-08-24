import type {
  ObservationDetail,
  ObservationPage,
  ObservationReadOptions,
  ObservationSnapshot,
  ObservationTarget,
} from "../public/v1/observation.ts";
import type {
  RemoteDriverEvent,
  RemoteRunSnapshot,
  RemoteToolEvent,
  RemoteUsage,
} from "../remote/types.ts";

/**
 * Remote (ACP / pi-rpc) `view="turns"` and `view="session"` projections.
 *
 * A remote run streams `RemoteDriverEvent`s (assistant text, tool calls/results,
 * usage, native). Both drivers emit assistant text as **streaming chunks** —
 * ACP emits one `text` event per `agent_message_chunk`, pi-rpc one per
 * `text_delta` — so a single assistant message arrives as many `text` events.
 * This module retains a bounded, sanitized structured event ring on the run
 * record and projects it into turn-grouped and cursor-paginated observation
 * views, mirroring the workspace peer projections.
 *
 * Turn grouping coalesces consecutive assistant text chunks into one turn: a
 * new turn opens only when a tool result precedes the next text, or at run
 * start. ACP/pi-rpc carry no explicit turn_start/turn_end lifecycle.
 */

export const REMOTE_PROGRESS_RING_MAX_EVENTS = 64;
/** Total serialized byte budget for the ring; oldest events evict past it. */
export const REMOTE_PROGRESS_RING_MAX_BYTES = 256 * 1024;
const REMOTE_TEXT_BYTES = 8 * 1024;
/** Byte bound for any single native/tool summary payload. */
const REMOTE_PAYLOAD_BYTES = 2 * 1024;
const REMOTE_TURN_PREVIEW_CHARS = 100;
const REMOTE_LINE_CHARS = 4_000;
const REMOTE_SESSION_SUMMARY_CHARS = 120;

const CURSOR_VERSION = 1 as const;
const CURSOR_MAX_CHARS = 2_048;

/** One retained structured event, normalized from RemoteDriverEvent. */
export interface RemoteProgressEvent {
  /** Monotonic 1-based absolute cursor over the run's lifetime. */
  cursor: number;
  at: number;
  kind: "assistant" | "tool" | "usage" | "native";
  /** assistant text (bounded) — present for kind="assistant". */
  text?: string;
  toolCallId?: string;
  toolName?: string;
  /** tool phase mapped to the workspace-style status vocabulary. */
  status?: "running" | "completed" | "failed";
  /** usage snapshot — present for kind="usage". */
  usage?: RemoteUsage;
  /** native event name — present for kind="native". */
  name?: string;
  /**
   * Tool result summary (bounded string). Native event data is deliberately
   * NOT retained: boundedData at the driver layer only checks serialized
   * size, it does not redact credentials or reasoning. The projection surfaces
   * only the native event name, never its raw payload.
   */
  summary?: string;
}

/**
 * Bounded structured event ring retained on the run record. Mirrors
 * WorkspaceMainSessionProgress: sequence is monotonic across the run lifetime;
 * baseCursor is the absolute cursor *before* events[0]; the ring evicts oldest
 * when it exceeds the event-count OR byte budget so absolute cursors stay
 * stable for cursor-based reads.
 */
export interface RemoteProgressRing {
  sequence: number;
  baseCursor: number;
  updatedAt: number;
  events: RemoteProgressEvent[];
  /** Current serialized byte size of the retained events (for budgeting). */
  bytes: number;
}

export function createRemoteProgressRing(): RemoteProgressRing {
  return { sequence: 0, baseCursor: 0, updatedAt: 0, events: [], bytes: 0 };
}

function boundedText(value: string, maxBytes: number): string {
  const trimmed = value.slice(0, maxBytes * 4);
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;
  const buf = Buffer.from(trimmed, "utf8").subarray(0, maxBytes);
  return buf.toString("utf8").replace(/\uFFFD$/, "");
}

/** Byte size of a retained event, approximated for budget eviction. */
function eventBytes(event: RemoteProgressEvent): number {
  let total = 64; // overhead per event
  total += Buffer.byteLength(event.text ?? "", "utf8");
  total += Buffer.byteLength(event.toolName ?? "", "utf8");
  total += Buffer.byteLength(event.summary ?? "", "utf8");
  total += Buffer.byteLength(event.name ?? "", "utf8");
  return total;
}

/**
 * Append a driver event to the ring, returning the new ring. Absolute cursors
 * are monotonic across the run; the ring evicts oldest entries once it exceeds
 * REMOTE_PROGRESS_RING_MAX_EVENTS or REMOTE_PROGRESS_RING_MAX_BYTES, advancing
 * baseCursor so prior cursor reads detect a gap rather than seeing shifted
 * content. Native event data is dropped (only the name is retained) to avoid
 * leaking unsanitized payloads the live view never exposed.
 */
export function appendRemoteProgressEvent(
  ring: RemoteProgressRing,
  event: RemoteDriverEvent,
  at: number,
): RemoteProgressRing {
  const cursor = ring.sequence + 1;
  let normalized: RemoteProgressEvent;
  if (event.type === "text") {
    normalized = { cursor, at, kind: "assistant", text: boundedText(event.text, REMOTE_TEXT_BYTES) };
  } else if (event.type === "tool") {
    const tool = event.tool as RemoteToolEvent;
    const summary = typeof tool.summary === "string" ? boundedText(tool.summary, REMOTE_PAYLOAD_BYTES) : undefined;
    normalized = {
      cursor,
      at,
      kind: "tool",
      toolCallId: tool.toolCallId,
      toolName: boundedText(tool.toolName ?? "", 256),
      status: tool.phase === "start" ? "running" : tool.isError ? "failed" : "completed",
      ...(summary ? { summary } : {}),
    };
  } else if (event.type === "usage") {
    normalized = { cursor, at, kind: "usage", usage: event.usage as RemoteUsage };
  } else {
    // Native events: retain only the name. The driver's boundedData is a size
    // check, not a redaction; raw payloads may carry reasoning or credentials
    // the prior live view never published, so they are dropped here.
    normalized = { cursor, at, kind: "native", name: boundedText(event.name ?? "", 256) };
  }
  const events = [...ring.events, normalized];
  let bytes = ring.bytes + eventBytes(normalized);
  // Evict oldest past both the event-count and the byte budget.
  while (events.length > 0
    && (events.length > REMOTE_PROGRESS_RING_MAX_EVENTS || bytes > REMOTE_PROGRESS_RING_MAX_BYTES)) {
    const removed = events.shift();
    if (!removed) break;
    bytes -= eventBytes(removed);
  }
  return {
    sequence: cursor,
    baseCursor: cursor - events.length,
    updatedAt: at,
    events,
    bytes,
  };
}

// ---------------------------------------------------------------------------
// view="turns" — turn grouping
// ---------------------------------------------------------------------------

export interface RemoteTurn {
  /** 1-based turn index (1 = preamble or first work unit). */
  index: number;
  startedAt: number;
  /** First assistant text line, or a synthetic label. */
  preview: string;
  assistantChars: number;
  toolCallCount: number;
  toolResultCount: number;
  /** Rendered detail lines for this turn (assistant, tool, usage rows). */
  rows: string[];
}

function assistantPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > REMOTE_TURN_PREVIEW_CHARS
    ? `${collapsed.slice(0, REMOTE_TURN_PREVIEW_CHARS - 3)}...`
    : collapsed;
}

function formatAssistantRows(text: string): string[] {
  const physical = text.replace(/\r\n/g, "\n").split("\n");
  return (physical.length > 0 ? physical : [""]).map((line, index) => {
    const clipped = line.length > REMOTE_LINE_CHARS ? `${line.slice(0, REMOTE_LINE_CHARS - 1)}…` : line;
    return index === 0 ? `[assistant] ${clipped}`.trimEnd() : `  ${clipped}`;
  });
}

/**
 * Group retained ring events into turns. Consecutive assistant text chunks
 * (streaming deltas) coalesce into ONE turn: a new turn opens only when the
 * current event is assistant text AND the previous retained event was not
 * assistant text (or there is no current turn). Tool, usage, and native events
 * attach to the in-progress turn. This ensures a single streamed assistant
 * message — emitted as many `text` chunks — does not fragment into many turns.
 * All turns are 1-based so they are expandable via turn=<n> (the public
 * validator requires turn >= 1).
 */
export function groupRemoteTurns(ring: RemoteProgressRing | undefined): RemoteTurn[] {
  if (!ring || ring.events.length === 0) return [];
  const turns: RemoteTurn[] = [];
  // Tracks turns whose preview has locked onto a non-empty assistant chunk.
  // Using a WeakSet (rather than a sentinel string on `preview`) avoids any
  // collision when the chunk content happens to equal the placeholder text.
  const lockedPreviews = new WeakSet<RemoteTurn>();
  let current: RemoteTurn | undefined;
  let nextIndex = 1;
  const openTurn = (at: number, preview: string): RemoteTurn => {
    const turn: RemoteTurn = {
      index: nextIndex++,
      startedAt: at,
      preview,
      assistantChars: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      rows: [],
    };
    turns.push(turn);
    return turn;
  };
  ring.events.forEach((event, index) => {
    const previous = ring!.events[index - 1];
    if (event.kind === "assistant") {
      // Coalesce: a text chunk continues the current turn only when the
      // immediately preceding retained event was also assistant text.
      const continuesAssistant = current !== undefined && previous?.kind === "assistant";
      const turn = continuesAssistant && current
        ? current
        : openTurn(event.at, assistantPreview(event.text ?? "") || "assistant message");
      if (!continuesAssistant) current = turn;
      turn.assistantChars += (event.text ?? "").length;
      // Lock the preview onto the first non-empty chunk. pi-rpc emits
      // unfiltered empty text_delta events, so the opening chunk may carry
      // the "assistant message" placeholder; a later non-empty chunk in the
      // same turn replaces it. Once locked, subsequent chunks never replace
      // the preview (stabilizing on the first meaningful content).
      if (!lockedPreviews.has(turn)) {
        const candidate = assistantPreview(event.text ?? "");
        if (candidate) {
          turn.preview = candidate;
          lockedPreviews.add(turn);
        }
      }
      turn.rows.push(...formatAssistantRows(event.text ?? ""));
      return;
    }
    if (!current) {
      current = openTurn(event.at, "session start");
    }
    if (event.kind === "tool") {
      if (event.status === "running") {
        current.toolCallCount += 1;
        current.rows.push(`[tool] ${event.toolName ?? "?"} (running)`);
      } else {
        current.toolResultCount += 1;
        current.rows.push(`[result]${event.status === "failed" ? " !" : ""} ${event.toolName ?? "?"}${event.summary ? `: ${event.summary.slice(0, REMOTE_LINE_CHARS)}` : ""}`);
      }
    } else if (event.kind === "usage") {
      const total = event.usage?.totalTokens ?? event.usage?.inputTokens ?? event.usage?.outputTokens;
      current.rows.push(`[usage] ${total ?? "unknown"} tokens`);
    } else if (event.kind === "native") {
      current.rows.push(`[native] ${event.name ?? "unknown"}`);
    }
  });
  return turns;
}

// ---------------------------------------------------------------------------
// view="session" — cursor-paginated stream
// ---------------------------------------------------------------------------

interface RemoteSessionCursor {
  version: typeof CURSOR_VERSION;
  runId: string;
  sequence: number;
}

function encodeCursor(cursor: RemoteSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, runId: string): RemoteSessionCursor | undefined {
  if (!cursor || cursor.length > CURSOR_MAX_CHARS) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<RemoteSessionCursor>;
    if (parsed.version !== CURSOR_VERSION
      || typeof parsed.runId !== "string"
      || parsed.runId !== runId
      || typeof parsed.sequence !== "number"
      || !Number.isSafeInteger(parsed.sequence)
      || parsed.sequence < 0) return undefined;
    return { version: CURSOR_VERSION, runId: parsed.runId, sequence: parsed.sequence };
  } catch {
    return undefined;
  }
}

export interface RemoteSessionObservationItem {
  cursor: number;
  kind: RemoteProgressEvent["kind"];
  at: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  status?: "running" | "completed" | "failed";
  usage?: RemoteUsage;
  name?: string;
  summary?: string;
}

function projectSessionItem(event: RemoteProgressEvent): RemoteSessionObservationItem {
  const base: RemoteSessionObservationItem = { cursor: event.cursor, kind: event.kind, at: event.at };
  if (event.kind === "assistant") return { ...base, text: event.text };
  if (event.kind === "tool") return { ...base, toolCallId: event.toolCallId, toolName: event.toolName, status: event.status, ...(event.summary !== undefined ? { summary: event.summary } : {}) };
  if (event.kind === "usage") return { ...base, usage: event.usage };
  return { ...base, name: event.name };
}

function describeSessionItem(item: RemoteSessionObservationItem, summary: boolean): string {
  switch (item.kind) {
    case "assistant": {
      const text = (item.text ?? "").replace(/\s+/g, " ").trim();
      const bounded = summary && text.length > REMOTE_SESSION_SUMMARY_CHARS
        ? `${text.slice(0, REMOTE_SESSION_SUMMARY_CHARS - 3)}...`
        : text;
      return `[${item.cursor}] assistant${bounded ? `: ${bounded}` : ""}`;
    }
    case "tool":
      return `[${item.cursor}] tool ${item.toolName ?? "unknown"} ${item.status ?? "unknown"}`;
    case "usage":
      return `[${item.cursor}] usage ${item.usage?.totalTokens ?? "unknown"} tokens`;
    case "native":
      return `[${item.cursor}] native ${item.name ?? "unknown"}`;
  }
}

const REMOTE_TURN_CAPABILITIES = {
  inspect: true,
  wait: true,
  cancel: true,
  message: true,
  supervise: true,
} as const;

function runLabel(snapshot: RemoteRunSnapshot, record?: { name?: string }): string {
  const name = record?.name ?? `remote:${snapshot.runId}`;
  return `${name} · ${snapshot.status}`;
}

function turnState(status: RemoteRunSnapshot["status"]): Pick<ObservationSnapshot, "phase" | "outcome" | "waitStatus" | "terminalStatus"> {
  switch (status) {
    case "completed": return { phase: "settled", outcome: "success", waitStatus: "completed", terminalStatus: status };
    case "failed": return { phase: "settled", outcome: "failure", waitStatus: "failed", terminalStatus: status };
    case "cancelled": return { phase: "settled", outcome: "aborted", waitStatus: "terminated", terminalStatus: status };
    case "lost": return { phase: "settled", outcome: "failure", waitStatus: "failed", terminalStatus: status };
    default: return { phase: "active" };
  }
}

function ringUpdatedAt(snapshot: RemoteRunSnapshot, ring: RemoteProgressRing | undefined): number {
  return ring?.updatedAt ?? snapshot.updatedAt;
}

/**
 * view="turns" snapshot. Groups the run's retained event ring into turns and
 * supports turn=<n> expansion. Falls back to an empty-turns listing when the
 * ring is empty (a run that emitted no structured progress yet).
 */
export function remoteTurnsSnapshot(
  snapshot: RemoteRunSnapshot,
  ring: RemoteProgressRing | undefined,
  record: { name?: string; objective?: string } | undefined,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
  options: ObservationReadOptions,
): ObservationSnapshot {
  const turns = groupRemoteTurns(ring);
  const base = {
    target,
    found: true,
    nativeStatus: snapshot.nativeStatus ?? snapshot.status,
    updatedAt: ringUpdatedAt(snapshot, ring),
    capabilities: REMOTE_TURN_CAPABILITIES,
  } as const;
  if (options.turn !== undefined) {
    const turn = turns.find((candidate) => candidate.index === options.turn);
    if (!turn) {
      return {
        ...base,
        ...turnState(snapshot.status),
        summary: `Turn ${options.turn} not found (${turns.length} turn${turns.length === 1 ? "" : "s"}).`,
        detail: turns.map((candidate) =>
          `Turn ${candidate.index} · ${candidate.preview.slice(0, 60)} · ${candidate.rows.length} rows`,
        ),
      };
    }
    const detailLines = detail === "summary"
      ? turn.rows.slice(0, 1)
      : turn.rows.slice(-Math.max(lines, 1));
    return {
      ...base,
      ...turnState(snapshot.status),
      summary: `Turn ${turn.index} · ${turn.preview.slice(0, REMOTE_TURN_PREVIEW_CHARS)} · ${turn.rows.length} rows · ${turn.toolCallCount} tools`,
      ...(detailLines.length > 0 ? { detail: detailLines } : {}),
    };
  }
  const bounded = ring && ring.events.length > 0
    ? `${turns.length} turn${turns.length === 1 ? "" : "s"} · last ${ring.events.length} event${ring.events.length === 1 ? "" : "s"} (bounded ring)`
    : "no structured progress retained yet";
  const listLines = turns.length === 0
    ? ["No structured progress events retained for this run."]
    : turns.map((turn) => {
      const tools = turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} tools` : "";
      const chars = turn.assistantChars > 0 ? ` · ${turn.assistantChars} chars` : "";
      return `Turn ${turn.index} · ${turn.preview.slice(0, REMOTE_TURN_PREVIEW_CHARS)} · ${turn.rows.length} rows${tools}${chars}`;
    });
  return {
    ...base,
    ...turnState(snapshot.status),
    summary: `${runLabel(snapshot, record)} · ${bounded}`,
    detail: listLines,
  };
}

function cursorError(
  snapshot: RemoteRunSnapshot,
  record: { name?: string } | undefined,
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
    updatedAt: ringUpdatedAt(snapshot, undefined),
    error: "stale-session-cursor",
    capabilities: REMOTE_TURN_CAPABILITIES,
  };
}

/**
 * view="session" snapshot. Cursor-paginates the run's retained event ring so
 * callers can incrementally drain progress with target.cursor. A gap flag is
 * set when the requested cursor precedes baseCursor (older events evicted).
 * When the cursor is caught up (no new items), the summary falls back to the
 * last retained event rather than claiming no published activity.
 */
export function remoteSessionSnapshot(
  snapshot: RemoteRunSnapshot,
  ring: RemoteProgressRing | undefined,
  record: { name?: string; objective?: string } | undefined,
  target: ObservationTarget,
  detail: ObservationDetail,
  lines: number,
  options: ObservationReadOptions,
): ObservationSnapshot {
  const sequence = ring?.sequence ?? 0;
  const baseCursor = ring?.baseCursor ?? 0;
  const events = ring?.events ?? [];
  const updatedAt = ringUpdatedAt(snapshot, ring);
  const revision = `remote-session:${snapshot.runId}:${sequence}`;
  const nextCursor = encodeCursor({ version: CURSOR_VERSION, runId: snapshot.runId, sequence });
  const requested = options.cursor === undefined ? undefined : decodeCursor(options.cursor, snapshot.runId);

  if (options.cursor !== undefined && (!requested || requested.runId !== snapshot.runId)) {
    return cursorError(snapshot, record, target, revision, "Session cursor belongs to another remote run.");
  }
  if (requested && requested.sequence > sequence) {
    return cursorError(snapshot, record, target, revision, "Session cursor is ahead of the published run progress.");
  }
  const requestedSequence = requested?.sequence ?? baseCursor;
  const gap = requestedSequence < baseCursor;
  const items = events.flatMap((event, index) => {
    const absoluteCursor = baseCursor + index + 1;
    return absoluteCursor > requestedSequence ? [projectSessionItem(event)] : [];
  });
  const page: ObservationPage = {
    kind: "remote-session",
    nextCursor,
    ...(gap ? { gap: true } : {}),
    items: detail === "summary" ? [] : items,
  };
  // Fall back to the last retained event when there are no new items, so an
  // up-to-date cursor reports the latest activity rather than "no activity".
  const lastRetained = events.at(-1);
  const latest = items.at(-1) ?? (lastRetained ? projectSessionItem(lastRetained) : undefined);
  const summary = latest
    ? `${runLabel(snapshot, record)} session · ${describeSessionItem(latest, true)} · sequence ${sequence}${gap ? " · gap" : ""}${items.length === 0 && lastRetained ? " · up to date" : ""}`
    : `${runLabel(snapshot, record)} session · no published activity · sequence ${sequence}${gap ? " · gap" : ""}`;
  const detailLines = detail === "summary"
    ? undefined
    : [
        ...(gap ? [`Session progress gap: requested ${requestedSequence}, retained from ${baseCursor + 1}.`] : []),
        ...(items.length === 0
          ? (lastRetained ? [`Up to date; last event was ${describeSessionItem(projectSessionItem(lastRetained), false)}.`] : ["No new run activity published."])
          : items.slice(-Math.max(1, lines)).map((item) => describeSessionItem(item, false))),
        `next-cursor=${nextCursor}`,
      ];
  return {
    target,
    found: true,
    nativeStatus: snapshot.nativeStatus ?? snapshot.status,
    ...turnState(snapshot.status),
    summary,
    ...(detailLines ? { detail: detailLines } : {}),
    revision,
    page,
    updatedAt,
    capabilities: REMOTE_TURN_CAPABILITIES,
  };
}

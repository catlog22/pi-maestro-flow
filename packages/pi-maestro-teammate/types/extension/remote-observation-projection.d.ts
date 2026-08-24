import type { ObservationDetail, ObservationReadOptions, ObservationSnapshot, ObservationTarget } from "../public/v1/observation.ts";
import type { RemoteDriverEvent, RemoteRunSnapshot, RemoteUsage } from "../remote/types.ts";
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
export declare const REMOTE_PROGRESS_RING_MAX_EVENTS = 64;
/** Total serialized byte budget for the ring; oldest events evict past it. */
export declare const REMOTE_PROGRESS_RING_MAX_BYTES: number;
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
export declare function createRemoteProgressRing(): RemoteProgressRing;
/**
 * Append a driver event to the ring, returning the new ring. Absolute cursors
 * are monotonic across the run; the ring evicts oldest entries once it exceeds
 * REMOTE_PROGRESS_RING_MAX_EVENTS or REMOTE_PROGRESS_RING_MAX_BYTES, advancing
 * baseCursor so prior cursor reads detect a gap rather than seeing shifted
 * content. Native event data is dropped (only the name is retained) to avoid
 * leaking unsanitized payloads the live view never exposed.
 */
export declare function appendRemoteProgressEvent(ring: RemoteProgressRing, event: RemoteDriverEvent, at: number): RemoteProgressRing;
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
export declare function groupRemoteTurns(ring: RemoteProgressRing | undefined): RemoteTurn[];
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
/**
 * view="turns" snapshot. Groups the run's retained event ring into turns and
 * supports turn=<n> expansion. Falls back to an empty-turns listing when the
 * ring is empty (a run that emitted no structured progress yet).
 */
export declare function remoteTurnsSnapshot(snapshot: RemoteRunSnapshot, ring: RemoteProgressRing | undefined, record: {
    name?: string;
    objective?: string;
} | undefined, target: ObservationTarget, detail: ObservationDetail, lines: number, options: ObservationReadOptions): ObservationSnapshot;
/**
 * view="session" snapshot. Cursor-paginates the run's retained event ring so
 * callers can incrementally drain progress with target.cursor. A gap flag is
 * set when the requested cursor precedes baseCursor (older events evicted).
 * When the cursor is caught up (no new items), the summary falls back to the
 * last retained event rather than claiming no published activity.
 */
export declare function remoteSessionSnapshot(snapshot: RemoteRunSnapshot, ring: RemoteProgressRing | undefined, record: {
    name?: string;
    objective?: string;
} | undefined, target: ObservationTarget, detail: ObservationDetail, lines: number, options: ObservationReadOptions): ObservationSnapshot;

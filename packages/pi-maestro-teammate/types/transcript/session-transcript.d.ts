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
import { type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { type HistoricalAgentRecord, type TranscriptLoad, type TranscriptRow } from "../shared/transcript.ts";
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
export declare function resolveSessionFile(source: TranscriptSource): string | null;
/** Newest *.jsonl in a directory, or null. Per-candidate fail-soft:
 *  non-files and unreadable stats are skipped, never thrown. */
export declare function findLatestSessionFile(dir: string): string | null;
/**
 * First *.jsonl in a directory whose summary validates (real session header),
 * newest first. Used by history scans so a crashed-empty file cannot shadow a
 * valid older session in the same directory.
 */
export declare function findValidSessionFile(dir: string): string | null;
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
export declare function loadTranscript(source: TranscriptSource): Promise<TranscriptLoad>;
/**
 * Root→leaf chain from the last written entry (child sessions are append-only
 * during a run and never branch mid-run). Cycle-guarded for hand-edited files.
 */
export declare function buildSessionPath(entries: SessionEntry[], byId: Map<string, SessionEntry>): SessionEntry[];
/** Session entry → display rows. Non-message entries collapse to meta rows. */
export declare function entryToRows(entry: SessionEntry): TranscriptRow[];
/** One pi message → rows (assistant blocks split by block type). */
export declare function projectMessage(entry: SessionMessageEntry): TranscriptRow[];
/** Best-effort fallback when no session file exists (e.g. --no-session). */
export declare function loadTranscriptFromMemory(source: TranscriptSource): TranscriptLoad;
export interface TranscriptTurn {
    /** 1-based turn index; 0 is the preamble before the first user message. */
    index: number;
    startedAt: number;
    /** First line of the turn's user message (preamble: "session start"). */
    userText: string;
    rowCount: number;
    toolCallCount: number;
    toolResultCount: number;
    /** Assistant text + thinking length in characters. */
    textLength: number;
    rows: TranscriptRow[];
}
/**
 * Split display rows into turns: every user row starts a new turn, and all
 * following rows (assistant, tool calls, results, thinking, meta) stay in it.
 * Rows before the first user message form the preamble turn (index 0).
 */
export declare function groupTranscriptTurns(rows: readonly TranscriptRow[]): TranscriptTurn[];
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
export declare function scanWorkspaceSessionDirs(parentSessionFile: string): WorkspaceSessionScan[];
/**
 * Header + active-chain summary of one session file, or null when the file is
 * not a valid session (missing/positional header, unreadable). Only the active
 * leaf chain contributes messages — abandoned branches are excluded, matching
 * what loadTranscript displays.
 */
export declare function summarizeSessionFile(file: string): WorkspaceSessionScan | null;
/**
 * Rebuild historical agent records from parent-session custom entries.
 * Entries with a mismatched customType or invalid shape are skipped.
 */
export declare function parseTeammateSessionRecords(entries: SessionEntry[]): HistoricalAgentRecord[];

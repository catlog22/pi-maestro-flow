/**
 * Teammate transcript viewer: row kinds, load contract, and persistent
 * per-agent records.
 *
 * The authoritative transcript source is the child's pi session file (JSONL
 * entry tree). Rows are a display projection of that tree — one row per
 * text/thinking/tool block, with meta rows for compaction / branch / model
 * changes. Memory fallback covers agents without a persisted session.
 */

export type TranscriptRowKind =
  | "user"
  | "assistant"
  | "tool"
  | "tool_result"
  | "thinking"
  | "system"
  | "meta";

export interface TranscriptRow {
  kind: TranscriptRowKind;
  /** Original pi message role (user | assistant | toolResult | system). */
  role: string;
  text: string;
  timestamp: number;
  /** AssistantMessage.model — set on assistant rows. */
  model?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  /** Session entry id — incremental anchor / dedupe key. */
  entryId?: string;
}

export interface TranscriptLoad {
  rows: TranscriptRow[];
  /**
   * Session entry id of the last entry in the root→leaf chain that produced a
   * row (state-only leaves like label/custom produce none). Null for memory
   * fallback. Consumers can always locate the anchor among `rows`.
   */
  anchorId: string | null;
  source: "session" | "memory";
  compacted: boolean;
  /** Session file the transcript was read from, when a session source exists. */
  sessionFile?: string;
}

/**
 * Persistent per-agent record stored as a custom entry in the parent session.
 * Survives process restarts: on reload the extension scans the parent session
 * entries for TEAMMATE_SESSION_CUSTOM_TYPE and rebuilds the history registry.
 * Custom entries do not participate in LLM context (pi ignores them in
 * buildSessionContext).
 */
export interface HistoricalAgentRecord {
  /** Absent for records recovered by directory scan (not storable). */
  correlationId?: string;
  agent: string;
  name?: string;
  sessionFile?: string;
  startedAt: number;
  lastActivityAt?: number;
  status: "completed" | "failed" | "terminated";
}

export const TEAMMATE_SESSION_CUSTOM_TYPE = "pi-teammate-session";

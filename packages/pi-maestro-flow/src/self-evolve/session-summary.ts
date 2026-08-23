/**
 * Session summary — the read-only, reason-aware session shutdown receipt.
 *
 * Design (locked by the approved Plan):
 *
 * 1. **Shutdown is state-only.** `session_shutdown` never starts an LLM,
 *    review, or stage. It snapshots in-memory counters, writes a
 *    `kind=session_summary` record, and emits a best-effort notify.
 *
 * 2. **Reason-aware.** `reload` writes a checkpoint (the session resumes, so
 *    the summary is not final). `quit` / `new` / `resume` / `fork` write a
 *    final summary.
 *
 * 3. **Separate from knowledge receipts.** Summaries live in
 *    `session-summaries/<date>.jsonl` under `kind=session_summary`, never
 *    confused with knowledge approval/reconciliation receipts.
 *
 * 4. **Idempotent.** `/self-evolve wrap` (manual) and `session_shutdown`
 *    (automatic) both go through {@link buildSessionSummary}; calling wrap
 *    twice in a session is safe (the second call is a no-op or a refresh).
 *
 * This module is host-free and unit-testable. The extension wires it to the
 * `session_shutdown` event and the `/self-evolve wrap` command.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/** In-memory session accumulator (mirrors the extension's counters). */
export interface SessionAccumulator {
  sessionId: string;
  project: string;
  agentEndCount: number;
  signalsWritten: number;
  deduped: number;
  suppressed: number;
  failures: number;
  /** Enrichment budget usage (Phase 2). */
  enrichmentCallsUsed: number;
  enrichmentCandidatesEnriched: number;
  /** Signals rescued from unknown by semantic enrichment. */
  enrichmentRescued: number;
}

/** A serialized session summary record. */
export interface SessionSummary {
  schemaVersion: 1;
  kind: "session_summary";
  /** `quit`/`new`/`resume`/`fork` → final; `reload` → checkpoint. */
  reason: ShutdownReason;
  /** True when this is a final summary (not a reload checkpoint). */
  final: boolean;
  createdAt: string;
  sessionId: string;
  project: string;
  agentEndCount: number;
  signalsWritten: number;
  deduped: number;
  suppressed: number;
  failures: number;
  enrichmentCallsUsed: number;
  enrichmentCandidatesEnriched: number;
  enrichmentRescued: number;
  /** Pending unreviewed signals in this session (best-effort count). */
  pendingReview: number;
  /** True when `/self-evolve wrap` already produced a summary this session. */
  wrapped: boolean;
}

// ---------------------------------------------------------------------------
// Summary construction
// ---------------------------------------------------------------------------

/**
 * Build a session summary from the accumulator. `reason` and `wrapped`
 * control whether the record is final or a checkpoint, and whether a prior
 * wrap already happened.
 */
export function buildSessionSummary(
  acc: SessionAccumulator,
  reason: ShutdownReason,
  opts: { pendingReview?: number; wrapped?: boolean } = {},
): SessionSummary {
  const final = reason !== "reload";
  return {
    schemaVersion: 1,
    kind: "session_summary",
    reason,
    final,
    createdAt: new Date().toISOString(),
    sessionId: acc.sessionId,
    project: acc.project,
    agentEndCount: acc.agentEndCount,
    signalsWritten: acc.signalsWritten,
    deduped: acc.deduped,
    suppressed: acc.suppressed,
    failures: acc.failures,
    enrichmentCallsUsed: acc.enrichmentCallsUsed,
    enrichmentCandidatesEnriched: acc.enrichmentCandidatesEnriched,
    enrichmentRescued: acc.enrichmentRescued,
    pendingReview: opts.pendingReview ?? 0,
    wrapped: opts.wrapped ?? false,
  };
}

/**
 * Human-readable one-line summary for notify/panel. Bounded length so it fits
 * a status notification.
 */
export function formatSessionSummaryLine(summary: SessionSummary): string {
  const tag = summary.final ? "session summary" : "session checkpoint";
  const parts = [
    `${summary.signalsWritten} signals`,
    `${summary.deduped} deduped`,
    `${summary.suppressed} suppressed`,
  ];
  if (summary.enrichmentCallsUsed > 0) {
    parts.push(`${summary.enrichmentCallsUsed} enrich`);
    if (summary.enrichmentRescued > 0) parts.push(`${summary.enrichmentRescued} rescued`);
  }
  if (summary.pendingReview > 0) parts.push(`${summary.pendingReview} pending review`);
  if (summary.failures > 0) parts.push(`${summary.failures} failures`);
  const truncated = parts.join(" · ");
  return `Self-evolve ${tag} (${summary.reason}): ${truncated}`;
}

// ---------------------------------------------------------------------------
// Pending review nudge
// ---------------------------------------------------------------------------

/** Threshold for prompting the user to run `/self-evolve review pending`. */
export const REVIEW_NUDGE_THRESHOLD = 3;

/**
 * True when the pending-review count is high enough to warrant a nudge. The
 * nudge is informational only — it never starts a review.
 */
export function shouldNudgeReview(pendingReview: number): boolean {
  return pendingReview >= REVIEW_NUDGE_THRESHOLD;
}

/** The nudge message (informational, never auto-runs anything). */
export function reviewNudgeMessage(pendingReview: number): string {
  return `Self-evolve: ${pendingReview} signals pending review in this session. Run /self-evolve review pending when ready.`;
}

// ---------------------------------------------------------------------------
// Parsing / validation
// ---------------------------------------------------------------------------

const SHUTDOWN_REASONS: readonly ShutdownReason[] = ["quit", "reload", "new", "resume", "fork"];

/** Parse a session summary from a raw JSON object. Returns undefined if invalid. */
export function parseSessionSummary(raw: unknown): SessionSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "session_summary" || obj.schemaVersion !== 1) return undefined;
  const reason = typeof obj.reason === "string" && (SHUTDOWN_REASONS as readonly string[]).includes(obj.reason)
    ? (obj.reason as ShutdownReason)
    : undefined;
  const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : undefined;
  const project = typeof obj.project === "string" ? obj.project : undefined;
  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : undefined;
  if (!reason || !sessionId || !project || !createdAt) return undefined;
  const num = (key: string): number =>
    typeof obj[key] === "number" && Number.isFinite(obj[key]) ? (obj[key] as number) : 0;
  return {
    schemaVersion: 1,
    kind: "session_summary",
    reason,
    final: typeof obj.final === "boolean" ? obj.final : reason !== "reload",
    createdAt,
    sessionId,
    project,
    agentEndCount: num("agentEndCount"),
    signalsWritten: num("signalsWritten"),
    deduped: num("deduped"),
    suppressed: num("suppressed"),
    failures: num("failures"),
    enrichmentCallsUsed: num("enrichmentCallsUsed"),
    enrichmentCandidatesEnriched: num("enrichmentCandidatesEnriched"),
    enrichmentRescued: num("enrichmentRescued"),
    pendingReview: num("pendingReview"),
    wrapped: typeof obj.wrapped === "boolean" ? obj.wrapped : false,
  };
}

/** Serialize a session summary to a single ledger line. */
export function formatSessionSummaryLedgerLine(summary: SessionSummary): string {
  return JSON.stringify(summary);
}

/** Parse a session-summaries ledger file (newline-delimited JSON). */
export function parseSessionSummaryLedger(contents: string): SessionSummary[] {
  const summaries: SessionSummary[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseSessionSummary(JSON.parse(trimmed));
      if (parsed) summaries.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return summaries;
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type SessionAccumulator,
  type SessionSummary,
  buildSessionSummary,
  formatSessionSummaryLine,
  parseSessionSummary,
  parseSessionSummaryLedger,
  shouldNudgeReview,
  reviewNudgeMessage,
  REVIEW_NUDGE_THRESHOLD,
  formatSessionSummaryLedgerLine,
} from "../src/self-evolve/session-summary.ts";

function makeAcc(overrides: Partial<SessionAccumulator> = {}): SessionAccumulator {
  return {
    sessionId: "sess-A",
    project: "myproj",
    agentEndCount: 10,
    signalsWritten: 3,
    deduped: 2,
    suppressed: 1,
    failures: 0,
    enrichmentCallsUsed: 0,
    enrichmentCandidatesEnriched: 0,
    enrichmentRescued: 0,
    ...overrides,
  };
}

describe("buildSessionSummary", () => {
  it("builds a final summary for quit", () => {
    const summary = buildSessionSummary(makeAcc(), "quit", { pendingReview: 5 });
    assert.equal(summary.kind, "session_summary");
    assert.equal(summary.reason, "quit");
    assert.equal(summary.final, true);
    assert.equal(summary.sessionId, "sess-A");
    assert.equal(summary.signalsWritten, 3);
    assert.equal(summary.pendingReview, 5);
    assert.equal(summary.wrapped, false);
  });

  it("builds a checkpoint (not final) for reload", () => {
    const summary = buildSessionSummary(makeAcc(), "reload");
    assert.equal(summary.reason, "reload");
    assert.equal(summary.final, false);
  });

  it("builds final summaries for new/resume/fork", () => {
    for (const reason of ["new", "resume", "fork"] as const) {
      const summary = buildSessionSummary(makeAcc(), reason);
      assert.equal(summary.final, true, `${reason} should be final`);
    }
  });

  it("records enrichment usage when present", () => {
    const acc = makeAcc({ enrichmentCallsUsed: 2, enrichmentCandidatesEnriched: 5, enrichmentRescued: 1 });
    const summary = buildSessionSummary(acc, "quit");
    assert.equal(summary.enrichmentCallsUsed, 2);
    assert.equal(summary.enrichmentCandidatesEnriched, 5);
    assert.equal(summary.enrichmentRescued, 1);
  });

  it("marks wrapped=true when wrap already happened", () => {
    const summary = buildSessionSummary(makeAcc(), "quit", { wrapped: true });
    assert.equal(summary.wrapped, true);
  });
});

describe("formatSessionSummaryLine", () => {
  it("includes signal counts and reason", () => {
    const summary = buildSessionSummary(makeAcc({ signalsWritten: 3, deduped: 2, suppressed: 1 }), "quit");
    const line = formatSessionSummaryLine(summary);
    assert.match(line, /session summary/);
    assert.match(line, /quit/);
    assert.match(line, /3 signals/);
    assert.match(line, /2 deduped/);
  });

  it("includes enrichment and pending when present", () => {
    const acc = makeAcc({ enrichmentCallsUsed: 1, enrichmentRescued: 1 });
    const summary = buildSessionSummary(acc, "quit", { pendingReview: 4 });
    const line = formatSessionSummaryLine(summary);
    assert.match(line, /1 enrich/);
    assert.match(line, /1 rescued/);
    assert.match(line, /4 pending review/);
  });

  it("uses checkpoint tag for reload", () => {
    const summary = buildSessionSummary(makeAcc(), "reload");
    const line = formatSessionSummaryLine(summary);
    assert.match(line, /session checkpoint/);
  });
});

describe("parseSessionSummary", () => {
  it("round-trips through serialize/parse", () => {
    const summary = buildSessionSummary(makeAcc(), "quit", { pendingReview: 2 });
    const parsed = parseSessionSummary(JSON.parse(formatSessionSummaryLedgerLine(summary)));
    assert.deepEqual(parsed, summary);
  });

  it("rejects wrong kind", () => {
    const bad = { ...buildSessionSummary(makeAcc(), "quit"), kind: "review" };
    assert.equal(parseSessionSummary(bad), undefined);
  });

  it("rejects missing required fields", () => {
    assert.equal(parseSessionSummary({ kind: "session_summary", schemaVersion: 1 }), undefined);
    assert.equal(parseSessionSummary({ ...buildSessionSummary(makeAcc(), "quit"), sessionId: undefined }), undefined);
  });

  it("rejects invalid reason", () => {
    const bad = { ...buildSessionSummary(makeAcc(), "quit"), reason: "bogus" };
    assert.equal(parseSessionSummary(bad), undefined);
  });

  it("defaults final to reason !== reload when missing", () => {
    const summary = buildSessionSummary(makeAcc(), "quit");
    const raw = JSON.parse(JSON.stringify(summary));
    delete raw.final;
    const parsed = parseSessionSummary(raw);
    assert.equal(parsed?.final, true);
  });
});

describe("parseSessionSummaryLedger", () => {
  it("parses newline-delimited summaries and skips malformed", () => {
    const s1 = buildSessionSummary(makeAcc(), "quit");
    const s2 = buildSessionSummary(makeAcc(), "reload");
    const contents = [formatSessionSummaryLedgerLine(s1), "not json", formatSessionSummaryLedgerLine(s2), ""].join("\n");
    const summaries = parseSessionSummaryLedger(contents);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].reason, "quit");
    assert.equal(summaries[1].reason, "reload");
  });
});

describe("review nudge", () => {
  it("threshold is 3", () => {
    assert.equal(REVIEW_NUDGE_THRESHOLD, 3);
  });

  it("shouldNudgeReview returns true at threshold and above", () => {
    assert.equal(shouldNudgeReview(2), false);
    assert.equal(shouldNudgeReview(3), true);
    assert.equal(shouldNudgeReview(5), true);
  });

  it("nudge message mentions the count and the command", () => {
    const msg = reviewNudgeMessage(4);
    assert.match(msg, /4 signals pending review/);
    assert.match(msg, /\/self-evolve review pending/);
  });
});

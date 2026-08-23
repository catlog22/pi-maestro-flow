import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type EnrichmentRecord,
  type EvidenceRef,
  type ResolvedSignal,
  evidenceIdFor,
  resolveSignal,
  selectEnrichment,
  resolveSignalCorpus,
  parseEnrichmentRecord,
  parseEnrichmentLedger,
  formatEnrichmentLine,
  validateEvidenceIds,
  downgradeInvalidEvidence,
} from "../src/self-evolve/enrichment.ts";
import type { SelfEvolveSignal } from "../src/self-evolve/runtime.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRawSignal(overrides: Partial<SelfEvolveSignal> = {}): SelfEvolveSignal {
  return {
    schemaVersion: 1,
    id: "se-aaaaaaaaaaaa",
    kind: "candidate",
    source: "agent_end",
    dryRun: true,
    createdAt: "2026-08-23T00:00:00.000Z",
    sessionId: "session-A",
    traceHash: "a".repeat(64),
    candidateType: "unknown",
    title: "raw title",
    summary: "raw summary",
    evidence: [],
    ...overrides,
  };
}

function makeSemanticRecord(overrides: Partial<EnrichmentRecord> = {}): EnrichmentRecord {
  return {
    schemaVersion: 1,
    kind: "enrichment",
    signalId: "se-aaaaaaaaaaaa",
    traceHash: "a".repeat(64),
    sessionId: "session-A",
    attempt: 1,
    status: "semantic",
    model: "test/model",
    candidateType: "knowhow",
    confidence: 0.8,
    title: "enriched title",
    summary: "enriched summary with context + finding + constraint",
    qualityClass: "pitfall",
    knowledge: "doing X you must watch Y because Z",
    evidenceIds: ["ev-aaaaaaaaaa"],
    completedAt: "2026-08-23T00:00:01.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evidenceIdFor
// ---------------------------------------------------------------------------

describe("evidenceIdFor", () => {
  it("is stable for identical content", () => {
    const ref: EvidenceRef = { type: "file", ref: "src/a.ts", role: "modified" };
    assert.equal(evidenceIdFor(ref), evidenceIdFor({ ...ref }));
  });

  it("differs across type/ref/role", () => {
    const base: EvidenceRef = { type: "file", ref: "src/a.ts", role: "modified" };
    assert.notEqual(evidenceIdFor(base), evidenceIdFor({ ...base, role: "read" }));
    assert.notEqual(evidenceIdFor(base), evidenceIdFor({ ...base, ref: "src/b.ts" }));
    assert.notEqual(evidenceIdFor(base), evidenceIdFor({ ...base, type: "tool" }));
  });

  it("is order-independent (same content same id)", () => {
    const a: EvidenceRef = { type: "tool", ref: "browser:guide" };
    const b: EvidenceRef = { type: "tool", ref: "browser:guide" };
    assert.equal(evidenceIdFor(a), evidenceIdFor(b));
  });
});

// ---------------------------------------------------------------------------
// resolveSignal
// ---------------------------------------------------------------------------

describe("resolveSignal", () => {
  it("returns raw signal as skipped when no enrichment provided", () => {
    const raw = makeRawSignal();
    const resolved = resolveSignal(raw, undefined);
    assert.equal(resolved.enrichmentStatus, "skipped");
    assert.equal(resolved.enrichmentAttempt, 0);
    assert.equal(resolved.candidateType, raw.candidateType);
    assert.equal(resolved.title, raw.title);
  });

  it("overlays semantic enrichment fields onto raw signal", () => {
    const raw = makeRawSignal({ candidateType: "unknown" });
    const rec = makeSemanticRecord({ candidateType: "knowhow" });
    const resolved = resolveSignal(raw, rec);
    assert.equal(resolved.enrichmentStatus, "semantic");
    assert.equal(resolved.enrichmentAttempt, 1);
    assert.equal(resolved.candidateType, "knowhow");
    assert.equal(resolved.title, "enriched title");
    assert.equal(resolved.summary, "enriched summary with context + finding + constraint");
    assert.equal(resolved.enrichmentQuality, "pitfall");
    assert.equal(resolved.enrichmentConfidence, 0.8);
  });

  it("preserves raw signal fields on heuristic_fallback", () => {
    const raw = makeRawSignal({ candidateType: "knowhow", title: "raw" });
    const rec = makeSemanticRecord({
      status: "heuristic_fallback",
      error: "model timeout",
      candidateType: undefined,
      title: undefined,
    });
    const resolved = resolveSignal(raw, rec);
    assert.equal(resolved.enrichmentStatus, "heuristic_fallback");
    assert.equal(resolved.enrichmentAttempt, 1);
    assert.equal(resolved.candidateType, "knowhow");
    assert.equal(resolved.title, "raw");
  });

  it("returns raw as skipped when signalId mismatches", () => {
    const raw = makeRawSignal({ id: "se-bbbbbbbbbbbb" });
    const rec = makeSemanticRecord({ signalId: "se-aaaaaaaaaaaa" });
    const resolved = resolveSignal(raw, rec);
    assert.equal(resolved.enrichmentStatus, "skipped");
    assert.equal(resolved.enrichmentAttempt, 0);
  });
});

// ---------------------------------------------------------------------------
// selectEnrichment (collision detection)
// ---------------------------------------------------------------------------

describe("selectEnrichment", () => {
  it("picks the highest attempt for a consistent group", () => {
    const rec1 = makeSemanticRecord({ attempt: 1 });
    const rec2 = makeSemanticRecord({ attempt: 2, title: "retry" });
    const sel = selectEnrichment([rec1, rec2]);
    const best = sel.bySignalId.get("se-aaaaaaaaaaaa");
    assert.equal(best?.attempt, 2);
    assert.equal(best?.title, "retry");
    assert.equal(sel.collisionIds.size, 0);
  });

  it("marks collision when same id has different traceHash", () => {
    const rec1 = makeSemanticRecord({ traceHash: "a".repeat(64) });
    const rec2 = makeSemanticRecord({ traceHash: "b".repeat(64), attempt: 2 });
    const sel = selectEnrichment([rec1, rec2]);
    assert.ok(sel.collisionIds.has("se-aaaaaaaaaaaa"));
    assert.equal(sel.bySignalId.size, 0);
  });

  it("marks collision when same id has different sessionId", () => {
    const rec1 = makeSemanticRecord({ sessionId: "session-A" });
    const rec2 = makeSemanticRecord({ sessionId: "session-B", attempt: 2 });
    const sel = selectEnrichment([rec1, rec2]);
    assert.ok(sel.collisionIds.has("se-aaaaaaaaaaaa"));
    assert.equal(sel.bySignalId.size, 0);
  });

  it("ignores non-terminal records", () => {
    // parseEnrichmentRecord already rejects non-terminal statuses, but
    // selectEnrichment must also defend against a record that slips through.
    const rec = makeSemanticRecord();
    // Simulate a non-terminal by force-casting
    const nonTerminal = { ...rec, status: "pending" as unknown as "semantic" };
    const sel = selectEnrichment([nonTerminal as EnrichmentRecord]);
    assert.equal(sel.bySignalId.size, 0);
  });
});

// ---------------------------------------------------------------------------
// resolveSignalCorpus
// ---------------------------------------------------------------------------

describe("resolveSignalCorpus", () => {
  it("projects semantic enrichment across a corpus", () => {
    const sigA = makeRawSignal({ id: "se-aaaaaaaaaaaa" });
    const sigB = makeRawSignal({ id: "se-bbbbbbbbbbbb", traceHash: "b".repeat(64), title: "b" });
    const rec = makeSemanticRecord();
    const sel = selectEnrichment([rec]);
    const resolved = resolveSignalCorpus([sigA, sigB], sel);
    assert.equal(resolved[0].enrichmentStatus, "semantic");
    assert.equal(resolved[0].title, "enriched title");
    assert.equal(resolved[1].enrichmentStatus, "skipped");
    assert.equal(resolved[1].title, "b");
  });

  it("forces colliding signals to heuristic_fallback", () => {
    const sig = makeRawSignal({ id: "se-aaaaaaaaaaaa" });
    const rec1 = makeSemanticRecord({ traceHash: "a".repeat(64) });
    const rec2 = makeSemanticRecord({ traceHash: "b".repeat(64) });
    const sel = selectEnrichment([rec1, rec2]);
    assert.ok(sel.collisionIds.has("se-aaaaaaaaaaaa"));
    const resolved = resolveSignalCorpus([sig], sel);
    assert.equal(resolved[0].enrichmentStatus, "heuristic_fallback");
    assert.equal(resolved[0].title, "raw title"); // raw preserved
  });
});

// ---------------------------------------------------------------------------
// parseEnrichmentRecord
// ---------------------------------------------------------------------------

describe("parseEnrichmentRecord", () => {
  it("parses a well-formed semantic record", () => {
    const rec = makeSemanticRecord();
    const parsed = parseEnrichmentRecord(rec);
    assert.deepEqual(parsed, rec);
  });

  it("rejects wrong kind", () => {
    const rec = { ...makeSemanticRecord(), kind: "candidate" };
    assert.equal(parseEnrichmentRecord(rec), undefined);
  });

  it("rejects missing required fields", () => {
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), signalId: undefined }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), traceHash: undefined }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), sessionId: undefined }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), attempt: undefined }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), status: undefined }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), completedAt: undefined }), undefined);
  });

  it("rejects invalid status enum", () => {
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), status: "pending" }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), status: "in_flight" }), undefined);
  });

  it("rejects non-integer or non-positive attempt", () => {
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), attempt: 0 }), undefined);
    assert.equal(parseEnrichmentRecord({ ...makeSemanticRecord(), attempt: 1.5 }), undefined);
  });

  it("rejects invalid candidateType and qualityClass", () => {
    assert.equal(
      parseEnrichmentRecord({ ...makeSemanticRecord(), candidateType: "bogus" })?.candidateType,
      undefined,
    );
    assert.equal(
      parseEnrichmentRecord({ ...makeSemanticRecord(), qualityClass: "bogus" })?.qualityClass,
      undefined,
    );
  });

  it("rejects confidence out of range", () => {
    assert.equal(
      parseEnrichmentRecord({ ...makeSemanticRecord(), confidence: 1.5 })?.confidence,
      undefined,
    );
    assert.equal(
      parseEnrichmentRecord({ ...makeSemanticRecord(), confidence: -0.1 })?.confidence,
      undefined,
    );
  });

  it("strips empty optional fields", () => {
    const rec = makeSemanticRecord({ title: "", summary: "", error: "" });
    const parsed = parseEnrichmentRecord(rec);
    assert.equal(parsed?.title, undefined);
    assert.equal(parsed?.summary, undefined);
    assert.equal(parsed?.error, undefined);
  });
});

// ---------------------------------------------------------------------------
// parseEnrichmentLedger + formatEnrichmentLine
// ---------------------------------------------------------------------------

describe("parseEnrichmentLedger", () => {
  it("parses newline-delimited records and skips malformed lines", () => {
    const rec1 = makeSemanticRecord({ attempt: 1 });
    const rec2 = makeSemanticRecord({ attempt: 2 });
    const contents = [
      formatEnrichmentLine(rec1),
      "not json",
      formatEnrichmentLine(rec2),
      JSON.stringify({ kind: "enrichment", schemaVersion: 1 }), // missing fields
      "",
    ].join("\n");
    const records = parseEnrichmentLedger(contents);
    assert.equal(records.length, 2);
    assert.equal(records[0].attempt, 1);
    assert.equal(records[1].attempt, 2);
  });

  it("round-trips through formatEnrichmentLine", () => {
    const rec = makeSemanticRecord();
    const line = formatEnrichmentLine(rec);
    const parsed = parseEnrichmentLedger(line);
    assert.deepEqual(parsed, [rec]);
  });
});

// ---------------------------------------------------------------------------
// validateEvidenceIds + downgradeInvalidEvidence
// ---------------------------------------------------------------------------

describe("validateEvidenceIds", () => {
  it("returns all valid when every evidence id exists", () => {
    const rec = makeSemanticRecord({ evidenceIds: ["ev-1", "ev-2"] });
    const available = new Set(["ev-1", "ev-2"]);
    const result = validateEvidenceIds(rec, available);
    assert.deepEqual(result.validIds, ["ev-1", "ev-2"]);
    assert.equal(result.allValid, true);
  });

  it("returns only valid ids when some are unknown", () => {
    const rec = makeSemanticRecord({ evidenceIds: ["ev-1", "ev-bogus"] });
    const available = new Set(["ev-1"]);
    const result = validateEvidenceIds(rec, available);
    assert.deepEqual(result.validIds, ["ev-1"]);
    assert.equal(result.allValid, false);
  });

  it("returns all valid for non-semantic records", () => {
    const rec = makeSemanticRecord({ status: "heuristic_fallback", evidenceIds: [] });
    const result = validateEvidenceIds(rec, new Set());
    assert.equal(result.allValid, true);
  });
});

describe("downgradeInvalidEvidence", () => {
  it("fully downgrades when all evidence ids are unknown", () => {
    const rec = makeSemanticRecord({ evidenceIds: ["ev-bogus"] });
    const downgraded = downgradeInvalidEvidence(rec, new Set());
    assert.equal(downgraded.status, "heuristic_fallback");
    assert.equal(downgraded.evidenceIds?.length, 0);
    assert.match(downgraded.error ?? "", /no valid evidence/);
  });

  it("keeps partial evidence and notes the count", () => {
    const rec = makeSemanticRecord({ evidenceIds: ["ev-1", "ev-bogus"] });
    const downgraded = downgradeInvalidEvidence(rec, new Set(["ev-1"]));
    assert.equal(downgraded.status, "semantic");
    assert.deepEqual(downgraded.evidenceIds, ["ev-1"]);
    assert.match(downgraded.error ?? "", /unknown evidence id/);
  });

  it("leaves non-semantic records unchanged", () => {
    const rec = makeSemanticRecord({ status: "heuristic_fallback" });
    const downgraded = downgradeInvalidEvidence(rec, new Set());
    assert.equal(downgraded, rec);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: old fixtures parse without enrichment
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("old signal without enrichment resolves to raw with skipped status", () => {
    const raw = makeRawSignal();
    const sel = selectEnrichment([]);
    const resolved = resolveSignalCorpus([raw], sel);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].id, raw.id);
    assert.equal(resolved[0].title, raw.title);
    assert.equal(resolved[0].candidateType, raw.candidateType);
    assert.equal(resolved[0].enrichmentStatus, "skipped");
    assert.equal(resolved[0].enrichmentAttempt, 0);
  });

  it("resolved signal preserves all raw signal fields", () => {
    const raw = makeRawSignal({
      toolCalls: [{ tool: "browser", action: "guide", topic: "auth", outcome: "ok" }],
      evidence: [{ type: "file", ref: "src/a.ts", role: "modified" }],
      suggestion: "maestro knowledge stage ...",
    });
    const resolved = resolveSignal(raw, undefined);
    assert.equal(resolved.toolCalls?.length, 1);
    assert.equal(resolved.evidence.length, 1);
    assert.equal(resolved.suggestion, raw.suggestion);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: semantic enrichment prompt, schema, budget, parsing
// ---------------------------------------------------------------------------

import {
  DEFAULT_ENRICHMENT_BUDGET,
  freshBudgetState,
  canEnrich,
  markSubmitted,
  recordAttempt,
  buildEnrichmentInput,
  buildEnrichmentPrompt,
  parseEnrichmentResult,
  parseEnrichmentResults,
  resultToRecord,
  ENRICHMENT_OUTPUT_SCHEMA,
} from "../src/self-evolve/enrichment.ts";

describe("enrichment budget", () => {
  it("default captureMode is heuristic", () => {
    assert.equal(DEFAULT_ENRICHMENT_BUDGET.captureMode, "heuristic");
  });

  it("canEnrich returns false in heuristic mode", () => {
    const budget = { ...DEFAULT_ENRICHMENT_BUDGET, captureMode: "heuristic" as const };
    const state = freshBudgetState();
    assert.equal(canEnrich({ id: "se-aaa", candidateType: "unknown" }, budget, state), false);
  });

  it("canEnrich returns true in hybrid mode under budget", () => {
    const budget = { ...DEFAULT_ENRICHMENT_BUDGET, captureMode: "hybrid" as const };
    const state = freshBudgetState();
    assert.equal(canEnrich({ id: "se-aaa", candidateType: "unknown" }, budget, state), true);
  });

  it("canEnrich returns false when calls exhausted", () => {
    const budget = { ...DEFAULT_ENRICHMENT_BUDGET, captureMode: "hybrid" as const, maxSemanticCallsPerSession: 1 };
    const state = freshBudgetState();
    recordAttempt(1, state);
    assert.equal(canEnrich({ id: "se-bbb", candidateType: "unknown" }, budget, state), false);
  });

  it("canEnrich returns false when candidates exhausted", () => {
    const budget = { ...DEFAULT_ENRICHMENT_BUDGET, captureMode: "hybrid" as const, maxSemanticCandidatesPerSession: 2 };
    const state = freshBudgetState();
    recordAttempt(2, state);
    assert.equal(canEnrich({ id: "se-bbb", candidateType: "unknown" }, budget, state), false);
  });

  it("canEnrich returns false for already-submitted signal", () => {
    const budget = { ...DEFAULT_ENRICHMENT_BUDGET, captureMode: "hybrid" as const };
    const state = freshBudgetState();
    markSubmitted("se-aaa", state);
    assert.equal(canEnrich({ id: "se-aaa", candidateType: "unknown" }, budget, state), false);
  });
});

describe("buildEnrichmentInput", () => {
  it("enumerates evidence with stable ids", () => {
    const raw = makeRawSignal({
      evidence: [
        { type: "file", ref: "src/a.ts", role: "modified" },
        { type: "tool", ref: "browser:guide" },
      ],
    });
    const input = buildEnrichmentInput(raw, "digest text", []);
    assert.equal(input.evidence.length, 2);
    assert.match(input.evidence[0].id, /^ev-/);
    assert.equal(input.evidence[0].type, "file");
    assert.equal(input.evidence[1].type, "tool");
    assert.equal(input.digest, "digest text");
  });
});

describe("buildEnrichmentPrompt", () => {
  it("declares transcript as untrusted data", () => {
    const raw = makeRawSignal();
    const input = buildEnrichmentInput(raw, "some trace", []);
    const prompt = buildEnrichmentPrompt([input]);
    assert.match(prompt, /UNTRUSTED DATA/);
    assert.match(prompt, /pitfall/);
    assert.match(prompt, /evidenceIds/);
  });

  it("includes signal id and evidence ids", () => {
    const raw = makeRawSignal({
      evidence: [{ type: "file", ref: "src/a.ts" }],
    });
    const input = buildEnrichmentInput(raw, "trace", []);
    const prompt = buildEnrichmentPrompt([input]);
    assert.match(prompt, /se-aaaaaaaaaaaa/);
    assert.match(prompt, /ev-/);
  });
});

describe("parseEnrichmentResult", () => {
  it("parses a well-formed result", () => {
    const raw = {
      signalId: "se-aaa",
      worthCapturing: true,
      candidateType: "knowhow",
      confidence: 0.9,
      title: "good title",
      summary: "good summary",
      qualityClass: "pitfall",
      knowledge: "doing X watch Y because Z",
      evidenceIds: ["ev-1"],
    };
    const result = parseEnrichmentResult(raw);
    assert.deepEqual(result, raw);
  });

  it("rejects missing signalId or worthCapturing", () => {
    assert.equal(parseEnrichmentResult({ worthCapturing: true }), undefined);
    assert.equal(parseEnrichmentResult({ signalId: "x" }), undefined);
  });

  it("rejects invalid candidateType and qualityClass", () => {
    const result = parseEnrichmentResult({
      signalId: "x",
      worthCapturing: true,
      candidateType: "bogus",
      qualityClass: "bogus",
    });
    assert.equal(result?.candidateType, undefined);
    assert.equal(result?.qualityClass, undefined);
  });
});

describe("parseEnrichmentResults", () => {
  it("parses top-level JSON object", () => {
    const text = JSON.stringify({
      results: [
        { signalId: "se-a", worthCapturing: true, candidateType: "knowhow", title: "t", summary: "s" },
        { signalId: "se-b", worthCapturing: false },
      ],
    });
    const results = parseEnrichmentResults(text);
    assert.equal(results.length, 2);
    assert.equal(results[0].candidateType, "knowhow");
  });

  it("extracts JSON from markdown fences", () => {
    const text = "Here you go:\n```json\n" + JSON.stringify({ results: [{ signalId: "se-a", worthCapturing: false }] }) + "\n```";
    const results = parseEnrichmentResults(text);
    assert.equal(results.length, 1);
  });

  it("returns empty array on unparseable text", () => {
    assert.deepEqual(parseEnrichmentResults("not json at all"), []);
  });
});

describe("resultToRecord", () => {
  const signal = { id: "se-aaa", traceHash: "a".repeat(64), sessionId: "sess" };
  const availableIds = new Set(["ev-1", "ev-2"]);

  it("produces semantic record for a complete worthCapturing result", () => {
    const result = {
      signalId: "se-aaa",
      worthCapturing: true,
      candidateType: "knowhow" as const,
      confidence: 0.85,
      title: "title",
      summary: "summary",
      qualityClass: "pitfall" as const,
      knowledge: "knowledge statement",
      evidenceIds: ["ev-1"],
    };
    const rec = resultToRecord(result, signal, 1, "test/model", availableIds);
    assert.equal(rec.status, "semantic");
    assert.equal(rec.candidateType, "knowhow");
    assert.equal(rec.confidence, 0.85);
    assert.deepEqual(rec.evidenceIds, ["ev-1"]);
  });

  it("produces heuristic_fallback when worthCapturing is false", () => {
    const rec = resultToRecord(
      { signalId: "se-aaa", worthCapturing: false },
      signal,
      1,
      "test/model",
      availableIds,
    );
    assert.equal(rec.status, "heuristic_fallback");
    assert.match(rec.error ?? "", /not worth capturing/);
  });

  it("produces heuristic_fallback when candidateType is unknown", () => {
    const rec = resultToRecord(
      { signalId: "se-aaa", worthCapturing: true, candidateType: "unknown", title: "t", summary: "s" },
      signal,
      1,
      "test/model",
      availableIds,
    );
    assert.equal(rec.status, "heuristic_fallback");
  });

  it("drops unknown evidence ids and notes the count", () => {
    const rec = resultToRecord(
      {
        signalId: "se-aaa",
        worthCapturing: true,
        candidateType: "knowhow",
        title: "t",
        summary: "s",
        evidenceIds: ["ev-1", "ev-bogus"],
      },
      signal,
      1,
      "test/model",
      availableIds,
    );
    assert.equal(rec.status, "semantic");
    assert.deepEqual(rec.evidenceIds, ["ev-1"]);
    assert.match(rec.error ?? "", /unknown evidence id/);
  });
});

describe("ENRICHMENT_OUTPUT_SCHEMA", () => {
  it("requires results array", () => {
    assert.equal(ENRICHMENT_OUTPUT_SCHEMA.required?.[0], "results");
  });
});

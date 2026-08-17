import type {
  KnowledgeAudit,
  KnowledgeDisposition,
  KnowledgeFreshness,
  KnowledgeInputTotals,
  KnowledgePromotionEligibility,
  KnowledgeResolutionChoice,
  KnowledgeReviewView,
  ReviewCandidate,
} from "./cli-adapter.ts";

export type KnowledgeSeverity =
  | "conflict"
  | "supersede"
  | "duplicate"
  | "extends"
  | "unique"
  | "unknown";

const SEVERITY_RANK: Record<KnowledgeSeverity, number> = {
  conflict: 5,
  supersede: 4,
  duplicate: 3,
  extends: 2,
  unique: 1,
  unknown: 0,
};

const FRESHNESS_RANK: Record<KnowledgeFreshness, number> = {
  missing: 2,
  stale: 1,
  fresh: 0,
  blocked: 3,
};

export const STALE_OBSERVED_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_BY_SOURCE = 6;

export function severityFor(disposition: KnowledgeDisposition | null | undefined): KnowledgeSeverity {
  switch (disposition) {
    case "potential_conflict":
      return "conflict";
    case "supersede_candidate":
      return "supersede";
    case "exact_duplicate":
    case "semantic_duplicate":
      return "duplicate";
    case "extends":
    case "related":
      return "extends";
    case "unique":
      return "unique";
    default:
      return "unknown";
  }
}

export interface CandidateSummary {
  candidate: ReviewCandidate;
  severity: KnowledgeSeverity;
  disposition: KnowledgeDisposition | null;
  eligibility: KnowledgePromotionEligibility | null;
  freshness: KnowledgeFreshness;
  canonicalId: string | null;
  matchCount: number;
  ageDays: number;
  staleObserved: boolean;
}

export interface HealthSummary {
  spec: {
    total: number;
    active: number;
    deprecated: number;
    contested: number;
    stale: number;
    avgFreshness: number;
    chains: number;
    dangling: number;
  };
  knowhow: {
    total: number;
    active: number;
    deprecated: number;
    invalid: number;
  };
  concentration: {
    impression: number;
    consumption: number;
  };
  bySource: Array<{ sourceType: string; nodes: number; impressions: number; consumptions: number }>;
  findings: Array<{ severity: string; message: string }>;
  generatedAt: string;
}

export interface KnowledgeAdvisory {
  id: string;
  message: string;
}

export const KNOWLEDGE_UPSTREAM_ADVISORIES: readonly KnowledgeAdvisory[] = [
  { id: "X1", message: "deprecated specs may still inject through the keyword index" },
  { id: "X3", message: "credibility signals are write-only; the exploration slot is inactive" },
  { id: "G-A4", message: "spec writes lack a cross-process lock; avoid parallel promote to one file" },
];

export interface KnowledgeCenterView {
  sessionId: string;
  inputTotals: KnowledgeInputTotals;
  candidates: CandidateSummary[];
  triageCandidates: CandidateSummary[];
  counts: {
    total: number;
    missing: number;
    stale: number;
    reviewRequired: number;
    eligible: number;
    staleObserved: number;
  };
  health: HealthSummary | null;
  upstreamAdvisories: readonly KnowledgeAdvisory[];
  error: string | null;
}

function candidateAgeDays(candidate: ReviewCandidate, nowMs: number): number {
  const recorded = Date.parse(candidate.first_recorded_at);
  if (Number.isNaN(recorded)) return 0;
  return Math.max(0, (nowMs - recorded) / DAY_MS);
}

function summarizeCandidate(candidate: ReviewCandidate, nowMs: number): CandidateSummary {
  const reconciliation = candidate.reconciliation;
  const ageDays = candidateAgeDays(candidate, nowMs);
  return {
    candidate,
    severity: severityFor(reconciliation?.disposition),
    disposition: reconciliation?.disposition ?? null,
    eligibility: reconciliation?.promotion_eligibility ?? null,
    freshness: candidate.review.freshness,
    canonicalId: reconciliation?.canonical_id ?? null,
    matchCount: reconciliation?.matches.length ?? 0,
    ageDays,
    staleObserved: candidate.stage === "observed" && ageDays > STALE_OBSERVED_DAYS,
  };
}

function compareCandidates(a: CandidateSummary, b: CandidateSummary): number {
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) return severity;
  const freshness = FRESHNESS_RANK[b.freshness] - FRESHNESS_RANK[a.freshness];
  if (freshness !== 0) return freshness;
  const stage = (a.candidate.stage === "corroborated" ? 1 : 0) - (b.candidate.stage === "corroborated" ? 1 : 0);
  if (stage !== 0) return stage;
  return a.candidate.title.localeCompare(b.candidate.title);
}

function compareByTriage(a: CandidateSummary, b: CandidateSummary): number {
  const corroboration = (b.candidate.stage === "corroborated" ? 1 : 0) - (a.candidate.stage === "corroborated" ? 1 : 0);
  if (corroboration !== 0) return corroboration;
  const age = b.ageDays - a.ageDays;
  if (Math.abs(age) > 1e-9) return age;
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) return severity;
  return a.candidate.title.localeCompare(b.candidate.title);
}

function buildHealth(audit: KnowledgeAudit | null): HealthSummary | null {
  if (!audit) return null;
  const spec = audit.spec_health;
  return {
    spec: {
      total: spec.total,
      active: spec.active,
      deprecated: spec.deprecated,
      contested: spec.contested,
      stale: spec.staleActive,
      avgFreshness: spec.avgFreshness,
      chains: spec.chains,
      dangling: spec.danglingSupersedes.length + spec.danglingSupersededBy.length + spec.cyclicSids.length,
    },
    knowhow: {
      total: audit.knowhow.total,
      active: audit.knowhow.active,
      deprecated: audit.knowhow.deprecated,
      invalid: audit.knowhow.invalid,
    },
    concentration: {
      impression: audit.usage.impressionConcentration.gini,
      consumption: audit.usage.consumptionConcentration.gini,
    },
    bySource: [...audit.usage.bySource]
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, MAX_BY_SOURCE)
      .map((entry) => ({
        sourceType: entry.sourceType,
        nodes: entry.nodes,
        impressions: entry.impressions,
        consumptions: entry.consumptions,
      })),
    findings: audit.findings.map((finding) => ({
      severity: finding.priority,
      message: `${finding.store}/${finding.subtype}: ${finding.evidence}`,
    })),
    generatedAt: audit.generated_at,
  };
}

export function buildKnowledgeCenterView(
  review: KnowledgeReviewView | null,
  audit: KnowledgeAudit | null,
  error: string | null = null,
): KnowledgeCenterView {
  const nowMs = Date.now();
  const summarized = (review?.candidates ?? []).map((candidate) => summarizeCandidate(candidate, nowMs));
  const candidates = [...summarized].sort(compareCandidates);
  const triageCandidates = [...summarized].sort(compareByTriage);
  return {
    sessionId: review?.session_id ?? "",
    inputTotals: review?.input_totals ?? { consumed: 0, cited: 0, validated: 0, contradicted: 0 },
    candidates,
    triageCandidates,
    counts: {
      total: candidates.length,
      missing: candidates.filter((c) => c.freshness === "missing").length,
      stale: candidates.filter((c) => c.freshness === "stale").length,
      reviewRequired: candidates.filter((c) => c.eligibility === "review_required").length,
      eligible: candidates.filter((c) => c.eligibility === "eligible").length,
      staleObserved: candidates.filter((c) => c.staleObserved).length,
    },
    health: buildHealth(audit),
    upstreamAdvisories: KNOWLEDGE_UPSTREAM_ADVISORIES,
    error,
  };
}

export function resolutionChoicesFor(disposition: KnowledgeDisposition | null): KnowledgeResolutionChoice[] {
  switch (disposition) {
    case "semantic_duplicate":
      return ["duplicate", "related", "unique"];
    case "potential_conflict":
      return ["conflict", "related", "unique"];
    case "supersede_candidate":
      return ["supersede", "related", "unique"];
    case "extends":
    case "related":
      return ["related", "supersede", "unique"];
    default:
      return [];
  }
}

export function canPromote(summary: CandidateSummary): boolean {
  return summary.eligibility === "eligible" && summary.freshness === "fresh";
}

export function promoteBlockReason(summary: CandidateSummary): string | null {
  if (summary.freshness === "blocked") return "blocked — invalid candidate source";
  if (summary.freshness === "missing") return "receipt missing — press r to refresh";
  if (summary.freshness === "stale") return "receipt stale — press r to refresh";
  if (summary.eligibility === "review_required") return "resolution required first — press x";
  if (summary.eligibility === "suppressed") return "suppressed as duplicate";
  if (summary.eligibility !== "eligible") return "not eligible";
  return null;
}

export function dispositionLabel(disposition: KnowledgeDisposition | null): string {
  switch (disposition) {
    case "potential_conflict":
      return "conflict";
    case "supersede_candidate":
      return "supersede";
    case "exact_duplicate":
      return "exact-dup";
    case "semantic_duplicate":
      return "sem-dup";
    case "extends":
      return "extends";
    case "related":
      return "related";
    case "unique":
      return "unique";
    default:
      return "unmatched";
  }
}

export function eligibilityLabel(eligibility: KnowledgePromotionEligibility | null): string {
  switch (eligibility) {
    case "eligible":
      return "eligible";
    case "suppressed":
      return "suppressed";
    case "review_required":
      return "review";
    default:
      return "—";
  }
}

export function freshnessLabel(freshness: KnowledgeFreshness): string {
  return freshness;
}

export function actionLabel(candidate: ReviewCandidate): string {
  return `${candidate.target}:${candidate.action}`;
}

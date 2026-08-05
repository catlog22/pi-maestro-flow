import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner, type RunCliResult, type RunCliRunner } from "../session/cli-adapter.ts";

export type KnowledgeDisposition =
  | "unique"
  | "exact_duplicate"
  | "semantic_duplicate"
  | "extends"
  | "related"
  | "potential_conflict"
  | "supersede_candidate";

export type KnowledgePromotionEligibility = "eligible" | "suppressed" | "review_required";

export type KnowledgeFreshness = "fresh" | "stale" | "missing";

export type KnowledgeCandidateAction = "propose" | "reaffirm" | "supersede" | "contest";

export type KnowledgeCandidateStatus = "pending" | "promoting" | "promoted" | "rejected";

export interface KnowledgeInputTotals {
  consumed: number;
  cited: number;
  validated: number;
  contradicted: number;
}

export interface KnowledgeReconciliationMatch {
  knowledge_id: string;
  target: "spec" | "knowhow";
  title: string;
  relation: Exclude<KnowledgeDisposition, "unique">;
  scores: {
    composite: number;
    semantic: number;
    lexical: number;
  };
  novelty: number;
  evidence: string[];
  source_path: string;
  source_line: number | null;
}

export interface KnowledgeCandidateReconciliation {
  candidate_id: string;
  disposition: KnowledgeDisposition;
  promotion_eligibility: KnowledgePromotionEligibility;
  canonical_id: string | null;
  matches: KnowledgeReconciliationMatch[];
  freshness: KnowledgeFreshness;
}

export interface ReviewCandidate {
  candidate_id: string;
  target: "spec" | "knowhow";
  action: KnowledgeCandidateAction;
  title: string;
  content: string;
  category: string | null;
  source_kind: "decision" | "constraint" | "manual";
  occurrences: number;
  first_recorded_at: string;
  last_recorded_at: string;
  status: KnowledgeCandidateStatus;
  run_ids: string[];
  stage: "observed" | "corroborated";
  reconciliation: KnowledgeCandidateReconciliation | null;
  review: {
    freshness: KnowledgeFreshness;
    reconcile_commands: string[];
    resolution_commands: string[];
  };
}

export interface KnowledgeReviewView {
  schema_version: string;
  session_id: string;
  run_count: number;
  ledger_count: number;
  input_totals: KnowledgeInputTotals;
  /** Signal totals by attribution source; absent on older CLIs. */
  input_totals_by_source?: Record<string, KnowledgeInputTotals>;
  /** Knowledge-id attribution detail in ledger order; absent on older CLIs. */
  inputs?: Array<{
    run_id: string;
    knowledge_id: string;
    signal: string;
    source: string;
    count: number;
    evidence?: string[];
  }>;
  unique_inputs: number;
  candidates: ReviewCandidate[];
}

export interface KnowledgeSpecHealth {
  total: number;
  active: number;
  deprecated: number;
  contested: number;
  chains: number;
  danglingSupersedes: string[];
  danglingSupersededBy: string[];
  cyclicSids: string[];
  avgFreshness: number;
  staleActive: number;
}

export interface KnowledgeKnowhowHealth {
  total: number;
  active: number;
  deprecated: number;
  invalid: number;
}

export interface KnowledgeUsageBySource {
  sourceType: string;
  nodes: number;
  impressions: number;
  consumptions: number;
}

export interface KnowledgeConcentration {
  positiveNodes: number;
  totalEvents: number;
  top1Share: number;
  gini: number;
  hhi: number;
  effectiveNodes: number;
}

export interface KnowledgeAuditFinding {
  id: string;
  store: string;
  priority: string;
  subtype: string;
  target: string;
  evidence: string;
  recommended_action: string;
}

export interface KnowledgeAudit {
  schema_version: string;
  scope: string;
  generated_at: string;
  spec_health: KnowledgeSpecHealth;
  knowhow: KnowledgeKnowhowHealth;
  usage: {
    bySource: KnowledgeUsageBySource[];
    impressionConcentration: KnowledgeConcentration;
    consumptionConcentration: KnowledgeConcentration;
  };
  findings: KnowledgeAuditFinding[];
  prune_plan: unknown[];
}

export type KnowledgeResolutionChoice = "duplicate" | "related" | "conflict" | "supersede" | "unique";

export interface KnowledgePromoteResult {
  promoted: Array<{ candidate_id: string; promoted_id: string; target: string; outcome: string }>;
  already_promoted: Array<{ candidate_id: string }>;
  skipped_observed: Array<{ candidate_id: string }>;
  skipped_review_required: Array<{ candidate_id: string }>;
  skipped_suppressed: Array<{ candidate_id: string }>;
}

export interface KnowledgeRecordOptions {
  /** Knowledge IDs to attribute. */
  knowledgeIds: readonly string[];
  signal?: "consumed" | "cited" | "validated" | "contradicted";
  source?: "search" | "load" | "manual";
  /** Optional evidence anchors (artifact/output/test refs). */
  evidence?: readonly string[];
  /** Active Run that owns the attribution; omit to target the unique active Run. */
  runId?: string;
  /** Explicit Session ID; requires runId. */
  sessionId?: string;
}

export interface KnowledgeRecordResult {
  session_id: string;
  run_id: string;
  recorded: number;
}

export interface KnowledgeStageOptions {
  /** Candidate target corpus: spec or knowhow. */
  target: "spec" | "knowhow";
  title: string;
  content: string;
  /** Active Run that owns the staged candidate; omit to target the unique active Run. */
  runId?: string;
  /** Explicit Session ID; requires runId. */
  sessionId?: string;
  action?: KnowledgeCandidateAction;
  category?: string | null;
  /** Optional knowledge signal recorded alongside the candidate (attribution). */
  signal?: "consumed" | "cited" | "validated" | "contradicted";
  signalIds?: readonly string[];
  evidence?: readonly string[];
}

export interface KnowledgeStageResult {
  session_id: string;
  run_id: string;
  candidate_id: string;
  signal_recorded: number;
}

export interface KnowledgeResolveOptions {
  as: KnowledgeResolutionChoice;
  target?: string;
  reason: string;
}

export interface ResolveManyItem extends KnowledgeResolveOptions {
  candidateId: string;
}

export interface ResolveManyResult {
  resolved: number;
  failed: Array<{ candidateId: string; error: string }>;
}

export class KnowledgeCliAdapter {
  constructor(
    readonly workflowRoot: string,
    private readonly runner: RunCliRunner = defaultRunner,
  ) {}

  async review(sessionId: string, options: { refresh?: boolean } = {}): Promise<KnowledgeReviewView> {
    return this.invokeJson<KnowledgeReviewView>([
      "knowledge", "review", required(sessionId, "sessionId"),
      ...(options.refresh ? ["--refresh"] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async audit(scope: "spec" | "knowhow" | "all" = "all"): Promise<KnowledgeAudit> {
    return this.invokeJson<KnowledgeAudit>([
      "knowledge", "audit",
      "--scope", scope,
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async resolve(sessionId: string, candidateId: string, options: KnowledgeResolveOptions): Promise<KnowledgeReviewView> {
    return this.invokeJson<KnowledgeReviewView>([
      "knowledge", "review", required(sessionId, "sessionId"),
      "--resolve", required(candidateId, "candidateId"),
      "--as", required(options.as, "as"),
      ...(options.target ? ["--target", options.target] : []),
      "--reason", required(options.reason, "reason"),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async resolveMany(sessionId: string, items: readonly ResolveManyItem[]): Promise<ResolveManyResult> {
    const failed: Array<{ candidateId: string; error: string }> = [];
    let resolved = 0;
    for (const item of items) {
      try {
        await this.resolve(sessionId, item.candidateId, { as: item.as, target: item.target, reason: item.reason });
        resolved += 1;
      } catch (error) {
        failed.push({ candidateId: item.candidateId, error: errorMessage(error) });
      }
    }
    return { resolved, failed };
  }

  async promote(sessionId: string, options: { candidates?: readonly string[]; all?: boolean }): Promise<KnowledgePromoteResult> {
    const candidates = options.candidates ?? [];
    if (!options.all && candidates.length === 0) {
      throw new Error("promote requires at least one candidate id or --all");
    }
    return this.invokeJson<KnowledgePromoteResult>([
      "knowledge", "promote", required(sessionId, "sessionId"),
      ...candidates.flatMap((candidate) => ["--candidate", candidate]),
      ...(options.all ? ["--all"] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async recordInputs(options: KnowledgeRecordOptions): Promise<KnowledgeRecordResult> {
    const ids = options.knowledgeIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error("knowledgeIds must be non-empty");
    if (options.sessionId && !options.runId) {
      throw new Error("sessionId requires runId (the CLI binds --session to --run)");
    }
    return this.invokeJson<KnowledgeRecordResult>([
      "knowledge", "record", ...ids,
      "--signal", options.signal ?? "consumed",
      "--source", options.source ?? "search",
      ...(options.evidence?.length ? ["--evidence", options.evidence.join(",")] : []),
      ...(options.runId ? ["--run", required(options.runId, "runId")] : []),
      ...(options.sessionId ? ["--session", required(options.sessionId, "sessionId")] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  async stage(options: KnowledgeStageOptions): Promise<KnowledgeStageResult> {
    const target = required(options.target, "target");
    const title = required(options.title, "title");
    const content = required(options.content, "content");
    if (options.signal && !options.signalIds?.length) {
      throw new Error("signal requires signalIds");
    }
    if (options.signalIds?.length && !options.signal) {
      throw new Error("signalIds requires signal");
    }
    if (options.sessionId && !options.runId) {
      throw new Error("sessionId requires runId (the CLI binds --session to --run)");
    }
    return this.invokeJson<KnowledgeStageResult>([
      "knowledge", "stage", target, title, content,
      ...(options.sessionId ? ["--session", required(options.sessionId, "sessionId")] : []),
      ...(options.runId ? ["--run", required(options.runId, "runId")] : []),
      ...(options.action ? ["--action", options.action] : []),
      ...(options.category ? ["--category", options.category] : []),
      ...(options.evidence?.length ? ["--evidence", options.evidence.join(",")] : []),
      ...(options.signal ? ["--signal", options.signal] : []),
      ...(options.signalIds?.length ? ["--signal-ids", options.signalIds.join(",")] : []),
      "--json",
      "--workflow-root", this.workflowRoot,
    ]);
  }

  private async invokeJson<T>(args: readonly string[]): Promise<T> {
    const result = await this.runner(args, this.workflowRoot);
    if (result.exitCode !== 0) {
      throw new Error(`maestro ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
    }
    return parseJson<T>(result);
  }
}

export function resolveLatestSessionId(workflowRoot: string): string | null {
  const sessionsDir = join(workflowRoot, ".workflow", "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  let latest: { id: string; mtime: number } | null = null;
  for (const id of entries) {
    try {
      const sessionPath = join(sessionsDir, id, "session.json");
      const metadata = JSON.parse(readFileSync(sessionPath, "utf8")) as { session_id?: unknown };
      if (metadata.session_id !== id) continue;
      const stats = statSync(sessionPath);
      if (!stats.isFile()) continue;
      if (!latest || stats.mtimeMs > latest.mtime) latest = { id, mtime: stats.mtimeMs };
    } catch {
      // Skip legacy, malformed, and unreadable session directories.
    }
  }
  return latest?.id ?? null;
}

function parseJson<T>(result: RunCliResult): T {
  const text = result.stdout.trim();
  if (!text) throw new Error(`maestro ${result.argv.join(" ")} returned empty output`);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`maestro ${result.argv.join(" ")} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

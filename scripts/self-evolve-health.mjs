#!/usr/bin/env node
/**
 * self-evolve health sidecar generator (Phase 3 — knowledge health loop).
 *
 * Rebuildable knowledge-health snapshot for the current project, written to
 * the GLOBAL output root so it never pollutes git:
 *
 *   ~/.maestro/self-evolve/health.json            (default)
 *   ~/.maestro/self-evolve/health-<project>.json  (per-project twin)
 *   $SELF_EVOLVE_OUTPUT_DIR/health*.json          (env override)
 *
 * Sources (all deterministic maestro CLI):
 *   - `maestro spec health --json`            freshness / chains / identity
 *   - `maestro knowledge audit --json`        findings / prune plan / safety
 *   - knowledge-delta.json under `.workflow/sessions`   signals / candidates
 *   - `~/.maestro/self-evolve/reviews/*.jsonl`       negative feedback
 *   - `~/.maestro/self-evolve/suggestions/*.jsonl`   unknown-candidate ratio
 *   - `~/.maestro/self-evolve/approvals/*.jsonl`     promote receipt audit
 *
 * Output: health summary + a revalidation queue (stale / contested / dangling /
 * review-required-stale / candidate-expired / approval-missing-candidates /
 * high-priority findings) with suggested governance actions. The queue feeds
 * the skill's `health` intent: conflict mark → supersede → audit prune.
 *
 * Governance closed-loop: `mark <item-id> [--action <a>]` / `unmark <item-id>`
 * persist handled revalidation item ids to ~/.maestro/self-evolve/health-handled.json
 * (0o600); buildHealth filters handled items out of the queue.
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";

const OUTPUT_DIR = process.env.SELF_EVOLVE_OUTPUT_DIR?.trim()
  ? resolve(process.env.SELF_EVOLVE_OUTPUT_DIR)
  : resolve(homedir(), ".maestro", "self-evolve");
const HANDLED_PATH = join(OUTPUT_DIR, "health-handled.json");
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      if (key in args) {
        if (Array.isArray(args[key])) args[key].push(value);
        else args[key] = [args[key], value];
      } else args[key] = value;
    } else args._.push(a);
  }
  return args;
}

function runMaestroJson(args) {
  try {
    const raw = execSync(`maestro ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

/** Read one JSONL file defensively (missing / malformed lines are skipped). */
function readJsonLines(filePath) {
  const out = [];
  try {
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
    }
  } catch { /* missing or unreadable */ }
  return out;
}

/** Read all *.jsonl in a directory, sorted by file name. */
function readJsonDirLines(dir) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { return []; }
  const out = [];
  for (const f of files) out.push(...readJsonLines(join(dir, f)));
  return out;
}

/** Map an audit finding to a governance action suggestion. */
function suggestAction(finding) {
  const t = (finding.target ?? "").toString();
  switch (finding.subtype) {
    case "ghost-code-reference":
      return {
        action: "supersede-or-deprecate",
        reason: `referenced code path missing: ${finding.evidence}`,
        command: `maestro knowledge review --resolve --as supersede --target <id> --reason "ghost reference" (or deprecate)`,
      };
    case "missing-required-metadata":
      return {
        action: "fix-metadata",
        reason: finding.evidence,
        command: `edit frontmatter of ${t} (title/type)`,
      };
    case "invalid-knowledge-ledger":
      return {
        action: "review-ledger",
        reason: `invalid run ledger: ${finding.evidence?.slice(0, 120)}`,
        command: "inspect the referenced run's knowledge-delta",
      };
    case "missing-stable-id":
      return {
        action: "backfill-sid",
        reason: finding.evidence,
        command: "maestro spec backfill-sid",
      };
    default:
      return {
        action: finding.recommended_action ?? "review",
        reason: finding.evidence?.slice(0, 160) ?? "",
        command: "",
      };
  }
}

/**
 * Aggregate validated/contradicted/cited signals from all run knowledge ledgers
 * (`{project}/.workflow/sessions/<session>/runs/<run>/knowledge-delta.json`).
 *
 * Phase 3 health model: per-entry `last_validated_at` + contradiction count.
 * Entries with any contradiction (or both validated+contradicted) enter the
 * contest queue — supersede/deprecate stays human-confirmed.
 */
function aggregateSignals(projectRoot) {
  const byId = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "knowledge-delta.json") {
        let data;
        try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
        for (const input of data?.inputs ?? []) {
          const id = String(input.knowledge_id ?? "");
          if (!id) continue;
          const signal = String(input.signal ?? "");
          if (!["validated", "contradicted", "cited"].includes(signal)) continue;
          const count = Number(input.count ?? 1);
          const record = byId.get(id) ?? { validated: 0, contradicted: 0, cited: 0, lastRecordedAt: null };
          record[signal] += count;
          const ts = input.last_recorded_at ?? input.first_recorded_at;
          if (ts && (!record.lastRecordedAt || ts > record.lastRecordedAt)) record.lastRecordedAt = ts;
          byId.set(id, record);
        }
      }
    }
  };
  walk(join(projectRoot, ".workflow", "sessions"));
  return [...byId.entries()]
    .map(([id, record]) => ({ id, ...record }))
    .sort((a, b) => (b.contradicted + b.validated) - (a.contradicted + a.validated));
}

/**
 * Cross-run candidate index (Phase 2B): scan all run knowledge-delta
 * `candidates`, group by title, and flag near-duplicates staged in multiple
 * runs — advisory signal for reconciliation before promotion. Also carries the
 * earliest `first_recorded_at`/`created_at` per title (candidate TTL input)
 * and the candidate ids per title (signal cross-reference input).
 */
function aggregateCandidates(projectRoot) {
  const byTitle = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "knowledge-delta.json") {
        let data;
        try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
        // Session-level ledgers (session-knowledge-delta/1.0) carry no run_id;
        // attribute by session so cross-source duplication stays visible
        // instead of collapsing into "?" (K7 origin split).
        const runId = data.schema_version === "session-knowledge-delta/1.0"
          ? `session:${data.session_id ?? "?"}`
          : (data.run_id ?? "?");
        for (const candidate of data.candidates ?? []) {
          const title = String(candidate.title ?? "").trim();
          if (!title) continue;
          const record = byTitle.get(title) ?? {
            title,
            runs: [],
            sourceKinds: new Set(),
            candidateIds: new Set(),
            firstRecordedAt: null,
          };
          if (!record.runs.includes(runId)) record.runs.push(runId);
          if (candidate.source_kind) record.sourceKinds.add(String(candidate.source_kind));
          if (candidate.candidate_id) record.candidateIds.add(String(candidate.candidate_id));
          const ts = candidate.first_recorded_at ?? candidate.created_at;
          if (ts && (!record.firstRecordedAt || ts < record.firstRecordedAt)) record.firstRecordedAt = ts;
          byTitle.set(title, record);
        }
      }
    }
  };
  walk(join(projectRoot, ".workflow", "sessions"));
  return [...byTitle.values()]
    .map((r) => ({
      title: r.title,
      runs: r.runs,
      sourceKinds: [...r.sourceKinds],
      candidateIds: [...r.candidateIds],
      firstRecordedAt: r.firstRecordedAt,
    }))
    .filter((r) => r.runs.length > 1) // cross-run duplication signal
    .sort((a, b) => b.runs.length - a.runs.length);
}

/** Contest queue: entries with contradictions (or validated+contradicted clash). */
function buildContestItems(signals) {
  return signals
    .filter((s) => s.contradicted > 0 || (s.validated > 0 && s.contradicted > 0))
    .map((s) => ({
      id: `CONTEST-${s.id.slice(0, 12)}`,
      target: s.id,
      priority: "P1",
      subtype: s.contradicted > 1 ? "contradicted-multiple" : "validated-contradicted-clash",
      suggestedAction: {
        action: "contest-review",
        reason: `validated ×${s.validated} · contradicted ×${s.contradicted}${s.lastRecordedAt ? ` · last ${s.lastRecordedAt}` : ""}`,
        command: "maestro knowledge review <session> --resolve --as supersede|conflict --reason \"contest resolved\"",
      },
    }));
}

/**
 * review_required 统计（A3）: 遍历 .workflow/sessions 下所有 knowledge-delta.json
 * 的 candidates，按 session 分组统计 status==='review_required' 的候选数与最早的
 * first_recorded_at/created_at（真实 schema 字段见本仓库 ledger 样例）。
 */
function aggregateReviewRequired(projectRoot) {
  const bySession = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "knowledge-delta.json") {
        let data;
        try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
        const sessionId = String(data.session_id ?? "?");
        for (const candidate of data.candidates ?? []) {
          if (String(candidate.status ?? "") !== "review_required") continue;
          const record = bySession.get(sessionId) ?? { sessionId, count: 0, firstRecordedAt: null };
          record.count += 1;
          const ts = candidate.first_recorded_at ?? candidate.created_at;
          if (ts && (!record.firstRecordedAt || ts < record.firstRecordedAt)) record.firstRecordedAt = ts;
          bySession.set(sessionId, record);
        }
      }
    }
  };
  walk(join(projectRoot, ".workflow", "sessions"));
  const bySessionArr = [...bySession.values()]
    .map((g) => ({ session_id: g.sessionId, count: g.count, firstRecordedAt: g.firstRecordedAt }))
    .sort((a, b) => b.count - a.count);
  return {
    total: bySessionArr.reduce((n, g) => n + g.count, 0),
    bySession: bySessionArr,
  };
}

/** 滞留超过 7 天的 review_required session 组 → revalidation 项（SE-RR-<session>）。 */
function buildReviewRequiredItems(reviewRequired) {
  const items = [];
  const now = Date.now();
  for (const g of reviewRequired.bySession) {
    if (!g.firstRecordedAt) continue;
    const ts = Date.parse(g.firstRecordedAt);
    if (Number.isNaN(ts)) continue;
    if (now - ts <= 7 * DAY_MS) continue;
    items.push({
      id: `SE-RR-${g.session_id}`,
      target: g.session_id,
      priority: "P2",
      subtype: "review-required-stale",
      suggestedAction: {
        action: "review-resolve",
        reason: `${g.count} 个候选滞留 review_required 超过 7 天（最早 ${g.firstRecordedAt}）`,
        command: `maestro knowledge review ${g.session_id} --resolve <candidate-id> --as rejected|supersede --reason "review required stale"`,
      },
    });
  }
  return items;
}

/**
 * 候选 TTL（A4）: 跨 run 候选若 earliest firstRecordedAt 距今 >30 天且该 title
 * 无任何 validated/cited 信号 → revalidation 项（SE-EXPIRED-<titleHash8>）。
 * advisory 明确：可 review --resolve --as rejected|supersede，或保持 pending 审计。
 */
function buildExpiredCandidateItems(crossRunCandidates, signals) {
  const items = [];
  const now = Date.now();
  for (const c of crossRunCandidates) {
    if (!c.firstRecordedAt) continue;
    const ts = Date.parse(c.firstRecordedAt);
    if (Number.isNaN(ts)) continue;
    if (now - ts <= 30 * DAY_MS) continue;
    const hasSignal = signals.some(
      (s) => (s.validated + s.cited) > 0 && (s.id === c.title || c.candidateIds.includes(s.id)),
    );
    if (hasSignal) continue;
    items.push({
      id: `SE-EXPIRED-${sha256(c.title).slice(0, 8)}`,
      target: c.title,
      priority: "P3",
      subtype: "candidate-expired",
      suggestedAction: {
        action: "review-expired-candidate",
        reason: `跨 run 候选自 ${c.firstRecordedAt} 起 >30 天无 validated/cited 信号`,
        command: `maestro knowledge review <session-id> --resolve <candidate-id> --as rejected|supersede --reason "candidate expired"（或保持 pending 审计）`,
        advisory: true,
      },
    });
  }
  return items;
}

/** 负反馈统计（A6）: reviews/*.jsonl 聚合 + suggestions/*.jsonl unknown 占比。 */
function aggregateReviews() {
  const records = readJsonDirLines(join(OUTPUT_DIR, "reviews"));
  const totals = { records: records.length, stage: 0, skip: 0, uncertain: 0, withVerdict: 0 };
  const scoreBuckets = { lt04: 0, lt06: 0, lt08: 0, gte08: 0 };
  for (const r of records) {
    const verdict = String(r.verdict ?? r.decision ?? r.stage_verdict ?? "").trim().toLowerCase();
    if (verdict) totals.withVerdict += 1;
    if (verdict === "stage" || r.stage === true) totals.stage += 1;
    else if (verdict === "skip" || r.skip === true) totals.skip += 1;
    else if (verdict === "uncertain" || r.uncertain === true) totals.uncertain += 1;
    const score = Number(r.score);
    if (Number.isFinite(score)) {
      if (score < 0.4) scoreBuckets.lt04 += 1;
      else if (score < 0.6) scoreBuckets.lt06 += 1;
      else if (score < 0.8) scoreBuckets.lt08 += 1;
      else scoreBuckets.gte08 += 1;
    }
  }
  const suggestions = readJsonDirLines(join(OUTPUT_DIR, "suggestions"));
  const suggestionUnknown = suggestions.filter((s) => String(s.candidateType ?? "") === "unknown").length;
  totals.suggestionRecords = suggestions.length;
  totals.suggestionUnknown = suggestionUnknown;
  const unknownRatio = suggestions.length > 0 ? suggestionUnknown / suggestions.length : null;
  return { totals, scoreBuckets, unknownRatio };
}

/**
 * approval 对账（A7）: approvals/*.jsonl 中 action=promote 的 receipt 统计 + 扫描
 * ledgers 中被 promote 的候选（真实 schema 标记字段 status/promoted_id/promotion_receipt）。
 * 字段取不到时仅报告 receipt 统计并注明 advisory。
 */
function aggregateApprovals(projectRoot) {
  const receipts = readJsonDirLines(join(OUTPUT_DIR, "approvals"));
  const promote = receipts.filter((r) => r.action === "promote");
  const emptyCandidatesReceipts = promote.filter((r) => !Array.isArray(r.candidates) || r.candidates.length === 0);
  let promotedInLedgers = 0;
  let promotedFieldObserved = false;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "knowledge-delta.json") {
        let data;
        try { data = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
        for (const candidate of data?.candidates ?? []) {
          if (candidate.promoted_id !== undefined || candidate.promotion_receipt !== undefined || candidate.status !== undefined) {
            promotedFieldObserved = true;
          }
          const promoted = candidate.status === "promoted" || candidate.promoted_id || candidate.promotion_receipt;
          if (promoted) promotedInLedgers += 1;
        }
      }
    }
  };
  walk(join(projectRoot, ".workflow", "sessions"));
  let advisory = null;
  if (!promotedFieldObserved && promotedInLedgers === 0) {
    advisory = "ledger schema 未发现 promoted 标记字段（status/promoted_id/promotion_receipt）— 仅报告 receipt 统计";
  }
  return {
    promoteReceipts: promote.length,
    emptyCandidatesReceipts: emptyCandidatesReceipts.length,
    promotedInLedgers,
    advisory,
    emptyCandidatesReceiptsList: emptyCandidatesReceipts,
  };
}

/** candidates 为空的 promote receipt → revalidation 项（SE-NO-CANDIDATES-<session>）。 */
function buildApprovalGapItems(approval) {
  return approval.emptyCandidatesReceiptsList.map((receipt) => ({
    id: `SE-NO-CANDIDATES-${receipt.sessionId ?? "?"}`,
    target: receipt.sessionId ?? "?",
    priority: "P2",
    subtype: "approval-missing-candidates",
    suggestedAction: {
      action: "backfill-receipt",
      reason: `promote receipt 无 candidates（${receipt.approvedAt ?? "?"}）`,
      command: `node scripts/self-evolve-approval.mjs record --action promote --session ${receipt.sessionId ?? "?"} --candidates <id> --reason "<why>"（或核对 ledger）`,
    },
  }));
}

// ── 治理闭环 handled 标记（A5）───────────────────────────────────────────────

function loadHandled() {
  try { return JSON.parse(readFileSync(HANDLED_PATH, "utf8")) ?? {}; } catch { return {}; }
}

function writeHandled(map) {
  mkdirSync(dirname(HANDLED_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(HANDLED_PATH, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function markHandled(itemId, action) {
  if (!itemId) {
    console.error("usage: node scripts/self-evolve-health.mjs mark <item-id> [--action <a>]");
    process.exit(1);
  }
  const map = loadHandled();
  map[itemId] = { handledAt: nowIso(), action: action || null };
  writeHandled(map);
  console.log(`HEALTH HANDLED — ${itemId}${action ? ` (action=${action})` : ""} → ${HANDLED_PATH}`);
}

function unmarkHandled(itemId) {
  if (!itemId) {
    console.error("usage: node scripts/self-evolve-health.mjs unmark <item-id>");
    process.exit(1);
  }
  const map = loadHandled();
  if (Object.prototype.hasOwnProperty.call(map, itemId)) {
    delete map[itemId];
    writeHandled(map);
    console.log(`HEALTH UNMARKED — ${itemId} → ${HANDLED_PATH}`);
  } else {
    console.log(`HEALTH UNMARKED — ${itemId}（未在 handled 记录中）`);
  }
}

function buildHealth() {
  const specHealth = runMaestroJson("spec health --json");
  const audit = runMaestroJson("knowledge audit --json");
  const signalAggregates = aggregateSignals(process.cwd());
  const crossRunCandidates = aggregateCandidates(process.cwd());
  const reviewRequired = aggregateReviewRequired(process.cwd());
  const reviews = aggregateReviews();
  const approval = aggregateApprovals(process.cwd());

  const revalidation = [];
  for (const contest of buildContestItems(signalAggregates)) revalidation.push(contest);
  for (const item of buildReviewRequiredItems(reviewRequired)) revalidation.push(item);
  for (const item of buildExpiredCandidateItems(crossRunCandidates, signalAggregates)) revalidation.push(item);
  for (const item of buildApprovalGapItems(approval)) revalidation.push(item);
  if (specHealth && !specHealth.error) {
    if (specHealth.staleActive > 0) {
      revalidation.push({
        id: "HEALTH-stale-active",
        target: "spec corpus",
        priority: "P1",
        subtype: "stale-active",
        suggestedAction: { action: "re-review", reason: `${specHealth.staleActive} active spec(s) stale (freshness < 0.5)`, command: "maestro spec health --json → review stale entries" },
      });
    }
    if (specHealth.contested > 0) {
      revalidation.push({
        id: "HEALTH-contested",
        target: "spec corpus",
        priority: "P1",
        subtype: "contested",
        suggestedAction: { action: "conflict-mark-resolve", reason: `${specHealth.contested} contested spec(s) awaiting conflict disposition`, command: "maestro spec conflict mark <file> <line> --note \"<reason>\"" },
      });
    }
    for (const chain of specHealth.danglingSupersedes ?? []) {
      revalidation.push({ id: "HEALTH-dangling-supersedes", target: String(chain), priority: "P2", subtype: "dangling-supersedes", suggestedAction: { action: "fix-chain", reason: "supersedes points to a missing entry", command: "maestro spec health → repair chain" } });
    }
    for (const chain of specHealth.cyclicSids ?? []) {
      revalidation.push({ id: "HEALTH-cyclic", target: String(chain), priority: "P2", subtype: "cyclic-chain", suggestedAction: { action: "fix-chain", reason: "cyclic supersede chain", command: "maestro spec health → repair cycle" } });
    }
  }
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  for (const finding of findings) {
    if (finding.priority === "P1" || ["ghost-code-reference", "invalid-knowledge-ledger"].includes(finding.subtype)) {
      revalidation.push({
        id: finding.id,
        target: finding.target,
        priority: finding.priority,
        subtype: finding.subtype,
        suggestedAction: suggestAction(finding),
      });
    }
  }
  revalidation.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0));

  // 治理闭环：过滤已 handled 的 itemId
  const handled = loadHandled();
  const filtered = revalidation.filter((item) => !Object.prototype.hasOwnProperty.call(handled, item.id));

  const findingsByPriority = {};
  for (const finding of findings) {
    findingsByPriority[finding.priority] = (findingsByPriority[finding.priority] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    kind: "health",
    generatedAt: nowIso(),
    project: basename(process.cwd()),
    sources: { specHealth: !!specHealth && !specHealth.error, audit: !!audit && !audit.error },
    specHealth: specHealth?.error ? { error: specHealth.error } : specHealth ?? null,
    audit: audit?.error ? { error: audit.error } : {
      generatedAt: audit?.generated_at,
      findingsCount: findings.length,
      findingsByPriority,
      prunePlan: audit?.prune_plan,
      safety: audit?.safety,
    },
    revalidation: filtered,
    revalidationCount: filtered.length,
    reviewRequired,
    reviews,
    approvalReconcile: {
      promoteReceipts: approval.promoteReceipts,
      emptyCandidatesReceipts: approval.emptyCandidatesReceipts,
      promotedInLedgers: approval.promotedInLedgers,
      advisory: approval.advisory,
    },
    crossRunCandidates: crossRunCandidates.map((c) => ({
      title: c.title,
      runs: c.runs.length,
      sourceKinds: c.sourceKinds,
      firstRecordedAt: c.firstRecordedAt,
    })),
    signals: {
      total: signalAggregates.length,
      validated: signalAggregates.reduce((n, e) => n + e.validated, 0),
      contradicted: signalAggregates.reduce((n, e) => n + e.contradicted, 0),
      cited: signalAggregates.reduce((n, e) => n + e.cited, 0),
      entries: signalAggregates.map((e) => ({
        id: e.id,
        validated: e.validated,
        contradicted: e.contradicted,
        cited: e.cited,
        lastRecordedAt: e.lastRecordedAt,
      })),
    },
  };
}

function formatSummary(health) {
  const s = health.specHealth ?? {};
  const rrStale = health.revalidation.filter((r) => r.subtype === "review-required-stale").length;
  const reviews = health.reviews ?? { totals: { records: 0, stage: 0, skip: 0, uncertain: 0 }, scoreBuckets: {}, unknownRatio: null };
  const approval = health.approvalReconcile ?? { promoteReceipts: 0, emptyCandidatesReceipts: 0, advisory: null };
  const lines = [
    `SELF-EVOLVE HEALTH — ${health.project} @ ${new Date(health.generatedAt).toLocaleString()}`,
    `  specs: ${s.total ?? "?"} total · ${s.active ?? "?"} active · ${s.deprecated ?? "?"} deprecated · ${s.contested ?? 0} contested · ${s.staleActive ?? 0} stale`,
    `  identity: ${s.withSid ?? "?"} with sid · ${s.withoutSid ?? 0} missing · ${s.chains ?? 0} chains · freshness ${(s.avgFreshness ?? 0).toFixed(2)}`,
    `  audit findings: ${health.audit?.findingsCount ?? 0}${health.audit?.findingsByPriority ? ` (${JSON.stringify(health.audit.findingsByPriority)})` : ""}`,
    `  cross-run duplicate candidates: ${health.crossRunCandidates.length}`,
    `  signals: validated ${health.signals.validated} · contradicted ${health.signals.contradicted} · cited ${health.signals.cited} (${health.signals.total} entries, 全量)`,
    `  review-required: ${health.reviewRequired?.total ?? 0}（滞留>7d 入队 ${rrStale}）`,
    `  reviews: ${reviews.totals.records} 记录（stage ${reviews.totals.stage}/skip ${reviews.totals.skip}/uncertain ${reviews.totals.uncertain}）· unknown ${reviews.unknownRatio === null ? "n/a" : `${(reviews.unknownRatio * 100).toFixed(1)}%`}`,
    `  approval: promote receipts ${approval.promoteReceipts} · 空 candidates ${approval.emptyCandidatesReceipts}${approval.advisory ? ` · ⚠ ${approval.advisory}` : ""}`,
    `  revalidation queue: ${health.revalidationCount} (contest ${health.revalidation.filter((r) => r.subtype.startsWith("contest")).length} · audit ${health.revalidation.filter((r) => r.id.startsWith("KAU") || r.id.startsWith("HEALTH")).length} · self-evolve ${health.revalidation.filter((r) => r.id.startsWith("SE-")).length})`,
  ];
  for (const item of health.revalidation.slice(0, 8)) {
    lines.push(`    [${item.priority}] ${item.id} ${item.subtype} → ${item.suggestedAction.action}: ${item.target}`);
  }
  if (health.revalidationCount > 8) lines.push(`    … +${health.revalidationCount - 8} more`);
  lines.push(`  → saved: ${join(OUTPUT_DIR, "health.json")}`);
  lines.push(`  → saved: ${join(OUTPUT_DIR, `health-${health.project}.json`)}`);
  return lines.join("\n");
}

function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "mark") {
    markHandled(args._[1], String(args.action ?? ""));
    return;
  }
  if (command === "unmark") {
    unmarkHandled(args._[1]);
    return;
  }
  if (command !== undefined) {
    console.error(`unknown command: ${command}`);
    console.error("usage: node scripts/self-evolve-health.mjs [mark <item-id> [--action <a>] | unmark <item-id>]");
    process.exit(1);
  }
  const health = buildHealth();
  const json = `${JSON.stringify(health, null, 2)}\n`;
  writeFileSync(join(OUTPUT_DIR, "health.json"), json, { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(OUTPUT_DIR, `health-${health.project}.json`), json, { encoding: "utf8", mode: 0o600 });
  console.log(formatSummary(health));
}

main();

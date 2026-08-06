#!/usr/bin/env node
/**
 * self-evolve health sidecar generator (Phase 3 — knowledge health loop).
 *
 * Rebuildable knowledge-health snapshot for the current project, written to
 * the GLOBAL output root so it never pollutes git:
 *
 *   ~/.maestro/self-evolve/health.json        (default)
 *   $SELF_EVOLVE_OUTPUT_DIR/health.json       (env override)
 *
 * Sources (all deterministic maestro CLI):
 *   - `maestro spec health --json`            freshness / chains / identity
 *   - `maestro knowledge audit --json`        findings / prune plan / safety
 *
 * Output: health summary + a revalidation queue (stale / contested / dangling /
 * high-priority findings) with suggested governance actions. The queue feeds
 * the skill's `health` intent: conflict mark → supersede → audit prune.
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { basename } from "node:path";

const OUTPUT_DIR = process.env.SELF_EVOLVE_OUTPUT_DIR?.trim()
  ? resolve(process.env.SELF_EVOLVE_OUTPUT_DIR)
  : resolve(homedir(), ".maestro", "self-evolve");

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
 * runs — advisory signal for reconciliation before promotion.
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
        const runId = data.run_id ?? "?";
        for (const candidate of data.candidates ?? []) {
          const title = String(candidate.title ?? "").trim();
          if (!title) continue;
          const record = byTitle.get(title) ?? { title, runs: [], sourceKinds: new Set() };
          if (!record.runs.includes(runId)) record.runs.push(runId);
          if (candidate.source_kind) record.sourceKinds.add(String(candidate.source_kind));
          byTitle.set(title, record);
        }
      }
    }
  };
  walk(join(projectRoot, ".workflow", "sessions"));
  return [...byTitle.values()]
    .map((r) => ({ title: r.title, runs: r.runs, sourceKinds: [...r.sourceKinds] }))
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

function buildHealth() {
  const specHealth = runMaestroJson("spec health --json");
  const audit = runMaestroJson("knowledge audit --json");
  const signalAggregates = aggregateSignals(process.cwd());
  const crossRunCandidates = aggregateCandidates(process.cwd());

  const revalidation = [];
  for (const contest of buildContestItems(signalAggregates)) revalidation.push(contest);
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

  const findingsByPriority = {};
  for (const finding of findings) {
    findingsByPriority[finding.priority] = (findingsByPriority[finding.priority] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    kind: "health",
    generatedAt: new Date().toISOString(),
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
    revalidation,
    revalidationCount: revalidation.length,
    crossRunCandidates: crossRunCandidates.map((c) => ({
      title: c.title,
      runs: c.runs.length,
      sourceKinds: c.sourceKinds,
    })),
    signals: {
      total: signalAggregates.length,
      validated: signalAggregates.reduce((n, e) => n + e.validated, 0),
      contradicted: signalAggregates.reduce((n, e) => n + e.contradicted, 0),
      cited: signalAggregates.reduce((n, e) => n + e.cited, 0),
      entries: signalAggregates.slice(0, 10).map((e) => ({
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
  const lines = [
    `SELF-EVOLVE HEALTH — ${health.project} @ ${new Date(health.generatedAt).toLocaleString()}`,
    `  specs: ${s.total ?? "?"} total · ${s.active ?? "?"} active · ${s.deprecated ?? "?"} deprecated · ${s.contested ?? 0} contested · ${s.staleActive ?? 0} stale`,
    `  identity: ${s.withSid ?? "?"} with sid · ${s.withoutSid ?? 0} missing · ${s.chains ?? 0} chains · freshness ${(s.avgFreshness ?? 0).toFixed(2)}`,
    `  audit findings: ${health.audit?.findingsCount ?? 0}${health.audit?.findingsByPriority ? ` (${JSON.stringify(health.audit.findingsByPriority)})` : ""}`,
    `  cross-run duplicate candidates: ${health.crossRunCandidates.length}`,
    `  signals: validated ${health.signals.validated} · contradicted ${health.signals.contradicted} · cited ${health.signals.cited} (${health.signals.total} entries)`,
    `  revalidation queue: ${health.revalidationCount} (contest ${health.revalidation.filter((r) => r.subtype.startsWith("contest")).length} · audit ${health.revalidation.filter((r) => r.id.startsWith("KAU") || r.id.startsWith("HEALTH")).length})`,
  ];
  for (const item of health.revalidation.slice(0, 8)) {
    lines.push(`    [${item.priority}] ${item.id} ${item.subtype} → ${item.suggestedAction.action}: ${item.target}`);
  }
  if (health.revalidationCount > 8) lines.push(`    … +${health.revalidationCount - 8} more`);
  lines.push(`  → saved: ${join(OUTPUT_DIR, "health.json")}`);
  return lines.join("\n");
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const health = buildHealth();
writeFileSync(join(OUTPUT_DIR, "health.json"), `${JSON.stringify(health, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(formatSummary(health));

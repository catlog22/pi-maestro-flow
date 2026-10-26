import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import test from "node:test";
import { aggregateReviews, aggregateApprovals, aggregateSignals, formatSummary } from "../../../scripts/self-evolve-health.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "se-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function jsonl(root, kind, records) {
  mkdirSync(join(root, kind), { recursive: true });
  writeFileSync(join(root, kind, "2026-08-23.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n{malformed\n");
}

function ledger(root, source, inputs = [], candidates = []) {
  const dir = join(root, ".workflow", "sessions", source);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "knowledge-delta.json"), JSON.stringify({ inputs, candidates }));
}

test("canonical review batches count every nested action and score, not wrapper fields", (t) => {
  const root = fixture(t);
  jsonl(root, "reviews", [
    { project: "current", verdict: "stage", score: 0, verdicts: [
      { action: "stage", score: 0.8 }, { action: "skip", score: 0.4 },
      { action: "uncertain", score: 0.6 }, { action: "skip", score: 0.39 },
    ] },
    { project: "current", verdict: "stage", score: 0.9, verdicts: [] },
  ]);
  const result = aggregateReviews("current", root);
  assert.equal(result.totals.records, 2);
  assert.equal(result.totals.withVerdict, 4);
  assert.equal(result.totals.stage, 1);
  assert.equal(result.totals.skip, 2);
  assert.equal(result.totals.uncertain, 1);
  assert.deepEqual(result.scoreBuckets, { lt04: 1, lt06: 1, lt08: 1, gte08: 1 });
});

test("legacy flat verdict/decision/stage_verdict and boolean flags remain supported", (t) => {
  const root = fixture(t);
  jsonl(root, "reviews", [
    { project: "current", verdict: " STAGE ", score: "0.8" },
    { project: "current", decision: "skip", score: 0.5 },
    { project: "current", stage_verdict: "uncertain", score: 0.7 },
    { project: "current", stage: true, score: 0.2 },
    { project: "current", skip: true }, { project: "current", uncertain: true },
  ]);
  const result = aggregateReviews("current", root);
  assert.equal(result.totals.records, 6);
  assert.equal(result.totals.stage, 2);
  assert.equal(result.totals.skip, 2);
  assert.equal(result.totals.uncertain, 2);
  assert.deepEqual(result.scoreBuckets, { lt04: 1, lt06: 1, lt08: 1, gte08: 1 });
});

test("mixed-project and unscoped reviews/suggestions cannot contaminate current metrics", (t) => {
  const root = fixture(t);
  jsonl(root, "reviews", [
    { project: "current", verdicts: [{ action: "stage", score: 0.9 }] },
    { project: "other", verdicts: [{ action: "skip", score: 0.1 }] },
    { verdict: "skip", score: 0.1 }, null, { project: "", verdict: "skip" },
  ]);
  jsonl(root, "suggestions", [
    { project: "current", candidateType: "unknown" },
    { project: "current", candidateType: "knowhow" },
    { project: "other", candidateType: "unknown" }, { candidateType: "unknown" },
  ]);
  const result = aggregateReviews("current", root);
  assert.equal(result.totals.records, 1);
  assert.equal(result.totals.skip, 0);
  assert.equal(result.unknownRatio, 0.5);
  assert.deepEqual(result.coverage.reviews, { total: 5, included: 1, unscoped: 3, otherProjects: 1 });
  assert.deepEqual(result.coverage.suggestions, { total: 4, included: 2, unscoped: 1, otherProjects: 1 });
  assert.match(result.advisory, /无 project.*已排除/);
});

test("missing/invalid scores and malformed nested rows never manufacture quality evidence", (t) => {
  const root = fixture(t);
  jsonl(root, "reviews", [{ project: "current", verdicts: [
    null, 42, {}, ...[null, "", " ", true, false, "bad", -1, 2].map((score) => ({ action: "uncertain", score })),
    { action: "stage", score: 0 }, { action: "stage", score: 1 },
  ] }]);
  assert.deepEqual(aggregateReviews("current", root).scoreBuckets, { lt04: 1, lt06: 0, lt08: 0, gte08: 1 });
});

test("missing suggestion types are unavailable evidence, not known-type successes", (t) => {
  const root = fixture(t);
  jsonl(root, "suggestions", [{ project: "current" }, { project: "current", candidateType: "invalid" }]);
  const result = aggregateReviews("current", root);
  assert.equal(result.unknownRatio, null);
  assert.equal(result.totals.suggestionTyped, 0);
  assert.match(result.advisory, /不可判定/);
  jsonl(root, "suggestions", [{ project: "current" }, { project: "current", candidateType: "unknown" }]);
  assert.equal(aggregateReviews("current", root).unknownRatio, 1);
});

test("empty or legacy-only input explicitly reports insufficient scoped data", (t) => {
  const root = fixture(t);
  for (const seed of [false, true]) {
    if (seed) jsonl(root, "reviews", [{ verdict: "stage", score: 1 }]);
    const result = aggregateReviews("current", root);
    assert.equal(result.totals.records, 0);
    assert.equal(result.totals.stage, 0);
    assert.equal(result.unknownRatio, null);
    assert.match(result.advisory, /数据不足，不代表健康/);
  }
});

test("approval reconciliation excludes foreign/unscoped receipts instead of creating false gaps", (t) => {
  const root = fixture(t);
  const project = basename(root);
  jsonl(root, "approvals", [
    { project, action: "promote", candidates: ["approved"] },
    { project, action: "promote", sessionId: "current-empty", candidates: [] },
    { project: "other", action: "promote", candidates: [] },
    { action: "promote", sessionId: "legacy", candidates: [] },
  ]);
  ledger(root, "current", [], [{ status: "promoted" }]);
  const result = aggregateApprovals(root, root);
  assert.equal(result.promoteReceipts, 2);
  assert.equal(result.emptyCandidatesReceipts, 1);
  assert.equal(result.emptyCandidatesReceiptsList[0].sessionId, "current-empty");
  assert.equal(result.promotedInLedgers, 1);
  assert.deepEqual(result.coverage, { total: 4, included: 2, unscoped: 1, otherProjects: 1 });
  assert.match(result.advisory, /不能据此判定当前项目缺少批准/);
});

test("legacy-only approval receipts do not prove approval coverage or missing approval", (t) => {
  const root = fixture(t);
  jsonl(root, "approvals", [{ action: "promote", candidates: [] }]);
  const result = aggregateApprovals(root, root);
  assert.equal(result.promoteReceipts, 0);
  assert.equal(result.emptyCandidatesReceiptsList.length, 0);
  assert.match(result.advisory, /无法判断批准覆盖率/);
});

test("ledger evidence preserves zero validated for cited/consumed and real contradiction counts", (t) => {
  const root = fixture(t);
  ledger(root, "a", [
    { knowledge_id: "known", signal: "cited", count: 2 },
    { knowledge_id: "known", signal: "consumed", count: 9 },
    { knowledge_id: "known", signal: "contradicted", count: 1 },
  ]);
  const [known] = aggregateSignals(root);
  assert.equal(known.validated, 0);
  assert.equal(known.cited, 2);
  assert.equal(known.contradicted, 1);
  ledger(root, "b", [{ knowledge_id: "known", signal: "validated", count: 3 }]);
  assert.equal(aggregateSignals(root)[0].validated, 3);
});

test("summary exposes scoped data warnings and n/a instead of a healthy inference", (t) => {
  const root = fixture(t);
  const summary = formatSummary({
    project: "current", generatedAt: "2026-08-23T00:00:00Z", revalidation: [], revalidationCount: 0,
    crossRunCandidates: [], signals: { validated: 0, contradicted: 0, cited: 0, total: 0 },
    reviews: aggregateReviews("current", root), approvalReconcile: aggregateApprovals(root, root),
  });
  assert.match(summary, /validated 0/);
  assert.match(summary, /unknown n\/a/);
  assert.match(summary, /数据不足，不代表健康/);
});

test("importing health helpers never runs maestro or writes snapshot/handled files", (t) => {
  const root = fixture(t);
  const output = join(root, "must-not-be-created");
  const moduleUrl = new URL("../../../scripts/self-evolve-health.mjs", import.meta.url).href;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)}); console.log('import-only');`], {
    cwd: root, encoding: "utf8", env: { ...process.env, SELF_EVOLVE_OUTPUT_DIR: output },
  });
  assert.equal(stdout.trim(), "import-only");
  assert.equal(existsSync(output), false);
});

test("Skill routes publication through canonical closeout, never default bulk or session-sealed gates", () => {
  const skill = readFileSync(new URL("../../../.pi/skills/self-evolve/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /~\/\.maestro\/ref\/knowledge-closeout\.md/);
  assert.match(skill, /session\/3\.0/);
  for (const word of ["content hash", "identity/revision", "evidence roots/hash", "最终提交", "固定", "人工批准", "数据不足"]) {
    assert.ok(skill.includes(word), word);
  }
  assert.doesNotMatch(skill, /session 源候选先 session complete 再 promote|Session sealed（session complete）|seal 后默认步骤/);
  assert.doesNotMatch(skill, /^maestro knowledge promote .*--all/gm);
  assert.match(skill, /历史 T2 特殊批次（非默认行为）/);
  assert.match(skill, /review-only 不授予 refresh\/resolve\/promote 权限/);
  for (const tag of ["required_reading", "purpose", "dispatch", "execution", "guardrails", "success_criteria"]) {
    assert.equal((skill.match(new RegExp(`<${tag}>`, "g")) || []).length, 1);
    assert.equal((skill.match(new RegExp(`</${tag}>`, "g")) || []).length, 1);
  }
});

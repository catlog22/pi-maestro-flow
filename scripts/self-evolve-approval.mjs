#!/usr/bin/env node
/**
 * self-evolve approval receipt recorder (Phase 2B — governance hardening).
 *
 * Records a durable approval receipt for knowledge-governance actions
 * (promote / supersede / deprecate / conflict-mark) to the GLOBAL output root,
 * so promotion has an audit trail independent of the maestro ledger:
 *
 *   ~/.maestro/self-evolve/approvals/<date>.jsonl   (default)
 *   $SELF_EVOLVE_OUTPUT_DIR/approvals/<date>.jsonl  (env override)
 *
 * Usage:
 *   node scripts/self-evolve-approval.mjs record \
 *     --action promote --session <session-id> --reason "<why>" \
 *     [--candidates <id1,id2>] [--actor <name>]
 *   node scripts/self-evolve-approval.mjs query \
 *     [--session <sid>] [--action <a>] [--candidate <id>] [--json]
 *   node scripts/self-evolve-approval.mjs reconcile
 *
 * The skill's `promote` intent calls record AFTER the CLI promote succeeds, so
 * every governance action has a signed (actor+reason+timestamp) receipt.
 * `verify` for promote queries the REAL session seal state (three-state
 * sealed=true/false/unavailable) — never "有输出即 checked".
 */

import { execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUTPUT_DIR = process.env.SELF_EVOLVE_OUTPUT_DIR?.trim()
  ? resolve(process.env.SELF_EVOLVE_OUTPUT_DIR)
  : resolve(homedir(), ".maestro", "self-evolve");
const APPROVALS_DIR = join(OUTPUT_DIR, "approvals");

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
      } else {
        args[key] = value;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`usage: node scripts/self-evolve-approval.mjs <command> [args]
  record --action <promote|supersede|deprecate|conflict-mark> --session <session-id> --reason "<why>" [--candidates <id1,id2>] [--actor <name>]
  query  [--session <sid>] [--action <a>] [--candidate <id>] [--json]
  reconcile`);
  process.exit(1);
}

/** 从 stdout 提取首个 {...} JSON 片段（maestro 输出可能混有日志）。 */
function parseJsonish(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/**
 * 真实三态 verify（C1）: 查询 maestro session status 的 sealed/status 字段。
 * 先确认命令存在（maestro session status --help），再试 --json（v0.5.63 不支持，
 * 报 "unknown option"），回落普通输出（本身是 JSON，含 status 字段）。
 * 返回 sealed: true | false | "unavailable"，绝不再「有输出即 checked」。
 */
function verifySealed(sessionId) {
  try {
    execSync("maestro session status --help", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    console.warn("verify: maestro session status 命令不可用 — sealed 标 unavailable");
    return { sealed: "unavailable", method: "command-missing" };
  }
  // 1) 先试 --json
  try {
    const raw = execSync(`maestro session status ${JSON.stringify(sessionId)} --json`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseJsonish(raw);
    const status = parsed?.status ?? parsed?.sealed;
    if (parsed && status !== undefined) {
      return { sealed: status === "sealed" || status === true, method: "session-status-json" };
    }
  } catch { /* --json 不被支持（实测 v0.5.63）→ 回落普通输出 */ }
  // 2) 回落：普通输出（JSON，含 status 字段）
  try {
    const raw = execSync(`maestro session status ${JSON.stringify(sessionId)}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseJsonish(raw);
    const status = parsed?.status ?? parsed?.sealed;
    if (parsed && status !== undefined) {
      return { sealed: status === "sealed" || status === true, method: "session-status" };
    }
    console.warn(`verify: 无法从 session status 输出解析 sealed/status 字段 — ${sessionId} 标 unavailable`);
    return { sealed: "unavailable", method: "parse-failed" };
  } catch (error) {
    console.warn(`verify: maestro session status 调用失败 — ${sessionId} 标 unavailable（${error instanceof Error ? error.message : String(error)}）`);
    return { sealed: "unavailable", method: "call-failed" };
  }
}

/** 读取全部 approvals/<date>.jsonl receipt。 */
function readAllReceipts() {
  const out = [];
  let files = [];
  try {
    files = readdirSync(APPROVALS_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return out;
  }
  for (const f of files) {
    let text = "";
    try { text = readFileSync(join(APPROVALS_DIR, f), "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { out.push({ ...JSON.parse(t), _file: f }); } catch { /* skip malformed line */ }
    }
  }
  return out;
}

/** query（C2）: 按 --session/--action/--candidate 过滤；--json 输出数组；无匹配 (empty)。 */
function runQuery(args) {
  const sid = String(args.session ?? "");
  const action = String(args.action ?? "");
  const candidate = String(args.candidate ?? "");
  const asJson = args.json === true || String(args.json ?? "") === "true";
  const filtered = readAllReceipts().filter((r) => {
    if (sid && r.sessionId !== sid) return false;
    if (action && r.action !== action) return false;
    if (candidate && !(Array.isArray(r.candidates) && r.candidates.includes(candidate))) return false;
    return true;
  });
  if (asJson) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  if (filtered.length === 0) {
    console.log("(empty)");
    return;
  }
  for (const r of filtered) {
    const candidates = Array.isArray(r.candidates) && r.candidates.length ? r.candidates.join(",") : "(no candidates)";
    console.log(`${r.approvedAt ?? "?"} | ${r.action ?? "?"} | ${r.sessionId ?? "?"} | ${candidates} | ${r.reason ?? ""} | ${r._file ?? ""}`);
  }
}

/**
 * reconcile（C3）: 扫描当前项目 .workflow/sessions 下全部 knowledge-delta.json 中被
 * promote 的候选（真实 schema 标记字段 status/promoted_id/promotion_receipt），
 * 与 approvals 里 action=promote 的 receipt 按 (sessionId, candidate) 对照，
 * 输出缺失 receipt 的列表；schema 字段取不到时输出 advisory 并只报 receipt 统计。
 */
function runReconcile() {
  const receipts = readAllReceipts().filter((r) => r.action === "promote");
  const emptyCandidates = receipts.filter((r) => !Array.isArray(r.candidates) || r.candidates.length === 0);
  const promoted = []; // { sessionId, candidateId, title }
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
          const promotedMarker = candidate.status === "promoted" || candidate.promoted_id || candidate.promotion_receipt;
          if (!promotedMarker) continue;
          promoted.push({
            sessionId: String(data.session_id ?? ""),
            candidateId: String(candidate.candidate_id ?? candidate.id ?? ""),
            title: String(candidate.title ?? ""),
          });
        }
      }
    }
  };
  walk(join(process.cwd(), ".workflow", "sessions"));
  if (!promotedFieldObserved && promoted.length === 0) {
    console.log("[reconcile] advisory: ledger schema 未发现 promoted 标记字段（status/promoted_id/promotion_receipt）— 仅报告 receipt 统计");
    console.log(`  promote receipts: ${receipts.length} · 空 candidates: ${emptyCandidates.length}`);
    return;
  }
  const missing = [];
  for (const p of promoted) {
    const hit = receipts.some(
      (r) => r.sessionId === p.sessionId && Array.isArray(r.candidates) && r.candidates.includes(p.candidateId),
    );
    if (!hit) missing.push(p);
  }
  if (missing.length === 0) {
    console.log(`[reconcile] OK — ${promoted.length} 个已 promote 候选均有对应 receipt`);
    return;
  }
  console.log(`[reconcile] 缺失 receipt（${missing.length}/${promoted.length} 个已 promote 候选）:`);
  for (const m of missing) {
    console.log(`  ${m.sessionId || "(?)"} | ${m.candidateId || "(?)"} | ${m.title || ""}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
if (command === "query") {
  runQuery(args);
  process.exit(0);
}
if (command === "reconcile") {
  runReconcile();
  process.exit(0);
}
if (command !== "record") usage();

const action = String(args.action ?? "");
const sessionId = String(args.session ?? "");
const reason = String(args.reason ?? "");
if (!["promote", "supersede", "deprecate", "conflict-mark"].includes(action) || !sessionId || !reason) {
  usage();
}

const candidates = String(args.candidates ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const actor = String(args.actor ?? "") || (userInfo().username ?? "unknown");

// Optional verify step: confirm the source run is sealed (promote gate).
// 真实三态 sealed=true/false/unavailable；SELF_EVOLVE_VERIFY=0 可跳过。
let verification = { sealed: null, method: "skipped" };
if (action === "promote" && process.env.SELF_EVOLVE_VERIFY !== "0") {
  verification = verifySealed(sessionId);
  if (verification.sealed === "unavailable") {
    console.warn(`verify: ${sessionId} sealed 状态 unavailable — receipt 仍会记录，但 promote 门禁未确认`);
  }
}

const receipt = {
  schemaVersion: 1,
  kind: "approval-receipt",
  approvedAt: new Date().toISOString(),
  actor,
  action,
  sessionId,
  reason,
  candidates,
  verification,
  source: "self-evolve skill",
};

mkdirSync(APPROVALS_DIR, { recursive: true, mode: 0o700 });
const date = new Date();
const month = String(date.getMonth() + 1).padStart(2, "0");
const day = String(date.getDate()).padStart(2, "0");
const filePath = join(APPROVALS_DIR, `${date.getFullYear()}-${month}-${day}.jsonl`);

// record 失败处理（C4）: appendFileSync 包 try/catch，失败 exit(1) 并提示目录可写性。
try {
  appendFileSync(filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
} catch (error) {
  console.error(
    `receipt 写入失败: ${error instanceof Error ? error.message : String(error)} — approvals 目录可写性检查：${APPROVALS_DIR}`,
  );
  process.exit(1);
}

console.log(
  `APPROVAL RECEIPT — ${action} ${sessionId} by ${actor}`
  + `${candidates.length ? ` (${candidates.length} candidates)` : ""}`
  + `\n  reason: ${reason}`
  + `\n  sealed: ${verification.sealed ?? "n/a"} (${verification.method})`
  + `\n  → ${filePath}`,
);

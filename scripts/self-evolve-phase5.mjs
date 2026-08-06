#!/usr/bin/env node
/**
 * self-evolve Phase 5 — online verification & skill evolution (受控自动化).
 *
 * Two governed lanes, both writing to the GLOBAL output root
 * (SELF_EVOLVE_OUTPUT_DIR override respected, default ~/.maestro/self-evolve):
 *
 *   A. canary  <knowledge-id|spec-path> [--window <runs>]
 *      High-impact knowledge online verification: mark a candidate as SHADOW
 *      (trial window), observe validated/cited signals from the run ledgers,
 *      then PROMOTE (threshold met) or ROLLBACK (contradicted / window expired
 *      without corroboration). Never mutates the corpus by itself — it only
 *      advises the promote/rollback command.
 *
 *   B. proposal <skill-path> [--content <path|new-content>] [--reason "<why>"]
 *      Skill-modification governance: snapshot (sha256) + diff + permission
 *      delta review (allowed-tools) + static checks (frontmatter, execution
 *      tag pairing) + signature + approval receipt, written to
 *      proposals/<id>/. `apply` restores backup on failed validation;
 *      `revert` restores the snapshot. Requires a non-empty --reason
 *      (explicit approval record) — never silent.
 *
 * Commands: canary | proposal | apply | revert | list
 */

import { execSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const OUTPUT_DIR = process.env.SELF_EVOLVE_OUTPUT_DIR?.trim()
  ? resolve(process.env.SELF_EVOLVE_OUTPUT_DIR)
  : resolve(homedir(), ".maestro", "self-evolve");
const ACTOR = userInfo().username ?? "unknown";
const CANARY_DIR = join(OUTPUT_DIR, "canaries");
const PROPOSAL_DIR = join(OUTPUT_DIR, "proposals");
const APPROVAL_DIR = join(OUTPUT_DIR, "approvals");

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

function usage() {
  console.log(`usage: node scripts/self-evolve-phase5.mjs <command> [args]
  canary <knowledge-id|spec-path> [--window N]              # shadow 观察 → promote/rollback 建议
  proposal <skill-path> [--content <path>] --reason "<why>" # 生成 proposal 包（快照/签名/权限审查/静态检查）
  apply <proposal-id> --reason "<why>"                      # 应用（校验失败自动回滚；reason 非空=批准记录）
  revert <proposal-id> [--reason "<why>"]                   # 回滚到快照
  list [--type canary|proposal]                             # 列表`);
  process.exit(1);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

// ── A. Canary ────────────────────────────────────────────────────────────────

const CANARY_THRESHOLD = 1; // 观察期内 validated/cited 信号 ≥ 1 → promote 建议
const CANARY_WINDOW_DEFAULT = 3; // 默认观察窗口（run 数）

function canaryLedgerPath(id) {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_"); // Windows 文件名不允许 : 等字符
  return join(CANARY_DIR, `${safe}.json`);
}

function canaryStart(id, windowRuns) {
  const ledgerPath = canaryLedgerPath(id);
  const existing = readJson(ledgerPath, null);
  if (existing?.status === "shadow") {
    console.log(`CANARY 已存在: ${id} shadow（窗口内 ${existing.observedRuns}/${existing.windowRuns}）`);
    return existing;
  }
  const ledger = {
    schemaVersion: 1,
    id,
    status: "shadow",
    startedAt: nowIso(),
    windowRuns,
    observedRuns: 0,
    signals: { validated: 0, cited: 0, contradicted: 0 },
    history: [],
  };
  writeJson(ledgerPath, ledger);
  console.log(`CANARY SHADOW — ${id}`);
  console.log(`  观察窗口: ${windowRuns} runs · 阈值: validated/cited ≥ ${CANARY_THRESHOLD}`);
  console.log(`  → ${ledgerPath}`);
  return ledger;
}

function canaryObserve(id) {
  const ledgerPath = canaryLedgerPath(id);
  const ledger = readJson(ledgerPath, null);
  if (!ledger || ledger.status !== "shadow") {
    console.log(`CANARY 非 shadow 状态（${ledger?.status ?? "unknown"}）— 无观察`);
    return ledger;
  }
  // 从全局 health sidecar 的 signals 提取该知识的信号计数
  const health = readJson(join(OUTPUT_DIR, "health.json"), { signals: { entries: [] } });
  const entry = (health.signals?.entries ?? []).find((e) => e.id === id);
  const signals = entry ?? { validated: 0, cited: 0, contradicted: 0 };
  ledger.observedRuns += 1;
  ledger.signals = {
    validated: signals.validated ?? 0,
    cited: signals.cited ?? 0,
    contradicted: signals.contradicted ?? 0,
  };
  ledger.history.push({ at: nowIso(), signals: { ...ledger.signals } });
  const contradicted = ledger.signals.contradicted > 0;
  const corroborated = ledger.signals.validated + ledger.signals.cited >= CANARY_THRESHOLD;
  let verdict = "observing";
  if (contradicted) {
    ledger.status = "rollback";
    verdict = "ROLLBACK";
  } else if (corroborated) {
    ledger.status = "promote";
    verdict = "PROMOTE";
  } else if (ledger.observedRuns >= ledger.windowRuns) {
    ledger.status = "rollback";
    verdict = "ROLLBACK (窗口到期无佐证)";
  }
  writeJson(ledgerPath, ledger);
  console.log(`CANARY OBSERVE — ${id} (${ledger.observedRuns}/${ledger.windowRuns})`);
  console.log(
    `  信号: validated ${ledger.signals.validated} · cited ${ledger.signals.cited} · contradicted ${ledger.signals.contradicted}`,
  );
  console.log(`  判定: ${verdict}`);
  if (ledger.status === "promote") {
    console.log(`  建议命令: maestro knowledge promote <session-id> --candidate ${id} --reason "canary corroborated"`);
  } else if (ledger.status === "rollback") {
    console.log(`  建议命令: maestro knowledge review --resolve --as supersede --target <id> --reason "canary rollback"`);
  }
  return ledger;
}

// ── B. Skill proposal ────────────────────────────────────────────────────────

function staticChecks(targetPath) {
  const problems = [];
  let content;
  try {
    content = readFileSync(targetPath, "utf8");
  } catch {
    return { ok: false, problems: ["文件不可读"] };
  }
  if (!/^---\r?\nname:/.test(content)) problems.push("frontmatter 缺失（须以 --- 开头且含 name）");
  if (!content.includes("description:")) problems.push("frontmatter 缺 description");
  if (!content.includes("allowed-tools:")) problems.push("frontmatter 缺 allowed-tools");
  const openTags = (content.match(/^<(execution|success_criteria|required_reading|purpose|dispatch|error_codes)>\r?$/gm) ?? []).length;
  const closeTags = (content.match(/^<\/(execution|success_criteria|required_reading|purpose|dispatch|error_codes)>\r?$/gm) ?? []).length;
  if (openTags !== closeTags) problems.push(`结构标签不配对（开 ${openTags} / 关 ${closeTags}）`);
  return { ok: problems.length === 0, problems, openTags, closeTags };
}

function permissionDelta(oldContent, newContent) {
  const getTools = (s) => {
    const m = s.match(/^allowed-tools:\s*([^\r\n]*)/m);
    return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
  };
  const oldTools = getTools(oldContent);
  const newTools = getTools(newContent);
  const added = newTools.filter((t) => !oldTools.includes(t));
  const removed = oldTools.filter((t) => !newTools.includes(t));
  const impactful = added.some((t) => ["Bash", "Write", "Edit", "WebFetch", "teammate"].includes(t))
    || removed.length > 0;
  return { added, removed, impactful, note: impactful ? "⚠ 权限差异影响敏感工具，需人工复核" : "权限无敏感变更" };
}

function proposalCreate(targetPath, newContent, reason) {
  if (!targetPath || !reason) usage();
  const oldContent = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  if (!newContent && !oldContent) {
    console.error("proposal: 目标文件不存在且未提供 --content");
    process.exit(1);
  }
  const finalContent = newContent ?? oldContent;
  const id = `PROP-${sha256(targetPath + finalContent)}`;
  const dir = join(PROPOSAL_DIR, id);
  const snapshotPath = join(dir, "snapshot.sha256");
  const diff = oldContent === finalContent
    ? "(无内容变化)"
    : `--- ${targetPath}\n+++ ${targetPath} (proposal)\n${diffLines(oldContent, finalContent)}`;

  const checks = staticChecks(targetPath);
  const perm = permissionDelta(oldContent, finalContent);
  const proposal = {
    schemaVersion: 1,
    id,
    target: targetPath,
    actor: ACTOR,
    proposedAt: nowIso(),
    reason,
    status: "proposed",
    signature: sha256(finalContent),
    snapshotSha256: sha256(oldContent),
    staticChecks: checks,
    permissionDelta: perm,
    diff,
    approval: null,
  };
  writeJson(join(dir, "proposal.json"), proposal);
  writeFileSync(snapshotPath, sha256(oldContent), { encoding: "utf8", mode: 0o600 });
  if (oldContent) copyFileSync(targetPath, join(dir, "previous.md"));
  if (newContent) writeFileSync(join(dir, "proposal.md"), finalContent, { encoding: "utf8", mode: 0o600 });

  console.log(`SKILL PROPOSAL — ${id}`);
  console.log(`  target: ${targetPath}`);
  console.log(`  reason: ${reason}`);
  console.log(`  signature: ${proposal.signature}`);
  console.log(`  静态检查: ${checks.ok ? "OK" : "FAIL"} (${checks.problems.join("; ") || "无"})`);
  console.log(`  权限差异: ${perm.note} ${perm.added.length ? `+${perm.added.join(",")}` : ""} ${perm.removed.length ? `-${perm.removed.join(",")}` : ""}`);
  console.log(`  diff:\n${diff.slice(0, 1600)}`);
  console.log(`  → ${dir}`);
  return proposal;
}

function diffLines(oldContent, newContent) {
  const a = oldContent.split("\n");
  const b = newContent.split("\n");
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`- ${a[i]}`);
      if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    }
  }
  return out.slice(0, 60).join("\n");
}

function proposalApply(id, reason) {
  if (!id || !reason) usage();
  const dir = join(PROPOSAL_DIR, id);
  const proposal = readJson(join(dir, "proposal.json"), null);
  if (!proposal) {
    console.error(`apply: proposal ${id} 不存在`);
    process.exit(1);
  }
  if (proposal.status !== "proposed") {
    console.error(`apply: proposal ${id} 状态为 ${proposal.status}（非 proposed）`);
    process.exit(1);
  }
  const target = proposal.target;
  const oldContent = readFileSync(target, "utf8");
  const proposalFile = join(dir, "proposal.md");
  const finalContent = existsSync(proposalFile) ? readFileSync(proposalFile, "utf8") : readFileSync(target, "utf8");
  const checks = staticChecks(target);
  if (!checks.ok) {
    console.error(`apply: 静态检查失败，中止 → ${checks.problems.join("; ")}`);
    proposal.status = "rejected";
    proposal.staticChecks = checks;
    writeJson(join(dir, "proposal.json"), proposal);
    process.exit(1);
  }
  // 备份 → 写新内容 → 重校验，失败自动回滚
  const backup = join(dir, "backup.md");
  copyFileSync(target, backup);
  writeFileSync(target, finalContent, { encoding: "utf8" });
  const post = staticChecks(target);
  if (!post.ok) {
    copyFileSync(backup, target);
    proposal.status = "rejected";
    proposal.staticChecks = post;
    writeJson(join(dir, "proposal.json"), proposal);
    console.error(`apply: 应用后校验失败，已自动回滚 → ${post.problems.join("; ")}`);
    process.exit(1);
  }
  proposal.status = "applied";
  proposal.approval = { at: nowIso(), actor: ACTOR, reason };
  writeJson(join(dir, "proposal.json"), proposal);
  // approval receipt（与 knowledge promote 同源审计）
  mkdirSync(APPROVAL_DIR, { recursive: true, mode: 0o700 });
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const receipt = {
    schemaVersion: 1,
    kind: "approval-receipt",
    approvedAt: nowIso(),
    actor: ACTOR,
    action: "skill-apply",
    proposalId: id,
    target,
    reason,
  };
  const recPath = join(APPROVAL_DIR, `${date.getFullYear()}-${month}-${day}.jsonl`);
  const fd = openSync(recPath, "a", 0o600);
  writeSync(fd, `${JSON.stringify(receipt)}\n`);
  closeSync(fd);
  console.log(`SKILL APPLY — ${id} → ${target}`);
  console.log(`  approval: ${ACTOR} @ ${proposal.approval.at}`);
  console.log(`  receipt: ${recPath}`);
  console.log(`  revert: node scripts/self-evolve-phase5.mjs revert ${id}`);
  return proposal;
}

function proposalRevert(id, reason) {
  if (!id) usage();
  const dir = join(PROPOSAL_DIR, id);
  const proposal = readJson(join(dir, "proposal.json"), null);
  if (!proposal) {
    console.error(`revert: proposal ${id} 不存在`);
    process.exit(1);
  }
  const backup = join(dir, "backup.md");
  if (!existsSync(backup)) {
    console.error(`revert: 无备份（${id} 未 apply 过或备份缺失）`);
    process.exit(1);
  }
  copyFileSync(backup, proposal.target);
  proposal.status = "reverted";
  proposal.revertedAt = nowIso();
  proposal.revertReason = reason ?? "unrecorded";
  writeJson(join(dir, "proposal.json"), proposal);
  console.log(`SKILL REVERT — ${id} → ${proposal.target}（快照已恢复）`);
  return proposal;
}

function listItems(type) {
  const base = type === "canary" ? CANARY_DIR : PROPOSAL_DIR;
  if (!existsSync(base)) {
    console.log(`(空 — ${base})`);
    return;
  }
  const items = type === "canary"
    ? readdirSync(base).filter((f) => f.endsWith(".json")).map((f) => {
        const d = readJson(join(base, f), {});
        return { id: d.id, status: d.status, observed: `${d.observedRuns ?? 0}/${d.windowRuns ?? "?"}` };
      })
    : readdirSync(base).map((d) => {
        const p = readJson(join(base, d, "proposal.json"), {});
        return { id: p.id, target: p.target, status: p.status, reason: p.reason };
      });
  for (const it of items) {
    console.log(`  ${it.id} | ${it.status} | ${it.target ?? it.observed ?? ""} | ${it.reason ?? ""}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const target = args._[1] ?? String(args.target ?? "");
const windowRuns = Number(args.window ?? CANARY_WINDOW_DEFAULT);
const reason = String(args.reason ?? "");

switch (command) {
  case "canary":
    if (!target) usage();
    canaryObserve(target) ?? canaryStart(target, windowRuns);
    break;
  case "canary-start":
    if (!target) usage();
    canaryStart(target, windowRuns);
    break;
  case "proposal": {
    let newContent = null;
    if (args.content && existsSync(args.content)) newContent = readFileSync(args.content, "utf8");
    else if (args.content) newContent = String(args.content);
    proposalCreate(target, newContent, reason);
    break;
  }
  case "apply":
    proposalApply(target, reason);
    break;
  case "revert":
    proposalRevert(target, reason);
    break;
  case "list":
    listItems(String(args.type ?? "proposal"));
    break;
  default:
    usage();
}

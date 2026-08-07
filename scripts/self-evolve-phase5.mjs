#!/usr/bin/env node
/**
 * self-evolve Phase 5 — online verification & skill evolution (受控自动化).
 *
 * Two governed lanes, both writing to the GLOBAL output root
 * (SELF_EVOLVE_OUTPUT_DIR override respected, default ~/.maestro/self-evolve):
 *
 *   A. canary  <knowledge-id|spec-path> [--window <runs>]
 *      High-impact knowledge online verification: mark a candidate as SHADOW
 *      (trial window), observe validated/cited signals from the run ledgers
 *      (incremental vs signalsBaseline), then PROMOTE (threshold met) or
 *      ROLLBACK (contradicted / window expired without corroboration). The
 *      observation is gated on a FRESH health snapshot (health.json /
 *      health-<project>.json, generated < 1 day ago for this project);
 *      stale snapshots never increment observedRuns. Never mutates the corpus
 *      by itself — it only advises the promote/rollback command.
 *
 *   B. proposal <skill-path> [--content <path|new-content>] [--reason "<why>"]
 *      Skill-modification governance: snapshot (sha256) + diff + permission
 *      delta review (allowed-tools) + static checks (frontmatter, execution
 *      tag pairing — content-based) + signature + approval receipt, written to
 *      proposals/<id>/. `apply` restores backup on failed validation;
 *      `revert` restores the snapshot (requires --reason; sha256 conflict
 *      detection against backup.md needs --force to override). Requires a
 *      non-empty --reason (explicit approval record) — never silent.
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
const HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 天

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
  revert <proposal-id> --reason "<why>" [--force]           # 回滚到快照（--reason 必填；与快照不一致需 --force）
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

/** 追加 approval receipt（apply / revert 同款，approvals/<date>.jsonl）。 */
function appendReceipt(receipt) {
  mkdirSync(APPROVAL_DIR, { recursive: true, mode: 0o700 });
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const recPath = join(APPROVAL_DIR, `${date.getFullYear()}-${month}-${day}.jsonl`);
  const fd = openSync(recPath, "a", 0o600);
  writeSync(fd, `${JSON.stringify(receipt)}\n`);
  closeSync(fd);
  return recPath;
}

// ── A. Canary ────────────────────────────────────────────────────────────────

const CANARY_THRESHOLD = 1; // 观察期内增量 validated/cited 信号 ≥ 1 → promote 建议
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
    schemaVersion: 2, // v2: signalsBaseline 增量观察 + health 快照新鲜度门禁
    id,
    status: "shadow",
    startedAt: nowIso(),
    windowRuns,
    observedRuns: 0,
    signalsBaseline: null, // 首次 observe 时记录当前计数，之后用增量
    baselineRecordedAt: null,
    lastHealthGeneratedAt: null, // 上次 observe 时的 health.generatedAt（快照未更新检测）
    signals: { validated: 0, cited: 0, contradicted: 0 },
    history: [],
  };
  writeJson(ledgerPath, ledger);
  console.log(`CANARY SHADOW — ${id}`);
  console.log(`  观察窗口: ${windowRuns} runs · 阈值: 增量 validated/cited ≥ ${CANARY_THRESHOLD}`);
  console.log(`  → ${ledgerPath}`);
  return ledger;
}

/** 读取新鲜且属于本项目的 health 快照；过期/缺失/非本项目 → null。 */
function readFreshHealth() {
  const projectName = basename(process.cwd());
  const projectHealthPath = join(OUTPUT_DIR, `health-${projectName}.json`);
  const health = readJson(
    existsSync(projectHealthPath) ? projectHealthPath : join(OUTPUT_DIR, "health.json"),
    null,
  );
  if (!health) return null;
  const generatedAt = health.generatedAt ? Date.parse(health.generatedAt) : NaN;
  const fresh = Number.isFinite(generatedAt) && Date.now() - generatedAt <= HEALTH_MAX_AGE_MS;
  if (!fresh || health.project !== projectName) return null;
  return health;
}

function canaryObserve(id) {
  const ledgerPath = canaryLedgerPath(id);
  const ledger = readJson(ledgerPath, null);
  if (!ledger || ledger.status !== "shadow") {
    console.log(`CANARY 非 shadow 状态（${ledger?.status ?? "unknown"}）— 无观察`);
    return ledger;
  }
  const projectName = basename(process.cwd());
  // 新鲜度校验：过期/非本项目 → 警告且不递增 observedRuns、不写判定
  const health = readFreshHealth();
  if (!health) {
    const raw = readJson(
      existsSync(join(OUTPUT_DIR, `health-${projectName}.json`))
        ? join(OUTPUT_DIR, `health-${projectName}.json`)
        : join(OUTPUT_DIR, "health.json"),
      null,
    );
    console.log(`CANARY 跳过 — health 快照过期/非本项目（project=${raw?.project ?? "(无)"}, generatedAt=${raw?.generatedAt ?? "(无)"}）`);
    console.log(`  先运行: node scripts/self-evolve-health.mjs（写入 health.json 与 health-${projectName}.json）`);
    console.log(`  （本次观察不递增 observedRuns，不写判定）`);
    return ledger;
  }
  // 快照未更新：health.generatedAt 与上次 observe 相同 → 提示先重跑 health
  if (ledger.lastHealthGeneratedAt && ledger.lastHealthGeneratedAt === health.generatedAt) {
    console.log(`CANARY 跳过 — health 快照未更新（generatedAt=${health.generatedAt}）`);
    console.log(`  先重跑: node scripts/self-evolve-health.mjs 后再 observe`);
    console.log(`  （observedRuns 不递增）`);
    return ledger;
  }
  // 从全局 health sidecar 的 signals 提取该知识的当前计数（全量 entries）
  const entry = (health.signals?.entries ?? []).find((e) => e.id === id);
  const cur = {
    validated: Number(entry?.validated ?? 0),
    cited: Number(entry?.cited ?? 0),
    contradicted: Number(entry?.contradicted ?? 0),
  };
  // 首次 observe：仅记录 baseline，保持 observedRuns=0
  if (!ledger.signalsBaseline || !ledger.baselineRecordedAt) {
    ledger.signalsBaseline = { ...cur };
    ledger.baselineRecordedAt = nowIso();
    ledger.lastHealthGeneratedAt = health.generatedAt;
    writeJson(ledgerPath, ledger);
    console.log(`CANARY BASELINE — ${id}（signalsBaseline 已记录，observedRuns=0）`);
    console.log(`  基线: validated ${cur.validated} · cited ${cur.cited} · contradicted ${cur.contradicted}`);
    console.log(`  → ${ledgerPath}`);
    return ledger;
  }
  const base = ledger.signalsBaseline ?? {};
  const delta = {
    validated: Math.max(0, cur.validated - Number(base.validated ?? 0)),
    cited: Math.max(0, cur.cited - Number(base.cited ?? 0)),
    contradicted: Math.max(0, cur.contradicted - Number(base.contradicted ?? 0)),
  };
  ledger.observedRuns += 1;
  ledger.signals = { ...delta };
  ledger.history.push({ at: nowIso(), signals: { ...delta }, healthGeneratedAt: health.generatedAt });
  ledger.lastHealthGeneratedAt = health.generatedAt;
  // 判定逻辑保留，但基于增量而非累计
  const contradicted = delta.contradicted > 0;
  const corroborated = delta.validated + delta.cited >= CANARY_THRESHOLD;
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
    `  增量信号: validated ${delta.validated} · cited ${delta.cited} · contradicted ${delta.contradicted}`,
  );
  console.log(`  判定: ${verdict}`);
  if (ledger.status === "promote") {
    // maestro v0.5.63: knowledge promote 无 --reason 选项
    console.log(`  建议命令: maestro knowledge promote <session-id> --candidate ${id}`);
    console.log(`    # session-id 经 maestro knowledge review <session-id> --json 或 run brief 解析`);
  } else if (ledger.status === "rollback") {
    console.log(`  回滚说明（补全 session-id/candidate-id/target 后执行）:`);
    console.log(`    1) 候选未晋升场景: maestro knowledge review <session-id> --resolve <candidate-id> --as rejected --reason "canary rollback: 无佐证"`);
    console.log(`    2) 已晋升为知识条目场景: maestro spec supersede <sid> --by <修正版sid>`);
  }
  return ledger;
}

// ── B. Skill proposal ────────────────────────────────────────────────────────

/** 静态检查：基于内容字符串（proposalCreate/apply 均针对将要写入的内容）。 */
function staticChecksContent(content) {
  const problems = [];
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, problems: ["内容为空或不可读"], openTags: 0, closeTags: 0 };
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
  // id 防碰撞：确定性前缀（target+content）+ 时间后缀（同内容不同 reason 不覆盖）
  const id = `PROP-${sha256(targetPath + finalContent)}-${Date.now().toString(36)}`;
  const dir = join(PROPOSAL_DIR, id);
  const snapshotPath = join(dir, "snapshot.sha256");
  const diff = oldContent === finalContent
    ? "(无内容变化)"
    : `--- ${targetPath}\n+++ ${targetPath} (proposal)\n${diffLines(oldContent, finalContent)}`;

  const checksNew = staticChecksContent(finalContent);
  const checksOld = oldContent ? staticChecksContent(oldContent) : null;
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
    staticChecksNew: checksNew,
    ...(checksOld ? { staticChecksOld: checksOld } : {}),
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
  console.log(`  静态检查(新): ${checksNew.ok ? "OK" : "FAIL"} (${checksNew.problems.join("; ") || "无"})`);
  if (checksOld) console.log(`  静态检查(旧): ${checksOld.ok ? "OK" : "FAIL"} (${checksOld.problems.join("; ") || "无"})`);
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
  // 静态检查基于将要写入的内容
  const checks = staticChecksContent(finalContent);
  if (!checks.ok) {
    console.error(`apply: 静态检查失败，中止 → ${checks.problems.join("; ")}`);
    proposal.status = "rejected";
    proposal.staticChecksNew = checks;
    writeJson(join(dir, "proposal.json"), proposal);
    process.exit(1);
  }
  // 备份 → 写新内容 → 重校验，失败自动回滚
  const backup = join(dir, "backup.md");
  copyFileSync(target, backup);
  writeFileSync(target, finalContent, { encoding: "utf8" });
  const post = staticChecksContent(readFileSync(target, "utf8"));
  if (!post.ok) {
    copyFileSync(backup, target);
    proposal.status = "rejected";
    proposal.staticChecksNew = post;
    writeJson(join(dir, "proposal.json"), proposal);
    console.error(`apply: 应用后校验失败，已自动回滚 → ${post.problems.join("; ")}`);
    process.exit(1);
  }
  proposal.status = "applied";
  proposal.approval = { at: nowIso(), actor: ACTOR, reason };
  writeJson(join(dir, "proposal.json"), proposal);
  // approval receipt（与 knowledge promote 同源审计）
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
  const recPath = appendReceipt(receipt);
  console.log(`SKILL APPLY — ${id} → ${target}`);
  console.log(`  approval: ${ACTOR} @ ${proposal.approval.at}`);
  console.log(`  receipt: ${recPath}`);
  console.log(`  revert: node scripts/self-evolve-phase5.mjs revert ${id} --reason "<why>"`);
  return proposal;
}

function proposalRevert(id, reason, force) {
  // revert 强制 --reason（缺失则 usage 报错）
  if (!id || !reason) usage();
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
  const target = proposal.target;
  // 冲突检测：恢复前比较当前 target 文件 sha256 与 backup.md 的 sha256
  let currentContent = "";
  try { currentContent = readFileSync(target, "utf8"); } catch { currentContent = ""; }
  const backupContent = readFileSync(backup, "utf8");
  const currentSha = sha256(currentContent);
  const backupSha = sha256(backupContent);
  if (currentSha !== backupSha) {
    console.error(`revert: 目标文件与快照不一致（当前 sha256 ${currentSha} ≠ backup ${backupSha}）`);
    console.error(`  diff 摘要:\n${diffLines(currentContent, backupContent).slice(0, 1200)}`);
    if (!force) {
      console.error(`  → 需要 --force 才能覆盖当前修改；已中止`);
      process.exit(1);
    }
    console.error(`  → 已提供 --force，继续恢复`);
  }
  copyFileSync(backup, target);
  proposal.status = "reverted";
  proposal.revertedAt = nowIso();
  proposal.revertReason = reason;
  writeJson(join(dir, "proposal.json"), proposal);
  // revert 写 approval receipt（action: skill-revert，与 apply 同款）
  const receipt = {
    schemaVersion: 1,
    kind: "approval-receipt",
    approvedAt: nowIso(),
    actor: ACTOR,
    action: "skill-revert",
    proposalId: id,
    target,
    reason,
  };
  const recPath = appendReceipt(receipt);
  console.log(`SKILL REVERT — ${id} → ${target}（快照已恢复）`);
  console.log(`  receipt: ${recPath}`);
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
const force = args.force === true || String(args.force ?? "") === "true";

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
    proposalRevert(target, reason, force);
    break;
  case "list":
    listItems(String(args.type ?? "proposal"));
    break;
  default:
    usage();
}

/**
 * 272K 窗口真实会话回放：复现用户报告的「49% nudge 警告 → 超阈值卡住」
 *
 * 数据：dongdiankaifa9 / gpt-5.6-sol / 2026-07-31 真实会话（轨迹首个 nudge 穿越点
 * 原始估算 134,521 ≈ 用户报告的 134,490；超阈值后 240K→257K 横跨 ~25 个回合零压缩，
 * 最终 stop=aborted）。配置按用户报告反推：window=272,000 / maxTokens=128,000 /
 * reserve=16,384 → threshold=235,616 / truncation=139,904 / prune=139,904 / nudge=134,464。
 *
 * 用法（从 packages/pi-maestro-flow 目录）：
 *   node --experimental-transform-types scripts/simulate-272k-stuck.mjs              # HEAD（修复后）
 *   AM_MODULE=...auto-compaction-prefix.ts node ...simulate-272k-stuck.mjs          # 修复前
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME ?? "C:/Users/dyw";
const SESSION_DIR = `${HOME}/.pi/agent/sessions`;
const STUCK_SESSION = `${SESSION_DIR}/--D--dongdiankaifa9--/2026-07-31T01-34-53-937Z_019fb5cf-5df0-7c8a-a4dc-6936d76ac39f/ae3c30c7-2e6b-48ff-84ff-89744ad6a0de/2026-07-31T02-42-07-849Z_019fb60c-eb69-7497-a3d7-f948af799233.jsonl`;
const EXHAUSTED_SESSION = `${SESSION_DIR}/--D--maestro2--/2026-07-24T14-20-58-427Z_019f9480-36bb-769f-a878-af74974d7284.jsonl`;

const AM = process.env.AM_MODULE ?? join(ROOT, "src/compaction/auto-compaction.ts");
const { createMidTurnAutoCompaction, estimateContextTokens, endsWithCompleteToolResultBatch } = await import(pathToFileURL(AM).href);
const { deriveCompactionThreshold } = await import(pathToFileURL(join(dirname(AM), "compaction-threshold.ts")).href);

const CONFIG = { window: 272_000, maxTokens: 128_000, reserveTokens: 16_384 };
const SETTINGS = {
  enabled: true,
  reserveTokens: CONFIG.reserveTokens,
  keepRecentTokens: 20_000,
  soft: { enabled: true, nudgeRatio: 0.7, pruneRatio: 0.8, pruneTargetRatio: 0.7, cache: { enabled: true } },
};
const deriv = deriveCompactionThreshold({
  reserveTokens: CONFIG.reserveTokens,
  contextWindow: CONFIG.window,
  modelMaxTokens: CONFIG.maxTokens,
  soft: SETTINGS.soft,
});

const line = "=".repeat(78);
console.log("== 阈值推导（272K/128K/16,384） ==");
console.log(`  threshold=${deriv.thresholdTokens}  nudge=${deriv.soft.nudgeTokens}  prune=${deriv.soft.pruneTokens}  truncation=${deriv.soft.truncationPointTokens}  outputConstrained=${deriv.soft.outputConstrained}`);
console.log(`  模块: ${AM}`);
console.log(line);

function loadSessionMessages(path) {
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return rows.filter((r) => ["message", "custom", "custom_message"].includes(r.type)).map((r) => r.message).filter(Boolean);
}
function completeBatchSnapshots(msgs) {
  const snaps = [];
  for (let i = 1; i <= msgs.length; i++) {
    if (endsWithCompleteToolResultBatch(msgs.slice(0, i))) snaps.push(msgs.slice(0, i));
  }
  return snaps;
}
function scaleBatch(batch, factor) {
  return batch.map((m) => {
    if (m.role === "assistant" && m.usage && m.usage.totalTokens) {
      const u = m.usage;
      return { ...m, usage: { ...u, totalTokens: Math.round(u.totalTokens * factor), input: Math.round(u.input * factor), output: Math.round(u.output * factor), cacheRead: Math.round(u.cacheRead * factor), cacheWrite: Math.round(u.cacheWrite * factor) } };
    }
    return m;
  });
}
const mkCtx = (events) => ({
  cwd: "D:/dongdiankaifa9",
  model: { contextWindow: CONFIG.window, maxTokens: CONFIG.maxTokens },
  abort() { events.aborts++; },
  compact({ customInstructions, onComplete, onError }) {
    events.compacts.push(String(customInstructions).slice(0, 44));
    if (events.compactMode === "ok") setImmediate(() => onComplete());
  },
  sessionManager: { getBranch: () => [{ type: "message" }] },
  hasPendingMessages: () => false,
  ui: { setStatus() {}, notify(message) { events.notifications.push(message); } },
});
const mkPi = (events) => ({ sendUserMessage(text) { events.followUps.push(text); } });

/** 逐 turn 驱动：返回 { events, turns, perTurn } */
async function drive(batches, compactMode = "ok", settingsOverride) {
  const events = { aborts: 0, compacts: [], notifications: [], followUps: [], compactMode };
  const guard = createMidTurnAutoCompaction(mkPi(events), {
    loadInternals: async () => ({ prepareCompaction: () => ({ messagesToSummarize: [{}] }) }),
    readSettings: () => settingsOverride ?? SETTINGS,
  });
  const ctx = mkCtx(events);
  const perTurn = [];
  for (let t = 0; t < batches.length; t++) {
    const noteBefore = events.notifications.length, compBefore = events.compacts.length;
    const r = await guard.evaluate(batches[t], ctx);
    await guard.onAgentEnd(ctx);
    perTurn.push({
      t,
      est: Math.round(estimateContextTokens(batches[t]).tokens),
      notes: events.notifications.slice(noteBefore),
      compacts: events.compacts.length - compBefore,
      aborts: events.aborts,
      evalUndefined: r === undefined,
    });
  }
  return { events, perTurn };
}
function showTimeline(perTurn, label) {
  console.log(`  ${label}:`);
  for (const e of perTurn) {
    if (e.notes.length === 0 && e.compacts === 0 && !e.evalUndefined && e.aborts === 0) continue;
    const notes = e.notes.map((n) => n.slice(0, 100)).join(" | ");
    console.log(`    t=${String(e.t).padStart(3)} est=${String(e.est).padStart(7)} ${e.evalUndefined ? "[无变更]" : ""} ${e.aborts ? `ABORT(${e.aborts})` : ""} ${e.compacts ? `COMPACT×${e.compacts}` : ""}${notes ? " 通知: " + notes : ""}`);
  }
}
const summarizeEvents = (events, key) => ({
  aborts: events.aborts,
  compacts: events.compacts.length,
  defers: events.notifications.filter((n) => /next completed turn|after the next/.test(n)).length,
  escalates: events.notifications.filter((n) => /remains near/.test(n)).length,
  nudges: events.notifications.filter((n) => /Automatic pruning starts/.test(n)).length,
  followUps: events.followUps,
});

// ---------- S1a：nudge 警告精确复现（缩放到用户报告值 134,490） ----------
console.log(`\nS1a. nudge 警告复现：真实批次缩放到估算=134,490（用户报告值）`);
console.log(line);
{
  const msgs = loadSessionMessages(STUCK_SESSION);
  const snaps = completeBatchSnapshots(msgs);
  // 找首个估算 ≥ nudge 的批次，缩放到恰好 134,490（注意尾随 token 不缩放）
  const idx = snaps.findIndex((s) => estimateContextTokens(s).tokens >= deriv.soft.nudgeTokens);
  const est = estimateContextTokens(snaps[idx]);
  const scale = (134_490 - est.trailingTokens) / est.usageTokens;
  const scaled = scaleBatch(snaps[idx], scale);
  const { events } = await drive([scaled]);
  const nudge = events.notifications.find((n) => n.includes("Automatic pruning starts"));
  console.log(`  原始估算=${Math.round(est.tokens)} → 缩放后=${Math.round(estimateContextTokens(scaled).tokens)}（目标 134,490）`);
  console.log(`  警告原文: ${nudge ?? "（未触发）"}`);
  if (nudge) {
    const ok = nudge.includes("134,490") && nudge.includes("272,000") && nudge.includes("139,904") && nudge.includes("235,616");
    console.log(`  判定: ${ok ? "PASS —— 与用户报告逐字一致" : "FAIL"}（nudge 带内输出约束提示=${nudge.includes("Full-size response headroom") ? "有" : "无"}）`);
  }
}

// ---------- S1b：真实轨迹回放（阈值穿越 → 压缩时机） ----------
console.log(`\nS1b. 真实会话全轨迹回放（51 个完整工具批次）`);
console.log(line);
{
  const msgs = loadSessionMessages(STUCK_SESSION);
  const snaps = completeBatchSnapshots(msgs);
  const { events, perTurn } = await drive(snaps);
  showTimeline(perTurn, "事件");
  const s = summarizeEvents(events);
  console.log(`  汇总: turns=${snaps.length} nudge通知=${s.nudges} escalate通知=${s.escalates} defer通知=${s.defers} compact=${s.compacts} abort=${s.aborts} followUp=${s.followUps.length}`);
}

// ---------- S2：escalate 区观测（缓存门控下剪枝被拦 → action=none，不触发 escalate） ----------
console.log(`\nS2. escalate 区观测：真实批次缩放到 ≈233K ∈ [227,456, 235,616)，缓存门控开启`);
console.log(line);
{
  const msgs = loadSessionMessages(STUCK_SESSION);
  const snaps = completeBatchSnapshots(msgs);
  const late = snaps.at(-1);
  const est = estimateContextTokens(late);
  const scaled = scaleBatch(late, (233_000 - est.trailingTokens) / est.usageTokens);
  const { events } = await drive([scaled, scaled, scaled, scaled]);
  const s = summarizeEvents(events);
  console.log(`  估算=${Math.round(estimateContextTokens(scaled).tokens)}  defer通知=${s.defers}  escalate通知=${s.escalates}  compact=${s.compacts}`);
  console.log(`  说明: 缓存门控（cacheRead 占 ~99%）拦截剪枝 → action=none，escalate 条件(est>=227456 && action==prune)不成立；`);
  console.log(`        触发压缩只走 action=compact 路径（估算严格 > threshold）。该区两版本行为一致（fix C 由 simulate-replay S2 覆盖）。`);
}

// ---------- S3：耗尽 + 宿主吞回调（watchdog 对比） ----------
console.log(`\nS3. 耗尽会话（maestro2, est≈336K ≥ 272,000）+ 宿主 compact 永不回调`);
console.log(line);
{
  const { mock } = await import("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  const msgs = loadSessionMessages(EXHAUSTED_SESSION);
  const snaps = completeBatchSnapshots(msgs);
  const last = snaps.at(-1);
  const events = { aborts: 0, compacts: [], notifications: [], followUps: [], compactMode: "hang" };
  const guard = createMidTurnAutoCompaction(mkPi(events), {
    loadInternals: async () => ({ prepareCompaction: () => ({ messagesToSummarize: [{}] }) }),
    readSettings: () => SETTINGS,
  });
  const ctx = mkCtx(events);
  const runEval = async (tag) => {
    const r = await guard.evaluate(last, ctx);
    await guard.onAgentEnd(ctx);
    console.log(`  ${tag}: est=${Math.round(estimateContextTokens(last).tokens)} abort=${events.aborts} compact=${events.compacts.length} evaluate=${r === undefined ? "禁用" : "运行"}`);
  };
  await runEval("t0");
  await runEval("t1(锁卡)");
  mock.timers.tick(5 * 60_000 + 1);
  const timeoutNotes = events.notifications.filter((n) => /timed out/.test(n)).length;
  const retryPrompts = events.followUps.filter((f) => /Retry compaction/.test(f)).length;
  await runEval("t2(tick后)");
  mock.timers.reset();
  console.log(`  tick 5min 后: 超时通知=${timeoutNotes} retryPrompt=${retryPrompts}`);
  const watchdog = timeoutNotes > 0;
  console.log(`  判定: ${watchdog ? "WATCHDOG 生效（锁被释放，可恢复；无 watchdog 则锁永久卡死）" : "无 watchdog（锁永久卡死：压缩+剪枝静默失效，后续每回合请求被中止）"}`);
}

// ---------- S5：fix C —— escalate 区连续变化估算（真实形状） ----------
console.log(`\nS5. fix C 验证：无可剪内容 + 估算在 escalate 区连续变化（231K→232K→233K），3 回合`);
console.log(line);
{
  const msgs = loadSessionMessages(STUCK_SESSION);
  const snaps = completeBatchSnapshots(msgs);
  const short = snaps.find((s) => { const t = estimateContextTokens(s).tokens; return t > 50_000 && t < 80_000; });
  const est = estimateContextTokens(short);
  const scale = (target) => (target - est.trailingTokens) / est.usageTokens;
  const batches = [231_000, 232_000, 233_000].map((t) => scaleBatch(short, scale(t)));
  const { events } = await drive(batches, "ok", { ...SETTINGS, soft: { ...SETTINGS.soft, cache: { enabled: false } } });
  const s = summarizeEvents(events);
  console.log(`  defer通知=${s.defers}  compact=${s.compacts}  （估算=${batches.map((b) => Math.round(estimateContextTokens(b).tokens)).join("/")}）`);
  const recovered = s.compacts > 0;
  console.log(`  判定: ${recovered ? "RECOVER —— 第 2 个完成回合执行压缩（计数器跨回合存活）" : "STALL —— 3 回合零压缩：每次 evaluate 的 escalate 分支把 defer 计数器清零，永不达 2 回合门槛"}`);
}
console.log(`\nS4. internals 加载器缓存语义对比：首次加载失败（瞬时故障），后续 3 回合`);
console.log(line);
{
  const poison = process.env.CACHE_SEMANTICS === "poison"; // 修复前 pi-internals：失败被缓存，永不重试
  const msgs = loadSessionMessages(EXHAUSTED_SESSION);
  const snaps = completeBatchSnapshots(msgs);
  const last = snaps.at(-1);
  const events = { aborts: 0, compacts: [], notifications: [], followUps: [], compactMode: "ok" };
  let cached = null;
  let failed = false;
  const loader = async () => {
    if (poison && cached) throw cached;                 // 修复前：缓存失败并永久复用
    if (!failed) {                                       // 首次调用失败（瞬时故障）
      failed = true;
      const err = new Error("pi compaction internals resolve failed");
      if (poison) cached = err;
      throw err;
    }
    return { prepareCompaction: () => ({ messagesToSummarize: [{}] }) };
  };
  const guard = createMidTurnAutoCompaction(mkPi(events), { loadInternals: loader, readSettings: () => SETTINGS });
  const ctx = mkCtx(events);
  for (let t = 0; t < 4; t++) {
    await guard.evaluate(last, ctx);
    await guard.onAgentEnd(ctx);
    await new Promise((r) => setImmediate(r)); // 让 setImmediate(onComplete) 有机会触发
  }
  const disabled = events.notifications.filter((n) => /Mid-turn compaction disabled/.test(n)).length;
  const continuations = events.followUps.filter((f) => /Continue the interrupted/.test(f)).length;
  const retries = events.followUps.filter((f) => /Retry compaction/.test(f)).length;
  console.log(`  缓存语义=${poison ? "poison（修复前：失败缓存，永久重试失败）" : "clean（修复后：失败即清缓存，可重试）"}`);
  console.log(`  abort=${events.aborts}  compact=${events.compacts.length}  disabled通知=${disabled}  CONTINUE=${continuations}  RETRY=${retries}`);
  const recovered = events.compacts.length > 0;
  console.log(`  判定: ${poison ? (recovered ? "RECOVER" : "STUCK —— 4 回合零压缩、无继续提示，每回合请求被中止（真实会话 07-31 即此形态）") : (recovered ? "RECOVER —— 第 2 回合重试成功并继续任务" : "STUCK")}`);
}

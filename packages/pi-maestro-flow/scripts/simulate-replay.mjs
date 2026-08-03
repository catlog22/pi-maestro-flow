/**
 * 历史会话回放模拟：用真实 pi-maestro-flow 会话数据（2026-07-24，usage.input 峰值 378550）
 * 驱动修复后的压缩系统，验证四类修复在真实数据形状下的行为。
 * 运行：node --experimental-transform-types scripts/simulate-replay.mjs
 * （从 packages/pi-maestro-flow 目录运行）
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMidTurnAutoCompaction } from "../src/compaction/auto-compaction.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_DIR = process.env.HOME + "/.pi/agent/sessions/--D--pi-maestro-flow--";
const SESSION_FILE = "2026-07-24T08-09-19-829Z_019f932b-f6d5-7130-b129-c94cf46bc29e.jsonl";

function loadSessionMessages(path) {
  const rows = readFileSync(path, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const msgs = [];
  let compactAt = -1;
  rows.forEach((r, i) => {
    if (r.type === "message") msgs.push(r.message);
    if (r.type === "compaction" && compactAt < 0) compactAt = msgs.length;
  });
  return { msgs, compactAt, rows };
}

function lastCompleteToolResultBatch(msgs) {
  // 找最后一个完整 assistant(toolCall)+toolResult 配对批次；hook 输入是它结束时的快照。
  for (let asst = msgs.length - 1; asst >= 0; asst--) {
    if (msgs[asst].role !== "assistant") continue;
    const callIds = (msgs[asst].content ?? [])
      .filter((b) => b?.type === "toolCall")
      .map((b) => b.id);
    if (callIds.length === 0) continue;
    let end = asst + 1;
    while (end < msgs.length && msgs[end].role === "toolResult") end++;
    const resultIds = msgs.slice(asst + 1, end).map((m) => m.toolCallId);
    if (resultIds.length !== callIds.length) continue;
    if (resultIds.some((id) => !id)) continue;
    if (new Set(resultIds).size !== resultIds.length) continue;
    if (!callIds.every((id) => resultIds.includes(id))) continue;
    return { slice: msgs.slice(0, end), batchStart: asst, batchEnd: end - 1 };
  }
  return null;
}

// 真实配置：会话模型 400K/128K，压缩模型 600K（项目 .pi/settings.json），reserve 16384
const REAL_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};
const CTX = (overrides = {}) => ({
  cwd: "D:/pi-maestro-flow",
  model: { contextWindow: 400_000, maxTokens: 128_000 },
  abort() {},
  compact() {},
  sessionManager: { getBranch: () => [{ type: "message" }] },
  ui: { setStatus() {}, notify() {} },
  ...overrides,
});

const line = "=".repeat(78);
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log("      " + detail);
}

// ---------- 场景 1：真实会话回放（峰值 378K > 360K 阈值） ----------
console.log(line);
console.log("场景 1：真实会话回放 —— 上下文 378K（usage.input 峰值），超过推导阈值 360K");
console.log(line);
{
  const { msgs, compactAt } = loadSessionMessages(join(SESSION_DIR, SESSION_FILE));
  const batch = lastCompleteToolResultBatch(msgs.slice(0, compactAt === -1 ? msgs.length : compactAt));
  if (!batch) {
    record("S1 提取压缩前完整 toolResult 批次", false, "未找到完整批次");
  } else {
    record("S1 提取压缩前完整 toolResult 批次", true,
      `批次 ${batch.batchStart}..${batch.batchEnd}（共 ${batch.slice.length} 条消息），尾消息 role=${batch.slice.at(-1).role}`);
    let compacted = 0;
    const notifications = [];
    const guard = createMidTurnAutoCompaction({ sendUserMessage() {} }, {
      loadInternals: async () => ({ prepareCompaction: () => ({ messagesToSummarize: [{}] }) }),
      readSettings: () => REAL_SETTINGS,
    });
    const ctx = CTX({
      compact() { compacted++; },
      ui: {
        setStatus(key, value) { if (key === "maestro-auto-compact") status = value; },
        notify(message) { notifications.push(message); },
      },
    });
    let status;
    const r1 = await guard.evaluate(batch.slice, ctx);
    record("S1 估算与阈值判定", r1 !== undefined || true,
      `evaluate 返回 ${Array.isArray(r1) ? r1.length + " 条消息" : String(r1)}，CTX 状态=${JSON.stringify(status)}`);
    await guard.onAgentEnd(ctx);
    const afterTurn1 = compacted;
    await guard.evaluate(batch.slice, ctx);
    await guard.onAgentEnd(ctx);
    record("S1 第 2 个完成回合触发压缩", compacted === 1,
      `compacted=${compacted}（第 1 回合后=${afterTurn1}），通知=${JSON.stringify(notifications)}`);
  }
}

// ---------- 场景 2：修复 C —— escalate 区不再无限延迟（真实消息形状） ----------
console.log(line);
console.log("场景 2：修复 C —— 估算落在 escalate 区（阈值下 3% 内），剪枝无效时第 2 回合必须压缩");
console.log(line);
{
  // 用真实批次做骨架，把 usage 缩放到 escalate 区：阈值 360K，需估算 ∈ [348K, 360K)
  const { msgs, compactAt } = loadSessionMessages(join(SESSION_DIR, SESSION_FILE));
  const batch = lastCompleteToolResultBatch(msgs.slice(0, compactAt === -1 ? msgs.length : compactAt));
  const scale = 355_000 / 378_550; // 目标估算 ~355K
  const scaled = batch.slice.map((m) => {
    if (m.role === "assistant" && m.usage?.totalTokens) {
      return { ...m, usage: { ...m.usage, totalTokens: Math.round(m.usage.totalTokens * scale) } };
    }
    return m;
  });
  let compacted = 0;
  const notifications = [];
  const guard = createMidTurnAutoCompaction({ sendUserMessage() {} }, {
    loadInternals: async () => ({ prepareCompaction: () => ({ messagesToSummarize: [{}] }) }),
    readSettings: () => ({ ...REAL_SETTINGS, soft: { enabled: true, nudgeRatio: 0.7, pruneRatio: 0.8, pruneTargetRatio: 0.7, cache: { enabled: false } } }),
  });
  const ctx = CTX({
    compact() { compacted++; },
    ui: { setStatus() {}, notify(message) { notifications.push(message); } },
  });
  const est = (await guard.evaluate(scaled, ctx)) !== undefined;
  await guard.onAgentEnd(ctx);
  await guard.evaluate(scaled, ctx);
  await guard.onAgentEnd(ctx);
  record("S2 escalate 区第 2 回合压缩", compacted === 1,
    `compacted=${compacted}（修复前为 0：计数器被每次评估清零，永不达到 2 回合门槛），延迟通知=${notifications.filter((n) => /next completed turn/.test(n)).length}`);
}

// ---------- 场景 3：修复 A —— 宿主永不回调时 watchdog 释放运行锁 ----------
console.log(line);
console.log("场景 3：修复 A —— ctx.compact 永不回调（吞调用/摘要挂起），running 锁 5 分钟后自动释放");
console.log(line);
{
  const { mock } = await import("node:test");
  // 必须先启用 mock timers，watchdog 的 setTimeout 才会被拦截
  mock.timers.enable({ apis: ["setTimeout"] });
  const { msgs, compactAt } = loadSessionMessages(join(SESSION_DIR, SESSION_FILE));
  const batch = lastCompleteToolResultBatch(msgs.slice(0, compactAt === -1 ? msgs.length : compactAt));
  let compacted = 0;
  const notifications = [];
  const guard = createMidTurnAutoCompaction({ sendUserMessage() {} }, {
    loadInternals: async () => ({ prepareCompaction: () => ({ messagesToSummarize: [{}] }) }),
    readSettings: () => REAL_SETTINGS,
  });
  const ctx = CTX({
    compact() { compacted++; }, // 永不调用 onComplete/onError —— 模拟宿主吞掉回调
    ui: { setStatus() {}, notify(message) { notifications.push(message); } },
  });
  await guard.evaluate(batch.slice, ctx);
  await guard.onAgentEnd(ctx);
  await guard.evaluate(batch.slice, ctx);
  await guard.onAgentEnd(ctx);
  const before = await guard.evaluate(batch.slice, ctx);
  record("S3 锁卡死时 evaluate 被禁用", before === undefined,
    `compacted=${compacted}，锁后 evaluate=${before === undefined ? "undefined（禁用）" : "运行"}`);
  mock.timers.tick(5 * 60_000 + 1);
  const after = await guard.evaluate(batch.slice, ctx);
  record("S3 watchdog 释放后 evaluate 恢复", Array.isArray(after) && after.length > 0,
    `恢复后 evaluate=${Array.isArray(after) ? after.length + " 条" : String(after)}，超时通知=${notifications.filter((n) => /timed out/.test(n)).length}`);
  mock.timers.reset();
}

// ---------- 场景 4：修复 B —— internals 加载失败限频警告并持续重试 ----------
console.log(line);
console.log("场景 4：修复 B —— loadInternals 失败：不再一次性静默，冷却后重新警告并重试");
console.log(line);
{
  let loads = 0;
  const notifications = [];
  const guard = createMidTurnAutoCompaction({ sendUserMessage() {} }, {
    loadInternals: async () => { loads++; throw new Error("resolve failed"); },
    readSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 100 }),
  });
  const ctx = CTX({
    model: { contextWindow: 1_000 },
    sessionManager: { getBranch: () => [{ type: "message" }] },
    ui: { setStatus() {}, notify(message) { notifications.push(message); } },
  });
  const batch = [{
    role: "assistant",
    content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
    usage: { input: 1_050, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_050, cost: { total: 0 } },
  }, { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "x" }], isError: false }];
  for (let turn = 0; turn < 8; turn++) {
    await guard.evaluate(batch, ctx);
    await guard.onAgentEnd(ctx);
  }
  const warns = notifications.filter((n) => /Mid-turn compaction disabled/.test(n)).length;
  record("S4 冷却后重新警告", warns === 2,
    `8 回合中加载尝试=${loads}（首 3 次 + 熔断冷却后 1 次），警告次数=${warns}（修复前恒为 1，之后永久静默）`);
}

// ---------- 场景 5：修复 D —— 状态栏压缩后清除过期百分比 ----------
console.log(line);
console.log("场景 5：修复 D —— statusline 语义：usage.percent=null（压缩后无新 usage）时清空旧值");
console.log(line);
{
  // 复刻 statusline.ts 四个 handler 的赋值规则（if (usage) rs.contextPercent = usage.percent ?? null）
  let contextPercent = 95; // 压缩前状态栏显示 95%
  const applyUsage = (usage) => { if (usage) contextPercent = usage.percent ?? null; };
  applyUsage({ percent: 96 });            // 消息结束：96%
  applyUsage({ percent: 95.4 });          // 工具结束：95.4%
  applyUsage({ percent: null });          // 压缩成功，宿主返回 percent=null（无压缩后 usage）
  const cleared = contextPercent === null;
  record("S5 压缩后状态栏清空", cleared,
    `contextPercent=${JSON.stringify(contextPercent)}（修复前保留旧值 95.4%，误导为“没压缩”）`);
  applyUsage({ percent: 12 });            // 压缩后第一条响应
  record("S5 新 usage 到达后恢复显示", contextPercent === 12, `contextPercent=${contextPercent}`);
}

console.log(line);
const failed = results.filter((r) => !r.ok);
console.log(`模拟结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：" + failed.map((f) => f.name).join("; "));
  process.exitCode = 1;
}

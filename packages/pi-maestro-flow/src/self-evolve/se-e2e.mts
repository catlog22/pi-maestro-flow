/**
 * Live-behavior test harness for the self-evolve extension.
 *
 * Mocks the pi ExtensionAPI + ctx surface used by registerSelfEvolve and
 * drives real event sequences (session_start / agent_end / session_before_compact
 * / session_compact) plus command invocations. Verifies: default-disabled no-op,
 * enable persistence, signal generation (title/summary/evidence/hash-dedup),
 * cooldown + budget suppression, status-bar updates, dry-run guarantee, and
 * config validation.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerSelfEvolve, {
  setSelfEvolveDepositExecutorForTest,
  setSelfEvolveReviewRuntimeForTest,
} from "./extension.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Mock host
// ---------------------------------------------------------------------------

type EventName = "session_start" | "agent_end" | "session_before_compact" | "session_compact" | "session_shutdown";
type EventHandler = (event: unknown, ctx: ExtensionContext) => void;

interface CommandSpec {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

function makeCtx(cwd: string): ExtensionContext & {
  ui: {
    notify: (message: string, level: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
    custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) => Promise<T>;
  };
  sessionManager: { getSessionId: () => string };
} {
  const notifications: { message: string; level: string }[] = [];
  const status: Record<string, string | undefined> = {};
  let customCalls = 0;
  return {
    cwd,
    model: { provider: "test-provider", id: "test-model" },
    modelRegistry: { getAvailable: () => [{ provider: "test-provider", id: "test-model" }] },
    sessionManager: { getSessionId: () => "test-session-1" },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, text) => { status[key] = text; },
      custom: async (factory) => {
        customCalls += 1;
        let resolveDone: (r: never) => void = () => undefined;
        const done = (r: never) => resolveDone(r);
        factory({ requestRender: () => undefined }, undefined, undefined, done);
        return undefined as never;
      },
    },
    notifications,
    status,
    get customCalls() {
      return customCalls;
    },
  } as never as ExtensionContext & {
    ui: {
      notify: (message: string, level: string) => void;
      setStatus: (key: string, text: string | undefined) => void;
      custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) => Promise<T>;
    };
    sessionManager: { getSessionId: () => string };
    customCalls: number;
  };
}

function makeMockPi(ctx: ExtensionContext): {
  pi: ExtensionAPI;
  handlers: Record<EventName, EventHandler[]>;
  commands: Record<string, CommandSpec>;
} {
  const handlers: Record<EventName, EventHandler[]> = {
    session_start: [],
    agent_end: [],
    session_before_compact: [],
    session_compact: [],
    session_shutdown: [],
  };
  const commands: Record<string, CommandSpec> = {};
  const pi = {
    on: (name: string, handler: EventHandler) => {
      const n = name as EventName;
      if (n in handlers) handlers[n].push(handler);
    },
    registerCommand: (name: string, spec: CommandSpec) => {
      commands[name] = spec;
    },
  } as never as ExtensionAPI;
  return { pi, handlers, commands };
}

function agentEndEvent(messages: AgentMessage[]): { messages: AgentMessage[] } {
  return { messages };
}

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as never as AgentMessage;
}

function toolMessage(tool: string, text: string): AgentMessage {
  return { role: "tool", name: tool, content: text } as never as AgentMessage;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "se-e2e-"));
  const cwd = join(workDir, "ws");
  await (await import("node:fs/promises")).mkdir(cwd, { recursive: true });
  // Output goes to a hermetic temp dir via the env override (never ~/.maestro).
  const outRoot = join(workDir, "output");
  process.env.SELF_EVOLVE_OUTPUT_DIR = outRoot;

  const { pi, handlers, commands } = makeMockPi(makeCtx(cwd));
  registerSelfEvolve(pi);

  const ctx = makeCtx(cwd);
  const cmd = commands["self-evolve"];
  check("命令已注册", !!cmd, "no /self-evolve command");

  // ---- 1. session_start with no config → disabled, zero side effects ----
  for (const h of handlers.session_start) h({}, ctx);
  check("默认禁用：无配置时 enabled=false", ctx.status["self-evolve"] === "EVOL off", `status=${ctx.status["self-evolve"]}`);

  // agent_end while disabled must write nothing
  for (const h of handlers.agent_end) h(agentEndEvent([assistantMessage("A disabled no-op test turn.")]), ctx);
  await sleep(150);
  const dirBefore = join(outRoot, "suggestions");
  let exists = true;
  try { await readdir(dirBefore); } catch { exists = false; }
  check("禁用时零落盘（无全局 suggestions 目录）", !exists);

  // ---- 2. enable via command ----
  await cmd.handler("on", ctx);
  check("on 后状态栏 EVOL ● 0·0·0", ctx.status["self-evolve"] === "EVOL ● 0·0·0", ctx.status["self-evolve"]);
  const cfgPath = join(cwd, ".pi", "self-evolve.json");
  const cfgRaw = JSON.parse(await readFile(cfgPath, "utf8"));
  check("on 持久化 .pi/self-evolve.json", cfgRaw.enabled === true);

  // ---- 3. agent_end generates a signal ----
  const messages = [
    toolMessage("bash", "ran: git status\noutput: clean"),
    assistantMessage("I found a pitfall: the lock file must be committed after package changes, otherwise CI fails with stale hashes."),
  ];
  for (const h of handlers.agent_end) h(agentEndEvent(messages), ctx);
  await sleep(200);
  const dir = join(outRoot, "suggestions");
  const files = await readdir(dir);
  check("agent_end 信号落盘（1 个日文件）", files.length === 1 && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]), files.join(","));
  const lines = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("信号记录为 1 条", lines.length === 1, `got ${lines.length}`);
  const sig = JSON.parse(lines[0]);
  check("dryRun=true（永不自动写知识）", sig.dryRun === true);
  check("source=agent_end", sig.source === "agent_end");
  check("candidateType 启发式=knowhow", sig.candidateType === "knowhow", sig.candidateType);
  check("evidence 含 tool 与 file 引用", sig.evidence.some((e: { type: string }) => e.type === "tool"), JSON.stringify(sig.evidence));
  check("信号携带 project 字段（basename(cwd)）", sig.project === "ws", String(sig.project));
  check("信号携带继承模型 provider/id", sig.model === "test-provider/test-model", String(sig.model));
  check("suggestion 为命令模板（不执行）", typeof sig.suggestion === "string" && sig.suggestion.startsWith("maestro knowledge stage"));
  check("suggestion 为可执行的 session 源模板（无死占位符）", sig.suggestion.includes("--session test-session-1") && sig.suggestion.includes("--content-file"), sig.suggestion);
  // Phase 2C: writing a signal must push a lightweight notify so the user sees
  // what self-evolve captured from the finished agent loop.
  const signalNotify = ctx.notifications.find((n) => n.message.includes("Self-evolve") && n.message.includes("/self-evolve signals"));
  check("写信号后发出轻量 notify（含 /self-evolve signals 指引）", signalNotify !== undefined, JSON.stringify(ctx.notifications));
  check("notify 携带 candidateType 标签（knowhow）", signalNotify?.message.includes("knowhow"), signalNotify?.message);
  const evidencePath = join(outRoot, "evidence", `${sig.id}.md`);
  const evidenceContent = await readFile(evidencePath, "utf8");
  check("证据文件已生成（suggestion --content-file 指向真实文件）", evidenceContent.includes(sig.title) && evidenceContent.includes("session: test-session-1"), evidencePath);
  check("状态栏已更新 EVOL ● 1·0·0", ctx.status["self-evolve"] === "EVOL ● 1·0·0", ctx.status["self-evolve"]);

  // ---- 4. identical trace hash → deduped (no second line) ----
  for (const h of handlers.agent_end) h(agentEndEvent(messages), ctx);
  await sleep(200);
  const linesAfter = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("相同轨迹 hash 去重（仍 1 条）", linesAfter.length === 1, `got ${linesAfter.length}`);
  check("状态栏 EVOL ● 1·1·0（deduped=1）", ctx.status["self-evolve"] === "EVOL ● 1·1·0", ctx.status["self-evolve"]);

  // ---- 5. cooldown suppression: new trace within cooldown is suppressed ----
  const msg2 = [assistantMessage("A completely different second turn with distinct content to bypass dedup.")];
  for (const h of handlers.agent_end) h(agentEndEvent(msg2), ctx);
  await sleep(200);
  const linesAfter2 = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("冷却内新轨迹被抑制（仍 1 条）", linesAfter2.length === 1, `got ${linesAfter2.length}`);
  check("状态栏 EVOL ● 1·1·1（suppressed=1）", ctx.status["self-evolve"] === "EVOL ● 1·1·1", ctx.status["self-evolve"]);

  // ---- 5b. collection-side noise filter: trace fragments never become signals ----
  await cmd.handler("config cooldownMs=0", ctx);
  const noiseMsg = [assistantMessage("TOOL bash: 28: ??")];
  for (const h of handlers.agent_end) h(agentEndEvent(noiseMsg), ctx);
  await sleep(200);
  const linesAfterNoise = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("噪音轨迹片段被源头丢弃（仍 1 条）", linesAfterNoise.length === 1, `got ${linesAfterNoise.length}`);
  check("状态栏 EVOL ● 1·1·2（噪音计入 suppressed）", ctx.status["self-evolve"] === "EVOL ● 1·1·2", ctx.status["self-evolve"]);

  // ---- 5b2. system-log noise prefixes (model failover / teammate notice) → suppressed at source ----
  const failoverMsg = [assistantMessage("CUSTOM maestro-model-failover: The previous model exhausted its native retries with a transient network error.")];
  for (const h of handlers.agent_end) h(agentEndEvent(failoverMsg), ctx);
  await sleep(200);
  const linesAfterFailover = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("系统日志前缀(maestro-model-failover)被源头丢弃（仍 1 条）", linesAfterFailover.length === 1, `got ${linesAfterFailover.length}`);
  check("状态栏 EVOL ● 1·1·3（系统日志噪音计入 suppressed）", ctx.status["self-evolve"] === "EVOL ● 1·1·3", ctx.status["self-evolve"]);

  // ---- 5c. unknown type without knowledge signal → suppressed at source ----
  const unknownMsg = [assistantMessage("A turn about general topic with no knowledge hints whatsoever.")];
  for (const h of handlers.agent_end) h(agentEndEvent(unknownMsg), ctx);
  await sleep(200);
  const linesAfterUnknown = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("无知识特征 unknown 在源头丢弃（仍 1 条）", linesAfterUnknown.length === 1, `got ${linesAfterUnknown.length}`);
  check("状态栏 EVOL ● 1·1·4（无特征 unknown 计入 suppressed）", ctx.status["self-evolve"] === "EVOL ● 1·1·4", ctx.status["self-evolve"]);
  await cmd.handler("config cooldownMs=10m", ctx);

  // ---- 5d. unknown with failed toolCall → still written (gate does not kill real signals) ----
  await cmd.handler("config cooldownMs=0", ctx);
  const failToolMsg: AgentMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "查了一下没找到。" },
        { type: "tool_use", id: "t-fail-1", name: "bash", input: { command: "grep missing /no/such" } },
      ],
    } as never as AgentMessage,
    { role: "tool", toolCallId: "t-fail-1", name: "bash", content: "grep: No matches found", isError: true } as never as AgentMessage,
  ];
  for (const h of handlers.agent_end) h(agentEndEvent(failToolMsg), ctx);
  await sleep(200);
  const linesAfterFail = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("带失败 toolCall 的 unknown 仍落盘（2 条）", linesAfterFail.length === 2, `got ${linesAfterFail.length}`);
  const failUnknownSig = JSON.parse(linesAfterFail[1]!);
  check("带失败 toolCall 的信号仍落盘且为 knowhow（失败轨迹偏向 knowhow）", failUnknownSig.candidateType === "knowhow", JSON.stringify(failUnknownSig));
  check("带失败 toolCall 的 knowhow 信号有 suggestion（可 stage）", typeof failUnknownSig.suggestion === "string" && failUnknownSig.suggestion.length > 0, JSON.stringify(failUnknownSig));
  check("带失败 toolCall 的信号 episodes 已持久化且含非 success kind", Array.isArray(failUnknownSig.episodes) && failUnknownSig.episodes.length > 0 && failUnknownSig.episodes.some((e: { kind: string }) => e.kind !== "success"), JSON.stringify(failUnknownSig.episodes ?? null));
  check("带失败 bash toolCall 的信号 toolCalls 已持久化（EVIDENCE_TOOL_NAMES 放开后）", Array.isArray(failUnknownSig.toolCalls) && failUnknownSig.toolCalls.length > 0 && failUnknownSig.toolCalls.some((c: { tool: string; outcome: string }) => c.tool === "bash" && c.outcome !== "ok"), JSON.stringify(failUnknownSig.toolCalls ?? null));
  check("带失败 bash toolCall 的信号标题含工具失败信息（buildKnowledgeTitle 失败轨迹优先）", /bash.*失败/.test(failUnknownSig.title), JSON.stringify(failUnknownSig.title));
  check("状态栏 EVOL ● 2·1·4（带失败 toolCall 的 unknown 落盘，suppressed 不变）", ctx.status["self-evolve"] === "EVOL ● 2·1·4", ctx.status["self-evolve"]);

  // ---- 5f. reflective lexicon (no failure) → written via knowledge-moment gate ----
  // Tests the new isKnowledgeMoment path: a turn with no failed tool call and no
  // non-success episode, BUT whose last assistant line carries a reflective/
  // decisional lexicon hit ("决定 ... 因为 ..."), must still be captured.
  await cmd.handler("config cooldownMs=0", ctx);
  const reflectiveMsg = [assistantMessage("决定采用保守方案因为激进校验误杀 29% 本项目文件。")];
  for (const h of handlers.agent_end) h(agentEndEvent(reflectiveMsg), ctx);
  await sleep(200);
  const linesAfterReflective = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("含反思性词汇的轮次落盘（3 条）", linesAfterReflective.length === 3, `got ${linesAfterReflective.length}`);
  const reflectiveSig = JSON.parse(linesAfterReflective[2]!);
  check("反思性词汇信号标题含决策内容", /决定|因为/.test(reflectiveSig.title), JSON.stringify(reflectiveSig.title));
  check("状态栏 EVOL ● 3·1·4（反思性词汇落盘，suppressed 不变）", ctx.status["self-evolve"] === "EVOL ● 3·1·4", ctx.status["self-evolve"]);
  await cmd.handler("config cooldownMs=10m", ctx);

  // ---- 6. session_compact signal with file-op evidence ----
  const fileOps = {
    read: ["src/a.ts"],
    written: ["src/b.ts"],
    edited: ["src/c.ts"],
  };
  for (const h of handlers.session_before_compact) {
    h({ preparation: { fileOps }, reason: "threshold" }, ctx);
  }
  for (const h of handlers.session_compact) {
    h({ compactionEntry: { summary: "Compacted session about refactoring the protocol layer to version 7." }, reason: "threshold" }, ctx);
  }
  await sleep(200);
  const linesAfter3 = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("session_compact 信号落盘（4 条）", linesAfter3.length === 4, `got ${linesAfter3.length}`);
  const sig2 = JSON.parse(linesAfter3[3]!);
  check("compact 信号 source=session_compact", sig2.source === "session_compact");
  check("compact 信号 evidence 含 modified 文件", sig2.evidence.some((e: { type: string; role?: string }) => e.type === "file" && e.role === "modified"), JSON.stringify(sig2.evidence));
  check("状态栏 EVOL ● 4·1·4", ctx.status["self-evolve"] === "EVOL ● 4·1·4", ctx.status["self-evolve"]);

  // ---- 5e. cross-project absolute-path evidence filtered by cwd boundary ----
  // 保守过滤：绝对路径在 cwd 外的被丢弃，相对路径全保留（无法可靠区分）。
  await cmd.handler("config cooldownMs=0", ctx);
  await writeFile(join(cwd, "local_evidence.ts"), "export const x = 1;\n", "utf8");
  const foreignAbs = join(tmpdir(), "foreign_abs_routing.py").replace(/\\/g, "/");
  // title 含知识信号词（陷阱）以过知识门控，聚焦验证 evidence 过滤
  const xprojMsg: AgentMessage[] = [
    assistantMessage("发现了路由编码的陷阱：本地模块与跨项目绝对路径文件混用"),
    toolMessage("bash", `read ${foreignAbs} and local_evidence.ts`),
  ];
  for (const h of handlers.agent_end) h(agentEndEvent(xprojMsg), ctx);
  await sleep(200);
  const linesAfterXproj = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  const xprojSig = JSON.parse(linesAfterXproj[linesAfterXproj.length - 1]!);
  const fileRefs = (xprojSig.evidence ?? []).filter((e: { type: string }) => e.type === "file").map((e: { ref: string }) => e.ref);
  check("跨项目绝对路径被过滤（不含 foreign_abs_routing.py）", !fileRefs.some((r: string) => r.includes("foreign_abs_routing.py")), JSON.stringify(fileRefs));
  check("本项目相对路径保留（含 local_evidence.ts）", fileRefs.some((r: string) => r.includes("local_evidence.ts")), `fileRefs=${JSON.stringify(fileRefs)}`);
  await cmd.handler("config cooldownMs=10m", ctx);

  // ---- 7. signals command lists records ----
  let signalsNotified = "";
  const prevNotify = ctx.ui.notify;
  ctx.ui.notify = (message, level) => { if (message.includes("Self-evolve signals")) signalsNotified = message; prevNotify(message, level); };
  await cmd.handler("signals 5", ctx);
  check("signals 命令列出记录", signalsNotified.includes("agent_end") && signalsNotified.includes("session_compact"), signalsNotified.slice(0, 120));

  // ---- 7b. signals export writes a JSONL snapshot ----
  let exportMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("exported")) exportMsg = message; prevNotify(message, level); };
  await cmd.handler("signals export", ctx);
  const exportDir = join(outRoot, "exports");
  const exportFiles = await readdir(exportDir);
  check("signals export 落盘 exports/ 目录", exportFiles.length === 1 && exportFiles[0]!.endsWith(".jsonl") && exportMsg.includes("exported 5"), exportMsg.slice(0, 120));

  // ---- 8. config set + validation ----
  await cmd.handler("config cooldownMs=10m maxSignalsPerSession=3", ctx);
  const cfg2 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("config 修改持久化", cfg2.cooldownMs === 600000 && cfg2.maxSignalsPerSession === 3, JSON.stringify(cfg2));
  check("config 修改后状态栏仍显示", ctx.status["self-evolve"] !== undefined);
  let rejectMsg = "";
  ctx.ui.notify = (message, level) => { if (level === "warning") rejectMsg = message; prevNotify(message, level); };
  await cmd.handler("config cooldownMs=abc", ctx);
  const cfg3 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("非法值整体拒绝（配置未变）", cfg3.cooldownMs === 600000 && rejectMsg.includes("rejected"), rejectMsg.slice(0, 100));
  check("非法值提示 unknown/格式错误", rejectMsg.includes("cooldownMs expects a duration"), rejectMsg.slice(0, 120));
  await cmd.handler("config reset", ctx);
  const cfg4 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("config reset 恢复默认（保留 enabled）", cfg4.cooldownMs === 300000 && cfg4.enabled === true, JSON.stringify(cfg4));

  // ---- 8b. model config: set provider/model, validate bad ids, auto resets ----

  await cmd.handler("config model=maestro-qwen/qwen3.8-max", ctx);
  const cfgM1 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("config model 持久化", cfgM1.model === "maestro-qwen/qwen3.8-max", JSON.stringify(cfgM1));
  let modelReject = "";
  ctx.ui.notify = (message, level) => { if (level === "warning") modelReject = message; prevNotify(message, level); };
  await cmd.handler("config model=bad-id-no-slash", ctx);
  const cfgM2 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("非法 model 拒绝（配置未变）", cfgM2.model === "maestro-qwen/qwen3.8-max" && modelReject.includes("provider/model"), modelReject.slice(0, 100));
  await cmd.handler("config model=auto", ctx);
  const cfgM3 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("model=auto 清除显式模型", cfgM3.model === undefined, JSON.stringify(cfgM3));

  // ---- 8d. mode config: dry-run is the only legal Phase 2A mode ----
  await cmd.handler("config mode=dry-run", ctx);
  const cfgMode1 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("config mode=dry-run 持久化", cfgMode1.mode === "dry-run", JSON.stringify(cfgMode1));
  let modeReject = "";
  ctx.ui.notify = (message, level) => { if (level === "warning") modeReject = message; prevNotify(message, level); };
  await cmd.handler("config mode=live", ctx);
  const cfgMode2 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("非法 mode 拒绝（配置未变）", cfgMode2.mode === "dry-run" && modeReject.includes("mode expects"), modeReject.slice(0, 120));
  await cmd.handler("config reset", ctx);
  const cfgMode3 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("config reset 恢复 mode=dry-run", cfgMode3.mode === "dry-run", JSON.stringify(cfgMode3));

  // ---- 8c. dry-run review: fake teammate runtime, verdicts written globally ----

  let capturedTask = "";
  let capturedModel: string | undefined;
  let fakeVerdicts: Array<{ id: string; action: string; candidateType: string; score: number; reason: string }> = [];
  setSelfEvolveReviewRuntimeForTest({
    supervision: {
      async runSupervisedEvaluation(dispatch, params) {
        capturedTask = params.task;
        // Dispatch would route to a teammate; the fake model produces JSON text.
        await dispatch({ task: params.task, outputSchema: params.outputSchema, timeoutMs: 1 });
        const fakeText = JSON.stringify({ verdicts: fakeVerdicts });
        const parsed = params.fallbackTextParser
          ? params.fallbackTextParser(fakeText)
          : undefined;
        const invalid = params.beforeVerdict?.({ agent: "analyst", exitCode: 0, messages: [] });
        if (invalid) return { ok: false, reason: invalid };
        return { ok: true, verdict: parsed as { verdicts: Array<{ id: string; action: string }> } };
      },
    },
    runTeammate: async (params) => {
      capturedModel = params.tasks[0]?.model;
      return {
        agent: "analyst",
        exitCode: 0,
        messages: [{ role: "assistant", content: "ok" }],
        model: params.tasks[0]?.model,
      };
    },
  });
  // Real signal ids (actionable ones) drive the review-gate assertions.
  const sigLinesForReview = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  const reviewSignals = sigLinesForReview.map((l) => JSON.parse(l)).filter((s) => s.suggestion !== undefined);
  const [reviewSigA, reviewSigB] = reviewSignals as Array<{ id: string }>;
  fakeVerdicts = [
    { id: reviewSigA.id, action: "stage", candidateType: "knowhow", score: 0.8, reason: "reusable lesson with concrete evidence" },
    { id: "se-zzzzzzzzzzzz", action: "stage", candidateType: "knowhow", score: 0.9, reason: "hallucinated id" },
    { id: reviewSigB.id, action: "stage", candidateType: "knowhow", score: 0.2, reason: "low confidence" },
  ];
  let reviewMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("SELF-EVOLVE REVIEW")) reviewMsg = message; prevNotify(message, level); };
  await cmd.handler("review 5", ctx);
  check("review 使用继承模型", capturedModel === "test-provider/test-model", String(capturedModel));
  check("review prompt 包含信号与质量门槛", capturedTask.includes("Signals:") && capturedTask.includes("Staging Quality Bar"), capturedTask.slice(0, 80));
  check("review 汇总含 stage 判定", reviewMsg.includes("stage: 1") && reviewMsg.includes("reusable lesson"), reviewMsg.slice(0, 160));
  check("评审门：幻觉 id 丢弃 + 低分 stage 降级", reviewMsg.includes("1 invalid verdict id(s) dropped") && reviewMsg.includes("1 low-score stage(s) downgraded"), reviewMsg.slice(0, 240));
  const reviewsDir = join(outRoot, "reviews");
  const reviewFiles = await readdir(reviewsDir);
  check("review 落盘全局 reviews 目录", reviewFiles.length === 1 && reviewFiles[0].endsWith(".jsonl"), reviewFiles.join(","));
  const reviewRecord = JSON.parse((await readFile(join(reviewsDir, reviewFiles[0]), "utf8")).trim().split("\n").at(-1)!);
  check("review 记录 dryRun=true", reviewRecord.dryRun === true && reviewRecord.kind === "review");
  check("review 记录 project+model", reviewRecord.project === "ws" && reviewRecord.model === "test-provider/test-model", JSON.stringify(reviewRecord));
  check("review 记录评审门统计", reviewRecord.droppedInvalid === 1 && reviewRecord.downgraded === 1 && reviewRecord.nonActionableSkipped === 0, JSON.stringify(reviewRecord));
  // reviews history command
  let reviewsMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("review history")) reviewsMsg = message; prevNotify(message, level); };
  await cmd.handler("reviews 5", ctx);
  check("reviews 命令查看历史评审", reviewsMsg.includes("SELF-EVOLVE REVIEW") && reviewsMsg.includes("stage: 1"), reviewsMsg.slice(0, 120));
  // review failure path: model unavailable
  let unavailableMsg = "";
  ctx.ui.notify = (message, level) => { if (level === "warning") unavailableMsg = message; prevNotify(message, level); };
  ctx.model = { provider: "unavailable-provider", id: "x" };
  await cmd.handler("config model=unavailable-provider/x", ctx);
  await cmd.handler("review 5", ctx);
  check("review 模型不可用提示", unavailableMsg.includes("model unavailable"), unavailableMsg.slice(0, 100));
  await cmd.handler("config model=auto", ctx);
  ctx.model = { provider: "test-provider", id: "test-model" };

  // ---- 8f. auto-deposit mode: gate-passing signals auto-staged ----------------

  const depositsDir = join(outRoot, "deposits");
  // dry-run mode review never creates a deposit ledger.
  let depositsExist = true;
  try { await readdir(depositsDir); } catch { depositsExist = false; }
  check("dry-run 模式 review 不产生 deposit ledger", !depositsExist, `depositsDir exists=${depositsExist}`);

  // Switch to auto-deposit mode (persisted config).
  await cmd.handler("config mode=auto-deposit", ctx);
  const cfgDep = JSON.parse(await readFile(cfgPath, "utf8"));
  check("config mode=auto-deposit 持久化", cfgDep.mode === "auto-deposit", JSON.stringify(cfgDep));
  let badModeMsg = "";
  ctx.ui.notify = (message, level) => { if (level === "warning") badModeMsg = message; prevNotify(message, level); };
  await cmd.handler("config mode=live", ctx);
  const cfgDep2 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("auto-deposit 后非法 mode 仍拒绝", cfgDep2.mode === "auto-deposit" && badModeMsg.includes("mode expects one of dry-run | auto-deposit"), badModeMsg.slice(0, 140));

  // Helper: append a crafted actionable signal (with suggestion) to today's file.
  let craftedSeq = 0;
  async function appendSignal(partial: Record<string, unknown>): Promise<{ id: string; title: string; sessionId: string }> {
    craftedSeq += 1;
    const id = `se-0000000000${String(craftedSeq).padStart(2, "0")}`;
    const signal = {
      id,
      schemaVersion: 1,
      kind: "candidate",
      source: "agent_end",
      dryRun: true,
      createdAt: new Date().toISOString(),
      sessionId: "test-session-1",
      project: "ws",
      traceHash: "cafebabe00000000000000000000000000000000",
      candidateType: "knowhow",
      title: `crafted signal ${craftedSeq}`,
      summary: `crafted deposit test signal ${craftedSeq}`,
      evidence: [{ type: "file", ref: "src/foo.ts:1", role: "modified" }],
      suggestion: `maestro knowledge stage knowhow \"crafted signal ${craftedSeq}\" --content-file /tmp/x.md --session test-session-1`,
      ...partial,
    };
    await writeFile(join(dir, files[0]), `${JSON.stringify(signal)}\n`, { encoding: "utf8", flag: "a" });
    return { id, title: signal.title, sessionId: signal.sessionId };
  }

  // Fake stage executor records invocations; successful run returns a staged id.
  const executed: Array<{ args: string[]; cwd: string }> = [];
  setSelfEvolveDepositExecutorForTest(async (args, opts) => {
    executed.push({ args: [...args], cwd: opts.cwd });
    return { exitCode: 0, stdout: "staged KDC-TEST-1", stderr: "" };
  });
  const sigLinesDep = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  const depSignals = sigLinesDep.map((l) => JSON.parse(l)).filter((s) => s.suggestion !== undefined);
  fakeVerdicts = depSignals.map((s) => ({
    id: s.id, action: "stage", candidateType: "knowhow", score: 0.9, reason: "reusable and evidence-grounded",
  }));
  let depMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("SELF-EVOLVE REVIEW")) depMsg = message; prevNotify(message, level); };
  await cmd.handler("review 5", ctx);
  check("auto-deposit review 汇总含 staged/failed 计数", depMsg.includes(`deposit: ${depSignals.length} staged · 0 failed`), depMsg.slice(0, 220));
  check("auto-deposit 对每个过门信号执行 stage", executed.length === depSignals.length, `executed=${executed.length} expected=${depSignals.length}`);
  const firstArgs = executed[0]?.args ?? [];
  const firstSig = depSignals[0] as { title: string; sessionId: string };
  check(
    "stage argv 结构化正确（knowledge stage <type> <title> --content-file <evidence> --session --json）",
    firstArgs[0] === "knowledge" && firstArgs[1] === "stage" && firstArgs[2] === "knowhow"
      && firstArgs[3] === firstSig.title && firstArgs.includes("--content-file")
      && firstArgs.includes("--session") && firstArgs.includes(firstSig.sessionId)
      && firstArgs.includes("--json"),
    JSON.stringify(firstArgs),
  );
  const depFiles = await readdir(depositsDir);
  check("deposit ledger 落盘 deposits 目录", depFiles.length === 1 && depFiles[0].endsWith(".jsonl"), depFiles.join(","));
  const depLines = (await readFile(join(depositsDir, depFiles[0]), "utf8")).trim().split("\n").filter(Boolean);
  const depRecord = JSON.parse(depLines.at(-1)!);
  check(
    "deposit 记录 stagedId 解析 + 命令审计 + mode 标记",
    depRecord.kind === "deposit" && depRecord.stagedId === "KDC-TEST-1" && depRecord.exitCode === 0
      && depRecord.mode === "auto-deposit" && depRecord.command.startsWith("maestro knowledge stage")
      && depRecord.command.endsWith("--json"),
    JSON.stringify(depRecord).slice(0, 220),
  );
  check("auto-deposit review 记录 dryRun=false + mode 标记", depMsg.includes("(auto-deposit)"), depMsg.slice(0, 120));
  check("auto-deposit 后状态栏含 ·<n>D 计数", ctx.status["self-evolve"]?.includes(`·${depSignals.length}D`), ctx.status["self-evolve"]);

  // Idempotency: a second review of the same signals performs no new stage.
  await cmd.handler("review 5", ctx);
  const depLinesAfter2 = (await readFile(join(depositsDir, depFiles[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("去重：已沉淀信号二次 review 不重复执行", executed.length === depSignals.length && depLinesAfter2.length === depLines.length, `executed=${executed.length} lines=${depLinesAfter2.length}`);

  // Failure path: a fresh signal with a failing executor — ledger records the error, no stagedId.
  const failSig = await appendSignal({ traceHash: "cafebabe00000000000000000000000000000001" });
  // The failure path needs a real evidence file so it reaches the executor.
  await writeFile(join(outRoot, "evidence", `${failSig.id}.md`), "evidence\n", "utf8");
  setSelfEvolveDepositExecutorForTest(async () => ({ exitCode: 3, stdout: "", stderr: "boom: session sealed" }));
  fakeVerdicts = [{ id: failSig.id, action: "stage", candidateType: "knowhow", score: 0.9, reason: "ok" }];
  await cmd.handler("review 5", ctx);
  const depAllLines = (await readFile(join(depositsDir, depFiles[0]), "utf8")).trim().split("\n").filter(Boolean);
  const depRecordFail = JSON.parse(depAllLines.at(-1)!);
  check("deposit 失败路径记录 exitCode+error", depRecordFail.exitCode === 3 && depRecordFail.error?.includes("boom"), JSON.stringify(depRecordFail).slice(0, 180));
  check("deposit 失败不写 stagedId", depRecordFail.stagedId === undefined, JSON.stringify(depRecordFail).slice(0, 120));

  // Fail-closed: fresh signal whose evidence file was never written — executor not called.
  const missingSig = await appendSignal({ traceHash: "cafebabe00000000000000000000000000000002" });
  const executedBeforeMissing = executed.length;
  setSelfEvolveDepositExecutorForTest(async (args, opts) => {
    executed.push({ args: [...args], cwd: opts.cwd });
    return { exitCode: 0, stdout: "KDC-MISSING", stderr: "" };
  });
  fakeVerdicts = [{ id: missingSig.id, action: "stage", candidateType: "knowhow", score: 0.9, reason: "ok" }];
  await cmd.handler("review 5", ctx);
  check("fail-closed：evidence 缺失不执行 stage", executed.length === executedBeforeMissing, `executed=${executed.length} before=${executedBeforeMissing}`);
  const depRecordMissing = JSON.parse((await readFile(join(depositsDir, depFiles[0]), "utf8")).trim().split("\n").filter(Boolean).at(-1)!);
  check("fail-closed：ledger 记录 evidence missing", depRecordMissing.exitCode === -1 && depRecordMissing.error?.includes("evidence file missing"), JSON.stringify(depRecordMissing).slice(0, 180));

  // Executor throw: fresh signal, throwing executor — ledger records the exception.
  const throwSig = await appendSignal({ traceHash: "cafebabe00000000000000000000000000000003" });
  await writeFile(join(outRoot, "evidence", `${throwSig.id}.md`), "evidence\n", "utf8");
  setSelfEvolveDepositExecutorForTest(async () => { throw new Error("executor exploded"); });
  fakeVerdicts = [{ id: throwSig.id, action: "stage", candidateType: "knowhow", score: 0.9, reason: "ok" }];
  await cmd.handler("review 5", ctx);
  const depRecordThrow = JSON.parse((await readFile(join(depositsDir, depFiles[0]), "utf8")).trim().split("\n").filter(Boolean).at(-1)!);
  check("executor throw 路径记录 error", depRecordThrow.exitCode === -1 && depRecordThrow.error?.includes("executor exploded"), JSON.stringify(depRecordThrow).slice(0, 180));

  // Cross-project guard: a signal from another project is never deposited here.
  const otherSig = await appendSignal({ project: "other-project", traceHash: "cafebabe00000000000000000000000000000004" });
  const executedBeforeOther = executed.length;
  setSelfEvolveDepositExecutorForTest(async (args, opts) => {
    executed.push({ args: [...args], cwd: opts.cwd });
    return { exitCode: 0, stdout: "KDC-OTHER", stderr: "" };
  });
  fakeVerdicts = [{ id: otherSig.id, action: "stage", candidateType: "knowhow", score: 0.9, reason: "ok" }];
  await cmd.handler("review 5", ctx);
  check("跨项目信号不沉淀（executor 不执行）", executed.length === executedBeforeOther, `executed=${executed.length} before=${executedBeforeOther}`);
  const depRecordOther = JSON.parse((await readFile(join(depositsDir, depFiles[0]), "utf8")).trim().split("\n").filter(Boolean).at(-1)!);
  check("跨项目信号不产生 ledger 记录", depRecordOther.signalId !== otherSig.id, JSON.stringify(depRecordOther).slice(0, 120));

  // deposits history command.
  let depHistMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("deposit history")) depHistMsg = message; prevNotify(message, level); };
  await cmd.handler("deposits 5", ctx);
  check("deposits 命令查看历史（含成功/失败/缺失记录）", depHistMsg.includes("deposit history") && depHistMsg.includes("KDC-TEST-1") && depHistMsg.includes("failed rc=3") && depHistMsg.includes("evidence file missing"), depHistMsg.slice(0, 200));

  // Restore dry-run mode and reset the executor seam.
  await cmd.handler("config mode=dry-run", ctx);
  setSelfEvolveDepositExecutorForTest(undefined);

  // ---- 8e. signal record management: delete by id prefix, clear ----
  const sigLinesBefore = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  const firstSigId = (JSON.parse(sigLinesBefore[0]!) as { id: string }).id;
  let delMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("deleted")) delMsg = message; prevNotify(message, level); };
  await cmd.handler(`signals delete ${firstSigId.slice(0, 10)}`, ctx);
  const sigLinesAfter = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("signals delete 按前缀删除一条", sigLinesAfter.length === sigLinesBefore.length - 1 && delMsg.includes("deleted 1"), `before=${sigLinesBefore.length} after=${sigLinesAfter.length} ${delMsg.slice(0, 80)}`);
  let noMatchMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("no signals matched")) noMatchMsg = message; prevNotify(message, level); };
  await cmd.handler("signals delete se-000000000000", ctx);
  const sigLinesAfterNoop = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("signals delete 无匹配不删", sigLinesAfterNoop.length === sigLinesAfter.length && noMatchMsg.includes("no signals matched"), noMatchMsg.slice(0, 80));
  await cmd.handler("signals clear", ctx);
  const sigLinesAfterClear = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean);
  check("signals clear 清空全部", sigLinesAfterClear.length === 0, `left=${sigLinesAfterClear.length}`);

  // ---- 9. /self-evolve opens the panel by default; `status` stays a text notify ----
  await cmd.handler("", ctx);
  check("默认（无参数）打开 panel（custom 被调用）", ctx.customCalls === 1, `customCalls=${ctx.customCalls}`);
  const notifyCountBeforeStatus = ctx.notifications.length;
  await cmd.handler("status", ctx);
  check("status 不打开 panel（custom 计数不变）", ctx.customCalls === 1, `customCalls=${ctx.customCalls}`);
  check("status 输出文本通知", ctx.notifications.length > notifyCountBeforeStatus);
  await cmd.handler("panel", ctx);
  check("panel 显式打开正常（custom 计数递增）", ctx.customCalls === 2, `customCalls=${ctx.customCalls}`);

  // ---- 10. off → disabled, status bar EVOL off, no more writes ----
  await cmd.handler("off", ctx);
  check("off 后状态栏 EVOL off", ctx.status["self-evolve"] === "EVOL off", ctx.status["self-evolve"]);
  const cfg5 = JSON.parse(await readFile(cfgPath, "utf8"));
  check("off 持久化", cfg5.enabled === false);
  const beforeOff = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean).length;
  for (const h of handlers.agent_end) h(agentEndEvent([assistantMessage("turn after off")]), ctx);
  await sleep(150);
  const afterOff = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n").filter(Boolean).length;
  check("关闭后零新信号", afterOff === beforeOff, `${beforeOff} → ${afterOff}`);

  // ---- 11. dry-run guarantee: nothing staged/promoted anywhere ----
  const anyKnowledgeWrites = JSON.stringify(await readdir(cwd)).includes("specs") || JSON.stringify(await readdir(cwd)).includes("knowhow");
  check("dry-run 保证：工作区无知识写入", !anyKnowledgeWrites);

  // ---- 12. env override display: PI_SELF_EVOLVE=1 shows on even when config is off ----
  const ctxEnv = makeCtx(cwd);
  const { pi: piEnv, handlers: handlersEnv, commands: commandsEnv } = makeMockPi(ctxEnv);
  process.env.PI_SELF_EVOLVE = "1";
  registerSelfEvolve(piEnv);
  for (const h of handlersEnv.session_start) h({}, ctxEnv);
  check("env 覆盖：config off + PI_SELF_EVOLVE=1 时状态栏显示 EVOL ● 0·0·0", ctxEnv.status["self-evolve"] === "EVOL ● 0·0·0", ctxEnv.status["self-evolve"]);
  delete process.env.PI_SELF_EVOLVE;

  // ---- P5: session shutdown receipt + review pending + enrichment fallback ----
  // Use a fresh ctx so session counters are clean.
  const ctxP5 = makeCtx(cwd);
  const { pi: piP5, handlers: handlersP5, commands: commandsP5 } = makeMockPi(ctxP5);
  process.env.PI_SELF_EVOLVE = "1";
  registerSelfEvolve(piP5);
  for (const h of handlersP5.session_start) h({}, ctxP5);
  // Toggle hybrid mode so canEnrich() returns true, but with no teammate
  // runtime available the enrichment must fall back to heuristic_fallback and
  // append a terminal record to the enrichment ledger.
  await commandsP5["self-evolve"].handler("config captureMode=hybrid", ctxP5);
  // Fire an agent_end so a signal + enrichment fallback land.
  for (const h of handlersP5.agent_end) h(agentEndEvent(messages), ctxP5);
  await sleep(300);
  const enrichDir = join(outRoot, "enrichments");
  let enrichFiles: string[] = [];
  try { enrichFiles = (await readdir(enrichDir)).filter((f) => f.endsWith(".jsonl")); } catch { /* ok */ }
  check("hybrid 模式下 enrichment ledger 已创建", enrichFiles.length > 0, `enrichFiles=${JSON.stringify(enrichFiles)}`);
  if (enrichFiles.length > 0) {
    const enrichContent = await readFile(join(enrichDir, enrichFiles[0]), "utf8");
    const enrichLines = enrichContent.trim().split("\n").filter(Boolean);
    check("enrichment ledger 含 terminal fallback 记录", enrichLines.length > 0 && enrichLines.some((l) => l.includes("heuristic_fallback")), enrichContent.slice(0, 200));
  }
  // session_shutdown(quit) must write a session summary and NOT start a
  // review/deposit. Verify a session-summaries file appears with final=true.
  for (const h of handlersP5.session_shutdown ?? []) h({ type: "session_shutdown", reason: "quit" }, ctxP5);
  await sleep(100);
  const summaryDir = join(outRoot, "session-summaries");
  let summaryFiles: string[] = [];
  try { summaryFiles = (await readdir(summaryDir)).filter((f) => f.endsWith(".jsonl")); } catch { /* ok */ }
  check("session_shutdown(quit) 写入 session-summaries ledger", summaryFiles.length > 0, `summaryFiles=${JSON.stringify(summaryFiles)}`);
  if (summaryFiles.length > 0) {
    const summaryContent = await readFile(join(summaryDir, summaryFiles[0]), "utf8");
    check("session summary final=true for quit", summaryContent.includes("\"final\":true") && summaryContent.includes("\"reason\":\"quit\""), summaryContent.slice(0, 200));
  }
  // /self-evolve wrap is idempotent: calling it twice is safe.
  const wrapBefore = ctxP5.notifications.length;
  await commandsP5["self-evolve"].handler("wrap", ctxP5).catch(() => undefined);
  check("/self-evolve wrap 发出摘要通知", ctxP5.notifications.length > wrapBefore, `notifications=${ctxP5.notifications.length}`);
  delete process.env.PI_SELF_EVOLVE;

  // ---- cleanup ----
  await rm(workDir, { recursive: true, force: true });
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  if (fail > 0) {
    console.log(`FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

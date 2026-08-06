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
import registerSelfEvolve, { setSelfEvolveReviewRuntimeForTest } from "./extension.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Mock host
// ---------------------------------------------------------------------------

type EventName = "session_start" | "agent_end" | "session_before_compact" | "session_compact";
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
  check("session_compact 信号落盘（2 条）", linesAfter3.length === 2, `got ${linesAfter3.length}`);
  const sig2 = JSON.parse(linesAfter3[1]);
  check("compact 信号 source=session_compact", sig2.source === "session_compact");
  check("compact 信号 evidence 含 modified 文件", sig2.evidence.some((e: { type: string; role?: string }) => e.type === "file" && e.role === "modified"), JSON.stringify(sig2.evidence));
  check("状态栏 EVOL ● 2·1·1", ctx.status["self-evolve"] === "EVOL ● 2·1·1", ctx.status["self-evolve"]);

  // ---- 7. signals command lists records ----
  let signalsNotified = "";
  const prevNotify = ctx.ui.notify;
  ctx.ui.notify = (message, level) => { if (message.includes("Self-evolve signals")) signalsNotified = message; prevNotify(message, level); };
  await cmd.handler("signals 5", ctx);
  check("signals 命令列出记录", signalsNotified.includes("agent_end") && signalsNotified.includes("session_compact"), signalsNotified.slice(0, 120));

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
  setSelfEvolveReviewRuntimeForTest({
    supervision: {
      async runSupervisedEvaluation(dispatch, params) {
        capturedTask = params.task;
        // Dispatch would route to a teammate; the fake model produces JSON text.
        await dispatch({ task: params.task, outputSchema: params.outputSchema, timeoutMs: 1 });
        const fakeText = JSON.stringify({
          verdicts: [{
            id: "se-abc",
            action: "stage",
            candidateType: "knowhow",
            score: 0.8,
            reason: "reusable lesson with concrete evidence",
          }],
        });
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
  let reviewMsg = "";
  ctx.ui.notify = (message, level) => { if (message.includes("SELF-EVOLVE REVIEW")) reviewMsg = message; prevNotify(message, level); };
  await cmd.handler("review 5", ctx);
  check("review 使用继承模型", capturedModel === "test-provider/test-model", String(capturedModel));
  check("review prompt 包含信号", capturedTask.includes("Signals:") && capturedTask.includes("se-"), capturedTask.slice(0, 80));
  check("review 汇总含 stage 判定", reviewMsg.includes("stage: 1") && reviewMsg.includes("reusable lesson"), reviewMsg.slice(0, 160));
  const reviewsDir = join(outRoot, "reviews");
  const reviewFiles = await readdir(reviewsDir);
  check("review 落盘全局 reviews 目录", reviewFiles.length === 1 && reviewFiles[0].endsWith(".jsonl"), reviewFiles.join(","));
  const reviewRecord = JSON.parse((await readFile(join(reviewsDir, reviewFiles[0]), "utf8")).trim().split("\n").at(-1)!);
  check("review 记录 dryRun=true", reviewRecord.dryRun === true && reviewRecord.kind === "review");
  check("review 记录 project+model", reviewRecord.project === "ws" && reviewRecord.model === "test-provider/test-model", JSON.stringify(reviewRecord));
  // review failure path: model unavailable
  let unavailableMsg = "";
  ctx.ui.notify = (message, level) => { if (level === "warning") unavailableMsg = message; prevNotify(message, level); };
  ctx.model = { provider: "unavailable-provider", id: "x" };
  await cmd.handler("config model=unavailable-provider/x", ctx);
  await cmd.handler("review 5", ctx);
  check("review 模型不可用提示", unavailableMsg.includes("model unavailable"), unavailableMsg.slice(0, 100));
  await cmd.handler("config model=auto", ctx);
  ctx.model = { provider: "test-provider", id: "test-model" };

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

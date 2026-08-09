import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActiveAgent, Details } from "../src/shared/types.ts";
import { AttachOverlay } from "../src/tui/attach-overlay.ts";
import {
  SETTINGS_LOCALE_EVENT,
  applySettingsLocaleEvent,
  checkTuiCatalogCompleteness,
  getTuiLocale,
  initializeTuiLocale,
  onTuiLocaleChange,
} from "../src/tui/locale.ts";
import { TeammateControlCenter } from "../src/tui/model-mapping-overlay.ts";
import { MonitorOverlay, type MonitorSessionRow } from "../src/tui/monitor-overlay.ts";
import { buildProgressTree } from "../src/tui/progress-tree.ts";
import { renderTeammateResult } from "../src/tui/render.ts";
import { SessionSendOverlay } from "../src/tui/session-send-overlay.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function row(): MonitorSessionRow {
  return {
    correlationId: "owner:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    displayName: "review-window",
    agentRole: "window · 1 agents",
    status: "running",
    idleSeconds: 0,
    source: "remote:aaaaaa",
    bound: false,
    kind: "window",
    ownerId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bindable: true,
  };
}

function activeAgent(): ActiveAgent {
  const now = Date.now();
  return {
    agent: "general",
    name: "worker",
    correlationId: "worker-correlation",
    startedAt: now,
    abortController: new AbortController(),
    inbox: [],
    outputLog: [],
    lastActivityAt: now,
    status: "running",
    depth: 0,
    sleepMs: 0,
  } as ActiveAgent;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("TUI locale resolves auto from deterministic system inputs", () => {
  try {
    assert.equal(initializeTuiLocale("auto", {
      environment: { LC_ALL: "zh_CN.UTF-8" },
      resolvedLocale: "en-US",
    }), "zh-CN");
    assert.equal(getTuiLocale(), "zh-CN");

    assert.equal(initializeTuiLocale(undefined, {
      environment: {},
      resolvedLocale: "en-GB",
    }), "en");
    assert.equal(getTuiLocale(), "en");
  } finally {
    initializeTuiLocale("en");
  }
});

test("valid v1 locale events update runtime listeners and invalid events are ignored", () => {
  initializeTuiLocale("en");
  const seen: string[] = [];
  const dispose = onTuiLocaleChange((locale) => seen.push(locale));
  try {
    assert.equal(SETTINGS_LOCALE_EVENT, "maestro:settings:locale");
    assert.equal(applySettingsLocaleEvent({ version: 1, locale: "zh-CN", generation: "test-1" }), true);
    assert.equal(getTuiLocale(), "zh-CN");
    assert.deepEqual(seen, ["zh-CN"]);

    assert.equal(applySettingsLocaleEvent({ version: 2, locale: "en", generation: "test-2" }), false);
    assert.equal(applySettingsLocaleEvent({ version: 1, locale: "zh-TW", generation: "test-3" }), false);
    assert.equal(applySettingsLocaleEvent({ version: 1, locale: "en", generation: "" }), false);
    assert.equal(getTuiLocale(), "zh-CN");
  } finally {
    dispose();
    initializeTuiLocale("en");
  }
});

test("default overlays follow locale events while an explicit constructor locale wins", () => {
  initializeTuiLocale("en");
  let repaintCount = 0;
  const dynamic = new MonitorOverlay({ getSessions: () => [row()], close: () => {} });
  dynamic.setRequestRender(() => { repaintCount += 1; });
  const fixedEnglish = new MonitorOverlay({ getSessions: () => [row()], close: () => {} }, "en");
  try {
    assert.match(stripAnsi(dynamic.render(72).join("\n")), /Select Sessions/);
    assert.equal(applySettingsLocaleEvent({ version: 1, locale: "zh-CN", generation: "live" }), true);
    assert.equal(repaintCount, 1);
    assert.match(stripAnsi(dynamic.render(72).join("\n")), /选择会话/);
    assert.match(stripAnsi(fixedEnglish.render(72).join("\n")), /Select Sessions/);
    assert.doesNotMatch(stripAnsi(fixedEnglish.render(72).join("\n")), /选择会话/);
  } finally {
    dynamic.dispose();
    fixedEnglish.dispose();
    initializeTuiLocale("en");
  }
});

test("representative monitor, session-send, attach, and control-center renders are bilingual", () => {
  const monitorZh = new MonitorOverlay({ getSessions: () => [row()], close: () => {} }, "zh-CN");
  const sendZh = new SessionSendOverlay({ getSessions: () => [row()], close: () => {} }, "zh-CN");
  const attachZh = new AttachOverlay(activeAgent(), () => {}, undefined, undefined, undefined, false, "zh-CN");
  const centerZh = new TeammateControlCenter({
    cwd: process.cwd(),
    availableModels: [],
    agents: [],
    activeAgents: [],
    config: { version: 2, mappings: { explore: null }, thinkingLevels: {} },
    theme,
    initialTab: "routing",
    locale: "zh-CN",
    requestRender: () => {},
    close: () => {},
  });
  try {
    const monitor = stripAnsi(monitorZh.render(72).join("\n"));
    const send = stripAnsi(sendZh.render(72).join("\n"));
    const attach = stripAnsi(attachZh.render(80, 18).join("\n"));
    const center = stripAnsi(centerZh.render(90).join("\n"));
    assert.match(monitor, /选择会话/);
    assert.match(send, /发送到其他会话/);
    assert.match(attach, /主对话/);
    assert.match(center, /Teammate 控制中心/);
    assert.ok(monitorZh.render(48).every((line) => visibleWidth(line) <= 48));
    assert.ok(sendZh.render(48).every((line) => visibleWidth(line) <= 48));
    assert.ok(attachZh.render(48, 18).every((line) => visibleWidth(line) <= 48));
    assert.ok(centerZh.render(48).every((line) => visibleWidth(line) <= 48));
  } finally {
    monitorZh.dispose();
    sendZh.dispose();
    attachZh.dispose();
    centerZh.dispose();
  }
});

test("progress and result surfaces render both supported locales", () => {
  const palette = {
    dim: (text: string) => text,
    accent: (text: string) => text,
    running: (text: string) => text,
    success: (text: string) => text,
    error: (text: string) => text,
    bold: (text: string) => text,
  };
  const progress = [{
    taskIndex: 0,
    agent: "general",
    name: "worker",
    correlationId: "worker",
    dependencies: [],
    status: "running" as const,
    inputTokens: 10,
    outputTokens: 2,
  }];
  const result = {
    content: [{ type: "text" as const, text: "done" }],
    details: {
      mode: "single" as const,
      results: [{
        agent: "general",
        task: "work",
        exitCode: 0,
        messages: [{ role: "assistant" as const, content: "done" }],
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
        model: "provider/model",
        correlationId: "worker",
        durationMs: 1000,
      }],
    },
  } as AgentToolResult<Details>;

  try {
    assert.match(buildProgressTree(progress, palette, Date.now(), "en")[0]!.text, /running/);
    assert.match(buildProgressTree(progress, palette, Date.now(), "zh-CN")[0]!.text, /运行中/);
    initializeTuiLocale("zh-CN");
    assert.match(renderTeammateResult(result, { expanded: false }, theme as never).render(80)[0]!, /Alt\+R 详情/);
    initializeTuiLocale("en");
    assert.match(renderTeammateResult(result, { expanded: false }, theme as never).render(80)[0]!, /Alt\+R details/);
  } finally {
    initializeTuiLocale("en");
  }
});

test("TUI catalogs are complete and extension lifecycle owns the shared locale listener", async () => {
  assert.deepEqual(checkTuiCatalogCompleteness(), {
    complete: true,
    referenceLocale: "en",
    issues: [],
  });
  const source = await readFile(new URL("../src/extension/index.ts", import.meta.url), "utf8");
  assert.match(source, /const disposeTuiLocaleEvents = pi\.events\.on\(SETTINGS_LOCALE_EVENT/);
  assert.match(source, /applySettingsLocaleEvent\(payload\)/);
  assert.match(source, /shutdownReason === "quit" \|\| shutdownReason === "reload"/);
  assert.match(source, /disposeTuiLocaleEvents\(\)/);
});

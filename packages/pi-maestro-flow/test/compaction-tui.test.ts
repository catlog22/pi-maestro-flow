import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  CompactionSettingsOverlay,
  registerCompactionSettingsCommand,
  type CompactionSettingsResult,
} from "../src/tui/compaction-settings.ts";
import type { CompactionScope } from "../src/compaction/compaction-settings.ts";

const theme = {
  fg(_role: string, text: string) { return text; },
  bold(text: string) { return text; },
};

test("compaction TUI renders safely at narrow, boundary, and wide widths", () => {
  const overlay = createOverlay();
  for (const width of [1, 12, 20, 40, 76, 80, 120]) {
    const lines = overlay.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
    }
  }
  assert.match(overlay.render(80).join("\n"), /Maestro 压缩设置/);
  assert.match(overlay.render(80).join("\n"), /压缩阈值/);
  assert.match(overlay.render(80).join("\n"), /实际 >269,000 \/ 300,000 \(89\.7%\)/);
  assert.match(overlay.render(80).join("\n"), /配置阈值 · 290,000 Token \(96\.7%\)/);
  assert.match(overlay.render(20).join("\n"), /Esc关闭 Enter修改/);
  overlay.handleInput("\r");
  assert.match(overlay.render(20).join("\n"), /Esc返回 Enter确认/);
  overlay.handleInput("\x1b");
});

test("compaction TUI supports direct threshold editing, scope tabs, toggle, inherit, and save", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  let result: CompactionSettingsResult | undefined;
  const overlay = createOverlay({
    done(next) { result = next; },
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });

  overlay.handleInput("U");
  assert.match(overlay.render(80).join("\n"), /实际硬压缩阈值 · 实际 >264,000 \/ 300,000 \(88\.0%\) · 继承自用户/);
  assert.match(overlay.render(80).join("\n"), /配置阈值 · 280,000 Token \(93\.3%\)/);
  assert.match(overlay.render(20).join("\n"), /Esc关闭 Ctrl\+S保存/);
  overlay.handleInput("\x1b[B");
  overlay.handleInput(" ");
  overlay.handleInput("\t");
  overlay.handleInput("\x1b[A");
  overlay.handleInput("\r");
  for (let index = 0; index < 6; index++) overlay.handleInput("\x7f");
  overlay.handleInput("285000");
  overlay.handleInput("\r");
  overlay.handleInput("\x13");
  await flushAsync();

  assert.deepEqual(saves, [{
    scope: "user",
    values: { enabled: false, reserveTokens: 15_000 },
  }, {
    scope: "project",
    values: { enabled: true, keepRecentTokens: 12_000 },
  }]);
  assert.deepEqual(result, { saved: true });
});

test("compaction TUI keeps draft and selection after a failed save", async () => {
  let attempts = 0;
  const overlay = createOverlay({
    async saveScope() {
      attempts++;
      throw new Error("disk full");
    },
  });
  overlay.handleInput("\r");
  for (let index = 0; index < 6; index++) overlay.handleInput("\x7f");
  overlay.handleInput("250000");
  overlay.handleInput("\r");
  overlay.handleInput("\x13");
  await flushAsync();

  const rendered = overlay.render(80).join("\n");
  assert.equal(attempts, 1);
  assert.match(rendered, /234,000 \/ 300,000 \(78\.0%\)/);
  assert.match(rendered, /保存失败 · disk full/);
  assert.match(rendered, /压缩阈值/);
});

test("compaction TUI validates inline and uses layered Esc without saving", async () => {
  let saves = 0;
  let result: CompactionSettingsResult | undefined;
  const overlay = createOverlay({
    done(next) { result = next; },
    async saveScope() { saves++; },
  });
  overlay.handleInput("\r");
  for (let index = 0; index < 6; index++) overlay.handleInput("\x7f");
  overlay.handleInput("300000");
  overlay.handleInput("\r");
  assert.match(overlay.render(80).join("\n"), /× 压缩阈值必须小于上下文窗口 300,000/);
  overlay.handleInput("\x1b");
  assert.match(overlay.render(80).join("\n"), /设置菜单/);

  overlay.handleInput("\r");
  for (let index = 0; index < 6; index++) overlay.handleInput("\x7f");
  overlay.handleInput("299999");
  overlay.handleInput("\r");
  const nearLimit = overlay.render(80).join("\n");
  assert.match(nearLimit, /实际 >269,000 \/ 300,000 \(89\.7%\)/);
  assert.doesNotMatch(nearLimit, /△ 提醒/);
  assert.equal(saves, 0);

  overlay.handleInput("\x1b");
  assert.equal(result, undefined, "first Esc arms discard for a dirty draft");
  overlay.handleInput("\x1b");
  assert.deepEqual(result, { saved: false });
});

test("compaction TUI falls back to reserve-token editing when model context is unavailable", () => {
  const overlay = createOverlay({ contextWindow: undefined });
  overlay.handleInput("\r");
  const rendered = overlay.render(80).join("\n");
  assert.match(rendered, /当前模型缺少上下文窗口，正在编辑预留输出空间/);
  assert.match(rendered, /新值 · 10,000 Token/);
});

test("compaction TUI shows the stepwise effective-reserve derivation while editing the configured threshold", () => {
  const overlay = createOverlay();
  overlay.handleInput("\r");
  const rendered = overlay.render(80).join("\n");
  assert.match(rendered, /配置阈值 · 290,000 \/ 300,000 Token/);
  assert.match(rendered, /配置预留 · 10,000 Token/);
  assert.match(rendered, /窗口 5% 底线 · 15,000 Token/);
  assert.match(rendered, /模型输出上限 · 16,000 Token · 按剩余窗口动态收缩/);
  assert.match(rendered, /实际安全预留 · 15,000 Token/);
  assert.match(rendered, /实际硬压缩 · 超过 269,000 Token \(89\.7%\)/);
  assert.match(rendered, /生效原因 · 窗口 5% 安全底线下调/);
});

test("compaction TUI localizes the absolute reserve ceiling", () => {
  const overlay = createOverlay({
    contextWindow: 4_000_000,
    snapshot: {
      scopes: { user: {}, project: { reserveTokens: 2_000_001 } },
      effective: {} as never,
    },
  });
  assert.match(overlay.render(120).join("\n"), /预留输出空间 2,000,001 不得超过 2,000,000/);
});

test("/maestro-compaction reloads exactly once only after a successful save", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-command-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let command: { handler(args: string, ctx: any): Promise<void> | void } | undefined;
  let reloads = 0;
  try {
    registerCompactionSettingsCommand({
      registerCommand(name: string, value: typeof command) {
        if (name === "maestro-compaction") command = value;
      },
    } as never);
    assert.ok(command);
    await command.handler("", {
      cwd: join(root, "project"),
      hasUI: true,
      model: { contextWindow: 300_000, maxTokens: 20_000, provider: "maestro-openai", id: "gpt-5.6-sol", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      modelRegistry: { getAvailable: () => [] },
      async reload() { reloads++; },
      ui: {
        notify() {},
        async custom(factory: Function) {
          return new Promise((resolve) => {
            const component = factory({ requestRender() {} }, theme, {}, resolve);
            setImmediate(() => {
              component.handleInput("\x1b[B");
              component.handleInput(" ");
              component.handleInput("\x13");
            });
          });
        },
      },
    });
    assert.equal(reloads, 1);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction TUI toggles the soft-compression switch independently and saves the soft group", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  overlay.handleInput("\x1b[B"); // -> enabled
  overlay.handleInput("\x1b[B"); // -> keepRecentTokens
  overlay.handleInput("\x1b[B"); // -> softEnabled
  assert.match(overlay.render(80).join("\n"), /软压缩开关 · 已开启/);
  overlay.handleInput(" ");
  assert.match(overlay.render(80).join("\n"), /软压缩开关 · 已关闭/);
  overlay.handleInput("\x13");
  await flushAsync();
  const projectSave = saves.find((save) => save.scope === "project");
  assert.deepEqual(projectSave?.values, {
    reserveTokens: 10_000,
    keepRecentTokens: 12_000,
    soft: { enabled: false },
  });
});

test("compaction TUI toggles soft mechanism switches and saves the soft group", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  for (let index = 0; index < 3; index++) overlay.handleInput("\x1b[B"); // -> softEnabled
  for (let index = 0; index < 4; index++) overlay.handleInput("\x1b[B"); // -> softRelevance
  assert.match(overlay.render(80).join("\n"), /相关性排序 · 已关闭 · 继承自默认值/);
  overlay.handleInput(" ");
  assert.match(overlay.render(80).join("\n"), /相关性排序 · 已开启 · 项目/);
  overlay.handleInput("\x1b[B"); // -> softDedup
  overlay.handleInput(" ");
  assert.match(overlay.render(80).join("\n"), /跨轮去重 · 已开启 · 项目/);
  overlay.handleInput("u"); // inherit dedup again
  assert.match(overlay.render(80).join("\n"), /跨轮去重 · 已关闭 · 继承自项目/);
  overlay.handleInput("\x13");
  await flushAsync();
  const projectSave = saves.find((save) => save.scope === "project");
  assert.deepEqual(projectSave?.values, {
    reserveTokens: 10_000,
    keepRecentTokens: 12_000,
    soft: { relevance: { enabled: true } },
  });
});

test("compaction TUI toggles soft mechanisms on the user scope and saves there", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  overlay.handleInput("\t"); // -> user
  for (let index = 0; index < 7; index++) overlay.handleInput("\x1b[B"); // -> softRelevance
  overlay.handleInput(" ");
  assert.match(overlay.render(80).join("\n"), /相关性排序 · 已开启 · 用户/);
  overlay.handleInput("\x13");
  await flushAsync();
  const userSave = saves.find((save) => save.scope === "user");
  assert.deepEqual(userSave?.values, {
    enabled: false,
    reserveTokens: 20_000,
    soft: { relevance: { enabled: true } },
  });
});

test("compaction TUI saves several mechanism toggles in one soft group", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  for (let index = 0; index < 6; index++) overlay.handleInput("\x1b[B"); // -> softTimeBased
  overlay.handleInput(" ");
  overlay.handleInput("\x1b[B"); // -> softRelevance
  overlay.handleInput(" ");
  overlay.handleInput("\x1b[B"); // -> softDedup
  overlay.handleInput(" ");
  overlay.handleInput("\x13");
  await flushAsync();
  const projectSave = saves.find((save) => save.scope === "project");
  assert.deepEqual(projectSave?.values, {
    reserveTokens: 10_000,
    keepRecentTokens: 12_000,
    soft: {
      timeBased: { enabled: true },
      relevance: { enabled: true },
      crossTurnDedup: { enabled: true },
    },
  });
});

test("compaction TUI keeps a mechanism toggle draft after a failed save", async () => {
  const overlay = createOverlay({
    async saveScope() { throw new Error("disk full"); },
  });
  for (let index = 0; index < 7; index++) overlay.handleInput("\x1b[B"); // -> softRelevance
  overlay.handleInput(" ");
  overlay.handleInput("\x13");
  await flushAsync();
  const rendered = overlay.render(80).join("\n");
  assert.match(rendered, /相关性排序 · 已开启 · 项目/);
  assert.match(rendered, /保存失败 · disk full/);
});

test("compaction TUI discards a mechanism toggle on layered Esc", async () => {
  let result: CompactionSettingsResult | undefined;
  const overlay = createOverlay({
    done(next) { result = next; },
  });
  for (let index = 0; index < 7; index++) overlay.handleInput("\x1b[B"); // -> softRelevance
  overlay.handleInput(" ");
  overlay.handleInput("\x1b"); // arms discard
  assert.match(overlay.render(80).join("\n"), /有未保存的修改/);
  overlay.handleInput("\x1b");
  assert.deepEqual(result, { saved: false });
});

test("compaction TUI 'u' on the only mechanism toggle clears the whole soft group", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  for (let index = 0; index < 8; index++) overlay.handleInput("\x1b[B"); // -> softDedup
  overlay.handleInput(" ");
  assert.match(overlay.render(80).join("\n"), /跨轮去重 · 已开启 · 项目/);
  overlay.handleInput("u");
  assert.match(overlay.render(80).join("\n"), /跨轮去重 · 已关闭 · 继承自默认值/);
  overlay.handleInput("\x13");
  await flushAsync();
  assert.equal(saves.length, 0, "fully reverting a mechanism toggle is clean, nothing to save");
});

test("compaction TUI tiny render labels the selected mechanism", () => {
  const overlay = createOverlay();
  for (let index = 0; index < 8; index++) overlay.handleInput("\x1b[B"); // -> softDedup
  assert.match(overlay.render(12).join("\n"), /去重/);
  for (let index = 0; index < 2; index++) overlay.handleInput("\x1b[A"); // -> softTimeBased
  assert.match(overlay.render(12).join("\n"), /时间/);
});

test("compaction TUI mechanism toggles stay on the user scope for a readonly project", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    projectReadonlyReason: "workspace is not writable",
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  assert.match(overlay.render(80).join("\n"), /Maestro 压缩设置 · 项目\s+\[用户\]/);
  for (let index = 0; index < 7; index++) overlay.handleInput("\x1b[B"); // -> softRelevance
  overlay.handleInput(" ");
  assert.match(overlay.render(80).join("\n"), /相关性排序 · 已开启 · 用户/);
  overlay.handleInput("\x13");
  await flushAsync();
  const userSave = saves.find((save) => save.scope === "user");
  assert.deepEqual(userSave?.values.soft, { relevance: { enabled: true } });
});

test("compaction TUI pressure preview derives from the effective soft ratios", () => {
  const overlay = createOverlay({
    snapshot: {
      scopes: {
        user: {},
        project: { soft: { nudgeRatio: 0.5, pruneRatio: 0.65, pruneTargetRatio: 0.5 } },
      },
      effective: {} as never,
    },
  });
  assert.match(overlay.render(120).join("\n"), /软阶段 · 提醒 150,000 \(50\.0%\) 可达 · 裁剪 195,000 \(65\.0%\) 可达/);
});

test("compaction TUI treats maxTokens as a dynamically clamped output ceiling", () => {
  const overlay = createOverlay({ contextWindow: 250_000, maxTokens: 250_000 });
  const rendered = overlay.render(120).join("\n");
  assert.match(rendered, /实际硬压缩阈值 · 实际 >217,500 \/ 250,000 \(87\.0%\)/);
  assert.match(rendered, /配置阈值 · 240,000 Token \(96\.0%\)/);
  assert.match(rendered, /实际安全预留 · 12,500 Token · 窗口 5% 安全底线下调/);
  assert.match(rendered, /模型输出上限 · 250,000 Token · 按剩余窗口动态收缩/);
  assert.match(rendered, /提醒 175,000 \(70\.0%\) 可达/);
  assert.match(rendered, /裁剪 200,000 \(80\.0%\) 可达/);
});

test("compaction TUI selects a compaction model from the catalog and saves it", async () => {
  const saves: Array<{ scope: CompactionScope; values: Record<string, unknown> }> = [];
  const overlay = createOverlay({
    async saveScope(scope, values) { saves.push({ scope, values }); },
  });
  for (let index = 0; index < 9; index++) overlay.handleInput("\x1b[B"); // -> compactModel
  assert.match(overlay.render(80).join("\n"), /压缩模型 · 跟随会话模型/);
  overlay.handleInput("\r"); // open picker
  assert.match(overlay.render(80).join("\n"), /选择压缩模型/);
  assert.match(overlay.render(80).join("\n"), /跟随当前会话模型（当前 maestro-openai\/gpt-5\.6-sol）/);
  overlay.handleInput("\x1b[B"); // inherit -> first catalog model
  overlay.handleInput("\x1b[B"); // -> second catalog model (qwen)
  overlay.handleInput("\r");
  assert.match(overlay.render(80).join("\n"), /压缩模型 · maestro-qwen\/qwen3\.8-max-preview · 项目/);
  assert.match(overlay.render(80).join("\n"), /实际 >47,904 \/ 120,000 \(39\.9%\)/);
  overlay.handleInput("\x13");
  await flushAsync();
  const projectSave = saves.find((save) => save.scope === "project");
  assert.equal(projectSave?.values.model, "maestro-qwen/qwen3.8-max-preview");
});

test("compaction TUI model picker inherit entry clears the configured model", () => {
  const overlay = createOverlay({
    snapshot: {
      scopes: { user: {}, project: { model: "maestro-qwen/qwen3.8-max-preview" } },
      effective: {} as never,
    },
  });
  for (let index = 0; index < 9; index++) overlay.handleInput("\x1b[B");
  assert.match(overlay.render(80).join("\n"), /压缩模型 · maestro-qwen\/qwen3\.8-max-preview/);
  overlay.handleInput("\r"); // cursor starts on the matching entry
  overlay.handleInput("\x1b[A");
  overlay.handleInput("\x1b[A"); // -> inherit entry
  overlay.handleInput("\r");
  assert.match(overlay.render(80).join("\n"), /压缩模型 · 跟随会话模型/);
});

function createOverlay(overrides: Partial<ConstructorParameters<typeof CompactionSettingsOverlay>[0]> = {}) {
  return new CompactionSettingsOverlay({
    projectRoot: "D:\\repo",
    snapshot: {
      scopes: {
        user: { enabled: false, reserveTokens: 20_000 },
        project: { reserveTokens: 10_000, keepRecentTokens: 12_000 },
      },
      effective: {
        enabled: false,
        reserveTokens: 10_000,
        keepRecentTokens: 12_000,
        source: {
          enabled: "user",
          reserveTokens: "project",
          keepRecentTokens: "project",
        },
      },
    },
    contextWindow: 300_000,
    maxTokens: 16_000,
    currentModel: {
      reference: "maestro-openai/gpt-5.6-sol",
      contextWindow: 300_000,
      maxTokens: 16_000,
    },
    availableModels: [
      { reference: "maestro-openai/gpt-5.6-sol", contextWindow: 300_000, maxTokens: 16_000 },
      { reference: "maestro-qwen/qwen3.8-max-preview", contextWindow: 120_000, maxTokens: 16_000 },
      { reference: "maestro-anthropic/claude-sonnet", contextWindow: 200_000, maxTokens: 32_000 },
    ],
    theme,
    requestRender() {},
    done() {},
    async saveScope() {},
    ...overrides,
  });
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

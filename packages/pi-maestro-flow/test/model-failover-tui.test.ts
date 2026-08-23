import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  getProjectModelFailoverPath,
  loadModelFailoverConfig,
  saveProjectModelFailoverConfig,
  type ModelFailoverConfig,
} from "../src/providers/model-failover.ts";
import { ModelFailoverOverlay } from "../src/tui/model-failover-settings.ts";

const theme = {
  fg(_role: string, text: string) { return text; },
  bold(text: string) { return text; },
};

function createOverlay(overrides: Partial<ConstructorParameters<typeof ModelFailoverOverlay>[0]> = {}) {
  return new ModelFailoverOverlay({
    cwd: "D:/workspace",
    locale: "zh-CN",
    models: ["provider/primary", "provider/backup", "provider/last"],
    multimodalModels: ["provider/last"],
    currentModel: "provider/primary",
    config: {
      enabled: false,
      fallbackModels: { "provider/primary": ["provider/backup", "provider/last"] },
    },
    health: [{
      model: "provider/primary",
      state: "OPEN",
      consecutiveFailures: 3,
      openedAt: 1,
      retryAt: 60_001,
      halfOpenTrialInProgress: false,
    }],
    theme,
    requestRender() {},
    done() {},
    async saveConfig() {},
    ...overrides,
  });
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("model failover TUI renders without overflow from tiny through wide terminals", () => {
  const overlay = createOverlay();
  for (const width of [1, 8, 19, 20, 40, 79, 80, 120, 160]) {
    const lines = overlay.render(width);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= Math.min(width, 140), `width ${width}: ${visibleWidth(line)} ${line}`);
    }
  }
  const rendered = overlay.render(100).join("\n");
  assert.match(rendered, /模型故障转移/);
  assert.match(rendered, /provider\/primary/);
  assert.match(rendered, /\[vision\]/);
  assert.match(rendered, /OPEN/);
});

test("model failover TUI enables failover and persists explicit fallback priority", async () => {
  const saves: ModelFailoverConfig[] = [];
  let done: boolean | undefined;
  const overlay = createOverlay({
    done(saved) { done = saved; },
    async saveConfig(config) { saves.push(config); },
  });

  overlay.handleInput("E");
  overlay.handleInput("\t");
  overlay.handleInput("\x1bOb");
  overlay.handleInput("\x13");
  // Ctrl+S opens the change confirmation; Enter commits the save.
  assert.match(overlay.render(100).join("\n"), /确认保存/);
  overlay.handleInput("\r");
  await flushAsync();

  assert.deepEqual(saves, [{
    enabled: true,
    fallbackModels: { "provider/primary": ["provider/last", "provider/backup"] },
    defaultFallbackModels: [],
  }]);
  assert.equal(done, true);
});

test("model failover TUI adds and removes fallbacks while slash owns text filtering", async () => {
  const saves: ModelFailoverConfig[] = [];
  const overlay = createOverlay({
    config: { enabled: true, fallbackModels: { "provider/primary": [] } },
    async saveConfig(config) { saves.push(config); },
  });

  overlay.handleInput("x");
  assert.doesNotMatch(overlay.render(100).join("\n"), /筛选 x/);
  overlay.handleInput("\t");
  overlay.handleInput("/");
  overlay.handleInput("backup");
  assert.match(overlay.render(100).join("\n"), /筛选 backup/);
  overlay.handleInput("\r");
  overlay.handleInput(" ");
  overlay.handleInput("\x13");
  overlay.handleInput("\r");
  await flushAsync();

  assert.deepEqual(saves[0]?.fallbackModels["provider/primary"], ["provider/backup"]);
});

test("primary filtering commits the selected source model with Enter", async () => {
  const saves: ModelFailoverConfig[] = [];
  const overlay = createOverlay({ async saveConfig(config) { saves.push(config); } });

  overlay.handleInput("/");
  overlay.handleInput("last");
  overlay.handleInput("\r");
  overlay.handleInput("\r");
  overlay.handleInput(" ");
  overlay.handleInput("\x13");
  overlay.handleInput("\r");
  await flushAsync();

  assert.deepEqual(saves[0]?.fallbackModels["provider/last"], ["provider/primary"]);
  assert.deepEqual(saves[0]?.fallbackModels["provider/primary"], ["provider/backup", "provider/last"]);
});

test("model failover TUI keeps the draft open when project save fails", async () => {
  let done = false;
  const overlay = createOverlay({
    done() { done = true; },
    async saveConfig() { throw new Error("disk full"); },
  });
  overlay.handleInput("E");
  overlay.handleInput("\x13");
  overlay.handleInput("\r");
  await flushAsync();

  assert.equal(done, false);
  assert.match(overlay.render(100).join("\n"), /保存失败：disk full/);
  assert.match(overlay.render(100).join("\n"), /已启用/);
});

test("project failover save preserves unknown fields and empty-chain overrides", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-failover-tui-"));
  try {
    const filePath = getProjectModelFailoverPath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 7, future: { keep: true }, enabled: false }));

    saveProjectModelFailoverConfig(cwd, {
      enabled: true,
      fallbackModels: { "provider/primary": [] },
      defaultFallbackModels: [],
    });

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(raw.version, 7);
    assert.deepEqual(raw.future, { keep: true });
    assert.deepEqual(raw.fallbackModels, { "provider/primary": [] });
    assert.deepEqual(loadModelFailoverConfig(cwd), {
      enabled: true,
      fallbackModels: { "provider/primary": [] },
      defaultFallbackModels: [],
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("model failover TUI edits the default priority pane and persists the order", async () => {
  const saves: ModelFailoverConfig[] = [];
  const overlay = createOverlay({ async saveConfig(config) { saves.push(config); } });

  // Tab to the default pane (primary -> fallback -> default).
  overlay.handleInput("\t");
  overlay.handleInput("\t");
  // Add `provider/last` then `provider/backup` to the default table.
  overlay.handleInput("/");
  overlay.handleInput("last");
  overlay.handleInput("\r");
  overlay.handleInput(" ");
  overlay.handleInput("/");
  overlay.handleInput("backup");
  overlay.handleInput("\r");
  overlay.handleInput(" ");
  // Reorder: move backup above last (Ctrl+Up on the last-added row).
  overlay.handleInput("\x1bOa");
  overlay.handleInput("\x13");
  overlay.handleInput("\r");
  await flushAsync();

  assert.deepEqual(saves[0]?.defaultFallbackModels, ["provider/backup", "provider/last"]);
});

test("model failover TUI lists changes in the save confirmation and cancels with Esc", async () => {
  const saves: ModelFailoverConfig[] = [];
  const overlay = createOverlay({
    models: ["provider/primary", "provider/backup", "provider/last", "provider/extra"],
    currentModel: "provider/primary",
    config: { enabled: false, fallbackModels: { "provider/primary": ["provider/backup"] } },
    async saveConfig(config) { saves.push(config); },
  });

  // Toggle failover on, then move down to `provider/last` and add it.
  overlay.handleInput("E");
  overlay.handleInput("\t");
  overlay.handleInput("\x1b[B");
  overlay.handleInput(" ");
  // Ctrl+S opens the confirmation panel listing the two changes.
  overlay.handleInput("\x13");
  const confirmed = overlay.render(100).join("\n");
  assert.match(confirmed, /确认保存/);
  assert.match(confirmed, /启用故障转移/);
  assert.match(confirmed, /provider\/primary → \+provider\/last/);
  assert.match(confirmed, /Enter 确认保存/);
  // Esc returns to the editor without persisting.
  overlay.handleInput("\x1b");
  assert.doesNotMatch(overlay.render(100).join("\n"), /确认保存/);
  assert.equal(saves.length, 0);
});

test("model failover TUI ranks prefix matches before infix in the filter", () => {
  const overlay = createOverlay({
    models: ["provider/alpha", "alphapro/other", "provider/backup"],
    currentModel: "provider/alpha",
  });
  overlay.handleInput("/");
  overlay.handleInput("alpha");
  const rendered = overlay.render(100).join("\n");
  const alphaProPos = rendered.indexOf("alphapro/other");
  const providerAlphaPos = rendered.indexOf("provider/alpha");
  assert.ok(alphaProPos > -1 && providerAlphaPos > -1, "both alpha matches should be visible");
  assert.ok(alphaProPos < providerAlphaPos, "prefix match alphapro/other ranks before infix provider/alpha");
});

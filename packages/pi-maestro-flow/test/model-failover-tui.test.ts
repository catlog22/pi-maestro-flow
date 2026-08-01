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
  await flushAsync();

  assert.deepEqual(saves, [{
    enabled: true,
    fallbackModels: { "provider/primary": ["provider/last", "provider/backup"] },
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
    });

    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(raw.version, 7);
    assert.deepEqual(raw.future, { keep: true });
    assert.deepEqual(raw.fallbackModels, { "provider/primary": [] });
    assert.deepEqual(loadModelFailoverConfig(cwd), {
      enabled: true,
      fallbackModels: { "provider/primary": [] },
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

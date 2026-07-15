import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  SmartSearchConfigStore,
  displaySmartSearchConfigValue,
  resolveSmartSearchConfigPath,
  type SmartSearchConfig,
} from "../src/tools/smart-search-config.ts";
import {
  SmartSearchConfigOverlay,
  type SmartSearchConfigStoreLike,
} from "../src/tui/smart-search-config.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

test("Smart Search path honors override and Windows legacy fallback", () => {
  const overridden = resolveSmartSearchConfigPath({
    env: { SMART_SEARCH_CONFIG_DIR: "C:\\custom\\smart-search", LOCALAPPDATA: "C:\\Local" },
    platform: "win32",
    homeDir: "C:\\Users\\tester",
    exists: () => false,
  });
  assert.equal(overridden.source, "environment");
  assert.equal(overridden.configFile, join("C:\\custom\\smart-search", "config.json"));

  const legacy = resolveSmartSearchConfigPath({
    env: { LOCALAPPDATA: "C:\\Local" },
    platform: "win32",
    homeDir: "C:\\Users\\tester",
    exists: (path) => path.includes(".config"),
  });
  assert.equal(legacy.source, "legacy_windows_home");
  assert.equal(legacy.configFile, join("C:\\Users\\tester", ".config", "smart-search", "config.json"));
});

test("Smart Search store atomically preserves unknown keys and masks secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-smart-search-config-"));
  try {
    const configFile = join(root, "config.json");
    await writeFile(configFile, JSON.stringify({ UNKNOWN_PLUGIN_KEY: { enabled: true }, XAI_MODEL: "old" }), "utf8");
    const store = new SmartSearchConfigStore({ configFile, temporaryId: () => "test" });
    const saved = await store.save({ XAI_MODEL: "grok-4", XAI_API_KEY: "xai-test-secret" });
    assert.deepEqual(saved.UNKNOWN_PLUGIN_KEY, { enabled: true });
    assert.equal(saved.XAI_MODEL, "grok-4");
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).XAI_API_KEY, "xai-test-secret");
    assert.deepEqual((await readdir(root)).sort(), ["config.json"]);
    assert.equal(displaySmartSearchConfigValue("XAI_API_KEY", "xai-test-secret"), "xai-*******cret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Smart Search TUI uses nested Esc semantics, saves edits, and stays width-safe", async () => {
  const saved: Array<Record<string, unknown | undefined>> = [];
  let closed = 0;
  const store = createStore({ XAI_MODEL: "grok" }, async (patch) => {
    saved.push(patch);
    return { XAI_MODEL: patch.XAI_MODEL };
  });
  const overlay = new SmartSearchConfigOverlay({
    config: { XAI_MODEL: "grok" },
    store,
    theme,
    initialKey: "XAI_MODEL",
    requestRender() {},
    close() { closed++; },
  });

  overlay.handleInput("\r");
  overlay.handleInput("-discarded");
  overlay.handleInput("\x1b");
  await flushInput();
  assert.equal(closed, 0);
  overlay.handleInput("\r");
  overlay.handleInput("\x15");
  overlay.handleInput("grok-4");
  overlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(saved, [{ XAI_MODEL: "grok-4" }]);
  assert.match(overlay.render(80).join("\n"), /Saved · XAI_MODEL/);

  for (const width of [1, 12, 20, 40, 80, 120]) {
    for (const line of overlay.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${line}`);
    }
  }
  overlay.handleInput("\x1b");
  await flushInput();
  assert.equal(closed, 1);
});

test("Smart Search TUI decodes bracketed paste and Ctrl+U unsets secret keys", async () => {
  const saved: Array<Record<string, unknown | undefined>> = [];
  let config: SmartSearchConfig = { XAI_API_KEY: "old-secret", XAI_MODEL: "old" };
  const store = createStore(config, async (patch) => {
    saved.push(patch);
    config = { ...config };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete config[key];
      else config[key] = value;
    }
    return config;
  });
  const secretOverlay = new SmartSearchConfigOverlay({
    config,
    store,
    theme,
    initialKey: "XAI_API_KEY",
    requestRender() {},
    close() {},
  });
  secretOverlay.handleInput("\r");
  secretOverlay.handleInput("\x15");
  secretOverlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(saved[0], { XAI_API_KEY: undefined });
  assert.equal("XAI_API_KEY" in config, false);

  const modelOverlay = new SmartSearchConfigOverlay({
    config,
    store,
    theme,
    initialKey: "XAI_MODEL",
    requestRender() {},
    close() {},
  });
  modelOverlay.handleInput("\r");
  modelOverlay.handleInput("\x15");
  modelOverlay.handleInput("\x1b[20");
  modelOverlay.handleInput("0~grok\n4\x1b[201~");
  modelOverlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(saved[1], { XAI_MODEL: "grok 4" });
});

test("Smart Search TUI keeps failed secret edit context without exposing the value", async () => {
  const attempts: string[] = [];
  const store = createStore({ XAI_API_KEY: "old-secret" }, async (patch) => {
    attempts.push(String(patch.XAI_API_KEY));
    throw new Error("disk full");
  });
  const overlay = new SmartSearchConfigOverlay({
    config: { XAI_API_KEY: "old-secret" },
    store,
    theme,
    initialKey: "XAI_API_KEY",
    requestRender() {},
    close() {},
  });

  overlay.handleInput("\r");
  overlay.handleInput("replacement-secret");
  overlay.handleInput("\r");
  await flushAsync();
  const rendered = overlay.render(80).join("\n");
  assert.match(rendered, /Save failed · disk full/);
  assert.doesNotMatch(rendered, /replacement-secret/);
  overlay.handleInput("\x7f");
  overlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(attempts, ["replacement-secret", "replacement-secre"]);
});

function createStore(
  initial: SmartSearchConfig,
  save: (patch: Record<string, unknown | undefined>) => Promise<SmartSearchConfig>,
): SmartSearchConfigStoreLike {
  return { async load() { return initial; }, save };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function flushInput(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

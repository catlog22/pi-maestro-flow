import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  SMART_SEARCH_CONFIG_GROUPS,
  SMART_SEARCH_CONFIG_KEYS,
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
const require = createRequire(import.meta.url);

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

test("Smart Search provider groups cover every repository config key exactly once", async () => {
  const grouped = SMART_SEARCH_CONFIG_GROUPS.flatMap((group) => [...group.keys]);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(grouped, [...SMART_SEARCH_CONFIG_KEYS]);
  const packageRoot = dirname(require.resolve("@konbakuyomu/smart-search/package.json"));
  const configSource = await readFile(join(packageRoot, "src", "smart_search", "config.py"), "utf8");
  const configBlock = /_CONFIG_KEYS\s*=\s*\{(?<body>[\s\S]*?)\n\s*\}/.exec(configSource)?.groups?.body;
  assert.ok(configBlock, "Smart Search _CONFIG_KEYS block must be readable");
  const repositoryKeys = [...configBlock.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual([...grouped].sort(), repositoryKeys);
  assert.deepEqual(
    SMART_SEARCH_CONFIG_GROUPS.map((group) => group.id),
    ["xai", "openai-compatible", "search-policy", "intent-router", "exa", "context7", "zhipu", "zhipu-mcp", "jina", "tavily", "firecrawl", "anysearch", "runtime"],
  );
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

test("Smart Search TUI filters provider keys and saves Context7 configuration", async () => {
  const saved: Array<Record<string, unknown | undefined>> = [];
  const store = createStore({}, async (patch) => {
    saved.push(patch);
    return { ...patch };
  });
  let closed = 0;
  const overlay = new SmartSearchConfigOverlay({
    config: {},
    store,
    theme,
    requestRender() {},
    close() { closed++; },
  });

  overlay.handleInput("context7");
  const filtered = overlay.render(100).join("\n");
  assert.match(filtered, /Filter: context7 · 3\/61/);
  assert.match(filtered, /CONTEXT7_API_KEY/);
  assert.match(filtered, /CONTEXT7_BASE_URL/);
  assert.match(filtered, /CONTEXT7_TIMEOUT_SECONDS/);
  assert.doesNotMatch(filtered, /XAI_API_KEY/);

  overlay.handleInput("\r");
  overlay.handleInput("ctx7-secret");
  overlay.handleInput("\r");
  await flushAsync();
  assert.deepEqual(saved, [{ CONTEXT7_API_KEY: "ctx7-secret" }]);
  assert.match(overlay.render(100).join("\n"), /Saved · CONTEXT7_API_KEY/);

  overlay.handleInput("\x1b");
  await flushInput();
  assert.equal(closed, 0);
  assert.match(overlay.render(100).join("\n"), /Filter: all keys · 61\/61/);
  overlay.handleInput("\x1b");
  await flushInput();
  assert.equal(closed, 1);
});

test("Smart Search TUI supports paging and safe no-match filters", async () => {
  const overlay = new SmartSearchConfigOverlay({
    config: {},
    store: createStore({}, async (patch) => patch),
    theme,
    requestRender() {},
    close() {},
  });

  overlay.handleInput("\x1b[6~");
  assert.doesNotMatch(overlay.render(100).join("\n"), /› XAI_API_URL/);
  overlay.handleInput("\x1b[F");
  assert.match(overlay.render(100).join("\n"), /› \[Runtime\] SSL_VERIFY/);

  overlay.handleInput("definitely-missing-provider");
  assert.match(overlay.render(100).join("\n"), /No matching configuration keys/);
  overlay.handleInput("\r");
  assert.match(overlay.render(100).join("\n"), /No matching configuration key/);
});

test("Smart Search TUI exposes and saves a representative key from every provider group", async () => {
  const saved: Array<Record<string, unknown | undefined>> = [];
  const store = createStore({}, async (patch) => {
    saved.push(patch);
    return { ...patch };
  });

  for (const group of SMART_SEARCH_CONFIG_GROUPS) {
    const key = group.keys[0];
    const overlay = new SmartSearchConfigOverlay({
      config: {},
      store,
      theme,
      initialKey: key,
      requestRender() {},
      close() {},
    });
    assert.match(overlay.render(120).join("\n"), new RegExp(`\\[${escapeRegex(group.label)}\\].*${key}`));
    overlay.handleInput("\r");
    overlay.handleInput(`value-${group.id}`);
    overlay.handleInput("\r");
    await flushAsync();
    assert.deepEqual(saved.at(-1), { [key]: `value-${group.id}` });
  }
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

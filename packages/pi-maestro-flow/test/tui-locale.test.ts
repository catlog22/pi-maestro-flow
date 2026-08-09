import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_LOCALE_EVENT,
  SETTINGS_PROTOCOL_VERSION,
  type SupportedSettingsLocale,
} from "pi-maestro-settings-core/v1";
import { ApiModelEditorOverlay } from "../src/tui/api-model-editor.ts";
import { McpManagerOverlay } from "../src/mcp/mcp-manager.ts";
import { McpSetupPanel } from "../src/mcp/mcp-setup-panel.ts";
import {
  RuntimeTuiLocale,
  getTuiLocale,
  registerTuiLocaleEvents,
} from "../src/tui/locale.ts";

const theme = {
  fg(_role: string, text: string) { return text; },
  bold(text: string) { return text; },
};

test("runtime TUI locale detects the system locale and lets an explicit locale win", () => {
  const chinese = new RuntimeTuiLocale({
    environment: { LANG: "zh_CN.UTF-8" },
    resolvedLocale: "en-US",
  });
  assert.equal(chinese.current, "zh-CN");
  assert.equal(chinese.resolve(undefined), "zh-CN");
  assert.equal(chinese.resolve("en"), "en");

  const english = new RuntimeTuiLocale({
    environment: {},
    resolvedLocale: "fr-FR",
  });
  assert.equal(english.current, "en");
  assert.equal(english.resolve("zh-Hans"), "zh-CN");
});

test("runtime TUI locale accepts only valid versioned locale events", () => {
  const runtime = new RuntimeTuiLocale({ environment: {}, resolvedLocale: "en-US" });
  let handler: ((payload: unknown) => void) | undefined;
  let disposed = false;
  const dispose = runtime.bind({
    on(event, next) {
      assert.equal(event, SETTINGS_LOCALE_EVENT);
      handler = next;
      return () => { disposed = true; };
    },
  });

  handler?.({ version: 2, locale: "zh-CN", generation: "bad-version" });
  handler?.({ version: SETTINGS_PROTOCOL_VERSION, locale: "fr", generation: "bad-locale" });
  handler?.({ version: SETTINGS_PROTOCOL_VERSION, locale: "zh-CN", generation: "" });
  handler?.({ version: SETTINGS_PROTOCOL_VERSION, locale: "zh-CN", generation: "   " });
  assert.equal(runtime.current, "en");

  handler?.({ version: SETTINGS_PROTOCOL_VERSION, locale: "zh-CN", generation: "generation-1" });
  assert.equal(runtime.current, "zh-CN");
  dispose();
  assert.equal(disposed, true);
});

test("shared runtime events update implicit renders while explicit overlay locale remains authoritative", () => {
  const original = getTuiLocale();
  let handler: ((payload: unknown) => void) | undefined;
  const dispose = registerTuiLocaleEvents({
    on(event, next) {
      assert.equal(event, SETTINGS_LOCALE_EVENT);
      handler = next;
    },
  });
  const emit = (locale: SupportedSettingsLocale, generation: string): void => {
    handler?.({ version: SETTINGS_PROTOCOL_VERSION, locale, generation });
  };

  try {
    emit("zh-CN", "render-zh");
    const implicit = apiEditor();
    assert.match(implicit.render(80).join("\n"), /Ctrl\+S 继续/);

    const explicit = apiEditor("en");
    assert.match(explicit.render(80).join("\n"), /Ctrl\+S continue/);
    assert.doesNotMatch(explicit.render(80).join("\n"), /继续/);
  } finally {
    emit(original, "restore");
    dispose();
  }
});

test("MCP manager renders representative English and Simplified Chinese paths", () => {
  const english = mcpManager("en").render(60).join("\n");
  assert.match(english, /Manage services/);
  assert.match(english, /Edit configuration/);

  const chinese = mcpManager("zh-CN").render(60).join("\n");
  assert.match(chinese, /管理服务/);
  assert.match(chinese, /编辑配置/);
});

test("MCP setup renders representative English and Simplified Chinese paths", () => {
  const english = mcpSetup("en");
  const chinese = mcpSetup("zh-CN");
  try {
    assert.match(english.render(80).join("\n"), /MCP setup/);
    assert.match(english.render(80).join("\n"), /Run setup/);
    assert.match(chinese.render(80).join("\n"), /MCP 设置/);
    assert.match(chinese.render(80).join("\n"), /运行设置/);
  } finally {
    english.dispose();
    chinese.dispose();
  }
});

function apiEditor(locale?: SupportedSettingsLocale): ApiModelEditorOverlay {
  return new ApiModelEditorOverlay({
    title: "API",
    fields: [{ id: "model", label: "Model", kind: "text", value: "gpt" }],
    locale,
    theme,
    requestRender() {},
    done() {},
  });
}

function mcpSetup(locale: SupportedSettingsLocale): McpSetupPanel {
  const preview = { path: "/project/.mcp.json", existed: false, diffText: "+{}" };
  return new McpSetupPanel({
    hasAnyConfig: false,
    hasSharedServers: false,
    totalServerCount: 0,
    fingerprint: "test",
    sources: [],
    imports: [],
    repoPrompt: { configured: false },
  } as never, {
    previewImports: () => preview,
    previewStarterProject: () => preview,
    previewRepoPrompt: () => null,
    adoptImports: async () => ({ added: [], path: preview.path }),
    scaffoldProjectConfig: async () => ({ path: preview.path }),
    addRepoPrompt: async () => ({ path: preview.path, serverName: "repoprompt" }),
    openPath: async () => undefined,
    markSetupCompleted() {},
  }, {
    mode: "empty",
    onboardingState: { setupCompleted: false } as never,
    locale,
  }, {
    requestRender() {},
  }, () => undefined);
}

function mcpManager(locale: SupportedSettingsLocale): McpManagerOverlay {
  return new McpManagerOverlay({
    servers: [],
    locale,
    theme,
    requestRender() {},
    done() {},
  });
}

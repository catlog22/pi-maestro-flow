import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProviderSettings,
  encodeProviderSettings,
  normalizeBaseUrl,
  registerLoginProviderConfigs,
} from "../src/providers/login-provider-config.ts";

test("normalizes configurable provider URLs", () => {
  assert.equal(normalizeBaseUrl(" https://gateway.example.com/v1/ ", "unused"), "https://gateway.example.com/v1");
  assert.equal(normalizeBaseUrl("", "https://api.openai.com/v1"), "https://api.openai.com/v1");
  assert.throws(() => normalizeBaseUrl("file:///tmp/api", "unused"), /http or https/);
});

test("round trips provider settings through OAuth credentials", () => {
  const refresh = encodeProviderSettings({
    version: 1,
    format: "anthropic",
    baseUrl: "https://anthropic.example.com",
    modelId: "claude-custom",
  });
  assert.deepEqual(decodeProviderSettings({ refresh }), {
    version: 1,
    format: "anthropic",
    baseUrl: "https://anthropic.example.com",
    modelId: "claude-custom",
  });
});

test("registers OpenAI and Anthropic login providers", async () => {
  const registered: Array<{ name: string; config: any }> = [];
  registerLoginProviderConfigs({
    registerProvider(name: string, config: any) {
      registered.push({ name, config });
    },
  } as any);

  assert.deepEqual(registered.map((entry) => entry.name), ["maestro-openai", "maestro-anthropic"]);
  assert.equal(registered[0].config.api, "openai-completions");
  assert.equal(registered[1].config.api, "anthropic-messages");

  const answers = ["https://proxy.example.com/v1/", "proxy-model", "secret"];
  const loginCredentials = await registered[0].config.oauth.login({
    onPrompt: async () => answers.shift() ?? "",
  });
  assert.equal(loginCredentials.access, "secret");
  assert.deepEqual(decodeProviderSettings(loginCredentials), {
    version: 1,
    format: "openai",
    baseUrl: "https://proxy.example.com/v1",
    modelId: "proxy-model",
  });

  const credentials = {
    access: "secret",
    refresh: encodeProviderSettings({
      version: 1,
      format: "openai",
      baseUrl: "https://proxy.example.com/v1",
      modelId: "proxy-model",
    }),
    expires: Number.MAX_SAFE_INTEGER,
  };
  const models = registered[0].config.oauth.modifyModels(registered[0].config.models, credentials);
  assert.equal(models[0].id, "proxy-model");
  assert.equal(models[0].baseUrl, "https://proxy.example.com/v1");
  assert.equal(registered[0].config.oauth.getApiKey(credentials), "secret");
});

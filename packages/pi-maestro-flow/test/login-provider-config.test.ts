import assert from "node:assert/strict";
import test from "node:test";
import { registerLoginProviderConfigs } from "../src/providers/login-provider-config.ts";

test("registers isolated OpenAI and Anthropic API key providers", () => {
  const registered: Array<{ name: string; config: any }> = [];
  registerLoginProviderConfigs({
    registerProvider(name: string, config: any) {
      registered.push({ name, config });
    },
  } as any);

  assert.deepEqual(registered.map((entry) => entry.name), ["maestro-openai", "maestro-anthropic"]);
  assert.equal(registered[0].config.name, "Maestro OpenAI");
  assert.equal(registered[0].config.api, "openai-responses");
  assert.equal(registered[0].config.apiKey, "$OPENAI_API_KEY");
  assert.equal(registered[0].config.models[0].id, "gpt-5");
  assert.equal(registered[0].config.models[0].reasoning, true);
  assert.equal(registered[0].config.models[0].contextWindow, 400_000);
  assert.equal(registered[0].config.models[0].maxTokens, 128_000);

  assert.equal(registered[1].config.name, "Maestro Anthropic");
  assert.equal(registered[1].config.api, "anthropic-messages");
  assert.equal(registered[1].config.apiKey, "$ANTHROPIC_API_KEY");
  assert.equal(registered[0].config.oauth, undefined);
  assert.equal(registered[1].config.oauth, undefined);
  assert.notStrictEqual(registered[0].config.models, registered[1].config.models);
});

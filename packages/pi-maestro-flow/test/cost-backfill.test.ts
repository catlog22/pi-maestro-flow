import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchOpenRouterPricing,
  lookupBuiltinPricing,
  matchOpenRouterPricing,
} from "../src/providers/cost-backfill.ts";
import { providerIdsInModels } from "../src/providers/api-provider-ops.ts";

test("lookupBuiltinPricing resolves official OpenAI rates from the pi-ai catalog", () => {
  const match = lookupBuiltinPricing("gpt-5.6-sol");
  assert.ok(match, "gpt-5.6-sol should exist in the built-in catalog");
  assert.equal(match!.source, "openai");
  assert.deepEqual(
    { input: match!.cost.input, output: match!.cost.output, cacheRead: match!.cost.cacheRead, cacheWrite: match!.cost.cacheWrite },
    { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  );
});

test("lookupBuiltinPricing prefers the official provider over gateways", () => {
  const match = lookupBuiltinPricing("claude-sonnet-4-5");
  assert.ok(match, "claude-sonnet-4-5 should exist in the built-in catalog");
  assert.equal(match!.source, "anthropic");
  assert.equal(match!.cost.input, 3);
});

test("lookupBuiltinPricing skips all-zero placeholder pricing", () => {
  // qwen3.8-max-preview only ships in token-plan catalogs with zero rates.
  assert.equal(lookupBuiltinPricing("qwen3.8-max-preview"), undefined);
});

test("lookupBuiltinPricing returns undefined for unknown ids", () => {
  assert.equal(lookupBuiltinPricing("definitely-not-a-model-12345"), undefined);
});

test("lookupBuiltinPricing prefers the catalog matching the channel's API driver", () => {
  const openai = lookupBuiltinPricing("gpt-5.6-sol", "openai-responses");
  assert.equal(openai?.source, "openai");
  assert.equal(openai?.cost.cacheWrite, 6.25);
  const azure = lookupBuiltinPricing("gpt-5.6-sol", "azure-openai-responses");
  assert.equal(azure?.source, "azure-openai-responses");
  assert.equal(azure?.cost.cacheWrite, 6.25);
  const codex = lookupBuiltinPricing("gpt-5.6-sol", "openai-codex-responses");
  assert.equal(codex?.source, "openai-codex");
  const deepseek = lookupBuiltinPricing("deepseek-v4-flash", "openai-completions");
  assert.equal(deepseek?.source, "deepseek");
  assert.equal(deepseek?.cost.input, 0.14);
});

test("matchOpenRouterPricing matches bare channel ids to provider-prefixed ids", () => {
  const models = new Map<string, never>([
    ["openai/gpt-5.6-sol", undefined as never],
    ["anthropic/claude-sonnet-4-5", undefined as never],
  ]);
  const match = matchOpenRouterPricing(models as never, "gpt-5.6-sol");
  assert.ok(match);
  assert.equal(match!.source, "openrouter:openai/gpt-5.6-sol");
  assert.equal(matchOpenRouterPricing(models as never, "claude-sonnet-4-5")?.source, "openrouter:anthropic/claude-sonnet-4-5");
  assert.equal(matchOpenRouterPricing(models as never, "no-such-model"), undefined);
});

test("providerIdsInModels enumerates every provider including native ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-backfill-"));
  const modelsPath = join(dir, "models.json");
  try {
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        openai: { baseUrl: "https://hub.linux.do/v1", models: [{ id: "gpt-5.5" }] },
        "maestro-openai": { baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-5.6-sol" }] },
        broken: "not-a-record",
      },
    }));
    assert.deepEqual(providerIdsInModels(modelsPath).sort(), ["maestro-openai", "openai"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOpenRouterPricing converts per-token pricing from a fresh disk cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-backfill-"));
  const cachePath = join(dir, "openrouter-pricing.json");
  try {
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: Date.now(),
      entries: [
        {
          id: "openai/gpt-5.6-sol",
          pricing: {
            prompt: "0.000005",
            completion: "0.00003",
            input_cache_read: "0.0000005",
            input_cache_write: "0.00000625",
            overrides: [
              { min_prompt_tokens: 272000, prompt: "0.00001", completion: "0.000045", input_cache_read: "0.000001", input_cache_write: "0.0000125" },
            ],
          },
        },
      ],
    }));
    const rates = await fetchOpenRouterPricing({ cachePath });
    assert.deepEqual(rates.get("openai/gpt-5.6-sol"), {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      tiers: [{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOpenRouterPricing ignores empty cache files and reports network failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-backfill-"));
  const cachePath = join(dir, "openrouter-pricing.json");
  try {
    writeFileSync(cachePath, "{}");
    await assert.rejects(
      fetchOpenRouterPricing({ cachePath, ttlMs: 60_000, url: "http://127.0.0.1:1/models" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchOpenRouterPricing falls back to a stale cache when the network fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cost-backfill-"));
  const cachePath = join(dir, "openrouter-pricing.json");
  try {
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days old
      entries: [{ id: "openai/gpt-4o", pricing: { prompt: "0.0000025", completion: "0.00001" } }],
    }));
    const rates = await fetchOpenRouterPricing({ cachePath, ttlMs: 60_000, url: "http://127.0.0.1:1/models" });
    assert.equal(rates.get("openai/gpt-4o")?.input, 2.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModelIntelligence } from "../src/providers/model-intelligence.ts";

function startRankingServer(): Promise<{
  server: Server;
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hitCount = 0;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      hitCount++;
      const sort = new URL(request.url ?? "/", "http://localhost").searchParams.get("sort");
      const coder = {
        id: "openai/coder-pro",
        canonical_slug: "openai/coder-pro",
        context_length: 200_000,
        pricing: { prompt: "0.000001", completion: "0.000004" },
      };
      const general = {
        id: "google/general-pro",
        canonical_slug: "google/general-pro",
        context_length: 1_000_000,
        pricing: { prompt: "0.0000005", completion: "0.000001" },
      };
      const data = sort === "intelligence-high-to-low" || sort === "pricing-low-to-high"
        ? [general, coder]
        : [coder, general];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/api/v1/models`,
        hits: () => hitCount,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("model intelligence fetches ranked lists once and serves a fresh cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-"));
  const cachePath = join(root, "cache.json");
  const server = await startRankingServer();
  try {
    const models = [
      { registrationId: "maestro-openai/coder-pro", modelId: "openai/coder-pro" },
      { registrationId: "hub/general-pro", modelId: "google/general-pro" },
      { registrationId: "private/unmatched" },
    ];
    const first = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
      limit: 2,
    });
    assert.equal(first.status, "available");
    assert.equal(first.preference, "balanced");
    assert.equal(first.recommendation, "maestro-openai/coder-pro");
    assert.deepEqual(first.candidates.map((candidate) => candidate.registration_id), [
      "maestro-openai/coder-pro",
      "hub/general-pro",
    ]);
    assert.deepEqual(first.candidates[0]?.reference_pricing_usd_per_million, { input: 1, output: 4 });
    assert.deepEqual(first.unmatched_models, ["private/unmatched"]);
    assert.equal(server.hits(), 5);

    const second = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
    });
    assert.equal(second.status, "available");

    const economy = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
      preference: "economy",
    });
    assert.equal(economy.preference, "economy");
    assert.equal(economy.recommendation, "hub/general-pro");

    const sota = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
      preference: "sota",
    });
    assert.equal(sota.preference, "sota");
    assert.equal(sota.recommendation, "maestro-openai/coder-pro");
    assert.equal(server.hits(), 5, "fresh cache must suppress network refresh");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model intelligence marks an expired fallback stale and withholds a recommendation", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-stale-"));
  const cachePath = join(root, "cache.json");
  const server = await startRankingServer();
  const models = [{ registrationId: "maestro-openai/coder-pro", modelId: "openai/coder-pro" }];
  try {
    await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
    });
    await server.close();
    const stale = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 0,
      timeoutMs: 100,
    });
    assert.equal(stale.status, "stale");
    assert.equal(stale.recommendation, null);
    assert.equal(stale.candidates[0]?.registration_id, "maestro-openai/coder-pro");
  } finally {
    if (server.server.listening) await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model intelligence degrades to unavailable without a current or cached snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-empty-"));
  try {
    const view = await loadModelIntelligence("analysis", [{ registrationId: "private/model" }], {
      cachePath: join(root, "missing.json"),
      baseUrl: "http://127.0.0.1:1/api/v1/models",
      timeoutMs: 100,
    });
    assert.equal(view.status, "unavailable");
    assert.equal(view.recommendation, null);
    assert.deepEqual(view.unmatched_models, ["private/model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

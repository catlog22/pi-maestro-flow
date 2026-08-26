import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverModels,
  loadModelSpecs,
  lookupModelSpec,
  modelsUrlForProvider,
  normalizeModelId,
} from "../src/providers/model-discovery.ts";

/** Start an ephemeral HTTP server that records the last request and replies with `body`. */
async function startServer(
  handler: (req: { url?: string; headers: Record<string, string | string[] | undefined> }) =>
    { status?: number; body: unknown; delayMs?: number },
): Promise<{ server: Server; base: string; lastHeaders: () => Record<string, string | string[] | undefined>; close: () => Promise<void> }> {
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      lastHeaders = { ...req.headers };
      const response = handler({ url: req.url, headers: req.headers });
      if (response.delayMs) {
        setTimeout(() => {
          res.writeHead(response.status ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify(response.body));
        }, response.delayMs);
        return;
      }
      res.writeHead(response.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    server,
    base,
    lastHeaders: () => lastHeaders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("modelsUrlForProvider derives /models and strips trailing slashes", () => {
  assert.equal(modelsUrlForProvider({ baseUrl: "https://relay.example.com/v1" }), "https://relay.example.com/v1/models");
  assert.equal(modelsUrlForProvider({ baseUrl: "https://relay.example.com/v1///" }), "https://relay.example.com/v1/models");
});

test("modelsUrlForProvider honors an explicit modelsUrl override", () => {
  assert.equal(
    modelsUrlForProvider({ baseUrl: "https://relay.example.com/v1", modelsUrl: "https://other.example.com/list" }),
    "https://other.example.com/list",
  );
});

test("discoverModels parses the OpenAI-style { data: [...] } envelope", async () => {
  const srv = await startServer(() => ({
    body: {
      data: [
        { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", context_window: 400000, max_tokens: 128000 },
        { id: "gpt-5.4", display_name: "GPT 5.4" },
      ],
    },
  }));
  try {
    const models = await discoverModels({ baseUrl: srv.base, apiKey: "secret" });
    assert.deepEqual(
      models.map((m) => m.id),
      ["gpt-5.6-sol", "gpt-5.4"],
    );
    assert.equal(models[0]!.name, "GPT 5.6 Sol");
    assert.equal(models[0]!.contextWindow, 400000);
    assert.equal(models[0]!.maxTokens, 128000);
    // display_name falls back to name when `name` is absent.
    assert.equal(models[1]!.name, "GPT 5.4");
  } finally {
    await srv.close();
  }
});

test("discoverModels parses a bare { models: [...] } object", async () => {
  const srv = await startServer(() => ({ body: { models: [{ id: "claude-x" }, { id: "claude-y" }] } }));
  try {
    const models = await discoverModels({ baseUrl: srv.base, apiKey: "secret" });
    assert.deepEqual(models.map((m) => m.id), ["claude-x", "claude-y"]);
  } finally {
    await srv.close();
  }
});

test("discoverModels parses a top-level array of id strings", async () => {
  const srv = await startServer(() => ({ body: ["model-a", "model-b", "model-b"] }));
  try {
    const models = await discoverModels({ baseUrl: srv.base });
    assert.deepEqual(models.map((m) => m.id), ["model-a", "model-b"]);
    assert.equal(models[0]!.name, undefined);
  } finally {
    await srv.close();
  }
});

test("discoverModels sends Authorization: Bearer <key>", async () => {
  const srv = await startServer(() => ({ body: { data: [{ id: "m1" }] } }));
  try {
    await discoverModels({ baseUrl: srv.base, apiKey: "secret-key" });
    assert.equal(srv.lastHeaders().authorization, "Bearer secret-key");
  } finally {
    await srv.close();
  }
});

test("discoverModels omits Authorization for the 'unused' placeholder and unset keys", async () => {
  const srv = await startServer(() => ({ body: { data: [{ id: "m1" }] } }));
  try {
    await discoverModels({ baseUrl: srv.base, apiKey: "unused" });
    assert.equal(srv.lastHeaders().authorization, undefined);
  } finally {
    await srv.close();
  }
});

test("discoverModels merges caller-supplied headers", async () => {
  const srv = await startServer(() => ({ body: { data: [{ id: "m1" }] } }));
  try {
    await discoverModels({ baseUrl: srv.base, apiKey: "k", headers: { "x-title": "pi" } });
    assert.equal(srv.lastHeaders().authorization, "Bearer k");
    assert.equal(srv.lastHeaders()["x-title"], "pi");
  } finally {
    await srv.close();
  }
});

test("discoverModels throws on non-200 responses", async () => {
  const srv = await startServer(() => ({ status: 401, body: { error: "invalid api key" } }));
  try {
    await assert.rejects(
      () => discoverModels({ baseUrl: srv.base, apiKey: "bad" }),
      /HTTP 401/,
    );
  } finally {
    await srv.close();
  }
});

test("discoverModels aborts when the timeout elapses", async () => {
  // Delay the response beyond the timeout so the fetch aborts.
  const srv = await startServer(() => ({ body: { data: [{ id: "slow" }] }, delayMs: 1000 }));
  try {
    await assert.rejects(
      () => discoverModels({ baseUrl: srv.base, apiKey: "k", timeoutMs: 50 }),
    );
  } finally {
    await srv.close();
  }
});

test("discoverModels deduplicates repeated model ids", async () => {
  const srv = await startServer(() => ({ body: { data: [{ id: "dup" }, { id: "dup" }, { id: "uniq" }] } }));
  try {
    const models = await discoverModels({ baseUrl: srv.base, apiKey: "k" });
    assert.deepEqual(models.map((m) => m.id), ["dup", "uniq"]);
  } finally {
    await srv.close();
  }
});

// ============================================================================
// Reference specs from models.dev
// ============================================================================

const SPECS_PAYLOAD = {
  openai: { models: { "gpt-5.6-sol": { limit: { context: 400_000, output: 128_000 } } } },
  anthropic: { models: { "anthropic/claude-opus-5": { limit: { context: 200_000, output: 64_000 } } } },
};

function startSpecsServer(payload: unknown, status = 200): Promise<{ server: Server; url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      hits += 1;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/api.json`,
        close: () => new Promise((done) => server.close(() => done())),
        hits: () => hits,
      });
    });
  });
}

function specsTestDir(): { dir: string; cachePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-specs-"));
  return { dir, cachePath: join(dir, "model-specs-cache.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("normalizeModelId strips prefixes, date suffixes and separator variants", () => {
  assert.equal(normalizeModelId("gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeModelId("openai/gpt-5.5"), "gpt-5.5");
  assert.equal(normalizeModelId("gpt-5.5-2026-06-01"), "gpt-5.5");
  assert.equal(normalizeModelId("GLM:5_5"), "glm-5-5");
});

test("lookupModelSpec matches exact, normalized and longest-prefix ids", () => {
  const specs = new Map(Object.entries(SPECS_PAYLOAD).flatMap(([provider, entry]) =>
    Object.entries(entry.models ?? {}).map(([id, model]) => [id, { context: model.limit?.context, output: model.limit?.output } as const]),
  ));
  assert.deepEqual(lookupModelSpec(specs, "gpt-5.6-sol"), { context: 400_000, output: 128_000 });
  assert.deepEqual(lookupModelSpec(specs, "claude-opus-5"), { context: 200_000, output: 64_000 });
  // Longest bidirectional prefix match keeps "gpt-5" from matching "gpt-50".
  assert.deepEqual(
    lookupModelSpec(new Map([["gpt-5", { context: 1, output: 2 }], ["gpt-50", { context: 3, output: 4 }]]), "gpt-5"),
    { context: 1, output: 2 },
  );
  assert.equal(lookupModelSpec(specs, "totally-unknown-model"), undefined);
});

test("loadModelSpecs fetches once and serves subsequent reads from the fresh disk cache", async () => {
  const specsSrv = await startSpecsServer(SPECS_PAYLOAD);
  const { cachePath, cleanup } = specsTestDir();
  try {
    const first = await loadModelSpecs({ cachePath, ttlMs: 60_000, url: specsSrv.url });
    const second = await loadModelSpecs({ cachePath, ttlMs: 60_000, url: specsSrv.url });
    assert.equal(first.get("gpt-5.6-sol")?.context, 400_000);
    assert.deepEqual(second, first);
    assert.equal(specsSrv.hits(), 1); // TTL-fresh cache must suppress the second network fetch
    assert.ok(JSON.parse(readFileSync(cachePath, "utf8")).fetchedAt > 0);
  } finally {
    await specsSrv.close();
    cleanup();
  }
});;
test("loadModelSpecs falls back to a stale snapshot when the spec service is down", async () => {
  const { cachePath, cleanup } = specsTestDir();
  try {
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now() - 48 * 60 * 60 * 1000, specs: { "gpt-4o": { context: 128_000, output: 16_384 } } }));
    const down = await startSpecsServer({ error: "boom" }, 500);
    try {
      const specs = await loadModelSpecs({ cachePath, ttlMs: 1000, url: down.url });
      assert.equal(specs.get("gpt-4o")?.context, 128_000);
    } finally {
      await down.close();
    }
  } finally {
    cleanup();
  }
});

test("loadModelSpecs rejects when there is no usable snapshot at all", async () => {
  const { cachePath, cleanup } = specsTestDir();
  try {
    const down = await startSpecsServer({ error: "boom" }, 500);
    try {
      await assert.rejects(loadModelSpecs({ cachePath, ttlMs: 60_000, url: down.url }));
    } finally {
      await down.close();
    }
  } finally {
    cleanup();
  }
});

test("discoverModels enriches missing limits from models.dev but keeps gateway-advertised values", async () => {
  const specsSrv = await startSpecsServer(SPECS_PAYLOAD);
  const { cachePath, cleanup } = specsTestDir();
  const srv = await startServer(() => ({
    body: {
      data: [
        { id: "openai/gpt-5.6-sol-2026-01-01" }, // no limits → enriched via normalized + prefix match
        { id: "anthropic/claude-opus-5", context_window: 999_999 }, // gateway value wins over the reference spec
      ],
    },
  }));
  try {
    const models = await discoverModels({ baseUrl: srv.base, apiKey: "k", specs: { url: specsSrv.url, cachePath } });
    assert.equal(models[0]!.contextWindow, 400_000);
    assert.equal(models[0]!.maxTokens, 128_000);
    assert.equal(models[1]!.contextWindow, 999_999);
  } finally {
    await srv.close();
    await specsSrv.close();
    cleanup();
  }
});

test("discoverModels still returns results when the spec service is unreachable", async () => {
  const { cachePath, cleanup } = specsTestDir();
  const srv = await startServer(() => ({ body: { data: [{ id: "mystery-model" }] } }));
  try {
    const models = await discoverModels({ baseUrl: srv.base, apiKey: "k", specs: { url: "http://127.0.0.1:1/api.json", cachePath } });
    assert.deepEqual(models.map((m) => m.id), ["mystery-model"]);
    assert.equal(models[0]!.contextWindow, undefined); // no specs available → plain discovery result
  } finally {
    await srv.close();
    cleanup();
  }
});

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { discoverModels, modelsUrlForProvider } from "../src/providers/model-discovery.ts";

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

import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  guardMcpOutput,
  type McpArtifactRetentionOptions,
  type McpResultSummary,
} from "../src/mcp/mcp-output-guard.ts";

async function makeArtifactDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-output-guard-test-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function spillText(
  text: string,
  artifactRetention: McpArtifactRetentionOptions,
): Promise<string> {
  const guarded = await guardMcpOutput([{ type: "text", text }], {
    maxBytes: 32,
    maxLines: 100,
    artifactRetention,
  });
  assert.equal(guarded.outputGuard?.truncated, true);
  assert.ok(guarded.outputGuard.fullOutputPath, guarded.outputGuard.writeError);
  return guarded.outputGuard.fullOutputPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("MCP result sizing keeps compact JSON-compatible values raw", async () => {
  const rawResult = { content: [{ type: "text", text: "compact" }], value: 42 };
  const guarded = await guardMcpOutput([{ type: "text", text: "compact" }], {
    detailsMaxBytes: 1_024,
    rawMcpResult: rawResult,
  });
  assert.equal(guarded.mcpResult, rawResult);
});

test("MCP result sizing does not invoke custom toJSON serializers", async (t) => {
  const directory = await makeArtifactDirectory(t);
  let invoked = false;
  const rawResult = {
    value: "safe",
    toJSON() {
      invoked = true;
      return { huge: "x".repeat(4 * 1024 * 1024) };
    },
  };
  const guarded = await guardMcpOutput([{ type: "text", text: "custom serializer" }], {
    detailsMaxBytes: 1_024,
    rawMcpResult: rawResult,
    artifactRetention: { directory, maxFiles: 2, maxBytes: 1_024 * 1_024, ttlMs: 10_000 },
  });
  const summary = guarded.mcpResult as McpResultSummary;
  assert.equal(invoked, false);
  assert.equal(summary.omitted, true);
  assert.ok(summary.fullResultPath, summary.resultWriteError);
  assert.deepEqual(JSON.parse(await readFile(summary.fullResultPath, "utf8")), { value: "safe" });
});

test("MCP result sizing stops without JSON.stringify and streams huge results", async (t) => {
  const directory = await makeArtifactDirectory(t);
  let stringifyCalls = 0;
  const originalStringify = JSON.stringify;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    stringifyCalls += 1;
    return originalStringify(...args);
  }) as typeof JSON.stringify;

  const huge = "x".repeat(2 * 1024 * 1024);
  const rawResult = {
    content: [{ type: "text", text: "small model-facing content" }],
    structuredContent: { huge },
  };

  try {
    const guarded = await guardMcpOutput([{ type: "text", text: "small model-facing content" }], {
      detailsMaxBytes: 1_024,
      rawMcpResult: rawResult,
      artifactRetention: { directory, maxFiles: 4, maxBytes: 4 * 1024 * 1024, ttlMs: 10_000 },
    });
    const summary = guarded.mcpResult as McpResultSummary;
    assert.equal(summary.omitted, true);
    assert.ok(summary.fullResultPath, summary.resultWriteError);
    assert.equal(dirname(summary.fullResultPath), directory);
    const retained = await readFile(summary.fullResultPath, "utf8");
    assert.equal(Buffer.byteLength(retained), summary.rawResultBytes);
    assert.deepEqual(JSON.parse(retained), rawResult);
  } finally {
    JSON.stringify = originalStringify;
  }

  assert.equal(stringifyCalls, 0);
});

test("MCP cyclic results are summarized with a usable JSON artifact", async (t) => {
  const directory = await makeArtifactDirectory(t);
  const rawResult: Record<string, unknown> = {
    content: [{ type: "text", text: "cycle" }],
    label: "root",
  };
  rawResult.self = rawResult;

  const guarded = await guardMcpOutput([{ type: "text", text: "cycle" }], {
    detailsMaxBytes: 1_024,
    rawMcpResult: rawResult,
    artifactRetention: { directory, maxFiles: 4, maxBytes: 1_024 * 1_024, ttlMs: 10_000 },
  });
  const summary = guarded.mcpResult as McpResultSummary;
  assert.equal(summary.omitted, true);
  assert.match(summary.reason, /not safely JSON-compatible/);
  assert.ok(summary.fullResultPath, summary.resultWriteError);
  const retained = JSON.parse(await readFile(summary.fullResultPath, "utf8")) as Record<string, unknown>;
  assert.equal(retained.label, "root");
  assert.equal(retained.self, "[Circular]");
});

test("MCP artifacts are private and evict the deterministic oldest file by count", async (t) => {
  const directory = await makeArtifactDirectory(t);
  const retention = { directory, maxFiles: 2, maxBytes: 16 * 1024, ttlMs: 10_000 };
  const first = await spillText(`first-${"a".repeat(256)}`, retention);
  const second = await spillText(`second-${"b".repeat(256)}`, retention);
  const third = await spillText(`third-${"c".repeat(256)}`, retention);

  assert.equal(await exists(first), false);
  assert.equal(await readFile(second, "utf8"), `second-${"b".repeat(256)}`);
  assert.equal(await readFile(third, "utf8"), `third-${"c".repeat(256)}`);
  const entries = await readdir(directory, { withFileTypes: true });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.isFile()), "retention uses one directory and creates no per-artifact directories");

  if (process.platform !== "win32") {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(second)).mode & 0o777, 0o600);
    assert.equal((await lstat(third)).mode & 0o777, 0o600);
  }
});

test("MCP artifact retention enforces aggregate bytes", async (t) => {
  const directory = await makeArtifactDirectory(t);
  const retention = { directory, maxFiles: 10, maxBytes: 700, ttlMs: 10_000 };
  const first = await spillText(`first-${"a".repeat(400)}`, retention);
  const second = await spillText(`second-${"b".repeat(400)}`, retention);

  assert.equal(await exists(first), false);
  assert.equal(await exists(second), true);
  const files = await readdir(directory);
  const totalBytes = (await Promise.all(files.map((name) => stat(join(directory, name)))))
    .reduce((total, info) => total + info.size, 0);
  assert.ok(totalBytes <= retention.maxBytes);
});

test("MCP artifacts larger than the aggregate byte quota return no stale path", async (t) => {
  const directory = await makeArtifactDirectory(t);
  const guarded = await guardMcpOutput([{ type: "text", text: "x".repeat(256) }], {
    maxBytes: 32,
    artifactRetention: { directory, maxFiles: 2, maxBytes: 64, ttlMs: 10_000 },
  });
  assert.equal(guarded.outputGuard?.fullOutputPath, undefined);
  assert.match(guarded.outputGuard?.writeError ?? "", /exceeds retention byte limit/);
  assert.deepEqual(await readdir(directory), []);
});

test("MCP artifact TTL preserves the path until expiry and then cleans it", async (t) => {
  const directory = await makeArtifactDirectory(t);
  const text = `ttl-${"z".repeat(256)}`;
  const path = await spillText(text, {
    directory,
    maxFiles: 4,
    maxBytes: 4 * 1024,
    ttlMs: 100,
  });

  assert.equal(await readFile(path, "utf8"), text);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await exists(path), true, "the returned artifact remains usable before its TTL");
  await waitFor(async () => !(await exists(path)));
  assert.deepEqual(await readdir(directory), []);
});

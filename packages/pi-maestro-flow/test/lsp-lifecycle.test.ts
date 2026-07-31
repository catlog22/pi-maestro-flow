import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearLspConfigCache, findProjectRoot } from "../src/tools/lsp/config.ts";
import { LspManager } from "../src/tools/lsp/manager.ts";
import type { LspClientLike, LspServerConfig } from "../src/tools/lsp/types.ts";

function makeClient(config: LspServerConfig, root: string): LspClientLike {
  return {
    config,
    root,
    capabilities: {},
    closed: false,
    async ensureFileOpen() { return "file:///sample.ts"; },
    async request() { return null; },
    notify() {},
    async getDiagnostics() { return []; },
    async shutdown() {},
  };
}

async function withWorkspace(body: (root: string, source: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-lifecycle-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  const source = path.join(root, "sample.ts");
  await fs.writeFile(source, "export {};\n", "utf8");
  clearLspConfigCache();
  try {
    await body(root, source);
  } finally {
    clearLspConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("LSP shared startup is owned by the lifecycle and survives a caller aborting its wait", () => withWorkspace(async (root, source) => {
  let starts = 0;
  let resolveStart: ((client: LspClientLike) => void) | undefined;
  const manager = new LspManager(async (server, projectRoot) => {
    starts += 1;
    return new Promise<LspClientLike>((resolve) => {
      resolveStart = () => resolve(makeClient(server, projectRoot));
    });
  });

  const creatorController = new AbortController();
  const creator = manager.clientForFile(source, root, undefined, creatorController.signal);
  const follower = manager.clientForFile(source, root);
  while (starts === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, "concurrent callers share one startup");

  creatorController.abort();
  await assert.rejects(creator, { name: "AbortError" });
  assert.equal(starts, 1, "caller abort must not cancel the lifecycle-owned startup");

  resolveStart?.();
  const followerClient = await follower;
  assert.ok(followerClient);
  assert.equal(starts, 1);
  assert.equal(await manager.clientForFile(source, root), followerClient, "startup is cached for later callers");
  await manager.shutdown();
}));

test("LSP follower abort does not cancel the shared startup", () => withWorkspace(async (root, source) => {
  let starts = 0;
  let resolveStart: ((client: LspClientLike) => void) | undefined;
  const manager = new LspManager(async (server, projectRoot) => {
    starts += 1;
    return new Promise<LspClientLike>((resolve) => {
      resolveStart = () => resolve(makeClient(server, projectRoot));
    });
  });

  const creator = manager.clientForFile(source, root);
  const followerController = new AbortController();
  const follower = manager.clientForFile(source, root, undefined, followerController.signal);
  while (starts === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  followerController.abort();
  await assert.rejects(follower, { name: "AbortError" });

  resolveStart?.();
  const creatorClient = await creator;
  assert.ok(creatorClient);
  assert.equal(starts, 1);
  await manager.shutdown();
}));

test("LSP findProjectRoot is memoized per generation and invalidated on reload/shutdown", () => withWorkspace(async (root, source) => {
  const markers = ["package.json"];

  const first = findProjectRoot(source, root, markers);
  const second = findProjectRoot(source, root, markers);
  assert.equal(first, second, "concurrent lookups share one in-flight walk");
  assert.equal(await first, root);

  const cached = findProjectRoot(source, root, markers);
  assert.equal(cached, first, "settled root is memoized within a generation");

  clearLspConfigCache();
  const afterReload = findProjectRoot(source, root, markers);
  assert.notEqual(afterReload, first, "reload invalidates the root cache");
  assert.equal(await afterReload, root);

  const beforeShutdown = findProjectRoot(source, root, markers);
  await new LspManager().shutdown();
  const afterShutdown = findProjectRoot(source, root, markers);
  assert.notEqual(afterShutdown, beforeShutdown, "shutdown invalidates the root cache");
  assert.equal(await afterShutdown, root);
}));

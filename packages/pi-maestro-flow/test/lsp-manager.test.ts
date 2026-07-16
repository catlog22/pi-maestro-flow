import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearLspConfigCache, loadLspConfig } from "../src/tools/lsp/config.ts";
import { LspManager } from "../src/tools/lsp/manager.ts";
import type { LspClientLike } from "../src/tools/lsp/types.ts";

test("LSP config merges project overrides and manager single-flights clients then evicts closed processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-manager-"));
  await fs.mkdir(path.join(root, ".pi"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi", "lsp.json"), JSON.stringify({
    disabled: ["typescript"],
    servers: [{ name: "custom-ts", command: "custom-ts.cmd", args: ["--stdio"], fileTypes: [".ts"], rootMarkers: ["package.json"] }],
  }), "utf8");
  await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf8");
  const source = path.join(root, "sample.ts");
  await fs.writeFile(source, "export {};\n", "utf8");
  clearLspConfigCache();
  try {
    const config = await loadLspConfig(root);
    assert.equal(config.some((item) => item.name === "typescript"), false);
    assert.equal(config.find((item) => item.name === "custom-ts")?.command, "custom-ts.cmd");

    let starts = 0;
    let close: ((error?: Error) => void) | undefined;
    const manager = new LspManager(async (server, projectRoot, _signal, _timeoutMs, onClose) => {
      starts += 1;
      close = onClose;
      return {
        config: server,
        root: projectRoot,
        capabilities: {},
        closed: false,
        async ensureFileOpen() { return "file:///sample.ts"; },
        async request() { return null; },
        notify() {},
        async getDiagnostics() { return []; },
        async shutdown() {},
      } satisfies LspClientLike;
    });
    const [first, second] = await Promise.all([
      manager.clientForFile(source, root),
      manager.clientForFile(source, root),
    ]);
    assert.equal(first, second);
    assert.equal(starts, 1);
    close?.(new Error("server crashed"));
    await manager.clientForFile(source, root);
    assert.equal(starts, 2);
    await manager.shutdown();

    const aborting = new LspManager(async (_server, _projectRoot, signal) => new Promise<LspClientLike>((_resolve, reject) => {
      const fail = () => { const error = new Error("startup aborted"); error.name = "AbortError"; reject(error); };
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    }));
    const startup = aborting.clientForFile(source, root);
    const rejected = assert.rejects(startup, { name: "AbortError" });
    await aborting.shutdown();
    await rejected;

    const nested = path.join(root, "packages", "app");
    await fs.mkdir(path.join(nested, ".pi"), { recursive: true });
    await fs.writeFile(path.join(nested, ".pi", "lsp.json"), JSON.stringify({
      servers: [{ name: "nested-ts", command: "nested-ts", fileTypes: [".ts"], rootMarkers: ["package.json"] }],
    }), "utf8");
    clearLspConfigCache();
    const roots = new Map<string, string>();
    const nestedManager = new LspManager(async (server, projectRoot) => {
      roots.set(server.name, projectRoot);
      return {
        config: server, root: projectRoot, capabilities: {}, closed: false,
        async ensureFileOpen() { return "file:///sample.ts"; }, async request() { return null; }, notify() {},
        async getDiagnostics() { return []; }, async shutdown() {},
      } satisfies LspClientLike;
    });
    await nestedManager.clientsForWorkspace(nested);
    assert.equal(roots.get("nested-ts"), root);
    await nestedManager.shutdown();

    clearLspConfigCache();
    let delayedStarts = 0;
    let rejectOld: ((error: Error) => void) | undefined;
    const delayedManager = new LspManager(async (server, projectRoot) => {
      delayedStarts += 1;
      if (delayedStarts === 1) {
        return new Promise<LspClientLike>((_resolve, reject) => { rejectOld = reject; });
      }
      return {
        config: server, root: projectRoot, capabilities: {}, closed: false,
        async ensureFileOpen() { return "file:///sample.ts"; }, async request() { return null; }, notify() {},
        async getDiagnostics() { return []; }, async shutdown() {},
      } satisfies LspClientLike;
    });
    const oldStartup = delayedManager.clientForFile(source, root);
    const oldRejected = assert.rejects(oldStartup, /late old-generation failure/);
    while (delayedStarts === 0) await new Promise((resolve) => setImmediate(resolve));
    await delayedManager.shutdown();
    const current = await delayedManager.clientForFile(source, root);
    rejectOld?.(new Error("late old-generation failure"));
    await oldRejected;
    assert.equal(await delayedManager.clientForFile(source, root), current);
    assert.equal(delayedStarts, 2);
    await delayedManager.shutdown();
  } finally {
    clearLspConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LSP manager shutdown clears the process-wide cwd config cache", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-lsp-config-lifecycle-"));
  const configDirectory = path.join(root, ".pi");
  const configPath = path.join(configDirectory, "lsp.json");
  await fs.mkdir(configDirectory, { recursive: true });
  clearLspConfigCache();
  try {
    await fs.writeFile(configPath, JSON.stringify({
      servers: [{ name: "session-server", command: "first", fileTypes: [".session"], rootMarkers: [] }],
    }), "utf8");
    assert.equal((await loadLspConfig(root)).find((item) => item.name === "session-server")?.command, "first");

    await fs.writeFile(configPath, JSON.stringify({
      servers: [{ name: "session-server", command: "second", fileTypes: [".session"], rootMarkers: [] }],
    }), "utf8");
    assert.equal((await loadLspConfig(root)).find((item) => item.name === "session-server")?.command, "first");

    await new LspManager().shutdown();
    assert.equal((await loadLspConfig(root)).find((item) => item.name === "session-server")?.command, "second");
  } finally {
    clearLspConfigCache();
    await fs.rm(root, { recursive: true, force: true });
  }
});

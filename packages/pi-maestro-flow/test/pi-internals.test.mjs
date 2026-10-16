import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as piHost from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { loadExtensions } = await import(loaderUrl.href);
const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 100 };

test("compaction preflight uses the Pi host when the managed npm tree has no SDK", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionRoot = join(root, ".pi", "agent", "npm", "node_modules", "pi-maestro-flow");
  await mkdir(extensionRoot, { recursive: true });
  await copyFile(new URL("../src/compaction/pi-internals.ts", import.meta.url), join(extensionRoot, "pi-internals.ts"));
  const entry = join(extensionRoot, "index.ts");
  await writeFile(entry, `
    import { loadPiCompactionInternals } from "./pi-internals.ts";
    export default function (pi) {
      pi.registerCommand("preflight", {
        handler: async () => {
          const first = loadPiCompactionInternals();
          const second = loadPiCompactionInternals();
          if (first !== second) throw new Error("Concurrent preflight loads must share a promise");
          return first;
        },
      });
    }
  `);

  const extensionRequire = createRequire(pathToFileURL(entry));
  assert.throws(() => extensionRequire.resolve("@earendil-works/pi-coding-agent"), { code: "MODULE_NOT_FOUND" });
  const result = await loadExtensions([entry], root, piHost.createEventBus(), piHost.createExtensionRuntime());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const command = result.extensions[0].commands.get("preflight");
  assert.ok(command);
  const internals = await command.handler("", {});
  assert.equal(typeof internals.prepareCompaction, "function");
  assert.equal(await command.handler("", {}), internals, "successful loads must remain cached");
  assert.equal(internals.prepareCompaction([], settings), undefined);
  assert.equal(internals.prepareCompaction([{ type: "compaction", id: "already-compacted" }], settings), undefined);

  const entries = [
    { type: "message", id: "user-1", message: { role: "user", content: "old context ".repeat(200), timestamp: 1 } },
    { type: "message", id: "assistant-1", message: {
      role: "assistant", content: [{ type: "text", text: "old response ".repeat(200) }],
      api: "openai-responses", provider: "test", model: "test", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } },
    { type: "message", id: "user-2", message: { role: "user", content: "recent context", timestamp: 3 } },
  ];
  const session = piHost.SessionManager.inMemory(root);
  for (const entry of entries) session.appendMessage(entry.message);
  const preparation = internals.prepareCompaction(session.getBranch(), settings);
  assert.ok(preparation, "real host preparation must still accept compactable history");
  assert.ok(preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length > 0);
});

test("compaction preflight uses host virtual modules without resolving an SDK package", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-virtual-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "pi-internals.ts");
  await copyFile(new URL("../src/compaction/pi-internals.ts", import.meta.url), entry);
  assert.throws(() => createRequire(pathToFileURL(entry)).resolve("@earendil-works/pi-coding-agent"), { code: "MODULE_NOT_FOUND" });
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: { "@earendil-works/pi-coding-agent": piHost },
  });
  const { loadPiCompactionInternals } = await jiti.import(entry);
  const internals = await loadPiCompactionInternals();
  assert.equal(typeof internals.prepareCompaction, "function");
  assert.equal(internals.prepareCompaction([], settings), undefined);
});

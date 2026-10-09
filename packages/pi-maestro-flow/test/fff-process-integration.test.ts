import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GrepMatch, GrepResult } from "@ff-labs/fff-node";
import { registerFff } from "../src/tools/fff.ts";
import type { FffFinder } from "../src/tools/fff-process.ts";
import { createSessionHistoryFffAccelerator } from "../src/tools/session-history-fff.ts";

function harness() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    pi: {
      registerTool() {},
      on(event: string, handler: (...args: unknown[]) => unknown) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI,
  };
}
function match(relativePath: string): GrepMatch {
  return {
    relativePath, fileName: basename(relativePath), gitStatus: "clean", size: 10, modified: 1,
    isBinary: false, totalFrecencyScore: 0, accessFrecencyScore: 0, modificationFrecencyScore: 0,
    lineNumber: 1, col: 0, byteOffset: 0, lineContent: "needle", matchRanges: [[0, 6]],
  };
}
function grepResult(items: GrepMatch[] = []): { ok: true; value: GrepResult } {
  return { ok: true, value: {
    items, totalMatched: items.length, totalFilesSearched: 1, totalFiles: 1,
    filteredFileCount: 1, nextCursor: null,
  } };
}
function finder(): FffFinder {
  let destroyed = false;
  return {
    get isDestroyed() { return destroyed; },
    destroy() { destroyed = true; },
    async waitForScan() { return { ok: true, value: true }; },
    async grep() { return grepResult([match("src/needle.ts")]); },
    async glob() { return { ok: true, value: { items: [match("src/needle.ts")], scores: [], totalMatched: 1, totalFiles: 1 } }; },
    async fileSearch() { return { ok: true, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } }; },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("shutdown before initializer microtask prevents any worker creation", async () => {
  for (const entry of ["startup", "search"] as const) {
    const { pi, handlers } = harness();
    const root = join(tmpdir(), `fff-process-pre-spawn-${entry}`);
    let createCount = 0;
    let rgCalls = 0;
    const handle = registerFff(pi, {
      createFinder() { createCount += 1; return { ok: true, value: finder() }; },
      runRg: async () => { rgCalls += 1; return { text: "invalid fallback", limitReached: false }; },
    });
    const pending = entry === "startup"
      ? handlers.get("session_start")?.({}, { cwd: root })
      : handle.search({ pattern: "needle", path: "src" }, root);
    const shutdown = handlers.get("session_shutdown")?.();
    if (entry === "search") await assert.rejects(pending as Promise<unknown>, /session ended/);
    await shutdown;
    await tick();
    assert.equal(createCount, 0);
    assert.equal(rgCalls, 0);
  }
});

test("restored scoped FFF routes await glob/grep and preserve native default options", async () => {
  const { pi, handlers } = harness();
  const root = join(tmpdir(), "fff-process-default-integration");
  const native = finder();
  let createCount = 0;
  const handle = registerFff(pi, {
    createFinder(options) {
      assert.deepEqual(options, { basePath: root });
      createCount += 1;
      return { ok: true, value: native };
    },
    runRg: async () => { throw new Error("scoped search must retain FFF"); },
  });
  await handlers.get("session_start")?.({}, { cwd: root });
  await tick();
  assert.equal(createCount, 1, "startup prewarming is restored");
  const result = await handle.search({ pattern: "needle", path: "src", glob: "*.ts" }, root);
  assert.equal(result.details?.engine, "fff");
  assert.match(result.content[0]?.text ?? "", /src\/needle\.ts:1: needle/);
  await handlers.get("session_shutdown")?.();
});

test("crashed scoped workers fall back only for plain and rebuild on the next request", async () => {
  for (const mode of ["plain", "fuzzy"] as const) {
    const { pi, handlers } = harness();
    let createCount = 0;
    let rgCalls = 0;
    const handle = registerFff(pi, {
      createFinder() {
        const native = finder();
        if (++createCount === 1) native.grep = async () => {
          native.destroy();
          throw new Error("FFF worker exited (code 70)");
        };
        return { ok: true, value: native };
      },
      runRg: async () => { rgCalls += 1; return { text: "rg recovered", limitReached: false }; },
    });
    const root = join(tmpdir(), `fff-process-recovery-${mode}`);
    const request = { pattern: "needle", path: "src", mode };
    if (mode === "plain") {
      const result = await handle.search(request, root);
      assert.equal(result.details?.engine, "rg");
      assert.equal(rgCalls, 1);
    } else {
      await assert.rejects(handle.search(request, root), /FFF worker exited/);
      assert.equal(rgCalls, 0, "fuzzy must not silently become literal matching");
    }
    const recovered = await handle.search(request, root);
    assert.equal(recovered.details?.engine, "fff");
    assert.equal(createCount, 2);
    await handlers.get("session_shutdown")?.();
  }
});

test("cancelled IPC search settles without killing the shared finder", async () => {
  const { pi, handlers } = harness();
  const native = finder();
  let complete!: (value: ReturnType<typeof grepResult>) => void;
  let queries = 0;
  native.grep = () => ++queries === 1
    ? new Promise((resolve) => { complete = resolve; })
    : Promise.resolve(grepResult());
  const handle = registerFff(pi, { createFinder: () => ({ ok: true, value: native }) });
  const root = join(tmpdir(), "fff-process-cancel-ipc");
  const controller = new AbortController();
  const pending = handle.search({ pattern: "needle", path: "src" }, root, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await tick();
  controller.abort();
  await rejected;
  assert.equal(native.isDestroyed, false);
  complete(grepResult());
  assert.equal((await handle.search({ pattern: "needle", path: "src" }, root)).details?.engine, "fff");
  await handlers.get("session_shutdown")?.();
});

test("shutdown fences a late IPC reply and never spawns rg during teardown", async () => {
  const { pi, handlers } = harness();
  const native = finder();
  let complete!: (value: ReturnType<typeof grepResult>) => void;
  native.grep = () => new Promise((resolve) => { complete = resolve; });
  let rgCalls = 0;
  const handle = registerFff(pi, {
    createFinder: () => ({ ok: true, value: native }),
    runRg: async () => { rgCalls += 1; return { text: "invalid fallback", limitReached: false }; },
  });
  const pending = handle.search({ pattern: "needle", path: "src" }, join(tmpdir(), "fff-process-late-ipc"));
  const rejected = assert.rejects(pending, /index ended/);
  await tick();
  const shutdown = handlers.get("session_shutdown")?.();
  complete(grepResult([match("src/needle.ts")]));
  await rejected;
  await shutdown;
  assert.equal(rgCalls, 0);
});

test("history accelerator preserves defaults and retries after a worker dies during init or grep", async () => {
  const root = join(tmpdir(), "fff-history-process-recovery");
  const ctx = { cwd: root, sessionManager: { getSessionFile: () => join(root, "active.jsonl") } };
  for (const phase of ["init", "grep"] as const) {
    let createCount = 0;
    const accelerator = createSessionHistoryFffAccelerator({
      createFinder(options) {
        assert.deepEqual(options, { basePath: root, aiMode: true });
        const native = finder();
        native.glob = async () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } });
        native.grep = async () => grepResult();
        if (++createCount === 1) {
          const crash = async (): Promise<never> => { native.destroy(); throw new Error("FFF worker exited"); };
          if (phase === "init") native.waitForScan = crash;
          else native.grep = crash;
        }
        return { ok: true, value: native };
      },
    });
    const failed = await accelerator.search("needle", ctx);
    assert.equal(failed.available, false);
    const recovered = await accelerator.search("needle", ctx);
    assert.equal(recovered.available, true);
    assert.equal(createCount, 2, "worker failure must not permanently disable the accelerator");
    await accelerator.destroy();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("workspace initialization admission bounds distinct roots and preserves same-root single flight", async () => {
  const { pi, handlers } = harness();
  const scans = Array.from({ length: 4 }, () => deferred<{ ok: true; value: boolean }>());
  let created = 0;
  let rgCalls = 0;
  const handle = registerFff(pi, {
    createFinder() {
      const native = finder();
      native.waitForScan = () => scans[created++].promise;
      return { ok: true, value: native };
    },
    runRg: async () => { rgCalls += 1; return { text: "admission fallback", limitReached: false }; },
  });
  const roots = scans.map((_, index) => join(tmpdir(), `fff-admission-${index}`));
  const pending = roots.map((root) => handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, root));
  const shared = handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, roots[0]);
  await tick();
  assert.equal(created, 4);
  const extra = join(tmpdir(), "fff-admission-overflow");
  await assert.rejects(handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, extra), /initialization limit reached/);
  assert.equal((await handle.search({ pattern: "needle", path: "src" }, extra)).details?.engine, "rg");
  assert.equal(created, 4, "overflow must not fork another worker");
  assert.equal(rgCalls, 1);
  scans.forEach((scan) => scan.resolve({ ok: true, value: true }));
  const results = await Promise.all([...pending, shared]);
  assert.ok(results.every((result) => result.details?.engine === "fff"));
  await handlers.get("session_shutdown")?.();
});

test("same-root replacement waits for confirmed worker close", async () => {
  const { pi, handlers } = harness();
  const closed = deferred<void>();
  let created = 0;
  const original = finder();
  Object.defineProperty(original, "closed", { value: closed.promise });
  const handle = registerFff(pi, {
    createFinder() { return { ok: true, value: ++created === 1 ? original : finder() }; },
  });
  const root = join(tmpdir(), "fff-close-before-replace");
  await handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, root);
  original.destroy();
  const replacement = handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, root);
  await tick();
  assert.equal(created, 1, "destroyed is not proof that the worker exited");
  closed.resolve();
  assert.equal((await replacement).details?.engine, "fff");
  assert.equal(created, 2);
  await handlers.get("session_shutdown")?.();
});

test("shutdown awaits closing ownership and fences a replacement waiting for it", async () => {
  const { pi, handlers } = harness();
  const closed = deferred<void>();
  const original = finder();
  Object.defineProperty(original, "closed", { value: closed.promise });
  let created = 0;
  const handle = registerFff(pi, {
    createFinder() { created += 1; return { ok: true, value: original }; },
  });
  const root = join(tmpdir(), "fff-shutdown-closing");
  await handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, root);
  original.destroy();
  const pending = handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, root);
  const rejected = assert.rejects(pending, /session ended/);
  await tick();
  let complete = false;
  const shutdown = Promise.resolve(handlers.get("session_shutdown")?.()).then(() => { complete = true; });
  await tick();
  assert.equal(complete, false);
  closed.resolve();
  await Promise.all([shutdown, rejected]);
  assert.equal(created, 1, "old cleanup completion must not spawn after shutdown");
});

test("failed reclamation retains owned capacity and permits retry only after cleanup succeeds", async () => {
  const { pi, handlers } = harness();
  let refuse = true;
  let created = 0;
  const handle = registerFff(pi, {
    createFinder() {
      created += 1;
      const native = finder();
      const markDestroyed = native.destroy;
      native.waitForScan = async () => {
        if (refuse) throw new Error("scan stopped");
        return { ok: true, value: true };
      };
      native.destroy = async () => {
        markDestroyed();
        if (refuse) throw new Error("reclamation unconfirmed");
      };
      return { ok: true, value: native };
    },
  });
  const roots = Array.from({ length: 9 }, (_, index) => join(tmpdir(), `fff-unconfirmed-${index}`));
  const search = (root: string) => handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, root);
  try {
    for (const root of roots.slice(0, 8)) await assert.rejects(search(root), /reclamation unconfirmed/);
    await assert.rejects(search(roots[8]), /worker limit reached/);
    await assert.rejects(search(roots[0]), /reclamation unconfirmed/);
    assert.equal(created, 8, "failed workers must retain permits, including same-root retries");
    refuse = false;
    assert.equal((await search(roots[0])).details?.engine, "fff");
    assert.equal(created, 9, "a replacement is allowed after confirmed cleanup");
  } finally {
    refuse = false;
    await handlers.get("session_shutdown")?.();
  }
});

test("history root switches wait for close and superseded initializers cannot publish", async () => {
  const closed = deferred<void>();
  const original = finder();
  Object.defineProperty(original, "closed", { value: closed.promise });
  const created: string[] = [];
  const accelerator = createSessionHistoryFffAccelerator({
    createFinder(options) {
      created.push(options.basePath);
      const native = created.length === 1 ? original : finder();
      native.glob = async () => ({ ok: true, value: { items: [], scores: [], totalMatched: 0, totalFiles: 0 } });
      native.grep = async () => grepResult();
      return { ok: true, value: native };
    },
  });
  const roots = ["a", "b", "c"].map((name) => join(tmpdir(), `fff-history-switch-${name}`));
  const context = (root: string) => ({ cwd: root, sessionManager: { getSessionFile: () => join(root, "active.jsonl") } });
  assert.equal((await accelerator.search("needle", context(roots[0]))).available, true);
  const superseded = accelerator.search("needle", context(roots[1]));
  await tick();
  const current = accelerator.search("needle", context(roots[2]));
  await tick();
  assert.deepEqual(created, [roots[0]], "a closing worker still owns the only history slot");
  closed.resolve();
  assert.equal((await superseded).available, false);
  assert.equal((await current).available, true);
  assert.deepEqual(created, [roots[0], roots[2]]);
  await accelerator.destroy();
});

test("history shutdown surfaces failed reclamation and retries retained ownership", async () => {
  let refuse = true;
  let attempts = 0;
  const native = finder();
  const markDestroyed = native.destroy;
  native.destroy = async () => {
    attempts += 1;
    markDestroyed();
    if (refuse) throw new Error("history reclamation unconfirmed");
  };
  const accelerator = createSessionHistoryFffAccelerator({ createFinder: () => ({ ok: true, value: native }) });
  const root = join(tmpdir(), "fff-history-retained-owner");
  const ctx = { cwd: root, sessionManager: { getSessionFile: () => join(root, "active.jsonl") } };
  await accelerator.search("needle", ctx);
  await assert.rejects(Promise.resolve(accelerator.destroy()), /history reclamation unconfirmed/);
  refuse = false;
  await accelerator.destroy();
  assert.equal(attempts, 2);
  assert.equal((await accelerator.search("needle", ctx)).available, false, "shutdown must not reopen discovery");
});

test("workspace failed teardown waits for every cleanup and pending initialization", async () => {
  const { pi, handlers } = harness();
  const scan = deferred<{ ok: true; value: boolean }>();
  const closed = deferred<void>();
  let refuse = true;
  const failed = finder();
  const stopFailed = failed.destroy;
  failed.destroy = async () => { stopFailed(); if (refuse) throw new Error("blocked workspace owner"); };
  const pendingNative = finder();
  const stopPending = pendingNative.destroy;
  pendingNative.waitForScan = () => scan.promise;
  pendingNative.destroy = async () => { stopPending(); await closed.promise; };
  Object.defineProperty(pendingNative, "closed", { value: closed.promise });
  let created = 0;
  const handle = registerFff(pi, {
    createFinder: () => ({ ok: true, value: ++created === 1 ? failed : pendingNative }),
  });
  const root = join(tmpdir(), "fff-teardown-barrier");
  await handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, join(root, "ready"));
  const pending = handle.search({ pattern: "needle", mode: "fuzzy", path: "src" }, join(root, "scanning"));
  const rejected = assert.rejects(pending, /session ended/);
  await tick();
  let settled = false;
  const shutdown = Promise.resolve(handlers.get("session_shutdown")?.());
  void shutdown.then(() => { settled = true; }, () => { settled = true; });
  const failedShutdown = assert.rejects(shutdown, /blocked workspace owner/);
  await tick();
  assert.equal(settled, false, "one cleanup failure must not bypass another pending cleanup");
  closed.resolve();
  await tick();
  assert.equal(settled, false, "cleanup completion must not bypass a pending initializer");
  scan.resolve({ ok: true, value: true });
  await Promise.all([failedShutdown, rejected]);
  refuse = false;
  await handlers.get("session_shutdown")?.();
});

test("history failed teardown waits for a superseded initializer before rejecting", async () => {
  const scan = deferred<{ ok: true; value: boolean }>();
  const native = finder();
  let refuse = true;
  const stop = native.destroy;
  native.waitForScan = () => scan.promise;
  native.destroy = async () => { stop(); if (refuse) throw new Error("blocked history owner"); };
  let created = 0;
  const accelerator = createSessionHistoryFffAccelerator({
    createFinder: () => { created += 1; return { ok: true, value: native }; },
  });
  const context = (name: string) => {
    const root = join(tmpdir(), `fff-history-barrier-${name}`);
    return { cwd: root, sessionManager: { getSessionFile: () => join(root, "active.jsonl") } };
  };
  const superseded = accelerator.search("needle", context("old"));
  await tick();
  assert.equal((await accelerator.search("needle", context("new"))).available, false);
  assert.equal(created, 1, "failed retirement must not allow a new worker");
  let settled = false;
  const shutdown = Promise.resolve(accelerator.destroy());
  void shutdown.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(shutdown, /blocked history owner/);
  await tick();
  assert.equal(settled, false, "the superseded scan is still in flight after current initialization failed");
  scan.resolve({ ok: true, value: true });
  assert.equal((await superseded).available, false);
  await rejected;
  refuse = false;
  await accelerator.destroy();
});

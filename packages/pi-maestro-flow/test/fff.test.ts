import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerFff } from "../src/tools/fff.ts";
import { buildArgs } from "../src/tools/search-rg.ts";

test("FFF tools are registered for the root Maestro session", () => {
  const tools: string[] = [];
  registerFff({
    registerTool(tool: ToolDefinition) { tools.push(tool.name); },
    on() {},
  } as unknown as ExtensionAPI);

  assert.ok(tools.includes("search"));
  assert.ok(tools.includes("fffind"));
  assert.ok(!tools.includes("ffgrep"), "ffgrep is replaced by search");
});

test("FFF refuses home-directory workspace roots", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  registerFff(register as unknown as ExtensionAPI);

  const grep = tools.find((tool) => tool.name === "search");
  assert.ok(grep);
  const ctx = {
    cwd: homedir(),
    ui: { notify() {} },
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  await assert.rejects(
    grep.execute(
      "fff-home-reject",
      { pattern: "needle", limit: 5 },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /does not index home directories/,
  );
});

test("FFF destroys an initializing finder when the session shuts down", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let finishFirstScan!: (result: { ok: true; value: boolean }) => void;
  let finishReplacementScan!: (result: { ok: true; value: boolean }) => void;
  let firstDestroyCount = 0;
  let replacementDestroyCount = 0;
  let createCount = 0;
  const finder = {
    isDestroyed: false,
    destroy() {
      if (finder.isDestroyed) return;
      finder.isDestroyed = true;
      firstDestroyCount += 1;
    },
    waitForScan() {
      return new Promise<{ ok: true; value: boolean }>((resolve) => {
        finishFirstScan = resolve;
      });
    },
  };
  const replacementFinder = {
    isDestroyed: false,
    destroy() {
      if (replacementFinder.isDestroyed) return;
      replacementFinder.isDestroyed = true;
      replacementDestroyCount += 1;
    },
    waitForScan() {
      return new Promise<{ ok: true; value: boolean }>((resolve) => {
        finishReplacementScan = resolve;
      });
    },
  };
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  registerFff(register as unknown as ExtensionAPI, {
    createFinder: () => ({
      ok: true,
      value: (++createCount === 1 ? finder : replacementFinder) as never,
    }),
    scanTimeoutMs: 60_000,
  });

  const grep = tools.find((tool) => tool.name === "search");
  assert.ok(grep);
  const root = join(tmpdir(), "pi-fff-pending");
  const ctx = { cwd: root } as unknown as ExtensionContext;
  const execution = grep.execute(
    "fff-shutdown",
    { pattern: "needle", path: "src", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  assert.equal(firstDestroyCount, 1);
  const replacement = grep.execute(
    "fff-replacement",
    { pattern: "needle", path: "src", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(createCount, 2);

  finishFirstScan({ ok: true, value: true });
  await assert.rejects(execution, /session ended/);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  assert.equal(
    replacementDestroyCount,
    1,
    "the stale initializer must not remove the replacement initializing finder",
  );
  finishReplacementScan({ ok: true, value: true });
  await assert.rejects(replacement, /session ended/);
});

test("FFF loads its native index and searches a selected workspace subdirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fff-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "needle.ts"), "export const FFF_INTEGRATION_NEEDLE = true;\n");
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  try {
    registerFff(register as unknown as ExtensionAPI);
    const ctx = {
      cwd: root,
      ui: { notify() {} },
      sessionManager: { getEntries: () => [] },
    } as unknown as ExtensionContext;
    const grep = tools.find((tool) => tool.name === "search");
    assert.ok(grep);
    const result = await grep.execute(
      "fff-smoke",
      { pattern: "FFF_INTEGRATION_NEEDLE", path: "src", limit: 10 },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.match(result.content[0]?.text ?? "", /needle\.ts/);

    const find = tools.find((tool) => tool.name === "fffind");
    assert.ok(find);
    const found = await find.execute(
      "fff-find-smoke",
      { pattern: "needle", path: "src", limit: 10 },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.match(found.content[0]?.text ?? "", /needle\.ts/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FFF search and fffind report results omitted by the requested limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fff-limits-"));
  const tools: ToolDefinition[] = [];
  let shutdown: (() => void) | undefined;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "needle-a.ts"), "NEEDLE\nNEEDLE\n");
    await writeFile(join(root, "src", "needle-b.ts"), "NEEDLE\n");
    registerFff({
      registerTool(tool: ToolDefinition) { tools.push(tool); },
      on(event: string, handler: () => void) {
        if (event === "session_shutdown") shutdown = handler;
      },
    } as unknown as ExtensionAPI);
    const ctx = { cwd: root } as unknown as ExtensionContext;
    const search = tools.find((tool) => tool.name === "search")!;
    for (const output of ["lines", "files", "count"]) {
      const result = await search.execute("fff-limit", {
        pattern: "NEEDLE", path: "src", output, limit: 1,
      }, undefined, undefined, ctx);
      assert.match(result.content[0]?.text ?? "", /limit reached/, `${output} must disclose omitted rows`);
      assert.equal(result.details?.truncated, true);
      assert.equal(result.details?.exhausted, true, "the native scan itself completed");
    }
    const find = tools.find((tool) => tool.name === "fffind")!;
    const found = await find.execute("fff-find-limit", {
      pattern: "needle", path: "src", limit: 1,
    }, undefined, undefined, ctx);
    assert.match(found.content[0]?.text ?? "", /limit reached/);
    assert.equal(found.details?.truncated, true);
  } finally {
    shutdown?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("FFF search and fffind cancellation does not wait for a shared index scan", async () => {
  for (const name of ["search", "fffind"]) {
    const { tools, register } = fakeRegister();
    let finishScan!: (result: { ok: true; value: boolean }) => void;
    let queried = false;
    const finder = {
      isDestroyed: false,
      destroy() { finder.isDestroyed = true; },
      waitForScan() {
        return new Promise<{ ok: true; value: boolean }>((resolve) => { finishScan = resolve; });
      },
      grep() { queried = true; return { ok: true, value: { items: [], nextCursor: null } }; },
      fileSearch() { queried = true; return { ok: true, value: { items: [], totalMatched: 0 } }; },
    };
    const handle = registerFff(register, { createFinder: () => ({ ok: true, value: finder }) as never });
    const controller = new AbortController();
    const root = join(tmpdir(), `pi-fff-cancel-${name}`);
    // search uses the broker handle directly: it must also honor cancellation.
    const pending = name === "search"
      ? handle.search({ pattern: "needle", path: "src" }, root, controller.signal)
      : tools.find((tool) => tool.name === name)!.execute("fff-cancel", {
          pattern: "needle", path: "src",
        }, controller.signal, undefined, { cwd: root } as unknown as ExtensionContext);
    let settled = false;
    let failure: unknown;
    void pending.then(() => { settled = true; }, (error) => { settled = true; failure = error; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, true, `${name} must settle before waitForScan completes`);
      assert.equal((failure as Error)?.name, "AbortError");
      assert.equal(finder.isDestroyed, false, "one caller must not destroy the shared scan");
    } finally {
      finishScan({ ok: true, value: true });
      await pending.catch(() => undefined);
      finder.destroy();
    }
    assert.equal(queried, false, "cancelled calls must not start native queries after the scan");
  }
});

test("fffind discloses an incomplete scoped drain instead of definitive empty results", async () => {
  const { tools, register } = fakeRegister();
  let pages = 0;
  const finder = {
    isDestroyed: false,
    destroy() { finder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    fileSearch(_pattern: string, options: { pageIndex: number; pageSize: number }) {
      pages += 1;
      return {
        ok: true as const,
        value: {
          items: Array.from({ length: options.pageSize }, (_, index) => ({
            relativePath: `other/needle-${options.pageIndex * options.pageSize + index}.ts`,
          })),
          totalMatched: 10_001,
        },
      };
    },
  };
  registerFff(register, { createFinder: () => ({ ok: true, value: finder }) as never });
  const result = await tools.find((tool) => tool.name === "fffind")!.execute("fff-drain", {
    pattern: "needle", path: "src", limit: 1,
  }, undefined, undefined, { cwd: join(tmpdir(), "pi-fff-scoped-drain") } as unknown as ExtensionContext);
  assert.equal(pages, 200, "the drain remains bounded");
  assert.match(result.content[0]?.text ?? "", /index drain stopped early.*incomplete/);
  assert.equal(result.details?.exhausted, false);
  assert.equal(result.details?.truncated, true);
});

function fakeRegister(): {
  tools: ToolDefinition[];
  register: ExtensionAPI;
} {
  const tools: ToolDefinition[] = [];
  const register = {
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    on() {},
  };
  return { tools, register: register as unknown as ExtensionAPI };
}

test("FFF destroys finders whose scan promise rejects and permits same-root retries", async () => {
  const { tools, register } = fakeRegister();
  let createCount = 0;
  let destroyCount = 0;
  registerFff(register, {
    createFinder: () => {
      createCount += 1;
      const finder = {
        isDestroyed: false,
        destroy() {
          if (finder.isDestroyed) return;
          finder.isDestroyed = true;
          destroyCount += 1;
        },
        async waitForScan() { throw new Error("scan rejected"); },
      };
      return { ok: true, value: finder } as never;
    },
    runRg: async () => ({ text: "No matches found", limitReached: false }),
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-rejected-scan") } as unknown as ExtensionContext;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await search.execute(
      `fff-rejected-scan-${attempt}`,
      { pattern: "needle", path: "src" },
      new AbortController().signal,
      undefined,
      ctx,
    );
  }

  assert.equal(createCount, 2, "a rejected scan must not leave a same-root initializer cached");
  assert.equal(destroyCount, 2, "every unpublished finder must be destroyed after scan rejection");
});

test("FFF retries after createFinder throws synchronously without caching the rejected reservation", async () => {
  const { tools, register } = fakeRegister();
  let createCount = 0;
  let fallbackCount = 0;
  registerFff(register, {
    createFinder: () => {
      createCount += 1;
      throw new Error("synchronous create failure");
    },
    runRg: async () => {
      fallbackCount += 1;
      return { text: `fallback ${fallbackCount}`, limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-sync-create-failure") } as unknown as ExtensionContext;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await search.execute(
      `fff-sync-create-failure-${attempt}`,
      { pattern: "needle", path: "src" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.match(result.content[0]?.text ?? "", new RegExp(`fallback ${attempt}`));
  }

  assert.equal(createCount, 2, "each same-root attempt must execute createFinder");
  assert.equal(fallbackCount, 2, "each failed initialization must fall back independently");
});

test("FFF bounds the failed-root cache and retries the oldest root after 33 failures", async () => {
  const { tools, register } = fakeRegister();
  const createdRoots: string[] = [];
  let destroyCount = 0;
  registerFff(register, {
    createFinder: (options) => {
      createdRoots.push(options.basePath);
      const finder = {
        isDestroyed: false,
        destroy() {
          if (finder.isDestroyed) return;
          finder.isDestroyed = true;
          destroyCount += 1;
        },
        async waitForScan() { return { ok: true as const, value: false }; },
      };
      return { ok: true, value: finder } as never;
    },
    runRg: async () => ({ text: "No matches found", limitReached: false }),
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const roots = Array.from({ length: 33 }, (_, index) => join(tmpdir(), `pi-fff-failed-root-${index}`));

  for (const [index, root] of roots.entries()) {
    await search.execute(
      `fff-timeout-${index}`,
      { pattern: "needle", path: "src" },
      new AbortController().signal,
      undefined,
      { cwd: root } as unknown as ExtensionContext,
    );
  }
  await search.execute(
    "fff-timeout-oldest-retry",
    { pattern: "needle", path: "src" },
    new AbortController().signal,
    undefined,
    { cwd: roots[0] } as unknown as ExtensionContext,
  );

  assert.equal(createdRoots.length, 34);
  assert.equal(createdRoots.at(-1), createdRoots[0], "the oldest failed root must be evicted and retryable");
  assert.equal(destroyCount, 34);
});

test("search falls back to ripgrep when the index cannot initialize", async () => {
  const { tools, register } = fakeRegister();
  const rgCalls: Array<{ pattern: string; output: string }> = [];
  registerFff(register, {
    createFinder: () => ({ ok: false, error: "native binding missing" }) as never,
    runRg: async (request) => {
      rgCalls.push({ pattern: request.pattern, output: request.output });
      return { text: "src/a.ts:3: hit", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-rg-fallback") } as unknown as ExtensionContext;
  const result = await search.execute(
    "search-rg",
    { pattern: "needle", path: "src", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(rgCalls.length, 1);
  assert.equal(rgCalls[0]?.output, "lines");
  assert.match(result.content[0]?.text ?? "", /src\/a\.ts:3: hit/);
  assert.match(result.content[0]?.text ?? "", /engine: rg/);
});

test("root-wide plain search uses bounded rg without waiting for an index", async () => {
  const { tools, register } = fakeRegister();
  let finderCreated = false;
  let rgCalls = 0;
  registerFff(register, {
    createFinder: () => {
      finderCreated = true;
      return { ok: false, error: "should not be created" } as never;
    },
    runRg: async () => {
      rgCalls += 1;
      return { text: "src/a.ts:1: hit", limitReached: false, timedOut: true };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-root-rg") } as unknown as ExtensionContext;
  const result = await search.execute("search-root", { pattern: "hit" }, new AbortController().signal, undefined, ctx);
  assert.equal(finderCreated, false);
  assert.equal(rgCalls, 1);
  assert.match(result.content[0]?.text ?? "", /search timed out.*narrow path/);
  assert.equal(result.details?.truncated, true);
  assert.match(search.description, /root-wide.*ripgrep/);
  assert.match(search.parameters.properties.path.description, /subdirectory/);
});

test("root-wide search retains the index when rg is unavailable", async () => {
  const { tools, register } = fakeRegister();
  let finderCreated = false;
  const finder = {
    isDestroyed: false,
    destroy() { finder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep() { return { ok: true as const, value: { items: [{ relativePath: "src/a.ts", lineNumber: 1, lineContent: "hit" }] } }; },
  };
  registerFff(register, {
    createFinder: () => {
      finderCreated = true;
      return { ok: true, value: finder } as never;
    },
    runRg: async () => { throw new Error("ripgrep (rg) is not available on PATH; install ripgrep or restore the FFF index"); },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-root-index-fallback") } as unknown as ExtensionContext;
  const result = await search.execute("search-root", { pattern: "hit" }, new AbortController().signal, undefined, ctx);
  assert.equal(finderCreated, true);
  assert.match(result.content[0]?.text ?? "", /src\/a\.ts:1: hit/);
  assert.equal(result.details?.engine, "fff");
});

test("root-wide regex preserves invalid-regex literal fallback", async () => {
  const { tools, register } = fakeRegister();
  const modes: boolean[] = [];
  registerFff(register, {
    runRg: async (request) => {
      modes.push(request.regex);
      if (request.regex) throw new Error("regex parse error: unclosed group");
      return { text: "src/a.ts:1: foo(", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-root-regex") } as unknown as ExtensionContext;
  const result = await search.execute("search-root-regex", { pattern: "foo(", mode: "regex" }, new AbortController().signal, undefined, ctx);
  assert.deepEqual(modes, [true, false]);
  assert.match(result.content[0]?.text ?? "", /invalid regex — matched literally/);
});

test("search mode=fuzzy reports an explicit error when the index is unavailable", async () => {
  const { tools, register } = fakeRegister();
  let rgCalled = false;
  registerFff(register, {
    createFinder: () => ({ ok: false, error: "native binding missing" }) as never,
    runRg: async () => {
      rgCalled = true;
      return { text: "", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-fuzzy") } as unknown as ExtensionContext;
  await assert.rejects(
    search.execute(
      "search-fuzzy",
      { pattern: "needle", mode: "fuzzy", limit: 5 },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /index unavailable/,
  );
  assert.equal(rgCalled, false, "fuzzy must not silently degrade to rg");
});

test("search aggregates files/count output and filters by path prefix", async () => {
  const { tools, register } = fakeRegister();
  const finder = {
    isDestroyed: false,
    destroy() { finder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep(_pattern: string, options: { cursor?: unknown }) {
      const page = options.cursor === null || options.cursor === undefined ? 0 : 1;
      const items = page === 0
        ? [
            { relativePath: "src/a.ts", lineNumber: 1, lineContent: "hit" },
            { relativePath: "other/b.ts", lineNumber: 2, lineContent: "hit" },
          ]
        : [
            { relativePath: "src/a.ts", lineNumber: 9, lineContent: "hit" },
            { relativePath: "src/c.ts", lineNumber: 4, lineContent: "hit" },
          ];
      return {
        ok: true as const,
        value: {
          items,
          totalMatched: items.length,
          totalFilesSearched: 3,
          nextCursor: page === 0 ? ({ _offset: 1 } as never) : null,
        },
      };
    },
  };
  registerFff(register, { createFinder: () => ({ ok: true, value: finder }) as never });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-aggregate") } as unknown as ExtensionContext;

  const files = await search.execute(
    "search-files",
    { pattern: "hit", path: "src", output: "files", limit: 10 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(files.content[0]?.text, "src/a.ts\nsrc/c.ts");

  const counts = await search.execute(
    "search-count",
    { pattern: "hit", path: "src", output: "count", limit: 10 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(counts.content[0]?.text, "src/a.ts:2\nsrc/c.ts:1");
});

test("search routes forced-insensitive uppercase patterns to ripgrep", async () => {
  const { tools, register } = fakeRegister();
  const rgCalls: Array<{ ignoreCase?: boolean }> = [];
  let finderCreated = false;
  registerFff(register, {
    createFinder: () => {
      finderCreated = true;
      return { ok: false, error: "should not be created" } as never;
    },
    runRg: async (request) => {
      rgCalls.push({ ignoreCase: request.ignoreCase });
      return { text: "src/a.ts:1: HIT", limitReached: false };
    },
  });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-insensitive") } as unknown as ExtensionContext;
  const result = await search.execute(
    "search-icase",
    { pattern: "Needle", ignoreCase: true, limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(finderCreated, false, "forced-insensitive uppercase goes straight to rg");
  assert.equal(rgCalls[0]?.ignoreCase, true);
  assert.match(result.content[0]?.text ?? "", /engine: rg/);
});

test("ripgrep fallback argv mirrors the FFF engine's case semantics", () => {
  const base = { pattern: "needle", regex: false, path: "/w", context: 0, output: "lines" as const, limit: 10 };
  assert.ok(buildArgs({ ...base, ignoreCase: undefined }).includes("--smart-case"));
  assert.ok(buildArgs({ ...base, ignoreCase: true }).includes("--ignore-case"));
  const sensitive = buildArgs({ ...base, ignoreCase: false });
  assert.ok(!sensitive.includes("--ignore-case") && !sensitive.includes("--smart-case"));
  assert.ok(buildArgs({ ...base, ignoreCase: undefined }).includes("--fixed-strings"));
  assert.ok(!buildArgs({ ...base, ignoreCase: undefined, regex: true }).includes("--fixed-strings"));
});

test("search surfaces the index's regex-to-literal fallback as a note", async () => {
  const { tools, register } = fakeRegister();
  const finder = {
    isDestroyed: false,
    destroy() { finder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep() {
      return {
        ok: true as const,
        value: {
          items: [{ relativePath: "src/a.ts", lineNumber: 1, lineContent: "foo(" }],
          totalMatched: 1,
          totalFilesSearched: 1,
          nextCursor: null,
          regexFallbackError: "unclosed group",
        },
      };
    },
  };
  registerFff(register, { createFinder: () => ({ ok: true, value: finder }) as never });
  const search = tools.find((tool) => tool.name === "search");
  assert.ok(search);
  const ctx = { cwd: join(tmpdir(), "pi-fff-regex-fallback") } as unknown as ExtensionContext;
  const result = await search.execute(
    "search-regex-fallback",
    { pattern: "foo(", path: "src", mode: "regex", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.match(result.content[0]?.text ?? "", /src\/a\.ts:1: foo\(/);
  assert.match(result.content[0]?.text ?? "", /invalid regex — matched literally \(unclosed group\)/);
});

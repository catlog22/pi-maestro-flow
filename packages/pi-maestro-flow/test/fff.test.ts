import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerFff } from "../src/tools/fff.ts";

test("FFF tools are registered for the root Maestro session", () => {
  const tools: string[] = [];
  registerFff({
    registerTool(tool: ToolDefinition) { tools.push(tool.name); },
    on() {},
  } as unknown as ExtensionAPI);

  assert.ok(tools.includes("ffgrep"));
  assert.ok(tools.includes("fffind"));
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

  const grep = tools.find((tool) => tool.name === "ffgrep");
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
  let finishScan!: (result: { ok: true; value: boolean }) => void;
  let destroyCount = 0;
  let createCount = 0;
  const finder = {
    isDestroyed: false,
    destroy() {
      if (finder.isDestroyed) return;
      finder.isDestroyed = true;
      destroyCount += 1;
    },
    waitForScan() {
      return new Promise<{ ok: true; value: boolean }>((resolve) => {
        finishScan = resolve;
      });
    },
  };
  const replacementFinder = {
    isDestroyed: false,
    destroy() { replacementFinder.isDestroyed = true; },
    async waitForScan() { return { ok: true as const, value: true }; },
    grep() { return { ok: true as const, value: { items: [] } }; },
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

  const grep = tools.find((tool) => tool.name === "ffgrep");
  assert.ok(grep);
  const root = join(tmpdir(), "pi-fff-pending");
  const ctx = { cwd: root } as unknown as ExtensionContext;
  const execution = grep.execute(
    "fff-shutdown",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  assert.equal(destroyCount, 1);
  const replacement = await grep.execute(
    "fff-replacement",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(replacement.content[0]?.text, "No matches found");
  assert.equal(createCount, 2);

  finishScan({ ok: true, value: true });
  await assert.rejects(execution, /session ended/);
  await grep.execute(
    "fff-cached-replacement",
    { pattern: "needle", limit: 5 },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(createCount, 2, "the old initializer must not delete the replacement reservation");
  assert.equal(destroyCount, 1);
});

test("FFF loads its native index and searches a root workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fff-"));
  await writeFile(join(root, "needle.ts"), "export const FFF_INTEGRATION_NEEDLE = true;\n");
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
    const grep = tools.find((tool) => tool.name === "ffgrep");
    assert.ok(grep);
    const result = await grep.execute(
      "fff-smoke",
      { pattern: "FFF_INTEGRATION_NEEDLE", limit: 10 },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.match(result.content[0]?.text ?? "", /needle\.ts/);

    const find = tools.find((tool) => tool.name === "fffind");
    assert.ok(find);
    const found = await find.execute(
      "fff-find-smoke",
      { pattern: "needle", limit: 10 },
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

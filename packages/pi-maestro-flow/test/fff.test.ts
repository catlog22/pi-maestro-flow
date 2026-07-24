import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

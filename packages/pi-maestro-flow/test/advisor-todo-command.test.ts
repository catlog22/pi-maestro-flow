import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerAdvisor from "../src/advisor/extension.ts";
import type { AdvisorTodoSettingsOverlay, AdvisorTodoSettingsResult } from "../src/tui/advisor-todo-settings.ts";

const theme = { fg(_role: string, text: string) { return text; }, bold(text: string) { return text; } };
type Factory = (tui: { requestRender(): void }, colors: typeof theme, keys: unknown, done: (result: AdvisorTodoSettingsResult) => void) => AdvisorTodoSettingsOverlay;
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "advisor-todo-command-"));
  await mkdir(join(cwd, ".pi")); const path = join(cwd, ".pi", "advisor.json");
  await writeFile(path, JSON.stringify({ enabled: true, guide: "preserve", todoReview: { enabled: true } }));
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>();
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined; let tools: string[] = [];
  const pi = { events: { emit() {} }, on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(tool: { name: string }) { tools.push(tool.name); }, getActiveTools: () => tools, setActiveTools: (value: string[]) => { tools = value; }, getThinkingLevel: () => "low",
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { if (name === "advisor") command = options.handler; } } as unknown as ExtensionAPI;
  const notices: string[] = []; let custom: (factory: Factory) => Promise<AdvisorTodoSettingsResult> = async () => "cancelled";
  const ctx = { cwd, hasUI: true, mode: "tui", model: { provider: "main", id: "primary" }, modelRegistry: { getAvailable: () => [{ provider: "main", id: "primary" }] },
    sessionManager: { getSessionId: () => "command-session", getSessionFile: () => "command.jsonl" },
    ui: { notify(message: string) { notices.push(message); }, custom(factory: Factory) { return custom(factory); } } };
  const extensionCtx = ctx as unknown as ExtensionContext;
  registerAdvisor(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({}, extensionCtx);
  for (const handler of handlers.get("before_agent_start") ?? []) await handler({}, extensionCtx);
  assert.ok(command);
  return { ctx, notices, path, command: (args: string) => command!(args, extensionCtx), setCustom: (callback: typeof custom) => { custom = callback; },
    async close() { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, extensionCtx); await rm(cwd, { recursive: true, force: true }); } };
}
test("/advisor todo opens the real panel and saves confirmed draft through canonical commit", async () => {
  const h = await setup(); let opened = 0;
  h.setCustom(async (factory) => new Promise<AdvisorTodoSettingsResult>((done) => {
    opened++; const component = factory({ requestRender() {} }, theme, {}, done);
    component.handleInput("\r"); component.handleInput("\x13"); component.handleInput("\r");
  }));
  try {
    await h.command("todo"); assert.equal(opened, 1);
    const saved = JSON.parse(await readFile(h.path, "utf8")) as { enabled: boolean; guide: string; todoReview: { enabled: boolean } };
    assert.equal(saved.enabled, false); assert.equal(saved.guide, "preserve"); assert.equal(saved.todoReview.enabled, true);
  } finally { await h.close(); }
});
test("/advisor settings rejects stale concurrent drafts and RPC does not open the panel", async () => {
  const h = await setup(); let opened = 0;
  h.setCustom(async (factory) => {
    opened++; let result: AdvisorTodoSettingsResult | undefined;
    const component = factory({ requestRender() {} }, theme, {}, next => { result = next; });
    component.handleInput("\r"); await h.command("todo mode shadow");
    component.handleInput("\x13"); component.handleInput("\r"); component.handleInput("\x1b");
    assert.equal(result, "cancelled"); return result;
  });
  try {
    await h.command("settings");
    const saved = JSON.parse(await readFile(h.path, "utf8")) as { enabled: boolean; todoReview: { mode: string } };
    assert.equal(saved.enabled, true); assert.equal(saved.todoReview.mode, "shadow");
    h.ctx.mode = "rpc"; await h.command("settings"); assert.equal(opened, 1);
    assert.match(h.notices.at(-1)!, /TUI/);
  } finally { await h.close(); }
});

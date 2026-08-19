import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_NOTIFY_CONFIG,
  applyNotifyPatch,
  loadNotifyGlobalState,
  notifyGlobalStatePath,
  registerNotifyMode,
  saveNotifyGlobalState,
} from "../src/notify/notify-mode.ts";
import { registerNotifyListeners } from "../src/notify/notify-listeners.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type Command = { handler: CommandHandler };
type NotifyEntry = { type: "custom"; customType: string; data: Record<string, unknown> };

interface CapturedNotify {
  message: string;
  type: string;
}

function createHarness(entries: NotifyEntry[], cwd: string, homeDir: string) {
  const commands = new Map<string, Command>();
  const handlers: Record<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>> = {};
  const notifications: CapturedNotify[] = [];
  const api = {
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    appendEntry(customType: string, data: Record<string, unknown>) {
      entries.push({ type: "custom", customType, data });
    },
    on(event: string, handler: unknown) {
      (handlers[event] ??= []).push(handler as (event: unknown, ctx: ExtensionContext) => unknown);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => entries },
    ui: { notify(message: string, type: string) { notifications.push({ message, type }); } },
  } as unknown as ExtensionContext;
  const mode = registerNotifyMode(api, { homeDir });
  return { commands, handlers, notifications, ctx, mode };
}

test("notify mode defaults to enabled with both error and completion on", () => {
  const home = mkdtempSync(join(tmpdir(), "notify-default-"));
  const h = createHarness([], process.cwd(), home);
  assert.deepEqual(h.mode.getConfig(), DEFAULT_NOTIFY_CONFIG);
  assert.equal(DEFAULT_NOTIFY_CONFIG.enabled, true);
  assert.equal(DEFAULT_NOTIFY_CONFIG.onError, true);
  assert.equal(DEFAULT_NOTIFY_CONFIG.onComplete, true);
  rmSync(home, { recursive: true, force: true });
});

test("/notify on|off|error|complete|status toggles and persists globally", async () => {
  const home = mkdtempSync(join(tmpdir(), "notify-cmd-"));
  const h = createHarness([], process.cwd(), home);

  // Bare /notify toggles master switch off (from default on).
  await h.commands.get("notify")?.handler("", h.ctx);
  assert.equal(h.mode.getConfig().enabled, false);
  assert.match(h.notifications.at(-1)?.message ?? "", /已关闭/);

  // /notify on re-enables and persists.
  await h.commands.get("notify")?.handler("on", h.ctx);
  assert.equal(h.mode.getConfig().enabled, true);
  const persisted = JSON.parse(readFileSync(notifyGlobalStatePath(home), "utf8"));
  assert.equal(persisted.enabled, true);
  assert.equal(persisted.onError, true);
  assert.equal(persisted.onComplete, true);

  // /notify error flips onError off (and keeps master enabled).
  await h.commands.get("notify")?.handler("error", h.ctx);
  assert.equal(h.mode.getConfig().onError, false);
  assert.equal(h.mode.getConfig().enabled, true);

  // /notify complete flips onComplete off.
  await h.commands.get("notify")?.handler("complete", h.ctx);
  assert.equal(h.mode.getConfig().onComplete, false);

  // /notify status reports without mutating.
  const before = h.notifications.length;
  await h.commands.get("notify")?.handler("status", h.ctx);
  assert.equal(h.notifications.length, before + 1);
  assert.match(h.notifications.at(-1)?.message ?? "", /已开启/);

  // Unknown arg warns with usage.
  await h.commands.get("notify")?.handler("bogus", h.ctx);
  assert.match(h.notifications.at(-1)?.message ?? "", /用法/);

  rmSync(home, { recursive: true, force: true });
});

test("global state restores across workspaces; session branch is the fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "notify-global-"));
  const workspaceA = join(home, "ws-a");
  const workspaceB = join(home, "ws-b");

  // Fresh session: no global file → defaults.
  const h1 = createHarness([], workspaceA, home);
  await h1.handlers.session_start[0]?.({}, h1.ctx);
  assert.deepEqual(h1.mode.getConfig(), DEFAULT_NOTIFY_CONFIG);

  // Disable globally.
  await h1.commands.get("notify")?.handler("off", h1.ctx);
  assert.equal(loadNotifyGlobalState(home)?.enabled, false);

  // A different workspace restores the global disabled state.
  const h2 = createHarness([], workspaceB, home);
  await h2.handlers.session_start[0]?.({}, h2.ctx);
  assert.equal(h2.mode.getConfig().enabled, false);

  // When no global file exists, the session branch entry is consulted.
  rmSync(notifyGlobalStatePath(home), { force: true });
  const entries: NotifyEntry[] = [{
    type: "custom",
    customType: "maestro-notify-mode",
    data: { enabled: true, onError: false, onComplete: true },
  }];
  const h3 = createHarness(entries, workspaceA, home);
  await h3.handlers.session_start[0]?.({}, h3.ctx);
  assert.equal(h3.mode.getConfig().enabled, true);
  assert.equal(h3.mode.getConfig().onError, false);

  rmSync(home, { recursive: true, force: true });
});

test("applyNotifyPatch merges partial patches without losing keys", () => {
  const base: typeof DEFAULT_NOTIFY_CONFIG = { enabled: true, onError: true, onComplete: true };
  assert.deepEqual(applyNotifyPatch(base, { onError: false }), { enabled: true, onError: false, onComplete: true });
  assert.deepEqual(applyNotifyPatch(base, { enabled: false }), { enabled: false, onError: true, onComplete: true });
  assert.deepEqual(applyNotifyPatch(base, {}), base);
});

test("saveNotifyGlobalState writes an atomic versioned file", () => {
  const home = mkdtempSync(join(tmpdir(), "notify-save-"));
  saveNotifyGlobalState({ enabled: false, onError: true, onComplete: false }, home);
  const parsed = JSON.parse(readFileSync(notifyGlobalStatePath(home), "utf8"));
  assert.deepEqual(parsed, { version: 1, enabled: false, onError: true, onComplete: false });
  rmSync(home, { recursive: true, force: true });
});

test("listeners fire error toast on message_end stopReason=error and suppress the complete toast", async () => {
  const home = mkdtempSync(join(tmpdir(), "notify-err-"));
  const h = createHarness([], process.cwd(), home);
  await h.handlers.session_start[0]?.({}, h.ctx);
  const controller = registerNotifyListeners(
    (() => {
      const api = { on: (event: string, handler: unknown) => (h.handlers[event] ??= []).push(handler as (event: unknown, ctx: ExtensionContext) => unknown) } as unknown as ExtensionAPI;
      return api;
    })(),
    h.mode,
  );

  // Turn reset at start.
  controller.reset();

  // after_provider_response 4xx seeds the error latch (no notify yet).
  await h.handlers.after_provider_response[0]?.({ status: 429 }, h.ctx);
  assert.equal(h.notifications.length, 0);

  // message_end assistant stopReason=error fires the error toast.
  await h.handlers.message_end[0]?.(
    { message: { role: "assistant", stopReason: "error", errorMessage: "rate limited" } },
    h.ctx,
  );
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].type, "error");
  assert.match(h.notifications[0].message, /模型报错/);
  assert.match(h.notifications[0].message, /rate limited/);

  // agent_settled: because an error was seen this turn, no complete toast fires.
  await h.handlers.agent_settled[0]?.({}, h.ctx);
  assert.equal(h.notifications.length, 1);

  rmSync(home, { recursive: true, force: true });
});

test("listeners fire complete toast on agent_settled when the turn had no error", async () => {
  const home = mkdtempSync(join(tmpdir(), "notify-ok-"));
  const h = createHarness([], process.cwd(), home);
  await h.handlers.session_start[0]?.({}, h.ctx);
  const controller = registerNotifyListeners(
    (() => {
      const api = { on: (event: string, handler: unknown) => (h.handlers[event] ??= []).push(handler as (event: unknown, ctx: ExtensionContext) => unknown) } as unknown as ExtensionAPI;
      return api;
    })(),
    h.mode,
  );

  controller.reset();
  // A 2xx response does not seed an error latch.
  await h.handlers.after_provider_response[0]?.({ status: 200 }, h.ctx);
  // A normal assistant message end (stopReason != error) does nothing.
  await h.handlers.message_end[0]?.(
    { message: { role: "assistant", stopReason: "end_turn" } },
    h.ctx,
  );
  assert.equal(h.notifications.length, 0);

  // agent_settled fires the complete toast.
  await h.handlers.agent_settled[0]?.({}, h.ctx);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].type, "info");
  assert.match(h.notifications[0].message, /已完成/);

  rmSync(home, { recursive: true, force: true });
});

test("disabled mode fires nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "notify-off-"));
  const h = createHarness([], process.cwd(), home);
  await h.handlers.session_start[0]?.({}, h.ctx);
  await h.commands.get("notify")?.handler("off", h.ctx);
  assert.equal(h.mode.getConfig().enabled, false);

  registerNotifyListeners(
    (() => {
      const api = { on: (event: string, handler: unknown) => (h.handlers[event] ??= []).push(handler as (event: unknown, ctx: ExtensionContext) => unknown) } as unknown as ExtensionAPI;
      return api;
    })(),
    h.mode,
  );

  await h.handlers.after_provider_response[0]?.({ status: 500 }, h.ctx);
  await h.handlers.message_end[0]?.(
    { message: { role: "assistant", stopReason: "error", errorMessage: "boom" } },
    h.ctx,
  );
  await h.handlers.agent_settled[0]?.({}, h.ctx);
  // Only the /notify off confirmation toast is present; no event-driven toasts.
  const eventToasts = h.notifications.filter((n) => /模型报错|已完成/.test(n.message));
  assert.equal(eventToasts.length, 0);

  rmSync(home, { recursive: true, force: true });
});

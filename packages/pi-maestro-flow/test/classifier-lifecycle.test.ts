import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerClassifier from "../src/classifier/extension.ts";
import type { ClassifierSettingsOverlay } from "../src/tui/classifier-settings.ts";
import { isDecisionPolicyConfiguring } from "../src/decision-policy/extension.ts";

const theme = { fg(_role: string, text: string) { return text; }, bold(text: string) { return text; } };

test("lifecycle during initial configuration load cannot open a post-boundary panel", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "classifier-initial-load-"));
  let entered!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const original = fsPromises.readFile;
  let paused = false;
  t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof original>) => {
    if (!paused && String(args[0]).endsWith("classifier.json")) { paused = true; entered(); await gate; }
    return original(...args);
  });
  syncBuiltinESMExports();
  const listeners = new Map<string, (() => void)[]>();
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  let opened = false;
  const pi = { on(name: string, callback: () => void) { const callbacks = listeners.get(name) ?? []; callbacks.push(callback); listeners.set(name, callbacks); }, registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } };
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "same-identity" }, modelRegistry: {}, ui: { notify() {}, custom: () => { opened = true; throw new Error("Must not open stale panel"); } } };
  try {
    registerClassifier(pi as never);
    const pending = handler("", ctx);
    const rejected = assert.rejects(pending, /cancelled or stale/);
    await reached;
    for (const callback of listeners.get("session_before_fork")!) callback();
    resume(); await rejected;
    assert.equal(opened, false);
    await assert.rejects(readFile(join(cwd, ".pi", "classifier.json")), { code: "ENOENT" });
  } finally { resume(); t.mock.restoreAll(); syncBuiltinESMExports(); await rm(cwd, { recursive: true, force: true }); }
});

test("invalid policy load is reported rather than hidden by panel cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "classifier-invalid-policy-"));
  const child = process.env.PI_TEAMMATE_CHILD;
  const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
  delete process.env.PI_TEAMMATE_CHILD; delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  const notices: string[] = [];
  const pi = { on() {}, registerCommand(_name: string, command: { handler: typeof handler }) { handler = command.handler; } };
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "invalid-policy" }, modelRegistry: {}, ui: { notify: (message: string) => notices.push(message), confirm: async () => true, custom: () => { throw new Error("Must not open invalid policy"); } } };
  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "decision-policy.json"), "{");
    registerClassifier(pi as never);
    await handler("", ctx);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /SyntaxError/);
    assert.equal(isDecisionPolicyConfiguring(ctx as never), false);
  } finally {
    if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
    if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const boundary of ["session_start", "session_before_switch", "session_before_fork", "session_shutdown", "reload", "abort", "session-identity"] as const) {
  test(`classifier panel refuses stale save and releases policy handle: ${boundary}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "classifier-lifecycle-"));
    const child = process.env.PI_TEAMMATE_CHILD;
    const managed = process.env.PI_TEAMMATE_MANAGED_WINDOW;
    delete process.env.PI_TEAMMATE_CHILD;
    delete process.env.PI_TEAMMATE_MANAGED_WINDOW;
    let sessionId = "old-session";
    let overlay!: ClassifierSettingsOverlay;
    let opened!: () => void;
    const ready = new Promise<void>(resolve => { opened = resolve; });
    const listeners = new Map<string, ((...args: any[]) => any)[]>();
    let handler!: (args: string, ctx: any) => Promise<void>;
    const pi = {
      on(name: string, callback: (...args: any[]) => any) { const callbacks = listeners.get(name) ?? []; callbacks.push(callback); listeners.set(name, callbacks); },
      registerCommand(_name: string, command: any) { handler = command.handler; },
    };
    const lifetime = new AbortController();
    const notifications: string[] = [];
    const ctx = {
      cwd, hasUI: true, signal: lifetime.signal,
      sessionManager: { getSessionId: () => sessionId }, modelRegistry: { getAvailable: () => [] },
      ui: {
        notify: (message: string) => notifications.push(message), setStatus() {}, confirm: async () => true,
        custom: (factory: any) => new Promise(resolve => {
          overlay = factory({ requestRender() {} }, theme, {}, (intent: string) => { overlay.dispose(); resolve(intent); });
          opened();
        }),
      },
    };
    try {
      registerClassifier(pi as never);
      const command = handler("", ctx);
      await ready;
      assert.equal(isDecisionPolicyConfiguring(ctx as never), true);
      overlay.handleInput("\r"); overlay.handleInput("\x1b[B"); overlay.handleInput("\r");
      overlay.handleInput("\x13");
      // Every lifecycle event revokes a pending confirmation before Enter can publish.
      if (boundary === "reload") registerClassifier(pi as never);
      else if (boundary === "abort") lifetime.abort();
      else if (boundary === "session-identity") sessionId = "new-session";
      else for (const callback of [...listeners.get(boundary)!]) callback({}, ctx);
      overlay.handleInput("\r");
      await command;
      await assert.rejects(readFile(join(cwd, ".pi", "classifier.json")), { code: "ENOENT" });
      await assert.rejects(readFile(join(cwd, ".pi", "decision-policy.json")), { code: "ENOENT" });
      sessionId = "old-session";
      assert.equal(isDecisionPolicyConfiguring(ctx as never), false);
      assert.ok(!notifications.some(message => message.includes("saved")));
    } finally {
      if (child === undefined) delete process.env.PI_TEAMMATE_CHILD; else process.env.PI_TEAMMATE_CHILD = child;
      if (managed === undefined) delete process.env.PI_TEAMMATE_MANAGED_WINDOW; else process.env.PI_TEAMMATE_MANAGED_WINDOW = managed;
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

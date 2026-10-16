import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "../src/tools/browser-tool.ts";
import { BrowserSessionScopes, browserHostSessionId, browserSessionScopes } from "../src/tools/browser/session-scope.ts";
import { canonicalizeBrowserOpenOptions, type BrowserManagerLike, type BrowserOpenOptions } from "../src/tools/browser/manager.ts";
import { browserBridge } from "../src/tools/browser/bridge-server.ts";
import { shutdownIntelligenceTools } from "../src/tools/intelligence.ts";
import { lspManager } from "../src/tools/lsp/manager.ts";
import { computerUseManager } from "../src/tools/computer-use/manager.ts";

function fakeManager() {
  const tabs = new Map<string, BrowserOpenOptions>();
  const runs: string[] = [];
  const manager: BrowserManagerLike = {
    async open(options) {
      const reused = tabs.has(options.name);
      tabs.set(options.name, options);
      return { name: options.name, kind: "headless", url: options.url ?? "about:blank", title: "", reused,
        connection: { channel: "managed", ownership: "owned", capabilities: { page: true, cdp: true, cookies: true } } };
    },
    async run(name) {
      assert.ok(tabs.has(name));
      runs.push(name);
      return { displays: [], screenshots: [], returnValue: undefined, url: tabs.get(name)?.url ?? "about:blank" };
    },
    async status() {
      return { bridge: { serverStarted: false, state: "disconnected", listeningPort: null, authenticatedConnected: false,
        authMode: "paired", transportConnected: false, transportReady: false, serverInstanceId: null,
        connectionGeneration: null, tabCount: 0, pendingPairings: [], drainingCommands: 0 },
        namedTabs: [...tabs.keys()].map((name) => ({ name, channel: "managed", ownership: "owned", capabilities: { page: true, cdp: true, cookies: true } })) };
    },
    async startVideo(name, cwd, options) {
      assert.ok(tabs.has(name));
      return { path: `${cwd}/${options.filename ?? "video.webm"}`, mimeType: "video/webm", recording: true };
    },
    async stopVideo(name) {
      assert.ok(tabs.has(name));
      return { path: "video.webm", mimeType: "video/webm", recording: false, bytes: 12 };
    },
    async videoChapter(name) { assert.ok(tabs.has(name)); },
    async videoShowActions(name) { assert.ok(tabs.has(name)); },
    async videoHideActions(name) { assert.ok(tabs.has(name)); },
    async pick() { return { captures: [], status: "escape", errorCount: 0 }; },
    async pair(requestId) { return { requestId, port: 19222, installationId: "fake" }; },
    async close(name) { return tabs.delete(name); },
    async closeAll() { const count = tabs.size; tabs.clear(); return count; },
  };
  return { manager, tabs, runs };
}

const context = (id?: string) => ({ cwd: process.cwd(), sessionManager: { getSessionId: () => id } }) as unknown as ExtensionContext;
const invoke = (tool: ReturnType<typeof createBrowserTool>, ctx: ExtensionContext, params: Record<string, unknown>) =>
  tool.execute("call", params as never, new AbortController().signal, undefined, ctx);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("default browser tools route trusted sessions, preserve names across turns, and close/status only their scope", async (t) => {
  const a = fakeManager();
  const b = fakeManager();
  const idA = "browser-test-a";
  const idB = "browser-test-b";
  for (const [id, fake] of [[idA, a], [idB, b]] as const) {
    const scope = browserSessionScopes.forSession(id);
    for (const method of ["open", "run", "pick", "pair", "status", "close", "closeAll", "startVideo", "stopVideo", "videoChapter", "videoShowActions", "videoHideActions"] as const) {
      t.mock.method(scope.manager, method, fake.manager[method]);
    }
  }
  t.after(async () => { await browserSessionScopes.closeSession(idA); await browserSessionScopes.closeSession(idB); });
  const first = createBrowserTool();
  const nextTurn = createBrowserTool();
  await invoke(first, context(idA), { action: "open", url: "https://a.example" });
  await invoke(first, context(idB), { action: "open", url: "https://b.example" });
  const reused = await invoke(nextTurn, context(idA), { action: "open", url: "https://a.example" });
  assert.match(reused.details?.result ?? "", /Reused/);
  await invoke(nextTurn, context(idA), { action: "run", code: "return 1" });
  await invoke(first, context(idB), { action: "run", code: "return 2" });
  assert.deepEqual(a.runs, ["main"]);
  assert.deepEqual(b.runs, ["main"]);
  assert.notEqual(a.tabs.get("main")?.isolationKey, b.tabs.get("main")?.isolationKey);
  assert.equal(canonicalizeBrowserOpenOptions(a.tabs.get("main")!).isolationKey, browserSessionScopes.forSession(idA).isolationKey);
  await invoke(first, context(idB), { action: "open", name: "b-only" });
  assert.deepEqual((await invoke(nextTurn, context(idA), { action: "status" })).details?.status?.namedTabs.map((tab) => tab.name), ["main"]);
  await invoke(nextTurn, context(idA), { action: "close", all: true });
  assert.equal(a.tabs.size, 0);
  assert.equal(b.tabs.size, 2);
  const video = await invoke(nextTurn, context(idB), { action: "start_video", name: "b-only", filename: "demo.webm" });
  assert.equal(video.details?.video?.recording, true);
  await assert.rejects(invoke(nextTurn, context(idA), { action: "stop_video", name: "b-only" }));
  for (const action of ["video_chapter", "video_show_actions", "video_hide_actions"]) {
    await invoke(first, context(idB), { action, name: "b-only", title: "Chapter" });
    await assert.rejects(invoke(first, context(idA), { action, name: "b-only", title: "Chapter" }));
  }
  const stopped = await invoke(first, context(idB), { action: "stop_video", name: "b-only" });
  assert.equal(stopped.details?.video?.bytes, 12);
  await invoke(first, context(idB), { action: "close" });
  assert.equal(b.tabs.has("b-only"), true);
});

test("SOP read state follows host session, while absent or invalidated identity fails closed except guide", async (t) => {
  const id = "browser-test-sop";
  const otherId = "browser-test-sop-other";
  const fake = fakeManager();
  for (const sessionId of [id, otherId]) t.mock.method(browserSessionScopes.forSession(sessionId).manager, "open", fake.manager.open);
  t.after(async () => { await browserSessionScopes.closeSession(id); await browserSessionScopes.closeSession(otherId); });
  await invoke(createBrowserTool(), context(id), { action: "guide", topic: "core" });
  assert.doesNotMatch((await invoke(createBrowserTool(), context(id), { action: "open" })).details?.result ?? "", /SOP registry not read/);
  assert.match((await invoke(createBrowserTool(), context(otherId), { action: "open" })).details?.result ?? "", /SOP registry not read/);
  const missing = context();
  for (const action of ["open", "status", "run", "pick", "pair", "close", "start_video", "stop_video", "video_chapter", "video_show_actions", "video_hide_actions"]) {
    await assert.rejects(invoke(createBrowserTool(), missing, { action, all: true, code: "123456", request_id: "request" }), /trusted host session identity/);
  }
  await assert.doesNotReject(invoke(createBrowserTool(), missing, { action: "guide", topic: "core" }));
  const invalid = { sessionManager: { getSessionId() { throw new Error("invalidated"); } } };
  assert.equal(browserHostSessionId(invalid), undefined);
  assert.equal(browserHostSessionId(context("  ")), undefined);
  assert.equal(await browserSessionScopes.closeSession(undefined), 0);
});

test("explicit manager injection retains actor/test authority even when the host session changes", async () => {
  const fake = fakeManager();
  const tool = createBrowserTool(fake.manager);
  await invoke(tool, context("host-a"), { action: "open" });
  await invoke(tool, context("host-b"), { action: "run", code: "return 1" });
  assert.deepEqual(fake.runs, ["main"]);
  assert.equal(fake.tabs.get("main")?.isolationKey, undefined);
  await invoke(tool, context(), { action: "close", all: true });
  assert.equal(fake.tabs.size, 0);
});

test("a stale scoped picker cannot paste into a replacement session editor", async (t) => {
  const id = "browser-test-picker";
  const scope = browserSessionScopes.forSession(id);
  let liveId = id;
  const pasted: string[] = [];
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => liveId },
    ui: { pasteToEditor: (text: string) => pasted.push(text) } } as unknown as ExtensionContext;
  t.mock.method(scope.manager, "pick", async (_name, onCapture) => {
    liveId = "replacement-session";
    onCapture?.([{ kind: "console", errors: ["old session"] }]);
    return { captures: [], status: "closed", errorCount: 0 };
  });
  await invoke(createBrowserTool(), ctx, { action: "pick" });
  assert.deepEqual(pasted, []);
  await browserSessionScopes.closeSession(id);
});

test("scoped cleanup fences admission and retains draining ownership without touching another session", async () => {
  const a = fakeManager();
  const b = fakeManager();
  const pending = deferred<number>();
  a.manager.closeAll = () => pending.promise;
  const managers = [a.manager, b.manager];
  const scopes = new BrowserSessionScopes(() => managers.shift()!);
  const old = scopes.forSession("a");
  const other = scopes.forSession("b");
  const cleanup = scopes.closeSession("a");
  assert.equal(scopes.closeSession("a"), cleanup);
  assert.throws(() => scopes.forSession("a"), /shutting down/);
  assert.equal(scopes.forSession("b"), other);
  pending.resolve(1);
  assert.equal(await cleanup, 1);
  managers.push(fakeManager().manager);
  assert.notEqual(scopes.forSession("a"), old);
  await scopes.closeSession("a");
  await scopes.closeSession("b");
});

test("failed cleanup retains the fenced scope and can be retried without abandoning its resources", async () => {
  const fake = fakeManager();
  const pending = deferred<number>();
  fake.manager.closeAll = () => pending.promise;
  let creations = 0;
  const scopes = new BrowserSessionScopes(() => { creations++; return fake.manager; });
  scopes.forSession("a");
  const cleanup = scopes.closeSession("a");
  pending.reject(new Error("cleanup failed"));
  await assert.rejects(cleanup, /cleanup failed/);
  assert.throws(() => scopes.forSession("a"), /shutting down/);
  assert.equal(creations, 1);
  fake.manager.closeAll = async () => 0;
  await scopes.closeSession("a");
  scopes.forSession("a");
  assert.equal(creations, 2);
});

test("default intelligence shutdown captures/fences only its session, does not stop the shared bridge, and retains timed-out cleanup", async (t) => {
  t.mock.method(lspManager, "shutdown", async () => {});
  t.mock.method(computerUseManager, "shutdown", async () => {});
  const bridgeShutdown = t.mock.method(browserBridge, "shutdown", async () => {});
  const a = browserSessionScopes.forSession("browser-test-shutdown-a");
  const b = browserSessionScopes.forSession("browser-test-shutdown-b");
  const pending = deferred<number>();
  const pendingB = deferred<Awaited<ReturnType<BrowserManagerLike["run"]>>>();
  t.mock.method(a.manager, "closeAll", () => pending.promise);
  const closeB = t.mock.method(b.manager, "closeAll", async () => 0);
  t.mock.method(b.manager, "run", () => pendingB.promise);
  const runB = invoke(createBrowserTool(), context("browser-test-shutdown-b"), { action: "run", code: "return 1" });
  const cleanup = shutdownIntelligenceTools(undefined, 10, "browser-test-shutdown-a");
  assert.throws(() => browserSessionScopes.forSession("browser-test-shutdown-a"), /shutting down/);
  await cleanup;
  assert.equal(closeB.mock.callCount(), 0);
  assert.equal(bridgeShutdown.mock.callCount(), 0);
  assert.equal(browserSessionScopes.forSession("browser-test-shutdown-b"), b);
  assert.throws(() => browserSessionScopes.forSession("browser-test-shutdown-a"), /shutting down/);
  pendingB.resolve({ displays: [], screenshots: [], returnValue: 1, url: "https://b.example" });
  assert.equal((await runB).details?.url, "https://b.example", "another scope's in-flight operation survives cleanup");
  pending.resolve(0);
  await browserSessionScopes.closeSession("browser-test-shutdown-a");
  await shutdownIntelligenceTools(undefined, 100, "browser-test-shutdown-b");
  assert.equal(bridgeShutdown.mock.callCount(), 0, "even the last root scope cannot prove Gateway/actor bridge ownership is idle");
  await shutdownIntelligenceTools(undefined, 100);
  assert.equal(bridgeShutdown.mock.callCount(), 0, "missing identity is not a process-wide shutdown grant");
});

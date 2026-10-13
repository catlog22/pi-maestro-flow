import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { installRequestListenerScope } from "../src/tools/browser/manager.ts";

type Handler = (request: HTTPRequest) => unknown;

function requestPage() {
  const handlers: Handler[] = [];
  const page = {
    on(_type: string, handler: Handler) { handlers.push(handler); return this; },
    off(_type: string, handler?: Handler) {
      if (!handler) handlers.length = 0;
      else {
        const index = handlers.lastIndexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      }
      return this;
    },
    once(type: string, handler: Handler) {
      const onceHandler: Handler = (request) => { handler(request); this.off(type, onceHandler); };
      return this.on(type, onceHandler);
    },
  } as unknown as Page;
  // Page.on queues interception actions before HTTPRequest.finalizeInterceptions invokes them.
  const enqueue = (request: HTTPRequest) => handlers.map((handler) => () => handler(request));
  return { page, handlers, enqueue };
}

function requestWith(actions: Partial<Pick<HTTPRequest, "continue" | "abort" | "respond">> = {}): HTTPRequest {
  return {
    continue: async () => {},
    abort: async () => {},
    respond: async () => {},
    ...actions,
  } as unknown as HTTPRequest;
}

for (const event of ["dialog", "console", "targetcreated"] as const) {
  for (const once of [false, true]) {
    test(`browser event scope contains sync/async ${once ? "once" : "on"} ${event} failures`, async () => {
      for (const asyncHandler of [false, true]) {
        const page = new EventEmitter() as unknown as Page;
        const browser = new EventEmitter() as unknown as Browser;
        const scope = installRequestListenerScope(page, browser);
        const emitter = event === "targetcreated" ? browser : page;
        const failure = new Error("event callback failed");
        const handler = asyncHandler ? async () => { throw failure; } : () => { throw failure; };
        emitter[once ? "once" : "on"](event as never, handler);
        assert.doesNotThrow(() => emitter.emit(event as never, { accept() {}, dismiss() {} } as never));
        assert.equal(await scope.failure, failure);
        assert.equal(scope.failedEvent, `${event === "targetcreated" ? "browser" : "page"}.${event}`);
        await assert.rejects(scope.settle(), (error) => error === failure);
        scope.cleanup();
      }
    });
  }
}

for (const method of ["accept", "dismiss"] as const) {
  test(`dialog scope contains fire-and-forget ${method} protocol failure and fences late actions`, async () => {
    const page = new EventEmitter() as unknown as Page;
    const scope = installRequestListenerScope(page);
    const failure = new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
    let calls = 0;
    const dialog = {
      accept: async () => { calls++; throw failure; },
      dismiss: async () => { calls++; throw failure; },
    };
    page.on("dialog", (received) => {
      assert.equal(received, dialog);
      void received[method]();
    });
    page.emit("dialog", dialog as never);
    assert.equal(await scope.failure, failure);
    await assert.rejects(scope.settle(), (error) => error === failure);
    scope.cleanup();
    await assert.rejects(dialog[method](), /finished run/);
    assert.equal(calls, 1);
  });
}

test("browser event scope drains pending callbacks and removes only run listeners", async () => {
  const rawPage = new EventEmitter();
  const rawBrowser = new EventEmitter();
  const page = rawPage as unknown as Page;
  const browser = rawBrowser as unknown as Browser;
  const external = () => {};
  page.on("console", external);
  const original = { on: page.on, off: page.off, once: page.once, browserOn: browser.on };
  const scope = installRequestListenerScope(page, browser);
  let release!: () => void;
  page.on("console", () => new Promise<void>((resolve) => { release = resolve; }));
  page.emit("console", {} as never);
  let settled = false;
  const drain = scope.settle().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await drain;
  let calls = 0;
  const handler = () => { calls++; };
  page.on("console", handler);
  page.on("close", handler);
  page.off("console", handler);
  page.once("close", () => { calls++; page.emit("close", undefined); });
  page.emit("close", undefined);
  await scope.settle();
  assert.equal(calls, 3, "once is removed before reentrant emission; off stays event-specific");
  browser.on("targetcreated", handler);
  const queued = rawBrowser.listeners("targetcreated")[0]!;
  scope.cleanup();
  queued({});
  assert.equal(calls, 3);
  assert.deepEqual(rawPage.listeners("console"), [external]);
  assert.equal(page.listenerCount("close"), 0);
  assert.equal(browser.listenerCount("targetcreated"), 0);
  assert.equal(page.on, original.on);
  assert.equal(page.off, original.off);
  assert.equal(page.once, original.once);
  assert.equal(browser.on, original.browserOn);
});

test("request scope fences callbacks queued before cleanup and restores page methods", async () => {
  const { page, handlers, enqueue } = requestPage();
  const original = { on: page.on, off: page.off, once: page.once };
  const external = () => {};
  page.on("request", external);
  const scope = installRequestListenerScope(page);
  let calls = 0;
  page.on("request", () => { calls += 1; });
  const queued = enqueue(requestWith());
  scope.cleanup();
  scope.cleanup();
  await Promise.all(queued.map((invoke) => invoke()));
  assert.equal(calls, 0);
  assert.deepEqual(handlers, [external]);
  assert.equal(page.on, original.on);
  assert.equal(page.off, original.off);
  assert.equal(page.once, original.once);
});

test("request scope preserves duplicate on/off and once registration", async () => {
  const { page, handlers, enqueue } = requestPage();
  const scope = installRequestListenerScope(page);
  let calls = 0;
  let onceCalls = 0;
  const handler = () => { calls += 1; };
  page.on("request", handler);
  page.on("request", handler);
  page.off("request", handler);
  page.once("request", async () => { onceCalls += 1; });
  assert.equal(handlers.length, 2);
  for (const invoke of enqueue(requestWith())) await invoke();
  for (const invoke of enqueue(requestWith())) await invoke();
  await scope.settle();
  assert.equal(calls, 2);
  assert.equal(onceCalls, 1);
  assert.equal(handlers.length, 1);
  scope.cleanup();
  assert.equal(handlers.length, 0);
});

for (const method of ["continue", "abort", "respond"] as const) {
  test(`request scope reports fire-and-forget ${method} rejection without leaking it`, async () => {
    const { page, enqueue } = requestPage();
    const scope = installRequestListenerScope(page);
    const failure = new Error("Request Interception is not enabled!");
    const request = requestWith({ [method]: async () => { throw failure; } });
    page.on("request", (received) => {
      assert.equal(received, request, "request identity must be preserved");
      if (method === "respond") void received.respond({ status: 200 });
      else if (method === "abort") void received.abort();
      else void received.continue();
    });
    for (const invoke of enqueue(request)) await invoke();
    assert.equal(await scope.failure, failure);
    await assert.rejects(scope.settle(), (error) => error === failure);
    scope.cleanup();
  });
}

for (const once of [false, true]) {
  test(`request scope contains async ${once ? "once" : "on"} handler failures`, async () => {
    const { page, enqueue } = requestPage();
    const scope = installRequestListenerScope(page);
    const failure = new Error("request callback failed");
    page[once ? "once" : "on"]("request", async () => { throw failure; });
    for (const invoke of enqueue(requestWith())) await invoke();
    assert.equal(await scope.failure, failure);
    await assert.rejects(scope.settle(), (error) => error === failure);
    scope.cleanup();
  });
}

test("request scope settles unawaited resolutions before disabling interception", async () => {
  const { page, enqueue } = requestPage();
  const scope = installRequestListenerScope(page);
  let finish!: () => void;
  const request = requestWith({ continue: () => new Promise<void>((resolve) => { finish = resolve; }) });
  page.on("request", (received) => { void received.continue(); });
  for (const invoke of enqueue(request)) await invoke();
  let settled = false;
  const drain = scope.settle().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  finish();
  await drain;
  assert.equal(settled, true);
  scope.cleanup();
});

test("request scope prevents a delayed resolution from acting after cleanup", async () => {
  const { page, enqueue } = requestPage();
  const scope = installRequestListenerScope(page);
  let calls = 0;
  const request = requestWith({ continue: async () => { calls += 1; } });
  page.on("request", () => {});
  for (const invoke of enqueue(request)) await invoke();
  await scope.settle();
  scope.cleanup();
  await assert.rejects(request.continue(), /finished run/);
  assert.equal(calls, 0);
});

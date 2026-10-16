import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import puppeteer, { type Browser, type ScreencastOptions } from "puppeteer-core";
import { BrowserManager } from "../src/tools/browser/manager.ts";
import { BrowserVideoRecording, type BrowserScreencastOptions, type BrowserVideoPage, type BrowserVideoOptions } from "../src/tools/browser/video.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

class Recorder extends PassThrough {
  stops = 0;
  async stop() { this.stops++; this.end("webm-test-frames"); }
}

class PageStub extends EventEmitter {
  closed = false;
  location = "https://video.example/";
  recorder = new Recorder();
  startGate?: Promise<void>;
  options?: ScreencastOptions;
  isClosed() { return this.closed; }
  url() { return this.location; }
  async title() { return "Video"; }
  viewport() { return { width: 800, height: 600 }; }
  async goto(url: string) { this.location = url; }
  async setRequestInterception() {}
  readonly session = Object.assign(new EventEmitter(), {
    connection: () => ({}), send: async () => ({}), detach: async () => {},
  });
  readonly pageTarget = { createCDPSession: async () => this.session };
  target() { return this.pageTarget; }
  async screencast(options: ScreencastOptions) {
    this.options = options;
    await this.startGate;
    return this.recorder;
  }
}

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-video-manager-"));
  const page = new PageStub();
  let disconnected = false;
  const browser = Object.assign(new EventEmitter(), {
    connected: true, pages: async () => [page],
    disconnect: () => { disconnected = true; },
  });
  t.mock.method(puppeteer, "connect", async () => browser as unknown as Browser);
  const nativeStart = BrowserVideoRecording.start;
  const recordingPages = [page];
  let capture = 0;
  t.mock.method(BrowserVideoRecording, "start", (_adapter: BrowserVideoPage, cwd: string, options?: BrowserVideoOptions) => nativeStart(recordingPages[capture++] ?? page, cwd, options));
  const manager = new BrowserManager();
  t.after(async () => { await manager.closeAll(); await fs.rm(directory, { recursive: true, force: true }); });
  await manager.open({ name: "demo", cwd: directory, cdpUrl: "http://localhost:9222", timeoutMs: 1000 });
  return { manager, page, browser, directory, recordingPages, disconnected: () => disconnected };
}

test("browser video persists across runs/navigation and close joins the recorder without deleting the artifact", async (t) => {
  const { manager, page, directory, disconnected } = await fixture(t);
  const started = await manager.startVideo("demo", directory, { filename: "demo.webm", fps: 20 }, undefined, 1000);
  assert.equal(started.recording, true);
  await assert.rejects(manager.startVideo("demo", directory, {}, undefined, 1000), /already recording/);
  const first = await manager.run("demo", "return page.url();", directory, undefined, 1000);
  assert.equal(first.returnValue, "https://video.example/");
  const second = await manager.run("demo", "await page.goto('https://video.example/next'); return page.url();", directory, undefined, 1000);
  assert.equal(second.navigated, true);
  assert.equal(page.recorder.stops, 0);
  await manager.close("demo");
  assert.equal(page.recorder.stops, 1);
  assert.equal(disconnected(), true);
  assert.equal(page.closed, false, "borrowed tab is not closed");
  assert.equal(await fs.readFile(started.path, "utf8"), "webm-test-frames");
});

test("browser video explicit stop flushes metadata, permits another recording and closeAll finalizes it", async (t) => {
  const { manager, page, directory } = await fixture(t);
  await manager.startVideo("demo", directory, { filename: "first.webm" }, undefined, 1000);
  const stopped = await manager.stopVideo("demo", undefined, 1000);
  assert.ok(stopped);
  assert.equal(stopped.recording, false);
  assert.equal(stopped.bytes, 16);
  assert.equal(await manager.stopVideo("demo", undefined, 1000), undefined);
  page.recorder = new Recorder();
  const next = await manager.startVideo("demo", directory, { filename: "second.webm" }, undefined, 1000);
  await manager.closeAll();
  assert.equal(page.recorder.stops, 1);
  assert.equal((await fs.stat(next.path)).size, 16);
});

test("browser video aborted start is drained and stopped before the tab is reusable", async (t) => {
  const { manager, page, directory } = await fixture(t);
  const started = gate();
  page.startGate = started.promise;
  const controller = new AbortController();
  const operation = manager.startVideo("demo", directory, { filename: "abort.webm" }, controller.signal, 1000);
  controller.abort();
  await assert.rejects(manager.run("demo", "return true;", directory, undefined, 1000), /busy/);
  started.resolve();
  await assert.rejects(operation, { name: "AbortError" });
  assert.equal(page.recorder.stops, 1);
  assert.equal(await manager.stopVideo("demo", undefined, 1000), undefined);
  assert.equal((await manager.run("demo", "return true;", directory, undefined, 1000)).returnValue, true);
});

test("browser video timeout drains a late recorder, and close during start cannot leave an active encoder", async (t) => {
  const { manager, page, directory } = await fixture(t);
  const delayed = gate();
  page.startGate = delayed.promise;
  const operation = manager.startVideo("demo", directory, { filename: "late.webm" }, undefined, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(manager.run("demo", "return true;", directory, undefined, 1000), /busy/);
  delayed.resolve();
  await assert.rejects(operation, /timed out/);
  assert.equal(page.recorder.stops, 1);
  page.recorder = new Recorder();
  const pending = gate();
  page.startGate = pending.promise;
  const start = manager.startVideo("demo", directory, { filename: "closing.webm" }, undefined, 1000);
  const closing = manager.close("demo");
  pending.resolve();
  await assert.rejects(start, { name: "AbortError" });
  assert.equal(await closing, true);
  assert.equal(page.recorder.stops, 1);
});

for (const trigger of ["page-close", "browser-disconnect", "explicit-close"] as const) {
  test(`browser video closeAll joins an already-retiring entry after ${trigger}`, async (t) => {
    const { manager, page, browser, directory } = await fixture(t);
    const stopping = gate();
    const finish = gate();
    t.mock.method(page.recorder, "stop", async () => {
      stopping.resolve();
      await finish.promise;
      page.recorder.end("webm-test-frames");
    });
    const video = await manager.startVideo("demo", directory, { filename: "retiring.webm" }, undefined, 1000);
    let explicit: Promise<boolean> | undefined;
    if (trigger === "page-close") { page.closed = true; page.emit("close"); }
    else if (trigger === "browser-disconnect") browser.emit("disconnected");
    else explicit = manager.close("demo");
    await stopping.promise;
    assert.equal(manager.has("demo"), false);
    let closed = false;
    const cleanup = manager.closeAll().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "shutdown must join the detached entry's encoder and file flush");
    finish.resolve();
    await cleanup;
    await explicit;
    assert.equal((await fs.stat(video.path)).size, 16);
  });
}

test("browser video interrupted stop keeps finalization owned until closeAll joins it", async (t) => {
  const { manager, page, directory } = await fixture(t);
  const finish = gate();
  t.mock.method(page.recorder, "stop", async () => {
    await finish.promise;
    page.recorder.end("webm-test-frames");
  });
  const video = await manager.startVideo("demo", directory, {}, undefined, 1000);
  await assert.rejects(manager.stopVideo("demo", undefined, 10), /timed out/);
  await assert.rejects(manager.run("demo", "return true;", directory, undefined, 1000), /busy/);
  const cleanup = manager.closeAll();
  finish.resolve();
  await cleanup;
  assert.equal((await fs.stat(video.path)).size, 16);
});

for (const interruption of ["abort", "timeout"] as const) {
  test(`child video startup shares the whole start_video ${interruption} boundary`, { timeout: 2000 }, async (t) => {
    const { manager, browser, directory, recordingPages } = await fixture(t);
    const child = new PageStub();
    recordingPages.push(child);
    Object.assign(browser, { newPage: async () => child });
    await manager.run("demo", "await browser.newPage();", directory, undefined, 1000);
    const entered = gate();
    child.screencast = async (options: BrowserScreencastOptions) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        const signal = options.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (signal.aborted) reject(signal.reason);
      });
      return child.recorder;
    };
    const controller = new AbortController();
    const starting = manager.startVideo("demo", directory, {}, controller.signal, interruption === "timeout" ? 30 : 1000);
    const rejected = assert.rejects(starting, interruption === "abort" ? { name: "AbortError" } : /timed out/);
    await entered.promise;
    if (interruption === "abort") controller.abort();
    await rejected;
    assert.equal(await manager.stopVideo("demo", undefined, 1000), undefined);
    await manager.closeAll();
  });
}

test("a proven popup created during primary encoder startup is admitted and recorded", async (t) => {
  const { manager, page, browser, directory, recordingPages } = await fixture(t);
  const starting = gate();
  page.startGate = starting.promise;
  const popup = new PageStub();
  recordingPages.push(popup);
  const operation = manager.startVideo("demo", directory, {}, undefined, 1000);
  browser.emit("targetcreated", { type: () => "page", opener: () => page.target(), page: async () => popup });
  starting.resolve();
  await operation;
  const result = await manager.stopVideo("demo", undefined, 1000);
  assert.equal(result?.videos?.length, 2);
  assert.equal(popup.recorder.stops, 1);
});

test("a pending popup Page acquisition cannot hold an aborted start or capture after shutdown", { timeout: 2000 }, async (t) => {
  const { manager, page, browser, directory, recordingPages } = await fixture(t);
  const popup = new PageStub();
  recordingPages.push(popup);
  let release!: (page: PageStub) => void;
  const acquiring = new Promise<PageStub>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const starting = manager.startVideo("demo", directory, {}, controller.signal, 1000);
  const rejected = assert.rejects(starting, { name: "AbortError" });
  browser.emit("targetcreated", { type: () => "page", opener: () => page.target(), page: () => acquiring });
  controller.abort();
  await rejected;
  await manager.closeAll();
  release(popup);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(popup.recorder.stops, 0, "late acquisition never begins a new recording");
});

test("browser video requires an open name and rejects already-aborted admission", async () => {
  const manager = new BrowserManager();
  await assert.rejects(manager.startVideo("missing", process.cwd(), {}, undefined, 1000), /Open it first/);
  assert.equal(await manager.stopVideo("missing", undefined, 1000), undefined);
  await assert.rejects(manager.startVideo("missing", process.cwd(), {}, AbortSignal.abort(), 1000), { name: "AbortError" });
});

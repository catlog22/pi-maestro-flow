import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { BrowserParams, createBrowserTool } from "../src/tools/browser-tool.ts";
import { BrowserManager, type BrowserManagerLike, type BrowserOpenOptions, type BrowserRunOutput, type BrowserTabInfo } from "../src/tools/browser/manager.ts";

class FakeBrowserManager implements BrowserManagerLike {
  opened?: BrowserOpenOptions;
  runs: Array<{ name: string; code: string; cwd: string; timeoutMs: number }> = [];
  closed: string[] = [];
  closeAllCount = 2;
  abortRun = false;

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    this.opened = options;
    return { name: options.name, kind: options.cdpUrl ? "connected" : "headless", url: options.url ?? "about:blank", title: "Example", reused: false, viewport: { width: 1000, height: 700 } };
  }
  async run(name: string, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserRunOutput> {
    if (this.abortRun || signal?.aborted) {
      const error = new Error("aborted"); error.name = "AbortError"; throw error;
    }
    this.runs.push({ name, code, cwd, timeoutMs });
    return {
      displays: [{ type: "text", text: "observed 3 elements" }, { type: "image", data: "cG5n", mimeType: "image/png" }],
      returnValue: { ok: true },
      screenshots: [{ path: "shot.png", mimeType: "image/png", bytes: 3 }],
      url: "https://example.com",
    };
  }
  async close(name: string): Promise<boolean> { this.closed.push(name); return true; }
  async closeAll(): Promise<number> { return this.closeAllCount; }
}

test("browser schema preserves open/run/close and full control inputs", () => {
  assert.deepEqual((BrowserParams.properties.action as { enum: string[] }).enum, ["open", "close", "run"]);
  assert.deepEqual(Object.keys(BrowserParams.properties).sort(), [
    "action", "all", "app", "code", "dialogs", "kill", "name", "timeout", "url", "viewport", "wait_until",
  ]);
});

test("browser tool forwards named-tab open options and returns run displays, images, and screenshots", async () => {
  const manager = new FakeBrowserManager();
  const tool = createBrowserTool(manager);
  const ctx = { cwd: "D:/workspace" } as never;
  const opened = await tool.execute("open", {
    action: "open", name: "docs", url: "https://example.com", app: { cdp_url: "http://127.0.0.1:9222" },
    viewport: { width: 1000, height: 700, scale: 1 }, wait_until: "domcontentloaded", dialogs: "dismiss",
  }, undefined, undefined, ctx);
  assert.equal(opened.details?.browser, "connected");
  assert.equal(manager.opened?.name, "docs");
  assert.equal(manager.opened?.waitUntil, "domcontentloaded");

  const run = await tool.execute("run", { action: "run", name: "docs", code: "return await tab.observe();", timeout: 5 }, undefined, undefined, ctx);
  assert.equal(run.isError, undefined);
  assert.equal(run.content.some((item) => item.type === "image"), true);
  assert.deepEqual(run.details?.screenshots, [{ path: "shot.png", mimeType: "image/png", bytes: 3 }]);
  assert.equal(manager.runs[0]?.timeoutMs, 5_000);
});

test("browser close supports one tab and all tabs, while run validates code and propagates abort", async () => {
  const manager = new FakeBrowserManager();
  const tool = createBrowserTool(manager);
  const ctx = { cwd: "D:/workspace" } as never;
  assert.equal((await tool.execute("close", { action: "close", name: "docs" }, undefined, undefined, ctx)).details?.result, "Closed tab \"docs\".");
  assert.equal((await tool.execute("close-all", { action: "close", all: true }, undefined, undefined, ctx)).details?.result, "Closed 2 browser tabs.");
  await assert.rejects(() => tool.execute("empty", { action: "run", code: "   " }, undefined, undefined, ctx), /non-empty code/);
  manager.abortRun = true;
  await assert.rejects(() => tool.execute("abort", { action: "run", code: "await wait(1000)" }, undefined, undefined, ctx), { name: "AbortError" });
});

test("browser manager drives a real local Chromium tab when an executable is available", async (t) => {
  const manager = new BrowserManager();
  const openOptions = {
    name: "live",
    cwd: process.cwd(),
    url: "data:text/html,<title>Smoke</title><input id='name'><button id='save'>Save</button>",
    viewport: { width: 800, height: 600 },
    timeoutMs: 15_000,
  } as const;
  try {
    const opened = await Promise.all([manager.open(openOptions), manager.open(openOptions)]);
    assert.deepEqual(opened.map((item) => item.reused).sort(), [false, true]);
  } catch (error) {
    if (error instanceof Error && /No Chromium browser found/.test(error.message)) {
      t.skip("No local Chromium executable is available.");
      return;
    }
    throw error;
  }
  try {
    const output = await manager.run("live", `
      const observed = await tab.observe();
      assert(observed.elements.some(element => element.name === 'Save'), 'button missing');
      await tab.waitForUrl(/SMOKE/i);
      await tab.fill('#name', 'Ada');
      const value = await tab.evaluate(() => document.querySelector('#name').value);
      const shot = await tab.screenshot({ silent: true });
      return { value, shot };
    `, process.cwd(), undefined, 15_000);
    assert.equal((output.returnValue as { value: string }).value, "Ada");
    assert.equal(output.screenshots.length, 1);
    const screenshotPath = output.screenshots[0]?.path;
    assert.ok(screenshotPath);
    assert.equal(await fs.stat(screenshotPath).then(() => true, () => false), true);
    await manager.run("live", "await page.close(); return true;", process.cwd(), undefined, 15_000);
    for (let attempt = 0; attempt < 20 && manager.has("live"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.has("live"), false);
    for (let attempt = 0; attempt < 300 && await fs.stat(screenshotPath).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await fs.stat(screenshotPath).then(() => true, () => false), false);
    await manager.open({ name: "live", cwd: process.cwd(), url: "data:text/html,<title>Reopened</title>", timeoutMs: 15_000 });
    assert.equal(await manager.close("live"), true);
  } finally {
    await manager.close("live");
  }
});

test("browser manager aborts a live run and tears down the named tab", async (t) => {
  const manager = new BrowserManager();
  try {
    await manager.open({ name: "abort", cwd: process.cwd(), url: "data:text/html,<title>Abort</title>", timeoutMs: 15_000 });
  } catch (error) {
    if (error instanceof Error && /No Chromium browser found/.test(error.message)) { t.skip("No local Chromium executable is available."); return; }
    throw error;
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => manager.run("abort", "await wait(10000)", process.cwd(), controller.signal, 15_000), { name: "AbortError" });
  assert.equal(manager.has("abort"), false);
});

test("browser manager fails closed when an explicit target does not match", async (t) => {
  const manager = new BrowserManager();
  try {
    await assert.rejects(() => manager.open({ name: "target", cwd: process.cwd(), target: "definitely-missing-target", timeoutMs: 15_000 }), /No browser page matched target/);
  } catch (error) {
    if (error instanceof Error && /No Chromium browser found/.test(error.message)) { t.skip("No local Chromium executable is available."); return; }
    throw error;
  } finally {
    await manager.closeAll();
  }
});

test("browser CDP connect obeys AbortSignal while endpoint discovery is stalled", async () => {
  const server = http.createServer((_request, _response) => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const manager = new BrowserManager();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  try {
    await assert.rejects(() => manager.open({
      name: "cdp-abort",
      cwd: process.cwd(),
      cdpUrl: `http://127.0.0.1:${address.port}`,
      signal: controller.signal,
      timeoutMs: 5_000,
    }), { name: "AbortError" });
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await manager.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("browser closeAll cancels an in-flight open before it can register a tab", async () => {
  const server = http.createServer((_request, _response) => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const manager = new BrowserManager();
  const opening = manager.open({
    name: "pending",
    cwd: process.cwd(),
    cdpUrl: `http://127.0.0.1:${address.port}`,
    timeoutMs: 5_000,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = manager.closeAll();
    await assert.rejects(opening, { name: "AbortError" });
    assert.equal(await closed, 0);
    assert.equal(manager.has("pending"), false);
  } finally {
    await manager.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

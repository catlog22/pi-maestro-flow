import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { BrowserParams, createBrowserTool } from "../src/tools/browser-tool.ts";
import { BrowserManager, browserRunErrorHint, compileRunCode, type BrowserManagerLike, type BrowserOpenOptions, type BrowserRunOutput, type BrowserTabInfo } from "../src/tools/browser/manager.ts";

class FakeBrowserManager implements BrowserManagerLike {
  opened?: BrowserOpenOptions;
  runs: Array<{ name: string; code: string; cwd: string; timeoutMs: number }> = [];
  closed: string[] = [];
  closeAllCount = 2;
  abortRun = false;

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    this.opened = options;
    return { name: options.name, kind: options.cdpUrl ? "connected" : options.visible ? "headed" : "headless", url: options.url ?? "about:blank", title: "Example", reused: false, viewport: { width: 1000, height: 700 } };
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
    "action", "all", "app", "code", "dialogs", "kill", "name", "timeout", "url", "viewport", "visible", "wait_until",
  ]);
  assert.equal(Check(BrowserParams, { action: "open" }), true);
  assert.equal(Check(BrowserParams, { action: "close" }), true);
  assert.equal(Check(BrowserParams, { action: "run" }), false);
  assert.equal(Check(BrowserParams, { action: "run", code: "return true;" }), true);
  assert.equal(Check(BrowserParams, { action: "run", code: "" }), false);
});

test("browser tool guidelines expose probe/snapshot/diff/monitor helpers", async () => {
  const manager = new FakeBrowserManager();
  const tool = createBrowserTool(manager);
  const snippet = tool.promptSnippet ?? "";
  const guidelines = tool.promptGuidelines ?? [];
  const joined = [snippet, ...guidelines].join("\n");
  // Each new probe capability is mentioned in the agent-facing prompt surface.
  assert.match(joined, /extract\(['"]probe['"]\)/, "guidelines must mention extract('probe')");
  assert.match(joined, /tab\.snapshot\(\)/, "guidelines must mention tab.snapshot()");
  assert.match(joined, /tab\.diff\(/, "guidelines must mention tab.diff()");
  assert.match(joined, /monitorStart/, "guidelines must mention monitorStart");
  assert.match(joined, /monitorStop/, "guidelines must mention monitorStop");
  assert.match(joined, /tab\.tabs\(\)/, "guidelines must mention tab.tabs()");
  assert.match(joined, /navigated/, "guidelines must mention navigated detection");
  // Schema is unchanged: no new top-level action or param was added.
  assert.deepEqual(Object.keys(BrowserParams.properties).sort(), [
    "action", "all", "app", "code", "dialogs", "kill", "name", "timeout", "url", "viewport", "visible", "wait_until",
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

test("browser open forwards visible for a headed launch and reports the kind", async () => {
  const manager = new FakeBrowserManager();
  const tool = createBrowserTool(manager);
  const ctx = { cwd: "D:/workspace" } as never;
  const opened = await tool.execute("open", {
    action: "open", name: "ui", url: "https://example.com", visible: true,
  }, undefined, undefined, ctx);
  assert.equal(manager.opened?.visible, true);
  assert.equal(opened.details?.browser, "headed");
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

test("browser run error hints explain evaluate callback scoping", () => {
  const reference = browserRunErrorHint(new ReferenceError("clicked is not defined")) as Error;
  assert.equal(reference.name, "ReferenceError");
  assert.match(reference.message, /Browser run hint/);
  assert.match(reference.message, /`clicked` is referenced where it is not defined/);
  assert.match(reference.message, /page\.evaluate\(\)\/tab\.evaluate\(\) callbacks runs in the browser page context/);
  assert.match(reference.message, /Pass values explicitly: await tab\.evaluate\(\(v\) => …, v\)/);
  assert.match(reference.message, /tab\.click\(\)\/tab\.type\(\)\/tab\.fill\(\) return undefined/);
  // 其他 ReferenceError（非 "is not defined"）不加浏览器提示，保持原样。
  const other = browserRunErrorHint(new ReferenceError("Cannot read properties of null (reading 'x')")) as Error;
  assert.equal(other.message, "Cannot read properties of null (reading 'x')");
  // 语法错误附带解析提示。
  const syntax = browserRunErrorHint(new SyntaxError("Unexpected token 'x'")) as Error;
  assert.match(syntax.message, /Browser run hint: the run code failed to parse/);
  // 普通错误原样透传。
  const plain = new Error("boom");
  assert.equal(browserRunErrorHint(plain), plain);
});

test("compileRunCode surfaces ReferenceError with the undefined name", async () => {
  const execute = compileRunCode("return missingClicked;");
  await assert.rejects(() => execute(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined), /missingClicked is not defined/);
});

test("browser temporary screenshots use exclusive owner-only creation", async () => {
  const source = await fs.readFile(new URL("../src/tools/browser/manager.ts", import.meta.url), "utf8");
  assert.match(source, /flag:\s*options\?\.save\s*\?\s*"w"\s*:\s*"wx"/);
  assert.match(source, /mode:\s*options\?\.save\s*\?\s*0o666\s*:\s*0o600/);
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
    const collision = await manager.run("live", `
      const wait = "w"; const page = "p"; const assert = "a"; const display = "d";
      const print = "pr"; const signal = "s"; const console = "c"; const browser = "b";
      return { shadowed: [wait, page, assert, display, print, signal, console, browser].join(","), tabName: tab.name, ok: (await tab.observe()).elements.length >= 0 };
    `, process.cwd(), undefined, 15_000);
    const cv = collision.returnValue as { shadowed: string; tabName: string; ok: boolean };
    assert.equal(cv.shadowed, "w,p,a,d,pr,s,c,b");
    assert.equal(cv.tabName, "live");
    assert.equal(cv.ok, true);
    // Node-side variables are invisible inside evaluate callbacks (browser context);
    // the error must carry the scoping hint so the agent can self-correct.
    await assert.rejects(
      manager.run("live", `const clicked = "n"; return await tab.evaluate(() => clicked);`, process.cwd(), undefined, 15_000),
      (error) => error instanceof Error && /clicked is not defined/.test(error.message) && /Browser run hint/.test(error.message),
    );
    const screenshotPath = output.screenshots[0]?.path;
    assert.ok(screenshotPath);
    const screenshotStat = await fs.stat(screenshotPath);
    assert.equal(screenshotStat.isFile(), true);
    if (process.platform !== "win32") assert.equal(screenshotStat.mode & 0o777, 0o600);
    await manager.run("live", "await page.close(); return true;", process.cwd(), undefined, 15_000);
    for (let attempt = 0; attempt < 100 && manager.has("live"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.has("live"), false);
    for (let attempt = 0; attempt < 500 && await fs.stat(screenshotPath).then(() => true, () => false); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await fs.stat(screenshotPath).then(() => true, () => false), false);
    await manager.open({ name: "live", cwd: process.cwd(), url: "data:text/html,<title>Reopened</title>", timeoutMs: 15_000 });
    assert.equal(await manager.close("live"), true);

    // Probe helpers (ported from GenericAgent simphtml.py): extract('probe')
    // returns token-optimized simplified HTML, snapshot/diff detect changes,
    // monitorStart/Stop capture transient text.
    await manager.open({ name: "probe", cwd: process.cwd(), url: "data:text/html,<title>Probe</title><ul id='list'><li>Product 0: " + "x".repeat(210) + "</li><li>Product 1: " + "x".repeat(210) + "</li><li>Product 2: " + "x".repeat(210) + "</li><li>Product 3: " + "x".repeat(210) + "</li><li>Product 4: " + "x".repeat(210) + "</li><li>Product 5: target match</li><li>Product 6: " + "x".repeat(210) + "</li><li>Product 7: " + "x".repeat(210) + "</li><li>Product 8: " + "x".repeat(210) + "</li><li>Product 9: " + "x".repeat(210) + "</li><li>Product 10: " + "x".repeat(210) + "</li><li>Product 11: " + "x".repeat(210) + "</li></ul><button id='add'>Add</button>", timeoutMs: 15_000 });
    try {
      const probed = await manager.run("probe", `
        const probeHtml = await tab.extract('probe');
        const lists = await tab.extract('list');
        const folded = await tab.extract('probe', { fold: 'target' });
        const before = await tab.snapshot();
        await tab.click('#add');
        await tab.evaluate(() => new Promise(r => setTimeout(r, 50)));
        const diff = await tab.diff(before);
        await tab.monitorStart();
        await tab.evaluate(() => { const t = document.createElement('div'); t.textContent = 'Toast message here'; document.body.appendChild(t); });
        await tab.evaluate(() => new Promise(r => setTimeout(r, 500)));
        const transients = await tab.monitorStop();
        return { probeLen: probeHtml.length, foldedLen: folded.length, foldedHasHint: folded.includes('[FAKE ELEMENT]'), listCount: lists.length, diffChanged: diff.changed, transients };
      `, process.cwd(), undefined, 15_000);
      const rv = probed.returnValue as { probeLen: number; foldedLen: number; foldedHasHint: boolean; listCount: number; diffChanged: number; transients: string[] };
      assert.ok(rv.probeLen > 0, 'extract("probe") must return HTML');
      assert.ok(rv.foldedLen < rv.probeLen || rv.foldedHasHint, 'folded probe should be smaller or contain a FAKE ELEMENT hint');
      assert.ok(rv.foldedHasHint, 'extract("probe", {fold}) must emit [FAKE ELEMENT] hint for the long list');
      assert.ok(rv.listCount >= 0, 'extract("list") must return an array');
      assert.ok(typeof rv.diffChanged === 'number', 'diff must return a numeric changed count');
      assert.ok(Array.isArray(rv.transients), 'monitorStop must return an array');
    } finally {
      await manager.close("probe");
    }

    // Navigation / new-tab detection: run output reports when the page URL
    // changed and when new tabs opened during execution.
    await manager.open({ name: "nav", cwd: process.cwd(), url: "data:text/html,<title>Nav</title>", timeoutMs: 15_000 });
    try {
      const navOut = await manager.run("nav", `await tab.goto('data:text/html,<title>Navigated</title>'); const tabs = await tab.tabs(); return { tabs: tabs.length, hasNavigatedTab: tabs.some(t => /Navigated/.test(t.title || '')) };`, process.cwd(), undefined, 15_000);
      assert.equal(navOut.navigated, true, 'run must report navigated=true after a goto changes the URL');
      assert.ok(/Navigated/.test(navOut.url), 'run output url should reflect the navigated page');
      const rv = navOut.returnValue as { tabs: number; hasNavigatedTab: boolean };
      assert.ok(rv.tabs >= 1, 'tab.tabs() must list at least one page');
      assert.equal(rv.hasNavigatedTab, true, 'tab.tabs() must include the navigated page by title');
    } finally {
      await manager.close("nav");
    }
    await manager.open({ name: "pop", cwd: process.cwd(), url: "data:text/html,<title>Pop</title>", timeoutMs: 15_000 });
    try {
      const popOut = await manager.run("pop", `const p = await browser.newPage(); await p.goto('data:text/html,<title>Spawned</title>'); await new Promise(r => setTimeout(r, 200)); return true;`, process.cwd(), undefined, 15_000);
      assert.ok(Array.isArray(popOut.newTabs) && popOut.newTabs.length >= 1, 'run must report new tabs opened during execution');
    } finally {
      await manager.closeAll();
    }

    // Negative paths: navigated=false on same URL, newTabs undefined when a spawned
    // tab is closed before the run ends, monitorStop returns [] without a prior start.
    await manager.open({ name: "neg", cwd: process.cwd(), url: "data:text/html,<title>Neg</title>", timeoutMs: 15_000 });
    try {
      const negOut = await manager.run("neg", `
        const sameUrl = page.url();
        await tab.goto(sameUrl);
        const tabsAfterSame = await tab.tabs();
        const monitorWithoutStart = await tab.monitorStop();
        return { sameUrl, tabsAfterSame, monitorWithoutStart };
      `, process.cwd(), undefined, 15_000);
      assert.notEqual(negOut.navigated, true, 'navigated must be falsy when the URL did not change');
      const rv = negOut.returnValue as { tabsAfterSame: Array<{ url: string }>; monitorWithoutStart: string[] };
      assert.ok(Array.isArray(rv.tabsAfterSame) && rv.tabsAfterSame.length >= 1, 'tab.tabs() lists the page');
      assert.deepEqual(rv.monitorWithoutStart, [], 'monitorStop without monitorStart returns []');
      // A spawned tab closed within the run should not be reported as a new tab.
      const closeOut = await manager.run("neg", `const p = await browser.newPage(); await p.close(); return true;`, process.cwd(), undefined, 15_000);
      assert.equal(closeOut.newTabs, undefined, 'newTabs is undefined when a spawned tab is closed before run ends');
    } finally {
      await manager.close("neg");
    }
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

test("browser run wrapper lets top-level declarations reuse helper names without a redeclaration error", async () => {
  const displays: string[] = [];
  const mockTab = { name: "main", observe: async () => ({ n: 1 }) };
  const mockAssert = (condition: unknown, message?: string) => { if (!condition) throw new Error(message ?? "assert"); };
  const mockWait = async () => { displays.push("helper-wait-called"); };
  const mockDisplay = (value: unknown) => { displays.push(`display:${String(value)}`); };
  const fn = compileRunCode(`
    const wait = "user-wait";
    const page = "user-page";
    const assert = "user-assert";
    const display = "user-display";
    return { shadowed: [wait, page, assert, display].join("|"), tabName: tab.name, observed: (await tab.observe()).n, browserType: typeof browser };
  `);
  const returnValue = await fn({ tag: "PAGE" }, {}, mockTab, mockAssert, mockWait, mockDisplay, () => {}, undefined, console) as { shadowed: string; tabName: string; observed: number; browserType: string };
  assert.equal(returnValue.shadowed, "user-wait|user-page|user-assert|user-display");
  assert.equal(returnValue.tabName, "main");
  assert.equal(returnValue.observed, 1);
  assert.equal(returnValue.browserType, "object");
  assert.deepEqual(displays, []);
});

test("browser run wrapper exposes every helper when the user does not shadow it", async () => {
  const displays: string[] = [];
  let waited = false;
  const mockTab = { name: "t" };
  const mockAssert = (condition: unknown, message?: string) => { if (!condition) throw new Error(message ?? "assert"); };
  const mockWait = async () => { waited = true; };
  const mockDisplay = (value: unknown) => { displays.push(String(value)); };
  const mockPrint = (...values: unknown[]) => { displays.push(values.join(" ")); };
  const fn = compileRunCode(`
    assert(1 + 1 === 2, "math");
    await wait(0);
    display(page.tag);
    print("hello", tab.name);
    return signal === undefined ? "no-signal" : "has-signal";
  `);
  const returnValue = await fn({ tag: "P" }, {}, mockTab, mockAssert, mockWait, mockDisplay, mockPrint, undefined, console);
  assert.equal(waited, true);
  assert.deepEqual(displays, ["P", "hello t"]);
  assert.equal(returnValue, "no-signal");
});

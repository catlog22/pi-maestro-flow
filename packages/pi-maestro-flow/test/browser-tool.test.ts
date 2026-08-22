import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { BrowserParams, createBrowserTool } from "../src/tools/browser-tool.ts";
import { BrowserManager, browserRunErrorHint, compileRunCode, type BrowserManagerLike, type BrowserOpenOptions, type BrowserRunOutput, type BrowserTabInfo } from "../src/tools/browser/manager.ts";
import { STEALTH_INIT_JS, STEALTH_LAUNCH_ARGS } from "../src/tools/browser/stealth.ts";

class FakeBrowserManager implements BrowserManagerLike {
  opened?: BrowserOpenOptions;
  runs: Array<{ name: string; code: string; cwd: string; timeoutMs: number }> = [];
  closed: string[] = [];
  closeAllCount = 2;
  abortRun = false;

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    this.opened = options;
    const kind = options.cdpUrl || options.attachUserProfile ? "connected" : options.visible ? "headed" : "headless";
    return { name: options.name, kind, url: options.url ?? "about:blank", title: "Example", reused: false, viewport: { width: 1000, height: 700 } };
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

test("stealth module exports the webdriver/plugins/chrome/permissions patches and the anti-automation launch flag", () => {
  assert.match(STEALTH_INIT_JS, /webdriver/, 'STEALTH_INIT_JS must patch navigator.webdriver');
  assert.match(STEALTH_INIT_JS, /plugins/, 'STEALTH_INIT_JS must patch navigator.plugins');
  assert.match(STEALTH_INIT_JS, /chrome/, 'STEALTH_INIT_JS must patch window.chrome');
  assert.match(STEALTH_INIT_JS, /permissions/, 'STEALTH_INIT_JS must patch permissions.query');
  assert.ok(STEALTH_LAUNCH_ARGS.includes('--disable-blink-features=AutomationControlled'), 'STEALTH_LAUNCH_ARGS must disable AutomationControlled');
});

test("browser schema preserves open/run/close and full control inputs", () => {
  assert.deepEqual((BrowserParams.properties.action as { enum: string[] }).enum, ["open", "close", "run", "guide"]);
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
  // Wave 0/1 new capabilities.
  assert.match(joined, /tab\.cdp\(/, "guidelines must mention tab.cdp()");
  assert.match(joined, /tab\.cookies\./, "guidelines must mention tab.cookies.*");
  assert.match(joined, /tab\.uploadFile\(/, "guidelines must mention tab.uploadFile()");
  assert.match(joined, /attach_user_profile/, "guidelines must mention attach_user_profile");
  // Wave 2 new capabilities.
  assert.match(joined, /tab\.evalInFrame\(/, "guidelines must mention tab.evalInFrame()");
  assert.match(joined, /tab\.pierce\(/, "guidelines must mention tab.pierce()");
  assert.match(joined, /tab\.cdpClick\(/, "guidelines must mention tab.cdpClick()");
  assert.match(joined, /tab\.autofillRelease\(/, "guidelines must mention tab.autofillRelease()");
  assert.match(joined, /tab\.setDownloadBehavior\(/, "guidelines must mention tab.setDownloadBehavior()");
  assert.match(joined, /tab\.cdpBatch\(/, "guidelines must mention tab.cdpBatch()");
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

test("browser open forwards attach_user_profile + user_profile_dir into the manager", async () => {
  const manager = new FakeBrowserManager();
  const tool = createBrowserTool(manager);
  const ctx = { cwd: "D:/workspace" } as never;
  const opened = await tool.execute("open", {
    action: "open",
    name: "me",
    url: "https://example.com",
    visible: true,
    app: {
      attach_user_profile: true,
      user_profile_dir: "C:/Users/me/AppData/Local/Google/Chrome/User Data",
    },
  }, undefined, undefined, ctx);
  // FakeBrowserManager reports kind "connected" when cdpUrl is set OR (now) when
  // attachUserProfile is set, mirroring the real connectBrowser attach branch.
  assert.equal(manager.opened?.attachUserProfile, true);
  assert.equal(manager.opened?.userProfileDir, "C:/Users/me/AppData/Local/Google/Chrome/User Data");
  assert.equal(opened.details?.browser, "connected");
});

test("browser schema accepts app.attach_user_profile / app.user_profile_dir", () => {
  assert.equal(Check(BrowserParams, {
    action: "open",
    app: { attach_user_profile: true, user_profile_dir: "C:/x" },
  }), true);
  assert.equal(Check(BrowserParams, { action: "open", app: { attach_user_profile: true } }), true);
});

test("browser guide action returns the in-tool SOP", async () => {
  const manager = new FakeBrowserManager();
  const tool = createBrowserTool(manager);
  const ctx = { cwd: "D:/workspace" } as never;
  const res = await tool.execute("guide", { action: "guide" }, undefined, undefined, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(res.details?.action, "guide");
  const text = res.content.filter((item) => item.type === "text").map((item) => "text" in item ? item.text : "").join("\n");
  assert.match(text, /Turnstile/i, "guide must mention Turnstile");
  assert.match(text, /evalInFrame/, "guide must mention evalInFrame");
  assert.match(text, /cdpClick/, "guide must mention cdpClick");
  assert.match(text, /attach_user_profile/, "guide must mention attach_user_profile");
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

    // Wave 0/1 capabilities: stealth (webdriver undefined), tab.cdp, tab.cookies, tab.uploadFile.
    await manager.open({ name: "wave01", cwd: process.cwd(), url: "data:text/html,<title>Wave01</title><input type='file' id='f'><input id='name'>", timeoutMs: 15_000 });
    try {
      const waveOut = await manager.run("wave01", `
        const webdriver = await tab.evaluate(() => navigator.webdriver);
        const pluginsLen = await tab.evaluate(() => navigator.plugins.length);
        const cdpVal = await tab.cdp('Runtime.evaluate', { expression: '1 + 2' });
        const cdpSum = cdpVal && cdpVal.result && cdpVal.result.value;
        // Cookie round-trip on a real origin.
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await tab.cookies.set({ name: 'pi_test', value: 'v1', domain: 'example.com', path: '/' });
        const beforeDelete = await tab.cookies.get({ name: 'pi_test' });
        await tab.cookies.delete({ name: 'pi_test' });
        const afterDelete = await tab.cookies.get({ name: 'pi_test' });
        return { webdriver, pluginsLen, cdpSum, beforeDelete, afterDelete };
      `, process.cwd(), undefined, 20_000);
      const w = waveOut.returnValue as { webdriver: unknown; pluginsLen: number; cdpSum: number; beforeDelete: unknown[]; afterDelete: unknown[] };
      assert.notEqual(w.webdriver, true, 'stealth must not leave navigator.webdriver === true');
      assert.ok(w.pluginsLen > 0, 'stealth must fake navigator.plugins so length > 0');
      assert.equal(w.cdpSum, 3, 'tab.cdp(Runtime.evaluate) must return the evaluated value');
      assert.ok(Array.isArray(w.beforeDelete) && w.beforeDelete.length > 0, 'tab.cookies.set then get must return the cookie');
      assert.deepEqual(w.afterDelete, [], 'tab.cookies.delete must remove the cookie');
    } finally {
      await manager.close("wave01");
    }

    // Wave 2: evalInFrame (cross-origin iframe), pierce (closed shadow),
    // cdpClick (physical coords), cdpBatch ($N references), setDownloadBehavior.
    // All use data: URLs so no network is required; attach mode is out of scope here.
    await manager.open({
      name: "wave2",
      cwd: process.cwd(),
      url: "data:text/html," + encodeURIComponent("<title>Wave2</title><iframe id='f' src='data:text/html,<button id=bt>Cross</button>'></iframe><div id=host></div><button id=btn>X</button>"),
      timeoutMs: 15_000,
    });
    try {
      const wave2Out = await manager.run("wave2", `
        // Open shadow root + a button inside it (open=true). pi's pierce() uses
        // puppeteer's pierce/<selector> engine which crosses OPEN shadow boundaries;
        // closed shadow is a known Chrome limitation (documented in the guide).
        await tab.evaluate(() => {
          const host = document.getElementById('host');
          const root = host.attachShadow({ mode: 'open' });
          const b = document.createElement('button'); b.id = 'shadow-btn'; b.textContent = 'Shadow'; root.appendChild(b);
        });
        const pierced = await tab.pierce('#shadow-btn');
        // evalInFrame: find the iframe by url substring, read its button text.
        const frameText = await tab.evalInFrame('data:text/html', () => document.getElementById('bt').textContent);
        // cdpBatch: getDocument depth 0, then querySelector referencing $0.root.nodeId.
        const batch = await tab.cdpBatch([
          { method: 'DOM.getDocument', params: { depth: 0 } },
          { method: 'DOM.querySelector', params: { nodeId: '$0.root.nodeId', selector: '#btn' } },
        ]);
        // cdpClick on #btn center, then read its clicked flag.
        await tab.evaluate(() => { document.getElementById('btn').addEventListener('click', () => { window.__clicked = true; }, { once: true }); });
        const btnBox = await tab.evaluate(() => { const r = document.getElementById('btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        await tab.cdpClick(btnBox.x, btnBox.y, { hoverMs: 50 });
        const clicked = await tab.evaluate(() => window.__clicked === true);
        // setDownloadBehavior: set an allow path (creates the dir).
        const dl = await tab.setDownloadBehavior('./downloads-test');
        return { piercedHasCoords: typeof pierced.x === 'number' && typeof pierced.y === 'number', frameText, batchLen: batch.length, batchSecondOk: batch[1] && batch[1].ok === true, clicked, dl };
      `, process.cwd(), undefined, 20_000);
      const w2 = wave2Out.returnValue as { piercedHasCoords: boolean; frameText: string; batchLen: number; batchSecondOk: boolean; clicked: boolean; dl: unknown };
      assert.ok(w2.piercedHasCoords, 'tab.pierce must return numeric center coords for a closed shadow button');
      assert.equal(w2.frameText, 'Cross', 'tab.evalInFrame must evaluate JS inside the matched iframe');
      assert.equal(w2.batchLen, 2, 'tab.cdpBatch must return one result per command');
      assert.equal(w2.batchSecondOk, true, 'tab.cdpBatch $0.root.nodeId reference must resolve and the second command must succeed');
      assert.equal(w2.clicked, true, 'tab.cdpClick must dispatch a real click that the page listener observes');
      assert.equal(w2.dl, undefined, 'tab.setDownloadBehavior resolves without a return value');
      // Clean up the test download dir.
      await fs.rm(path.join(process.cwd(), 'downloads-test'), { recursive: true, force: true }).catch(() => {});
    } finally {
      await manager.close("wave2");
    }
  } finally {
    await manager.close("live");
  }
});

test("browser manager scopes request interception listeners to one run", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Interception</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const manager = new BrowserManager();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  try {
    try {
      await manager.open({ name: "interception", cwd: process.cwd(), url: `${baseUrl}initial`, timeoutMs: 15_000 });
    } catch (error) {
      if (error instanceof Error && /No Chromium browser found/.test(error.message)) {
        t.skip("No local Chromium executable is available.");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => manager.run("interception", `
        await page.setRequestInterception(true);
        page.on("request", () => {});
        throw new Error("expected run failure");
      `, process.cwd(), undefined, 15_000),
      /expected run failure/,
    );
    const first = await manager.run("interception", `
      const baseline = page.listenerCount("request");
      const requestHandler = (request) => { request.continue(); };
      await page.setRequestInterception(true);
      page.on("request", requestHandler);
      page.on("request", requestHandler);
      page.off("request", requestHandler);
      page.once("request", () => {});
      await page.goto(${JSON.stringify(`${baseUrl}intercepted`)});
      return { baseline, listenersDuringRun: page.listenerCount("request") };
    `, process.cwd(), undefined, 15_000);
    const firstResult = first.returnValue as { baseline: number; listenersDuringRun: number };
    assert.ok(firstResult.baseline > 0, "Puppeteer internal request listener should remain installed");
    assert.equal(firstResult.listenersDuringRun, firstResult.baseline + 1);
    const second = await manager.run("interception", `
      await page.setRequestInterception(false);
      await page.goto(${JSON.stringify(`${baseUrl}normal`)});
      await page.waitForNetworkIdle({ idleTime: 50, timeout: 2_000 });
      return { title: await page.title(), requestListeners: page.listenerCount("request") };
    `, process.cwd(), undefined, 15_000);
    assert.deepEqual(second.returnValue, { title: "Interception", requestListeners: firstResult.baseline });
  } finally {
    await manager.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

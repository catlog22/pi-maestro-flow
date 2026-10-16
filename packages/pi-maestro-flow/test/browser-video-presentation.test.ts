import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, test, type TestContext } from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { BrowserVideoPresentation, type BrowserVideoActionOptions } from "../src/tools/browser/video-presentation.ts";

let browser: Browser;

function localChrome(): string {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
    path.join(process.env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ];
  const executable = candidates.find((candidate) => candidate && existsSync(candidate));
  assert.ok(executable, "A local Chromium executable is required; these tests must not skip.");
  return executable;
}

before(async () => { browser = await puppeteer.launch({ executablePath: localChrome(), headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

async function fixture(t: TestContext) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.setContent('<style>body{background:linear-gradient(135deg,#feb,#6af);height:1500px}button,input,select{margin:40px;padding:15px}</style><button id="target">Click target</button><input id="secret" type="password"><select id="select"><option value="a">A</option><option value="b">B</option></select>');
  const presentation = new BrowserVideoPresentation(page);
  t.after(async () => { await presentation.dispose(); await page.close(); });
  return { page, presentation };
}

async function decorations(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-browser-video-presentation]");
    const shadow = root?.shadowRoot;
    const label = shadow?.querySelector<HTMLElement>(".label");
    const target = shadow?.querySelector<HTMLElement>(".target");
    const cursor = shadow?.querySelector<HTMLElement>(".cursor");
    const chapter = shadow?.querySelector<HTMLElement>(".chapter");
    const box = chapter?.getBoundingClientRect();
    return {
      exists: Boolean(root), inert: root?.inert, pointerEvents: root && getComputedStyle(root).pointerEvents,
      label: label?.textContent, labelOpacity: label?.style.opacity,
      position: label && { top: label.style.top, right: label.style.right, bottom: label.style.bottom, left: label.style.left, transform: label.style.transform },
      cursor: cursor?.style.opacity, cursorTransform: cursor?.style.transform,
      target: target && { left: target.style.left, top: target.style.top, width: target.style.width, opacity: target.style.opacity },
      chapter: chapter && { title: chapter.querySelector("h1")?.textContent, description: chapter.querySelector("p")?.textContent, blur: getComputedStyle(chapter).backdropFilter, align: getComputedStyle(chapter).alignItems, justify: getComputedStyle(chapter).justifyContent, opacity: chapter.style.opacity, box: box && { x: box.x, y: box.y, width: box.width, height: box.height }, injectedElements: chapter.querySelectorAll("img,script").length },
    };
  });
}

async function waitForLabel(page: Page, label: string) {
  await page.waitForFunction((expected) => document.querySelector("[data-browser-video-presentation]")?.shadowRoot?.querySelector(".label")?.textContent === expected, {}, label);
}

test("presentation activates its named page after another tab took foreground", async (t) => {
  const { page, presentation } = await fixture(t);
  const other = await browser.newPage();
  t.after(async () => { await other.close(); });
  assert.equal(await page.evaluate(() => document.visibilityState), "hidden");
  await presentation.showActions();
  assert.equal(await page.evaluate(() => document.visibilityState), "visible");
  await other.bringToFront();
  await presentation.chapter({ title: "Back on target", duration: 0 });
  assert.equal(await page.evaluate(() => document.visibilityState), "visible");
});

test("aborting show_actions while foreground activation is pending prevents late installation", async (t) => {
  const { page, presentation } = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(page, "bringToFront", async () => { entered(); await gate; });
  const controller = new AbortController();
  const showing = presentation.showActions({}, controller.signal);
  const rejected = assert.rejects(showing, { name: "AbortError" });
  await ready;
  controller.abort();
  await rejected;
  await presentation.dispose();
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await decorations(page)).exists, false);
});

test("a late new-document registration after cancellation is removed before another navigation", async (t) => {
  const { page, presentation } = await fixture(t);
  const register = page.evaluateOnNewDocument.bind(page);
  const remove = page.removeScriptToEvaluateOnNewDocument.bind(page);
  let release!: () => void;
  let entered!: () => void;
  let removed!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const cleaned = new Promise<void>((resolve) => { removed = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(page, "evaluateOnNewDocument", async (...args: Parameters<Page["evaluateOnNewDocument"]>) => {
    entered(); await gate; return register(...args);
  });
  t.mock.method(page, "removeScriptToEvaluateOnNewDocument", async (id: string) => { await remove(id); removed(); });
  const controller = new AbortController();
  const showing = presentation.showActions({}, controller.signal);
  const rejected = assert.rejects(showing, { name: "AbortError" });
  await ready;
  controller.abort();
  await rejected;
  await presentation.dispose();
  release();
  await cleaned;
  await page.goto("data:text/html,<h1>Clean navigation</h1>");
  assert.equal((await decorations(page)).exists, false);
});

test("chapter renders a captured full-screen centered, blurred, text-only card and removes it", async (t) => {
  const { page, presentation } = await fixture(t);
  const viewport = page.viewport();
  const before = await page.screenshot();
  const chapter = presentation.chapter({ title: '<img src=x onerror="bad()"> Chapter', description: "A description\nSecond line", duration: 250 });
  await page.waitForFunction(() => document.querySelector("[data-browser-video-presentation]")?.shadowRoot?.querySelector<HTMLElement>(".chapter")?.style.opacity === "1");
  const state = await decorations(page);
  assert.deepEqual(state.chapter?.box, { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(state.chapter?.title, '<img src=x onerror="bad()"> Chapter');
  assert.equal(state.chapter?.description, "A description\nSecond line");
  assert.equal(state.chapter?.injectedElements, 0);
  assert.equal(state.chapter?.blur, "blur(12px)");
  assert.equal(state.chapter?.align, "center");
  assert.equal(state.chapter?.justify, "center");
  assert.equal(state.pointerEvents, "none");
  assert.equal(state.inert, true);
  assert.notDeepEqual(await page.screenshot(), before, "decorations are rendered in Chromium screenshot pixels");
  await chapter;
  assert.equal((await decorations(page)).exists, false);
  assert.deepEqual(page.viewport(), viewport, "presentation never changes viewport");
});

test("chapter waits for multiple animation frames before its duration starts, fades and aborts cleanly", async (t) => {
  const { page, presentation } = await fixture(t);
  await page.evaluate(() => {
    const native = requestAnimationFrame.bind(window);
    let frames = 0;
    Object.assign(window, { presentationFrames: () => frames });
    window.requestAnimationFrame = (callback) => native((time) => { frames++; callback(time); });
  });
  const chapter = presentation.chapter({ title: "Frame proof", duration: 0 });
  await chapter;
  assert.ok(Number(await page.evaluate(() => Reflect.apply(Reflect.get(window, "presentationFrames"), window, []))) >= 2);
  const controller = new AbortController();
  const aborted = presentation.chapter({ title: "Abort", duration: 10_000 }, controller.signal);
  const rejection = assert.rejects(aborted, { name: "AbortError" });
  await page.waitForFunction(() => !!document.querySelector("[data-browser-video-presentation]")?.shadowRoot?.querySelector(".chapter"));
  controller.abort();
  await rejection;
  assert.equal((await decorations(page)).exists, false);
  const early = new AbortController(); early.abort();
  await assert.rejects(presentation.chapter({ title: "Never mounted" }, early.signal), { name: "AbortError" });
  assert.equal((await decorations(page)).exists, false);
});

test("all six action callout positions, cursor options and duration are applied", async (t) => {
  const { page, presentation } = await fixture(t);
  const api = presentation.wrapApis(page, {});
  for (const position of ["top-left", "top", "top-right", "bottom-left", "bottom", "bottom-right"] as const) {
    await presentation.showActions({ position, duration: 1000, cursor: "none" });
    await api.page.click("#target");
    const state = await decorations(page);
    assert.equal(state.label, "click");
    assert.equal(state.cursor, "0");
    assert.equal(state.position?.[position.startsWith("bottom") ? "bottom" : "top"], "24px");
    if (position.endsWith("-left")) assert.equal(state.position?.left, "24px");
    else if (position.endsWith("-right")) assert.equal(state.position?.right, "24px");
    else { assert.equal(state.position?.left, "50%"); assert.equal(state.position?.transform, "translateX(-50%)"); }
  }
  await presentation.showActions({ duration: 40 });
  await api.page.click("#target");
  const state = await decorations(page);
  assert.equal(state.cursor, "1");
  assert.equal(state.target?.opacity, "1");
  assert.equal(state.position?.right, "24px");
  await page.waitForFunction(() => document.querySelector("[data-browser-video-presentation]")?.shadowRoot?.querySelector<HTMLElement>(".label")?.style.opacity === "0");
});

test("proxy preserves synchronous getters, receiver binding and cached keyboard/mouse objects without enabling effects", async (t) => {
  const { page, presentation } = await fixture(t);
  const tab = { token: "receiver", url() { return this.token; } };
  const api = presentation.wrapApis(page, tab);
  assert.equal(typeof api.page.url(), "string");
  assert.equal(api.page.isClosed(), false);
  assert.equal(api.page.mouse, api.page.mouse);
  assert.equal(api.page.keyboard, api.page.keyboard);
  assert.equal(api.page.mouse.move, api.page.mouse.move);
  assert.equal(api.tab.url(), "receiver");
  await api.page.click("#target");
  assert.equal((await decorations(page)).exists, false);
});

test("page, keyboard, mouse, touchscreen and tab actions annotate without exposing input values or duplicating nested actions", async (t) => {
  const { page, presentation } = await fixture(t);
  const tab = {
    async id(id: number) { assert.equal(id, 7); return page.$("#secret"); },
    async click(id: number) { const handle = await this.id(id); await handle!.click(); await handle!.dispose(); },
    async type(selector: string, text: string) { await page.type(selector, text); },
    async fill(selector: string, text: string) { await page.$eval(selector, (element) => { (element as HTMLInputElement).value = ""; }); await this.type(selector, text); },
    async hover(selector: string) { await page.hover(selector); },
    async focus(selector: string) { await page.focus(selector); },
    async select(selector: string, value: string) { return page.select(selector, value); },
  };
  const api = presentation.wrapApis(page, tab);
  await presentation.showActions({ duration: 1000 });
  await api.tab.click(7);
  assert.equal((await decorations(page)).label, "click");
  assert.ok(Number.parseFloat((await decorations(page)).target!.width) > 20, "numeric selector resolves real target geometry");
  await api.tab.fill("#secret", "super-secret-value");
  assert.equal((await decorations(page)).label, "fill", "tab.fill calling raw this.type produces only the outer annotation");
  assert.equal(await page.$eval("#secret", (input) => (input as HTMLInputElement).value), "super-secret-value");
  await api.page.keyboard.type("private-keyboard-value");
  assert.equal((await decorations(page)).label, "keyboard type");
  await api.page.keyboard.press("Tab");
  assert.equal((await decorations(page)).label, "keyboard press");
  await api.tab.hover("#target"); assert.equal((await decorations(page)).label, "hover");
  await api.tab.focus("#secret"); assert.equal((await decorations(page)).label, "focus");
  assert.deepEqual(await api.tab.select("#select", "b"), ["b"]);
  assert.equal((await decorations(page)).label, "select");
  await api.page.mouse.move(50, 90);
  assert.equal((await decorations(page)).label, "mouse move");
  assert.equal((await decorations(page)).cursorTransform, "translate(50px, 90px)");
  await api.page.touchscreen.tap(60, 100);
  assert.equal((await decorations(page)).label, "touchscreen tap");
  assert.equal(await page.evaluate(() => document.querySelector("[data-browser-video-presentation]")!.shadowRoot!.textContent!.includes("super-secret-value")), false);
});

test("raw CDP input and cdpClick annotate coordinates; DOM events provide unwrapped action fallback", async (t) => {
  const { page, presentation } = await fixture(t);
  const session = await page.createCDPSession();
  const tab = {
    cdp(method: string, params: Record<string, unknown>) { return session.send(method as never, params as never); },
    async cdpClick(x: number, y: number) { await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x, y }); await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x, y }); },
  };
  await presentation.showActions({ duration: 1000 });
  const api = presentation.wrapApis(page, tab);
  await api.tab.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 70, y: 80 });
  assert.equal((await decorations(page)).label, "dispatchMouseEvent");
  assert.equal((await decorations(page)).cursorTransform, "translate(70px, 80px)");
  await api.tab.cdpClick(80, 90);
  assert.equal((await decorations(page)).label, "cdpClick");
  await api.tab.cdp("Input.insertText", { text: "never-reveal-cdp-value" });
  assert.equal((await decorations(page)).label, "insertText");
  await page.click("#target");
  await waitForLabel(page, "Click");
  assert.equal(await page.evaluate(() => document.querySelector("[data-browser-video-presentation]")!.shadowRoot!.querySelector(".ripple")!.classList.contains("pulse")), true);
});

test("show/update reinjects only one overlay across navigation; hide/dispose removes scripts, DOM and listeners without closing a borrowed page", async (t) => {
  const { page, presentation } = await fixture(t);
  await presentation.showActions();
  await presentation.showActions({ position: "bottom-left", cursor: "none" });
  await page.goto("data:text/html,<button id='next'>Next</button>");
  assert.equal(await page.$$eval("[data-browser-video-presentation]", (roots) => roots.length), 1);
  await page.click("#next");
  const state = await decorations(page);
  assert.equal(state.position?.bottom, "24px");
  assert.equal(state.position?.left, "24px");
  assert.equal(state.cursor, "0");
  await presentation.hideActions();
  assert.equal((await decorations(page)).exists, false);
  await page.click("#next");
  assert.equal((await decorations(page)).exists, false);
  await page.reload();
  assert.equal((await decorations(page)).exists, false);
  await presentation.showActions();
  await presentation.dispose();
  await page.reload();
  await page.click("#next");
  assert.equal((await decorations(page)).exists, false);
  assert.equal(page.isClosed(), false);
  await assert.rejects(presentation.showActions(), /disposed/);
});

test("invalid runtime options have no DOM or new-document effects and aborted wrapped actions do not execute", async (t) => {
  const { page, presentation } = await fixture(t);
  for (const invalid of [null, [], { duration: -1 }, { duration: Infinity }, { duration: "10" }, { position: "middle" }, { cursor: "hidden" }]) {
    assert.throws(() => presentation.showActions(invalid as BrowserVideoActionOptions), TypeError);
  }
  for (const invalid of [null, {}, { title: 4 }, { title: "" }, { title: "Hi", description: 7 }, { title: "Hi", duration: NaN }]) {
    await assert.rejects(presentation.chapter(invalid as never), TypeError);
  }
  assert.equal((await decorations(page)).exists, false);
  await page.reload();
  assert.equal((await decorations(page)).exists, false);
  await presentation.showActions();
  const controller = new AbortController(); controller.abort();
  let called = false;
  const api = presentation.wrapApis(page, { async click() { called = true; } }, controller.signal);
  await assert.rejects(api.tab.click(), { name: "AbortError" });
  assert.equal(called, false);
});

test("chapter times out and cleans its DOM when animation frames never arrive", async (t) => {
  const { page, presentation } = await fixture(t);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await assert.rejects(presentation.chapter({ title: "Stalled render", duration: 0 }), /presentation timed out/);
  assert.equal((await decorations(page)).exists, false);
  assert.equal(page.isClosed(), false);
});

test("dispose interrupts an active chapter and leaves the live borrowed document undecorated", async (t) => {
  const { page, presentation } = await fixture(t);
  await presentation.showActions();
  const chapter = presentation.chapter({ title: "Close", duration: 10_000 });
  const rejected = assert.rejects(chapter, { name: "AbortError" });
  await page.waitForFunction(() => !!document.querySelector("[data-browser-video-presentation]")?.shadowRoot?.querySelector(".chapter"));
  await presentation.dispose();
  await rejected;
  assert.equal((await decorations(page)).exists, false);
  assert.equal(page.isClosed(), false);
});

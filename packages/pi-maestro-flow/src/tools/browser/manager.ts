import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, ElementHandle, HTTPResponse, KeyInput, Page, WaitForOptions } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import { PROBE_JS, FIND_LISTS_JS, foldListsJs, monitorStartJs, MONITOR_STOP_JS, optimizeHtmlForTokens, smartTruncate, diffHtml, type HtmlDiff } from "./simplify.ts";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";

export interface BrowserOpenOptions {
  name: string;
  cwd: string;
  url?: string;
  executablePath?: string;
  cdpUrl?: string;
  args?: string[];
  target?: string;
  visible?: boolean;
  viewport?: { width: number; height: number; scale?: number };
  waitUntil?: WaitUntil;
  dialogs?: "accept" | "dismiss";
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface BrowserTabInfo {
  name: string;
  kind: "headless" | "headed" | "connected";
  url: string;
  title: string;
  reused: boolean;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export interface BrowserRunOutput {
  displays: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  returnValue: unknown;
  screenshots: Array<{ path?: string; mimeType: string; bytes: number }>;
  url: string;
  navigated?: boolean;
  newTabs?: Array<{ url: string }>;
}

export interface BrowserManagerLike {
  open(options: BrowserOpenOptions): Promise<BrowserTabInfo>;
  run(name: string, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserRunOutput>;
  close(name: string): Promise<boolean>;
  closeAll(): Promise<number>;
}

interface TabEntry {
  name: string;
  key: string;
  kind: "headless" | "headed" | "connected";
  browser: Browser;
  page: Page;
  owned: boolean;
  ownedPage: boolean;
  profileDir?: string;
  dialogHandler?: (dialog: import("puppeteer-core").Dialog) => Promise<void>;
  elementSelectors: Map<number, string>;
  ownedTempFiles: Set<string>;
  busy: boolean;
}

interface OpeningEntry {
  key: string;
  requestKey: string;
  promise: Promise<BrowserTabInfo>;
  abort(): void;
}

export class BrowserManager implements BrowserManagerLike {
  #tabs = new Map<string, TabEntry>();
  #opening = new Map<string, OpeningEntry>();
  #lifecycle = new AbortController();

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    throwIfAborted(options.signal);
    const key = browserKey(options);
    const requestKey = browserOpenRequestKey(options, key);
    const pending = this.#opening.get(options.name);
    if (pending) {
      if (pending.requestKey !== requestKey) throw new Error(`Tab "${options.name}" is already opening with different settings.`);
      return { ...(await pending.promise), reused: true };
    }
    let existing = this.#tabs.get(options.name);
    if (existing && (!existing.browser.connected || existing.page.isClosed())) {
      this.#tabs.delete(options.name);
      await disposeEntry(existing);
      existing = undefined;
      const raced = this.#opening.get(options.name);
      if (raced) {
        if (raced.requestKey !== requestKey) throw new Error(`Tab "${options.name}" is already opening with different settings.`);
        return { ...(await raced.promise), reused: true };
      }
    }
    if (existing) {
      if (existing.key !== key) throw new Error(`Tab "${options.name}" already uses a different browser. Close it before changing app settings.`);
      const combined = combineSignals(options.signal, this.#lifecycle.signal);
      try {
        const effective = { ...options, signal: combined.signal };
        await this.#configurePage(existing, effective);
        return this.#info(existing, true, combined.signal, options.timeoutMs);
      } finally {
        combined.dispose();
      }
    }

    const controller = new AbortController();
    const combined = combineSignals(options.signal, this.#lifecycle.signal, controller.signal);
    const effective = { ...options, signal: combined.signal };
    let promise: Promise<BrowserTabInfo>;
    promise = this.#openNew(effective, key);
    const opening: OpeningEntry = { key, requestKey, promise, abort: () => controller.abort() };
    this.#opening.set(options.name, opening);
    try {
      return await promise;
    } finally {
      if (this.#opening.get(options.name) === opening) this.#opening.delete(options.name);
      combined.dispose();
    }
  }

  async #openNew(options: BrowserOpenOptions, key: string): Promise<BrowserTabInfo> {
    const connection = await connectBrowser(options, key);
    let page: Page | undefined;
    let ownedPage = false;
    try {
      const pickedPage = await raceAbort(pickPage(connection.browser, options.target), options.signal, options.timeoutMs);
      if (options.target && !pickedPage) throw new Error(`No browser page matched target ${JSON.stringify(options.target)}.`);
      page = pickedPage ?? await raceAbort(connection.browser.newPage(), options.signal, options.timeoutMs);
      ownedPage = connection.owned || !pickedPage;
      const entry: TabEntry = {
        name: options.name,
        key,
        kind: connection.kind,
        browser: connection.browser,
        page,
        owned: connection.owned,
        ownedPage,
        profileDir: connection.profileDir,
        elementSelectors: new Map(),
        ownedTempFiles: new Set(),
        busy: false,
      };
      await this.#configurePage(entry, options);
      throwIfAborted(options.signal);
      this.#registerEntry(entry);
      return this.#info(entry, connection.reused, options.signal, options.timeoutMs);
    } catch (error) {
      if (ownedPage && page && !page.isClosed()) await completesWithin(page.close(), 2_000).catch(() => false);
      await disposeBrowser(connection.browser, connection.owned, connection.profileDir);
      throw error;
    }
  }

  async run(name: string, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserRunOutput> {
    const entry = this.#tabs.get(name);
    if (!entry) throw new Error(`No tab named "${name}". Open it first.`);
    if (entry.busy) throw new Error(`Tab "${name}" is busy.`);
    if (!code.trim()) throw new Error("Browser run requires non-empty code.");
    throwIfAborted(signal);
    entry.busy = true;
    const displays: BrowserRunOutput["displays"] = [];
    const screenshots: BrowserRunOutput["screenshots"] = [];
    const beforeUrl = entry.page.isClosed() ? "" : entry.page.url();
    let beforePages: Page[] = [];
    try { beforePages = await raceAbort(entry.browser.pages(), signal, Math.min(2_000, timeoutMs)); } catch { /* best-effort */ }
    try {
      const tab = createTabApi(entry, cwd, displays, screenshots, signal, timeoutMs);
      const assert = (condition: unknown, message = "Browser assertion failed") => { if (!condition) throw new Error(message); };
      const wait = (ms: number) => abortableDelay(ms, signal);
      const display = (value: unknown) => displays.push({ type: "text", text: formatDisplay(value) });
      const print = (...values: unknown[]) => displays.push({ type: "text", text: values.map(formatDisplay).join(" ") });
      const capturedConsole = { log: print, info: print, warn: print, error: print, debug: print };
      const execute = compileRunCode(code);
      const returnValue = await raceAbort(execute(entry.page, entry.browser, tab, assert, wait, display, print, signal, capturedConsole), signal, timeoutMs);
      const afterUrl = entry.page.isClosed() ? "" : entry.page.url();
      const navigated = Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl);
      let newTabs: Array<{ url: string }> | undefined;
      try {
        const afterPages = await raceAbort(entry.browser.pages(), signal, Math.min(2_000, timeoutMs));
        const beforeUrls = new Set(beforePages.map((p) => p.url()));
        const added = afterPages.filter((p) => !beforeUrls.has(p.url())).map((p) => ({ url: p.url() }));
        if (added.length > 0) newTabs = added;
      } catch { /* best-effort */ }
      return { displays, returnValue, screenshots, url: afterUrl, navigated: navigated || undefined, newTabs };
    } catch (error) {
      if (isInterruptError(error)) await this.close(name);
      throw browserRunErrorHint(error);
    } finally {
      entry.busy = false;
    }
  }

  async close(name: string): Promise<boolean> {
    const entry = this.#tabs.get(name);
    if (entry) {
      this.#tabs.delete(name);
      await disposeEntry(entry);
      return true;
    }
    const opening = this.#opening.get(name);
    if (!opening) return false;
    opening.abort();
    await opening.promise.catch(() => {});
    return true;
  }

  async closeAll(): Promise<number> {
    const entries = [...this.#tabs.values()];
    const openings = [...this.#opening.values()];
    this.#lifecycle.abort();
    this.#lifecycle = new AbortController();
    for (const opening of openings) opening.abort();
    this.#tabs.clear();
    this.#opening.clear();
    await Promise.allSettled([...entries.map(disposeEntry), ...openings.map((opening) => opening.promise)]);
    return entries.length;
  }

  has(name: string): boolean {
    return this.#tabs.has(name);
  }

  #registerEntry(entry: TabEntry): void {
    const discard = () => { void this.#discardEntry(entry); };
    entry.page.once("close", discard);
    entry.browser.once("disconnected", discard);
    this.#tabs.set(entry.name, entry);
  }

  async #discardEntry(entry: TabEntry): Promise<void> {
    if (this.#tabs.get(entry.name) !== entry) return;
    this.#tabs.delete(entry.name);
    await disposeEntry(entry);
  }

  async #configurePage(entry: TabEntry, options: BrowserOpenOptions): Promise<void> {
    if (options.viewport) {
      await entry.page.setViewport({
        width: options.viewport.width,
        height: options.viewport.height,
        deviceScaleFactor: options.viewport.scale,
      });
    }
    if (entry.dialogHandler) entry.page.off("dialog", entry.dialogHandler);
    entry.dialogHandler = options.dialogs
      ? async (dialog) => { if (options.dialogs === "accept") await dialog.accept(); else await dialog.dismiss(); }
      : undefined;
    if (entry.dialogHandler) entry.page.on("dialog", entry.dialogHandler);
    if (options.url) {
      await raceAbort(entry.page.goto(options.url, { waitUntil: options.waitUntil ?? "load", timeout: options.timeoutMs }), options.signal, options.timeoutMs);
      entry.elementSelectors.clear();
    }
  }

  async #info(entry: TabEntry, reused: boolean, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserTabInfo> {
    return {
      name: entry.name,
      kind: entry.kind,
      url: entry.page.url(),
      title: await raceAbort(entry.page.title(), signal, timeoutMs),
      reused,
      viewport: entry.page.viewport() ?? undefined,
    };
  }
}

function createTabApi(
  entry: TabEntry,
  cwd: string,
  displays: BrowserRunOutput["displays"],
  screenshots: BrowserRunOutput["screenshots"],
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const page = entry.page;
  const deadline = () => Math.max(1, timeoutMs);
  const resolve = async (selectorOrId: string | number): Promise<ElementHandle<Element>> => {
    const selector = typeof selectorOrId === "number" ? entry.elementSelectors.get(selectorOrId) : selectorOrId;
    if (!selector) throw new Error(`Unknown or stale element id: ${selectorOrId}`);
    const handle = await page.$(normalizeSelector(selector));
    if (!handle) throw new Error(`Element not found: ${selector}`);
    return handle as ElementHandle<Element>;
  };
  const api = {
    name: entry.name,
    page,
    signal,
    url: () => page.url(),
    title: () => page.title(),
    async setViewport(viewport: { width: number; height: number; scale?: number }) {
      return page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale });
    },
    async goto(url: string, options?: { waitUntil?: WaitUntil }) {
      entry.elementSelectors.clear();
      return raceAbort(page.goto(url, { waitUntil: options?.waitUntil ?? "load", timeout: deadline() }), signal, deadline());
    },
    async observe(options?: { includeAll?: boolean; viewportOnly?: boolean }) {
      const observed = await page.evaluate(({ includeAll, viewportOnly }) => {
        const interactive = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
        const selector = includeAll
          ? "body *"
          : "a,button,input,select,textarea,summary,[role],[tabindex],[contenteditable='true']";
        const elements = Array.from(document.querySelectorAll(selector));
        const rows: Array<{ selector: string; role: string; name: string; text: string; box?: { x: number; y: number; width: number; height: number } }> = [];
        const cssPath = (element: Element): string => {
          if ((element as HTMLElement).id) return `#${CSS.escape((element as HTMLElement).id)}`;
          const parts: string[] = [];
          let current: Element | null = element;
          while (current && current !== document.body) {
            const parent: Element | null = current.parentElement;
            if (!parent) break;
            const siblings = Array.from(parent.children).filter((item) => item.tagName === current!.tagName);
            const index = siblings.indexOf(current) + 1;
            parts.unshift(`${current.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${index})` : ""}`);
            current = parent;
          }
          return `body > ${parts.join(" > ")}`;
        };
        for (const element of elements) {
          const html = element as HTMLElement;
          const style = getComputedStyle(html);
          const rect = html.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
          if (viewportOnly && (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth)) continue;
          const role = html.getAttribute("role") || html.tagName.toLowerCase();
          const isInteractive = interactive.has(html.tagName) || html.tabIndex >= 0 || html.onclick !== null || ["button", "link", "textbox", "checkbox", "radio", "combobox"].includes(role);
          if (!includeAll && !isInteractive) continue;
          rows.push({
            selector: cssPath(html),
            role,
            name: html.getAttribute("aria-label") || html.getAttribute("title") || (html as HTMLInputElement).placeholder || (html.innerText ?? "").trim().slice(0, 160),
            text: (html.innerText ?? "").trim().slice(0, 240),
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          });
          if (rows.length >= 500) break;
        }
        return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, elements: rows };
      }, options ?? {});
      entry.elementSelectors.clear();
      const elements = observed.elements.map((element, index) => {
        const id = index + 1;
        entry.elementSelectors.set(id, element.selector);
        return { id, role: element.role, name: element.name, text: element.text, box: element.box };
      });
      return { ...observed, elements };
    },
    id: (id: number) => resolve(id),
    ref: (id: number | string) => resolve(typeof id === "string" && /^e?\d+$/.test(id) ? Number(id.replace(/^e/, "")) : id),
    async screenshot(options?: { selector?: string; fullPage?: boolean; save?: string; silent?: boolean }) {
      const source = options?.selector ? await resolve(options.selector) : page;
      const data = await source.screenshot({ type: "png", ...(source === page ? { fullPage: options?.fullPage } : {}) }) as Uint8Array;
      const buffer = Buffer.from(data);
      const destination = options?.save
        ? path.resolve(cwd, options.save)
        : path.join(os.tmpdir(), `pi-maestro-browser-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, buffer, {
        flag: options?.save ? "w" : "wx",
        mode: options?.save ? 0o666 : 0o600,
      });
      if (!options?.save) entry.ownedTempFiles.add(destination);
      const metadata = { path: destination, mimeType: "image/png", bytes: buffer.length };
      screenshots.push(metadata);
      if (!options?.silent) {
        displays.push({ type: "text", text: `Screenshot saved: ${destination}` });
        displays.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/png" });
      }
      return metadata;
    },
    async extract(format: "text" | "html" | "markdown" | "probe" | "list" = "markdown", options?: { fold?: string }) {
      if (format === "html") return page.content();
      if (format === "text" || format === "markdown") return page.evaluate(() => document.body?.innerText ?? "");
      if (format === "list") return page.evaluate(FIND_LISTS_JS) as Promise<Array<Record<string, unknown>>>;
      // "probe": simplified, token-optimized structural HTML.
      const raw = (await page.evaluate(PROBE_JS)) as string;
      let optimized = optimizeHtmlForTokens(raw);
      if (options?.fold !== undefined) {
        const lists = await page.evaluate(FIND_LISTS_JS) as Array<Record<string, unknown>>;
        if (lists.length > 0) {
          const folded = await page.evaluate(foldListsJs({ html: optimized, lists, instruction: options.fold })) as string;
          optimized = folded || optimized;
        }
      }
      return smartTruncate(optimized, 35_000);
    },
    async snapshot() {
      const [html, lists] = await Promise.all([
        page.evaluate(PROBE_JS) as Promise<string>,
        page.evaluate(FIND_LISTS_JS) as Promise<Array<Record<string, unknown>>>,
      ]);
      return { html: optimizeHtmlForTokens(html), lists };
    },
    async diff(before: string | { html: string }, after?: string | { html: string }): Promise<HtmlDiff> {
      const beforeHtml = typeof before === "string" ? before : before.html;
      const afterHtml = after === undefined
        ? optimizeHtmlForTokens((await page.evaluate(PROBE_JS)) as string)
        : typeof after === "string" ? after : after.html;
      return diffHtml(beforeHtml, afterHtml);
    },
    async monitorStart(intervalMs?: number): Promise<boolean> {
      return page.evaluate(monitorStartJs(intervalMs)) as Promise<boolean>;
    },
    async monitorStop(): Promise<string[]> {
      return page.evaluate(MONITOR_STOP_JS) as Promise<string[]>;
    },
    async tabs(): Promise<Array<{ url: string; title?: string }>> {
      const pages = await raceAbort(entry.browser.pages(), signal, Math.min(2_000, deadline()));
      return Promise.all(pages.map(async (p) => ({ url: p.url(), title: p.isClosed() ? undefined : await raceAbort(p.title(), signal, Math.min(1_000, deadline())).catch(() => undefined) })));
    },
    async click(selector: string | number) { await (await resolve(selector)).click(); },
    async type(selector: string | number, text: string) { await (await resolve(selector)).type(text); },
    async fill(selector: string | number, value: string) {
      const handle = await resolve(selector);
      await handle.click({ count: 3 });
      await handle.press("Backspace");
      await handle.type(value);
    },
    async press(key: KeyInput, options?: { selector?: string | number }) {
      if (options?.selector !== undefined) await (await resolve(options.selector)).press(key);
      else await page.keyboard.press(key);
    },
    async scroll(deltaX: number, deltaY: number) { await page.evaluate(({ x, y }) => scrollBy(x, y), { x: deltaX, y: deltaY }); },
    async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
      await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
    },
    async waitFor(selector: string, options?: { timeout?: number }) { return page.waitForSelector(normalizeSelector(selector), { timeout: options?.timeout ?? deadline() }); },
    evaluate: <T>(fn: (...args: unknown[]) => T, ...args: unknown[]) => page.evaluate(fn, ...args),
    async scrollIntoView(selector: string | number) { await (await resolve(selector)).evaluate((element) => element.scrollIntoView({ block: "center" })); },
    async select(selector: string, ...values: string[]) { return page.select(normalizeSelector(selector), ...values); },
    async uploadFile(selector: string | number, ...filePaths: string[]) {
      const handle = await resolve(selector) as ElementHandle<HTMLInputElement>;
      await handle.uploadFile(...filePaths.map((file) => path.resolve(cwd, file)));
    },
    waitForUrl(pattern: string | RegExp, options?: { timeout?: number }) {
      const descriptor = typeof pattern === "string"
        ? { kind: "text", value: pattern, flags: "" }
        : { kind: "regex", value: pattern.source, flags: pattern.flags };
      return page.waitForFunction((expected) => expected.kind === "text" ? location.href.includes(expected.value) : new RegExp(expected.value, expected.flags).test(location.href), { timeout: options?.timeout ?? deadline() }, descriptor);
    },
    waitForResponse(pattern: string | RegExp, options?: { timeout?: number }): Promise<HTTPResponse> {
      return page.waitForResponse((response) => typeof pattern === "string" ? response.url().includes(pattern) : pattern.test(response.url()), { timeout: options?.timeout ?? deadline() });
    },
    waitForSelector(selector: string, options?: { timeout?: number; visible?: boolean; hidden?: boolean }) {
      return page.waitForSelector(normalizeSelector(selector), { timeout: options?.timeout ?? deadline(), visible: options?.visible, hidden: options?.hidden });
    },
    waitForNavigation(options?: WaitForOptions) { return page.waitForNavigation({ timeout: deadline(), ...options }); },
  };
  return api;
}

// Managed browser profiles live in a stable per-key directory instead of a fresh
// random temp dir per launch. Chrome (not puppeteer) owns the directory's lifecycle:
// puppeteer only deletes auto-generated temp profiles, so an explicit userDataDir is
// never rm'd — eliminating the EBUSY crash from lingering chrome child processes —
// and a leftover browser from a crashed session can be detected and reused.
const BROWSER_PROFILE_BASE = process.env.PI_BROWSER_PROFILES_DIR ?? path.join(os.homedir(), ".pi", "browser-profiles");

function profileDirFor(key: string): string {
  return path.join(BROWSER_PROFILE_BASE, createHash("sha1").update(key).digest("hex").slice(0, 16));
}

async function connectBrowser(options: BrowserOpenOptions, key: string): Promise<{ browser: Browser; owned: boolean; kind: "headless" | "headed" | "connected"; reused: boolean; profileDir?: string }> {
  if (options.cdpUrl) {
    const pending = puppeteer.connect({ browserURL: options.cdpUrl.replace(/\/$/, "") });
    const browser = await acquireResource(pending, options.signal, options.timeoutMs, (late) => late.disconnect());
    return { browser, owned: false, kind: "connected", reused: false };
  }
  const executablePath = await findBrowserExecutable(options.executablePath, options.cwd);
  if (!executablePath) throw new Error("No Chromium browser found. Set app.path, app.cdp_url, PUPPETEER_EXECUTABLE_PATH, or CHROME_PATH.");
  const profileDir = profileDirFor(key);
  // Reuse a still-running browser from this or a previous session: every puppeteer
  // launch enables remote debugging, so a live instance leaves DevToolsActivePort.
  const reused = await tryReuseBrowser(profileDir, options);
  if (reused) return { ...reused, owned: true, reused: true, profileDir };
  // A crash can orphan chrome children (e.g. the network service holding
  // first_party_sets.db) that keep the profile locked; reclaim them before relaunching.
  if (await staleProfileProcessesExist(profileDir)) await reclaimProfileProcesses(profileDir);
  const launched = await launchBrowser(executablePath, options, profileDir);
  return { ...launched, owned: true, reused: false, profileDir };
}

async function tryReuseBrowser(profileDir: string, options: BrowserOpenOptions): Promise<{ browser: Browser; kind: "headless" | "headed" } | undefined> {
  const port = await devToolsPortFor(profileDir);
  if (!port) return undefined;
  const pending = puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  try {
    const browser = await acquireResource(pending, options.signal, Math.min(2_000, options.timeoutMs), (late) => late.disconnect());
    return { browser, kind: options.visible ? "headed" : "headless" };
  } catch {
    return undefined;
  }
}

async function devToolsPortFor(profileDir: string): Promise<number | undefined> {
  try {
    const contents = await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8");
    const port = Number(contents.split(/\r?\n/, 1)[0]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

// A live instance leaves a singleton lockfile (Windows: lockfile; POSIX:
// SingletonLock) that only a clean shutdown removes.
async function staleProfileProcessesExist(profileDir: string): Promise<boolean> {
  try { await fs.access(profileDir); } catch { return false; }
  for (const name of process.platform === "win32" ? ["lockfile"] : ["SingletonLock"]) {
    try { await fs.access(path.join(profileDir, name)); return true; } catch {}
  }
  return false;
}

async function reclaimProfileProcesses(profileDir: string): Promise<void> {
  const pids = await findProcessesUsingProfile(profileDir);
  for (const pid of pids) await killProcessTree(pid);
  if (pids.length > 0) await abortableDelay(800, undefined); // let file handles release
}

async function findProcessesUsingProfile(profileDir: string): Promise<number[]> {
  try {
    if (process.platform === "win32") {
      const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      const output = await runCapture("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 20_000);
      const rows = JSON.parse(output) as { ProcessId: number; CommandLine: string } | Array<{ ProcessId: number; CommandLine: string }> | null;
      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
      return list.filter((row) => Boolean(row.CommandLine) && commandLineMentionsProfile(row.CommandLine, profileDir)).map((row) => row.ProcessId);
    }
    const output = await runCapture("ps", ["-axo", "pid=,args="], 10_000);
    const pids: number[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (match && commandLineMentionsProfile(match[2], profileDir)) pids.push(Number(match[1]));
    }
    return pids;
  } catch {
    return [];
  }
}

function commandLineMentionsProfile(commandLine: string, profileDir: string): boolean {
  const lower = process.platform === "win32";
  const normalize = (value: string) => {
    const cleaned = value.replace(/"/g, "").replace(/\\/g, "/").replace(/\/+$/, "");
    return lower ? cleaned.toLowerCase() : cleaned;
  };
  return normalize(commandLine).includes(`--user-data-dir=${normalize(profileDir)}`);
}

async function killProcessTree(pid: number): Promise<void> {
  try {
    if (process.platform === "win32") await runCapture("taskkill", ["/PID", String(pid), "/T", "/F"], 15_000);
    else process.kill(pid, "SIGKILL");
  } catch { /* best-effort; leftover processes are reclaimed on the next open */ }
}

function runCapture(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

async function launchBrowser(executablePath: string, options: BrowserOpenOptions, profileDir: string): Promise<{ browser: Browser; kind: "headless" | "headed" }> {
  const launch = () => puppeteer.launch({
    executablePath,
    headless: !options.visible,
    timeout: options.timeoutMs,
    userDataDir: profileDir,
    args: ["--no-first-run", "--no-default-browser-check", ...(options.args ?? [])],
    defaultViewport: options.viewport ? { width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: options.viewport.scale } : undefined,
  });
  const kind: "headless" | "headed" = options.visible ? "headed" : "headless";
  let pending = launch();
  try {
    const browser = await acquireResource(pending, options.signal, options.timeoutMs, async (late) => { await closeWithin(late, profileDir); });
    return { browser, kind };
  } catch (error) {
    // A zombie instance can survive the first reclaim (process still mid-exit);
    // reclaim again and retry once before failing.
    if (!(error instanceof Error) || !/already running|ProcessSingleton/i.test(error.message)) throw error;
    await reclaimProfileProcesses(profileDir);
    pending = launch();
    const browser = await acquireResource(pending, options.signal, options.timeoutMs, async (late) => { await closeWithin(late, profileDir); });
    return { browser, kind };
  }
}

async function pickPage(browser: Browser, target?: string): Promise<Page | undefined> {
  const pages = await browser.pages();
  if (target) {
    const needle = target.toLowerCase();
    for (const page of pages) {
      if (page.url().toLowerCase().includes(needle) || (await page.title()).toLowerCase().includes(needle)) return page;
    }
    return undefined;
  }
  return pages.find((page) => page.url() !== "about:blank") ?? pages[0];
}

async function disposeEntry(entry: TabEntry): Promise<void> {
  try { if (entry.ownedPage && !entry.page.isClosed()) await completesWithin(entry.page.close(), 2_000); } catch {}
  await disposeBrowser(entry.browser, entry.owned, entry.profileDir);
  await Promise.allSettled([...entry.ownedTempFiles].map((file) => fs.rm(file, { force: true })));
  entry.ownedTempFiles.clear();
}

async function disposeBrowser(browser: Browser, owned: boolean, profileDir?: string): Promise<void> {
  try {
    if (owned) await closeWithin(browser, profileDir);
    else browser.disconnect();
  } catch {
    if (profileDir) await reclaimProfileProcesses(profileDir).catch(() => {});
  }
}

// Graceful CDP close first; on hang, kill the whole process tree, then sweep any
// remaining children by profile marker. Never throws: dispose runs on shutdown
// paths where an unhandled rejection would take the whole process down.
async function closeWithin(browser: Browser, profileDir?: string): Promise<void> {
  try {
    const closed = await completesWithin(browser.close(), 2_000);
    if (closed) return;
  } catch {}
  try {
    const pid = browser.process()?.pid;
    if (pid) await killProcessTree(pid);
  } catch {}
  if (profileDir) await reclaimProfileProcesses(profileDir).catch(() => {});
}

function browserKey(options: BrowserOpenOptions): string {
  if (options.cdpUrl) return `cdp:${options.cdpUrl.replace(/\/$/, "")}`;
  return `launched:${options.visible ? "headed" : "headless"}:${path.resolve(options.cwd, options.executablePath ?? "auto")}:${JSON.stringify(options.args ?? [])}`;
}

function browserOpenRequestKey(options: BrowserOpenOptions, browser: string): string {
  return JSON.stringify({
    browser,
    url: options.url ?? "",
    target: options.target ?? "",
    viewport: options.viewport ?? null,
    waitUntil: options.waitUntil ?? "load",
    dialogs: options.dialogs ?? "accept",
    visible: options.cdpUrl ? null : (options.visible ?? false),
  });
}

async function findBrowserExecutable(explicit: string | undefined, cwd: string): Promise<string | undefined> {
  if (explicit) {
    const resolved = path.resolve(cwd, explicit);
    try { await fs.access(resolved); return resolved; }
    catch { throw new Error(`Browser executable does not exist: ${resolved}`); }
  }
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.platform === "win32" ? path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.platform === "win32" ? path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  const executableNames = process.platform === "win32" ? ["chrome.exe", "msedge.exe", "chromium.exe"] : ["google-chrome", "chromium", "chromium-browser"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of executableNames) {
      const candidate = path.join(directory, name);
      try { await fs.access(candidate); return candidate; } catch {}
    }
  }
  return undefined;
}

function normalizeSelector(selector: string): string {
  if (selector.startsWith("p-text/")) return `text/${selector.slice(7)}`;
  if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice(8)}`;
  if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice(9)}`;
  if (selector.startsWith("p-aria/")) return `aria/${selector.slice(7)}`;
  if (/^p-[^/]+\//.test(selector)) throw new Error(`Unsupported selector engine: ${selector.split("/")[0]}`);
  return selector;
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  if (signal?.aborted) throw abortError();
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Browser operation timed out after ${timeoutMs}ms.`)), timeoutMs);
    onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, interrupt]); }
  finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function acquireResource<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, cleanup: (resource: T) => void | Promise<void>): Promise<T> {
  try {
    return await raceAbort(promise, signal, timeoutMs);
  } catch (error) {
    void promise.then(cleanup, () => {});
    throw error;
  }
}

async function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally {
    clearTimeout(timer!);
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return raceAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal, Math.max(ms + 1_000, 1_000));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function combineSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() { for (const signal of signals) signal?.removeEventListener("abort", abort); },
  };
}

function abortError(): Error {
  const error = new Error("Browser operation aborted.");
  error.name = "AbortError";
  return error;
}

function formatDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

function isInterruptError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /timed out/i.test(error.message));
}

const RUN_HELPER_NAMES = ["page", "browser", "tab", "assert", "wait", "display", "print", "signal", "console"] as const;
const RUN_PARAM_NAMES = RUN_HELPER_NAMES.map((name) => `__pi_${name}`);

// Augments common user run-code errors with actionable browser-context guidance so
// the agent can self-correct instead of repeatedly failing: the top cause of
// `X is not defined` is referencing a Node-side variable inside a
// page.evaluate/tab.evaluate callback (which runs in the page context), and
// tab.click()/type()/fill() return void, so `const x = await tab.click(...)`
// yields undefined rather than a boolean. Unmatched errors pass through untouched.
export function browserRunErrorHint(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error.name === "ReferenceError") {
    const match = error.message.match(/^([A-Za-z_$][\w$]*) is not defined/);
    if (match) {
      error.message +=
        `\nBrowser run hint: \`${match[1]}\` is referenced where it is not defined. ` +
        `Code inside page.evaluate()/tab.evaluate() callbacks runs in the browser page context, ` +
        `so Node-side variables declared in this run are invisible there. ` +
        `Pass values explicitly: await tab.evaluate((v) => …, v), or compute the value inside the callback. ` +
        `Note: tab.click()/tab.type()/tab.fill() return undefined; test element existence with tab.observe() or tab.waitFor().`;
      return error;
    }
  }
  if (error instanceof SyntaxError) {
    error.message += "\nBrowser run hint: the run code failed to parse. Fix the syntax error above and retry.";
  }
  return error;
}

// Wraps user run code so the injected helpers (page, browser, tab, ...) never
// collide with a top-level const/let/class/function the user declares. Helpers
// are bound to collision-resistant parameters and re-exposed as var aliases in
// an outer scope; user code runs in an async IIFE, so its top-level bindings
// live in their own scope (shadowing a helper if reused) while top-level
// return/await keep working.
export function compileRunCode(code: string): (...values: unknown[]) => Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  const aliases = RUN_HELPER_NAMES.map((name, index) => `${name} = ${RUN_PARAM_NAMES[index]}`).join(", ");
  const body = `"use strict";\nvar ${aliases};\nreturn await (async () => {\n${code}\n})();`;
  return new AsyncFunction(...RUN_PARAM_NAMES, body);
}

export const browserManager = new BrowserManager();

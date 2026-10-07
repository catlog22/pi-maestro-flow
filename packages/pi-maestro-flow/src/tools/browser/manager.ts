import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, CDPSession, CookieParam, Dialog, ElementHandle, Frame, HTTPRequest, HTTPResponse, KeyInput, Page, Target, WaitForOptions } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import { PROBE_JS, FIND_LISTS_JS, foldListsJs, monitorStartJs, MONITOR_STOP_JS, optimizeHtmlForTokens, smartTruncate, diffHtml, type HtmlDiff } from "./simplify.ts";
import { PICKER_INJECT_JS, PICKER_POLL_JS, PICKER_TEARDOWN_JS } from "./picker.ts";
import { STEALTH_INIT_JS, STEALTH_LAUNCH_ARGS } from "./stealth.ts";
import { runOcr, runDetect, isLocalVisionError, type OcrOutcome, type DetectOutcome } from "../../providers/local-vision.ts";
import {
  browserBridge,
  type BridgeCommandTerminal,
  type BridgeConnectionIdentity,
  type BridgeAuthMode,
  type BridgeOwnerIdentity,
  type BridgeLeaseIdentity,
  type BridgeResult,
  type BridgeStatus,
  type PairingApproval,
  type PairingRequestInfo,
  type TrackedBridgeCommand,
} from "./bridge-server.ts";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
export type BrowserChannel = "managed" | "profile" | "cdp" | "extension";
export type BrowserOwnership = "owned" | "borrowed";

export interface BrowserCapabilities {
  page: boolean;
  cdp: boolean;
  cookies: boolean;
}

export interface BrowserConnectionInfo {
  channel: BrowserChannel;
  ownership: BrowserOwnership;
  capabilities: BrowserCapabilities;
}

export interface BrowserOpenOptions {
  name: string;
  cwd: string;
  url?: string;
  executablePath?: string;
  cdpUrl?: string;
  channel?: BrowserChannel;
  args?: string[];
  target?: string;
  visible?: boolean;
  viewport?: { width: number; height: number; scale?: number };
  waitUntil?: WaitUntil;
  dialogs?: "accept" | "dismiss";
  attachUserProfile?: boolean;
  userProfileDir?: string;
  /** Optional caller-owned namespace for physically isolated managed browser profiles. */
  isolationKey?: string;
  /** Navigation guard: exact hosts or *.example.com wildcards; deny wins. Not a network sandbox. */
  policy?: BrowserNavigationPolicy;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Declarative navigation guard for managed/profile/cdp channels (browser-use-pi policy.ts port). */
export interface BrowserNavigationPolicy {
  /** Exact hosts or "*.example.com" (apex included). When set, only matching http(s) pages may load. */
  allow?: string[];
  /** Deny wins over allow. */
  deny?: string[];
}

export interface CompiledNavigationPolicy {
  allowed(url: string): boolean;
  /** Blocked navigations observed by the entry-level guards; drained into run output. */
  violations: string[];
}

// Exact hostname or a single leading "*.domain" wildcard (apex included).
export function domainMatcher(pattern: string): (host: string) => boolean {
  if (typeof pattern !== "string" || !pattern || /[\s/@:#?]/.test(pattern))
    throw new Error("Browser policy domains must be hostnames, optionally prefixed with *.");
  const wildcard = pattern.startsWith("*.");
  const name = pattern.slice(wildcard ? 2 : 0);
  if (!name || name.includes("*"))
    throw new Error("Browser policy supports only a leading *. domain wildcard.");
  const domain = new URL(`https://${name}`).hostname.replace(/\.$/, "");
  return (host) => host === domain || (wildcard && host.endsWith(`.${domain}`));
}

// Non-network schemes stay navigable under a policy (inline/test content); a
// policy otherwise gates navigation to http(s) hosts. Not a network sandbox:
// sub-resource requests and run-code fetches are not filtered.
export function compileNavigationPolicy(policy: BrowserNavigationPolicy | undefined): CompiledNavigationPolicy | undefined {
  if (!policy) return undefined;
  if (policy.allow !== undefined && !Array.isArray(policy.allow)) throw new Error("Browser policy.allow must be an array.");
  if (policy.deny !== undefined && !Array.isArray(policy.deny)) throw new Error("Browser policy.deny must be an array.");
  const allow = policy.allow?.map(domainMatcher);
  const deny = policy.deny?.map(domainMatcher) ?? [];
  const allowed = (url: string): boolean => {
    if (["about:blank", ""].includes(url) || /^data:|^blob:/i.test(url)) return true;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false;
      const host = parsed.hostname.replace(/\.$/, "");
      return !deny.some((match) => match(host)) && (allow === undefined || allow.some((match) => match(host)));
    } catch {
      return false;
    }
  };
  return { allowed, violations: [] };
}

function recordPolicyViolation(policy: CompiledNavigationPolicy, kind: string, url: string): void {
  if (policy.violations.length < 20) policy.violations.push(`[policy] blocked ${kind}: ${url}`);
}

export interface BrowserTabInfo {
  name: string;
  kind: "headless" | "headed" | "connected" | "extension";
  connection: BrowserConnectionInfo;
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

export type BrowserPickStatus = "sent" | "escape" | "timeout" | "navigated" | "closed";

export interface BrowserElementCapture {
  kind: "element";
  tagName: string;
  id: string | null;
  selector: string;
  outerHtml: string;
  text: string;
  reactComponentName: string | null;
  vueComponentName: string | null;
  filePath: string | null;
  line: number | null;
}

export interface BrowserConsoleCapture {
  kind: "console";
  errors: string[];
}

export type BrowserCapture = BrowserElementCapture | BrowserConsoleCapture;

export interface BrowserPickResult {
  captures: BrowserCapture[];
  status: BrowserPickStatus;
  /** Live console.error buffer size at pick end (unsent errors are discarded). */
  errorCount: number;
}

export type BrowserPickCaptureCallback = (captures: BrowserCapture[]) => void;

class BrowserOutputCollector {
  private bytes = 0;
  private failure?: Error;
  /** Everything metered so far, capped — spilled to a file when the limit trips. */
  private spillChunks: string[] = [];
  private spillBytes = 0;
  private static readonly spillCap = 1_000_000;
  constructor(private readonly maximum?: number) {}

  private collectSpill(text: string): void {
    if (!text || this.maximum === undefined || this.spillBytes >= BrowserOutputCollector.spillCap) return;
    const budget = BrowserOutputCollector.spillCap - this.spillBytes;
    const piece = Buffer.byteLength(text, "utf8") > budget ? text.slice(0, Math.max(1, Math.floor(budget / 4))) : text;
    this.spillChunks.push(piece);
    this.spillBytes += Buffer.byteLength(piece, "utf8");
  }

  // Ported from browser-use-pi worker.ts: when the output budget trips, the run
  // still fails — but everything captured up to that point is preserved to a
  // file and the error carries its path instead of losing the evidence.
  private overflowError(): Error {
    const captured = this.spillChunks.join("");
    let suffix = "";
    if (captured) {
      try {
        const file = path.join(os.tmpdir(), `pi-maestro-browser-output-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
        writeFileSync(file, captured, { flag: "wx", mode: 0o600 });
        suffix = ` Captured output (pre-limit): ${file}`;
      } catch {
        suffix = " (captured output could not be written to a spill file)";
      }
    }
    return new Error(`Browser output exceeds ${this.maximum} UTF-8 bytes.${suffix}`);
  }

  pushDisplay(displays: BrowserRunOutput["displays"], item: BrowserRunOutput["displays"][number]): void {
    this.collectSpill(item.type === "text" ? item.text : `[image: ${item.mimeType}]`);
    this.reserve(item);
    displays.push(item);
  }

  reserveScreenshot(metadata: BrowserRunOutput["screenshots"][number], imageBase64Bytes: number, silent: boolean): void {
    this.collectSpill(`Screenshot: ${metadata.path ?? "(inline)"}`);
    this.reserve(metadata);
    if (!silent) {
      this.reserve({ type: "text", text: `Screenshot saved: ${metadata.path}` });
      this.reserveBytes(imageBase64Bytes + 64);
    }
  }

  commitScreenshot(
    screenshots: BrowserRunOutput["screenshots"],
    displays: BrowserRunOutput["displays"],
    metadata: BrowserRunOutput["screenshots"][number],
    imageData: string,
    silent: boolean,
  ): void {
    screenshots.push(metadata);
    if (!silent) {
      displays.push({ type: "text", text: `Screenshot saved: ${metadata.path}` });
      displays.push({ type: "image", data: imageData, mimeType: "image/png" });
    }
  }

  maxCollectionItems(): number {
    return this.maximum === undefined ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.min(256, Math.floor(this.maximum / 128)));
  }

  fail(message: string): never {
    this.failure ??= new Error(message);
    throw this.failure;
  }

  reserve(value: unknown): void {
    if (this.failure) throw this.failure;
    if (this.maximum === undefined) return;
    let serialized: string;
    try { serialized = JSON.stringify(value) ?? ""; }
    catch { return this.fail("Browser output is not JSON-serializable."); }
    this.collectSpill(serialized);
    this.reserveBytes(Buffer.byteLength(serialized, "utf8"));
  }

  private reserveBytes(bytes: number): void {
    if (this.failure) throw this.failure;
    if (this.maximum === undefined) return;
    const next = this.bytes + bytes;
    if (next > this.maximum) {
      this.failure ??= this.overflowError();
      throw this.failure;
    }
    this.bytes = next;
  }
}

export interface BrowserNamedTabStatus {
  name: string;
  channel: BrowserChannel;
  ownership: BrowserOwnership;
  capabilities: BrowserCapabilities;
}

export interface BrowserManagerStatus {
  bridge: {
    serverStarted: boolean;
    state: BridgeStatus;
    listeningPort: number | null;
    authenticatedConnected: boolean;
    authMode: BridgeAuthMode;
    transportConnected: boolean;
    transportReady: boolean;
    serverInstanceId: string | null;
    connectionGeneration: number | null;
    /** Number of live Chrome tabs last reported by the ready transport. */
    tabCount: number;
    /** Short-lived, command-inert discovery requests awaiting explicit approval. */
    pendingPairings: PairingRequestInfo[];
    /** Caller-finished extension commands still awaiting a real lifecycle terminal. */
    drainingCommands: number;
  };
  namedTabs: BrowserNamedTabStatus[];
}

export interface BrowserManagerLike {
  open(options: BrowserOpenOptions): Promise<BrowserTabInfo>;
  run(name: string, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, maxOutputBytes?: number): Promise<BrowserRunOutput>;
  pick(name: string, onCapture: BrowserPickCaptureCallback | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserPickResult>;
  status(signal?: AbortSignal): Promise<BrowserManagerStatus>;
  pair(requestId: string, code: string, signal?: AbortSignal): Promise<PairingApproval>;
  close(name: string): Promise<boolean>;
  closeAll(): Promise<number>;
}

type GenericPageHandler = (...args: never[]) => unknown;
type PageEventType = string | symbol;

export async function settleBrowserDialog(
  dialog: Pick<Dialog, "accept" | "dismiss">,
  policy: NonNullable<BrowserOpenOptions["dialogs"]>,
  reportError: (error: unknown) => void = reportBrowserDialogError,
): Promise<void> {
  try {
    if (policy === "accept") await dialog.accept();
    else await dialog.dismiss();
  } catch (error) {
    if (isMissingBrowserDialogError(error)) return;
    reportError(error);
  }
}

function isMissingBrowserDialogError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("Page.handleJavaScriptDialog")
    && /No dialog is showing/i.test(error.message);
}

function reportBrowserDialogError(error: unknown): void {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.warn(`[pi-maestro-flow] browser dialog handling failed: ${reason}`);
}

interface RequestListenerScope {
  failure: Promise<unknown>;
  settle(): Promise<void>;
  cleanup(): void;
}

interface BaseEntry {
  name: string;
  key: string;
  kind: "headless" | "headed" | "connected" | "extension";
  connection: BrowserConnectionInfo;
  ownedTempFiles: Set<string>;
  busy: boolean;
  /** Aborts an in-progress pick() poll loop; set only while pick owns the tab. */
  pickAbort?: AbortController;
}

interface PuppeteerEntry extends BaseEntry {
  backend: "puppeteer";
  kind: "headless" | "headed" | "connected";
  browser: Browser;
  page: Page;
  owned: boolean;
  ownedPage: boolean;
  profileDir?: string;
  dialogHandler?: (dialog: Dialog) => void;
  requestScope?: RequestListenerScope;
  elementSelectors: Map<number, string>;
  cdpSession?: CDPSession;
  /** Compiled navigation guard from open options; undefined disables guarding. */
  policy?: CompiledNavigationPolicy;
  policyGuardsInstalled?: boolean;
}

interface ExtensionTrackedOperation {
  handle: TrackedBridgeCommand;
  draining: boolean;
}

interface ExtensionOperationOwner {
  owner: BridgeOwnerIdentity;
  bridgeIdentity: BridgeConnectionIdentity;
  leases: Map<number, { lease: BridgeLeaseIdentity; owned: boolean }>;
  claims: Map<number, Promise<void>>;
  /** False after timeout/abort or once close starts; no new commands may begin. */
  acceptingCommands: boolean;
  /** Every command terminal owned by this entry, including caller-finished work. */
  terminalOperations: Set<ExtensionTrackedOperation>;
  /** Host-side post-processing that may outlive its bridge command terminal. */
  hostOperations: Set<Promise<void>>;
}

interface ExtensionEntry extends BaseEntry, ExtensionOperationOwner {
  backend: "extension";
  kind: "extension";
  /** Fixed when the named entry is opened; never re-resolved from bridge defaults. */
  tabId: number;
  ownedTab: boolean;
  url: string;
  title: string;
  bridgeIdentity: BridgeConnectionIdentity;
  closed: boolean;
  activeRun: {
    controller: AbortController;
    promise: Promise<BrowserRunOutput>;
  } | null;
  disposePromise: Promise<void> | null;
}

type TabEntry = PuppeteerEntry | ExtensionEntry;

interface OpeningEntry {
  key: string;
  requestKey: string;
  promise: Promise<BrowserTabInfo>;
  abort(): void;
}

type CanonicalBrowserOpenOptions = BrowserOpenOptions & { channel: BrowserChannel };

export function canonicalizeBrowserOpenOptions(options: BrowserOpenOptions): CanonicalBrowserOpenOptions {
  const explicit = options.channel;
  if (explicit) {
    if (options.attachUserProfile === true && explicit !== "profile") {
      throw browserChannelConflict(explicit, "app.attach_user_profile", "profile");
    }
    if (options.cdpUrl && explicit !== "cdp") {
      throw browserChannelConflict(explicit, "app.cdp_url", "cdp");
    }
    if (explicit === "profile" && options.attachUserProfile === false) {
      throw browserChannelConflict(explicit, "app.attach_user_profile=false", "managed");
    }
    if (explicit === "profile" && !options.userProfileDir) {
      throw new Error('app.channel "profile" requires app.user_profile_dir.');
    }
    if (explicit === "cdp" && !options.cdpUrl) {
      throw new Error('app.channel "cdp" requires app.cdp_url.');
    }
    if (explicit === "extension" && options.policy) {
      throw browserChannelConflict(explicit, "app.policy", "managed");
    }
    compileNavigationPolicy(options.policy); // validate patterns eagerly; throws on bad input
    return { ...options, channel: explicit };
  }

  // Preserve the historical precedence when both legacy selectors are present:
  // attach_user_profile won over cdp_url before app.channel existed.
  const channel: BrowserChannel = options.attachUserProfile === true
    ? "profile"
    : options.cdpUrl
      ? "cdp"
      : "managed";
  compileNavigationPolicy(options.policy); // validate patterns eagerly; throws on bad input
  return { ...options, channel };
}

function browserChannelConflict(channel: BrowserChannel, parameter: string, implied: BrowserChannel): Error {
  return new Error(`app.channel ${JSON.stringify(channel)} conflicts with legacy ${parameter}, which selects ${JSON.stringify(implied)}.`);
}

export class BrowserManager implements BrowserManagerLike {
  #tabs = new Map<string, TabEntry>();
  #opening = new Map<string, OpeningEntry>();
  #provisionalExtensionOwners = new Set<ExtensionOperationOwner>();
  #lifecycle = new AbortController();

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    const canonical = canonicalizeBrowserOpenOptions(options);
    throwIfAborted(canonical.signal);
    const key = browserKey(canonical);
    const requestKey = browserOpenRequestKey(canonical, key);
    const pending = this.#opening.get(options.name);
    if (pending) {
      if (pending.requestKey !== requestKey) throw new Error(`Tab "${options.name}" is already opening with different settings.`);
      return { ...(await pending.promise), reused: true };
    }
    let existing = this.#tabs.get(options.name);
    if (existing?.backend === "puppeteer" && (!existing.browser.connected || existing.page.isClosed())) {
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
      const combined = combineSignals(canonical.signal, this.#lifecycle.signal);
      try {
        const effective = { ...canonical, signal: combined.signal };
        await this.#configureEntry(existing, effective);
        return this.#info(existing, true, combined.signal, canonical.timeoutMs);
      } finally {
        combined.dispose();
      }
    }

    const controller = new AbortController();
    const combined = combineSignals(canonical.signal, this.#lifecycle.signal, controller.signal);
    const effective = { ...canonical, signal: combined.signal };
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

  async #openNew(options: CanonicalBrowserOpenOptions, key: string): Promise<BrowserTabInfo> {
    if (options.channel === "extension") return this.#openNewExtension(options, key);

    const connection = await connectBrowser(options, key);
    let page: Page | undefined;
    let ownedPage = false;
    try {
      const pickedPage = await raceAbort(pickPage(connection.browser, options.target), options.signal, options.timeoutMs);
      if (options.target && !pickedPage) throw new Error(`No browser page matched target ${JSON.stringify(options.target)}.`);
      page = pickedPage ?? await raceAbort(connection.browser.newPage(), options.signal, options.timeoutMs);
      ownedPage = connection.owned || !pickedPage;
      const entry: PuppeteerEntry = {
        backend: "puppeteer",
        name: options.name,
        key,
        kind: connection.kind,
        connection: {
          channel: connection.channel,
          ownership: connection.owned ? "owned" : "borrowed",
          capabilities: { page: true, cdp: true, cookies: true },
        },
        browser: connection.browser,
        page,
        owned: connection.owned,
        ownedPage,
        profileDir: connection.profileDir,
        elementSelectors: new Map(),
        ownedTempFiles: new Set(),
        busy: false,
      };
      await this.#configureEntry(entry, options);
      throwIfAborted(options.signal);
      this.#registerEntry(entry);
      return this.#info(entry, connection.reused, options.signal, options.timeoutMs);
    } catch (error) {
      if (ownedPage && page && !page.isClosed()) await completesWithin(page.close(), 2_000).catch(() => false);
      await disposeBrowser(connection.browser, connection.owned, connection.profileDir);
      throw error;
    }
  }

  async #openNewExtension(options: CanonicalBrowserOpenOptions, key: string): Promise<BrowserTabInfo> {
    validateExtensionOpenOptions(options);
    await raceAbort(browserBridge.waitUntilConnected(options.timeoutMs), options.signal, options.timeoutMs);
    throwIfAborted(options.signal);
    const bridgeIdentity = requireExtensionConnection();
    const operationOwner = createExtensionOperationOwner(bridgeIdentity);
    this.#provisionalExtensionOwners.add(operationOwner);
    let entry: ExtensionEntry | undefined;
    let ownedTab = false;
    try {
      const reported = await queryExtensionTabs(bridgeIdentity, options.signal, options.timeoutMs, operationOwner);
      let selected: ExtensionTabState | undefined;

      if (options.target) {
        const needle = options.target.toLowerCase();
        selected = reported.find((tab) => tab.url.toLowerCase().includes(needle) || tab.title.toLowerCase().includes(needle));
        if (!selected) throw new Error(`No browser extension tab matched target ${JSON.stringify(options.target)}.`);
      } else if (options.url) {
        const result = await awaitExtensionBridge(
          bridgeIdentity,
          options.signal,
          options.timeoutMs,
          () => sendOwnedExtensionCommand(operationOwner, "tabs", { method: "create", url: options.url, active: false }, options.timeoutMs),
          operationOwner,
        );
        selected = parseExtensionTab(result.data, "tabs.create");
        ownedTab = true;
      } else {
        selected = reported[0];
        if (!selected) throw new Error("browser-bridge: the ready extension reported no scriptable tabs; pass url to create an owned tab.");
      }

      entry = {
        backend: "extension",
        name: options.name,
        key,
        kind: "extension",
        connection: {
          channel: "extension",
          ownership: ownedTab ? "owned" : "borrowed",
          // This is an honest limited adapter, not a puppeteer Page implementation.
          capabilities: { page: false, cdp: true, cookies: true },
        },
        tabId: selected.id,
        ownedTab,
        url: selected.url,
        title: selected.title,
        bridgeIdentity,
        owner: operationOwner.owner,
        leases: operationOwner.leases,
        claims: operationOwner.claims,
        closed: false,
        acceptingCommands: operationOwner.acceptingCommands,
        terminalOperations: operationOwner.terminalOperations,
        hostOperations: operationOwner.hostOperations,
        activeRun: null,
        disposePromise: null,
        ownedTempFiles: new Set(),
        busy: false,
      };
      this.#provisionalExtensionOwners.delete(operationOwner);

      await ensureExtensionClaim(entry, selected.id, options.timeoutMs);
      await this.#configureEntry(entry, options, ownedTab && !options.target);
      assertExtensionEntryActive(entry, options.signal);
      this.#registerEntry(entry);
      return await this.#info(entry, false, options.signal, options.timeoutMs);
    } catch (error) {
      operationOwner.acceptingCommands = false;
      let cleanupError: unknown;
      if (entry) {
        entry.closed = true;
        entry.acceptingCommands = false;
        cancelExtensionOperations(entry);
        entry.disposePromise ??= disposeEntry(entry);
        try {
          await entry.disposePromise;
        } catch (caught) {
          cleanupError = caught;
        }
        if (this.#tabs.get(entry.name) === entry) this.#tabs.delete(entry.name);
      } else {
        cancelExtensionOperations(operationOwner);
        try { await releaseExtensionOwner(operationOwner); } catch (caught) { cleanupError = caught; }
      }
      this.#retireProvisionalExtensionOwner(operationOwner);
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          `Browser extension open failed for ${JSON.stringify(options.name)} and owned-tab cleanup also failed.`,
        );
      }
      throw error;
    }
  }

  async run(name: string, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, maxOutputBytes?: number): Promise<BrowserRunOutput> {
    const entry = this.#tabs.get(name);
    if (!entry) throw new Error(`No tab named "${name}". Open it first.`);
    if (entry.busy) throw new Error(`Tab "${name}" is busy.`);
    if (!code.trim()) throw new Error("Browser run requires non-empty code.");
    throwIfAborted(signal);
    if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) throw new Error("Browser maxOutputBytes must be a positive integer.");
    if (entry.backend === "extension") {
      assertExtensionEntryAcceptingCommands(entry);
      return this.#runTrackedExtension(entry, code, cwd, signal, timeoutMs, maxOutputBytes);
    }
    return this.#runPuppeteer(entry, code, cwd, signal, timeoutMs, maxOutputBytes);
  }

  // In-page element/component picker (Devin browser_preview port, see
  // devin-re/BROWSER_PREVIEW.md). Injects the picker script into the live page,
  // then polls window.__piElementPick because the extension bridge's CDP path
  // is attach→send→detach and cannot deliver Runtime.bindingCalled events.
  // Each drained batch goes to onCapture so the tool layer can paste it into
  // the user's input box (user-in-the-loop delivery, same as Devin).
  async pick(name: string, onCapture: BrowserPickCaptureCallback | undefined, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserPickResult> {
    const entry = this.#tabs.get(name);
    if (!entry) throw new Error(`No tab named "${name}". Open it first.`);
    if (entry.busy) throw new Error(`Tab "${name}" is busy.`);
    throwIfAborted(signal);
    if (entry.backend === "extension") assertExtensionEntryActive(entry, signal);
    else if (entry.page.isClosed()) throw new Error(`Tab "${name}" page is closed.`);

    const pickAbort = new AbortController();
    const combined = combineSignals(signal, pickAbort.signal, this.#lifecycle.signal);
    entry.busy = true;
    entry.pickAbort = pickAbort;
    const captures: BrowserCapture[] = [];
    let status: BrowserPickStatus = "sent";
    let errorCount = 0;
    const evaluate = async (code: string): Promise<unknown> => {
      if (entry.backend === "extension") {
        const result = await awaitExtensionBridge(
          entry.bridgeIdentity,
          combined.signal,
          timeoutMs,
          () => sendOwnedExtensionCommand(entry, "exec", { tabId: entry.tabId, code }, timeoutMs),
          entry,
        );
        assertExtensionEntryActive(entry, combined.signal);
        return result.data;
      }
      if (entry.page.isClosed()) throw new Error(`Tab "${name}" page is closed.`);
      return raceAbort(entry.page.evaluate(code), combined.signal, timeoutMs);
    };
    try {
      await evaluate(PICKER_INJECT_JS);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        throwIfAborted(combined.signal);
        const remaining = deadline - Date.now();
        if (remaining <= 0) { status = "timeout"; break; }
        let poll: unknown;
        try {
          poll = await evaluate(PICKER_POLL_JS);
        } catch (error) {
          if (isInterruptError(error)) {
            status = (error as Error).name === "AbortError" ? "closed" : "timeout";
            break;
          }
          throw error;
        }
        if (!isRecord(poll)) throw new Error("Browser pick poll returned an unexpected value.");
        if (poll.missing === true) { status = "navigated"; break; }
        const batch = Array.isArray(poll.captures) ? (poll.captures as BrowserCapture[]) : [];
        if (batch.length > 0) {
          captures.push(...batch);
          try { onCapture?.(batch); } catch { /* delivery failure must not kill the pick */ }
        }
        if (typeof poll.errorCount === "number") errorCount = poll.errorCount;
        if (typeof poll.done === "string" && poll.done) {
          status = poll.done === "sent" ? "sent" : "escape";
          break;
        }
        await abortableDelay(Math.min(500, Math.max(50, remaining)), combined.signal);
      }
    } catch (error) {
      if (isInterruptError(error)) {
        // Caller abort or close()/closeAll() via pickAbort: keep whatever was
        // already drained (it was already pasted) and report a graceful end.
        status = (error as Error).name === "AbortError" ? "closed" : "timeout";
      } else {
        throw error;
      }
    } finally {
      try { await evaluate(PICKER_TEARDOWN_JS); } catch { /* page may be gone */ }
      entry.busy = false;
      entry.pickAbort = undefined;
      combined.dispose();
    }
    return { captures, status, errorCount };
  }

  async #runTrackedExtension(
    entry: ExtensionEntry,
    code: string,
    cwd: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    maxOutputBytes?: number,
  ): Promise<BrowserRunOutput> {
    assertExtensionEntryActive(entry, signal);
    const controller = new AbortController();
    const combined = combineSignals(signal, controller.signal);
    const promise = this.#runExtension(entry, code, cwd, combined.signal, timeoutMs, maxOutputBytes);
    entry.activeRun = { controller, promise };
    try {
      return await promise;
    } catch (error) {
      if (isInterruptError(error)) {
        // The caller is finished, but the named binding and every acknowledged
        // command terminal remain manager-owned until an explicit close.
        entry.acceptingCommands = false;
        controller.abort();
        cancelExtensionOperations(entry);
      }
      throw error;
    } finally {
      if (entry.activeRun?.promise === promise) entry.activeRun = null;
      combined.dispose();
    }
  }

  async #runPuppeteer(entry: PuppeteerEntry, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, maxOutputBytes?: number): Promise<BrowserRunOutput> {
    const name = entry.name;
    entry.busy = true;
    const displays: BrowserRunOutput["displays"] = [];
    const screenshots: BrowserRunOutput["screenshots"] = [];
    const output = new BrowserOutputCollector(maxOutputBytes);
    const beforeUrl = entry.page.isClosed() ? "" : entry.page.url();
    // Capture new tabs via the targetcreated event instead of a before/after
    // browser.pages() diff: window.open mid-run can race the after-snapshot and
    // drop tabs that are still attaching (the race GA's extension explicitly
    // avoided with chrome.tabs.onCreated). Collect Targets during the run; the
    // entry page itself is excluded so a same-tab reload is not reported.
    const ownTarget = entry.page.target();
    const createdTargets = new Set<Target>();
    const maxNewTabs = output.maxCollectionItems();
    let targetOverflow = false;
    const onTargetCreated = (target: Target) => {
      if (target.type() !== "page" || target === ownTarget) return;
      if (createdTargets.size >= maxNewTabs) {
        targetOverflow = true;
        void target.page().then((page) => page?.close()).catch(() => undefined);
        return;
      }
      createdTargets.add(target);
    };
    // A tab spawned and closed within the same run must not be reported (same
    // semantics as the old before/after pages diff, which only saw survivors).
    const onTargetDestroyed = (target: Target) => { createdTargets.delete(target); };
    entry.browser.on("targetcreated", onTargetCreated);
    entry.browser.on("targetdestroyed", onTargetDestroyed);
    let requestScope: RequestListenerScope | undefined;
    let runFailed = false;
    let requestFailed = false;
    let cleanupFailed = false;
    try {
      if (entry.requestScope) {
        try {
          entry.requestScope.cleanup();
        } catch (error) {
          cleanupFailed = true;
          throw error;
        }
        entry.requestScope = undefined;
      }
      await disablePageRequestInterception(entry.page);
      requestScope = installRequestListenerScope(entry.page);
      entry.requestScope = requestScope;
      const tab = createTabApi(entry, cwd, displays, screenshots, signal, timeoutMs, output);
      const navGuard = entry.policy
        ? (url: string) => {
            if (!entry.policy!.allowed(url)) {
              recordPolicyViolation(entry.policy!, "goto", url);
              throw new Error(`Browser navigation blocked by domain policy: ${url}`);
            }
          }
        : undefined;
      const runApis = observeBrowserRunApis(name, entry.page, entry.browser, tab, undefined, navGuard);
      const assert = (condition: unknown, message = "Browser assertion failed") => { if (!condition) throw new Error(message); };
      const wait = (ms: number) => abortableDelay(ms, signal);
      const display = (value: unknown) => output.pushDisplay(displays, { type: "text", text: formatDisplay(value) });
      const print = (...values: unknown[]) => output.pushDisplay(displays, { type: "text", text: values.map(formatDisplay).join(" ") });
      const capturedConsole = { log: print, info: print, warn: print, error: print, debug: print };
      const execute = compileRunCode(code);
      const execution = (async () => {
        const value = await execute(runApis.page, runApis.browser, runApis.tab, assert, wait, display, print, signal, capturedConsole);
        await requestScope!.settle();
        return value;
      })();
      const requestFailure = requestScope.failure.then((error) => {
        requestFailed = true;
        requestScope!.cleanup();
        throw error;
      });
      const returnValue = await raceAbort(Promise.race([execution, requestFailure]), signal, timeoutMs);
      output.reserve(returnValue);
      const afterUrl = entry.page.isClosed() ? "" : entry.page.url();
      const navigated = Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl);
      if (targetOverflow) output.fail(`Browser opened more than ${maxNewTabs} new tabs in one run.`);
      let newTabs: Array<{ url: string }> | undefined;
      if (createdTargets.size > 0) {
        const added: Array<{ url: string }> = [];
        for (const target of createdTargets) {
          let item: { url: string };
          try { const page = await raceAbort(target.page(), signal, Math.min(2_000, timeoutMs)); item = { url: page?.url() ?? target.url() }; }
          catch { item = { url: target.url() }; }
          if (!item.url) continue;
          output.reserve(item);
          added.push(item);
        }
        if (added.length > 0) newTabs = added;
      }
      // Surface navigations the entry-level guards blocked during this run.
      if (entry.policy?.violations.length) {
        for (const violation of entry.policy.violations.splice(0)) {
          output.pushDisplay(displays, { type: "text", text: violation });
        }
      }
      output.reserve({ url: afterUrl, navigated: navigated || undefined });
      await raceAbort(Promise.race([requestScope.settle(), requestFailure]), signal, timeoutMs);
      return { displays, returnValue, screenshots, url: afterUrl, navigated: navigated || undefined, newTabs };
    } catch (error) {
      runFailed = true;
      if (requestFailed || isInterruptError(error)) await this.close(name);
      if (requestFailed && error instanceof Error) {
        error.message += "\nBrowser run hint: a request handler failed; the named tab was closed to stop unfinished run code. " +
          "Reopen it before retrying. Before continue/abort/respond, await page.setRequestInterception(true) in the same run, " +
          "and return or await the request resolution promise.";
      }
      throw browserRunErrorHint(error);
    } finally {
      entry.browser.off("targetcreated", onTargetCreated);
      entry.browser.off("targetdestroyed", onTargetDestroyed);
      let cleanupError: unknown;
      try {
        requestScope?.cleanup();
        if (entry.requestScope === requestScope) entry.requestScope = undefined;
        await disablePageRequestInterception(entry.page);
      } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
      }
      if (cleanupFailed && this.#tabs.get(name) === entry) {
        await this.close(name).catch(() => {});
      }
      entry.busy = false;
      if (cleanupError && !runFailed) throw cleanupError;
    }
  }

  async #runExtension(entry: ExtensionEntry, code: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number, maxOutputBytes?: number): Promise<BrowserRunOutput> {
    assertExtensionEntryActive(entry, signal);
    entry.busy = true;
    const displays: BrowserRunOutput["displays"] = [];
    const screenshots: BrowserRunOutput["screenshots"] = [];
    const createdTabs: Array<{ id?: number; url: string }> = [];
    const output = new BrowserOutputCollector(maxOutputBytes);
    const beforeUrl = entry.url;
    try {
      const adapters = createExtensionAdapters(entry, cwd, displays, screenshots, createdTabs, signal, timeoutMs, output);
      const runApis = observeBrowserRunApis(entry.name, adapters.page, adapters.browser, adapters.tab);
      const assert = (condition: unknown, message = "Browser assertion failed") => { if (!condition) throw new Error(message); };
      const wait = (ms: number) => abortableDelay(ms, signal);
      const display = (value: unknown) => output.pushDisplay(displays, { type: "text", text: formatDisplay(value) });
      const print = (...values: unknown[]) => output.pushDisplay(displays, { type: "text", text: values.map(formatDisplay).join(" ") });
      const capturedConsole = { log: print, info: print, warn: print, error: print, debug: print };
      const execute = compileRunCode(code);
      const returnValue = await raceAbort(execute(runApis.page, runApis.browser, runApis.tab, assert, wait, display, print, signal, capturedConsole), signal, timeoutMs);
      output.reserve(returnValue);
      assertExtensionEntryActive(entry, signal);
      const current = await getExtensionTab(entry.tabId, entry.bridgeIdentity, signal, timeoutMs, entry);
      assertExtensionEntryActive(entry, signal);
      entry.url = current.url;
      entry.title = current.title;
      const uniqueTabs = new Map<string, { url: string }>();
      for (const item of createdTabs) {
        if (item.url) uniqueTabs.set(item.id === undefined ? item.url : String(item.id), { url: item.url });
      }
      const newTabs = uniqueTabs.size > 0 ? [...uniqueTabs.values()] : undefined;
      output.reserve({ url: entry.url, navigated: beforeUrl !== entry.url || undefined });
      return {
        displays,
        returnValue,
        screenshots,
        url: entry.url,
        navigated: beforeUrl !== entry.url || undefined,
        newTabs,
      };
    } catch (error) {
      throw browserRunErrorHint(error);
    } finally {
      entry.busy = false;
    }
  }

  async status(signal?: AbortSignal): Promise<BrowserManagerStatus> {
    // Status is an explicit live probe and may start the process-owned bridge;
    // extension open and explicit pair approval are the other startup surfaces.
    await browserBridge.start(signal);
    const listeningPort = browserBridge.listeningPort();
    const transport = browserBridge.transportState();
    const authenticatedConnected = transport.authenticated;
    const reportedState = browserBridge.status();
    const state: BridgeStatus = transport.ready
      ? "connected"
      : reportedState === "connected"
        ? "disconnected"
        : reportedState;
    const namedTabs = [...this.#tabs.values()]
      .map((entry): BrowserNamedTabStatus => ({
        name: entry.name,
        channel: entry.connection.channel,
        ownership: entry.connection.ownership,
        capabilities: { ...entry.connection.capabilities },
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      bridge: {
        serverStarted: listeningPort !== null,
        state,
        listeningPort,
        authenticatedConnected,
        authMode: transport.authMode,
        transportConnected: transport.ready,
        transportReady: transport.ready,
        serverInstanceId: transport.serverInstanceId,
        connectionGeneration: transport.generation,
        tabCount: transport.ready ? browserBridge.tabs().length : 0,
        pendingPairings: transport.authMode === "none" ? [] : browserBridge.pairingRequests(),
        drainingCommands: this.#drainingExtensionCommands(),
      },
      namedTabs,
    };
  }

  async pair(requestId: string, code: string, signal?: AbortSignal): Promise<PairingApproval> {
    await browserBridge.start(signal);
    throwIfAborted(signal);
    // Approval is an atomic credential-delivery commit; once begun, do not
    // misreport a successful approval as aborted after the side effect lands.
    return browserBridge.approvePairing(requestId, code);
  }

  async close(name: string): Promise<boolean> {
    const entry = this.#tabs.get(name);
    if (entry) {
      entry.pickAbort?.abort();
      if (entry.backend === "extension") {
        entry.closed = true;
        entry.acceptingCommands = false;
        cancelExtensionOperations(entry);
        entry.disposePromise ??= disposeEntry(entry);
        try {
          await entry.disposePromise;
        } finally {
          // Retain the binding while draining so the same name cannot reopen
          // against work whose lifecycle terminal has not arrived yet.
          if (this.#tabs.get(name) === entry) this.#tabs.delete(name);
        }
      } else {
        this.#tabs.delete(name);
        await disposeEntry(entry);
      }
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
    const provisionalOwners = [...this.#provisionalExtensionOwners];
    this.#lifecycle.abort();
    this.#lifecycle = new AbortController();
    for (const entry of entries) {
      entry.pickAbort?.abort();
      if (entry.backend === "extension") {
        entry.closed = true;
        entry.acceptingCommands = false;
        cancelExtensionOperations(entry);
        entry.disposePromise ??= disposeEntry(entry);
      }
    }
    for (const owner of provisionalOwners) {
      owner.acceptingCommands = false;
      cancelExtensionOperations(owner);
    }
    for (const opening of openings) opening.abort();
    await Promise.allSettled([
      ...entries.map((entry) => entry.backend === "extension" ? entry.disposePromise! : disposeEntry(entry)),
      ...openings.map((opening) => opening.promise),
      ...provisionalOwners.flatMap((owner) => [
        ...[...owner.terminalOperations].map((operation) => operation.handle.terminal),
        ...owner.hostOperations,
      ]),
    ]);
    for (const entry of entries) if (this.#tabs.get(entry.name) === entry) this.#tabs.delete(entry.name);
    for (const [name, opening] of this.#opening) if (openings.includes(opening)) this.#opening.delete(name);
    for (const owner of provisionalOwners) this.#provisionalExtensionOwners.delete(owner);
    return entries.length;
  }

  has(name: string): boolean {
    return this.#tabs.has(name);
  }

  #drainingExtensionCommands(): number {
    let total = 0;
    for (const entry of this.#tabs.values()) {
      if (entry.backend === "extension") total += drainingExtensionCommandCount(entry);
    }
    for (const owner of this.#provisionalExtensionOwners) total += drainingExtensionCommandCount(owner);
    return total;
  }

  #retireProvisionalExtensionOwner(owner: ExtensionOperationOwner): void {
    if (owner.terminalOperations.size === 0 && owner.hostOperations.size === 0) {
      this.#provisionalExtensionOwners.delete(owner);
      return;
    }
    this.#provisionalExtensionOwners.add(owner);
    const terminals = [
      ...[...owner.terminalOperations].map((operation) => operation.handle.terminal),
      ...owner.hostOperations,
    ];
    void Promise.all(terminals).then(() => this.#provisionalExtensionOwners.delete(owner));
  }

  #registerEntry(entry: TabEntry): void {
    if (entry.backend === "puppeteer") {
      const discard = () => { void this.#discardEntry(entry); };
      entry.page.once("close", discard);
      entry.browser.once("disconnected", discard);
    }
    this.#tabs.set(entry.name, entry);
  }

  async #discardEntry(entry: PuppeteerEntry): Promise<void> {
    if (this.#tabs.get(entry.name) !== entry) return;
    entry.pickAbort?.abort();
    this.#tabs.delete(entry.name);
    await disposeEntry(entry);
  }

  async #configureEntry(entry: TabEntry, options: BrowserOpenOptions, urlAlreadyApplied = false): Promise<void> {
    if (entry.backend === "extension") {
      validateExtensionOpenOptions(options);
      if (!browserBridge.isConnected()) throw extensionDisconnectedError(entry);
      if (options.url && !urlAlreadyApplied) {
        const result = await awaitExtensionBridge(
          entry.bridgeIdentity,
          options.signal,
          options.timeoutMs,
          () => sendOwnedExtensionCommand(entry, "tabs", { method: "update", tabId: entry.tabId, url: options.url }, options.timeoutMs),
          entry,
        );
        assertExtensionEntryActive(entry, options.signal);
        const updated = parseExtensionTab(result.data, "tabs.update");
        if (updated.id !== entry.tabId) throw new Error(`browser-bridge tabs.update changed fixed tabId ${entry.tabId} to ${updated.id}.`);
        entry.url = updated.url;
        entry.title = updated.title;
      }
      return;
    }

    if (entry.kind !== "connected") await entry.page.evaluateOnNewDocument(STEALTH_INIT_JS);
    if (options.viewport) {
      await entry.page.setViewport({
        width: options.viewport.width,
        height: options.viewport.height,
        deviceScaleFactor: options.viewport.scale,
      });
    }
    if (entry.dialogHandler) entry.page.off("dialog", entry.dialogHandler);
    const dialogPolicy = options.dialogs;
    entry.dialogHandler = dialogPolicy
      ? (dialog) => { void settleBrowserDialog(dialog, dialogPolicy); }
      : undefined;
    if (entry.dialogHandler) entry.page.on("dialog", entry.dialogHandler);
    // A re-open without policy clears the guard (options-driven, like dialogs).
    entry.policy = compileNavigationPolicy(options.policy);
    if (entry.policy && !entry.policyGuardsInstalled) {
      entry.policyGuardsInstalled = true;
      installNavigationGuards(entry);
    }
    if (options.url) {
      if (entry.policy && !entry.policy.allowed(options.url)) {
        recordPolicyViolation(entry.policy, "open url", options.url);
        throw new Error(`Browser navigation blocked by domain policy: ${options.url}`);
      }
      await raceAbort(entry.page.goto(options.url, { waitUntil: options.waitUntil ?? "load", timeout: options.timeoutMs }), options.signal, options.timeoutMs);
      entry.elementSelectors.clear();
    }
  }

  async #info(entry: TabEntry, reused: boolean, signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserTabInfo> {
    if (entry.backend === "extension") {
      const current = await getExtensionTab(entry.tabId, entry.bridgeIdentity, signal, timeoutMs, entry);
      assertExtensionEntryActive(entry, signal);
      entry.url = current.url;
      entry.title = current.title;
      return {
        name: entry.name,
        kind: entry.kind,
        connection: { ...entry.connection, capabilities: { ...entry.connection.capabilities } },
        url: entry.url,
        title: entry.title,
        reused,
      };
    }
    return {
      name: entry.name,
      kind: entry.kind,
      connection: {
        ...entry.connection,
        capabilities: { ...entry.connection.capabilities },
      },
      url: entry.page.url(),
      title: await raceAbort(entry.page.title(), signal, timeoutMs),
      reused,
      viewport: entry.page.viewport() ?? undefined,
    };
  }
}

interface ExtensionTabState {
  id: number;
  url: string;
  title: string;
}

const EXTENSION_ADAPTER_CAPABILITIES = [
  "page.url", "page.title", "page.goto(url)", "page.evaluate",
  "browser.pages",
  "tab.name", "tab.page", "tab.signal", "tab.url", "tab.title", "tab.goto(url)", "tab.evaluate", "tab.cdp", "tab.cdpBatch",
  "tab.cookies.get", "tab.cookies.set", "tab.cookies.delete", "tab.tabs", "tab.screenshot",
] as const;

function validateExtensionOpenOptions(options: BrowserOpenOptions): void {
  const unsupported: string[] = [];
  if (options.executablePath) unsupported.push("app.path");
  if (options.args?.length) unsupported.push("app.args");
  if (options.visible !== undefined) unsupported.push("visible");
  if (options.viewport) unsupported.push("viewport");
  if (options.waitUntil) unsupported.push("wait_until");
  if (options.dialogs) unsupported.push("dialogs");
  if (options.userProfileDir) unsupported.push("app.user_profile_dir");
  if (options.policy) unsupported.push("app.policy");
  if (unsupported.length > 0) {
    throw new Error(`Browser extension channel does not support open option(s): ${unsupported.join(", ")}. Supported open selectors: app.target to borrow an existing tab, or url to create an owned tab.`);
  }
  if (options.url) assertExtensionUrl(options.url);
}

function assertExtensionUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Browser extension channel only supports http(s) tab URLs, received ${JSON.stringify(url)}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExtensionTab(value: unknown, operation: string): ExtensionTabState {
  if (!value || typeof value !== "object") throw new Error(`browser-bridge ${operation} returned no tab metadata.`);
  const tab = value as { id?: unknown; url?: unknown; title?: unknown };
  if (!Number.isInteger(tab.id) || typeof tab.url !== "string") {
    throw new Error(`browser-bridge ${operation} returned invalid tab metadata.`);
  }
  return { id: tab.id as number, url: tab.url, title: typeof tab.title === "string" ? tab.title : "" };
}

function requireExtensionConnection(): BridgeConnectionIdentity {
  const identity = browserBridge.connectionIdentity();
  if (!identity) throw new Error("browser-bridge disconnected; extension channel does not fall back to managed Chromium.");
  return identity;
}

function assertExtensionConnection(identity: BridgeConnectionIdentity, signal?: AbortSignal): void {
  throwIfAborted(signal);
  browserBridge.assertConnection(identity);
}

function assertExtensionEntryAcceptingCommands(entry: ExtensionEntry): void {
  if (entry.closed) throw abortError();
  if (!entry.acceptingCommands) {
    throw new Error(`Browser extension entry ${JSON.stringify(entry.name)} is draining after an interrupted command; close it before issuing new commands.`);
  }
}

function assertExtensionEntryActive(entry: ExtensionEntry, signal?: AbortSignal): void {
  assertExtensionEntryAcceptingCommands(entry);
  if (!browserBridge.isConnected()) throw extensionDisconnectedError(entry);
  assertExtensionConnection(entry.bridgeIdentity, signal);
}

function createExtensionOperationOwner(bridgeIdentity: BridgeConnectionIdentity): ExtensionOperationOwner {
  return {
    owner: { namespace: "pi-browser-manager", ownerId: randomUUID() }, bridgeIdentity,
    leases: new Map(), claims: new Map(),
    acceptingCommands: true, terminalOperations: new Set(), hostOperations: new Set(),
  };
}

function adoptExtensionLease(owner: ExtensionOperationOwner, tabId: number, value: unknown, owned: boolean): void {
  if (!isRecord(value) || value.namespace !== owner.owner.namespace || value.ownerId !== owner.owner.ownerId
    || value.serverInstanceId !== owner.bridgeIdentity.serverInstanceId || value.generation !== owner.bridgeIdentity.generation
    || typeof value.claimId !== "string" || !value.claimId) {
    throw new Error(`browser-bridge returned invalid owner lease for tabId ${tabId}.`);
  }
  owner.leases.set(tabId, { lease: value as unknown as BridgeLeaseIdentity, owned });
}

function captureExtensionLeases(owner: ExtensionOperationOwner, result: BridgeResult, created = false): void {
  if (created) {
    const tab = parseExtensionTab(result.data, "tabs.create");
    adoptExtensionLease(owner, tab.id, (result.data as Record<string, unknown>).lease, true);
  }
  for (const item of result.newTabs ?? []) {
    const lease = (item as unknown as Record<string, unknown>).lease;
    if (Number.isInteger(item.id) && lease) adoptExtensionLease(owner, item.id!, lease, true);
  }
}

function ensureExtensionClaim(owner: ExtensionOperationOwner, tabId: number, timeoutMs: number): Promise<void> {
  if (!owner.acceptingCommands) return Promise.reject(new Error("Browser extension command owner is draining."));
  assertExtensionConnection(owner.bridgeIdentity);
  if (owner.leases.has(tabId)) return Promise.resolve();
  const existing = owner.claims.get(tabId);
  if (existing) return existing;
  const claim = trackExtensionHostOperation(owner, (async () => {
    const handle = await browserBridge.sendTracked("claim", { tabId, owner: owner.owner }, timeoutMs, owner.bridgeIdentity);
    const adopt = (result: BridgeResult) => {
      if (!isRecord(result.data) || result.data.tabId !== tabId) throw new Error("browser-bridge claim returned invalid tabId.");
      adoptExtensionLease(owner, tabId, result.data.lease, false);
    };
    void handle.terminal.then((terminal) => { if (terminal.result) adopt(terminal.result); }).catch(() => {});
    const tracked = trackExtensionOperation(owner, handle);
    try { adopt(await handle.response); }
    catch (error) { if (isInterruptError(error)) markExtensionOperationDraining(owner, tracked); throw error; }
  })());
  owner.claims.set(tabId, claim);
  void claim.finally(() => { if (owner.claims.get(tabId) === claim) owner.claims.delete(tabId); }).catch(() => {});
  return claim;
}

function sendOwnedExtensionCommand(owner: ExtensionOperationOwner, cmd: string, payload: Record<string, unknown>, timeoutMs: number): Promise<TrackedBridgeCommand> {
  return trackExtensionHostOperation(owner, (async () => {
    if (!owner.acceptingCommands) throw new Error("Browser extension command owner is draining.");
    if (typeof payload.tabId === "number") await ensureExtensionClaim(owner, payload.tabId, timeoutMs);
    if (!owner.acceptingCommands) throw new Error("Browser extension command owner is draining.");
    assertExtensionConnection(owner.bridgeIdentity);
    const lease = typeof payload.tabId === "number" ? owner.leases.get(payload.tabId)?.lease : undefined;
    const handle = await browserBridge.sendTracked(cmd, { ...payload, owner: owner.owner, ...(lease ? { lease } : {}) }, timeoutMs, owner.bridgeIdentity);
    const created = cmd === "tabs" && payload.method === "create";
    void handle.terminal.then((terminal) => { if (terminal.result) captureExtensionLeases(owner, terminal.result, created); }).catch(() => {});
    trackExtensionOperation(owner, handle);
    const response = handle.response.then((result) => { captureExtensionLeases(owner, result, created); return result; });
    void response.catch(() => {});
    handle.response = response;
    return handle;
  })());
}

async function releaseExtensionOwner(owner: ExtensionOperationOwner): Promise<void> {
  cancelExtensionOperations(owner);
  while (owner.terminalOperations.size || owner.hostOperations.size) {
    await Promise.all([
      ...[...owner.terminalOperations].map((operation) => operation.handle.terminal),
      ...owner.hostOperations,
    ]);
  }
  if (!owner.leases.size) return;
  if (!browserBridge.isConnected() && ![...owner.leases.values()].some((binding) => binding.owned)) return;
  assertExtensionConnection(owner.bridgeIdentity);
  const errors: unknown[] = [];
  for (const [tabId, binding] of owner.leases) {
    try {
      await awaitExtensionBridgeTerminal(owner.bridgeIdentity, 2_000,
        () => browserBridge.sendTracked("release", { tabId, lease: binding.lease, close: binding.owned }, 2_000, owner.bridgeIdentity), owner);
      if (owner.leases.get(tabId) === binding) owner.leases.delete(tabId);
    } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Browser extension lease retirement failed.");
}

function trackExtensionOperation(owner: ExtensionOperationOwner, handle: TrackedBridgeCommand): ExtensionTrackedOperation {
  const existing = [...owner.terminalOperations].find((item) => item.handle === handle);
  if (existing) return existing;
  const operation = { handle, draining: false } satisfies ExtensionTrackedOperation;
  owner.terminalOperations.add(operation);
  void handle.terminal.then(() => owner.terminalOperations.delete(operation));
  return operation;
}

function trackExtensionHostOperation<T>(owner: ExtensionOperationOwner, operation: Promise<T>): Promise<T> {
  const terminal = operation.then(() => undefined, () => undefined);
  owner.hostOperations.add(terminal);
  void terminal.then(() => owner.hostOperations.delete(terminal));
  return operation;
}

function markExtensionOperationDraining(owner: ExtensionOperationOwner, operation: ExtensionTrackedOperation): void {
  owner.acceptingCommands = false;
  operation.draining = true;
  void operation.handle.cancel().catch(() => {});
}

function cancelExtensionOperations(owner: ExtensionOperationOwner): void {
  owner.acceptingCommands = false;
  for (const operation of owner.terminalOperations) {
    operation.draining = true;
    void operation.handle.cancel().catch(() => {});
  }
}

function drainingExtensionCommandCount(owner: ExtensionOperationOwner): number {
  let count = 0;
  for (const operation of owner.terminalOperations) if (operation.draining) count += 1;
  return count;
}

async function awaitExtensionBridge(
  identity: BridgeConnectionIdentity,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: () => Promise<TrackedBridgeCommand>,
  owner?: ExtensionOperationOwner,
): Promise<BridgeResult> {
  assertExtensionConnection(identity, signal);
  if (owner && !owner.acceptingCommands) throw new Error("Browser extension command owner is draining; no new commands may start.");
  const handle = await operation();
  const tracked = owner ? trackExtensionOperation(owner, handle) : undefined;
  try {
    const result = await raceAbort(handle.response, signal, timeoutMs);
    assertExtensionConnection(identity, signal);
    return result;
  } catch (error) {
    if (isInterruptError(error)) {
      if (owner && tracked) markExtensionOperationDraining(owner, tracked);
      else void handle.cancel().catch(() => {});
    }
    throw error;
  }
}

async function awaitExtensionBridgeTerminal(
  identity: BridgeConnectionIdentity,
  timeoutMs: number,
  operation: () => Promise<TrackedBridgeCommand>,
  owner: ExtensionOperationOwner,
): Promise<BridgeResult> {
  const handle = await operation();
  const tracked = trackExtensionOperation(owner, handle);
  let result: BridgeResult | undefined;
  let responseError: unknown;
  try {
    result = await handle.response;
  } catch (error) {
    responseError = error;
    if (isInterruptError(error)) markExtensionOperationDraining(owner, tracked);
  }
  await handle.terminal;
  if (responseError) throw responseError;
  browserBridge.assertConnection(identity);
  if (!result) throw new Error(`browser-bridge command produced no response within ${timeoutMs}ms`);
  return result;
}

async function queryExtensionTabs(
  identity: BridgeConnectionIdentity,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  owner?: ExtensionOperationOwner,
): Promise<ExtensionTabState[]> {
  const result = await awaitExtensionBridge(
    identity,
    signal,
    timeoutMs,
    () => owner ? sendOwnedExtensionCommand(owner, "tabs", { method: "query" }, timeoutMs) : browserBridge.sendTracked("tabs", { method: "query" }, timeoutMs, identity),
    owner,
  );
  if (!Array.isArray(result.data)) throw new Error("browser-bridge tabs.query returned invalid tab metadata.");
  return result.data.map((tab) => parseExtensionTab(tab, "tabs.query"));
}

async function getExtensionTab(
  tabId: number,
  identity: BridgeConnectionIdentity,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  owner?: ExtensionOperationOwner,
): Promise<ExtensionTabState> {
  const result = await awaitExtensionBridge(
    identity,
    signal,
    timeoutMs,
    () => owner ? sendOwnedExtensionCommand(owner, "tabs", { method: "get", tabId }, timeoutMs) : browserBridge.sendTracked("tabs", { method: "get", tabId }, timeoutMs, identity),
    owner,
  );
  const tab = parseExtensionTab(result.data, "tabs.get");
  if (tab.id !== tabId) throw new Error(`browser-bridge tabs.get returned tabId ${tab.id} for fixed tabId ${tabId}.`);
  return tab;
}

function extensionDisconnectedError(entry: ExtensionEntry): Error {
  return new Error(`browser-bridge disconnected from extension entry ${JSON.stringify(entry.name)} (fixed tabId ${entry.tabId}); extension channel does not fall back to managed Chromium.`);
}

function unsupportedExtensionCapability(pathName: string): Error {
  return new Error(`Browser extension adapter does not support ${pathName}. Supported capabilities: ${EXTENSION_ADAPTER_CAPABILITIES.join(", ")}.`);
}

function limitedExtensionAdapter<T extends object>(scope: string, supported: T): T {
  return new Proxy(supported, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      if (typeof property === "symbol") return Reflect.get(target, property, receiver);
      if (Object.prototype.hasOwnProperty.call(target, property)) return Reflect.get(target, property, receiver);
      throw unsupportedExtensionCapability(`${scope}.${property}`);
    },
  });
}

function serializeExtensionEvaluation(pageFunction: string | ((...args: unknown[]) => unknown), args: unknown[]): string {
  validateJsonWireValue(args, "page.evaluate arguments", new Set());
  const serializedArgs = JSON.stringify(args);
  if (typeof pageFunction === "string") return `return await (${pageFunction});`;
  // Rebuild data in the page realm. Direct object-literal interpolation would
  // reinterpret an own __proto__ key as a prototype setter.
  return `return await (${pageFunction.toString()})(...JSON.parse(${JSON.stringify(serializedArgs)}));`;
}

function validateJsonWireValue(value: unknown, location: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`Browser extension ${location} contains a number outside the JSON wire domain.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Browser extension ${location} contains unsupported ${typeof value} outside the JSON wire domain.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`Browser extension ${location} contains a cycle outside the JSON wire domain.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error(`Browser extension ${location}[${index}] is an array hole outside the JSON wire domain.`);
        }
        validateJsonWireValue(value[index], `${location}[${index}]`, ancestors);
      }
      for (const key of ownKeys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new Error(`Browser extension ${location} contains a non-index array property outside the JSON wire domain.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`Browser extension ${location}[${key}] is not a JSON wire data property.`);
        }
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Browser extension ${location} contains unsupported ${prototype?.constructor?.name ?? "object"} outside the JSON wire domain.`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error(`Browser extension ${location} contains a symbol key outside the JSON wire domain.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`Browser extension ${location}.${key} is not an enumerable JSON wire data property.`);
      }
      validateJsonWireValue(descriptor.value, `${location}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function createExtensionAdapters(
  entry: ExtensionEntry,
  cwd: string,
  displays: BrowserRunOutput["displays"],
  screenshots: BrowserRunOutput["screenshots"],
  createdTabs: Array<{ id?: number; url: string }>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  output: BrowserOutputCollector,
): { page: object; browser: object; tab: object } {
  const recordNewTabs = (items: Array<{ id?: number; url?: string }> | undefined) => {
    for (const item of items ?? []) {
      if (!item.url || !(item as unknown as Record<string, unknown>).lease) continue;
      if (createdTabs.length >= output.maxCollectionItems()) output.fail(`Browser opened more than ${output.maxCollectionItems()} new tabs in one run.`);
      const tab = { id: item.id, url: item.url };
      output.reserve(tab);
      createdTabs.push(tab);
    }
  };

  const createPage = (state: ExtensionTabState): object => {
    const refresh = async () => {
      const current = await getExtensionTab(state.id, entry.bridgeIdentity, signal, timeoutMs, entry);
      assertExtensionEntryActive(entry, signal);
      state.url = current.url;
      state.title = current.title;
      if (state.id === entry.tabId) {
        entry.url = current.url;
        entry.title = current.title;
      }
      return current;
    };
    const goto = async (url: string, options?: { waitUntil?: unknown; timeout?: unknown }) => {
      if (options && Object.keys(options).length > 0) throw unsupportedExtensionCapability("page.goto options");
      assertExtensionUrl(url);
      assertExtensionEntryActive(entry, signal);
      const result = await awaitExtensionBridge(
        entry.bridgeIdentity,
        signal,
        timeoutMs,
        () => sendOwnedExtensionCommand(entry, "tabs", { method: "update", tabId: state.id, url }, timeoutMs),
        entry,
      );
      assertExtensionEntryActive(entry, signal);
      const updated = parseExtensionTab(result.data, "tabs.update");
      if (updated.id !== state.id) throw new Error(`browser-bridge tabs.update changed fixed tabId ${state.id} to ${updated.id}.`);
      state.url = updated.url;
      state.title = updated.title;
      if (state.id === entry.tabId) {
        entry.url = updated.url;
        entry.title = updated.title;
      }
      return { url: updated.url, title: updated.title };
    };
    const evaluate = async (pageFunction: string | ((...args: unknown[]) => unknown), ...args: unknown[]) => {
      assertExtensionEntryActive(entry, signal);
      const code = serializeExtensionEvaluation(pageFunction, args);
      const result = await awaitExtensionBridge(
        entry.bridgeIdentity,
        signal,
        timeoutMs,
        () => sendOwnedExtensionCommand(entry, "exec", { tabId: state.id, code }, timeoutMs),
        entry,
      );
      assertExtensionEntryActive(entry, signal);
      recordNewTabs(result.newTabs);
      return result.data;
    };
    return limitedExtensionAdapter("page", {
      url: () => state.url,
      title: async () => (await refresh()).title,
      goto,
      evaluate,
    });
  };

  const page = createPage({ id: entry.tabId, url: entry.url, title: entry.title });
  const cdp = async (method: string, params?: Record<string, unknown>) => {
    assertExtensionEntryActive(entry, signal);
    const result = await awaitExtensionBridge(
      entry.bridgeIdentity,
      signal,
      timeoutMs,
      () => sendOwnedExtensionCommand(entry, "cdp", { tabId: entry.tabId, method, params: params ?? {} }, timeoutMs),
      entry,
    );
    assertExtensionEntryActive(entry, signal);
    if (!isRecord(result.data)) throw new Error(`browser-bridge ${method} returned invalid CDP data.`);
    return result.data;
  };
  const cdpBatch = async (commands: Array<{ method: string; params?: Record<string, unknown> }>) => {
    if (!Array.isArray(commands)) throw new Error("tab.cdpBatch requires an array of CDP commands.");
    const bridged = commands.map((command) => ({ cmd: "cdp", method: command.method, params: command.params ?? {} }));
    const result = await awaitExtensionBridge(
      entry.bridgeIdentity,
      signal,
      timeoutMs,
      () => sendOwnedExtensionCommand(entry, "batch", { commands: bridged, tabId: entry.tabId }, timeoutMs),
      entry,
    );
    assertExtensionEntryActive(entry, signal);
    return result.results ?? [];
  };
  const screenshot = (options?: { selector?: string; fullPage?: boolean; save?: string; silent?: boolean }) => trackExtensionHostOperation(entry, (async () => {
    if (options?.selector) throw unsupportedExtensionCapability("tab.screenshot selector");
    const result = await cdp("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: options?.fullPage ?? false,
    });
    if (typeof result.data !== "string") throw new Error("browser-bridge Page.captureScreenshot returned no base64 PNG data.");
    const buffer = Buffer.from(result.data, "base64");
    const destination = options?.save
      ? path.resolve(cwd, options.save)
      : path.join(os.tmpdir(), `pi-maestro-browser-extension-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const metadata = { path: destination, mimeType: "image/png", bytes: buffer.length };
    output.reserveScreenshot(metadata, Buffer.byteLength(result.data, "utf8"), options?.silent === true);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    assertExtensionEntryActive(entry, signal);
    await fs.writeFile(destination, buffer, { flag: options?.save ? "w" : "wx", mode: options?.save ? 0o666 : 0o600 });
    try {
      assertExtensionEntryActive(entry, signal);
    } catch (error) {
      if (!options?.save) await fs.rm(destination, { force: true }).catch(() => {});
      throw error;
    }
    if (!options?.save) entry.ownedTempFiles.add(destination);
    output.commitScreenshot(screenshots, displays, metadata, result.data, options?.silent === true);
    return metadata;
  })());
  const cookieApi = limitedExtensionAdapter("tab.cookies", {
    async get(filter?: { domain?: string; name?: string }) {
      const result = await awaitExtensionBridge(
        entry.bridgeIdentity,
        signal,
        timeoutMs,
        () => sendOwnedExtensionCommand(entry, "cookies", { method: "get", tabId: entry.tabId, filter }, timeoutMs),
        entry,
      );
      assertExtensionEntryActive(entry, signal);
      return Array.isArray(result.data) ? result.data : [];
    },
    async set(cookies: CookieParam | CookieParam[]) {
      const list = Array.isArray(cookies) ? cookies : [cookies];
      const result = await awaitExtensionBridge(
        entry.bridgeIdentity,
        signal,
        timeoutMs,
        () => sendOwnedExtensionCommand(entry, "cookies", { method: "set", tabId: entry.tabId, cookies: list }, timeoutMs),
        entry,
      );
      assertExtensionEntryActive(entry, signal);
      return result.data;
    },
    async delete(filter: { domain?: string; name?: string }) {
      const result = await awaitExtensionBridge(
        entry.bridgeIdentity,
        signal,
        timeoutMs,
        () => sendOwnedExtensionCommand(entry, "cookies", { method: "delete", tabId: entry.tabId, filter }, timeoutMs),
        entry,
      );
      assertExtensionEntryActive(entry, signal);
      return result.data;
    },
  });
  const tab = limitedExtensionAdapter("tab", {
    name: entry.name,
    page,
    signal,
    url: () => entry.url,
    title: async () => {
      const current = await getExtensionTab(entry.tabId, entry.bridgeIdentity, signal, timeoutMs, entry);
      assertExtensionEntryActive(entry, signal);
      entry.url = current.url;
      entry.title = current.title;
      return current.title;
    },
    goto: (url: string, options?: { waitUntil?: unknown; timeout?: unknown }) => (page as { goto(url: string, options?: object): Promise<unknown> }).goto(url, options),
    evaluate: (pageFunction: string | ((...args: unknown[]) => unknown), ...args: unknown[]) => (page as { evaluate(fn: typeof pageFunction, ...values: unknown[]): Promise<unknown> }).evaluate(pageFunction, ...args),
    cdp,
    cdpBatch,
    cookies: cookieApi,
    tabs: async () => (await queryExtensionTabs(entry.bridgeIdentity, signal, timeoutMs, entry)).map(({ url, title }) => ({ url, title })),
    screenshot,
  });
  const browser = limitedExtensionAdapter("browser", {
    pages: async () => (await queryExtensionTabs(entry.bridgeIdentity, signal, timeoutMs, entry)).map((state) => createPage(state)),
  });
  return { page, browser, tab };
}

function createTabApi(
  entry: PuppeteerEntry,
  cwd: string,
  displays: BrowserRunOutput["displays"],
  screenshots: BrowserRunOutput["screenshots"],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  output: BrowserOutputCollector,
) {
  const page = entry.page;
  const deadline = () => Math.max(1, timeoutMs);
  const ensureCdpSession = async (): Promise<CDPSession> => {
    if (!entry.cdpSession || entry.cdpSession.connection() === null) entry.cdpSession = await page.target().createCDPSession();
    return entry.cdpSession;
  };
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
      const metadata = { path: destination, mimeType: "image/png", bytes: buffer.length };
      const imageBase64Bytes = Math.ceil(buffer.length / 3) * 4;
      output.reserveScreenshot(metadata, imageBase64Bytes, options?.silent === true);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, buffer, {
        flag: options?.save ? "w" : "wx",
        mode: options?.save ? 0o666 : 0o600,
      });
      if (!options?.save) entry.ownedTempFiles.add(destination);
      output.commitScreenshot(screenshots, displays, metadata, buffer.toString("base64"), options?.silent === true);
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
    async cdp(method: string, params?: Record<string, unknown>) {
      const session = await ensureCdpSession();
      return session.send(method as never, params as never) as Promise<Record<string, unknown>>;
    },
    // AX-tree discovery (browser-use-pi page.snapshot port): the accessibility
    // tree is the semantic observation layer — role/name/value plus control
    // state and a backendNodeId that feeds straight into DOM.* CDP commands and
    // the clickNode/typeNode helpers below. Complements observe()/extract():
    // AX sees disabled/checked/pressed state and survives CSS deception.
    async axTree(options?: { maxNodes?: number }) {
      const session = await ensureCdpSession();
      const { nodes } = await session.send("Accessibility.getFullAXTree" as never) as { nodes?: Array<Record<string, unknown>> };
      const limit = Math.max(1, Math.min(5000, Math.floor(options?.maxNodes ?? 1500)));
      const mapped: Array<Record<string, unknown>> = [];
      let eligible = 0;
      for (const node of nodes ?? []) {
        if (node.ignored === true || typeof node.backendDOMNodeId !== "number") continue;
        eligible += 1;
        if (mapped.length >= limit) continue;
        const item: Record<string, unknown> = {
          id: node.backendDOMNodeId,
          role: String((node.role as { value?: unknown } | undefined)?.value ?? ""),
          name: String((node.name as { value?: unknown } | undefined)?.value ?? "").replace(/\s+/g, " ").trim(),
        };
        const value = (node.value as { value?: unknown } | undefined)?.value;
        if (value !== undefined) item.value = String(value);
        for (const prop of (node.properties as Array<{ name?: string; value?: { value?: unknown } }> | undefined) ?? []) {
          const observed = prop.value?.value;
          if (prop.name === "checked" || prop.name === "pressed") {
            if (observed === "mixed") item[prop.name] = "mixed";
            else if (observed === true || observed === "true") item[prop.name] = true;
            else if (observed === false || observed === "false") item[prop.name] = false;
          } else if ((prop.name === "selected" || prop.name === "expanded" || prop.name === "disabled") && typeof observed === "boolean") {
            item[prop.name] = observed;
          }
        }
        mapped.push(item);
      }
      const title = await raceAbort(page.title(), signal, Math.min(1_000, deadline())).catch(() => "");
      return { url: page.url(), title, nodes: mapped, truncated: eligible > mapped.length };
    },
    // backendNodeId -> physical click (browser-use-pi AX recipe): scroll into
    // the layout viewport, read the content quad, click the centroid via the
    // CDP 3-event path. Coordinates hit whatever is visible — check overlays
    // and disabled state (visible on the AX node) first.
    async clickNode(backendNodeId: number, options?: { hoverMs?: number }) {
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new Error("tab.clickNode expects a positive backendNodeId from tab.axTree().");
      const session = await ensureCdpSession();
      await session.send("DOM.scrollIntoViewIfNeeded" as never, { backendNodeId } as never);
      const { model } = await session.send("DOM.getBoxModel" as never, { backendNodeId } as never) as { model?: { content?: number[] } };
      const quad = model?.content;
      if (!quad || quad.length < 8) throw new Error(`tab.clickNode: backendNodeId ${backendNodeId} has no box model (hidden or detached).`);
      await this.cdpClick((quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4, options);
    },
    // Focus by backendNodeId and insert text through the CDP input pipeline
    // (Input.insertText handles arbitrary unicode in one shot). replace:true
    // selects existing content first (native select() for inputs, or
    // selectAllChildren for contenteditable); replace + "" sends Backspace —
    // insertText("") inserts nothing.
    async typeNode(backendNodeId: number, text: string, options?: { replace?: boolean }) {
      if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) throw new Error("tab.typeNode expects a positive backendNodeId from tab.axTree().");
      const session = await ensureCdpSession();
      await session.send("DOM.focus" as never, { backendNodeId } as never);
      if (options?.replace) {
        const { object } = await session.send("DOM.resolveNode" as never, { backendNodeId } as never) as { object?: { objectId?: string } };
        if (object?.objectId) {
          try {
            await session.send("Runtime.callFunctionOn" as never, {
              objectId: object.objectId,
              functionDeclaration: `function() { if (typeof this.select === "function") { this.select(); } else { const s = this.ownerDocument.defaultView.getSelection(); if (s) { s.selectAllChildren(this); } } }`,
            } as never);
          } finally {
            await session.send("Runtime.releaseObject" as never, { objectId: object.objectId } as never).catch(() => {});
          }
        }
        if (text === "") {
          await session.send("Input.dispatchKeyEvent" as never, { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 } as never);
          await session.send("Input.dispatchKeyEvent" as never, { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 } as never);
          return;
        }
      }
      if (text) await session.send("Input.insertText" as never, { text } as never);
    },
    // One-shot CDP event waiter on the page session (browser-use-pi
    // browser.waitFor port): register BEFORE triggering the action — events
    // are not commands and are never replayed.
    async waitForCdp(method: string, options?: { predicate?: (params: Record<string, unknown>) => boolean; timeout?: number }) {
      const session = await ensureCdpSession();
      const timeout = Math.max(1, Math.floor(options?.timeout ?? deadline()));
      const emitter = session as unknown as { on(m: string, h: (p: unknown) => void): void; off(m: string, h: (p: unknown) => void): void };
      return new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
        const finish = (error?: Error, value?: Record<string, unknown>) => {
          clearTimeout(timer);
          emitter.off(method, listener);
          signal?.removeEventListener("abort", abort);
          if (error) rejectPromise(error); else resolvePromise(value ?? {});
        };
        const listener = (params: unknown) => {
          try {
            if (!options?.predicate || options.predicate(params as Record<string, unknown>)) finish(undefined, params as Record<string, unknown>);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        const abort = () => finish(abortError());
        const timer = setTimeout(() => finish(new Error(`CDP event ${method} exceeded ${timeout} ms.`)), timeout);
        emitter.on(method, listener);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    cookies: {
      async get(filter?: { domain?: string; name?: string }) {
        const all = await page.cookies();
        if (!filter) return all;
        return all.filter((cookie) =>
          (!filter.domain || cookie.domain.includes(filter.domain)) &&
          (!filter.name || cookie.name === filter.name),
        );
      },
      async set(cookies: CookieParam | CookieParam[]) {
        const list = Array.isArray(cookies) ? cookies : [cookies];
        await page.setCookie(...list);
      },
      async delete(filter: { domain?: string; name?: string }) {
        const all = await page.cookies();
        for (const cookie of all) {
          if ((!filter.domain || cookie.domain.includes(filter.domain)) && (!filter.name || cookie.name === filter.name)) {
            await page.deleteCookie(cookie);
          }
        }
      },
    },
    // Cross-origin iframe JS execution (B-2.1): puppeteer frames() already holds
    // cross-origin frames with their own execution context; no need for GA's
    // createIsolatedWorld dance.
    async evalInFrame(
      matcher: string | RegExp | ((frame: Frame) => boolean),
      fn: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) {
      const frames = page.frames();
      const match = typeof matcher === "function"
        ? frames.find(matcher)
        : frames.find((frame) => frame === page.mainFrame() ? false : (typeof matcher === "string" ? frame.url().includes(matcher) : matcher.test(frame.url())));
      if (!match) throw new Error(`No iframe matched ${typeof matcher === "string" ? JSON.stringify(matcher) : matcher.toString()}.`);
      return match.evaluate(fn, ...args);
    },
    // Closed Shadow DOM pierce (B-2.2): puppeteer's `pierce/<selector>` engine
    // crosses open AND closed shadow boundaries (unlike `page.$()`). Returns the
    // element center so the caller can follow with tab.cdpClick(x, y). Use the
    // `pierce/` prefix in the selector: tab.pierce('pierce/#shadow-btn').
    async pierce(selector: string) {
      const handle = await page.waitForSelector(`pierce/${selector}`, { timeout: deadline() });
      if (!handle) throw new Error(`pierce(${JSON.stringify(selector)}) found no node.`);
      const box = await handle.evaluate((element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      return { nodeId: 0, x: box.x, y: box.y };
    },
    // Physical-coordinate click (B-2.3): CDP Input.dispatchMouseEvent three-event
    // sequence (moved -> pressed -> released) with a hover dwell so hover-dependent
    // components (MUI Tooltip / Ant Dropdown) open before the press.
    async cdpClick(x: number, y: number, options?: { hoverMs?: number }) {
      if (!entry.cdpSession || entry.cdpSession.connection() === null) entry.cdpSession = await page.target().createCDPSession();
      const session = entry.cdpSession;
      const hoverMs = options?.hoverMs ?? 80;
      const moved = session.send("Input.dispatchMouseEvent" as never, { type: "mouseMoved", x, y } as never);
      await moved;
      await new Promise((resolve) => setTimeout(resolve, hoverMs));
      await session.send("Input.dispatchMouseEvent" as never, { type: "mousePressed", x, y, button: "left", clickCount: 1 } as never);
      await session.send("Input.dispatchMouseEvent" as never, { type: "mouseReleased", x, y, button: "left", clickCount: 1 } as never);
    },
    // Autofill release (B-2.4): bringToFront (Chrome only releases protected values
    // in the foreground tab), click the field via physical coords, then re-dispatch
    // input/change so the framework picks up the now-exposed value.
    async autofillRelease(selector: string) {
      await page.bringToFront();
      const box = await (await resolve(selector)).evaluate((element: Element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await this.cdpClick(box.x, box.y, { hoverMs: 120 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await (await resolve(selector)).evaluate((element) => {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    },
    // Download-dialog bypass (B-2.5): CDP Browser.setDownloadBehavior sets an
    // allow path so Chrome does not block on the "download multiple files" prompt.
    async setDownloadBehavior(downloadPath: string) {
      if (!entry.cdpSession || entry.cdpSession.connection() === null) entry.cdpSession = await page.target().createCDPSession();
      const resolved = path.resolve(cwd, downloadPath);
      await fs.mkdir(resolved, { recursive: true });
      await entry.cdpSession.send("Browser.setDownloadBehavior" as never, { behavior: "allow", downloadPath: resolved } as never);
    },
    // Batched CDP with $N.path chain references (B-2.6): send multiple CDP commands
    // in one round-trip; later commands may reference earlier results via
    // "$<index>.<dotted.path>" strings (recursively resolved from results so far).
    async cdpBatch(commands: Array<{ method: string; params?: Record<string, unknown> }>) {
      if (!entry.cdpSession || entry.cdpSession.connection() === null) entry.cdpSession = await page.target().createCDPSession();
      const session = entry.cdpSession;
      const results: unknown[] = [];
      for (let i = 0; i < commands.length; i += 1) {
        const command = commands[i];
        const resolvedParams = command.params ? resolveDollarRefs(command.params, results) : undefined;
        try {
          const value = await session.send(command.method as never, resolvedParams as never);
          results.push({ ok: true, value });
        } catch (error) {
          results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return results;
    },
    // On-page OCR: capture a PNG and pass its bytes plus browser-origin metadata
    // to the shared RapidOCR/ONNX service. Coordinates stay in screenshot
    // pixels, rooted at (0, 0); the caller can follow with tab.cdpClick().
    async ocr(options?: { region?: { x: number; y: number; w: number; h: number }; fullPage?: boolean; silent?: boolean; langs?: string }) {
      const shot = await this.screenshot({ fullPage: options?.fullPage, silent: options?.silent ?? true });
      const buffer = await fs.readFile(shot.path);
      const dims = await pngDimensions(buffer);
      const outcome: OcrOutcome = await runOcr(buffer, dims.width, dims.height, options?.region, options?.langs);
      return outcome;
    },
    // UI detection uses shared OmniParser/ONNX. Its manifest provenance gate
    // intentionally fails closed when no verified model is available.
    async detect(options?: { mode?: "match" | "crop"; fullPage?: boolean; silent?: boolean; langs?: string }) {
      const shot = await this.screenshot({ fullPage: options?.fullPage, silent: options?.silent ?? true });
      const buffer = await fs.readFile(shot.path);
      const dims = await pngDimensions(buffer);
      const outcome: DetectOutcome = await runDetect(buffer, dims.width, dims.height, options?.mode ?? "match", options?.langs);
      return outcome;
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

// Returns the pixel dimensions of a PNG buffer by reading the IHDR chunk
// (bytes 16..24), avoiding a sharp/zlib dependency just to size a screenshot.
function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Not a PNG buffer (screenshot returned an unexpected format).");
  }
  // IHDR width and height are big-endian uint32 at byte offsets 16 and 20.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw new Error("PNG IHDR reported zero dimensions.");
  return { width, height };
}

// Resolves "$N.dotted.path" references inside a cdpBatch command's params against
// the results collected so far (0-indexed). A failed prior command yields
// undefined for any $N reference (mirroring GA's silent-undefined behavior), so
// callers must check results[i].ok before relying on a referenced value.
function resolveDollarRefs(value: unknown, results: unknown[]): unknown {
  if (typeof value === "string" && /^\$\d+(\.[\w$]+)*$/.test(value)) {
    const [indexPart, ...pathParts] = value.slice(1).split(".");
    const index = Number(indexPart);
    const entry = results[index];
    if (!entry || typeof entry !== "object" || !("value" in entry)) return undefined;
    let current: unknown = (entry as { value: unknown }).value;
    for (const part of pathParts) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  if (Array.isArray(value)) return value.map((item) => resolveDollarRefs(item, results));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveDollarRefs(item, results);
    return out;
  }
  return value;
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

async function connectBrowser(options: CanonicalBrowserOpenOptions, key: string): Promise<{ browser: Browser; owned: boolean; kind: "headless" | "headed" | "connected"; channel: Exclude<BrowserChannel, "extension">; reused: boolean; profileDir?: string }> {
  if (options.channel === "extension") throw new Error("Internal error: extension entries must use the browser-bridge backend.");
  if (options.channel === "profile") {
    if (!options.userProfileDir) throw new Error("attach_user_profile requires app.user_profile_dir pointing at a Chrome user-data-dir whose browser runs with --remote-debugging-port.");
    let endpoint = await devToolsEndpointFor(options.userProfileDir);
    if (!endpoint) {
      // Borrowed profiles are never reclaimed: an existing user browser may
      // still own the directory even when it exposes no debugging endpoint.
      const executablePath = await findBrowserExecutable(options.executablePath, options.cwd);
      if (!executablePath) throw new Error("No Chromium browser found to launch for attach_user_profile. Set app.path, PUPPETEER_EXECUTABLE_PATH, or CHROME_PATH, or start Chrome manually with --remote-debugging-port.");
      endpoint = await launchAttachedChrome(executablePath, options.userProfileDir, options);
    }
    const browser = await connectViaDevtoolsEndpoint(endpoint, options, options.timeoutMs);
    return { browser, owned: false, kind: "connected", channel: "profile", reused: false, profileDir: options.userProfileDir };
  }
  if (options.channel === "cdp") {
    if (!options.cdpUrl) throw new Error('app.channel "cdp" requires app.cdp_url.');
    const cdpUrl = options.cdpUrl.replace(/\/$/, "");
    const pending = /^wss?:\/\//i.test(cdpUrl)
      ? puppeteer.connect({ browserWSEndpoint: cdpUrl })
      : puppeteer.connect({ browserURL: cdpUrl });
    const browser = await acquireResource(pending, options.signal, options.timeoutMs, (late) => late.disconnect());
    return { browser, owned: false, kind: "connected", channel: "cdp", reused: false };
  }
  const executablePath = await findBrowserExecutable(options.executablePath, options.cwd);
  if (!executablePath) throw new Error("No Chromium browser found. Set app.path, app.cdp_url, PUPPETEER_EXECUTABLE_PATH, or CHROME_PATH.");
  const profileDir = profileDirFor(key);
  // Reuse a still-running browser from this or a previous session: every puppeteer
  // launch enables remote debugging, so a live instance leaves DevToolsActivePort.
  const reused = await tryReuseBrowser(profileDir, options);
  if (reused) return { ...reused, owned: true, channel: "managed", reused: true, profileDir };
  // A crash can orphan chrome children (e.g. the network service holding
  // first_party_sets.db) that keep the profile locked; reclaim them before relaunching.
  if (await staleProfileProcessesExist(profileDir)) await reclaimProfileProcesses(profileDir);
  const launched = await launchBrowser(executablePath, options, profileDir);
  return { ...launched, owned: true, channel: "managed", reused: false, profileDir };
}

async function tryReuseBrowser(profileDir: string, options: BrowserOpenOptions): Promise<{ browser: Browser; kind: "headless" | "headed" } | undefined> {
  const endpoint = await devToolsEndpointFor(profileDir);
  if (!endpoint) return undefined;
  try {
    const browser = await connectViaDevtoolsEndpoint(endpoint, options, Math.min(2_000, options.timeoutMs));
    return { browser, kind: options.visible ? "headed" : "headless" };
  } catch {
    return undefined;
  }
}

// DevToolsActivePort carries "<port>\n<ws path>". Both lines are validated so a
// stale or partially-written file cannot be mistaken for a live endpoint
// (browser-use-pi browser.ts port).
export function parseDevToolsActivePort(contents: string): { port: number; wsPath: string } | undefined {
  const [portLine, wsPath] = contents.trim().split(/\r?\n/);
  const port = Number(portLine?.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (typeof wsPath !== "string" || !wsPath.trim().startsWith("/devtools/browser/")) return undefined;
  return { port, wsPath: wsPath.trim() };
}

async function devToolsEndpointFor(profileDir: string): Promise<{ port: number; wsPath: string } | undefined> {
  try {
    return parseDevToolsActivePort(await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8"));
  } catch {
    return undefined;
  }
}

// If HTTP discovery fails, try the recorded WebSocket endpoint directly.
// This cannot bypass a browser's default-profile debugging restriction.
async function connectViaDevtoolsEndpoint(endpoint: { port: number; wsPath: string }, options: BrowserOpenOptions, timeoutMs: number): Promise<Browser> {
  try {
    return await acquireResource(
      puppeteer.connect({ browserURL: `http://127.0.0.1:${endpoint.port}` }),
      options.signal,
      timeoutMs,
      (late) => late.disconnect(),
    );
  } catch (error) {
    try {
      return await acquireResource(
        puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${endpoint.port}${endpoint.wsPath}` }),
        options.signal,
        timeoutMs,
        (late) => late.disconnect(),
      );
    } catch {
      throw error;
    }
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

// Start the user's own Chrome with remote debugging on their profile, then poll
// DevToolsActivePort until the endpoint is ready. The child is detached (unref)
// so it survives pi's exit — the user keeps using their own browser. We do not
// own it; a later attach call in the same session will reuse the live port via
// devToolsEndpointFor + tryReuseBrowser path.
export async function launchAttachedChrome(
  executablePath: string,
  userProfileDir: string,
  options: BrowserOpenOptions,
  spawnBrowser: (command: string, args: string[], options: SpawnOptions) => ChildProcess = spawn,
): Promise<{ port: number; wsPath: string }> {
  throwIfAborted(options.signal);
  if (options.args?.some((arg) => (arg.startsWith("--remote-debugging-port") && arg !== "--remote-debugging-port=0") || arg === "--remote-debugging-pipe")) {
    throw new Error('Profile auto-launch requires --remote-debugging-port=0 to publish DevToolsActivePort. For a fixed debugging port, start the browser manually and use app.channel:"cdp" with app.cdp_url.');
  }
  const args = [
    // Chromium writes DevToolsActivePort only when it selects a dynamic port.
    "--remote-debugging-port=0",
    `--user-data-dir=${userProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.visible ? [] : ["--headless=new"]),
    ...(options.args ?? []),
  ];
  const child = spawnBrowser(executablePath, args, { windowsHide: !options.visible, detached: true, stdio: ["ignore", "ignore", "pipe"] });
  child.unref();
  let launchError: Error | undefined;
  let exited: string | undefined;
  let stderr = "";
  child.once("error", (error) => { launchError = error; });
  child.once("exit", (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_096); });
  const timeoutMs = Math.min(options.timeoutMs, 15_000);
  const deadline = Date.now() + timeoutMs;
  const failure = (reason: string) => new Error(
    `Could not attach ${executablePath} to ${userProfileDir}: ${reason}. ` +
    'Possible causes include a profile already in use or remote debugging disabled by the browser/policy. Chrome 136+ blocks remote debugging of its default user-data directory; closing windows does not remove that restriction. Use an explicitly chosen non-default app.user_profile_dir, or install/pair Pi Browser Bridge and explicitly select app.channel:"extension" for the daily browser. No profile is copied or switched automatically.' +
    (stderr.trim() ? `\nBrowser stderr: ${stderr.trim()}` : ""),
  );
  try {
    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      const ready = await devToolsEndpointFor(userProfileDir);
      throwIfAborted(options.signal);
      if (launchError) throw new Error(`Failed to launch ${executablePath}: ${launchError.message}`, { cause: launchError });
      if (ready) return ready;
      // Windows launchers can exit successfully after handing off to the browser.
      if (exited && exited !== "code 0") throw failure(`browser exited with ${exited} before publishing DevToolsActivePort`);
      if (stderr.includes("requires a non-default data directory")) throw failure("browser rejected remote debugging on the default data directory");
      await abortableDelay(Math.min(300, Math.max(0, deadline - Date.now())), options.signal);
    }
    throw failure(`no DevToolsActivePort appeared within ${timeoutMs / 1000}s after --remote-debugging-port=0`);
  } finally {
    child.stderr?.destroy();
  }
}

async function launchBrowser(executablePath: string, options: BrowserOpenOptions, profileDir: string): Promise<{ browser: Browser; kind: "headless" | "headed" }> {
  const launch = () => puppeteer.launch({
    executablePath,
    headless: !options.visible,
    timeout: options.timeoutMs,
    userDataDir: profileDir,
    args: ["--no-first-run", "--no-default-browser-check", ...STEALTH_LAUNCH_ARGS, ...(options.args ?? [])],
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

// Navigation guard (browser-use-pi policy.ts port, interception-free): the
// entry's own page gets a persistent framenavigated check, and every new page
// target is inspected and closed when denied. Denied loads may briefly start
// before the guard navigates back to about:blank — this bounds where the agent
// can go, it is not a network sandbox and does not filter sub-resources.
function installNavigationGuards(entry: PuppeteerEntry): void {
  const guardPage = (page: Page) => {
    page.on("framenavigated", (frame: Frame) => {
      const policy = entry.policy;
      if (!policy || frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url && !policy.allowed(url)) {
        recordPolicyViolation(policy, "navigation", url);
        void page.goto("about:blank").catch(() => {});
      }
    });
  };
  guardPage(entry.page);
  entry.browser.on("targetcreated", (target) => {
    if (!entry.policy || target.type() !== "page") return;
    const check = (url: string): boolean => {
      if (!url || entry.policy!.allowed(url)) return false;
      recordPolicyViolation(entry.policy!, "new tab", url);
      void target.page().then((page) => page?.close()).catch(() => {});
      return true;
    };
    if (check(target.url())) return;
    void target.page()
      .then((page) => {
        if (!page || page.isClosed()) return;
        if (!check(page.url())) guardPage(page);
      })
      .catch(() => {});
  });
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

export function installRequestListenerScope(page: Page): RequestListenerScope {
  const originalOn = page.on;
  const originalOff = page.off;
  const originalOnce = page.once;
  const callOn = originalOn.bind(page) as unknown as (type: PageEventType, handler: GenericPageHandler) => Page;
  const callOff = originalOff.bind(page) as unknown as (type: PageEventType, handler?: GenericPageHandler) => Page;
  const callOnce = originalOnce.bind(page) as unknown as (type: PageEventType, handler: GenericPageHandler) => Page;
  const wrappers = new Map<GenericPageHandler, GenericPageHandler>();
  const ownedHandlers: GenericPageHandler[] = [];
  const trackedRequests = new WeakSet<HTTPRequest>();
  const pending = new Set<Promise<void>>();
  let active = true;
  let failed = false;
  let failureReason: unknown;
  let reportFailure!: (error: unknown) => void;
  const failure = new Promise<unknown>((resolve) => {
    reportFailure = (error) => {
      if (!active || failed) return;
      failed = true;
      failureReason = error;
      resolve(error);
    };
  });
  const track = (promise: Promise<unknown>): void => {
    const observed = promise.then(() => {}, reportFailure).finally(() => { pending.delete(observed); });
    pending.add(observed);
  };
  const trackRequest = (request: HTTPRequest): void => {
    if (trackedRequests.has(request)) return;
    trackedRequests.add(request);
    // Keep request identity intact and observe even fire-and-forget resolutions.
    const wrapMethod = <K extends "continue" | "abort" | "respond">(method: K): void => {
      const original = request[method].bind(request) as (...args: Parameters<HTTPRequest[K]>) => Promise<void>;
      request[method] = ((...args: Parameters<HTTPRequest[K]>) => {
        const result = (async () => {
          if (!active) throw new Error("Browser request handler belongs to a finished run.");
          return await original(...args);
        })();
        track(result);
        return result;
      }) as HTTPRequest[K];
    };
    for (const method of ["continue", "abort", "respond"] as const) wrapMethod(method);
  };
  const scopedOn = (type: PageEventType, handler: GenericPageHandler): Page => {
    if (type !== "request") return callOn(type, handler);
    let wrapper = wrappers.get(handler);
    if (!wrapper) {
      wrapper = (...args: never[]) => {
        // Puppeteer queues handlers; off() cannot cancel already queued calls.
        if (!active) return;
        const work = (async () => {
          try {
            trackRequest(args[0] as HTTPRequest);
            await handler(...args);
          } catch (error) {
            reportFailure(error);
          }
        })();
        track(work);
        return work;
      };
      wrappers.set(handler, wrapper);
    }
    const result = callOn(type, wrapper);
    ownedHandlers.push(handler);
    return result;
  };
  const scopedOff = (type: PageEventType, handler?: GenericPageHandler): Page => {
    const result = callOff(type, type === "request" && handler ? wrappers.get(handler) ?? handler : handler);
    if (type === "request") {
      if (handler === undefined) {
        ownedHandlers.length = 0;
      } else {
        const index = ownedHandlers.lastIndexOf(handler);
        if (index >= 0) ownedHandlers.splice(index, 1);
      }
    }
    return result;
  };
  const scopedOnce = (type: PageEventType, handler: GenericPageHandler): Page => {
    if (type !== "request") return callOnce(type, handler);
    const onceHandler: GenericPageHandler = (...args) => {
      try { return handler(...args); }
      finally { scopedOff(type, onceHandler); }
    };
    return scopedOn(type, onceHandler);
  };
  page.on = scopedOn as unknown as Page["on"];
  page.off = scopedOff as unknown as Page["off"];
  page.once = scopedOnce as unknown as Page["once"];
  return {
    failure,
    async settle() {
      while (pending.size > 0) await Promise.all([...pending]);
      if (failed) throw failureReason;
    },
    cleanup() {
      if (!active) return;
      active = false;
      let firstError: unknown;
      try {
        for (let index = ownedHandlers.length - 1; index >= 0; index -= 1) {
          try {
            callOff("request", wrappers.get(ownedHandlers[index]!)!);
          } catch (error) {
            firstError ??= error;
          }
        }
      } finally {
        ownedHandlers.length = 0;
        wrappers.clear();
        page.on = originalOn;
        page.off = originalOff;
        page.once = originalOnce;
      }
      if (firstError) throw firstError;
    },
  };
}

async function disablePageRequestInterception(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    await page.setRequestInterception(false);
  } catch (error) {
    if (!page.isClosed()) throw error;
  }
}

async function disposeEntry(entry: TabEntry): Promise<void> {
  if (entry.backend === "extension") {
    let disposeError: unknown;
    try {
      entry.closed = true;
      entry.acceptingCommands = false;
      const activeRun = entry.activeRun;
      if (activeRun) {
        activeRun.controller.abort();
        cancelExtensionOperations(entry);
        await activeRun.promise.catch(() => {});
        if (entry.activeRun === activeRun) entry.activeRun = null;
      }
      // The caller-facing response is not terminal; release only after all
      // generation-owned commands, claims and post-processing have settled.
      await releaseExtensionOwner(entry);
    } catch (error) {
      disposeError = error;
    } finally {
      await Promise.allSettled([...entry.ownedTempFiles].map((file) => fs.rm(file, { force: true })));
      entry.ownedTempFiles.clear();
    }
    if (disposeError) throw disposeError;
    return;
  }
  try { if (entry.cdpSession && entry.cdpSession.connection() !== null) await entry.cdpSession.detach(); } catch {}
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

function browserKey(options: CanonicalBrowserOpenOptions): string {
  if (options.channel === "profile") return `attach:${options.userProfileDir ?? ""}`;
  if (options.channel === "cdp") {
    if (!options.cdpUrl) throw new Error('app.channel "cdp" requires app.cdp_url.');
    return `cdp:${options.cdpUrl.replace(/\/$/, "")}`;
  }
  if (options.channel === "extension") return "extension";
  return `launched:${options.visible ? "headed" : "headless"}:${path.resolve(options.cwd, options.executablePath ?? "auto")}:${JSON.stringify(options.args ?? [])}:${options.isolationKey ?? ""}`;
}

function browserOpenRequestKey(options: CanonicalBrowserOpenOptions, browser: string): string {
  return JSON.stringify({
    browser,
    url: options.url ?? "",
    target: options.target ?? "",
    viewport: options.viewport ?? null,
    waitUntil: options.waitUntil ?? "load",
    dialogs: options.dialogs ?? "accept",
    visible: options.channel === "managed" ? (options.visible ?? false) : null,
    policy: options.policy ?? null,
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

export type BrowserRunPromiseReporter = (operation: string, error: unknown) => void;

function observeBrowserRunPromise(
  value: unknown,
  operation: string,
  report: BrowserRunPromiseReporter,
): unknown {
  if (!(value instanceof Promise)) return value;
  let consumed = false;
  void value.then(
    () => undefined,
    (error) => {
      queueMicrotask(() => {
        if (consumed) return;
        try {
          report(operation, error);
        } catch (reportError) {
          console.warn(`[pi-maestro-flow] failed to report an unobserved browser promise: ${reportError instanceof Error ? reportError.message : String(reportError)}`);
        }
      });
    },
  );
  return new Proxy(value, {
    get(promise, property) {
      if (property === "then" || property === "catch" || property === "finally") {
        return (...args: unknown[]) => {
          consumed = true;
          const method = Reflect.get(promise, property, promise) as (...values: unknown[]) => unknown;
          return observeBrowserRunPromise(Reflect.apply(method, promise, args), operation, report);
        };
      }
      const member = Reflect.get(promise, property, promise);
      return typeof member === "function" ? member.bind(promise) : member;
    },
  });
}

function observeBrowserRunAsyncMethods<T extends object>(
  target: T,
  scope: string,
  report: BrowserRunPromiseReporter,
  beforeCall?: (scope: string, property: PropertyKey, args: unknown[]) => void,
): T {
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  let proxy: T;
  proxy = new Proxy(target, {
    get(inner, property) {
      const value = Reflect.get(inner, property, inner);
      if (typeof value !== "function") return value;
      const cached = methods.get(property);
      if (cached) return cached;
      const wrapped = (...args: unknown[]): unknown => {
        beforeCall?.(scope, property, args);
        const result = Reflect.apply(value, inner, args);
        if (result === inner) return proxy;
        return observeBrowserRunPromise(result, `${scope}.${String(property)}`, report);
      };
      methods.set(property, wrapped);
      return wrapped;
    },
  });
  return proxy;
}

export function observeBrowserRunApis<
  TPage extends object,
  TBrowser extends object,
  TTab extends object,
>(
  name: string,
  page: TPage,
  browser: TBrowser,
  tab: TTab,
  report?: BrowserRunPromiseReporter,
  guardNavigation?: (url: string) => void,
): { page: TPage; browser: TBrowser; tab: TTab } {
  const notify = report ?? ((operation: string, error: unknown) => {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[pi-maestro-flow] browser run ${JSON.stringify(name)} left ${operation} promise unobserved: ${reason}`);
  });
  // Navigation guard (policy open option): rejects before the command flies for
  // the direct goto path; clicks/popups are covered by installNavigationGuards.
  const beforeCall = guardNavigation
    ? (scope: string, property: PropertyKey, args: unknown[]) => {
        if ((scope === "page" || scope === "tab") && property === "goto" && typeof args[0] === "string") {
          guardNavigation(args[0]);
        }
      }
    : undefined;
  const observedPage = observeBrowserRunAsyncMethods(page, "page", notify, beforeCall);
  const observedBrowser = observeBrowserRunAsyncMethods(browser, "browser", notify);
  const nested = tab as TTab & { page?: TPage; cookies?: object };
  if (nested.page) nested.page = observedPage;
  if (nested.cookies) nested.cookies = observeBrowserRunAsyncMethods(nested.cookies, "tab.cookies", notify);
  return {
    page: observedPage,
    browser: observedBrowser,
    tab: observeBrowserRunAsyncMethods(tab, "tab", notify, beforeCall),
  };
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
  if (/^Browser operation timed out after \d+ms\.$/.test(error.message)) {
    error.message +=
      "\nBrowser run hint: timeout is the total wall-clock budget for the entire run, not a per-step allowance. " +
      "Keep the sum of worst-case waits and polling below it with headroom, split long serial cases into separate runs, " +
      "and wait on stable semantic state instead of incidental exact counts or toast text. " +
      "Managed/profile/CDP timeouts close the named tab to stop still-running code, so reopen it before retrying.";
    return error;
  }
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

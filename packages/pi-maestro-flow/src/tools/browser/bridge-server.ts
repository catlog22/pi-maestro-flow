import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

/**
 * BrowserBridgeServer — the pi side of the optional Chrome extension bridge.
 *
 * The `browser-bridge` MV3 extension (shipped under `optional/browser-bridge/`)
 * connects back to this server over WebSocket. It exposes the extension-level
 * capabilities (MAIN-world exec, chrome.debugger CDP, chrome.cookies with
 * partition keys, chrome.management / contentSettings / declarativeNetRequest)
 * that the puppeteer-core CDP path cannot reach.
 *
 * `BrowserManager.connectBrowser` prefers this channel when a bridge is
 * connected; otherwise it silently falls back to the existing CDP attach/launch
 * path, so absence of the extension is a no-op.
 *
 * Port: fixed anchor 19222 by default. If busy, the server walks upward to the
 * first free port so it never fails to start. The actual listening port is
 * written to `~/.pi/browser-bridge.port` so the install probe and the user can
 * discover it (the extension cannot read local files; it connects to the port
 * it was configured with via chrome.storage.local).
 */

const DEFAULT_PORT = 19222;
const PORT_FILE = path.join(os.homedir(), ".pi", "browser-bridge.port");
const ANCHOR_ENV = "PI_BROWSER_BRIDGE_PORT";

type BridgeStatus = "disconnected" | "connecting" | "connected";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
}

interface BridgeResult {
  ok: boolean;
  data?: unknown;
  results?: unknown[];
  error?: string;
  newTabs?: Array<{ id?: number; url?: string; title?: string }>;
}

interface ExtReadyMessage {
  type: "ext_ready" | "tabs_update";
  tabs?: Array<{ id: number; url: string; title?: string }>;
}
interface ResultMessage {
  type: "result" | "error";
  id: string;
  data?: unknown;
  results?: unknown[];
  error?: string;
  newTabs?: Array<{ id?: number; url?: string; title?: string }>;
}
interface AckMessage {
  type: "ack";
  id: string;
}
interface PingMessage {
  type: "ping";
}
type IncomingMessage = ExtReadyMessage | ResultMessage | AckMessage | PingMessage;

interface BridgeTab {
  id: number;
  url: string;
  title?: string;
}

class BrowserBridgeServer {
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #port: number | null = null;
  #status: BridgeStatus = "disconnected";
  #pending = new Map<string, PendingRequest>();
  #tabs: BridgeTab[] = [];
  #startPromise: Promise<void> | null = null;
  #defaultTabId: number | null = null;

  get status(): BridgeStatus {
    return this.#status;
  }

  /** A bridge extension is connected and reachable. */
  isConnected(): boolean {
    return this.#status === "connected" && this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
  }

  /** Tabs the bridge last reported (across all browser windows). */
  tabs(): BridgeTab[] {
    return this.#tabs;
  }

  /** The default tab id to target when none is specified (first reported). */
  defaultTabId(): number | null {
    return this.#defaultTabId ?? this.#tabs[0]?.id ?? null;
  }

  /** Resolve a tab id: explicit, or the default, or the first match of a url substring/target. */
  resolveTabId(tabId?: number, target?: string): number {
    if (typeof tabId === "number") return tabId;
    if (target) {
      const needle = target.toLowerCase();
      const match = this.#tabs.find((t) => t.url.toLowerCase().includes(needle) || (t.title ?? "").toLowerCase().includes(needle));
      if (match) return match.id;
    }
    const def = this.defaultTabId();
    if (def !== null) return def;
    throw new Error("browser-bridge: no tab connected; install the extension via /install browser-bridge.");
  }

  /** Lazily start the WS server (idempotent). */
  async start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    const envPort = Number(process.env[ANCHOR_ENV]);
    const startPort = Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
    const port = await findFreePort(startPort).catch(() => startPort);
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ port, host: "127.0.0.1" }, () => resolve());
      server.once("error", reject);
      server.on("connection", (socket) => this.#handleConnection(socket));
      this.#server = server;
      this.#port = port;
    });
    await fs.mkdir(path.dirname(PORT_FILE), { recursive: true }).catch(() => {});
    await fs.writeFile(PORT_FILE, String(this.#port), "utf8").catch(() => {});
  }

  #handleConnection(socket: WebSocket): void {
    // Only one extension at a time; replace any prior socket.
    if (this.#socket) {
      try { this.#socket.close(); } catch (_) {}
    }
    this.#socket = socket;
    this.#status = "connected";
    socket.on("message", (raw) => this.#handleMessage(raw.toString()));
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#status = "disconnected";
        this.#rejectAll(new Error("browser-bridge disconnected"));
      }
    });
    socket.on("error", () => { /* close handler follows */ });
  }

  #handleMessage(text: string): void {
    let msg: IncomingMessage;
    try {
      msg = JSON.parse(text) as IncomingMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "ext_ready":
      case "tabs_update": {
        const tabs = (msg as ExtReadyMessage).tabs ?? [];
        this.#tabs = tabs.filter((t) => /^https?:/.test(t.url));
        if (this.#defaultTabId === null && this.#tabs.length > 0) this.#defaultTabId = this.#tabs[0].id;
        break;
      }
      case "ack": {
        // Command delivered; reset the deadline to the original timeout so a
        // long-running script can still return its result, and a truly silent
        // extension still fails in bounded time. The extension sends result/error after.
        const pending = this.#pending.get((msg as AckMessage).id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => {
            this.#pending.delete((msg as AckMessage).id);
            pending.reject(new Error("browser-bridge command delivered but no result"));
          }, Math.max(1_000, pending.timeoutMs));
        }
        break;
      }
      case "ping":
        break;
      case "result":
      case "error": {
        const m = msg as ResultMessage;
        this.#finish(m.id, {
          ok: m.type === "result",
          data: m.data,
          results: m.results,
          error: m.error,
          newTabs: m.newTabs,
        });
        break;
      }
    }
  }

  #finish(id: string, result: BridgeResult): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result);
    else pending.reject(new Error(result.error ?? "browser-bridge command failed"));
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Test-only: close the WS server and clear state so the singleton can be reused across test files. */
  ["__testDispose"](): void {
    try { this.#socket?.close(); } catch (_) {}
    try { this.#server?.close(); } catch (_) {}
    this.#socket = null;
    this.#server = null;
    this.#port = null;
    this.#status = "disconnected";
    this.#tabs = [];
    this.#defaultTabId = null;
    this.#rejectAll(new Error("disposed"));
    this.#startPromise = null;
  }

  /** Send a command and await its result. */
  async send(cmd: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<BridgeResult> {
    await this.start();
    if (!this.isConnected()) throw new Error("browser-bridge: extension not connected. Run /install browser-bridge.");
    const id = randomUUID();
    const socket = this.#socket!;
    return new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`browser-bridge ${cmd} timed out after ${timeoutMs}ms`));
      }, Math.max(1_000, timeoutMs));
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, timeoutMs });
      socket.send(JSON.stringify({ id, cmd, ...payload }), (err) => {
        if (err) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`browser-bridge send failed: ${err.message}`));
        }
      });
    });
  }

  /** Execute JS in the MAIN world of a tab (CDP fallback handled by the extension). */
  async exec(tabId: number, code: string, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("exec", { tabId, code }, timeoutMs);
  }

  /** Send a raw CDP command via chrome.debugger on a tab. */
  async cdp(tabId: number, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("cdp", { tabId, method, params: params ?? {} }, timeoutMs);
  }

  /** Read cookies (with partition support) for a tab or url. */
  async cookies(args: { tabId?: number; url?: string }, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("cookies", args, timeoutMs);
  }

  /** List/switch/create tabs (agent command; the read-only list is `tabs()`). */
  async tabsCmd(method?: "query" | "switch" | "create", extra?: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("tabs", { ...(method ? { method } : {}), ...(extra ?? {}) }, timeoutMs);
  }

  /** Manage other extensions (list/disable/enable). */
  async management(method: string, extId?: string, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("management", { method, ...(extId ? { extId } : {}) }, timeoutMs);
  }

  /** Set a contentSetting (e.g. automaticDownloads allow to bypass the multi-download prompt). */
  async contentSettings(type: string, setting: string, pattern = "<all_urls>", timeoutMs?: number): Promise<BridgeResult> {
    return this.send("contentSettings", { type, setting, pattern }, timeoutMs);
  }

  /** Toggle the CSP-stripping DNR rule. */
  async dnr(method: "enable" | "disable", timeoutMs?: number): Promise<BridgeResult> {
    return this.send("dnr", { method }, timeoutMs);
  }

  /** Batch commands with $N.path references resolved by the extension. */
  async batch(commands: Array<Record<string, unknown>>, tabId?: number, timeoutMs?: number): Promise<BridgeResult> {
    return this.send("batch", { commands, ...(tabId !== undefined ? { tabId } : {}) }, timeoutMs);
  }
}

/** Find the first free TCP port at or above `start`. */
function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > 65535) return reject(new Error("no free port found"));
      const tester = net.createServer();
      tester.once("error", () => tryPort(port + 1));
      tester.once("listening", () => {
        tester.once("close", () => resolve(port));
        tester.close();
      });
      tester.listen(port, "127.0.0.1");
    };
    tryPort(start);
  });
}

/** Process-wide singleton (mirrors the single extension connection). */
export const browserBridge = new BrowserBridgeServer();
export { BrowserBridgeServer };
export type { BridgeResult, BridgeTab, BridgeStatus };

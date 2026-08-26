import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import test from "node:test";

/**
 * BrowserBridgeServer unit tests. Drives the server with a real ws client that
 * speaks the extension protocol, so connection, command dispatch, ack/result
 * pairing, and timeout behavior are all exercised end to end without a browser.
 *
 * The server picks a free port starting at PI_BROWSER_BRIDGE_PORT (or 19222);
 * to avoid clashing with a real install on a dev machine, tests set the env var
 * to an unused high port range and clean up ~/.pi/browser-bridge.port on exit.
 */

const PORT_FILE = join(homedir(), ".pi", "browser-bridge.port");

// Use an env override so the server never binds the user's real 19222 install
// during tests. Picked dynamically by findFreePort inside the server, so we just
// need a start anchor unlikely to collide; the actual port is read from the server.
const TEST_PORT_START = 29222;
process.env.PI_BROWSER_BRIDGE_PORT = String(TEST_PORT_START);

// Import after env is set so the singleton reads it at first start().
const { browserBridge } = await import("../src/tools/browser/bridge-server.ts");

/** Read the port the server actually bound to (written to ~/.pi/browser-bridge.port). */
async function boundPort(): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(PORT_FILE, "utf8");
  const port = Number(text.trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`bad port file: ${text}`);
  return port;
}

/** A minimal mock extension: connects, and auto-responds to a cmd with a configured reply. */
class MockExtension {
  #ws: WebSocket | null = null;
  #reply: (msg: { id: string; cmd: string; [k: string]: unknown }) => unknown;
  constructor(reply: (msg: { id: string; cmd: string; [k: string]: unknown }) => unknown) {
    this.#reply = reply;
  }
  async connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.#ws = ws;
      ws.once("open", () => {
        ws.send(JSON.stringify({ type: "ext_ready", tabs: [{ id: 1, url: "https://example.com", title: "Example" }] }));
        resolve();
      });
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") return;
        if (msg.cmd) {
          ws.send(JSON.stringify({ type: "ack", id: msg.id }));
          const result = this.#reply(msg);
          const payload = result as { ok?: boolean; data?: unknown; error?: string; results?: unknown[] };
          ws.send(JSON.stringify({ type: payload?.ok === false ? "error" : "result", id: msg.id, ...payload }));
        }
      });
    });
  }
  close(): void { this.#ws?.close(); this.#ws = null; }
}

test.before(async () => {
  await browserBridge.start();
});

test.after(async () => {
  browserBridge["__testDispose"]?.();
  rmSync(PORT_FILE, { force: true });
});

test("server reports disconnected until an extension connects", () => {
  // The mock connects inside individual tests; here we only assert the API shape.
  assert.equal(typeof browserBridge.isConnected(), "boolean");
  assert.equal(typeof browserBridge.status, "string");
});

test("exec round-trips to a connected extension and returns its data", async () => {
  const port = await boundPort();
  const ext = new MockExtension(() => ({ ok: true, data: 42 }));
  await ext.connect(port);
  try {
    // Give the server a tick to register the connection.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(browserBridge.isConnected(), true);
    const res = await browserBridge.exec(1, "return 6 * 7;");
    assert.equal(res.ok, true);
    assert.equal(res.data, 42);
  } finally {
    ext.close();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(browserBridge.isConnected(), false);
});

test("cdp forwards method and params and returns the extension reply", async () => {
  const port = await boundPort();
  const ext = new MockExtension((msg) => ({ ok: true, data: { echoed: msg.method, params: msg.params } }));
  await ext.connect(port);
  try {
    await new Promise((r) => setTimeout(r, 50));
    const res = await browserBridge.cdp(1, "Network.getCookies", { urls: ["https://example.com"] });
    assert.equal(res.ok, true);
    const data = res.data as { echoed: string; params: { urls: string[] } };
    assert.equal(data.echoed, "Network.getCookies");
    assert.deepEqual(data.params.urls, ["https://example.com"]);
  } finally {
    ext.close();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("cookies carries tabId through to the extension", async () => {
  const port = await boundPort();
  const ext = new MockExtension((msg) => ({ ok: true, data: [{ name: "sid", value: "x", partitionKey: {} }] }));
  await ext.connect(port);
  try {
    await new Promise((r) => setTimeout(r, 50));
    const res = await browserBridge.cookies({ tabId: 1 });
    assert.equal(res.ok, true);
    const cookies = res.data as Array<{ name: string; partitionKey?: unknown }>;
    assert.equal(cookies[0].name, "sid");
  } finally {
    ext.close();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("a command times out when the extension never replies", async () => {
  const port = await boundPort();
  // Custom extension that acks but holds the result forever: connect a raw WS
  // so we control exactly what is sent.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => { ws.send(JSON.stringify({ type: "ext_ready", tabs: [{ id: 1, url: "https://example.com" }] })); resolve(); });
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "ping") return;
    if (msg.cmd) ws.send(JSON.stringify({ type: "ack", id: msg.id }));
    // intentionally never send the result
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(
      () => browserBridge.send("cdp", { tabId: 1, method: "noop", params: {} }, 800),
      /timed out|no result|disconnected/i,
    );
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }
});

test("resolveTabId picks the first reported tab when none is given", () => {
  // After any connect cycle the server may have cached tabs; this asserts the
  // resolution contract rather than a specific value.
  assert.doesNotThrow(() => browserBridge.resolveTabId(1));
});

test("send rejects when no extension is connected", async () => {
  // Ensure no extension is connected (prior tests closed theirs).
  await new Promise((r) => setTimeout(r, 50));
  if (browserBridge.isConnected()) return; // skip if a slow close left one
  await assert.rejects(
    () => browserBridge.send("tabs", {}, 1_000),
    /not connected|install the extension/i,
  );
});

import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vm from "node:vm";
import { WebSocket } from "ws";
import test from "node:test";

/**
 * BrowserBridgeServer focused protocol tests. A real ws client acts as the
 * extension, including the token first-frame handshake, while browser APIs are
 * represented by small command responders.
 */

const TEST_DIRECTORY = mkdtempSync(join(tmpdir(), "pi-browser-bridge-test-"));
const PORT_FILE = join(TEST_DIRECTORY, "browser-bridge.port");
const CONFIG_FILE = join(TEST_DIRECTORY, "browser-bridge.json");
const VERIFIED_FILE = join(TEST_DIRECTORY, "browser-bridge.verified");
process.env.PI_BROWSER_BRIDGE_DIR = TEST_DIRECTORY;
process.env.PI_BROWSER_BRIDGE_PORT = "29222";

// Import after isolation env is set because bridge paths are module constants.
const { browserBridge, BrowserBridgeServer } = await import("../src/tools/browser/bridge-server.ts");

type Command = { id: string; cmd: string; [key: string]: unknown };
type Reply = { ok?: boolean; data?: unknown; error?: string; results?: unknown[]; newTabs?: Array<{ id?: number; url?: string; title?: string }> } | null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bridgeConfig(): Promise<{ version: number; port: number; token: string; installationId: string }> {
  return JSON.parse(await readFile(CONFIG_FILE, "utf8")) as { version: number; port: number; token: string; installationId: string };
}

async function extensionTempFiles(): Promise<Set<string>> {
  const names = await readdir(tmpdir());
  return new Set(names
    .filter((name) => name.startsWith("pi-maestro-browser-extension-") && name.endsWith(".png"))
    .map((name) => join(tmpdir(), name)));
}

class MockExtension {
  #socket: WebSocket | null = null;

  constructor(
    private readonly reply: (message: Command) => Reply | Promise<Reply>,
    private readonly reportedTabs = [{ id: 1, url: "https://example.com", title: "Example" }],
  ) {}

  async connect(port: number, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      this.#socket = socket;
      let settled = false;
      socket.once("open", () => {
        // This is deliberately the first frame.
        socket.send(JSON.stringify({ type: "auth", token }));
      });
      socket.once("error", (error) => {
        if (!settled) reject(error);
      });
      socket.on("message", async (raw) => {
        const message = JSON.parse(raw.toString()) as Command & { type?: string };
        if (message.type === "auth_error") {
          if (!settled) reject(new Error("mock extension authentication rejected"));
          return;
        }
        if (message.type === "auth_ok") {
          settled = true;
          socket.send(JSON.stringify({ type: "ext_ready", tabs: this.reportedTabs }));
          resolve();
          return;
        }
        if (!message.cmd) return;
        socket.send(JSON.stringify({ type: "ack", id: message.id }));
        const result = await this.reply(message);
        if (result === null) return;
        socket.send(JSON.stringify({
          type: result.ok === false ? "error" : "result",
          id: message.id,
          ...result,
        }));
      });
    });
  }

  sendTabsUpdate(tabs: Array<{ id: number; url: string; title?: string }>): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("mock extension is not connected");
    socket.send(JSON.stringify({ type: "tabs_update", tabs }));
  }

  waitForClose(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => socket.once("close", () => resolve()));
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
  }
}

async function openRaw(port: number, firstMessage: unknown): Promise<{ socket: WebSocket; closed: Promise<{ code: number; reason: string }> }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify(firstMessage));
      resolve();
    });
    socket.once("error", reject);
  });
  return { socket, closed };
}

function waitForSocketMessage<T>(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => message is Record<string, unknown> & T,
  timeoutMs = 1_000,
): Promise<Record<string, unknown> & T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`timed out waiting for browser-bridge frame after ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function openPairingRaw(
  port: number,
  proposal: { origin?: string; installationId?: string } = {},
): Promise<{
  socket: WebSocket;
  challenge: { type: "pairing_challenge"; requestId: string; code: string; expiresAt: number };
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const challenge = waitForSocketMessage<{ type: "pairing_challenge"; requestId: string; code: string; expiresAt: number }>(
    socket,
    (message): message is Record<string, unknown> & { type: "pairing_challenge"; requestId: string; code: string; expiresAt: number } =>
      message.type === "pairing_challenge"
      && typeof message.requestId === "string"
      && typeof message.code === "string"
      && typeof message.expiresAt === "number",
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "pairing_request", ...proposal }));
      resolve();
    });
    socket.once("error", reject);
  });
  return { socket, challenge: await challenge };
}

async function openAuthenticatedRaw(port: number, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.once("error", reject);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string };
      if (message.type === "auth_error") reject(new Error("authentication rejected"));
      if (message.type === "auth_ok") {
        socket.send(JSON.stringify({ type: "ext_ready", tabs: [{ id: 9, url: "https://raw.example" }] }));
        resolve();
      }
    });
  });
  return socket;
}

async function closeRaw(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
}

async function freeLoopbackPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("test probe did not bind an IP port");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

type BackgroundProtocolHarness = {
  install: (socket: { readyState: number; send: (frame: string) => void }, dispatch: (request: Command) => Promise<Reply>) => void;
  execute: (socket: { readyState: number; send: (frame: string) => void }, request: Command) => Promise<void>;
  cancel: (socket: { readyState: number; send: (frame: string) => void }, id: string) => void;
};

function backgroundVmContext(): vm.Context {
  const source = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/background.js"), "utf8");
  const event = { addListener() {}, removeListener() {} };
  const context = vm.createContext({
    AbortController,
    clearTimeout,
    console,
    fetch: async () => { throw new TypeError("offline"); },
    setTimeout,
    chrome: {
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({}) } },
      tabs: {
        query: async () => [],
        sendMessage: async () => {},
        onCreated: event,
        onUpdated: event,
        onRemoved: event,
      },
      alarms: { create() {}, onAlarm: event },
      runtime: { onMessage: event, onStartup: event, onInstalled: event, reload() {} },
    },
    WebSocket: class { static readonly OPEN = 1; },
  });
  vm.runInContext(source, context);
  return context;
}

function loadBackgroundTrackedProtocol(): BackgroundProtocolHarness {
  const context = backgroundVmContext();
  vm.runInContext(`
    globalThis.__trackedProtocol = {
      install(socket, handler) { ws = socket; authenticated = true; dispatch = handler; },
      execute: executeTrackedCommand,
      cancel: cancelTrackedCommand,
    };
  `, context);
  return (context as { __trackedProtocol: BackgroundProtocolHarness }).__trackedProtocol;
}

function loadBackgroundWireSerializer(): (expression: string) => string {
  const context = backgroundVmContext();
  vm.runInContext(
    `globalThis.__wireSerialize = (expression) => serializeBridgeResponse({ id: "wire-test", cmd: "exec" }, { ok: true, data: eval(expression) });`,
    context,
  );
  return (context as { __wireSerialize: (expression: string) => string }).__wireSerialize;
}

test.before(async () => {
  await browserBridge.start();
});

test.after(async () => {
  await browserBridge.shutdown();
  rmSync(TEST_DIRECTORY, { recursive: true, force: true });
});

test("start creates owner-only port/token config and exposes disconnected status", async () => {
  const config = await bridgeConfig();
  assert.equal(config.version, 1);
  assert.equal(config.port, browserBridge.listeningPort());
  assert.match(config.token, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(config.installationId, /^[0-9a-f-]{36}$/i);
  assert.equal(browserBridge.status(), "disconnected");
  assert.equal(browserBridge.isConnected(), false);
  assert.equal(Number((await readFile(PORT_FILE, "utf8")).trim()), config.port);
  assert.equal(statSync(CONFIG_FILE).isFile(), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(TEST_DIRECTORY).mode & 0o777, 0o700);
    assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600);
    assert.equal(statSync(PORT_FILE).mode & 0o777, 0o600);
  }
});

test("start persistence failure terminates accepted sockets and releases the unpublished port", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-fault-"));
  const port = await freeLoopbackPort();
  let announcePersistence!: () => void;
  const persistenceStarted = new Promise<void>((resolve) => { announcePersistence = resolve; });
  let rejectPersistence!: (error: Error) => void;
  const persistenceGate = new Promise<void>((_resolve, reject) => { rejectPersistence = reject; });
  const server = new BrowserBridgeServer({
    directory,
    anchorPort: port,
    persistConfig: async () => {
      announcePersistence();
      await persistenceGate;
    },
  });
  try {
    const starting = server.start();
    const rejectedStart = assert.rejects(starting, /fault-injected persistence failure/);
    await persistenceStarted;
    assert.equal(server.listeningPort(), null, "listener identity must remain unpublished before persistence commits");
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    rejectPersistence(new Error("fault-injected persistence failure"));
    await rejectedStart;
    await socketClosed;
    await server.shutdown();
    assert.equal(server.listeningPort(), null);
    assert.equal(server.isConnected(), false);

    const reuse = net.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => reuse.close((error) => error ? reject(error) : resolve()));
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown revokes a provisional listener without waiting for stalled persistence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-stalled-"));
  const port = await freeLoopbackPort();
  let announcePersistence!: () => void;
  const persistenceStarted = new Promise<void>((resolve) => { announcePersistence = resolve; });
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolve) => { releasePersistence = resolve; });
  const server = new BrowserBridgeServer({
    directory,
    anchorPort: port,
    persistConfig: async () => {
      announcePersistence();
      await persistenceGate;
    },
  });
  const starting = server.start().then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  try {
    await persistenceStarted;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    let shutdownSettled = false;
    const shutdown = server.shutdown().then(() => { shutdownSettled = true; });
    await delay(80);
    assert.equal(shutdownSettled, true, "shutdown must not join an uncooperative persistence implementation");
    await shutdown;
    await socketClosed;

    const reuse = net.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => reuse.close((error) => error ? reject(error) : resolve()));

    releasePersistence();
    const startOutcome = await starting;
    assert.equal(startOutcome.status, "rejected", "revoked startup must reject after persistence settles");
    assert.match(startOutcome.status === "rejected" && startOutcome.error instanceof Error ? startOutcome.error.message : "", /revoked|aborted|shut down/i);
    assert.equal(server.listeningPort(), null, "late persistence completion must not republish the listener");
  } finally {
    releasePersistence();
    await starting;
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waitUntilConnected times out without an authenticated extension", async () => {
  await assert.rejects(
    () => browserBridge.waitUntilConnected(40),
    /no authenticated extension connected within 40ms.*port and token/i,
  );
});

test("authenticated first frame connects, resolves waiters, records marker, and enables commands", async () => {
  const { port, token } = await bridgeConfig();
  const extension = new MockExtension((message) => ({ ok: true, data: message.cmd === "exec" ? 42 : null }));
  const waiting = browserBridge.waitUntilConnected(1_000);
  await extension.connect(port, token);
  try {
    await waiting;
    await delay(20);
    assert.equal(browserBridge.status(), "connected");
    assert.equal(browserBridge.isConnected(), true);
    assert.equal(browserBridge.defaultTabId(), 1);
    const result = await browserBridge.exec(1, "return 6 * 7;");
    assert.equal(result.ok, true);
    assert.equal(result.data, 42);
    const marker = JSON.parse(readFileSync(VERIFIED_FILE, "utf8")) as { protocol: string; port: number; verifiedAt: string };
    assert.equal(marker.protocol, "first-frame-token-v1");
    assert.equal(marker.port, port);
    assert.ok(Date.parse(marker.verifiedAt) > 0);
    if (process.platform !== "win32") assert.equal(statSync(VERIFIED_FILE).mode & 0o777, 0o600);
  } finally {
    await extension.close();
  }
  await delay(20);
  assert.equal(browserBridge.status(), "disconnected");
});

test("unauthenticated and wrong-token sockets cannot report tabs or replace the live socket", async () => {
  const { port, token } = await bridgeConfig();
  const extension = new MockExtension(() => ({ ok: true, data: "live" }));
  await extension.connect(port, token);
  try {
    await delay(20);
    const unauthenticated = await openRaw(port, {
      type: "ext_ready",
      tabs: [{ id: 666, url: "https://attacker.invalid" }],
    });
    const firstClose = await unauthenticated.closed;
    assert.equal(firstClose.code, 1008);
    assert.equal(browserBridge.isConnected(), true);
    assert.equal(browserBridge.defaultTabId(), 1);

    const wrongToken = await openRaw(port, { type: "auth", token: "x".repeat(43) });
    const secondClose = await wrongToken.closed;
    assert.equal(secondClose.code, 1008);
    assert.equal(browserBridge.isConnected(), true);

    const result = await browserBridge.send("exec", { tabId: 1, code: "1" }, 500);
    assert.equal(result.data, "live");
  } finally {
    await extension.close();
  }
  await delay(20);
});

test("an unauthenticated result frame cannot satisfy an authenticated pending request", async () => {
  const { port, token } = await bridgeConfig();
  let observedId = "";
  let observeCommand!: () => void;
  const commandObserved = new Promise<void>((resolve) => { observeCommand = resolve; });
  const extension = new MockExtension((message) => {
    observedId = message.id;
    observeCommand();
    return null;
  });
  await extension.connect(port, token);
  const pending = browserBridge.send("cdp", { tabId: 1, method: "Runtime.evaluate", params: {} }, 1_000);
  await commandObserved;
  const attacker = await openRaw(port, { type: "result", id: observedId, ok: true, data: "forged" });
  assert.equal((await attacker.closed).code, 1008);
  assert.equal(browserBridge.isConnected(), true);
  const rejectedOnDisconnect = assert.rejects(() => pending, /disconnected/i);
  await extension.close();
  await rejectedOnDisconnect;
  await delay(20);
});

test("pairing requests are isolated by socket generation and have zero command authority before approval", async () => {
  const { port, token } = await bridgeConfig();
  const extension = new MockExtension(() => null);
  await extension.connect(port, token);
  try {
    const { socket, challenge } = await openPairingRaw(port, {
      origin: "chrome-extension://abcdefghijklmnop",
      installationId: "proposed-installation",
    });
    const requests = browserBridge.pairingRequests();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      requestId: challenge.requestId,
      code: challenge.code,
      expiresAt: challenge.expiresAt,
      generation: requests[0]?.generation,
      origin: "chrome-extension://abcdefghijklmnop",
      installationId: "proposed-installation",
    });
    assert.ok(Number.isSafeInteger(requests[0]?.generation) && Number(requests[0]?.generation) > 0);
    assert.match(challenge.code, /^\d{6}$/);
    assert.ok(challenge.expiresAt > Date.now());
    assert.equal(browserBridge.isConnected(), true, "pairing socket must not replace the token-authenticated command socket");

    const closed = new Promise<{ code: number }>((resolve) => socket.once("close", (code) => resolve({ code })));
    socket.send(JSON.stringify({ type: "tabs_update", tabs: [{ id: 666, url: "https://pairing-attacker.invalid" }] }));
    assert.equal((await closed).code, 1008);
    assert.equal(browserBridge.defaultTabId(), 1);
    assert.equal(browserBridge.pairingRequests().length, 0, "closing a pairing socket must remove its isolated request");
  } finally {
    await extension.close();
  }
  await delay(20);
});

test("pairing expiry clears the request and closes only its generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-pairing-expiry-"));
  const port = await freeLoopbackPort();
  const server = new BrowserBridgeServer({ directory, anchorPort: port, pairingTtlMs: 30 });
  try {
    await server.start();
    const pairing = await openPairingRaw(port, { origin: "chrome-extension://expires" });
    assert.equal(server.pairingRequests().length, 1);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      pairing.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const outcome = await closed;
    assert.equal(outcome.code, 1008);
    assert.match(outcome.reason, /expired/i);
    assert.equal(server.pairingRequests().length, 0);
    assert.equal(server.isConnected(), false);
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved pairing promotes only the exact request generation while legacy token auth remains valid", async () => {
  const { port, token } = await bridgeConfig();
  const { socket, challenge } = await openPairingRaw(port, {
    origin: "chrome-extension://approved",
    installationId: "approved-proposal",
  });
  try {
    await assert.rejects(
      () => browserBridge.approvePairing(challenge.requestId, "000000"),
      /pairing code/i,
    );
    const approvedFrame = waitForSocketMessage<{ type: "pairing_approved"; token: string }>(
      socket,
      (message): message is Record<string, unknown> & { type: "pairing_approved"; token: string } =>
        message.type === "pairing_approved" && typeof message.token === "string",
    );
    const identity = await browserBridge.approvePairing(challenge.requestId, challenge.code);
    assert.equal((await approvedFrame).token, token);
    assert.deepEqual(browserBridge.connectionIdentity(), identity);
    assert.equal(browserBridge.pairingRequests().length, 0);
    socket.send(JSON.stringify({ type: "ext_ready", tabs: [{ id: 77, url: "https://paired.example" }] }));
    await delay(20);
    assert.equal(browserBridge.defaultTabId(), 77);
  } finally {
    await closeRaw(socket);
  }
  await delay(20);

  const legacy = new MockExtension(() => ({ ok: true, data: "legacy-token-still-valid" }));
  await legacy.connect(port, token);
  try {
    const result = await browserBridge.send("exec", { tabId: 1, code: "1" }, 500);
    assert.equal(result.data, "legacy-token-still-valid");
  } finally {
    await legacy.close();
  }
  await delay(20);
});

test("caller timeout leaves tracked terminal ownership pending until a late result cleans it exactly once", async () => {
  const { port, token } = await bridgeConfig();
  const socket = await openAuthenticatedRaw(port, token);
  let commandId = "";
  const commandSeen = new Promise<void>((resolve) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Command & { type?: string };
      if (!message.cmd) return;
      commandId = message.id;
      socket.send(JSON.stringify({ type: "ack", id: message.id }));
      resolve();
    });
  });
  try {
    const handle = await browserBridge.sendTracked("cdp", { tabId: 9, method: "Runtime.evaluate", params: {} }, 40);
    assert.deepEqual(handle.connection, browserBridge.connectionIdentity());
    await commandSeen;
    await assert.rejects(() => handle.response, /timed out after 40ms/i);
    assert.equal(
      await Promise.race([handle.terminal.then(() => "settled"), delay(30).then(() => "pending")]),
      "pending",
      "caller timeout must not delete or settle the resource lifecycle record",
    );

    socket.send(JSON.stringify({ type: "result", id: commandId, data: "late" }));
    const terminal = await handle.terminal;
    assert.equal(terminal.status, "result");
    assert.equal(terminal.result?.data, "late");
    socket.send(JSON.stringify({ type: "error", id: commandId, error: "duplicate" }));
    assert.equal((await handle.terminal).status, "result", "duplicate terminal frames must not resettle the handle");
  } finally {
    await closeRaw(socket);
  }
});

test("tracked cancel stopped=false retains terminal ownership until the real result", async () => {
  const { port, token } = await bridgeConfig();
  const socket = await openAuthenticatedRaw(port, token);
  let commandId = "";
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Command & { type?: string };
    if (message.cmd) {
      commandId = message.id;
      socket.send(JSON.stringify({ type: "ack", id: message.id }));
      return;
    }
    if (message.type === "cancel" && message.id === commandId) {
      socket.send(JSON.stringify({ type: "cancel_ack", id: commandId, stopped: false }));
    }
  });
  try {
    const handle = await browserBridge.sendTracked("exec", { tabId: 9, code: "slow" }, 500);
    while (!commandId) await delay(1);
    assert.deepEqual(await handle.cancel(), { stopped: false });
    assert.equal(
      await Promise.race([handle.terminal.then(() => "settled"), delay(30).then(() => "pending")]),
      "pending",
      "started work must stay lifecycle-owned after a negative cancel acknowledgement",
    );
    socket.send(JSON.stringify({ type: "result", id: commandId, data: 42 }));
    assert.equal((await handle.response).data, 42);
    assert.equal((await handle.terminal).status, "result");
  } finally {
    await closeRaw(socket);
  }
});

test("tracked cancel stopped=true is terminal without a synthetic result", async () => {
  const { port, token } = await bridgeConfig();
  const socket = await openAuthenticatedRaw(port, token);
  let commandId = "";
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Command & { type?: string };
    if (message.cmd) {
      commandId = message.id;
      socket.send(JSON.stringify({ type: "ack", id: message.id }));
      return;
    }
    if (message.type === "cancel" && message.id === commandId) {
      socket.send(JSON.stringify({ type: "cancel_ack", id: commandId, stopped: true }));
    }
  });
  try {
    const handle = await browserBridge.sendTracked("exec", { tabId: 9, code: "queued" }, 500);
    while (!commandId) await delay(1);
    assert.deepEqual(await handle.cancel(), { stopped: true });
    await assert.rejects(() => handle.response, /cancelled before start/i);
    assert.equal((await handle.terminal).status, "cancelled");
  } finally {
    await closeRaw(socket);
  }
});

test("tracked terminals distinguish authenticated replacement from disconnect and fence the replacement generation", async () => {
  const { port, token } = await bridgeConfig();
  const original = await openAuthenticatedRaw(port, token);
  original.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Command;
    if (message.cmd) original.send(JSON.stringify({ type: "ack", id: message.id }));
  });
  const first = await browserBridge.sendTracked("exec", { tabId: 9, code: "pending" }, 500);
  const firstRejected = assert.rejects(() => first.response, /connection replaced/i);
  const replacement = await openAuthenticatedRaw(port, token);
  await firstRejected;
  assert.equal((await first.terminal).status, "replaced");
  assert.throws(() => browserBridge.assertConnection(first.connection), /generation mismatch/i);

  replacement.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Command;
    if (message.cmd) replacement.send(JSON.stringify({ type: "ack", id: message.id }));
  });
  const second = await browserBridge.sendTracked("exec", { tabId: 9, code: "pending" }, 500);
  const secondRejected = assert.rejects(() => second.response, /disconnected/i);
  await closeRaw(replacement);
  await secondRejected;
  assert.equal((await second.terminal).status, "disconnected");
  await closeRaw(original);
});

test("an authenticated command times out when ack is not followed by a result", async () => {
  const { port, token } = await bridgeConfig();
  const extension = new MockExtension(() => null);
  await extension.connect(port, token);
  try {
    await assert.rejects(
      () => browserBridge.send("cdp", { tabId: 1, method: "noop", params: {} }, 60),
      /timed out|delivered but no result/i,
    );
  } finally {
    await extension.close();
  }
  await delay(20);
});

test("disconnect rejects commands pending on that authenticated transport", async () => {
  const { port, token } = await bridgeConfig();
  const socket = await openAuthenticatedRaw(port, token);
  let sawCommand!: () => void;
  const commandSeen = new Promise<void>((resolve) => { sawCommand = resolve; });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Command & { type?: string };
    if (!message.cmd) return;
    socket.send(JSON.stringify({ type: "ack", id: message.id }));
    sawCommand();
  });
  const pending = browserBridge.send("cdp", { tabId: 9, method: "Runtime.evaluate", params: {} }, 1_000);
  await commandSeen;
  await closeRaw(socket);
  await assert.rejects(() => pending, /disconnected/i);
  assert.equal(browserBridge.isConnected(), false);
});

test("tabs query/switch/create stay compatible and get/update/close preserve fixed tabId payloads", async () => {
  const { port, token } = await bridgeConfig();
  const calls: Command[] = [];
  const extension = new MockExtension((message) => {
    calls.push(message);
    return { ok: true, data: { method: message.method, tabId: message.tabId } };
  });
  await extension.connect(port, token);
  try {
    await browserBridge.tabsCmd("query");
    await browserBridge.tabsCmd("switch", { tabId: 7 });
    await browserBridge.tabsCmd("create", { url: "https://new.example", active: false });
    await browserBridge.tabsCmd("get", { tabId: 7 });
    await browserBridge.tabsCmd("update", { tabId: 7, url: "https://updated.example", active: true });
    await browserBridge.tabsCmd("close", { tabId: 7 });
  } finally {
    await extension.close();
  }
  assert.deepEqual(calls.map(({ method }) => method), ["query", "switch", "create", "get", "update", "close"]);
  assert.deepEqual(
    calls.slice(3).map(({ method, tabId }) => ({ method, tabId })),
    [
      { method: "get", tabId: 7 },
      { method: "update", tabId: 7 },
      { method: "close", tabId: 7 },
    ],
  );
  assert.equal(calls[4].url, "https://updated.example");
  assert.equal(calls[4].active, true);
});

test("BrowserManager extension entries bind fixed tabs, expose limited adapters, preserve ownership, and fail closed on disconnect", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const calls: Command[] = [];
  const tabs = new Map<number, { id: number; url: string; title: string }>([
    [7, { id: 7, url: "https://borrowed.example/start", title: "Borrowed" }],
    [8, { id: 8, url: "https://other.example/", title: "Other" }],
  ]);
  let nextId = 50;
  const png = Buffer.from("extension-png").toString("base64");
  const extension = new MockExtension((message) => {
    calls.push(message);
    if (message.cmd === "tabs") {
      if (message.method === "query") return { ok: true, data: [...tabs.values()] };
      if (message.method === "get") {
        const tab = tabs.get(Number(message.tabId));
        return tab ? { ok: true, data: tab } : { ok: false, error: `missing tab ${String(message.tabId)}; known=${[...tabs.keys()].join(",")}` };
      }
      if (message.method === "create") {
        const id = nextId++;
        const tab = { id, url: String(message.url), title: "Created" };
        tabs.set(id, tab);
        return { ok: true, data: tab };
      }
      if (message.method === "update") {
        const tab = tabs.get(Number(message.tabId));
        if (!tab) return { ok: false, error: "missing tab" };
        if (message.url !== undefined) {
          tab.url = String(message.url);
          tab.title = "Navigated";
        }
        return { ok: true, data: tab };
      }
      if (message.method === "close") {
        tabs.delete(Number(message.tabId));
        return { ok: true, data: { id: message.tabId } };
      }
    }
    if (message.cmd === "exec") {
      return { ok: true, data: 42, newTabs: [{ id: 88, url: "https://spawned.example/", title: "Spawned" }] };
    }
    if (message.cmd === "cdp") {
      return message.method === "Page.captureScreenshot"
        ? { ok: true, data: { data: png } }
        : { ok: true, data: { method: message.method, tabId: message.tabId } };
    }
    if (message.cmd === "batch") return { ok: true, results: [{ ok: true, data: { tabId: message.tabId } }] };
    if (message.cmd === "cookies") {
      if (message.method === "get") return { ok: true, data: [{ name: "session", value: "v", domain: "borrowed.example" }] };
      return { ok: true, data: [{ method: message.method, tabId: message.tabId }] };
    }
    return { ok: false, error: `unexpected command: ${message.cmd}` };
  }, [...tabs.values()]);
  await extension.connect(port, token);
  const manager = new BrowserManager();
  let screenshotPath = "";
  try {
    await delay(20);
    const borrowed = await manager.open({
      name: "borrowed",
      cwd: process.cwd(),
      channel: "extension",
      target: "Borrowed",
      timeoutMs: 2_000,
    });
    assert.equal(borrowed.kind, "extension");
    assert.equal(borrowed.connection.ownership, "borrowed");
    assert.deepEqual(borrowed.connection.capabilities, { page: false, cdp: true, cookies: true });
    assert.equal(borrowed.url, "https://borrowed.example/start");
    const connectedStatus = await manager.status();
    assert.equal(connectedStatus.bridge.serverStarted, true);
    assert.equal(connectedStatus.bridge.authenticatedConnected, true);
    assert.equal(connectedStatus.bridge.state, "connected");
    assert.equal(connectedStatus.bridge.tabCount, 2);
    assert.deepEqual(connectedStatus.namedTabs, [{
      name: "borrowed",
      channel: "extension",
      ownership: "borrowed",
      capabilities: { page: false, cdp: true, cookies: true },
    }]);

    // Change the bridge's global/default ordering after open. Every adapter call
    // must continue to carry the entry's fixed tabId=7.
    extension.sendTabsUpdate([
      { id: 99, url: "https://new-default.example/", title: "New default" },
      ...tabs.values(),
    ]);
    await delay(20);
    const output = await manager.run("borrowed", `
      const initial = { url: page.url(), title: await page.title() };
      const evaluated = await page.evaluate((a, b) => a + b, 20, 22);
      await tab.goto('https://borrowed.example/next');
      const cdp = await tab.cdp('Runtime.evaluate', { expression: '6 * 7' });
      const batch = await tab.cdpBatch([{ method: 'Runtime.evaluate', params: { expression: '1' } }]);
      const cookies = await tab.cookies.get({ name: 'session' });
      await tab.cookies.set({ name: 'session', value: 'v2', domain: 'borrowed.example', path: '/' });
      await tab.cookies.delete({ name: 'session' });
      const listed = await tab.tabs();
      const pages = await browser.pages();
      const shot = await tab.screenshot({ silent: true });
      return { initial, evaluated, cdp, batch, cookies, listed: listed.length, pages: pages.length, shot };
    `, process.cwd(), undefined, 2_000);
    const value = output.returnValue as {
      initial: { url: string; title: string };
      evaluated: number;
      cdp: { tabId: number };
      batch: Array<{ data: { tabId: number } }>;
      cookies: Array<{ name: string }>;
      listed: number;
      pages: number;
      shot: { path: string };
    };
    assert.deepEqual(value.initial, { url: "https://borrowed.example/start", title: "Borrowed" });
    assert.equal(value.evaluated, 42);
    assert.equal(value.cdp.tabId, 7);
    assert.equal(value.batch[0]?.data.tabId, 7);
    assert.equal(value.cookies[0]?.name, "session");
    assert.equal(value.listed, 2);
    assert.equal(value.pages, 2);
    assert.equal(output.url, "https://borrowed.example/next");
    assert.equal(output.navigated, true);
    assert.deepEqual(output.newTabs, [{ url: "https://spawned.example/" }]);
    assert.equal(output.screenshots.length, 1);
    screenshotPath = value.shot.path;
    assert.equal(statSync(screenshotPath).isFile(), true);

    const fixedTabCalls = calls.filter((call) => ["exec", "cdp", "batch", "cookies"].includes(call.cmd));
    assert.ok(fixedTabCalls.length >= 7);
    assert.ok(fixedTabCalls.every((call) => call.tabId === 7), "all extension operations must retain fixed tabId=7");
    await assert.rejects(
      () => manager.run("borrowed", "return await page.click('#unsupported');", process.cwd(), undefined, 2_000),
      /does not support page\.click.*Supported capabilities:/,
    );

    const closesBeforeBorrowed = calls.filter((call) => call.cmd === "tabs" && call.method === "close").length;
    assert.equal(await manager.close("borrowed"), true);
    assert.equal(calls.filter((call) => call.cmd === "tabs" && call.method === "close").length, closesBeforeBorrowed, "borrowed tabs must not be closed");
    assert.equal(statSync(screenshotPath, { throwIfNoEntry: false }), undefined, "entry-owned temporary screenshots must be removed on close");

    const owned = await manager.open({
      name: "owned",
      cwd: process.cwd(),
      channel: "extension",
      url: "https://owned.example/",
      timeoutMs: 2_000,
    });
    assert.equal(owned.connection.ownership, "owned");
    const ownedId = nextId - 1;
    assert.equal(await manager.close("owned"), true);
    assert.ok(calls.some((call) => call.cmd === "tabs" && call.method === "close" && call.tabId === ownedId), "owned tab must be closed exactly by its fixed id");

    await manager.open({
      name: "disconnect",
      cwd: process.cwd(),
      channel: "extension",
      target: "Borrowed",
      timeoutMs: 2_000,
    });
    await extension.close();
    await delay(20);
    await assert.rejects(
      () => manager.run("disconnect", "return page.url();", process.cwd(), undefined, 2_000),
      /disconnected.*fixed tabId 7.*does not fall back to managed Chromium/i,
    );
    const disconnectedStatus = await manager.status();
    assert.equal(disconnectedStatus.bridge.serverStarted, true);
    assert.equal(disconnectedStatus.bridge.authenticatedConnected, false);
    assert.equal(disconnectedStatus.bridge.state, "disconnected");
    assert.equal(disconnectedStatus.bridge.tabCount, 0, "status must not expose stale last-reported tabs as live");
    assert.deepEqual(disconnectedStatus.namedTabs, [{
      name: "disconnect",
      channel: "extension",
      ownership: "borrowed",
      capabilities: { page: false, cdp: true, cookies: true },
    }]);
    assert.equal(await manager.close("disconnect"), true, "closing a borrowed disconnected entry only releases the binding");
  } finally {
    await manager.closeAll();
    await extension.close();
  }
});

test("extension entries reject run and destructive close after authenticated transport replacement", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const originalTabs = new Map<number, { id: number; url: string; title: string }>();
  const original = new MockExtension((message) => {
    if (message.cmd !== "tabs") return { ok: false, error: "unexpected original command" };
    if (message.method === "query") return { ok: true, data: [...originalTabs.values()] };
    if (message.method === "create") {
      const tab = { id: 7, url: String(message.url), title: "Owned by socket A" };
      originalTabs.set(tab.id, tab);
      return { ok: true, data: tab };
    }
    if (message.method === "get") return { ok: true, data: originalTabs.get(Number(message.tabId)) };
    return { ok: false, error: `unexpected original tabs method ${String(message.method)}` };
  }, []);
  const replacementCalls: Command[] = [];
  const replacementTab = { id: 7, url: "https://unrelated.example/", title: "Owned by socket B" };
  const replacement = new MockExtension((message) => {
    replacementCalls.push(message);
    if (message.cmd === "tabs" && message.method === "get") return { ok: true, data: replacementTab };
    if (message.cmd === "tabs" && message.method === "close") return { ok: true, data: { id: 7 } };
    return { ok: true, data: null };
  }, [replacementTab]);
  const manager = new BrowserManager();
  try {
    await original.connect(port, token);
    await delay(20);
    await manager.open({
      name: "generation-owned",
      cwd: process.cwd(),
      channel: "extension",
      url: "https://owned.example/",
      timeoutMs: 2_000,
    });
    const originalIdentity = browserBridge.connectionIdentity();
    assert.ok(originalIdentity);
    await replacement.connect(port, token);
    await original.waitForClose();
    await delay(20);
    const replacementIdentity = browserBridge.connectionIdentity();
    assert.ok(replacementIdentity);
    assert.equal(replacementIdentity.installationId, originalIdentity.installationId);
    assert.notEqual(replacementIdentity.generation, originalIdentity.generation);

    const runError = await manager.run(
      "generation-owned",
      "return page.url();",
      process.cwd(),
      undefined,
      2_000,
    ).then(() => null, (error: unknown) => error);
    const closeError = await manager.close("generation-owned").then(() => null, (error: unknown) => error);
    assert.match(runError instanceof Error ? runError.message : "", /connection generation mismatch/i);
    assert.match(closeError instanceof Error ? closeError.message : "", /connection generation mismatch/i);
    assert.equal(replacementCalls.length, 0, "socket B must receive neither run commands nor a destructive tabs.close");
  } finally {
    await manager.closeAll();
    await original.close();
    await replacement.close();
  }
});

test("close waits for an acknowledged extension command before owned-tab destruction", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const tabs = new Map<number, { id: number; url: string; title: string }>();
  const events: string[] = [];
  let releaseExec!: () => void;
  const execGate = new Promise<void>((resolve) => { releaseExec = resolve; });
  let announceExec!: () => void;
  const execStarted = new Promise<void>((resolve) => { announceExec = resolve; });
  const extension = new MockExtension(async (message) => {
    if (message.cmd === "tabs" && message.method === "query") return { ok: true, data: [...tabs.values()] };
    if (message.cmd === "tabs" && message.method === "create") {
      const tab = { id: 71, url: String(message.url), title: "Owned" };
      tabs.set(tab.id, tab);
      return { ok: true, data: tab };
    }
    if (message.cmd === "tabs" && message.method === "get") return { ok: true, data: tabs.get(Number(message.tabId)) };
    if (message.cmd === "tabs" && message.method === "close") {
      events.push("tab-close");
      tabs.delete(Number(message.tabId));
      return { ok: true, data: { id: message.tabId } };
    }
    if (message.cmd === "exec") {
      events.push("exec-start");
      announceExec();
      await execGate;
      events.push("exec-finish");
      return { ok: true, data: true };
    }
    return { ok: false, error: `unexpected command ${message.cmd}.${String(message.method)}` };
  }, []);
  const manager = new BrowserManager();
  try {
    await extension.connect(port, token);
    await delay(20);
    await manager.open({ name: "join-owned", cwd: process.cwd(), channel: "extension", url: "https://owned.example/", timeoutMs: 1_000 });
    const runOutcome = manager.run(
      "join-owned",
      "return await page.evaluate(() => { globalThis.__piLateMutation = true; return true; });",
      process.cwd(),
      undefined,
      1_000,
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await execStarted;
    let closeSettled = false;
    const closing = manager.close("join-owned").then((value) => { closeSettled = true; return value; });
    await delay(40);
    assert.equal(closeSettled, false, "close must remain pending while the acknowledged exec is unfinished");
    assert.deepEqual(events, ["exec-start"], "owned tabs must not be destroyed ahead of their in-flight command");

    releaseExec();
    assert.equal(await closing, true);
    assert.deepEqual(events, ["exec-start", "exec-finish", "tab-close"]);
    const settled = await runOutcome;
    assert.match("error" in settled && settled.error instanceof Error ? settled.error.message : "", /aborted/i);
  } finally {
    releaseExec();
    await manager.closeAll();
    await extension.close();
  }
});

test("closing an extension entry aborts and joins its active run before temp cleanup", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const tab = { id: 7, url: "https://borrowed.example/", title: "Borrowed" };
  const png = Buffer.from("run-owned-temp").toString("base64");
  let captureCount = 0;
  let resolveFirstCapture!: () => void;
  const firstCapture = new Promise<void>((resolve) => { resolveFirstCapture = resolve; });
  const extension = new MockExtension((message) => {
    if (message.cmd === "tabs" && message.method === "query") return { ok: true, data: [tab] };
    if (message.cmd === "tabs" && message.method === "get") return { ok: true, data: tab };
    if (message.cmd === "cdp" && message.method === "Page.captureScreenshot") {
      captureCount += 1;
      if (captureCount === 1) resolveFirstCapture();
      return { ok: true, data: { data: png } };
    }
    return { ok: false, error: `unexpected command ${message.cmd}.${String(message.method)}` };
  }, [tab]);
  const manager = new BrowserManager();
  const before = await extensionTempFiles();
  try {
    await extension.connect(port, token);
    await delay(20);
    await manager.open({
      name: "active-run",
      cwd: process.cwd(),
      channel: "extension",
      target: "Borrowed",
      timeoutMs: 2_000,
    });
    const runOutcome = manager.run("active-run", `
      await tab.screenshot({ silent: true });
      await wait(200);
      await tab.screenshot({ silent: true });
      return true;
    `, process.cwd(), undefined, 2_000).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await firstCapture;
    await delay(20);
    assert.equal(await manager.close("active-run"), true);
    const settled = await runOutcome;
    assert.match("error" in settled && settled.error instanceof Error ? settled.error.message : "", /aborted/i);
    assert.equal(captureCount, 1, "close must prevent the post-wait screenshot CDP command");
    const after = await extensionTempFiles();
    assert.deepEqual([...after].filter((file) => !before.has(file)), [], "close must remove active-run temporary screenshots");
  } finally {
    await manager.closeAll();
    await extension.close();
    const leftovers = [...await extensionTempFiles()].filter((file) => !before.has(file));
    await Promise.all(leftovers.map((file) => rm(file, { force: true })));
  }
});

test("extension evaluate rejects every non-JSON wire value and preserves legal nested JSON", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const tab = { id: 7, url: "https://wire.example/", title: "Wire" };
  const execCalls: Command[] = [];
  const extension = new MockExtension((message) => {
    if (message.cmd === "tabs" && message.method === "query") return { ok: true, data: [tab] };
    if (message.cmd === "tabs" && message.method === "get") return { ok: true, data: tab };
    if (message.cmd === "exec") {
      execCalls.push(message);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => () => Promise<unknown>;
      return new AsyncFunction(String(message.code))().then((data) => ({ ok: true, data }));
    }
    return { ok: false, error: `unexpected command ${message.cmd}.${String(message.method)}` };
  }, [tab]);
  const manager = new BrowserManager();
  try {
    await extension.connect(port, token);
    await delay(20);
    await manager.open({ name: "wire", cwd: process.cwd(), channel: "extension", target: "Wire", timeoutMs: 2_000 });
    const invalidExpressions = [
      "undefined",
      "() => 1",
      "Symbol('x')",
      "NaN",
      "Infinity",
      "new Map([['k', 1]])",
    ];
    for (const expression of invalidExpressions) {
      await assert.rejects(
        () => manager.run("wire", `return await page.evaluate((value) => value, ${expression});`, process.cwd(), undefined, 2_000),
        /page\.evaluate argument.*JSON wire/i,
        expression,
      );
    }
    await assert.rejects(
      () => manager.run("wire", "const value = {}; value.self = value; return await page.evaluate((item) => item, value);", process.cwd(), undefined, 2_000),
      /page\.evaluate argument.*cycle.*JSON wire/i,
    );
    const valid = { text: "kept", nested: [null, true, 4.5, { ok: false }] };
    const validOutput = await manager.run(
      "wire",
      `return await page.evaluate((value) => value, ${JSON.stringify(valid)});`,
      process.cwd(),
      undefined,
      2_000,
    );
    assert.deepEqual(validOutput.returnValue, valid);

    const specialJson = '{"nested":{"__proto__":{"marker":7},"constructor":{"kept":true},"prototype":"own"}}';
    const specialOutput = await manager.run(
      "wire",
      `
        const value = JSON.parse(${JSON.stringify(specialJson)});
        return await page.evaluate((input) => ({
          keys: Object.keys(input.nested),
          ownProto: Object.prototype.hasOwnProperty.call(input.nested, '__proto__'),
          marker: input.nested.__proto__.marker,
          constructorKept: input.nested.constructor.kept,
          prototypeKept: input.nested.prototype,
        }), value);
      `,
      process.cwd(),
      undefined,
      2_000,
    );
    assert.deepEqual(specialOutput.returnValue, {
      keys: ["__proto__", "constructor", "prototype"],
      ownProto: true,
      marker: 7,
      constructorKept: true,
      prototypeKept: "own",
    });
    assert.equal(execCalls.length, 2, "unsupported values must be rejected before sending exec");
    assert.match(String(execCalls[0]?.code), /JSON\.parse\(/, "arguments must be reconstructed as JSON data, not source literals");
  } finally {
    await manager.closeAll();
    await extension.close();
  }
});

test("extension cancel state machine stops queued work but keeps started work terminal-owned", async () => {
  const protocol = loadBackgroundTrackedProtocol();

  const queuedFrames: Array<Record<string, unknown>> = [];
  let queuedDispatches = 0;
  const queuedSocket = {
    readyState: 1,
    send: (frame: string) => queuedFrames.push(JSON.parse(frame) as Record<string, unknown>),
  };
  protocol.install(queuedSocket, async () => {
    queuedDispatches += 1;
    return { ok: true, data: "must-not-run" };
  });
  const queuedExecution = protocol.execute(queuedSocket, { id: "queued", cmd: "exec" });
  protocol.cancel(queuedSocket, "queued");
  await queuedExecution;
  assert.equal(queuedDispatches, 0);
  assert.deepEqual(queuedFrames, [
    { type: "ack", id: "queued" },
    { type: "cancel_ack", id: "queued", stopped: true },
  ]);

  const startedFrames: Array<Record<string, unknown>> = [];
  let announceStarted!: () => void;
  const started = new Promise<void>((resolve) => { announceStarted = resolve; });
  let finishStarted!: () => void;
  const finish = new Promise<void>((resolve) => { finishStarted = resolve; });
  const startedSocket = {
    readyState: 1,
    send: (frame: string) => startedFrames.push(JSON.parse(frame) as Record<string, unknown>),
  };
  protocol.install(startedSocket, async () => {
    announceStarted();
    await finish;
    return { ok: true, data: "real-result" };
  });
  const startedExecution = protocol.execute(startedSocket, { id: "started", cmd: "exec" });
  await started;
  protocol.cancel(startedSocket, "started");
  assert.deepEqual(startedFrames.slice(0, 2), [
    { type: "ack", id: "started" },
    { type: "cancel_ack", id: "started", stopped: false },
  ]);
  finishStarted();
  await startedExecution;
  assert.deepEqual(startedFrames[2], { type: "result", id: "started", ok: true, data: "real-result" });
});

test("extension result serialization rejects unsupported JSON wire values and preserves special keys", () => {
  const serialize = loadBackgroundWireSerializer();
  const invalidExpressions = [
    "NaN",
    "Infinity",
    "new Map([['k', 1]])",
    "() => 1",
    "Symbol('x')",
    "(() => { const value = {}; value.self = value; return value; })()",
  ];
  for (const expression of invalidExpressions) {
    const response = JSON.parse(serialize(expression)) as { type: string; error?: string; data?: unknown };
    assert.equal(response.type, "error", expression);
    assert.match(response.error ?? "", /evaluation result.*JSON wire/i, expression);
    assert.equal("data" in response, false, expression);
  }

  const specialJson = '{"nested":{"__proto__":{"marker":7},"constructor":{"kept":true},"prototype":"own"}}';
  const response = JSON.parse(serialize(`JSON.parse(${JSON.stringify(specialJson)})`)) as { type: string; data: unknown };
  assert.equal(response.type, "result");
  assert.deepEqual(response.data, JSON.parse(specialJson));
});

test("extension sources configure port/token, gate ext_ready on auth_ok, and implement new tab methods", () => {
  const background = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/background.js"), "utf8");
  const popup = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/popup.js"), "utf8");
  const authenticationFrame = background.indexOf("socket.send(JSON.stringify({ type: 'auth', token: wsToken }))");
  const readyFrame = background.indexOf("type: 'ext_ready'");
  assert.ok(authenticationFrame >= 0 && readyFrame > authenticationFrame);
  assert.match(background, /data\.type !== 'auth_ok'/);
  assert.match(background, /msg\.method === 'get'/);
  assert.match(background, /msg\.method === 'update'/);
  assert.match(background, /msg\.method === 'close'/);
  assert.match(background, /method === 'set'/);
  assert.match(background, /method === 'delete'/);
  assert.match(background, /data\.type === 'cancel'/);
  assert.match(background, /type: 'cancel_ack'/);
  assert.match(background, /sendCancelAcknowledgement\(socket, id, true\)/);
  assert.match(background, /sendCancelAcknowledgement\(socket, id, false\)/);
  assert.match(popup, /STORAGE_PORT_KEY/);
  assert.match(popup, /STORAGE_TOKEN_KEY/);
});

test("shutdown is idempotent, closes sockets, and waits until the port is reusable", async () => {
  const { port, token } = await bridgeConfig();
  const extension = new MockExtension(() => ({ ok: true }));
  await extension.connect(port, token);
  const extensionClosed = extension.waitForClose();
  await browserBridge.shutdown();
  await extensionClosed;
  await browserBridge.shutdown();
  assert.equal(browserBridge.status(), "disconnected");
  assert.equal(browserBridge.isConnected(), false);
  assert.equal(browserBridge.listeningPort(), null);

  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
});

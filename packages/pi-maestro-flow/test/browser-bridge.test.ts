import assert from "node:assert/strict";
import { createHmac, randomBytes, webcrypto } from "node:crypto";
import * as net from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// Import after isolation env is set because bridge paths are module constants.
const {
  authTranscript,
  browserBridge,
  BrowserBridgeServer,
  HMAC_AUTH_PROTOCOL,
  parseProductionAnchorPort,
} = await import("../src/tools/browser/bridge-server.ts");

type Command = { id: string; cmd: string; [key: string]: unknown };
type Reply = { ok?: boolean; data?: unknown; error?: string; results?: unknown[]; newTabs?: Array<{ id?: number; url?: string; title?: string }> } | null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition did not become true within ${timeoutMs}ms`);
    await delay(10);
  }
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
  challenge: { type: "pairing_challenge"; protocol: string; requestId: string; code: string; expiresAt: number; generation: number };
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const challenge = waitForSocketMessage<{ type: "pairing_challenge"; protocol: string; requestId: string; code: string; expiresAt: number; generation: number }>(
    socket,
    (message): message is Record<string, unknown> & { type: "pairing_challenge"; protocol: string; requestId: string; code: string; expiresAt: number; generation: number } =>
      message.type === "pairing_challenge"
      && message.protocol === "pi-browser-bridge/v1"
      && typeof message.requestId === "string"
      && typeof message.code === "string"
      && typeof message.expiresAt === "number"
      && typeof message.generation === "number",
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "pairing_request", protocol: "pi-browser-bridge/v1", ...proposal }));
      resolve();
    });
    socket.once("error", reject);
  });
  return { socket, challenge: await challenge };
}

type AuthChallengeFrame = {
  type: "auth_challenge";
  protocol: string;
  clientNonce: string;
  serverNonce: string;
  installationId: string;
  port: number;
  generation: number;
  expiresAt: number;
};

async function openAuthProbe(port: number): Promise<{ socket: WebSocket; challenge: AuthChallengeFrame }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const clientNonce = randomBytes(16).toString("base64url");
  const challengePromise = waitForSocketMessage<AuthChallengeFrame>(
    socket,
    (message): message is Record<string, unknown> & AuthChallengeFrame =>
      message.type === "auth_challenge"
      && message.protocol === HMAC_AUTH_PROTOCOL
      && message.clientNonce === clientNonce
      && typeof message.serverNonce === "string"
      && typeof message.installationId === "string"
      && typeof message.port === "number"
      && typeof message.generation === "number"
      && typeof message.expiresAt === "number",
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "auth_probe", protocol: HMAC_AUTH_PROTOCOL, clientNonce }));
      resolve();
    });
    socket.once("error", reject);
  });
  return { socket, challenge: await challengePromise };
}

function authProof(token: string, challenge: AuthChallengeFrame): Record<string, unknown> {
  return {
    type: "auth_proof",
    protocol: HMAC_AUTH_PROTOCOL,
    clientNonce: challenge.clientNonce,
    serverNonce: challenge.serverNonce,
    installationId: challenge.installationId,
    port: challenge.port,
    generation: challenge.generation,
    proof: createHmac("sha256", token).update(authTranscript(challenge)).digest("base64url"),
  };
}

async function completeAuthProof(socket: WebSocket, token: string, challenge: AuthChallengeFrame): Promise<void> {
  const authenticated = waitForSocketMessage<{ type: "auth_ok" }>(
    socket,
    (message): message is Record<string, unknown> & { type: "auth_ok" } => message.type === "auth_ok",
  );
  socket.send(JSON.stringify(authProof(token, challenge)));
  await authenticated;
  socket.send(JSON.stringify({ type: "ext_ready", tabs: [{ id: 91, url: "https://proof.example" }] }));
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

async function occupyLoopbackRange(count: number): Promise<{ anchor: number; servers: net.Server[]; close: () => Promise<void> }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const anchor = 30_000 + Math.floor(Math.random() * 20_000);
    const servers: net.Server[] = [];
    let failed = false;
    for (let offset = 0; offset < count; offset += 1) {
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(anchor + offset, "127.0.0.1", resolve);
        });
        servers.push(server);
      } catch {
        failed = true;
        break;
      }
    }
    const close = async () => {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    };
    if (!failed) return { anchor, servers, close };
    await close();
  }
  throw new Error(`could not reserve a contiguous ${count}-port test range`);
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
    btoa,
    clearTimeout,
    console,
    crypto: webcrypto,
    TextEncoder,
    fetch: async () => { throw new TypeError("offline"); },
    setTimeout,
    chrome: {
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} } },
      tabs: {
        query: async () => [],
        sendMessage: async () => {},
        onCreated: event,
        onUpdated: event,
        onRemoved: event,
      },
      alarms: { create() {}, onAlarm: event },
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        getURL: () => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        onMessage: event,
        onStartup: event,
        onInstalled: event,
        reload() {},
      },
    },
    WebSocket: class {
      static readonly OPEN = 1;
      constructor() { throw new Error("offline test harness"); }
    },
  });
  vm.runInContext(source, context);
  return context;
}

function startBackgroundIntegration(storage: Record<string, unknown>): { stop: () => void } {
  const source = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/background.js"), "utf8");
  const event = { addListener() {}, removeListener() {} };
  const context = vm.createContext({
    btoa,
    clearTimeout,
    console,
    crypto: webcrypto,
    setTimeout,
    TextEncoder,
    chrome: {
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])),
          set: async (value: Record<string, unknown>) => { Object.assign(storage, value); },
        },
      },
      tabs: {
        query: async () => [],
        sendMessage: async () => {},
        onCreated: event,
        onUpdated: event,
        onRemoved: event,
      },
      alarms: { create() {}, onAlarm: event },
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        getURL: () => "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        onMessage: event,
        onStartup: event,
        onInstalled: event,
        reload() {},
      },
    },
    WebSocket,
  });
  vm.runInContext(source, context);
  vm.runInContext(`globalThis.__stopIntegration = () => { if (ws) ws.close(); };`, context);
  return { stop: (context as { __stopIntegration: () => void }).__stopIntegration };
}

function loadBackgroundTrackedProtocol(): BackgroundProtocolHarness {
  const context = backgroundVmContext();
  vm.runInContext(`
    globalThis.__trackedProtocol = {
      install(socket, handler) { ws = socket; authenticated = true; status = 'connected'; dispatch = handler; },
      execute: executeTrackedCommand,
      cancel: cancelTrackedCommand,
    };
  `, context);
  return (context as { __trackedProtocol: BackgroundProtocolHarness }).__trackedProtocol;
}

type BackgroundPairingProtocolHarness = {
  candidates: (configuredPort: number, hasToken: boolean) => number[];
  challenge: (data: unknown, port: number, now: number) => Record<string, unknown> | null;
  approval: (data: unknown, expected: unknown, now: number) => Record<string, unknown> | null;
  auth: (data: unknown, port: number, installationId: string) => Record<string, unknown> | null;
  store: (data: unknown, expected: unknown, now: number) => Promise<Record<string, unknown>>;
  captureWrites: () => Array<Record<string, unknown>>;
};

function loadBackgroundPairingProtocol(): BackgroundPairingProtocolHarness {
  const context = backgroundVmContext();
  vm.runInContext(`
    globalThis.__credentialWrites = [];
    chrome.storage.local.set = async (value) => { globalThis.__credentialWrites.push(value); };
    globalThis.__pairingProtocol = {
      candidates: candidatePorts,
      challenge: parsePairingChallenge,
      approval: parsePairingApproval,
      auth: parseAuthenticatedHello,
      store: storeApprovedCredentials,
      captureWrites: () => globalThis.__credentialWrites,
    };
  `, context);
  return (context as { __pairingProtocol: BackgroundPairingProtocolHarness }).__pairingProtocol;
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

test("production bridge port env parsing preserves default/custom anchors and rejects invalid values", () => {
  assert.equal(parseProductionAnchorPort(undefined), 19222);
  assert.equal(parseProductionAnchorPort("45555"), 45555);
  for (const value of ["", " 19222", "19222 ", "1.5", "0", "65527", "65536", "not-a-port"]) {
    assert.throws(() => parseProductionAnchorPort(value), /PI_BROWSER_BRIDGE_PORT/);
  }
});

test("bounded startup skips an occupied non-Bridge port and never scans past ten candidates", async () => {
  const occupied = await occupyLoopbackRange(1);
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-bounded-skip-"));
  const server = new BrowserBridgeServer({ directory, anchorPort: occupied.anchor });
  try {
    await server.start();
    assert.equal(server.listeningPort(), occupied.anchor + 1);
  } finally {
    await server.shutdown();
    await occupied.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded startup fails explicitly when the ten-port range is exhausted", async () => {
  const occupied = await occupyLoopbackRange(10);
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-bounded-full-"));
  const server = new BrowserBridgeServer({ directory, anchorPort: occupied.anchor });
  try {
    await assert.rejects(
      () => server.start(),
      new RegExp(`no available port in fixed discovery range ${occupied.anchor}\\.\\.${occupied.anchor + 9}`),
    );
    assert.equal(server.listeningPort(), null);
  } finally {
    await server.shutdown();
    await occupied.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("external abort interrupts startup persistence and releases the provisional listener", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-abort-"));
  const port = await freeLoopbackPort();
  let announcePersistence!: () => void;
  const persistenceStarted = new Promise<void>((resolve) => { announcePersistence = resolve; });
  const server = new BrowserBridgeServer({
    directory,
    anchorPort: port,
    persistConfig: async () => {
      announcePersistence();
      await new Promise(() => {});
    },
  });
  const controller = new AbortController();
  try {
    const starting = server.start(controller.signal);
    await persistenceStarted;
    controller.abort(new Error("test startup abort"));
    await assert.rejects(starting, /test startup abort/);
    assert.equal(server.listeningPort(), null);
    const reuse = net.createServer();
    await new Promise<void>((resolve, reject) => {
      reuse.once("error", reject);
      reuse.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => reuse.close(() => resolve()));
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
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

test("replayed proof aborts its generation-owned marker commit before publication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-proof-replay-"));
  const port = await freeLoopbackPort();
  let markerStartedResolve!: () => void;
  const markerStarted = new Promise<void>((resolve) => { markerStartedResolve = resolve; });
  let releaseMarker!: () => void;
  const markerGate = new Promise<void>((resolve) => { releaseMarker = resolve; });
  let published = false;
  const server = new BrowserBridgeServer({
    directory,
    anchorPort: port,
    writeVerifiedMarker: async (_marker, context) => {
      markerStartedResolve();
      await markerGate;
      context.assertOwner();
      published = true;
    },
  });
  try {
    await server.start();
    const config = JSON.parse(await readFile(join(directory, "browser-bridge.json"), "utf8")) as { token: string };
    const probed = await openAuthProbe(port);
    const proof = authProof(config.token, probed.challenge);
    probed.socket.send(JSON.stringify(proof));
    await markerStarted;
    const closed = new Promise<number>((resolve) => probed.socket.once("close", (code) => resolve(code)));
    probed.socket.send(JSON.stringify(proof));
    assert.equal(await closed, 1008);
    releaseMarker();
    await eventually(() => !server.isConnected());
    assert.equal(published, false);
  } finally {
    releaseMarker();
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("newer authenticated socket generation fences reverse-interleaved marker publication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-auth-replace-"));
  const port = await freeLoopbackPort();
  let firstStartedResolve!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const published: number[] = [];
  let call = 0;
  const server = new BrowserBridgeServer({
    directory,
    anchorPort: port,
    writeVerifiedMarker: async (_marker, context) => {
      call += 1;
      const ownCall = call;
      if (ownCall === 1) {
        firstStartedResolve();
        await firstGate;
      }
      context.assertOwner();
      published.push(ownCall);
    },
  });
  try {
    await server.start();
    const config = JSON.parse(await readFile(join(directory, "browser-bridge.json"), "utf8")) as { token: string };
    const first = await openAuthProbe(port);
    first.socket.send(JSON.stringify(authProof(config.token, first.challenge)));
    await firstStarted;

    const second = await openAuthProbe(port);
    await completeAuthProof(second.socket, config.token, second.challenge);
    await eventually(() => server.isConnected());
    releaseFirst();
    await eventually(() => first.socket.readyState === WebSocket.CLOSED);
    assert.deepEqual(published, [2], "the revoked older commit must never publish after the newer generation");
    await closeRaw(second.socket);
  } finally {
    releaseFirst();
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shutdown aborts and joins marker commits before releasing server identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-auth-shutdown-"));
  const port = await freeLoopbackPort();
  let markerStartedResolve!: () => void;
  const markerStarted = new Promise<void>((resolve) => { markerStartedResolve = resolve; });
  let releaseMarker!: () => void;
  const markerGate = new Promise<void>((resolve) => { releaseMarker = resolve; });
  let published = false;
  const server = new BrowserBridgeServer({
    directory,
    anchorPort: port,
    writeVerifiedMarker: async (_marker, context) => {
      markerStartedResolve();
      await markerGate;
      context.assertOwner();
      published = true;
    },
  });
  try {
    await server.start();
    const config = JSON.parse(await readFile(join(directory, "browser-bridge.json"), "utf8")) as { token: string };
    const probed = await openAuthProbe(port);
    probed.socket.send(JSON.stringify(authProof(config.token, probed.challenge)));
    await markerStarted;
    let shutdownSettled = false;
    const shutdown = server.shutdown().then(() => { shutdownSettled = true; });
    await delay(30);
    assert.equal(shutdownSettled, false, "shutdown must join the publication-capable marker writer");
    assert.equal(server.listeningPort(), port, "identity is retained until the marker commit joins");
    releaseMarker();
    await shutdown;
    assert.equal(server.listeningPort(), null);
    assert.equal(published, false);
  } finally {
    releaseMarker();
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waitUntilConnected times out without an authenticated extension", async () => {
  await assert.rejects(
    () => browserBridge.waitUntilConnected(40),
    /no authenticated extension connected within 40ms.*browser status\/browser pair/i,
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

test("HMAC authentication rejects wrong and cross-socket proofs while legacy raw auth remains accepted", async () => {
  const { port, token } = await bridgeConfig();

  const wrong = await openAuthProbe(port);
  const wrongClosed = new Promise<number>((resolve) => wrong.socket.once("close", (code) => resolve(code)));
  wrong.socket.send(JSON.stringify(authProof("z".repeat(43), wrong.challenge)));
  assert.equal(await wrongClosed, 1008);

  const first = await openAuthProbe(port);
  const second = await openAuthProbe(port);
  const crossClosed = new Promise<number>((resolve) => second.socket.once("close", (code) => resolve(code)));
  second.socket.send(JSON.stringify(authProof(token, first.challenge)));
  assert.equal(await crossClosed, 1008);
  await closeRaw(first.socket);

  const ambiguousLegacy = await openRaw(port, { type: "auth", token, protocol: "unexpected" });
  assert.equal((await ambiguousLegacy.closed).code, 1008, "legacy auth decoder rejects mixed/extra fields");

  const legacy = await openAuthenticatedRaw(port, token);
  assert.equal(browserBridge.isConnected(), true);
  await closeRaw(legacy);
});

test("HMAC authentication rejects expired proofs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-expired-proof-"));
  const port = await freeLoopbackPort();
  const server = new BrowserBridgeServer({ directory, anchorPort: port, authChallengeTtlMs: 20 });
  try {
    await server.start();
    const config = JSON.parse(await readFile(join(directory, "browser-bridge.json"), "utf8")) as { token: string };
    const probed = await openAuthProbe(port);
    const closed = new Promise<number>((resolve) => probed.socket.once("close", (code) => resolve(code)));
    await delay(30);
    probed.socket.send(JSON.stringify(authProof(config.token, probed.challenge)));
    assert.equal(await closed, 1008);
    assert.equal(server.isConnected(), false);
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
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

test("discovery rejects an open WebSocket that does not speak the Browser Bridge protocol", async () => {
  const { port } = await bridgeConfig();
  const socket = await openRaw(port, {
    type: "pairing_request",
    protocol: "unrelated-local-websocket/v1",
    origin: "chrome-extension://not-bridge",
  });
  const outcome = await socket.closed;
  assert.equal(outcome.code, 1008);
  assert.match(outcome.reason, /unrecognized.*protocol/i);
  assert.equal(browserBridge.pairingRequests().length, 0);
});

test("a newer extension generation replaces the old code and stale approval fails closed", async () => {
  const { port } = await bridgeConfig();
  const first = await openPairingRaw(port, { installationId: "same-extension-installation" });
  const firstClosed = new Promise<{ code: number; reason: string }>((resolve) => {
    first.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const second = await openPairingRaw(port, { installationId: "same-extension-installation" });
  try {
    const replaced = await firstClosed;
    assert.equal(replaced.code, 1008);
    assert.match(replaced.reason, /replaced/i);
    assert.equal(browserBridge.pairingRequests().length, 1);
    assert.equal(browserBridge.pairingRequests()[0]?.requestId, second.challenge.requestId);
    await assert.rejects(
      () => browserBridge.approvePairing(first.challenge.requestId, first.challenge.code),
      /missing or expired/i,
    );
    const wrongCode = second.challenge.code === "000000" ? "999999" : "000000";
    await assert.rejects(
      () => browserBridge.approvePairing(second.challenge.requestId, wrongCode),
      /code does not match/i,
    );
    assert.equal(browserBridge.pairingRequests()[0]?.requestId, second.challenge.requestId);
  } finally {
    await closeRaw(second.socket);
  }
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
    assert.equal(challenge.generation, requests[0]?.generation);
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
    await assert.rejects(
      () => server.approvePairing(pairing.challenge.requestId, pairing.challenge.code),
      /missing or expired/i,
    );
    assert.equal(server.isConnected(), false);
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pairing approval never writes a verified marker; only authenticated reconnect does", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-pair-marker-"));
  const markerPath = join(directory, "browser-bridge.verified");
  const port = await freeLoopbackPort();
  const server = new BrowserBridgeServer({ directory, anchorPort: port });
  try {
    await server.start();
    const config = JSON.parse(await readFile(join(directory, "browser-bridge.json"), "utf8")) as { token: string };
    const pairing = await openPairingRaw(port, { installationId: "pair-marker-test" });
    await server.approvePairing(pairing.challenge.requestId, pairing.challenge.code);
    assert.equal(statSync(markerPath, { throwIfNoEntry: false }), undefined);
    await closeRaw(pairing.socket);

    const authenticated = await openAuthProbe(port);
    await completeAuthProof(authenticated.socket, config.token, authenticated.challenge);
    await eventually(() => server.isConnected());
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { protocol: string };
    assert.equal(marker.protocol, "challenge-hmac-sha256-v1");
    await closeRaw(authenticated.socket);
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticated marker atomically replaces an existing regular marker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-browser-bridge-marker-replace-"));
  const markerPath = join(directory, "browser-bridge.verified");
  const port = await freeLoopbackPort();
  const server = new BrowserBridgeServer({ directory, anchorPort: port });
  try {
    await server.start();
    const config = JSON.parse(await readFile(join(directory, "browser-bridge.json"), "utf8")) as { token: string };
    writeFileSync(markerPath, '{"version":1,"protocol":"first-frame-token-v1","port":1,"verifiedAt":"stale"}\n', { mode: 0o600 });

    const authenticated = await openAuthProbe(port);
    await completeAuthProof(authenticated.socket, config.token, authenticated.challenge);
    await eventually(() => server.isConnected());

    const marker = JSON.parse(await readFile(markerPath, "utf8")) as { protocol: string; port: number };
    assert.equal(marker.protocol, "challenge-hmac-sha256-v1");
    assert.equal(marker.port, port);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    await closeRaw(authenticated.socket);
  } finally {
    await server.shutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manager status/pair deliver exact-generation credentials but stay inert until token reconnect", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const manager = new BrowserManager();
  const { port, token, installationId } = await bridgeConfig();
  const { socket, challenge } = await openPairingRaw(port, {
    origin: "chrome-extension://approved",
    installationId: "approved-proposal",
  });
  try {
    const pendingStatus = await manager.status();
    assert.equal(pendingStatus.bridge.pendingPairings[0]?.requestId, challenge.requestId);
    assert.equal(pendingStatus.bridge.pendingPairings[0]?.code, challenge.code);
    await assert.rejects(
      () => manager.pair(challenge.requestId, "000000"),
      /pairing code/i,
    );
    const approvedFrame = waitForSocketMessage<{
      type: "pairing_approved";
      protocol: string;
      requestId: string;
      token: string;
      port: number;
      installationId: string;
      generation: number;
      expiresAt: number;
    }>(
      socket,
      (message): message is Record<string, unknown> & {
        type: "pairing_approved";
        protocol: string;
        requestId: string;
        token: string;
        port: number;
        installationId: string;
        generation: number;
        expiresAt: number;
      } => message.type === "pairing_approved" && typeof message.token === "string",
    );
    const approval = manager.pair(challenge.requestId, challenge.code);
    await delay(0);
    await assert.rejects(
      () => browserBridge.approvePairing(challenge.requestId, challenge.code),
      /already in progress|missing or expired/i,
    );
    assert.deepEqual(await approval, { requestId: challenge.requestId, port, installationId });
    assert.deepEqual(await approvedFrame, {
      type: "pairing_approved",
      protocol: "pi-browser-bridge/v1",
      requestId: challenge.requestId,
      token,
      port,
      installationId,
      generation: challenge.generation,
      expiresAt: challenge.expiresAt,
    });
    assert.equal(browserBridge.connectionIdentity(), null, "credential delivery must not promote the pairing socket");
    assert.equal(browserBridge.pairingRequests().length, 0);
  } finally {
    await closeRaw(socket);
  }
  await delay(20);

  const reconnected = new MockExtension(() => ({ ok: true, data: "paired-token-valid" }));
  await reconnected.connect(port, token);
  try {
    const result = await browserBridge.send("exec", { tabId: 1, code: "1" }, 500);
    assert.equal(result.data, "paired-token-valid");
  } finally {
    await reconnected.close();
  }
  await delay(20);
});

test("empty extension storage discovers, persists only approved credentials, reconnects, and reload authenticates", async () => {
  const storage: Record<string, unknown> = {};
  const firstWorker = startBackgroundIntegration(storage);
  let reloadWorker: { stop: () => void } | null = null;
  try {
    await eventually(() => browserBridge.pairingRequests().length === 1);
    assert.deepEqual(storage, {}, "discovery and challenge must not persist provisional credentials");
    const request = browserBridge.pairingRequests()[0];
    assert.ok(request);
    const approval = await browserBridge.approvePairing(request.requestId, request.code);
    await eventually(() => browserBridge.isConnected() && typeof storage.pi_ws_token === "string");
    assert.deepEqual({
      port: storage.pi_ws_port,
      token: storage.pi_ws_token,
      installationId: storage.pi_ws_installation_id,
    }, {
      port: approval.port,
      token: (await bridgeConfig()).token,
      installationId: approval.installationId,
    });

    firstWorker.stop();
    await eventually(() => !browserBridge.isConnected());
    reloadWorker = startBackgroundIntegration(storage);
    await eventually(() => browserBridge.isConnected());
    assert.equal(browserBridge.pairingRequests().length, 0, "stored credentials must bypass pairing on reload");
  } finally {
    firstWorker.stop();
    reloadWorker?.stop();
    await eventually(() => !browserBridge.isConnected()).catch(() => {});
  }
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

test("failed owned extension open and concurrent closeAll wait for the real close terminal and preserve both errors", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const events: string[] = [];
  let closeStartedResolve!: () => void;
  const closeStarted = new Promise<void>((resolve) => { closeStartedResolve = resolve; });
  let releaseClose = () => {};
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const extension = new MockExtension(async (message) => {
    if (message.cmd !== "tabs") return { ok: false, error: "unexpected command" };
    if (message.method === "query") return { ok: true, data: [] };
    if (message.method === "create") return { ok: true, data: { id: 71, url: String(message.url), title: "Owned" } };
    if (message.method === "get") return { ok: true, data: { id: 71, url: 42, title: "invalid" } };
    if (message.method === "close") {
      events.push("close-start");
      closeStartedResolve();
      await closeGate;
      events.push("close-terminal");
      return { ok: false, error: "owned cleanup close failed" };
    }
    return { ok: false, error: `unexpected tabs method ${String(message.method)}` };
  }, []);
  await extension.connect(port, token);
  const manager = new BrowserManager();
  try {
    const opening = manager.open({
      name: "failed-owned",
      cwd: process.cwd(),
      channel: "extension",
      url: "https://owned-failure.example/",
      timeoutMs: 2_000,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    await closeStarted;
    let closeAllSettled = false;
    const closing = manager.closeAll().then(() => { closeAllSettled = true; });
    await delay(30);
    assert.equal(closeAllSettled, false, "closeAll must join the failed opening's physical close terminal");

    releaseClose();
    const outcome = await opening;
    assert.equal(outcome.ok, false);
    assert.ok("error" in outcome && outcome.error instanceof AggregateError);
    const messages = "error" in outcome && outcome.error instanceof AggregateError
      ? outcome.error.errors.map((error) => error instanceof Error ? error.message : String(error))
      : [];
    assert.ok(messages.some((message) => /tabs\.get returned invalid tab metadata/i.test(message)), "the original open error must remain visible");
    assert.ok(messages.some((message) => /owned cleanup close failed/i.test(message)), "the cleanup error must remain visible");
    await closing;
    assert.deepEqual(events, ["close-start", "close-terminal"]);
    assert.equal(manager.has("failed-owned"), false, "failed open must release its local binding after cleanup");
  } finally {
    releaseClose();
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

test("extension caller timeout retains borrowed ownership until the real command terminal", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const events: string[] = [];
  let releaseExec!: () => void;
  let execStartedResolve!: () => void;
  const execGate = new Promise<void>((resolve) => { releaseExec = resolve; });
  const execStarted = new Promise<void>((resolve) => { execStartedResolve = resolve; });
  const extension = new MockExtension(async (message) => {
    if (message.cmd === "tabs" && (!message.method || message.method === "query")) {
      return { ok: true, data: [{ id: 7, url: "https://borrowed.example", title: "Borrowed" }] };
    }
    if (message.cmd === "tabs" && message.method === "get") {
      return { ok: true, data: { id: 7, url: "https://borrowed.example", title: "Borrowed" } };
    }
    if (message.cmd === "exec") {
      events.push("exec-start");
      execStartedResolve();
      await execGate;
      events.push("exec-terminal");
      return { ok: true, data: "done" };
    }
    if (message.cmd === "tabs" && message.method === "close") {
      events.push("tab-close");
      return { ok: true, data: null };
    }
    return { ok: true, data: null };
  }, [{ id: 7, url: "https://borrowed.example", title: "Borrowed" }]);
  const manager = new BrowserManager();
  await extension.connect(port, token);
  try {
    await manager.open({ name: "timeout-borrowed", cwd: process.cwd(), channel: "extension", target: "borrowed.example", timeoutMs: 2_000 });
    const run = manager.run("timeout-borrowed", "return await page.evaluate(() => 'slow');", process.cwd(), undefined, 60);
    await execStarted;
    await assert.rejects(run, /timed out/i);
    assert.equal((await manager.status()).bridge.drainingCommands, 1);
    let closeSettled = false;
    const closing = manager.close("timeout-borrowed").then((value) => { closeSettled = true; return value; });
    await delay(30);
    assert.equal(closeSettled, false, "borrowed close must retain ownership until the real terminal");
    releaseExec();
    assert.equal(await closing, true);
    assert.deepEqual(events, ["exec-start", "exec-terminal"], "borrowed close must never close the user's tab");
  } finally {
    releaseExec();
    await manager.closeAll();
    await extension.close();
  }
});

test("extension caller timeout orders owned tab destruction after the real command terminal", async () => {
  const { BrowserManager } = await import("../src/tools/browser/manager.ts");
  const { port, token } = await bridgeConfig();
  const events: string[] = [];
  let releaseExec!: () => void;
  let execStartedResolve!: () => void;
  const execGate = new Promise<void>((resolve) => { releaseExec = resolve; });
  const execStarted = new Promise<void>((resolve) => { execStartedResolve = resolve; });
  const extension = new MockExtension(async (message) => {
    if (message.cmd === "tabs" && (!message.method || message.method === "query")) return { ok: true, data: [] };
    if (message.cmd === "tabs" && message.method === "create") {
      return { ok: true, data: { id: 8, url: "https://owned.example", title: "Owned" } };
    }
    if (message.cmd === "tabs" && message.method === "get") {
      return { ok: true, data: { id: 8, url: "https://owned.example", title: "Owned" } };
    }
    if (message.cmd === "exec") {
      events.push("exec-start");
      execStartedResolve();
      await execGate;
      events.push("exec-terminal");
      return { ok: true, data: "done" };
    }
    if (message.cmd === "tabs" && message.method === "close") {
      events.push("tab-close");
      return { ok: true, data: null };
    }
    return { ok: true, data: null };
  }, []);
  const manager = new BrowserManager();
  await extension.connect(port, token);
  try {
    await manager.open({ name: "timeout-owned", cwd: process.cwd(), channel: "extension", url: "https://owned.example", timeoutMs: 2_000 });
    const run = manager.run("timeout-owned", "return await page.evaluate(() => 'slow');", process.cwd(), undefined, 60);
    await execStarted;
    await assert.rejects(run, /timed out/i);
    let closeSettled = false;
    const closing = manager.close("timeout-owned").then((value) => { closeSettled = true; return value; });
    await delay(30);
    assert.equal(closeSettled, false, "owned close must not overtake an acknowledged command");
    releaseExec();
    assert.equal(await closing, true);
    assert.deepEqual(events, ["exec-start", "exec-terminal", "tab-close"]);
  } finally {
    releaseExec();
    await manager.closeAll();
    await extension.close();
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

test("extension token discovery sends only probes to a malicious candidate and authenticates the next marked listener", async () => {
  const context = backgroundVmContext();
  vm.runInContext(`
    const __framesByPort = new Map();
    class DiscoverySocket {
      static OPEN = 1;
      constructor(url) {
        this.port = Number(url.slice(url.lastIndexOf(':') + 1));
        this.readyState = 0;
        __framesByPort.set(this.port, []);
        Promise.resolve().then(() => { this.readyState = 1; this.onopen?.(); });
      }
      send(frame) {
        const message = JSON.parse(frame);
        __framesByPort.get(this.port).push(message);
        if (this.port === 19222) {
          Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify({ type: 'foreign_listener' }) }));
          return;
        }
        if (message.type === 'auth_probe') {
          Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify({
            type: 'auth_challenge',
            protocol: HMAC_AUTH_PROTOCOL,
            clientNonce: message.clientNonce,
            serverNonce: 's'.repeat(22),
            installationId: '22222222-2222-4222-8222-222222222222',
            port: 19223,
            generation: 8,
            expiresAt: Date.now() + 5000,
          }) }));
        } else if (message.type === 'auth_proof') {
          Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify({
            type: 'auth_ok',
            protocol: BRIDGE_PROTOCOL,
            port: 19223,
            installationId: '22222222-2222-4222-8222-222222222222',
          }) }));
        }
      }
      close(code = 1000) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        Promise.resolve().then(() => this.onclose?.({ code }));
      }
    }
    WebSocket = DiscoverySocket;
    connectionAttempt = 50;
    ws = null;
    status = 'connecting';
    wsPort = 19223;
    globalThis.__discoveryHarness = {
      run: async () => {
        const first = await connectCandidate(19222, 't'.repeat(43), '22222222-2222-4222-8222-222222222222', 50);
        const second = await connectCandidate(19223, 't'.repeat(43), '22222222-2222-4222-8222-222222222222', 50);
        return { first, second };
      },
      frames: () => Object.fromEntries([...__framesByPort].map(([port, frames]) => [port, frames])),
      state: () => ({ status, authenticated }),
    };
  `, context);
  const harness = (context as unknown as {
    __discoveryHarness: {
      run: () => Promise<{ first: string; second: string }>;
      frames: () => Record<string, Array<Record<string, unknown>>>;
      state: () => { status: string; authenticated: boolean };
    };
  }).__discoveryHarness;
  assert.deepEqual(JSON.parse(JSON.stringify(await harness.run())), { first: "miss", second: "accepted" });
  const frames = JSON.parse(JSON.stringify(harness.frames())) as Record<string, Array<Record<string, unknown>>>;
  assert.deepEqual(frames["19222"]?.map((frame) => frame.type), ["auth_probe"]);
  assert.equal(frames["19222"]?.some((frame) => "token" in frame), false);
  assert.deepEqual(frames["19223"]?.slice(0, 2).map((frame) => frame.type), ["auth_probe", "auth_proof"]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state())), { status: "connected", authenticated: true });
});

test("delayed extension storage continuation cannot publish connected for a stale attempt", async () => {
  const context = backgroundVmContext();
  vm.runInContext(`
    let __releaseStorage;
    let __storageStartedResolve;
    const __storageStarted = new Promise((resolve) => { __storageStartedResolve = resolve; });
    const __storageGate = new Promise((resolve) => { __releaseStorage = resolve; });
    chrome.storage.local.set = async () => { __storageStartedResolve(); await __storageGate; };
    let __lastSocket;
    class AttemptSocket {
      static OPEN = 1;
      constructor(url) {
        __lastSocket = this;
        this.url = url;
        this.readyState = 0;
        Promise.resolve().then(() => { this.readyState = 1; this.onopen?.(); });
      }
      send(frame) {
        const message = JSON.parse(frame);
        if (message.type === 'auth_probe') {
          const challenge = {
            type: 'auth_challenge',
            protocol: HMAC_AUTH_PROTOCOL,
            clientNonce: message.clientNonce,
            serverNonce: 's'.repeat(22),
            installationId: '22222222-2222-4222-8222-222222222222',
            port: 19223,
            generation: 7,
            expiresAt: Date.now() + 5000,
          };
          Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify(challenge) }));
        } else if (message.type === 'auth_proof') {
          const hello = {
            type: 'auth_ok',
            protocol: BRIDGE_PROTOCOL,
            port: 19223,
            installationId: '22222222-2222-4222-8222-222222222222',
          };
          Promise.resolve().then(() => this.onmessage?.({ data: JSON.stringify(hello) }));
        }
      }
      close(code = 1000) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        Promise.resolve().then(() => this.onclose?.({ code }));
      }
    }
    WebSocket = AttemptSocket;
    connectionAttempt = 40;
    ws = null;
    status = 'authenticating';
    wsPort = 19222;
    globalThis.__attemptHarness = {
      run: () => connectCandidate(19223, 't'.repeat(43), '22222222-2222-4222-8222-222222222222', 40),
      storageStarted: __storageStarted,
      replace: () => {
        connectionAttempt = 41;
        ws = { readyState: AttemptSocket.OPEN };
        authenticated = false;
        status = 'connecting';
      },
      release: () => __releaseStorage(),
      closeOld: () => __lastSocket.close(),
      state: () => ({ status, authenticated, attempt: connectionAttempt }),
    };
  `, context);
  const harness = (context as unknown as {
    __attemptHarness: {
      run: () => Promise<string>;
      storageStarted: Promise<void>;
      replace: () => void;
      release: () => void;
      closeOld: () => void;
      state: () => { status: string; authenticated: boolean; attempt: number };
    };
  }).__attemptHarness;
  const running = harness.run();
  await harness.storageStarted;
  harness.replace();
  harness.release();
  await delay(20);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.state())), { status: "connecting", authenticated: false, attempt: 41 });
  harness.closeOld();
  assert.equal(await running, "miss");
});

test("extension discovery recognizes protocol frames, stays bounded, and stores credentials only for the exact approval", async () => {
  const protocol = loadBackgroundPairingProtocol();
  const hostValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  assert.deepEqual(Array.from(protocol.candidates(19222, false)), [19222, 19223, 19224, 19225, 19226, 19227, 19228, 19229, 19230, 19231]);
  assert.deepEqual(Array.from(protocol.candidates(45555, true)), [45555, 19222, 19223, 19224, 19225, 19226, 19227, 19228, 19229, 19230, 19231]);

  const now = 1_000_000;
  const requestId = "11111111-1111-4111-8111-111111111111";
  const installationId = "22222222-2222-4222-8222-222222222222";
  const challengeFrame = {
    type: "pairing_challenge",
    protocol: "pi-browser-bridge/v1",
    requestId,
    code: "123456",
    generation: 9,
    expiresAt: now + 30_000,
  };
  assert.equal(protocol.challenge({ ...challengeFrame, protocol: "other-service/v1" }, 19222, now), null, "an open non-Bridge WebSocket must be skipped");
  const challenge = protocol.challenge(challengeFrame, 19222, now);
  assert.deepEqual(hostValue(challenge), { requestId, code: "123456", generation: 9, expiresAt: now + 30_000, port: 19222 });

  const approvalFrame = {
    type: "pairing_approved",
    protocol: "pi-browser-bridge/v1",
    requestId,
    token: "t".repeat(43),
    port: 19222,
    installationId,
    generation: 9,
    expiresAt: now + 30_000,
  };
  assert.equal(protocol.approval({ ...approvalFrame, generation: 10 }, challenge, now), null);
  assert.equal(protocol.approval({ ...approvalFrame, expiresAt: now - 1 }, challenge, now), null);
  await assert.rejects(() => protocol.store({ ...approvalFrame, requestId: "replaced" }, challenge, now), /invalid.*approval/i);
  assert.deepEqual(hostValue(protocol.captureWrites()), [], "invalid approval must never write credentials");

  assert.deepEqual(hostValue(await protocol.store(approvalFrame, challenge, now)), {
    port: 19222,
    token: "t".repeat(43),
    installationId,
  });
  assert.deepEqual(hostValue(protocol.captureWrites()), [{
    pi_ws_port: 19222,
    pi_ws_token: "t".repeat(43),
    pi_ws_installation_id: installationId,
  }]);
  assert.deepEqual(hostValue(protocol.auth({
    type: "auth_ok",
    protocol: "pi-browser-bridge/v1",
    port: 19222,
    installationId,
  }, 19222, installationId)), { installationId });
  assert.equal(protocol.auth({ type: "auth_ok", port: 19222, installationId }, 19222, installationId), null);
});

test("extension sources auto-discover/pair, preserve legacy fields, and implement command methods", () => {
  const background = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/background.js"), "utf8");
  const popup = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/popup.js"), "utf8");
  const popupHtml = readFileSync(join(import.meta.dirname, "../optional/browser-bridge/popup.html"), "utf8");
  const probeFrame = background.indexOf("type: 'auth_probe'");
  const proofFrame = background.indexOf("type: 'auth_proof'");
  const readyFrame = background.indexOf("type: 'ext_ready'");
  assert.ok(probeFrame >= 0 && proofFrame > probeFrame && readyFrame > proofFrame);
  assert.doesNotMatch(background, /\{ type: 'auth', token \}/, "discovery must never publish the stored raw token");
  assert.match(background, /parseAuthChallenge/);
  assert.match(background, /createAuthProof/);
  assert.match(background, /parseAuthenticatedHello/);
  assert.match(background, /DEFAULT_WS_PORT = 19222/);
  assert.match(background, /DISCOVERY_LAST_PORT = 19231/);
  assert.match(background, /type: 'pairing_request'/);
  assert.match(background, /storeApprovedCredentials/);
  assert.match(background, /STORAGE_INSTALLATION_KEY/);
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
  assert.match(popup, /pairing-pending/);
  assert.match(popupHtml, /<details id="advanced">/);
  assert.match(popupHtml, /browser status/);
  assert.match(popupHtml, /browser pair/);
});

test("shutdown terminalizes tracked work, closes sockets, and waits until the port is reusable", async () => {
  const { port, token } = await bridgeConfig();
  const extension = new MockExtension(() => null);
  await extension.connect(port, token);
  const handle = await browserBridge.sendTracked("exec", { tabId: 1, code: "pending" }, 1_000);
  const responseRejected = assert.rejects(() => handle.response, /shut down/i);
  const extensionClosed = extension.waitForClose();
  await browserBridge.shutdown();
  await responseRejected;
  assert.equal((await handle.terminal).status, "shutdown");
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

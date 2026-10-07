import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import {
  BRIDGE_READY_PROTOCOL, BRIDGE_OWNER_PROTOCOL, BrowserBridgeServer,
  HMAC_AUTH_PROTOCOL, parseProductionAuthMode, isAllowedBridgeOrigin,
} from "../src/tools/browser/bridge-server.ts";
import type {
  BridgeReadyChallenge, BridgeReadyFrame, BridgeReadyMessage, BridgeClaimResult,
  BridgeOwnerIdentity, NoneReadyMarker, BrowserBridgeServerOptions,
} from "../src/tools/browser/bridge-server.ts";

const nonce = () => randomBytes(16).toString("base64url");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

type Frame = Record<string, unknown>;
function message<T>(socket: WebSocket, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", onMessage); reject(new Error(`missing ${type}`)); }, 2_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      if (frame.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame as T);
    };
    socket.on("message", onMessage);
  });
}
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}
async function open(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: extensionOrigin });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
}
async function probe(server: InstanceType<typeof BrowserBridgeServer>): Promise<{ socket: WebSocket; challenge: BridgeReadyChallenge }> {
  const socket = await open(server.listeningPort()!);
  const received = message<BridgeReadyChallenge>(socket, "bridge_challenge");
  const clientNonce = nonce();
  socket.send(JSON.stringify({ type: "bridge_probe", protocol: BRIDGE_READY_PROTOCOL, authMode: "none", clientNonce }));
  const challenge = await received;
  assert.equal(challenge.clientNonce, clientNonce);
  return { socket, challenge };
}
function echo(challenge: BridgeReadyChallenge): BridgeReadyMessage {
  return {
    type: "bridge_ready", protocol: BRIDGE_READY_PROTOCOL, authMode: "none",
    clientNonce: challenge.clientNonce, serverNonce: challenge.serverNonce,
    installationId: challenge.installationId, serverInstanceId: challenge.serverInstanceId,
    generation: challenge.generation,
  };
}
async function ready(server: InstanceType<typeof BrowserBridgeServer>) {
  const { socket, challenge } = await probe(server);
  const received = message<BridgeReadyFrame>(socket, "bridge_ready");
  socket.send(JSON.stringify(echo(challenge)));
  return { socket, challenge, frame: await received };
}
async function fixture(options: BrowserBridgeServerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-none-"));
  const server = new BrowserBridgeServer({ directory, authMode: "none", ...options });
  await server.start();
  return { directory, server, dispose: async () => { await server.shutdown(); await rm(directory, { recursive: true, force: true }); } };
}

test("NONE mode parsing defaults to paired, rejects invalid values, and freezes env at construction", async () => {
  assert.equal(parseProductionAuthMode(undefined), "paired");
  assert.equal(parseProductionAuthMode("none"), "none");
  assert.equal(parseProductionAuthMode("paired"), "paired");
  for (const value of ["", "NONE", " none", "none ", "off", "token"]) {
    assert.throws(() => parseProductionAuthMode(value), /PI_BROWSER_BRIDGE_AUTH_MODE/);
    assert.throws(() => new BrowserBridgeServer({ authMode: value as "none" }), /PI_BROWSER_BRIDGE_AUTH_MODE/);
  }
  const previous = process.env.PI_BROWSER_BRIDGE_AUTH_MODE;
  try {
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = "none";
    const server = new BrowserBridgeServer();
    process.env.PI_BROWSER_BRIDGE_AUTH_MODE = "paired";
    assert.equal(server.authMode(), "none");
  } finally {
    if (previous === undefined) delete process.env.PI_BROWSER_BRIDGE_AUTH_MODE;
    else process.env.PI_BROWSER_BRIDGE_AUTH_MODE = previous;
  }
});

test("NONE empty credentials becomes ready without authentication or pairing; commands carry instance and owner", async () => {
  const f = await fixture({ persistConfig: async () => { throw new Error("NONE touched credentials"); } });
  try {
    const waiting = f.server.waitUntilConnected(1_000);
    const { socket, challenge, frame } = await ready(f.server);
    await waiting;
    assert.equal(frame.protocol, BRIDGE_READY_PROTOCOL);
    assert.equal(frame.authMode, "none");
    assert.equal(frame.authenticated, false);
    assert.equal(frame.serverInstanceId, challenge.serverInstanceId);
    assert.equal(frame.generation, challenge.generation);
    assert.deepEqual(frame.capabilities, [BRIDGE_OWNER_PROTOCOL]);
    assert.equal(f.server.isConnected(), true);
    assert.equal(f.server.isAuthenticated(), false);
    assert.deepEqual(f.server.pairingRequests(), []);
    const identity = f.server.connectionIdentity()!;
    assert.equal(f.server.transportState().ready, true);
    assert.equal(f.server.transportState().authenticated, false);
    assert.throws(() => f.server.assertConnection({ installationId: identity.installationId, generation: identity.generation }), /generation mismatch/);
    assert.throws(() => f.server.assertConnection({ ...identity, serverInstanceId: "another-instance" }), /generation mismatch/);
    assert.throws(() => f.server.assertConnection({ ...identity, authMode: "paired" }), /generation mismatch/);
    const owner: BridgeOwnerIdentity = { namespace: "session-a", ownerId: "agent-a" };
    const command = new Promise<Frame>((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Frame)));
    const handle = await f.server.sendTracked("claim", { tabId: 7, owner, connection: { forged: true }, id: "forged" }, 1_000, identity);
    const sent = await command;
    assert.equal(sent.id, handle.id);
    assert.deepEqual(sent.owner, owner);
    assert.deepEqual(sent.connection, identity);
    const result: BridgeClaimResult = {
      tabId: 7, lease: { ...owner, serverInstanceId: identity.serverInstanceId, generation: identity.generation, claimId: "claim-a" },
    };
    socket.send(JSON.stringify({ type: "result", id: handle.id, data: result }));
    assert.deepEqual((await handle.response).data, result);
    assert.equal((await handle.terminal).status, "result");
    const names = await readdir(f.directory);
    assert.deepEqual(names, ["browser-bridge.none"]);
    const marker = JSON.parse(await readFile(join(f.directory, "browser-bridge.none", `${identity.serverInstanceId}.ready.json`), "utf8")) as NoneReadyMarker;
    assert.equal(marker.authenticated, false);
    assert.equal(marker.authMode, "none");
    assert.equal(marker.generation, identity.generation);
    assert.equal(marker.serverInstanceId, identity.serverInstanceId);
    assert.ok(Date.parse(marker.readyAt));
    assert.equal("token" in marker, false);
  } finally { await f.dispose(); }
});

test("NONE two listeners leave malformed legacy credentials, port and authenticated history byte-identical", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bridge-none-isolation-"));
  const legacy = new Map([
    ["browser-bridge.json", "malformed old credentials must not be read"],
    ["browser-bridge.port", "19222\n"],
    ["browser-bridge.verified", "old paired history"],
  ]);
  for (const [name, contents] of legacy) await writeFile(join(directory, name), contents);
  const a = new BrowserBridgeServer({ directory, authMode: "none" });
  const b = new BrowserBridgeServer({ directory, authMode: "none" });
  try {
    await Promise.all([a.start(), b.start()]);
    const [first, second] = await Promise.all([ready(a), ready(b)]);
    assert.notEqual(first.frame.serverInstanceId, second.frame.serverInstanceId);
    assert.notEqual(a.listeningPort(), b.listeningPort());
    for (const [name, contents] of legacy) assert.equal(await readFile(join(directory, name), "utf8"), contents);
    assert.equal((await readdir(join(directory, "browser-bridge.none"))).length, 2);
    const old = a.connectionIdentity()!;
    await a.shutdown();
    await a.start();
    const restarted = await ready(a);
    assert.notEqual(restarted.frame.serverInstanceId, old.serverInstanceId);
    assert.throws(() => a.assertConnection(old), /generation mismatch/);
  } finally { await Promise.all([a.shutdown(), b.shutdown()]); await rm(directory, { recursive: true, force: true }); }
});

test("NONE readiness rejects wrong nonce, generation, instance, expired and cross-socket echoes", async (t) => {
  const f = await fixture({ authChallengeTtlMs: 60 });
  try {
    for (const field of ["clientNonce", "serverNonce", "generation", "serverInstanceId", "installationId", "protocol", "expired", "extra"]) {
      await t.test(field, async () => {
        const { socket, challenge } = await probe(f.server);
        const frame: Frame = { ...echo(challenge) };
        if (field === "generation") frame.generation = challenge.generation + 1;
        else if (field === "serverInstanceId" || field === "installationId") frame[field] = "11111111-1111-4111-8111-111111111111";
        else if (field === "expired") await delay(80);
        else if (field === "extra") frame.token = "not-a-token-protocol";
        else frame[field] = nonce();
        const closure = closed(socket);
        socket.send(JSON.stringify(frame));
        assert.equal(await closure, 1008);
        assert.equal(f.server.isConnected(), false);
        assert.equal(f.server.isAuthenticated(), false);
      });
    }
    const first = await probe(f.server);
    const second = await probe(f.server);
    const closure = closed(second.socket);
    second.socket.send(JSON.stringify(echo(first.challenge)));
    assert.equal(await closure, 1008);
    first.socket.terminate();
    assert.deepEqual(f.server.pairingRequests(), []);
    assert.deepEqual(await readdir(f.directory), []);
  } finally { await f.dispose(); }
});

test("NONE refuses pairing, raw token, HMAC, binary and malformed first frames without producing pairing requests", async () => {
  const f = await fixture();
  try {
    for (const frame of [
      { type: "pairing_request", protocol: "pi-browser-bridge/v1" },
      { type: "auth", token: nonce() },
      { type: "auth_probe", protocol: HMAC_AUTH_PROTOCOL, clientNonce: nonce() },
      { type: "ext_ready", tabs: [] },
      { type: "bridge_probe", protocol: BRIDGE_READY_PROTOCOL, authMode: "paired", clientNonce: nonce() },
      { type: "bridge_probe", protocol: "wrong", authMode: "none", clientNonce: nonce() },
      { type: "bridge_probe", protocol: BRIDGE_READY_PROTOCOL, authMode: "none", clientNonce: "short" },
      Buffer.from("{}"),
    ]) {
      const socket = await open(f.server.listeningPort()!);
      const closure = closed(socket);
      socket.send(Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
      assert.equal(await closure, 1008);
      assert.deepEqual(f.server.pairingRequests(), []);
      assert.equal(f.server.isAuthenticated(), false);
    }
  } finally { await f.dispose(); }
});

test("NONE and paired upgrades reject webpage/null Origin while accepting extension and native no-Origin", async (t) => {
  assert.equal(isAllowedBridgeOrigin(undefined), true);
  assert.equal(isAllowedBridgeOrigin(extensionOrigin), true);
  assert.equal(isAllowedBridgeOrigin("moz-extension://11111111-1111-4111-8111-111111111111"), true);
  for (const authMode of ["none", "paired"] as const) await t.test(authMode, async () => {
    const f = await fixture({ authMode });
    try {
      for (const origin of ["http://127.0.0.1", "https://example.com", "null", "", "chrome-extension://bad", `${extensionOrigin}.example.com`]) {
        const socket = new WebSocket(`ws://127.0.0.1:${f.server.listeningPort()}`, { headers: { Origin: origin } });
        const error = await new Promise<Error>((resolve, reject) => {
          socket.once("error", resolve);
          socket.once("open", () => { socket.terminate(); reject(new Error(`unexpected accepted Origin: ${origin}`)); });
        });
        assert.match(error.message, /403/);
      }
      for (const origin of [undefined, extensionOrigin]) {
        const socket = new WebSocket(`ws://127.0.0.1:${f.server.listeningPort()}`, origin === undefined ? {} : { origin });
        await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
        const closure = closed(socket);
        socket.close();
        await closure;
      }
    } finally { await f.dispose(); }
  });
});

test("paired new probe negotiates HMAC only and failed auth cannot downgrade to NONE", async () => {
  const f = await fixture({ authMode: "paired" });
  try {
    const socket = await open(f.server.listeningPort()!);
    const received = message<Frame>(socket, "auth_challenge");
    socket.send(JSON.stringify({ type: "bridge_probe", protocol: BRIDGE_READY_PROTOCOL, authMode: "paired", clientNonce: nonce() }));
    const challenge = await received;
    assert.equal(challenge.protocol, HMAC_AUTH_PROTOCOL);
    assert.equal(challenge.authMode, "paired");
    assert.equal(challenge.authenticated, false);
    assert.equal(challenge.serverInstanceId, f.server.transportState().serverInstanceId);
    const closure = closed(socket);
    socket.send(JSON.stringify({ ...challenge, type: "bridge_ready", authMode: "none" }));
    assert.equal(await closure, 1008);
    assert.equal(f.server.isConnected(), false);
    assert.equal(f.server.isAuthenticated(), false);
    const mismatched = await open(f.server.listeningPort()!);
    const mismatchClosed = closed(mismatched);
    mismatched.send(JSON.stringify({ type: "bridge_probe", protocol: BRIDGE_READY_PROTOCOL, authMode: "none", clientNonce: nonce() }));
    assert.equal(await mismatchClosed, 1008);
  } finally { await f.dispose(); }
});

test("selected peer rejects competing NONE and paired sockets without replacing commands or history", async (t) => {
  for (const authMode of ["none", "paired"] as const) await t.test(authMode, async () => {
    let writes = 0;
    const writeMarker = async (_marker: unknown, context: { assertOwner: () => void }) => {
      context.assertOwner();
      writes++;
    };
    const f = await fixture({ authMode, writeNoneReadyMarker: writeMarker, writeVerifiedMarker: writeMarker });
    try {
      const connect = async () => {
        if (authMode === "none") return (await ready(f.server)).socket;
        const config = JSON.parse(await readFile(join(f.directory, "browser-bridge.json"), "utf8")) as { token: string };
        const socket = await open(f.server.listeningPort()!);
        const accepted = message<Frame>(socket, "auth_ok");
        socket.send(JSON.stringify({ type: "auth", token: config.token }));
        await accepted;
        return socket;
      };
      const selected = await connect();
      const identity = f.server.connectionIdentity()!;
      const command = new Promise<Frame>((resolve) => selected.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Frame)));
      const handle = await f.server.sendTracked("exec", { tabId: 7, code: "pending" }, 1_000, identity);
      const dispatched = await command;
      selected.send(JSON.stringify({ type: "ack", id: dispatched.id }));
      const competitor = authMode === "none" ? await probe(f.server) : { socket: await open(f.server.listeningPort()!) };
      const rejected = message<Frame>(competitor.socket, "auth_error");
      const closure = closed(competitor.socket);
      if ("challenge" in competitor) competitor.socket.send(JSON.stringify(echo(competitor.challenge)));
      else {
        const config = JSON.parse(await readFile(join(f.directory, "browser-bridge.json"), "utf8")) as { token: string };
        competitor.socket.send(JSON.stringify({ type: "auth", token: config.token }));
      }
      assert.match(String((await rejected).error), /busy.*peer.*selected/);
      assert.equal(await closure, 1008);
      assert.deepEqual(f.server.connectionIdentity(), identity);
      assert.equal(selected.readyState, WebSocket.OPEN);
      assert.equal(writes, 1, "busy handshakes must not publish readiness/authentication history");
      selected.send(JSON.stringify({ type: "result", id: handle.id, data: "still selected" }));
      assert.equal((await handle.response).data, "still selected");
      assert.equal((await handle.terminal).status, "result");
      const selectedClosed = closed(selected);
      selected.close();
      await selectedClosed;
      const reconnected = await connect();
      assert.notEqual(f.server.connectionIdentity()!.generation, identity.generation);
      assert.equal(writes, 2);
      reconnected.terminate();
    } finally { await f.dispose(); }
  });
});

test("NONE newer ready generation fences delayed history publication and replay cannot authenticate", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const published: number[] = [];
  let calls = 0;
  const f = await fixture({ writeNoneReadyMarker: async (marker, context) => {
    if (++calls === 1) { entered(); await gate; }
    context.assertOwner();
    published.push(marker.generation);
  } });
  try {
    const first = await probe(f.server);
    first.socket.send(JSON.stringify(echo(first.challenge)));
    await started;
    const second = await ready(f.server);
    const firstClosed = closed(first.socket);
    release();
    assert.equal(await firstClosed, 1011);
    assert.deepEqual(published, [second.frame.generation]);
    assert.equal(f.server.connectionIdentity()!.generation, second.frame.generation);
    assert.equal(f.server.isAuthenticated(), false);
  } finally { release(); await f.dispose(); }
});

test("NONE shutdown joins and revokes history writer before listener release", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let published = false;
  const f = await fixture({ writeNoneReadyMarker: async (_marker, context) => {
    entered(); await gate; context.assertOwner(); published = true;
  } });
  try {
    const first = await probe(f.server);
    first.socket.send(JSON.stringify(echo(first.challenge)));
    await started;
    let settled = false;
    const shutdown = f.server.shutdown().then(() => { settled = true; });
    await delay(20);
    assert.equal(settled, false);
    assert.equal(f.server.transportState().ready, false);
    // The listener is retained while its writer joins, but cannot accept a new
    // socket under the already-revoked listener generation.
    const lateSocket = new WebSocket(`ws://127.0.0.1:${f.server.listeningPort()}`);
    lateSocket.on("error", () => {});
    const lateClosed = closed(lateSocket);
    lateSocket.once("open", () => lateSocket.send(JSON.stringify({
      type: "bridge_probe", protocol: BRIDGE_READY_PROTOCOL, authMode: "none", clientNonce: nonce(),
    })));
    assert.equal(await lateClosed, 1006);
    release();
    await shutdown;
    assert.equal(published, false);
    assert.equal(f.server.listeningPort(), null);
    assert.equal(f.server.transportState().serverInstanceId, null);
  } finally { release(); await f.dispose(); }
});

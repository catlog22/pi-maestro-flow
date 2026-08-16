import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as net from "node:net";
import test from "node:test";
import type { RemoteDriver, RemoteDriverContext, RemoteRunHandle } from "../src/remote/driver.ts";
import {
  REMOTE_MAX_LINE_BYTES,
  createRemoteRequest,
  encodeRemoteEnvelope,
  parseRemoteEnvelopeLine,
  type RemoteJsonRpcEnvelope,
  type RemoteRunCancelParams,
  type RemoteRunInputParams,
  type RemoteRunStartParams,
} from "../src/remote/protocol.ts";
import { connectRemoteSocket, RemoteBridgeServer } from "../src/remote/server.ts";
import { createRemoteRunSnapshot } from "../src/remote/state.ts";
import { REMOTE_PROTOCOL_VERSION, type RemoteRunEvent, type ResolvedRemoteTarget } from "../src/remote/types.ts";

const HOST_KEY = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function target(): ResolvedRemoteTarget {
  return {
    id: "linux-a/pi",
    host: "linux-a",
    cwd: "/srv/project",
    driver: "pi-rpc",
    command: ["/usr/bin/pi", "--mode", "rpc"],
    hostConfig: {
      host: "linux-a.example",
      user: "dev",
      port: 22,
      hostKeySha256: HOST_KEY,
    },
  };
}

class EventFeed implements AsyncIterable<RemoteRunEvent> {
  readonly #values: RemoteRunEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<RemoteRunEvent>) => void> = [];
  #closed = false;

  push(event: RemoteRunEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#values.push(event);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<RemoteRunEvent> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class TestHandle implements RemoteRunHandle {
  readonly capabilities = ["cancel", "follow-up"] as const;
  readonly feed = new EventFeed();
  readonly capture;
  cancelled = false;

  constructor(request: RemoteRunStartParams, context: RemoteDriverContext) {
    this.capture = {
      workerId: context.workerId,
      instanceNonce: context.instanceNonce,
      runId: `run-${request.commandId}`,
      generation: 1,
      monitorOwnerNonce: request.monitorOwnerNonce,
      targetId: request.targetId,
    };
  }

  snapshot() {
    return createRemoteRunSnapshot(this.capture, this.cancelled ? "cancelled" : "running");
  }

  events(): AsyncIterable<RemoteRunEvent> {
    return this.feed;
  }

  async input(request: RemoteRunInputParams) {
    if (this.cancelled) throw new Error("Input rejected after cancellation started");
    return {
      accepted: true,
      effectiveMode: request.mode,
      receipt: request.mode === "steer" ? "injected" as const : "queued" as const,
    };
  }

  async cancel(_request: RemoteRunCancelParams) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    this.cancelled = true;
    return { accepted: true, status: "cancelled" as const };
  }

  async close(): Promise<void> {
    this.feed.close();
  }
}

class TestDriver implements RemoteDriver {
  readonly id = "pi-rpc" as const;
  readonly capabilities = ["cancel", "follow-up"] as const;
  readonly handles: TestHandle[] = [];
  failure?: string;

  async start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle> {
    if (this.failure) throw new Error(this.failure);
    const handle = new TestHandle(request, context);
    this.handles.push(handle);
    return handle;
  }

  async attach(): Promise<RemoteRunHandle> {
    throw new Error("Attach is not used by this test driver");
  }

  async list() {
    return [];
  }

  async close(): Promise<void> {
    await Promise.all(this.handles.map((handle) => handle.close()));
  }
}

function initialize(owner: string, id = "initialize") {
  return createRemoteRequest(id, "remote/initialize", {
    commandId: id,
    protocolVersions: [REMOTE_PROTOCOL_VERSION],
    capabilities: ["cancel", "follow-up"],
    monitorOwnerNonce: owner,
  });
}

function start(owner: string, id = "start") {
  return createRemoteRequest(id, "run/start", {
    commandId: id,
    targetId: "linux-a/pi",
    monitorOwnerNonce: owner,
    name: "ordered run",
    objective: "verify server ordering",
    cwd: "/srv/project",
    driver: "pi-rpc",
    command: ["/usr/bin/pi", "--mode", "rpc"],
  });
}

function readEnvelopes(socket: net.Socket, count: number): Promise<RemoteJsonRpcEnvelope[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const envelopes: RemoteJsonRpcEnvelope[] = [];
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        envelopes.push(parseRemoteEnvelopeLine(line));
        if (envelopes.length === count) {
          cleanup();
          resolve(envelopes);
          return;
        }
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed after ${envelopes.length} of ${count} envelopes`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
  });
}

async function openServer(root: string, driver: TestDriver, options: { clientEgressBytes?: number } = {}) {
  const server = new RemoteBridgeServer({
    stateDirectory: path.join(root, "state"),
    targets: [target()],
    drivers: [driver],
    heartbeatMs: 60_000,
    ...options,
  });
  await server.listen();
  const socket = await connectRemoteSocket(path.join(root, "state"));
  return { server, socket };
}

test("bridge serializes same-chunk initialize/start and cancel/input in wire order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-server-order-"));
  const driver = new TestDriver();
  const { server, socket } = await openServer(root, driver);
  const owner = "owner-order";
  try {
    const firstResponses = readEnvelopes(socket, 2);
    socket.write(`${encodeRemoteEnvelope(initialize(owner))}${encodeRemoteEnvelope(start(owner))}`);
    const [initialized, started] = await firstResponses;
    assert.equal("result" in initialized, true);
    assert.equal("result" in started, true);
    assert.equal(driver.handles.length, 1);

    const capture = driver.handles[0].capture;
    const cancel = createRemoteRequest("cancel", "run/cancel", {
      commandId: "cancel",
      runId: capture.runId,
      generation: capture.generation,
      monitorOwnerNonce: owner,
      reason: "stop",
    });
    const input = createRemoteRequest("input", "run/input", {
      commandId: "input",
      runId: capture.runId,
      generation: capture.generation,
      monitorOwnerNonce: owner,
      mode: "follow_up",
      message: "must be rejected",
    });
    const secondResponses = readEnvelopes(socket, 2);
    socket.write(`${encodeRemoteEnvelope(cancel)}${encodeRemoteEnvelope(input)}`);
    const [cancelled, rejectedInput] = await secondResponses;
    assert.equal("result" in cancelled, true);
    assert.equal("error" in rejectedInput, true);
    assert.match("error" in rejectedInput ? rejectedInput.error.message : "", /after cancellation/i);
  } finally {
    socket.destroy();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bridge disconnects a non-reading client when queued egress exceeds the byte budget", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-server-egress-"));
  const driver = new TestDriver();
  const { server, socket } = await openServer(root, driver, { clientEgressBytes: REMOTE_MAX_LINE_BYTES });
  const owner = "owner-egress";
  try {
    let response = readEnvelopes(socket, 1);
    socket.write(encodeRemoteEnvelope(initialize(owner)));
    await response;
    response = readEnvelopes(socket, 1);
    socket.write(encodeRemoteEnvelope(start(owner)));
    await response;

    socket.pause();
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const handle = driver.handles[0];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      handle.feed.push({
        type: "run/event",
        workerId: handle.capture.workerId,
        instanceNonce: handle.capture.instanceNonce,
        runId: handle.capture.runId,
        generation: handle.capture.generation,
        sequence,
        updatedAt: sequence,
        event: { type: "text", text: `${sequence}:${"x".repeat(600 * 1024)}` },
      });
    }
    // The bridge charges every queued envelope before any write drains, so the budget is already
    // blown by the time the loop above returns. Resume only to observe the teardown: a paused
    // socket never reads the peer's EOF, so it would stay open no matter how long the wait is.
    socket.resume();
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Slow client was not disconnected")), 2_000)),
    ]);
    assert.equal(socket.destroyed, true);
  } finally {
    socket.destroy();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bridge redacts remote failures before transmission and command journaling", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-server-redact-"));
  const name = "PI_REMOTE_SERVER_SECRET_TOKEN";
  const marker = `server-marker-${Date.now()}`;
  const previous = process.env[name];
  process.env[name] = marker;
  const driver = new TestDriver();
  driver.failure = `authorization=${marker}`;
  const { server, socket } = await openServer(root, driver);
  try {
    let response = readEnvelopes(socket, 1);
    socket.write(encodeRemoteEnvelope(initialize("owner-redact")));
    await response;
    response = readEnvelopes(socket, 1);
    socket.write(encodeRemoteEnvelope(start("owner-redact", "failing-start")));
    const [failure] = await response;
    assert.equal("error" in failure, true);
    assert.equal(JSON.stringify(failure).includes(marker), false);

    const commandsDirectory = path.join(root, "state", "commands");
    const journalText = fs.readdirSync(commandsDirectory)
      .map((entry) => fs.readFileSync(path.join(commandsDirectory, entry), "utf8"))
      .join("\n");
    assert.equal(journalText.includes(marker), false);
  } finally {
    socket.destroy();
    await server.close();
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RuntimeBrokerClient } from "../src/runtime-broker/client.ts";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RuntimeBrokerError,
  type RuntimeBrokerFailureEnvelope,
} from "../src/runtime-broker/contracts.ts";
import { getRuntimeBrokerEndpoint } from "../src/runtime-broker/private-state.ts";
import { RuntimeBrokerServer } from "../src/runtime-broker/server.ts";

function makeStateDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

async function readOneLine(endpoint: string, line: string | Buffer): Promise<unknown> {
  const socket = net.createConnection(endpoint);
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("timed out waiting for broker response")), 3_000);
    timer.unref?.();
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("error", finish);
    socket.once("connect", () => socket.write(line));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.subarray(0, newline).toString("utf8")));
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
}

async function closeNetServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("runtime broker dispatches core lease and commit operations over real JSONL IPC", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-ipc-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 2_000 });
    const lease = await client.acquireLease({
      actorId: "actor-ipc",
      streamId: "stream-ipc",
      holderId: "window-ipc",
      ttlMs: 1_000,
      now: 10,
    }, "lease-1");
    assert.equal(lease.epoch, 1);
    assert.equal(lease.actorId, "actor-ipc");
    assert.equal(lease.streamId, "stream-ipc");

    const committed = await client.commit({
      messageId: "message-ipc",
      actorId: "actor-ipc",
      lease,
      streamId: "stream-ipc",
      expectedRevision: 0,
      committedAt: 20,
      events: [{ eventId: "event-ipc", eventType: "run.started", payload: { runId: "run-ipc" } }],
      projections: [{ projectionId: "run-ipc", value: { lifecycle: "running" } }],
      inboxResult: { accepted: true },
    }, "commit-1");
    assert.equal(Number.isSafeInteger(committed.appliedAt), true);
    assert.notEqual(committed.appliedAt, 20);
    assert.deepEqual(committed, {
      messageId: "message-ipc",
      streamId: "stream-ipc",
      previousRevision: 0,
      revision: 1,
      eventIds: ["event-ipc"],
      eventCursors: [1],
      outboxIds: [],
      appliedAt: committed.appliedAt,
      recovered: false,
      reply: { accepted: true },
    });
    assert.equal(await client.getStreamRevision("stream-ipc"), 1);
    const replayed = await client.readEvents("stream-ipc", 0, { actorId: "actor-ipc", lease });
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]?.eventId, "event-ipc");
    assert.equal(replayed[0]?.revision, 1);
    assert.deepEqual(await client.readEvents("stream-ipc", 1, { actorId: "actor-ipc", lease }), []);
    await assert.rejects(
      client.readEvents("other-stream", 0, { actorId: "actor-ipc", lease }),
      (error: unknown) => error instanceof RuntimeBrokerError && error.code === "stale_lease",
    );
    await assert.rejects(
      client.readEvents("stream-ipc", 0),
      (error: unknown) => error instanceof RuntimeBrokerError && error.code === "invalid_request",
    );

    await assert.rejects(
      client.commit({
        messageId: "message-conflict",
        actorId: "actor-ipc",
        lease,
        streamId: "stream-ipc",
        expectedRevision: 0,
        committedAt: 30,
        events: [],
      }, "commit-conflict"),
      (error: unknown) => error instanceof RuntimeBrokerError && error.code === "revision_conflict",
    );

    if (process.platform !== "win32") {
      assert.equal(fs.lstatSync(server.endpoint).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(server.databasePath).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(stateDirectory).mode & 0o777, 0o700);
    }
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
  await assert.rejects(RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 100 }));
});

test("runtime broker stream listing preserves workspace and prefix scope over IPC", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-list-ipc-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 2_000 });
    for (const [suffix, workspaceId] of [["a", "workspace-a"], ["b", "workspace-b"]] as const) {
      const streamId = `flow-schedule/schedule/${suffix}`;
      const lease = await client.acquireLease({ actorId: streamId, streamId, holderId: suffix, ttlMs: 1_000 });
      await client.commit({
        messageId: `message-${suffix}`,
        actorId: streamId,
        lease,
        streamId,
        expectedRevision: 0,
        events: [{
          eventId: `event-${suffix}`,
          eventType: "domain.event",
          payload: {
            version: 2,
            revision: 1,
            streamId,
            actor: { version: 2, revision: 1, workspaceId, actorKind: "schedule", actorId: streamId, generation: 1 },
            sequence: 1,
            producerEpoch: 1,
            occurredAt: 1,
            kind: "domain.event",
            eventType: "schedule.created",
            eventId: `flow-${suffix}`,
            payload: {},
          },
        }],
      });
    }
    assert.deepEqual(await client.listStreams({
      workspaceId: "workspace-a",
      prefix: "flow-schedule/schedule/",
      limit: 10,
    }), ["flow-schedule/schedule/a"]);
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("runtime broker returns stable fail-closed envelopes for malformed and unknown requests", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-protocol-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  try {
    await server.listen();
    const malformed = await readOneLine(server.endpoint, "{not-json}\n") as RuntimeBrokerFailureEnvelope;
    assert.deepEqual(malformed, {
      protocol: RUNTIME_BROKER_PROTOCOL,
      version: RUNTIME_BROKER_PROTOCOL_VERSION,
      requestId: "invalid",
      ok: false,
      error: { code: "invalid_request", message: "runtime broker request was rejected" },
    });

    const unknown = await readOneLine(server.endpoint, `${JSON.stringify({
      protocol: RUNTIME_BROKER_PROTOCOL,
      version: RUNTIME_BROKER_PROTOCOL_VERSION,
      requestId: "unknown-1",
      method: "database.exec",
      params: {},
    })}\n`) as RuntimeBrokerFailureEnvelope;
    assert.equal(unknown.requestId, "unknown-1");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "invalid_request");
    assert.doesNotMatch(unknown.error.message, /sqlite|stack|database/i);

    const extraField = await readOneLine(server.endpoint, `${JSON.stringify({
      protocol: RUNTIME_BROKER_PROTOCOL,
      version: RUNTIME_BROKER_PROTOCOL_VERSION,
      requestId: "extra-1",
      method: "lease.acquire",
      params: { actorId: "actor-extra", holderId: "holder-extra", ttlMs: 100 },
      extra: true,
    })}\n`) as RuntimeBrokerFailureEnvelope;
    assert.equal(extraField.requestId, "extra-1");
    assert.equal(extraField.ok, false);
    assert.equal(extraField.error.code, "invalid_request");

    const invalidUtf8 = Buffer.concat([
      Buffer.from(`{"protocol":"${RUNTIME_BROKER_PROTOCOL}","version":${RUNTIME_BROKER_PROTOCOL_VERSION},"requestId":"utf8-1","method":"lease.acquire","params":{"actorId":"`),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(`","holderId":"holder","ttlMs":100}}\n`),
    ]);
    const invalidEncoding = await readOneLine(server.endpoint, invalidUtf8) as RuntimeBrokerFailureEnvelope;
    assert.equal(invalidEncoding.requestId, "invalid");
    assert.equal(invalidEncoding.ok, false);
    assert.equal(invalidEncoding.error.code, "invalid_request");
  } finally {
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("runtime broker client bounds request lines and rejects duplicate in-flight request ids", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-client-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory, maxLineBytes: 1024 });
    await assert.rejects(
      client.request("lease.acquire", { actorId: "x".repeat(2_000), holderId: "holder", ttlMs: 10 }, "large-1"),
      /exceeds the line limit/,
    );

    await assert.rejects(
      client.request("lease.acquire", {
        actorId: "actor-nonfinite",
        holderId: "holder",
        ttlMs: Number.POSITIVE_INFINITY,
      } as never, "nonfinite-1"),
      /finite JSON object/,
    );

    const first = client.request("lease.acquire", {
      actorId: "actor-duplicate",
      holderId: "holder",
      ttlMs: 100,
      now: 1,
    }, "duplicate-id");
    await assert.rejects(
      client.request("lease.acquire", {
        actorId: "other",
        holderId: "holder",
        ttlMs: 100,
        now: 1,
      }, "duplicate-id"),
      /requestId must be unique/,
    );
    await first;
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("runtime broker client rejects invalid options before opening a socket", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-client-options-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  let acceptedConnections = 0;
  const fakeServer = net.createServer((socket) => {
    acceptedConnections += 1;
    socket.destroy();
  });
  try {
    await listen(fakeServer, endpoint);
    await assert.rejects(
      RuntimeBrokerClient.connect({ endpoint, maxLineBytes: 1 }),
      /line limit must be at least 1024 bytes/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(acceptedConnections, 0);
  } finally {
    await closeNetServer(fakeServer);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("runtime broker client rejects response envelopes with untrusted extra fields", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-client-protocol-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const fakeServer = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write(`${JSON.stringify({
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: "response-1",
        ok: true,
        result: null,
        extra: "untrusted",
      })}\n`);
    });
  });
  let client: RuntimeBrokerClient | undefined;
  try {
    await listen(fakeServer, endpoint);
    client = await RuntimeBrokerClient.connect({ endpoint, timeoutMs: 2_000 });
    await assert.rejects(
      client.request("lease.acquire", { actorId: "actor", holderId: "holder", ttlMs: 100 }, "response-1"),
      /invalid response envelope/,
    );
  } finally {
    await client?.close();
    await closeNetServer(fakeServer);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("Unix server removes stale sockets, refuses non-sockets, and preserves a replaced endpoint", {
  skip: process.platform === "win32" ? "Unix-domain socket behavior" : false,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-unix-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  try {
    const staging = `${endpoint}.staging`;
    const stale = net.createServer();
    await listen(stale, staging);
    fs.renameSync(staging, endpoint);
    await closeNetServer(stale);
    assert.equal(fs.lstatSync(endpoint).isSocket(), true);

    const server = new RuntimeBrokerServer({ stateDirectory });
    await server.listen();
    assert.equal(fs.lstatSync(endpoint).isSocket(), true);

    const ownedElsewhere = `${endpoint}.owned`;
    fs.renameSync(endpoint, ownedElsewhere);
    fs.writeFileSync(endpoint, "foreign endpoint", "utf8");
    await server.close();
    assert.equal(fs.readFileSync(endpoint, "utf8"), "foreign endpoint");
    fs.rmSync(ownedElsewhere, { force: true });

    fs.rmSync(endpoint, { force: true });
    fs.writeFileSync(endpoint, "not a socket", "utf8");
    const refusing = new RuntimeBrokerServer({ stateDirectory });
    await assert.rejects(refusing.listen(), /Refusing to replace non-socket/);
    await refusing.close();
    assert.equal(fs.readFileSync(endpoint, "utf8"), "not a socket");
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

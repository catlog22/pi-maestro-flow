import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  RuntimeBrokerClient,
  isRuntimeBrokerTransportError,
} from "../src/runtime-broker/client.ts";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RUNTIME_BROKER_SCHEMA_VERSION,
  RuntimeBrokerError,
  type RuntimeBrokerFailureEnvelope,
} from "../src/runtime-broker/contracts.ts";
import {
  RUNTIME_BROKER_DAEMON_LOCK_FILE,
  getRuntimeBrokerEndpoint,
  getRuntimeBrokerEndpointWorkspaceId,
} from "../src/runtime-broker/private-state.ts";
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

async function sendAndDrop(endpoint: string, request: unknown): Promise<void> {
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) reject(error);
        else setTimeout(resolve, 25);
      });
    });
  });
  socket.destroy();
}

function requestEnvelope(requestId: string, method: string, params: unknown): unknown {
  return {
    protocol: RUNTIME_BROKER_PROTOCOL,
    version: RUNTIME_BROKER_PROTOCOL_VERSION,
    requestId,
    method,
    params,
  };
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

function probeResult(
  endpoint: string,
  challenge: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: RUNTIME_BROKER_PROTOCOL,
    version: RUNTIME_BROKER_PROTOCOL_VERSION,
    schemaVersion: RUNTIME_BROKER_SCHEMA_VERSION,
    workspaceId: getRuntimeBrokerEndpointWorkspaceId(endpoint),
    daemonToken: "fake-daemon-token",
    generation: "fake-daemon-generation",
    readiness: "ready",
    challenge,
    ...overrides,
  };
}

test("runtime broker dispatches core lease and commit operations over real JSONL IPC", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-ipc-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 2_000 });
    assert.equal(client.readiness.protocol, RUNTIME_BROKER_PROTOCOL);
    assert.equal(client.readiness.version, RUNTIME_BROKER_PROTOCOL_VERSION);
    assert.equal(client.readiness.schemaVersion, RUNTIME_BROKER_SCHEMA_VERSION);
    assert.equal(client.readiness.workspaceId, getRuntimeBrokerEndpointWorkspaceId(server.endpoint));
    assert.equal(client.readiness.readiness, "ready");
    assert.equal(typeof client.readiness.daemonToken, "string");
    assert.equal(typeof client.readiness.generation, "string");
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

test("daemon authority wraps every dispatch and fences an established client before mutation", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-daemon-fence-");
  let authoritative = true;
  let authorityChecks = 0;
  const server = new RuntimeBrokerServer({
    stateDirectory,
    assertDaemonAuthority: () => {
      authorityChecks += 1;
      return authoritative;
    },
  });
  let oldClient: RuntimeBrokerClient | undefined;
  let verification: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    oldClient = await RuntimeBrokerClient.connect({ endpoint: server.endpoint, timeoutMs: 2_000 });
    assert.equal(authorityChecks, 2, "the readiness dispatch is fenced before and after");
    const lease = await oldClient.acquireLease({
      actorId: "actor-daemon-fence",
      streamId: "stream-daemon-fence",
      holderId: "holder-daemon-fence",
      ttlMs: 60_000,
    }, "daemon-fence-acquire");
    assert.equal(authorityChecks, 4, "a mutating dispatch is fenced before and after");

    authoritative = false;
    await assert.rejects(oldClient.commit({
      messageId: "message-daemon-fence",
      actorId: "actor-daemon-fence",
      lease,
      streamId: "stream-daemon-fence",
      expectedRevision: 0,
      events: [{
        eventId: "event-daemon-fence",
        eventType: "daemon.fence",
        payload: { mustNotCommit: true },
      }],
    }, "daemon-fence-commit"));
    assert.equal(authorityChecks, 5, "lost authority rejects at preflight without dispatching");

    authoritative = true;
    verification = await RuntimeBrokerClient.connect({ endpoint: server.endpoint, timeoutMs: 2_000 });
    assert.equal(await verification.getStreamRevision("stream-daemon-fence"), 0);
    assert.equal(authorityChecks, 9, "the verification probe and read are each fenced twice");
  } finally {
    await oldClient?.close();
    await verification?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("lost lease mutation responses replay exact durable requestId receipts over IPC", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-lost-response-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    const acquireRequest = { actorId: "actor-lost", streamId: "stream-lost", holderId: "holder-a", ttlMs: 10_000 };
    await sendAndDrop(server.endpoint, requestEnvelope("lost-acquire", "lease.acquire", acquireRequest));
    client = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 2_000 });
    const acquired = await client.acquireLease(acquireRequest, "lost-acquire");
    assert.equal(acquired.holderId, "holder-a");
    await assert.rejects(
      client.acquireLease({ ...acquireRequest, holderId: "different" }, "lost-acquire"),
      (error: unknown) => error instanceof RuntimeBrokerError && error.code === "idempotency_conflict",
    );

    const casRequest = { actorId: "actor-lost", lease: acquired, nextHolderId: "holder-b", ttlMs: 10_000 };
    await sendAndDrop(server.endpoint, requestEnvelope("lost-cas", "lease.compare-and-swap", casRequest));
    const swapped = await client.compareAndSwapLease(casRequest, "lost-cas");
    assert.equal(swapped.holderId, "holder-b");
    assert.equal(swapped.epoch, acquired.epoch + 1);

    await client.releaseLease({ actorId: "actor-lost", lease: swapped }, "release-for-takeover");
    const takeoverRequest = { actorId: "actor-lost", streamId: "stream-lost", holderId: "holder-c", ttlMs: 10_000 };
    await sendAndDrop(server.endpoint, requestEnvelope("lost-takeover", "lease.takeover", takeoverRequest));
    const taken = await client.takeoverLease(takeoverRequest, "lost-takeover");
    assert.equal(taken.holderId, "holder-c");
    assert.equal(taken.epoch, swapped.epoch + 1);
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("paged stream replay preserves the complete-array client API beyond one MiB", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-pagination-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 10_000 });
    const lease = await client.acquireLease({
      actorId: "actor-large",
      streamId: "stream-large",
      holderId: "holder-large",
      ttlMs: 60_000,
    }, "large-acquire");
    const payload = "x".repeat(80 * 1024);
    for (let index = 0; index < 12; index += 1) {
      const eventPayload = index === 0 ? "x".repeat(700 * 1024) : payload;
      await client.commit({
        messageId: `large-message-${index}`,
        actorId: "actor-large",
        lease,
        streamId: "stream-large",
        expectedRevision: index,
        events: [{
          eventId: `large-event-${index}`,
          eventType: "large.event",
          payload: { index, payload: eventPayload },
        }],
      }, `large-commit-${index}`);
    }
    await assert.rejects(
      client.request("stream.events", {
        streamId: "stream-large",
        afterRevision: 0,
        actorId: "actor-large",
        lease: { epoch: lease.epoch, nonce: lease.nonce },
      }, "legacy-large-replay"),
      (error: unknown) => error instanceof RuntimeBrokerError && error.code === "invalid_request",
    );
    const replayed = await client.readEvents(
      "stream-large",
      0,
      { actorId: "actor-large", lease },
      "paged-large-replay",
    );
    assert.equal(replayed.length, 12);
    assert.ok(Buffer.byteLength(JSON.stringify(replayed), "utf8") > 1024 * 1024);
    assert.deepEqual(replayed.map((event) => event.revision), Array.from({ length: 12 }, (_, index) => index + 1));
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("legacy stream.events replays complete transport-safe histories beyond 128 events", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-legacy-history-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 5_000 });
    const lease = await client.acquireLease({
      actorId: "actor-legacy-history",
      streamId: "stream-legacy-history",
      holderId: "holder-legacy-history",
      ttlMs: 60_000,
    });
    await client.commit({
      messageId: "message-legacy-history",
      actorId: "actor-legacy-history",
      lease,
      streamId: "stream-legacy-history",
      expectedRevision: 0,
      events: Array.from({ length: 129 }, (_, index) => ({
        eventId: `event-legacy-history-${index}`,
        eventType: "small.event",
        payload: { index },
      })),
    });
    const replayed = await client.request<Array<{ revision: number }>>("stream.events", {
      streamId: "stream-legacy-history",
      afterRevision: 0,
      actorId: "actor-legacy-history",
      lease: { epoch: lease.epoch, nonce: lease.nonce },
    }, "legacy-history-replay");
    assert.equal(replayed.length, 129);
    assert.deepEqual(replayed.map((event) => event.revision), Array.from({ length: 129 }, (_, index) => index + 1));
  } finally {
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
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

test("new client replays against a protocol-v1 daemon without paging capability", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-client-v1-compat-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const methods: string[] = [];
  const legacyEvent = {
    eventId: "legacy-event-1",
    messageId: "legacy-message-1",
    streamId: "legacy-stream",
    revision: 1,
    eventType: "legacy.event",
    payload: { legacy: true },
    producerEpoch: 1,
    occurredAt: 1,
  };
  const fakeServer = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          requestId: string;
          method: string;
          params: { challenge?: string };
        };
        buffer = buffer.slice(newline + 1);
        methods.push(request.method);
        socket.write(`${JSON.stringify({
          protocol: RUNTIME_BROKER_PROTOCOL,
          version: RUNTIME_BROKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result: request.method === "broker.probe"
            ? probeResult(endpoint, request.params.challenge ?? "")
            : request.method === "stream.events" ? [legacyEvent] : null,
        })}\n`);
      }
    });
  });
  let client: RuntimeBrokerClient | undefined;
  try {
    await listen(fakeServer, endpoint);
    client = await RuntimeBrokerClient.connect({ endpoint, timeoutMs: 2_000 });
    const replayed = await client.readEvents(
      "legacy-stream",
      0,
      { actorId: "legacy-actor", lease: { epoch: 1, nonce: "legacy-nonce" } },
      "legacy-v1-replay",
    );
    assert.deepEqual(replayed, [legacyEvent]);
    assert.deepEqual(methods, ["broker.probe", "stream.events"]);
  } finally {
    await client?.close();
    await closeNetServer(fakeServer);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("runtime broker client rejects response envelopes with untrusted extra fields", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-client-protocol-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const fakeServer = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          requestId: string;
          method: string;
          params: { challenge?: string };
        };
        buffer = buffer.slice(newline + 1);
        if (request.method === "broker.probe") {
          socket.write(`${JSON.stringify({
            protocol: RUNTIME_BROKER_PROTOCOL,
            version: RUNTIME_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: probeResult(endpoint, request.params.challenge ?? ""),
          })}\n`);
        } else {
          socket.write(`${JSON.stringify({
            protocol: RUNTIME_BROKER_PROTOCOL,
            version: RUNTIME_BROKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result: null,
            extra: "untrusted",
          })}\n`);
        }
      }
    });
  });
  let client: RuntimeBrokerClient | undefined;
  try {
    await listen(fakeServer, endpoint);
    client = await RuntimeBrokerClient.connect({ endpoint, timeoutMs: 2_000 });
    await assert.rejects(
      client.request("lease.acquire", { actorId: "actor", holderId: "holder", ttlMs: 100 }, "response-1"),
      (error) => error instanceof Error
        && /invalid response envelope/.test(error.message)
        && !isRuntimeBrokerTransportError(error),
    );
  } finally {
    await client?.close();
    await closeNetServer(fakeServer);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("connectOrStart fails closed on a readiness mismatch without launching over a foreign listener", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-mismatch-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  let connections = 0;
  const fakeServer = net.createServer((socket) => {
    connections += 1;
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        params: { challenge: string };
      };
      socket.write(`${JSON.stringify({
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: probeResult(endpoint, request.params.challenge, { schemaVersion: 999 }),
      })}\n`);
    });
  });
  try {
    await listen(fakeServer, endpoint);
    await assert.rejects(
      RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 2_000 }),
      (error: unknown) => error instanceof Error
        && /readiness handshake mismatch/.test(error.message)
        && !isRuntimeBrokerTransportError(error),
    );
    assert.equal(connections, 1);
    assert.equal(fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE)), false);
  } finally {
    await closeNetServer(fakeServer);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("canonical connectOrStart rejects an unleased listener while direct explicit endpoint remains available", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-unleased-canonical-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let direct: RuntimeBrokerClient | undefined;
  try {
    await server.listen();
    direct = await RuntimeBrokerClient.connect({ endpoint: server.endpoint, timeoutMs: 2_000 });
    assert.equal(direct.readiness.daemonToken, server.daemonToken);
    await assert.rejects(
      RuntimeBrokerClient.connectOrStart({ stateDirectory, timeoutMs: 2_000 }),
      /daemon lock authority mismatch/,
    );
    assert.equal(fs.existsSync(path.join(stateDirectory, RUNTIME_BROKER_DAEMON_LOCK_FILE)), false);
  } finally {
    await direct?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("runtime broker server close is idempotent and releases listener and database handles", async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-double-close-");
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  let replacement: RuntimeBrokerServer | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ endpoint: server.endpoint, timeoutMs: 2_000 });
    const firstClose = server.close();
    const secondClose = server.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    await client.close();
    client = undefined;
    replacement = new RuntimeBrokerServer({ stateDirectory });
    await replacement.listen();
    const replacementClient = await RuntimeBrokerClient.connect({ stateDirectory, timeoutMs: 2_000 });
    await replacementClient.close();
    await Promise.all([replacement.close(), replacement.close()]);
    replacement = undefined;
  } finally {
    await client?.close();
    await replacement?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("Unix shutdown errors still close the listener and SQLite store", {
  skip: process.platform === "win32" ? "Unix-domain socket quarantine behavior" : false,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-close-error-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const displaced = `${endpoint}.displaced`;
  const server = new RuntimeBrokerServer({ stateDirectory });
  try {
    await server.listen();
    fs.renameSync(endpoint, displaced);
    fs.mkdirSync(endpoint);
    fs.writeFileSync(path.join(endpoint, "non-empty"), "force endpoint cleanup failure", "utf8");
    await assert.rejects(server.close(), AggregateError);
    await assert.rejects(RuntimeBrokerClient.connect({ endpoint: displaced, timeoutMs: 100 }));

    const replacement = new RuntimeBrokerServer({ stateDirectory });
    fs.rmSync(endpoint, { recursive: true, force: true });
    fs.rmSync(displaced, { force: true });
    await replacement.listen();
    await replacement.close();
  } finally {
    await server.close().catch(() => undefined);
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("Unix stale-endpoint probe preserves and rejects an incompatible foreign listener", {
  skip: process.platform === "win32" ? "Unix-domain socket stale endpoint behavior" : false,
}, async () => {
  const stateDirectory = makeStateDirectory("runtime-broker-foreign-endpoint-");
  const endpoint = getRuntimeBrokerEndpoint(stateDirectory);
  const foreign = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        requestId: string;
        params: { challenge: string };
      };
      socket.write(`${JSON.stringify({
        protocol: RUNTIME_BROKER_PROTOCOL,
        version: RUNTIME_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: probeResult(endpoint, request.params.challenge, { workspaceId: "foreign-workspace" }),
      })}\n`);
    });
  });
  const server = new RuntimeBrokerServer({ stateDirectory });
  try {
    await listen(foreign, endpoint);
    await assert.rejects(server.listen(), /readiness handshake mismatch/);
    assert.equal(fs.lstatSync(endpoint).isSocket(), true);
    await assert.rejects(RuntimeBrokerClient.connect({ endpoint, timeoutMs: 500 }), /readiness handshake mismatch/);
  } finally {
    await server.close();
    await closeNetServer(foreign);
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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RuntimeBrokerClient } from "../src/runtime-broker/client.ts";
import { RuntimeBrokerServer } from "../src/runtime-broker/server.ts";
import { getRuntimeBrokerStateDirectory } from "../src/runtime-broker/private-state.ts";
import { RuntimeReadModelBrokerBridge } from "../src/runtime-v2/broker-read-model.ts";
import type { RuntimeAgentReadEntityV2 } from "../src/runtime-v2/read-model.ts";

function entity(correlationId: string, generation = 1): RuntimeAgentReadEntityV2 {
  return {
    correlationId,
    generation,
    agent: correlationId.startsWith("acp") ? "remote" : "general",
    status: "running",
    startedAt: 10,
    lastActivityAt: 20,
    ...(correlationId.startsWith("acp") ? { resolvedModel: "cli/acp" } : {}),
  };
}

test("broker bridge without an injected client selects state from the requested cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-cwd-"));
  const workspace = path.join(root, "requested-workspace");
  const stateDirectory = path.join(root, "actual-broker");
  fs.mkdirSync(workspace);
  const server = new RuntimeBrokerServer({ stateDirectory });
  const originalConnectOrStart = RuntimeBrokerClient.connectOrStart;
  const previousOverride = process.env.PI_TEAMMATE_BROKER_STATE_DIR;
  let client: RuntimeBrokerClient | undefined;
  let bridge: RuntimeReadModelBrokerBridge | undefined;
  let requestedStateDirectory: string | undefined;
  try {
    delete process.env.PI_TEAMMATE_BROKER_STATE_DIR;
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    RuntimeBrokerClient.connectOrStart = async (options = {}) => {
      requestedStateDirectory = options.stateDirectory;
      return client!;
    };
    bridge = await RuntimeReadModelBrokerBridge.connect({
      cwd: workspace,
      sourceId: "requested-cwd-window",
      mode: "sqlite",
    });
    assert.equal(requestedStateDirectory, getRuntimeBrokerStateDirectory(workspace));
    assert.notEqual(requestedStateDirectory, getRuntimeBrokerStateDirectory(process.cwd()));
  } finally {
    RuntimeBrokerClient.connectOrStart = originalConnectOrStart;
    if (previousOverride === undefined) delete process.env.PI_TEAMMATE_BROKER_STATE_DIR;
    else process.env.PI_TEAMMATE_BROKER_STATE_DIR = previousOverride;
    await bridge?.close();
    await client?.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("broker bridge cold-start replay covers Pi, ACP, and multiple windows", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-bridge-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let firstClient: RuntimeBrokerClient | undefined;
  let secondClient: RuntimeBrokerClient | undefined;
  let readerClient: RuntimeBrokerClient | undefined;
  let first: RuntimeReadModelBrokerBridge | undefined;
  let second: RuntimeReadModelBrokerBridge | undefined;
  let reader: RuntimeReadModelBrokerBridge | undefined;
  try {
    await server.listen();
    firstClient = await RuntimeBrokerClient.connect({ stateDirectory });
    secondClient = await RuntimeBrokerClient.connect({ stateDirectory });
    readerClient = await RuntimeBrokerClient.connect({ stateDirectory });
    first = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "pi-window",
      mode: "sqlite",
      client: firstClient,
    });
    second = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "acp-window",
      mode: "sqlite",
      client: secondClient,
    });
    await first.publish([entity("pi-agent")], { reset: true });
    const combined = await second.publish([entity("acp-agent")], { reset: true });
    assert.deepEqual(combined.agents.map((agent) => agent.correlationId), ["acp-agent", "pi-agent"]);

    const database = new DatabaseSync(server.databasePath);
    try {
      const stored = database.prepare(
        "SELECT event_id, payload_json FROM events WHERE event_type = 'domain.event' ORDER BY rowid LIMIT 1",
      ).get() as { event_id: string; payload_json: string };
      const legacy = JSON.parse(stored.payload_json) as Record<string, unknown>;
      delete legacy.producerEpoch;
      database.prepare("UPDATE events SET payload_json = ? WHERE event_id = ?").run(
        JSON.stringify(legacy),
        stored.event_id,
      );
    } finally {
      database.close();
    }

    reader = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "reader-window",
      mode: "sqlite",
      client: readerClient,
    });
    const replayed = await reader.publish([], { reset: true });
    assert.deepEqual(replayed.agents.map((agent) => agent.correlationId), ["acp-agent", "pi-agent"]);
    assert.ok(replayed.cursor > 0);
  } finally {
    await reader?.close();
    await second?.close();
    await first?.close();
    await readerClient?.close();
    await secondClient?.close();
    await firstClient?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("source-scoped bridge keeps another window's agents out of the local read model", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-source-scope-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let firstClient: RuntimeBrokerClient | undefined;
  let secondClient: RuntimeBrokerClient | undefined;
  let first: RuntimeReadModelBrokerBridge | undefined;
  let second: RuntimeReadModelBrokerBridge | undefined;
  try {
    await server.listen();
    firstClient = await RuntimeBrokerClient.connect({ stateDirectory });
    secondClient = await RuntimeBrokerClient.connect({ stateDirectory });
    first = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "first-window",
      mode: "sqlite",
      client: firstClient,
      readScope: "source",
    });
    second = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "second-window",
      mode: "sqlite",
      client: secondClient,
      readScope: "source",
    });
    assert.deepEqual(
      (await first.publish([entity("first-agent")], { reset: true })).agents.map((agent) => agent.correlationId),
      ["first-agent"],
    );
    assert.deepEqual(
      (await second.publish([entity("second-agent")], { reset: true })).agents.map((agent) => agent.correlationId),
      ["second-agent"],
    );
    assert.deepEqual(
      (await first.snapshot()).agents.map((agent) => agent.correlationId),
      ["first-agent"],
    );
  } finally {
    await second?.close();
    await first?.close();
    await secondClient?.close();
    await firstClient?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("a restarted source generation tombstones only its own older entities", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-generation-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  let first: RuntimeReadModelBrokerBridge | undefined;
  let replacement: RuntimeReadModelBrokerBridge | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    first = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "same-window",
      sessionId: "same-session",
      sessionGeneration: 1,
      mode: "sqlite",
      client,
      readScope: "source",
    });
    await first.publish([entity("old")], { reset: true });
    const firstGeneration = first.generation;
    await first.close();
    first = undefined;

    replacement = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "same-window",
      sessionId: "same-session",
      sessionGeneration: 2,
      mode: "sqlite",
      client,
      readScope: "source",
    });
    assert.ok(replacement.generation > firstGeneration);
    const rebuilt = await replacement.publish([entity("new", 2)], { reset: true });
    assert.deepEqual(rebuilt.agents.map((agent) => agent.correlationId), ["new"]);
    assert.equal(rebuilt.source.projection?.generation, 2);
    assert.equal(rebuilt.source.projection?.sessionId, "same-session");
    assert.equal(rebuilt.agents[0]?.projection?.generation, 2);
  } finally {
    await replacement?.close();
    await first?.close();
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("close fences late publications before draining an admitted publish", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-close-fence-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  let bridge: RuntimeReadModelBrokerBridge | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    const originalCommit = client.commit.bind(client);
    let releaseCommit: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let blocked = false;
    client.commit = async (params, requestId) => {
      if (!blocked && params.streamId.startsWith("runtime-read-model:")) {
        blocked = true;
        markEntered?.();
        await gate;
      }
      return originalCommit(params, requestId);
    };
    bridge = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "close-window",
      mode: "sqlite",
      client,
    });
    const streamId = bridge.sourceStreamId;
    const admitted = bridge.publish([entity("admitted")], { reset: true });
    await entered;
    const closing = bridge.close();
    const lateRejected = assert.rejects(bridge.publish([entity("late")]), /closed/);
    releaseCommit?.();
    await admitted;
    await closing;
    await lateRejected;
    assert.equal(await client.getStreamRevision(streamId), 1);
  } finally {
    await bridge?.close();
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("mid-batch failure fences same-generation writes and a new lease generation recovers", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-partial-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let client: RuntimeBrokerClient | undefined;
  let failing: RuntimeReadModelBrokerBridge | undefined;
  let replacement: RuntimeReadModelBrokerBridge | undefined;
  try {
    await server.listen();
    client = await RuntimeBrokerClient.connect({ stateDirectory });
    const originalCommit = client.commit.bind(client);
    let readModelCommits = 0;
    client.commit = async (params, requestId) => {
      if (params.streamId.startsWith("runtime-read-model:") && ++readModelCommits === 2) {
        throw new Error("injected second-frame failure");
      }
      return originalCommit(params, requestId);
    };
    failing = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "partial-window",
      mode: "sqlite",
      client,
    });
    const large = Array.from({ length: 24 }, (_, index) => ({
      ...entity(`partial-${index}`),
      task: "x".repeat(20_000),
    }));
    await assert.rejects(failing.publish(large, { reset: true }), /injected second-frame failure/);
    await assert.rejects(failing.publish([entity("same-generation-retry")]), /closed/);
    const failedGeneration = failing.generation;

    client.commit = originalCommit;
    replacement = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "partial-window",
      mode: "sqlite",
      client,
    });
    assert.ok(replacement.generation > failedGeneration);
    const recovered = await replacement.publish([entity("recovered", 2)], { reset: true });
    assert.deepEqual(recovered.agents.map((agent) => agent.correlationId), ["recovered"]);
  } finally {
    await replacement?.close();
    await failing?.close();
    await client?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("large histories are split into byte-bounded frames and cold-replayed incrementally", async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-read-model-pages-"));
  const server = new RuntimeBrokerServer({ stateDirectory });
  let writerClient: RuntimeBrokerClient | undefined;
  let readerClient: RuntimeBrokerClient | undefined;
  let writer: RuntimeReadModelBrokerBridge | undefined;
  let reader: RuntimeReadModelBrokerBridge | undefined;
  try {
    await server.listen();
    writerClient = await RuntimeBrokerClient.connect({ stateDirectory });
    readerClient = await RuntimeBrokerClient.connect({ stateDirectory });
    writer = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "large-writer",
      mode: "sqlite",
      client: writerClient,
    });
    const agents = Array.from({ length: 24 }, (_, index) => ({
      ...entity(`large-${index}`),
      task: `task-${index}-${"x".repeat(20_000)}`,
    }));
    const written = await writer.publish(agents, { reset: true });
    assert.equal(written.agents.length, agents.length);
    assert.ok(written.cursor > 1, "the oversized source snapshot was split across journal frames");

    reader = await RuntimeReadModelBrokerBridge.connect({
      cwd: stateDirectory,
      sourceId: "large-reader",
      mode: "sqlite",
      client: readerClient,
    });
    const replayed = await reader.publish([], { reset: true });
    assert.equal(replayed.agents.length, agents.length);
    assert.deepEqual(replayed.agents.map((agent) => agent.correlationId), agents.map((agent) => agent.correlationId).sort());
  } finally {
    await reader?.close();
    await writer?.close();
    await readerClient?.close();
    await writerClient?.close();
    await server.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

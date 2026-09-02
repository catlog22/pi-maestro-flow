import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_JSONRPC_VERSION,
  REMOTE_MAX_LINE_BYTES,
  createRemoteRequest,
  encodeRemoteEnvelope,
  negotiateRemoteWindowBridge,
  normalizeRemoteWindowBridgeAdvertisement,
  parseRemoteEnvelopeLine,
  type RemoteInitializeResult,
} from "../src/remote/protocol.ts";
import {
  RemoteCommandDeduplicator,
  RemoteEventSequenceTracker,
  applyRemoteRunEvent,
  createRemoteRunSnapshot,
} from "../src/remote/state.ts";
import {
  REMOTE_PROTOCOL_VERSION,
  REMOTE_STATUSES,
  REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
  isRemoteTerminalStatus,
  type RemoteRunCapture,
} from "../src/remote/types.ts";

test("remote/2 exposes the approved status contract", () => {
  assert.equal(REMOTE_PROTOCOL_VERSION, "remote/2");
  assert.deepEqual(REMOTE_STATUSES, [
    "connecting", "ready", "running", "waiting", "completed", "failed", "cancelled", "disconnected", "lost",
  ]);
  assert.equal(isRemoteTerminalStatus("completed"), true);
  assert.equal(isRemoteTerminalStatus("disconnected"), false);
});

test("windowBridge advertisement is optional, bounded, and negotiated separately from remote runs", () => {
  const base: RemoteInitializeResult = {
    workerId: "worker-a",
    instanceNonce: "instance-a",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    concurrency: 4,
    activeRuns: 0,
    status: "ready",
  };
  const workspace = {
    requiredPlugin: REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
    minimumWindowProtocol: 2,
  };

  assert.deepEqual(negotiateRemoteWindowBridge(workspace, base), {
    status: "unsupported",
    code: "plugin-missing",
    message: "Remote daemon did not advertise required plugin pi-maestro-teammate",
  });

  const advertised: RemoteInitializeResult = {
    ...base,
    windowBridge: {
      pluginId: REMOTE_WINDOW_BRIDGE_PLUGIN_ID,
      pluginVersion: "2.3.0",
      workspacePeerVersions: [1, 2],
      relayVersions: [1],
      runtimeVersions: [1],
    },
  };
  const supported = negotiateRemoteWindowBridge(workspace, advertised, 1);
  assert.equal(supported.status, "supported");
  if (supported.status === "supported") {
    assert.equal(supported.windowProtocolVersion, 2);
    assert.equal(Object.isFrozen(supported.advertisement), true);
    assert.equal(Object.isFrozen(supported.advertisement.workspacePeerVersions), true);
  }
  const noActiveWindow = negotiateRemoteWindowBridge(workspace, advertised, 0);
  assert.equal(noActiveWindow.status, "unsupported");
  assert.equal("code" in noActiveWindow ? noActiveWindow.code : undefined, "no-active-window");
  assert.equal(negotiateRemoteWindowBridge({ ...workspace, minimumWindowProtocol: 3 }, advertised).status, "upgrade-required");

  const wrongPlugin = {
    ...advertised,
    windowBridge: { ...advertised.windowBridge!, pluginId: "other-plugin" },
  };
  const wrongPluginResult = negotiateRemoteWindowBridge(workspace, wrongPlugin);
  assert.equal("code" in wrongPluginResult ? wrongPluginResult.code : undefined, "plugin-missing");
  assert.throws(() => normalizeRemoteWindowBridgeAdvertisement({
    ...advertised.windowBridge,
    workspacePeerVersions: [1, 1],
  }), /workspacePeerVersions/);
  const malformed = {
    ...advertised,
    windowBridge: { ...advertised.windowBridge!, relayVersions: [0] },
  } as RemoteInitializeResult;
  const malformedResult = negotiateRemoteWindowBridge(workspace, malformed);
  assert.equal("code" in malformedResult ? malformedResult.code : undefined, "daemon-incompatible");
});

test("remote/2 JSON-RPC requests round-trip as one NDJSON record", () => {
  const request = createRemoteRequest("command-1", "run/input", {
    commandId: "input-1",
    runId: "run-1",
    generation: 2,
    monitorOwnerNonce: "monitor-1",
    mode: "follow_up",
    message: "Continue with the focused test.",
  });
  const encoded = encodeRemoteEnvelope(request);
  assert.equal(encoded.endsWith("\n"), true);
  assert.equal(encoded.slice(0, -1).includes("\n"), false);
  assert.deepEqual(parseRemoteEnvelopeLine(encoded), request);
  assert.equal(request.jsonrpc, REMOTE_JSONRPC_VERSION);
});

test("remote/2 rejects malformed, multiline, and oversized records", () => {
  assert.throws(
    () => parseRemoteEnvelopeLine('{"jsonrpc":"1.0","id":1,"result":{}}'),
    /JSON-RPC 2\.0/,
  );
  assert.throws(
    () => parseRemoteEnvelopeLine('{"jsonrpc":"2.0","id":1,"result":{}}\n{}'),
    /exactly one NDJSON line/,
  );
  assert.throws(
    () => parseRemoteEnvelopeLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "run/event",
      params: { text: "x".repeat(REMOTE_MAX_LINE_BYTES) },
    })),
    /exceeds/,
  );
  assert.throws(
    () => parseRemoteEnvelopeLine('{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"bad"}}'),
    /exactly one/,
  );
});

test("command ids are idempotent and event sequences reject duplicates and gaps", () => {
  const commands = new RemoteCommandDeduplicator(2);
  assert.equal(commands.accept("a"), true);
  assert.equal(commands.accept("a"), false);
  assert.equal(commands.accept("b"), true);
  assert.equal(commands.accept("c"), true);
  assert.equal(commands.size, 2);
  assert.equal(commands.accept("a"), true, "oldest ids are evicted from the bounded dedup set");

  const sequence = new RemoteEventSequenceTracker();
  assert.deepEqual(sequence.accept(1), { accepted: true, expectedSequence: 2 });
  assert.deepEqual(sequence.accept(1), { accepted: false, reason: "duplicate", expectedSequence: 2 });
  assert.deepEqual(sequence.accept(3), { accepted: false, reason: "gap", expectedSequence: 2 });
  assert.deepEqual(sequence.accept(2), { accepted: true, expectedSequence: 3 });
});

test("run state only advances for the exact captured identity and contiguous sequence", () => {
  const capture: RemoteRunCapture = {
    workerId: "worker-a",
    instanceNonce: "instance-a",
    runId: "run-a",
    generation: 1,
    monitorOwnerNonce: "monitor-a",
    targetId: "linux-a/pi",
  };
  const initial = createRemoteRunSnapshot(capture, "running", 10);
  const waiting = applyRemoteRunEvent(initial, {
    type: "run/state",
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    sequence: 1,
    status: "waiting",
    updatedAt: 20,
    nativeStatus: "idle",
  });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.lastSequence, 1);
  assert.equal(waiting.nativeStatus, "idle");
  assert.throws(() => applyRemoteRunEvent(waiting, {
    type: "run/result",
    workerId: capture.workerId,
    instanceNonce: "replacement-instance",
    runId: capture.runId,
    generation: capture.generation,
    sequence: 2,
    status: "completed",
    updatedAt: 30,
    result: "wrong worker",
  }), /captured run identity/);
});

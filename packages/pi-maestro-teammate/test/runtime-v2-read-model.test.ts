import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeReadModelBrokerAccumulatorV2,
  RuntimeReadModelProjectionV2,
  createRuntimeReadModelDeltaV2,
  rebuildRuntimeReadModelFromBrokerFramesV2,
  runtimeV2ReadEnabled,
  type RuntimeAgentReadEntityV2,
  type RuntimeReadModelBrokerFrameV2,
  type RuntimeReadModelChangeV2,
  type RuntimeReadModelSnapshotV2,
  type RuntimeReadModelSourceFrameV2,
} from "../src/runtime-v2/read-model.ts";

function agent(
  correlationId: string,
  generation = 1,
  overrides: Partial<RuntimeAgentReadEntityV2> = {},
): RuntimeAgentReadEntityV2 {
  return {
    correlationId,
    generation,
    agent: "executor",
    status: "running",
    startedAt: 10,
    lastActivityAt: 20,
    ...overrides,
  };
}

function emptySnapshot(cursor = 0): RuntimeReadModelSnapshotV2 {
  return {
    version: 2,
    revision: 1,
    kind: "agent-runs-snapshot",
    cursor,
    source: { streamId: "workspace:w1", revision: Math.max(1, cursor), generation: 1 },
    agents: [],
  };
}

function frame(
  cursor: number,
  sourceId: string,
  sourceRevision: number,
  generation: number,
  changes: RuntimeReadModelChangeV2[],
  reset = sourceRevision === 1,
): RuntimeReadModelBrokerFrameV2 {
  const value: RuntimeReadModelSourceFrameV2 = {
    version: 2,
    revision: 1,
    kind: "agent-runs-source-frame",
    source: { streamId: sourceId, revision: sourceRevision, generation },
    batchId: `${sourceId}:${generation}:${sourceRevision}`,
    batchIndex: 0,
    batchCount: 1,
    reset,
    changes,
  };
  return { cursor, frame: value };
}

test("cold start rebuilds the canonical snapshot exclusively from broker frames", () => {
  const records = [
    frame(4, "window:a", 1, 1, [{ kind: "upsert", entity: agent("a") }]),
    frame(9, "window:a", 2, 1, [{ kind: "upsert", entity: agent("a", 1, { lastMessage: "working" }) }], false),
  ];
  const rebuilt = rebuildRuntimeReadModelFromBrokerFramesV2("w1", records);
  assert.equal(rebuilt.discarded, 0);
  assert.equal(rebuilt.projection.cursor, 9);
  assert.equal(rebuilt.projection.agent("a")?.lastMessage, "working");
  assert.equal(rebuilt.projection.source.streamId, "workspace:w1");
});

test("gap, duplicate, and out-of-order live deltas fail closed without mutation", () => {
  const projection = new RuntimeReadModelProjectionV2();
  const snapshot = {
    ...emptySnapshot(4),
    agents: [agent("a")],
  };
  assert.equal(projection.applySnapshot(snapshot), true);
  const before = projection.snapshot();
  const next = createRuntimeReadModelDeltaV2({
    previous: before,
    agents: [agent("a"), agent("b")],
    source: { streamId: "workspace:w1", revision: 9, generation: 1 },
    nextCursor: 9,
  });
  assert.equal(projection.applyDelta({ ...next, baseCursor: 5 }), false, "gap");
  assert.equal(projection.applyDelta({ ...next, baseCursor: 0 }), false, "out of order");
  assert.equal(projection.applyDelta({ ...next, nextCursor: 4, source: { ...next.source, revision: 4 } }), false, "duplicate");
  assert.deepEqual(projection.snapshot(), before);
  assert.equal(projection.applyDelta(next), true);
});

test("source generation reset clears only that window and preserves multi-window Pi/ACP rows", () => {
  const records = [
    frame(1, "pi-window", 1, 1, [{ kind: "upsert", entity: agent("pi-old") }]),
    frame(2, "acp-window", 1, 1, [{ kind: "upsert", entity: agent("acp", 1, { resolvedModel: "cli/acp" }) }]),
    frame(3, "pi-window", 1, 2, [{ kind: "upsert", entity: agent("pi-new", 2) }]),
  ];
  const rebuilt = rebuildRuntimeReadModelFromBrokerFramesV2("w1", records);
  assert.equal(rebuilt.discarded, 0);
  assert.deepEqual(
    rebuilt.projection.snapshot().agents.map((item) => item.correlationId),
    ["acp", "pi-new"],
  );
});

test("late old-generation tombstone is ignored during snapshot rebuild", () => {
  const records = [
    frame(1, "window:a", 1, 1, [{ kind: "upsert", entity: agent("same", 1) }]),
    frame(2, "window:a", 1, 2, [{ kind: "upsert", entity: agent("same", 2) }]),
    frame(3, "window:a", 2, 1, [{ kind: "tombstone", correlationId: "same", generation: 1 }], false),
  ];
  const rebuilt = rebuildRuntimeReadModelFromBrokerFramesV2("w1", records);
  assert.equal(rebuilt.discarded, 0);
  assert.equal(rebuilt.projection.cursor, 3);
  assert.equal(rebuilt.projection.agent("same")?.generation, 2);
});

test("deleting every read projection and replaying broker frames produces the same snapshot", () => {
  const records = [
    frame(2, "window:a", 1, 1, [{ kind: "upsert", entity: agent("a") }]),
    frame(7, "window:a", 2, 1, [{ kind: "upsert", entity: agent("a", 1, { status: "sleeping" }) }], false),
  ];
  const original = rebuildRuntimeReadModelFromBrokerFramesV2("w1", records).projection.snapshot();
  const rebuilt = rebuildRuntimeReadModelFromBrokerFramesV2("w1", records).projection.snapshot();
  assert.deepEqual(rebuilt, original);
  rebuilt.agents[0]!.agent = "mutated consumer copy";
  assert.equal(rebuildRuntimeReadModelFromBrokerFramesV2("w1", records).projection.agent("a")?.agent, "executor");
});

test("split batches remain invisible until terminal frame and generation reset discards partial work", () => {
  const accumulator = new RuntimeReadModelBrokerAccumulatorV2();
  assert.equal(accumulator.apply(frame(1, "window:a", 1, 1, [{ kind: "upsert", entity: agent("a") }])), true);
  const first: RuntimeReadModelSourceFrameV2 = {
    version: 2,
    revision: 1,
    kind: "agent-runs-source-frame",
    source: { streamId: "window:a", revision: 2, generation: 1 },
    batchId: "batch-update",
    batchIndex: 0,
    batchCount: 2,
    reset: false,
    changes: [{ kind: "upsert", entity: agent("b") }],
  };
  assert.equal(accumulator.apply({ cursor: 2, frame: first }), true);
  assert.deepEqual(accumulator.snapshot("w1").agents.map((item) => item.correlationId), ["a"]);
  assert.equal(accumulator.apply({
    cursor: 3,
    frame: {
      ...first,
      source: { ...first.source, revision: 3 },
      batchIndex: 1,
      changes: [{ kind: "upsert", entity: agent("c") }],
    },
  }), true);
  assert.deepEqual(accumulator.snapshot("w1").agents.map((item) => item.correlationId), ["a", "b", "c"]);

  assert.equal(accumulator.apply({
    cursor: 4,
    frame: {
      ...first,
      source: { ...first.source, revision: 4 },
      batchId: "abandoned",
      changes: [{ kind: "tombstone", correlationId: "a", generation: 1 }],
    },
  }), true);
  assert.deepEqual(accumulator.snapshot("w1").agents.map((item) => item.correlationId), ["a", "b", "c"]);
  assert.equal(accumulator.apply(frame(5, "window:a", 1, 2, [{ kind: "upsert", entity: agent("new", 2) }])), true);
  assert.deepEqual(accumulator.snapshot("w1").agents.map((item) => item.correlationId), ["new"]);
});

test("expired broker lease sources are excluded without deleting active windows", () => {
  const records = [
    frame(1, "window:expired", 1, 1, [{ kind: "upsert", entity: agent("stale") }]),
    frame(2, "window:active", 1, 3, [{ kind: "upsert", entity: agent("live", 3) }]),
  ];
  const rebuilt = rebuildRuntimeReadModelFromBrokerFramesV2(
    "w1",
    records,
    new Map([["window:active", 3]]),
  );
  assert.equal(rebuilt.discarded, 0);
  assert.deepEqual(rebuilt.projection.snapshot().agents.map((item) => item.correlationId), ["live"]);
});

test("broker replay rejects source revision gaps and duplicate generations", () => {
  const gap = rebuildRuntimeReadModelFromBrokerFramesV2("w1", [
    frame(1, "window:a", 1, 1, [{ kind: "upsert", entity: agent("a") }]),
    frame(2, "window:a", 3, 1, [{ kind: "upsert", entity: agent("b") }], false),
  ]);
  assert.equal(gap.discarded, 1);

  const duplicate = rebuildRuntimeReadModelFromBrokerFramesV2("w1", [
    frame(1, "window:a", 1, 1, [{ kind: "upsert", entity: agent("a") }]),
    frame(2, "window:a", 1, 1, [], false),
  ]);
  assert.equal(duplicate.discarded, 1);
});

test("PI_RUNTIME_V2_READ defaults on with SQLite and preserves explicit v1 rollback", () => {
  assert.equal(runtimeV2ReadEnabled({}), true);
  assert.equal(runtimeV2ReadEnabled({ PI_RUNTIME_V2_READ: "0" }), false);
  assert.equal(runtimeV2ReadEnabled({ PI_RUNTIME_V2_READ: "true" }), false);
  assert.equal(runtimeV2ReadEnabled({ PI_RUNTIME_V2_READ: "1" }), true);
  assert.equal(runtimeV2ReadEnabled({ PI_RUNTIME_BROKER: "off" }), false);
  assert.equal(runtimeV2ReadEnabled({ PI_RUNTIME_BROKER: "file" }), false);
  assert.equal(runtimeV2ReadEnabled({ PI_RUNTIME_BROKER: "invalid" }), false);
});

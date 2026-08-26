import assert from "node:assert/strict";
import test from "node:test";
import {
  parseActorAddressV2,
  parseRuntimeCommandV2,
  parseRuntimeEventV2,
  parseRuntimeLeaseV2,
  parseRuntimeProjectionV2,
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
} from "../src/public/v2/runtime.ts";
import { normalizePersistedRuntimeEventV2 } from "../src/runtime-v2/validation.ts";

const actor: ActorAddressV2 = {
  version: 2,
  revision: 1,
  workspaceId: "workspace-a",
  actorKind: "teammate",
  actorId: "agent-a",
  generation: 1,
};

test("Runtime V2 public contracts carry stable version and revision headers", () => {
  assert.equal(RUNTIME_V2_VERSION, 2);
  assert.equal(RUNTIME_V2_REVISION, 1);
  assert.deepEqual(parseActorAddressV2(actor), actor);
  assert.equal(parseRuntimeCommandV2({
    version: 2,
    revision: 1,
    commandId: "command-a",
    streamId: "stream-a",
    target: actor,
    kind: "run.start",
    issuedAt: 10,
  }).kind, "run.start");
  assert.equal(parseRuntimeLeaseV2({
    version: 2,
    revision: 1,
    leaseId: "lease-a",
    streamId: "stream-a",
    holder: actor,
    epoch: 1,
    acquiredAt: 10,
    expiresAt: 20,
  }).expiresAt, 20);
  assert.equal(parseRuntimeProjectionV2({
    version: 2,
    revision: 1,
    streamId: "stream-a",
    lastSequence: 0,
    lifecycle: "pending",
    activeToolCallIds: [],
    resultPublished: false,
    updatedAt: 10,
  }).lifecycle, "pending");
});

test("strict public parsing rejects legacy persisted Runtime V2 values", () => {
  const legacy = {
    version: "2",
    streamId: "stream-a",
    sequence: 1,
    actor: { ...actor, version: "2", revision: undefined },
    occurredAt: 10,
    kind: "tool_start",
    toolCallId: "tool-a",
    toolName: "read",
  };
  assert.throws(() => parseRuntimeEventV2(legacy));
  const normalized = normalizePersistedRuntimeEventV2(legacy);
  assert.equal(normalized.kind, "tool.started");
  assert.equal(normalized.version, 2);
  assert.equal(normalized.revision, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_BROKER_PROTOCOL,
  RUNTIME_BROKER_PROTOCOL_VERSION,
  RuntimeBrokerError,
  assertJsonValue,
  assertNonNegativeInteger,
  type RuntimeBrokerRequestEnvelope,
} from "../src/runtime-broker/contracts.ts";

test("runtime broker contracts are driver-neutral JSONL envelopes", () => {
  const request: RuntimeBrokerRequestEnvelope<{ actorId: string }> = {
    protocol: RUNTIME_BROKER_PROTOCOL,
    version: RUNTIME_BROKER_PROTOCOL_VERSION,
    requestId: "request-1",
    method: "lease.acquire",
    params: { actorId: "actor-1" },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(request)), request);
  assert.equal(RUNTIME_BROKER_PROTOCOL, "pi.runtime-broker");
  assert.equal(RUNTIME_BROKER_PROTOCOL_VERSION, 1);
});

test("runtime broker errors have stable serializable codes", () => {
  const error = new RuntimeBrokerError("revision_conflict", "revision changed", {
    expectedRevision: 2,
    actualRevision: 3,
  });
  assert.deepEqual(error.toJSON(), {
    code: "revision_conflict",
    message: "revision changed",
    details: { expectedRevision: 2, actualRevision: 3 },
  });
});

test("contract guards reject values that cannot cross JSONL", () => {
  assert.doesNotThrow(() => assertJsonValue({ nested: [null, true, 3, "ok"] }, "payload"));
  assert.throws(
    () => assertJsonValue({ value: Number.NaN }, "payload"),
    (error: unknown) => error instanceof RuntimeBrokerError && error.code === "invalid_request",
  );
  assert.throws(
    () => assertNonNegativeInteger(-1, "revision"),
    (error: unknown) => error instanceof RuntimeBrokerError && error.code === "invalid_request",
  );
  assert.throws(
    () => assertNonNegativeInteger("1", "revision"),
    (error: unknown) => error instanceof RuntimeBrokerError && error.code === "invalid_request",
  );
});

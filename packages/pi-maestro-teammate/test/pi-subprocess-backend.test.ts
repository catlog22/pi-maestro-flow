import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilitySupport } from "pi-maestro-backend-core/v1";
import { resolveBackendConfig } from "pi-maestro-backends";
import { createPiSubprocessBackend } from "../src/backends/pi-subprocess.ts";

const backend = createPiSubprocessBackend(() => {
  throw new Error("no run is started in these tests");
});

test("Pi reaches the orchestrator through the ordinary backend contract", () => {
  assert.equal(backend.name, "pi-subprocess");
  assert.equal(backend.protocolVersion, 1);
  assert.equal(typeof backend.start, "function");
});

test("Pi serves every orchestrator-requestable capability natively", () => {
  const supports: CapabilitySupport[] = Object.values(backend.capabilities({}));
  assert.equal(supports.length, 9);
  assert.deepEqual([...new Set(supports)], ["native"]);
});

test("a failed Pi attempt recovers by replay, so the host fence governs it", () => {
  assert.equal(backend.recoveryShape, "replay");
});

test("the tunables Pi exposes are timing bounds, not orchestrator requests", () => {
  const keys = (backend.configFields ?? []).map((field) => field.key);
  assert.deepEqual(keys, [
    "firstActivityTimeoutMs",
    "resultReadyGraceMs",
    "outputLimitRecoveryTimeoutMs",
    "structuredOutputRecoveryTimeoutMs",
    "toolExecutionHeartbeatMs",
    "interruptingSteerTimeoutMs",
    "foregroundMaxRunMs",
  ]);
  assert.deepEqual([...new Set((backend.configFields ?? []).map((f) => f.kind))], ["integer"]);
});

test("omitted tunables leave the runtime's own defaults in place", () => {
  const resolved = resolveBackendConfig(backend, {});
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.values, {});
});

test("a non-positive timeout is rejected at registration, not at dispatch", () => {
  const resolved = resolveBackendConfig(backend, { firstActivityTimeoutMs: 0 });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /"firstActivityTimeoutMs" must be a positive number of milliseconds, got 0/);
});

test("a non-integer timeout is rejected by the declared field kind", () => {
  const resolved = resolveBackendConfig(backend, { toolExecutionHeartbeatMs: 1.5 });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /expected an integer, got 1.5/);
});

test("an undeclared tunable names the ones Pi accepts", () => {
  const resolved = resolveBackendConfig(backend, { spawnTimeoutMs: 1000 });
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0]!, /has no setting "spawnTimeoutMs"/);
  assert.match(resolved.errors[0]!, /firstActivityTimeoutMs/);
});

test("every configured tunable is accepted together", () => {
  const resolved = resolveBackendConfig(backend, {
    firstActivityTimeoutMs: 30_000,
    resultReadyGraceMs: 2_000,
    outputLimitRecoveryTimeoutMs: 5_000,
    structuredOutputRecoveryTimeoutMs: 5_000,
    toolExecutionHeartbeatMs: 10_000,
    interruptingSteerTimeoutMs: 10_000,
    foregroundMaxRunMs: 600_000,
  });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.values.foregroundMaxRunMs, 600_000);
});

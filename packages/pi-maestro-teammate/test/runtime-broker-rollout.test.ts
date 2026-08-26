import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeTransport,
  parseRuntimeBrokerMode,
  runtimeBrokerModeFromEnv,
  type RuntimeBrokerMode,
} from "../src/runtime-broker/rollout.ts";
import type {
  RuntimeTransport,
  RuntimeTransportDriver,
} from "../src/runtime-broker/transport.ts";

function fakeTransport<TDriver extends RuntimeTransportDriver>(
  driver: TDriver,
): RuntimeTransport & { readonly driver: TDriver } {
  return {
    driver,
    enqueue: async () => ({ ok: true, messageId: "message-1", state: "ready" }),
    consume: async () => {},
    acknowledge: async () => false,
    state: async () => undefined,
    hasPendingMessages: async () => false,
    stop: async () => {},
  };
}

test("PI_RUNTIME_BROKER defaults to off (sqlite opt-in) and invalid values fail closed to off", () => {
  assert.equal(runtimeBrokerModeFromEnv({}), "off");
  assert.equal(parseRuntimeBrokerMode(undefined), "off");
  assert.equal(parseRuntimeBrokerMode(""), "off");
  assert.equal(parseRuntimeBrokerMode("invalid"), "off");
  assert.equal(parseRuntimeBrokerMode("sqlite"), "sqlite");
  assert.equal(parseRuntimeBrokerMode("file"), "file");

  let constructed = 0;
  const sqlite = fakeTransport("sqlite");
  const defaultSelection = createRuntimeTransport({
    env: {},
    sqliteFactory: () => { constructed += 1; return sqlite; },
  });
  assert.deepEqual(defaultSelection, { mode: "off", transport: undefined });
  assert.equal(constructed, 0);

  const optIn = createRuntimeTransport({
    env: { PI_RUNTIME_BROKER: "sqlite" },
    sqliteFactory: () => { constructed += 1; return sqlite; },
  });
  assert.equal(optIn.mode, "sqlite");
  assert.equal(optIn.transport, sqlite);
  assert.equal(constructed, 1);

  const selection = createRuntimeTransport({
    env: { PI_RUNTIME_BROKER: "invalid" },
    fileFactory: () => { constructed += 1; return fakeTransport("file"); },
    sqliteFactory: () => { constructed += 1; return fakeTransport("sqlite"); },
  });
  assert.deepEqual(selection, { mode: "off", transport: undefined });
  assert.equal(constructed, 1);

  const invalidOverride = createRuntimeTransport({
    mode: "invalid" as RuntimeBrokerMode,
    fileFactory: () => { constructed += 1; return fakeTransport("file"); },
    sqliteFactory: () => { constructed += 1; return fakeTransport("sqlite"); },
  });
  assert.deepEqual(invalidOverride, { mode: "off", transport: undefined });
  assert.equal(constructed, 1);
});

test("PI_RUNTIME_BROKER=off constructs no transport", () => {
  const selection = createRuntimeTransport({ env: { PI_RUNTIME_BROKER: "off" } });
  assert.deepEqual(selection, { mode: "off", transport: undefined });
});

test("PI_RUNTIME_BROKER=file constructs only the injected file adapter", () => {
  const file = fakeTransport("file");
  let sqliteConstructed = false;
  const selection = createRuntimeTransport({
    env: { PI_RUNTIME_BROKER: "file" },
    fileFactory: () => file,
    sqliteFactory: () => { sqliteConstructed = true; return fakeTransport("sqlite"); },
  });
  assert.equal(selection.mode, "file");
  assert.equal(selection.transport, file);
  assert.equal(sqliteConstructed, false);
});

test("PI_RUNTIME_BROKER=sqlite uses the injected client factory boundary", () => {
  const sqlite = fakeTransport("sqlite");
  let fileConstructed = false;
  const selection = createRuntimeTransport({
    env: { PI_RUNTIME_BROKER: "sqlite" },
    fileFactory: () => { fileConstructed = true; return fakeTransport("file"); },
    sqliteFactory: () => sqlite,
  });
  assert.equal(selection.mode, "sqlite");
  assert.equal(selection.transport, sqlite);
  assert.equal(fileConstructed, false);
});

test("an enabled mode without a matching factory fails closed", () => {
  assert.throws(
    () => createRuntimeTransport({ env: { PI_RUNTIME_BROKER: "sqlite" } }),
    /sqlite runtime transport factory is not configured/,
  );
  assert.throws(
    () => createRuntimeTransport({
      env: { PI_RUNTIME_BROKER: "file" },
      fileFactory: () => fakeTransport("sqlite"),
    }),
    /file runtime transport factory returned sqlite/,
  );
});

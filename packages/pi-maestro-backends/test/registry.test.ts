import assert from "node:assert/strict";
import test from "node:test";
import type { BackendCapabilities, TeammateBackend } from "pi-maestro-backend-core/v1/backend";
import { TeammateBackendRegistry, validateBackendCapabilities } from "pi-maestro-backends";

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native",
  forkContext: "native",
  modelSelection: "native",
  thinkingLevel: "native",
  todoBinding: "native",
  toolFilter: "native",
  steer: "native",
  followUp: "native",
  abort: "native",
};

function backend(name: string, overrides: Partial<TeammateBackend> = {}): TeammateBackend {
  return {
    name,
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    recoveryShape: "replay",
    start: () => {
      throw new Error("not started in these tests");
    },
    ...overrides,
  };
}

const SPEC = { agent: "general", task: "do the thing" };

test("a default naming an unregistered backend fails at construction", () => {
  assert.throws(
    () => new TeammateBackendRegistry(
      { default: "dsh", backends: { "pi-subprocess": { module: "x" } } },
      async () => backend("pi-subprocess"),
    ),
    /names "dsh" as its default, but no such backend is registered \(registered: pi-subprocess\)/,
  );
});

test("a task naming no backend resolves the default", async () => {
  const registry = new TeammateBackendRegistry(
    { default: "pi-subprocess", backends: { "pi-subprocess": { module: "pi" } } },
    async () => backend("pi-subprocess"),
  );
  const resolved = await registry.resolve(SPEC);
  assert.equal(resolved.backend.name, "pi-subprocess");
  assert.deepEqual(resolved.config, {});
});

test("an unloadable module is a hard failure, never a fallback to the default", async () => {
  const registry = new TeammateBackendRegistry(
    {
      default: "pi-subprocess",
      backends: { "pi-subprocess": { module: "pi" }, dsh: { module: "missing" } },
    },
    async (module) => {
      if (module === "missing") throw new Error("ENOENT");
      return backend("pi-subprocess");
    },
  );
  await assert.rejects(
    registry.resolve(SPEC, "dsh"),
    /teammate backend "dsh" could not be loaded from "missing"/,
  );
});

test("a module exporting no backend is rejected by name", async () => {
  const registry = new TeammateBackendRegistry(
    { default: "broken", backends: { broken: { module: "b" } } },
    async () => ({ notABackend: true }),
  );
  await assert.rejects(registry.resolve(SPEC), /exports no backend/);
});

test("a protocol mismatch is rejected before the backend is ever started", async () => {
  const registry = new TeammateBackendRegistry(
    { default: "future", backends: { future: { module: "f" } } },
    async () => backend("future", { protocolVersion: 2 as unknown as 1 }),
  );
  await assert.rejects(registry.resolve(SPEC), /implements protocol version 2, but this host speaks version 1/);
});

test("a default export is unwrapped", async () => {
  const registry = new TeammateBackendRegistry(
    { default: "pi-subprocess", backends: { "pi-subprocess": { module: "pi" } } },
    async () => ({ default: backend("pi-subprocess") }),
  );
  assert.equal((await registry.resolve(SPEC)).backend.name, "pi-subprocess");
});

test("misconfiguration surfaces at resolution with every rejection listed", async () => {
  const registry = new TeammateBackendRegistry(
    { default: "dsh", backends: { dsh: { module: "d", config: { nope: 1 } } } },
    async () => backend("dsh"),
  );
  await assert.rejects(registry.resolve(SPEC), /is misconfigured:\n {2}- backend "dsh" accepts no configuration/);
});

test("a backend named by several tasks is loaded and checked once", async () => {
  let loads = 0;
  const registry = new TeammateBackendRegistry(
    { default: "pi-subprocess", backends: { "pi-subprocess": { module: "pi" } } },
    async () => {
      loads += 1;
      return backend("pi-subprocess");
    },
  );
  await Promise.all([registry.resolve(SPEC), registry.resolve(SPEC), registry.capabilitiesOf("pi-subprocess")]);
  assert.equal(loads, 1);
});

test("the registry reports what it knows", () => {
  const registry = new TeammateBackendRegistry(
    { default: "pi-subprocess", backends: { "pi-subprocess": { module: "pi" }, dsh: { module: "d" } } },
    async () => backend("pi-subprocess"),
  );
  assert.deepEqual(registry.listBackendNames(), ["pi-subprocess", "dsh"]);
  assert.equal(registry.defaultBackendName(), "pi-subprocess");
});

test("one backend module registered twice with different configs adjudicates differently", async () => {
  // The point of a capability function: the same module, registered for two
  // deployments, must be able to report different tables. A static table can
  // only describe one of them, and whichever it describes, the other lies.
  const bridgeAware: TeammateBackend = {
    name: "probe",
    protocolVersion: 1,
    capabilities: (config) => ({
      ...CAPABILITIES,
      todoBinding: config.bridge === true ? "native" : "unsupported",
    }),
    recoveryShape: "replay",
    configFields: [{ key: "bridge", kind: "boolean", labelKey: "probe.bridge", default: false }],
    resolveConfig: (config) => ({ values: config, errors: [] }),
    start: () => {
      throw new Error("not started in these tests");
    },
  };
  const registry = new TeammateBackendRegistry(
    {
      default: "bridged",
      backends: {
        bridged: { module: "m", config: { bridge: true } },
        plain: { module: "m", config: { bridge: false } },
      },
    },
    async () => bridgeAware,
  );

  const spec = { agent: "a", task: "t", todos: ["t1"] };
  const bridged = await registry.resolve(spec, "bridged");
  const plain = await registry.resolve(spec, "plain");

  const accepted = validateBackendCapabilities(
    [{ spec }],
    () => ({ name: "probe", capabilities: bridged.capabilities }),
  );
  const rejected = validateBackendCapabilities(
    [{ spec }],
    () => ({ name: "probe", capabilities: plain.capabilities }),
  );
  assert.equal(accepted.errors.length, 0);
  assert.equal(rejected.errors.length, 1);
});

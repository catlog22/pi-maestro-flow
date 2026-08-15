import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_SUBPROCESS,
  createTeammateBackendRegistry,
  readBackendRegistryConfig,
} from "../src/backends/registry-host.ts";

async function workspace(document?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "teammate-backends-"));
  if (document !== undefined) {
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "teammate-backends.json"), document, "utf-8");
  }
  return root;
}

const extras = (): never => {
  throw new Error("no run is started in these tests");
};

test("a project with no document stays on the legacy path", async () => {
  assert.equal(await createTeammateBackendRegistry(await workspace(), extras), undefined);
});

test("registrations alone do not switch the dispatch path", async () => {
  const root = await workspace(JSON.stringify({
    default: PI_SUBPROCESS,
    backends: { dsh: { module: "some-dsh-backend" } },
  }));
  assert.equal(await createTeammateBackendRegistry(root, extras), undefined);
});

test("the document's mode is what switches it, and switching back is the same edit", async () => {
  const root = await workspace(JSON.stringify({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  assert.notEqual(await createTeammateBackendRegistry(root, extras), undefined);
  assert.equal(await createTeammateBackendRegistry(root, extras, "legacy"), undefined);
});

test("an unknown mode fails at load with the modes it accepts", async () => {
  const root = await workspace(JSON.stringify({
    mode: "registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  await assert.rejects(
    readBackendRegistryConfig(root),
    /names mode "registry"; expected one of legacy \| backend-registry/,
  );
});

test("a project with no document gets Pi under its ordinary name, on the legacy path", async () => {
  const config = await readBackendRegistryConfig(await workspace());
  assert.equal(config.mode, "legacy");
  assert.equal(config.default, PI_SUBPROCESS);
  assert.deepEqual(Object.keys(config.backends), [PI_SUBPROCESS]);
});

test("malformed JSON fails instead of silently running the built-in", async () => {
  const root = await workspace("{ not json");
  await assert.rejects(readBackendRegistryConfig(root), /is not valid JSON/);
});

test("a document missing default or backends is rejected by name", async () => {
  await assert.rejects(
    readBackendRegistryConfig(await workspace(JSON.stringify({ backends: {} }))),
    /must name a "default" backend/,
  );
  await assert.rejects(
    readBackendRegistryConfig(await workspace(JSON.stringify({ default: "x" }))),
    /must map "backends" to registrations/,
  );
});

test("adding a remote backend does not drop Pi", async () => {
  const config = await readBackendRegistryConfig(await workspace(JSON.stringify({
    default: PI_SUBPROCESS,
    backends: { dsh: { module: "some-dsh-backend" } },
  })));
  assert.deepEqual(Object.keys(config.backends).sort(), ["dsh", PI_SUBPROCESS].sort());
});

test("a document may redefine the built-in registration", async () => {
  const config = await readBackendRegistryConfig(await workspace(JSON.stringify({
    default: PI_SUBPROCESS,
    backends: { [PI_SUBPROCESS]: { module: "custom-pi", config: { resultReadyGraceMs: 5000 } } },
  })));
  assert.equal(config.backends[PI_SUBPROCESS]?.module, "custom-pi");
});

test("Pi resolves to the in-process backend rather than a second import", async () => {
  const root = await workspace(JSON.stringify({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  const registry = await createTeammateBackendRegistry(root, extras);
  assert.notEqual(registry, undefined);
  const resolved = await registry!.resolve({ agent: "general", task: "t" });
  assert.equal(resolved.backend.name, PI_SUBPROCESS);
  assert.equal(resolved.backend.recoveryShape, "replay");
});

test("a default naming an unregistered backend fails while the operator is looking at the file", async () => {
  const root = await workspace(JSON.stringify({
    mode: "backend-registry",
    default: "dsh",
    backends: {},
  }));
  await assert.rejects(
    createTeammateBackendRegistry(root, extras),
    /names "dsh" as its default/,
  );
});

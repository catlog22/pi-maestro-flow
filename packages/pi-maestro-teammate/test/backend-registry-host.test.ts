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

test("legacy mode builds no registry at all", async () => {
  const registry = await createTeammateBackendRegistry("legacy", await workspace(), extras);
  assert.equal(registry, undefined);
});

test("a project with no document gets Pi under its ordinary name", async () => {
  const config = await readBackendRegistryConfig(await workspace());
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
  const registry = await createTeammateBackendRegistry("backend-registry", await workspace(), extras);
  assert.notEqual(registry, undefined);
  const resolved = await registry!.resolve({ agent: "general", task: "t" });
  assert.equal(resolved.backend.name, PI_SUBPROCESS);
  assert.equal(resolved.backend.recoveryShape, "replay");
});

test("a default naming an unregistered backend fails while the operator is looking at the file", async () => {
  const root = await workspace(JSON.stringify({ default: "dsh", backends: {} }));
  await assert.rejects(
    createTeammateBackendRegistry("backend-registry", root, extras),
    /names "dsh" as its default/,
  );
});

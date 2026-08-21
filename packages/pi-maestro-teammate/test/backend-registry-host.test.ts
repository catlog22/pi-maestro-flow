import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_SUBPROCESS,
  backendRegistryConfigSync,
  dispatchRegistrySync,
  forgetBackendRegistryConfigSync,
} from "../src/backends/registry-host.ts";

// Keep default-path tests isolated from the operator's real global registry.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "teammate-backends-agent-"));

/**
 * Reading the registration document and deciding the dispatch path.
 *
 * The reader is synchronous because dispatch resolves the registry immediately
 * before spawning; an awaited read there delays the child by an I/O tick, which
 * breaks callers that address its stdin as soon as dispatch returns.
 */

function workspace(document?: string): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-backends-"));
  if (document !== undefined) {
    mkdirSync(join(root, ".pi"), { recursive: true });
    writeFileSync(join(root, ".pi", "teammate-backends.json"), document, "utf-8");
  }
  forgetBackendRegistryConfigSync(root);
  return root;
}

function globalDocument(document: string): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-backends-global-"));
  const path = join(root, "teammate-backends.json");
  writeFileSync(path, document, "utf-8");
  return path;
}

const extras = (): never => {
  throw new Error("no run is started in these tests");
};

test("a project with no document stays on the legacy path", () => {
  assert.equal(dispatchRegistrySync(workspace(), extras), undefined);
});

test("a global document switches projects that have no document", () => {
  const root = workspace();
  const globalPath = globalDocument(JSON.stringify({
    mode: "backend-registry",
    default: "cursor",
    backends: { cursor: { module: "some-acp-backend" } },
  }));

  const config = backendRegistryConfigSync(root, globalPath);
  assert.equal(config.mode, "backend-registry");
  assert.equal(config.default, "cursor");
  assert.equal(config.backends.cursor?.module, "some-acp-backend");
  assert.notEqual(dispatchRegistrySync(root, extras, undefined, globalPath), undefined);
});

test("a project document wins as a whole over the global document", () => {
  const root = workspace(JSON.stringify({
    mode: "legacy",
    default: PI_SUBPROCESS,
    backends: { project: { module: "project-backend" } },
  }));
  const globalPath = globalDocument(JSON.stringify({
    mode: "backend-registry",
    default: "cursor",
    backends: { cursor: { module: "global-acp-backend" } },
  }));

  const config = backendRegistryConfigSync(root, globalPath);
  assert.equal(config.mode, "legacy");
  assert.equal(config.default, PI_SUBPROCESS);
  assert.equal(config.backends.project?.module, "project-backend");
  assert.equal(config.backends.cursor, undefined);
  assert.equal(dispatchRegistrySync(root, extras, undefined, globalPath), undefined);
});

test("a malformed global document fails when no project document overrides it", () => {
  const root = workspace();
  const globalPath = globalDocument("{ not json");
  assert.throws(
    () => backendRegistryConfigSync(root, globalPath),
    new RegExp(`teammate backend registry at ${globalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON`),
  );
});

test("registrations alone do not switch the dispatch path", () => {
  const root = workspace(JSON.stringify({
    default: PI_SUBPROCESS,
    backends: { dsh: { module: "some-dsh-backend" } },
  }));
  assert.equal(dispatchRegistrySync(root, extras), undefined);
});

test("the document's mode is what switches it, and switching back is the same edit", () => {
  const registryRoot = workspace(JSON.stringify({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  assert.notEqual(dispatchRegistrySync(registryRoot, extras), undefined);

  const legacyRoot = workspace(JSON.stringify({
    mode: "legacy",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  assert.equal(dispatchRegistrySync(legacyRoot, extras), undefined);
});

test("an unknown mode fails at load with the modes it accepts", () => {
  const root = workspace(JSON.stringify({
    mode: "registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  assert.throws(
    () => backendRegistryConfigSync(root),
    /names mode "registry"; expected one of legacy \| backend-registry/,
  );
});

test("a project with no document gets Pi under its ordinary name, on the legacy path", () => {
  const config = backendRegistryConfigSync(workspace());
  assert.equal(config.mode, "legacy");
  assert.equal(config.default, PI_SUBPROCESS);
  assert.deepEqual(Object.keys(config.backends), [PI_SUBPROCESS]);
});

test("malformed JSON fails instead of silently running the built-in", () => {
  const root = workspace("{ not json");
  assert.throws(() => backendRegistryConfigSync(root), /is not valid JSON/);
});

test("a document missing default or backends is rejected by name", () => {
  assert.throws(
    () => backendRegistryConfigSync(workspace(JSON.stringify({ backends: {} }))),
    /must name a "default" backend/,
  );
  assert.throws(
    () => backendRegistryConfigSync(workspace(JSON.stringify({ default: "x" }))),
    /must map "backends" to registrations/,
  );
});

test("adding a remote backend does not drop Pi", () => {
  const config = backendRegistryConfigSync(workspace(JSON.stringify({
    default: PI_SUBPROCESS,
    backends: { dsh: { module: "some-dsh-backend" } },
  })));
  assert.deepEqual(Object.keys(config.backends).sort(), ["dsh", PI_SUBPROCESS].sort());
});

test("a document may redefine the built-in registration", () => {
  const config = backendRegistryConfigSync(workspace(JSON.stringify({
    default: PI_SUBPROCESS,
    backends: { [PI_SUBPROCESS]: { module: "custom-pi", config: { resultReadyGraceMs: 5000 } } },
  })));
  assert.equal(config.backends[PI_SUBPROCESS]?.module, "custom-pi");
});

test("the document is read once per workspace, not once per dispatch", () => {
  const root = workspace(JSON.stringify({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  assert.equal(backendRegistryConfigSync(root), backendRegistryConfigSync(root));
});

test("Pi resolves to the in-process backend rather than a second import", async () => {
  const root = workspace(JSON.stringify({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  }));
  const registry = dispatchRegistrySync(root, extras);
  assert.notEqual(registry, undefined);
  const resolved = await registry!.resolve({ agent: "general", task: "t" });
  assert.equal(resolved.backend.name, PI_SUBPROCESS);
  assert.equal(resolved.backend.recoveryShape, "replay");
});

test("a default naming an unregistered backend fails while the operator is looking at the file", () => {
  const root = workspace(JSON.stringify({
    mode: "backend-registry",
    default: "dsh",
    backends: {},
  }));
  assert.throws(() => dispatchRegistrySync(root, extras), /names "dsh" as its default/);
});

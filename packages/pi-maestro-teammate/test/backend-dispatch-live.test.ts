import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
import { createPiSubprocessBackend } from "../src/backends/pi-subprocess.ts";
import {
  dispatchRegistrySync,
  forgetBackendRegistryConfigSync,
  PI_SUBPROCESS,
} from "../src/backends/registry-host.ts";
import type { RunTeammateOptions } from "../src/runs/execution-infra.ts";

/**
 * A workspace holding one real agent definition, and optionally a registration
 * document. The agent must be discoverable for real: the defect these tests
 * exist to catch was a swapped `resolveAgent(name, cwd)` that only fails once
 * discovery actually runs against a directory.
 */
function workspace(document?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-live-"));
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "agents", "prober.md"),
    "---\nname: prober\ndescription: \"fixture agent\"\ntools:\n  - Read\n---\n\n# Prober\n",
    "utf-8",
  );
  if (document !== undefined) {
    writeFileSync(
      join(root, ".pi", "teammate-backends.json"),
      `${JSON.stringify(document, null, 2)}\n`,
      "utf-8",
    );
  }
  forgetBackendRegistryConfigSync(root);
  return root;
}

const SPEC = { agent: "prober", task: "probe" };

function backendOptions(root: string): BackendRunOptions {
  return { correlationId: "c-1", baseCwd: root, host: {}, config: {} };
}

/** Host wiring that stops the attempt before a child is spawned. */
function extrasOf(root: string) {
  const spawned: string[] = [];
  const hostOptions = {
    baseCwd: root,
    spawnChildProcess: ((command: string) => {
      spawned.push(command);
      throw new Error("SPAWN REACHED");
    }) as unknown as RunTeammateOptions["spawnChildProcess"],
  } as RunTeammateOptions;
  return {
    spawned,
    extras: () => ({ hostOptions, cwd: root, replyTo: "caller" as const }),
  };
}

test("the Pi backend resolves a real agent, so a swapped resolveAgent argument fails here", async () => {
  const root = workspace();
  const { extras } = extrasOf(root);
  const backend = createPiSubprocessBackend(extras);
  // start() resolving at all is the assertion: a failed agent resolve throws
  // inside start() before any run begins, so the swapped argument order made
  // this reject for every agent — and no test called start() to notice.
  const run = await backend.start(SPEC, backendOptions(root));
  assert.equal(typeof run.send, "function");
  run.abort();
  await run.outcome.catch(() => undefined);
});

test("an unknown agent still reports the resolve failure by name", async () => {
  const root = workspace();
  const { extras } = extrasOf(root);
  const backend = createPiSubprocessBackend(extras);
  await assert.rejects(
    backend.start({ agent: "no-such-agent", task: "probe" }, backendOptions(root)),
    /cannot resolve agent "no-such-agent"/,
  );
});

test("a workspace with no document dispatches on the legacy path", () => {
  const root = workspace();
  assert.equal(dispatchRegistrySync(root, () => { throw new Error("unused"); }), undefined);
});

test("registrations alone do not switch the dispatch path", () => {
  const root = workspace({
    default: PI_SUBPROCESS,
    backends: { dsh: { module: "some-dsh-backend" } },
  });
  assert.equal(dispatchRegistrySync(root, () => { throw new Error("unused"); }), undefined);
});

test("the document's mode is what makes the registry live", () => {
  const root = workspace({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  });
  const registry = dispatchRegistrySync(root, () => { throw new Error("unused"); });
  assert.notEqual(registry, undefined);
  assert.equal(registry?.defaultBackendName(), PI_SUBPROCESS);
});

test("a live registry resolves Pi to the in-process backend and reaches its start()", async () => {
  const root = workspace({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: {},
  });
  const { extras } = extrasOf(root);
  const registry = dispatchRegistrySync(root, extras);
  assert.notEqual(registry, undefined);
  const { backend } = await registry!.resolve(SPEC);
  assert.equal(backend.name, PI_SUBPROCESS);
  const run = await backend.start(SPEC, backendOptions(root));
  assert.equal(typeof run.send, "function");
  run.abort();
  await run.outcome.catch(() => undefined);
});

test("a registration without a module is rejected while the operator is looking at the file", () => {
  const root = workspace({
    mode: "backend-registry",
    default: PI_SUBPROCESS,
    backends: { dsh: {} },
  });
  assert.throws(
    () => dispatchRegistrySync(root, () => { throw new Error("unused"); }),
    /registration "dsh" must name a "module"/,
  );
});

test("an array in place of the backends map is rejected", () => {
  const root = workspace({ mode: "legacy", default: PI_SUBPROCESS, backends: ["x"] });
  assert.throws(
    () => dispatchRegistrySync(root, () => { throw new Error("unused"); }),
    /must map "backends" to registrations/,
  );
});

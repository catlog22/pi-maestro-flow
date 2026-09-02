import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  TeammateExecutionProvenance,
  TeammateResultPublishedEvent,
} from "../src/public/v1/events.ts";
import { parseProxyTeammateParams } from "../src/extension/index.ts";
import { normalizeTeammateParams } from "../src/runs/execution.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../src/public/v1/", import.meta.url));
const PUBLIC_V2_DIR = fileURLToPath(new URL("../src/public/v2/", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * Walks the *runtime* import graph: `import type` / `export type` statements
 * are erased by the TypeScript transform, so they cost a consumer nothing and
 * must not count against a leaf module.
 */
function runtimeGraph(entry: string): { modules: Set<string>; externals: Set<string> } {
  const modules = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    const abs = path.resolve(file);
    if (modules.has(abs)) return;
    modules.add(abs);
    const source = fs.readFileSync(abs, "utf8");
    // Anchored at a line start so prose inside a comment cannot look like an
    // import; the brace alternative lets a multi-line named list match.
    const statement = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:\{[^}]*\}|[^;\n{]*?)[ \t]*from[ \t]*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = statement.exec(source))) {
      if (match[1]) continue;
      const specifier = match[2];
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
        continue;
      }
      visit(path.resolve(path.dirname(abs), specifier));
    }
  };
  visit(entry);
  return { modules, externals };
}

/**
 * The narrow v1 subpaths exist so a consumer that only needs types, the event
 * contract, a retry policy or the progress renderer does not have to load the
 * extension entry point — which drags in the TUI overlays, `cross-spawn` and
 * the whole dispatch runtime. Only `./v1/extension` (and the `./v1` barrel that
 * re-exports it) may reach it.
 */
const LEAF_SUBPATHS = [
  "types.ts",
  "events.ts",
  "retry.ts",
  "session-history.ts",
  "progress-tree.ts",
  "agents.ts",
  "model-routing.ts",
  "observation.ts",
  "remote.ts",
  "child-extensions.ts",
  "scheduler.ts",
  "sessions.ts",
  "workspace-projections.ts",
];

test("narrow v1 subpaths never load the extension entry point", () => {
  const extensionEntry = path.resolve(SRC_DIR, "extension/index.ts");

  // Positive control: without it a graph walker that silently stopped resolving
  // would let every assertion below pass while proving nothing.
  assert.ok(
    runtimeGraph(path.join(PUBLIC_DIR, "extension.ts")).modules.has(extensionEntry),
    "the graph walker must be able to see src/extension/index.ts at all",
  );

  for (const subpath of LEAF_SUBPATHS) {
    const { modules } = runtimeGraph(path.join(PUBLIC_DIR, subpath));
    assert.equal(
      modules.has(extensionEntry),
      false,
      `pi-maestro-teammate/v1/${subpath.replace(/\.ts$/, "")} must not pull src/extension/index.ts into a consumer's module graph`,
    );
  }
});

test("the v1 event contract depends only on dependency-free contract modules", () => {
  const { modules, externals } = runtimeGraph(path.join(PUBLIC_DIR, "events.ts"));
  assert.deepEqual([...externals], [], "the event contract must have no external runtime dependency");
  assert.deepEqual(
    [...modules].map((file) => path.relative(SRC_DIR, file).replaceAll(path.sep, "/")).sort(),
    ["public/v1/events.ts", "sessions/session-core.ts", "shared/types.ts"],
  );
});

test("the v1 scheduler is dependency-free", () => {
  const { modules, externals } = runtimeGraph(path.join(PUBLIC_DIR, "scheduler.ts"));
  assert.deepEqual([...externals], []);
  assert.deepEqual(
    [...modules].map((file) => path.relative(SRC_DIR, file).replaceAll(path.sep, "/")).sort(),
    ["public/v1/scheduler.ts", "scheduler/scheduler-core.ts"],
  );
});

test("the v1 sessions API is dependency-free", () => {
  const { modules, externals } = runtimeGraph(path.join(PUBLIC_DIR, "sessions.ts"));
  assert.deepEqual([...externals], []);
  assert.deepEqual(
    [...modules].map((file) => path.relative(SRC_DIR, file).replaceAll(path.sep, "/")).sort(),
    ["public/v1/sessions.ts", "sessions/session-core.ts", "shared/types.ts"],
  );
});

test("every v1 module is reachable through a declared package export", () => {
  const packageJson: {
    exports?: Record<string, string | { default?: string }>;
  } = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  const declared = new Set(
    Object.values(packageJson.exports ?? {}).flatMap((entry) => {
      const runtimeTarget = typeof entry === "string" ? entry : entry.default;
      return runtimeTarget === undefined ? [] : [runtimeTarget];
    }),
  );
  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    if (!file.endsWith(".ts")) continue;
    assert.ok(
      declared.has(`./src/public/v1/${file}`),
      `src/public/v1/${file} has no "exports" entry in package.json, so consumers cannot import it`,
    );
  }
});

test("the Phase2 runtime broker facade has a stable package export and bounded runtime graph", () => {
  const packageJson: {
    exports?: Record<string, string | { types?: string; default?: string }>;
  } = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  assert.deepEqual(packageJson.exports?.["./v2/runtime-broker"], {
    types: "./types/public/v2/runtime-broker.d.ts",
    default: "./src/public/v2/runtime-broker.ts",
  });

  const { modules, externals } = runtimeGraph(path.join(PUBLIC_V2_DIR, "runtime-broker.ts"));
  assert.deepEqual([...externals].filter((specifier) => !specifier.startsWith("node:")), []);
  assert.equal(modules.has(path.resolve(SRC_DIR, "extension/index.ts")), false);
  assert.equal(modules.has(path.resolve(SRC_DIR, "runtime-broker/server.ts")), false);
  assert.equal(modules.has(path.resolve(SRC_DIR, "runtime-broker/sqlite-store.ts")), false);
});

test("v1 event names match the strings the extension actually emits", async () => {
  const provenance: TeammateExecutionProvenance = {
    registryVersion: 2,
    registryRevision: 1,
    registryHash: "hash",
    modelRegistrationId: "registry/general",
    modelId: "intrinsic/general",
    deploymentId: "local-pi",
    harness: "pi",
    transport: { kind: "local-process", protocol: "pi-rpc" },
  };
  const publishedContract: TeammateResultPublishedEvent = {
    result: {
      correlationId: "contract",
      originCwd: process.cwd(),
      agent: "general",
      output: "done",
      provenance,
    },
    waitUntil() {},
  };
  assert.equal(publishedContract.result.correlationId, "contract");
  assert.deepEqual(publishedContract.result.provenance, provenance);

  const events = await import("../src/public/v1/events.ts");
  const emitter = fs.readFileSync(path.join(SRC_DIR, "shared/types.ts"), "utf8");
  const expected: Record<string, string> = {
    TEAMMATE_STARTED_EVENT: "teammate:started",
    TEAMMATE_MESSAGE_EVENT: "teammate:message",
    TEAMMATE_RESULT_PUBLISHED_EVENT: "teammate:result-published",
    TEAMMATE_COMPLETE_EVENT: "teammate:complete",
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(
      (events as Record<string, unknown>)[name],
      value,
      `${name} is part of the cross-extension contract; changing it breaks pi-cockpit`,
    );
    assert.match(emitter, new RegExp(`export const ${name} = "${value}";`));
  }
});

test("the v1 barrel re-exports every v1 module", () => {
  const barrel = fs.readFileSync(path.join(PUBLIC_DIR, "index.ts"), "utf8");
  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    if (!file.endsWith(".ts") || file === "index.ts") continue;
    assert.match(
      barrel,
      new RegExp(`export \\* from "\\./${file.replace(".", "\\.")}";`),
      `src/public/v1/index.ts must re-export ./${file} — the barrel is the package root's public API`,
    );
  }
});

test("child IPC preserves model and thinking defaults before shared normalization", () => {
  const parsed = parseProxyTeammateParams({
    agent: "general",
    model: "provider/default",
    thinking: "low",
    tasks: [
      { prompt: "default", description: "first task" },
      { agent: "analyst", prompt: "override", model: "provider/task", thinking: "max", background: true },
    ],
    background: false,
    outputSchema: { type: "object" },
  });
  assert.ok(parsed);
  assert.equal(parsed.model, "provider/default");
  assert.equal(parsed.thinking, "low");
  assert.equal(parsed.tasks[0].description, "first task");
  assert.equal(parsed.tasks[1].background, true);
  assert.equal(parsed.tasks[1]?.model, "provider/task");
  assert.equal(parsed.tasks[1]?.thinking, "max");

  const normalized = normalizeTeammateParams(parsed);
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.tasks[0].model, "provider/default");
  assert.equal(normalized.tasks[0].thinking, "low");
  assert.equal(normalized.tasks[1].model, "provider/task");
  assert.equal(normalized.tasks[1].thinking, "max");
  assert.deepEqual(normalized.tasks[0].outputSchema, { type: "object" });

  assert.ok(parseProxyTeammateParams({ tasks: [{ agent: "general", prompt: "inspect", taskType: "security-audit" }] }));
  assert.equal(parseProxyTeammateParams({ tasks: [{ agent: "general", prompt: "inspect", taskType: "Bad Type!" }] }), undefined);
  assert.equal(parseProxyTeammateParams({ agent: "general", task: "inspect", taskType: "invalid" }), undefined);
  assert.equal(parseProxyTeammateParams({ tasks: [{ agent: 42, prompt: "inspect" }] }), undefined);
});

test("child IPC rejects a missing task-level prompt at admission", () => {
  assert.equal(parseProxyTeammateParams({
    tasks: [{ name: "audit", outputSchema: { type: "object", prompt: "PURPOSE: mislocated" } }],
  }), undefined);

  // A stray duplicate (task-level prompt present) is still salvageable because
  // the dispatch intent is unambiguous and no task text is missing.
  const parsedDup = parseProxyTeammateParams({
    tasks: [{ prompt: "work", outputSchema: { type: "object", properties: { summary: { type: "string" } }, prompt: "PURPOSE: stray" } }],
  });
  assert.ok(parsedDup);
  const dup = normalizeTeammateParams(parsedDup);
  assert.equal(dup.error, undefined);
  assert.ok(dup.warnings.some((w) => /removed a task-text "prompt" key/.test(w)), dup.warnings.join(" | "));
  assert.deepEqual(dup.tasks[0].outputSchema, { type: "object", properties: { summary: { type: "string" } } });
});

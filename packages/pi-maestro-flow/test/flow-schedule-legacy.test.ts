import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCoordinatorFlowScheduleTool } from "../src/flow-schedule/tool.ts";
import { FlowScheduleRuntime } from "../src/flow-schedule/runtime.ts";
import { FlowScheduleStore } from "../src/flow-schedule/store.ts";

async function snapshotTree(root: string): Promise<Array<{ path: string; kind: string; bytes?: string }>> {
  const rows: Array<{ path: string; kind: string; bytes?: string }> = [];
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push({ path: relative, kind: "directory" });
        await visit(path, relative);
      } else if (entry.isFile()) {
        rows.push({ path: relative, kind: "file", bytes: (await readFile(path)).toString("base64") });
      } else if (entry.isSymbolicLink()) {
        rows.push({ path: relative, kind: "symlink" });
      } else {
        rows.push({ path: relative, kind: "other" });
      }
    }
  };
  await visit(root);
  return rows;
}

test("legacy flow-track data remains byte-for-byte unchanged through list and runtime reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flow-schedule-legacy-"));
  const projectRoot = join(root, "workspace");
  const legacyRoot = join(projectRoot, ".pi", "flow-track");
  await mkdir(join(legacyRoot, "nested"), { recursive: true });
  await writeFile(join(legacyRoot, "record.json"), Buffer.from([0, 1, 2, 255, 10]));
  await writeFile(join(legacyRoot, "nested", "state.txt"), "legacy-state\r\n", "utf8");
  const before = await snapshotTree(legacyRoot);
  const store = new FlowScheduleStore(projectRoot, { getProcessIdentity: () => `test:${process.pid}` });
  const runtime = new FlowScheduleRuntime({
    store,
    getRegistry: () => undefined,
    observe: async () => ({ action: "status", reason: "snapshot", observations: [], durationMs: 0 }),
  });
  const tool = createCoordinatorFlowScheduleTool({ resolve: () => ({ store, runtime }), getRegistry: () => undefined });
  try {
    const listed = await tool.execute("legacy-list", { action: "list" }, undefined, undefined, { cwd: projectRoot } as never);
    assert.equal(listed.isError, undefined);
    assert.equal(listed.details?.legacy?.present, true);
    assert.equal(listed.details?.legacy?.kind, "directory");
    assert.match((listed.content[0] as { text: string }).text, /read-only/);
    await runtime.reconcileReady();
    assert.deepEqual(await snapshotTree(legacyRoot), before);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("flow-schedule source contains no PR #19 cursor, edge, wall-clock attribution, or sandbox-hook machinery", async () => {
  const sourceRoot = new URL("../src/flow-schedule/", import.meta.url);
  const names = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts")).sort();
  const sources = await Promise.all(names.map(async (name) => [name, await readFile(new URL(name, sourceRoot), "utf8")] as const));
  const combined = sources.map(([name, source]) => `// ${name}\n${source}`).join("\n");

  for (const forbidden of [
    /\bafterCursor\b/,
    /flow-track-edge/,
    /edge-ledger/,
    /edge-reader/,
    /settled-recorder/,
    /recordedAt\s*>\s*dispatchedAt/,
    /sandbox-preflight/,
    /\.pi\/hooks\.json/,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
  assert.doesNotMatch(combined, /(?:rm|unlink|rename|writeFile|mkdir)\([^\n]*legacyPath/);

  const trackPath = new URL("../src/track", import.meta.url);
  await assert.rejects(lstat(trackPath), /ENOENT/);
});

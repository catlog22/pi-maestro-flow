import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

const { persistStructuredResults } = await import("../src/teammate/agent-output-capture.ts");
const { readAgentOutput } = await import("../src/teammate/agent-output-store.ts");

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-agent-capture-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("persistStructuredResults uses each result origin cwd across overlapping workspaces", async () => {
  const other = await mkdtemp(join(tmpdir(), "pi-agent-origin-"));
  try {
    await Promise.all([
      persistStructuredResults([{
        correlationId: "origin-a",
        originCwd: root,
        name: "origin-task-a",
        structuredOutput: { workspace: "a" },
      }], undefined, other),
      persistStructuredResults([{
        correlationId: "origin-b",
        originCwd: other,
        name: "origin-task-b",
        structuredOutput: { workspace: "b" },
      }], undefined, root),
    ]);
    assert.deepEqual((await readAgentOutput("origin-task-a", root)).output, { workspace: "a" });
    assert.deepEqual((await readAgentOutput("origin-task-b", other)).output, { workspace: "b" });
    await assert.rejects(() => readAgentOutput("origin-task-a", other));
    await assert.rejects(() => readAgentOutput("origin-task-b", root));
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test("persistStructuredResults keeps the latest turn for a repeated correlation id", async () => {
  await Promise.all([
    persistStructuredResults([{
      correlationId: "repeat-cid",
      name: "repeat-task",
      structuredOutput: { turn: 1 },
    }], undefined, root),
    persistStructuredResults([{
      correlationId: "repeat-cid",
      name: "repeat-task",
      structuredOutput: { turn: 2 },
    }], undefined, root),
  ]);
  assert.deepEqual((await readAgentOutput("repeat-cid", root)).output, { turn: 2 });
});

test("persistStructuredResults preserves schema-valid null", async () => {
  await persistStructuredResults([{
    correlationId: "null-cid",
    name: "null-task",
    structuredOutput: null,
  }], undefined, root);
  assert.equal((await readAgentOutput("null-task", root)).output, null);
});

test("persistStructuredResults persists results carrying a task name", async () => {
  await persistStructuredResults(
    [{ correlationId: "capture-cid-1", name: "capture-task", agent: "explorer", structuredOutput: { ok: true } }],
    undefined,
    root,
  );
  const record = await readAgentOutput("capture-cid-1", root);
  assert.equal(record.name, "capture-task");
  assert.deepEqual(record.output, { ok: true });
  const byName = await readAgentOutput("capture-task", root);
  assert.equal(byName.correlationId, "capture-cid-1");
});

test("persistStructuredResults backfills graph task names from progress", async () => {
  // The graph SingleResult lacks name; the progress snapshot carries it.
  await persistStructuredResults(
    [{ correlationId: "capture-cid-2", agent: "general", structuredOutput: { v: 1 } }],
    [{ correlationId: "capture-cid-2", name: "graph-node", agent: "general", status: "completed", taskIndex: 0, dependencies: [] }],
    root,
  );
  const record = await readAgentOutput("capture-cid-2", root);
  assert.equal(record.name, "graph-node");
  assert.deepEqual(record.output, { v: 1 });
  const byName = await readAgentOutput("graph-node", root);
  assert.equal(byName.correlationId, "capture-cid-2");
});

test("persistStructuredResults skips entries without any output or correlation id", async () => {
  await persistStructuredResults(
    [
      { correlationId: "capture-cid-3", name: "plain", agent: "general" },
      { name: "no-cid", structuredOutput: { x: 1 } },
      null,
      "not-an-object",
    ],
    undefined,
    root,
  );
  await assert.rejects(
    () => readAgentOutput("capture-cid-3", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );
});

test("persistStructuredResults persists the final answer text for tasks without outputSchema", async () => {
  await persistStructuredResults(
    [{ correlationId: "text-cid-1", name: "text-task", agent: "general", output: "Found 3 issues in src/" }],
    undefined,
    root,
  );
  const record = await readAgentOutput("text-cid-1", root);
  assert.equal(record.output, "Found 3 issues in src/");
  const byName = await readAgentOutput("text-task", root);
  assert.equal(byName.correlationId, "text-cid-1");
});

test("persistStructuredResults falls back to the last assistant message of the foreground transcript", async () => {
  await persistStructuredResults(
    [{
      correlationId: "text-cid-2",
      name: "plain-run",
      messages: [
        { role: "system", content: "begin" },
        { role: "assistant", content: "  Done.  " },
      ],
    }],
    undefined,
    root,
  );
  assert.equal((await readAgentOutput("text-cid-2", root)).output, "Done.");
});

test("persistStructuredResults prefers structuredOutput and skips whitespace-only text", async () => {
  await persistStructuredResults(
    [{
      correlationId: "text-cid-3",
      output: "fallback text",
      messages: [{ role: "assistant", content: "fallback from messages" }],
      structuredOutput: { ok: true },
    }],
    undefined,
    root,
  );
  assert.deepEqual((await readAgentOutput("text-cid-3", root)).output, { ok: true });

  await persistStructuredResults(
    [{ correlationId: "text-cid-4", output: "   " }],
    undefined,
    root,
  );
  await assert.rejects(
    () => readAgentOutput("text-cid-4", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );
});

test("persistStructuredResults writes a private record readable by correlationId", async () => {
  await persistStructuredResults(
    [{ correlationId: "capture-cid-4", structuredOutput: { deep: { list: [1, 2, 3] } } }],
    undefined,
    root,
  );
  const raw = await readFile(join(root, ".pi", "agents", "capture-cid-4.json"), "utf8");
  assert.match(raw, /"output":/);
  const record = await readAgentOutput("capture-cid-4", root);
  assert.deepEqual(record.output, { deep: { list: [1, 2, 3] } });
});

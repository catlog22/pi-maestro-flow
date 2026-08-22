import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  getCompletionDurabilityRegistry,
  type CompletionDurabilityProvider,
} from "pi-maestro-teammate/v1";

const {
  capturePublishedAgentResult,
  filterUnacknowledgedResults,
  persistStructuredResults,
} = await import("../src/teammate/agent-output-capture.ts");
const {
  MAX_AGENT_FILES,
  getAgentOutputStoreUsage,
  persistAgentOutputChecked,
  readAgentOutput,
} = await import("../src/teammate/agent-output-store.ts");
const {
  displayMessageForResult,
  emitTeammateResultPublished,
} = await import("../../pi-maestro-teammate/src/extension/teammate-core.ts");

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

test("persistStructuredResults keeps immutable publications and a latest correlation alias", async () => {
  await Promise.all([
    persistStructuredResults([{
      correlationId: "repeat-cid",
      publicationId: "repeat-publication-1",
      name: "repeat-task",
      structuredOutput: { turn: 1 },
    }], undefined, root),
    persistStructuredResults([{
      correlationId: "repeat-cid",
      publicationId: "repeat-publication-2",
      name: "repeat-task",
      structuredOutput: { turn: 2 },
    }], undefined, root),
  ]);
  assert.deepEqual((await readAgentOutput("repeat-publication-1", root)).output, { turn: 1 });
  assert.deepEqual((await readAgentOutput("repeat-publication-2", root)).output, { turn: 2 });
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

test("persistStructuredResults writes a record readable by correlationId", async () => {
  await persistStructuredResults(
    [{ correlationId: "capture-cid-4", structuredOutput: { deep: { list: [1, 2, 3] } } }],
    undefined,
    root,
  );
  const record = await readAgentOutput("capture-cid-4", root);
  assert.deepEqual(record.output, { deep: { list: [1, 2, 3] } });
});

test("capturePublishedAgentResult acknowledges persistence before release", async () => {
  let persistence: Promise<unknown> | undefined;
  let acknowledged: string | undefined;
  let resource: string | undefined;
  const claimed = capturePublishedAgentResult({
    result: {
      correlationId: "published-cid-1",
      publicationId: "publication-1",
      originCwd: root,
      name: "published-node",
      agent: "general",
      structuredOutput: { ready: true },
    },
    waitUntil(promise: Promise<unknown>) {
      persistence = promise;
    },
    acknowledgeResource(uri: string) {
      resource = uri;
    },
  }, (publicationId) => {
    acknowledged = publicationId;
  });

  assert.equal(claimed, true);
  assert.ok(persistence);
  await persistence;
  assert.equal(acknowledged, "publication-1");
  assert.equal(resource, "agent://published-cid-1");
  assert.deepEqual((await readAgentOutput("publication-1", root)).output, { ready: true });
  assert.deepEqual((await readAgentOutput("published-cid-1", root)).output, { ready: true });
});

test("compatibility capture excludes only the acknowledged publication instance", () => {
  const results = [
    { correlationId: "shared-cid", publicationId: "publication-1", output: "primary" },
    { correlationId: "shared-cid", publicationId: "publication-2", output: "warm turn" },
    { correlationId: "legacy-cid", output: "fallback" },
  ];
  assert.deepEqual(
    filterUnacknowledgedResults(results, new Set(["publication-1"])),
    [results[1], results[2]],
  );
});

test("capturePublishedAgentResult rejects an unpersistable publication", async () => {
  let persistence: Promise<unknown> | undefined;
  let resource: string | undefined;
  assert.equal(capturePublishedAgentResult({
    result: {
      correlationId: "published-cid-oversized",
      publicationId: "publication-oversized",
      originCwd: root,
      agent: "general",
      structuredOutput: { data: "x".repeat(600_000) },
    },
    waitUntil(promise: Promise<unknown>) {
      persistence = promise;
    },
    acknowledgeResource(uri: string) {
      resource = uri;
    },
  }), true);

  assert.ok(persistence);
  await assert.rejects(persistence, /persistence was not acknowledged/);
  assert.equal(resource, undefined);
  await assert.rejects(() => readAgentOutput("published-cid-oversized", root));
});

test("capturePublishedAgentResult stores an overflow publication by rolling out the oldest record", async () => {
  const workspace = join(root, "capture-capacity-workspace");
  for (let index = 0; index < MAX_AGENT_FILES; index += 1) {
    assert.equal(
      await persistAgentOutputChecked(
        "capacity-filler",
        "capacity-filler",
        "general",
        { index },
        workspace,
        `capture-capacity-${index}`,
      ),
      "stored",
    );
  }

  let persistence: Promise<unknown> | undefined;
  let resource: string | undefined;
  let storedPublication: string | undefined;
  assert.equal(capturePublishedAgentResult({
    result: {
      correlationId: "capacity-overflow-cid",
      publicationId: "capacity-overflow-publication",
      originCwd: workspace,
      agent: "general",
      structuredOutput: { overflow: true },
    },
    waitUntil(promise: Promise<unknown>) {
      persistence = promise;
    },
    acknowledgeResource(uri: string) {
      resource = uri;
    },
  }, (publicationId: string) => {
    storedPublication = publicationId;
  }), true);

  assert.ok(persistence);
  await persistence;
  assert.equal(storedPublication, "capacity-overflow-publication", "overflow publication is stored");
  assert.equal(resource, "agent://capacity-overflow-cid", "the stored resource is acknowledged");
  assert.deepEqual((await readAgentOutput("capacity-overflow-publication", workspace)).output, { overflow: true });
  await assert.rejects(() => readAgentOutput("capture-capacity-0", workspace), /No persisted teammate output/);
  assert.equal((await getAgentOutputStoreUsage(workspace)).records, MAX_AGENT_FILES);
});

test("published large result is summarized only after its canonical resource is readable", async () => {
  const output = "x".repeat(2_000);
  const result = {
    agent: "general",
    name: "integration-result",
    task: "produce a large result",
    exitCode: 0,
    messages: [{ role: "assistant", content: output }],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      turns: 1,
    },
    model: "test/model",
    correlationId: "integration-correlation",
    publicationId: "integration-publication",
    durationMs: 1,
  } as Parameters<typeof displayMessageForResult>[0];
  const pi = {
    events: {
      emit(_name: string, event: unknown) {
        assert.equal(capturePublishedAgentResult(event), true);
      },
    },
  };

  await emitTeammateResultPublished(pi as never, result, root);
  const displayed = displayMessageForResult(result);
  assert.equal(displayed.includes(output), false);
  assert.match(displayed, /Full result: agent:\/\/integration-correlation$/);
  assert.equal((await readAgentOutput("integration-publication", root)).output, output);
  assert.equal((await readAgentOutput("integration-correlation", root)).output, output);
});

function durabilityProvider(overrides: Partial<CompletionDurabilityProvider>): CompletionDurabilityProvider {
  return {
    async beginDispatch(seed) {
      return { dispatchId: seed.dispatchId, reservationId: seed.reservationId, deliveryGroupId: seed.deliveryGroupId };
    },
    async requireNotification() {},
    async stagePublication() {},
    async commitPublication() {},
    async finalizeDelivery() { throw new Error("unused"); },
    async listRecoverable() { return []; },
    async acknowledgeApplied() {},
    async abandonDispatch() {},
    async prune() {},
    ...overrides,
  };
}

test("published capture stages before persistence and commits only after immutable readability", async () => {
  const publicationId = "capture-order-publication";
  const correlationId = "capture-order-correlation";
  const order: string[] = [];
  const registry = getCompletionDurabilityRegistry();
  const dispose = registry.register(durabilityProvider({
    async stagePublication(input) {
      order.push("stage");
      assert.equal(input.resource.publicationId, publicationId);
      await assert.rejects(() => readAgentOutput(publicationId, root), /No persisted teammate output/);
    },
    async commitPublication(input) {
      order.push("commit");
      assert.equal(input.publicationId, publicationId);
      assert.deepEqual((await readAgentOutput(publicationId, root)).output, { durable: true });
    },
  }));
  let persistence: Promise<unknown> | undefined;
  try {
    assert.equal(capturePublishedAgentResult({
      result: {
        correlationId,
        publicationId,
        originCwd: root,
        name: "capture-order",
        agent: "general",
        structuredOutput: { durable: true },
        completionDispatchId: "dispatch-order",
        completionReservationId: "reservation-order",
        completionOutcome: "completed",
      },
      waitUntil(promise: Promise<unknown>) { persistence = promise; },
    }), true);
    assert.ok(persistence);
    await persistence;
    assert.deepEqual(order, ["stage", "commit"]);
  } finally { dispose(); }
});

test("stage failure prevents immutable result persistence and acknowledgement", async () => {
  const publicationId = "capture-stage-failure-publication";
  const registry = getCompletionDurabilityRegistry();
  const dispose = registry.register(durabilityProvider({
    async stagePublication() { throw new Error("injected stage failure"); },
  }));
  let persistence: Promise<unknown> | undefined;
  let acknowledged = false;
  try {
    capturePublishedAgentResult({
      result: {
        correlationId: "capture-stage-failure-correlation",
        publicationId,
        originCwd: root,
        agent: "general",
        output: "must not persist",
        completionDispatchId: "dispatch-stage-failure",
        completionReservationId: "reservation-stage-failure",
      },
      waitUntil(promise: Promise<unknown>) { persistence = promise; },
      acknowledgeResource() { acknowledged = true; },
    });
    assert.ok(persistence);
    await assert.rejects(persistence, /injected stage failure/);
    await assert.rejects(() => readAgentOutput(publicationId, root), /No persisted teammate output/);
    assert.equal(acknowledged, false);
  } finally { dispose(); }
});

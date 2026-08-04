import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

const {
  persistAgentOutput,
  readAgentOutput,
  getAgentOutputPath,
} = await import("../src/teammate/agent-output-store.ts");

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-agent-output-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("persistAgentOutput writes a private record readable by correlationId", async () => {
  await persistAgentOutput("run-abc-1", "explorer", "explorer", { findings: [{ path: "src/a.ts" }] }, root);
  const record = await readAgentOutput("run-abc-1", root);
  assert.equal(record.correlationId, "run-abc-1");
  assert.equal(record.name, "explorer");
  assert.deepEqual(record.output, { findings: [{ path: "src/a.ts" }] });

  const raw = await readFile(join(root, ".pi", "agents", "run-abc-1.json"), "utf8");
  assert.match(raw, /"output":/);
});

test("readAgentOutput resolves by task name", async () => {
  await persistAgentOutput("run-abc-2", "reviewer", "analyst", { findings: [{ path: "src/b.ts", severity: "high" }] }, root);
  const record = await readAgentOutput("reviewer", root);
  assert.equal(record.correlationId, "run-abc-2");
});

test("readAgentOutput with duplicate names picks the latest capture", async () => {
  // 同名历史任务：写入两个不同 correlationId 的记录，读取应返回较新（按 capturedAt，平手按 correlationId 降序）
  await persistAgentOutput("dup-a1", "shared", "explorer", { v: 1 }, root);
  await persistAgentOutput("dup-b2", "shared", "explorer", { v: 2 }, root);
  const record = await readAgentOutput("shared", root);
  assert.equal(record.correlationId, "dup-b2");
  assert.deepEqual(record.output, { v: 2 });
});

test("readAgentOutput with unknown id lists available agents", async () => {
  await assert.rejects(
    () => readAgentOutput("nope", root),
    (err: unknown) => err instanceof Error
      && err.message.includes('No persisted teammate output for "nope"')
      && err.message.includes("run-abc-1"),
  );
});

test("getAgentOutputPath traverses objects and arrays", () => {
  const output = { findings: [{ path: "src/a.ts", fix: { strategy: "minimal" } }], count: 1 };
  const hit = getAgentOutputPath(output, ["findings", "0", "fix", "strategy"]);
  assert.ok(hit.hit);
  assert.equal(hit.value, "minimal");
  assert.equal(getAgentOutputPath(output, ["count"]).value, 1);
  assert.ok(getAgentOutputPath(output, []).hit);
});

test("getAgentOutputPath reports precise path misses", () => {
  const output = { findings: [{ path: "a.ts" }] };
  const missingKey = getAgentOutputPath(output, ["findings", "0", "nope"]);
  assert.ok(!missingKey.hit && missingKey.reason.includes('key "nope" not found'));
  const badIndex = getAgentOutputPath(output, ["findings", "5", "path"]);
  assert.ok(!badIndex.hit && badIndex.reason.includes("out of bounds"));
  const nonIndex = getAgentOutputPath(output, ["findings", "path", "x"]);
  assert.ok(!nonIndex.hit && nonIndex.reason.includes("not a numeric index"));
  const descendScalar = getAgentOutputPath(output, ["findings", "0", "path", "x"]);
  assert.ok(!descendScalar.hit && descendScalar.reason.includes("descend"));
});

test("getAgentOutputPath guards prototype pollution", () => {
  const output = { safe: { v: 2 } };
  const toStringHit = getAgentOutputPath(output, ["toString"]);
  assert.ok(!toStringHit.hit, "prototype methods are not exposed");
  const protoHit = getAgentOutputPath(output, ["__proto__", "polluted"]);
  assert.ok(!protoHit.hit, "__proto__ prototype access is blocked");
  const constructorHit = getAgentOutputPath(output, ["constructor", "x"]);
  assert.ok(!constructorHit.hit, "constructor prototype access is blocked");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype stays clean");
});

test("persistAgentOutput skips non-serializable or oversized outputs", async () => {
  await persistAgentOutput("run-abc-3", "big", undefined, { data: "x".repeat(600_000) }, root);
  await assert.rejects(
    () => readAgentOutput("run-abc-3", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await persistAgentOutput("run-abc-4", "cyclic", undefined, cyclic, root);
  await assert.rejects(
    () => readAgentOutput("run-abc-4", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );
});

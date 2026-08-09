import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

const {
  persistAgentOutput,
  persistAgentOutputChecked,
  readAgentOutput,
  getAgentOutputPath,
} = await import("../src/teammate/agent-output-store.ts");

/** 注入的全局输出根（PI_AGENT_OUTPUT_ROOT）下的分桶目录。 */
function outRoot(): string {
  return join(root, "out");
}

/** 读取注入根下唯一的分桶目录（workspaceBucketName 未导出，测试通过扫描定位）。 */
async function bucketDir(): Promise<string> {
  const entries = await readdir(outRoot());
  assert.equal(entries.length, 1, "exactly one workspace bucket expected");
  return join(outRoot(), entries[0]!);
}

let root: string;
let previousRoot: string | undefined;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-agent-output-"));
  previousRoot = process.env.PI_AGENT_OUTPUT_ROOT;
  process.env.PI_AGENT_OUTPUT_ROOT = outRoot();
});

after(async () => {
  if (previousRoot === undefined) delete process.env.PI_AGENT_OUTPUT_ROOT;
  else process.env.PI_AGENT_OUTPUT_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

test("persistAgentOutput writes a private record in the global bucket readable by correlationId", async () => {
  await persistAgentOutput("run-abc-1", "explorer", "explorer", { findings: [{ path: "src/a.ts" }] }, root);
  const record = await readAgentOutput("run-abc-1", root);
  assert.equal(record.correlationId, "run-abc-1");
  assert.equal(record.name, "explorer");
  assert.deepEqual(record.output, { findings: [{ path: "src/a.ts" }] });

  const bucket = await bucketDir();
  const raw = await readFile(join(bucket, "run-abc-1.json"), "utf8");
  assert.match(raw, /"output":/);
  if (process.platform !== "win32") {
    assert.equal((await stat(bucket)).mode & 0o777, 0o700);
    assert.equal((await stat(join(bucket, "run-abc-1.json"))).mode & 0o777, 0o600);
  }
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

test("workspace buckets isolate same-named tasks across workspaces", async () => {
  const other = join(root, "other-workspace");
  await persistAgentOutput("iso-1", "shared-name", "explorer", { workspace: "a" }, root);
  await persistAgentOutput("iso-2", "shared-name", "explorer", { workspace: "b" }, other);
  assert.deepEqual((await readAgentOutput("shared-name", root)).output, { workspace: "a" });
  assert.deepEqual((await readAgentOutput("shared-name", other)).output, { workspace: "b" });
  // 分桶完全隔离：跨工作区精确 correlationId 也不可见
  await assert.rejects(
    () => readAgentOutput("iso-2", root),
    (err: unknown) => err instanceof Error && err.message.includes('No persisted teammate output for "iso-2"'),
  );
  assert.equal((await readAgentOutput("iso-2", other)).correlationId, "iso-2");
});

test("readAgentOutput falls back to legacy <cwd>/.pi/agents records", async () => {
  const legacyDir = join(root, ".pi", "agents");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(join(legacyDir, "legacy-1.json"), JSON.stringify({
    correlationId: "legacy-1",
    name: "legacy-task",
    capturedAt: "2026-01-01T00:00:00.000Z",
    output: { legacy: true },
  }), "utf8");
  const record = await readAgentOutput("legacy-1", root);
  assert.deepEqual(record.output, { legacy: true });
  assert.equal((await readAgentOutput("legacy-task", root)).correlationId, "legacy-1");
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

test("persistAgentOutput replaces a repeated correlation id with the latest turn", async () => {
  await persistAgentOutput("repeat-agent", "repeat", "general", { turn: 1 }, root);
  await persistAgentOutput("repeat-agent", "repeat", "general", { turn: 2 }, root);
  assert.deepEqual((await readAgentOutput("repeat-agent", root)).output, { turn: 2 });
});

test("persistAgentOutput rejects a linked global output root", async (t) => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "pi-out-linked-"));
  const external = await mkdtemp(join(tmpdir(), "pi-out-external-"));
  const saved = process.env.PI_AGENT_OUTPUT_ROOT;
  try {
    const fakeRoot = join(linkedRoot, "out");
    await mkdir(fakeRoot, { recursive: true });
    await rm(fakeRoot, { recursive: true, force: true });
    try {
      await symlink(external, fakeRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32") {
        t.skip(`junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
    process.env.PI_AGENT_OUTPUT_ROOT = fakeRoot;
    await assert.rejects(
      () => persistAgentOutput("linked-agent", "linked", "general", { secret: true }, root),
      /must be a real directory/,
    );
    assert.deepEqual(await readdir(external), []);
  } finally {
    if (saved === undefined) delete process.env.PI_AGENT_OUTPUT_ROOT;
    else process.env.PI_AGENT_OUTPUT_ROOT = saved;
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("readAgentOutput rejects a legacy .pi/agents symlink directory", async (t) => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "pi-agent-linked-"));
  const external = await mkdtemp(join(tmpdir(), "pi-agent-external-"));
  try {
    await mkdir(join(linkedRoot, ".pi"), { recursive: true });
    try {
      await symlink(external, join(linkedRoot, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32") {
        t.skip(`junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readAgentOutput("linked-agent", linkedRoot),
      /must be a real directory/,
    );
    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("readAgentOutput rejects a linked legacy .pi directory", async (t) => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "pi-root-linked-"));
  const external = await mkdtemp(join(tmpdir(), "pi-root-external-"));
  try {
    try {
      await symlink(external, join(linkedRoot, ".pi"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32") {
        t.skip(`junction creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readAgentOutput("linked-pi", linkedRoot),
      /must be a real directory/,
    );
    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("readAgentOutput does not follow a linked record file", async (t) => {
  const linkedRoot = await mkdtemp(join(tmpdir(), "pi-record-linked-"));
  const external = join(await mkdtemp(join(tmpdir(), "pi-record-external-")), "outside.json");
  try {
    await persistAgentOutput("linked-record", "linked-record", "general", { safe: true }, linkedRoot);
    let bucket = "";
    for (const entry of await readdir(outRoot())) {
      try {
        await stat(join(outRoot(), entry, "linked-record.json"));
        bucket = join(outRoot(), entry);
        break;
      } catch {
        // not this bucket
      }
    }
    assert.ok(bucket, "record must exist in a workspace bucket");
    const recordPath = join(bucket, "linked-record.json");
    await unlink(recordPath);
    await writeFile(external, JSON.stringify({
      correlationId: "linked-record",
      name: "linked-record",
      capturedAt: new Date().toISOString(),
      output: { leaked: true },
    }));
    try {
      await symlink(external, recordPath, "file");
    } catch (error) {
      if (process.platform === "win32") {
        t.skip(`file symlink creation unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readAgentOutput("linked-record", linkedRoot),
      /No persisted teammate output/,
    );
  } finally {
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(resolve(external, ".."), { recursive: true, force: true });
  }
});

test("persistAgentOutput skips non-serializable or oversized outputs", async () => {
  assert.equal(
    await persistAgentOutputChecked("run-abc-3", "big", undefined, { data: "x".repeat(600_000) }, root),
    false,
  );
  await assert.rejects(
    () => readAgentOutput("run-abc-3", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(
    await persistAgentOutputChecked("run-abc-4", "cyclic", undefined, cyclic, root),
    false,
  );
  await assert.rejects(
    () => readAgentOutput("run-abc-4", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );
});

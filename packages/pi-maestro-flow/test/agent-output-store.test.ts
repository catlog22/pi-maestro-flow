import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

const {
  MAX_AGENT_FILES,
  persistAgentOutput,
  persistAgentOutputChecked,
  getAgentOutputStoreUsage,
  deleteAgentOutput,
  readAgentOutput,
  resolveAgentOutput,
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

/** Locate the workspace bucket containing a known record file. */
async function bucketContaining(fileName: string): Promise<string> {
  for (const entry of await readdir(outRoot())) {
    const bucket = join(outRoot(), entry);
    try {
      await stat(join(bucket, fileName));
      return bucket;
    } catch {
      // continue
    }
  }
  throw new Error(`No output bucket contains ${fileName}`);
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

test("readAgentOutput with duplicate names lists matches instead of silently picking the latest", async () => {
  // 同名历史任务：写入两个不同 correlationId 的记录，按 name 查询必须给出列表而非静默取最新
  await persistAgentOutput("dup-a1", "shared", "explorer", { v: 1 }, root);
  await persistAgentOutput("dup-b2", "shared", "explorer", { v: 2 }, root);
  await assert.rejects(
    () => readAgentOutput("shared", root),
    (err: unknown) => err instanceof Error
      && err.message.includes('Multiple outputs match agent name "shared" (2)')
      && err.message.includes("agent://dup-b2")
      && err.message.includes("agent://dup-a1")
      && err.message.includes('{"v":2}')
      && err.message.includes('{"v":1}'),
  );
});

test("resolveAgentOutput with duplicate names returns newest-first matches with ids, times and previews", async () => {
  await persistAgentOutputChecked("dup-c1", "shared-pub", "explorer", { v: 1 }, root, "dup-pub-1");
  await persistAgentOutputChecked("dup-c2", "shared-pub", "explorer", { v: 2 }, root, "dup-pub-2");
  const resolved = await resolveAgentOutput("shared-pub", root);
  assert.equal(resolved.kind, "ambiguous");
  if (resolved.kind !== "ambiguous") return;
  assert.equal(resolved.name, "shared-pub");
  assert.equal(resolved.matches.length, 2);
  assert.equal(resolved.matches[0]!.id, "dup-c2");
  assert.equal(resolved.matches[1]!.id, "dup-c1");
  assert.match(resolved.matches[0]!.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(resolved.matches[0]!.preview, '{"v":2}');
  // correlationId tracks the latest turn; publicationId pins one immutable result.
  const exact = await resolveAgentOutput("dup-pub-1", root);
  assert.equal(exact.kind, "record");
  if (exact.kind === "record") assert.deepEqual(exact.record.output, { v: 1 });
  const alias = await resolveAgentOutput("dup-c2", root);
  assert.equal(alias.kind, "record");
  if (alias.kind === "record") assert.deepEqual(alias.record.output, { v: 2 });
});

test("workspace buckets isolate names while exact ids remain globally readable", async () => {
  const wsA = join(root, "iso-ws-a");
  const wsB = join(root, "iso-ws-b");
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  await persistAgentOutput("iso-1", "shared-name", "explorer", { workspace: "a" }, wsA);
  await persistAgentOutput("iso-2", "shared-name", "explorer", { workspace: "b" }, wsB);
  assert.deepEqual((await readAgentOutput("shared-name", wsA)).output, { workspace: "a" });
  assert.deepEqual((await readAgentOutput("shared-name", wsB)).output, { workspace: "b" });
  assert.deepEqual((await readAgentOutput("iso-2", wsA)).output, { workspace: "b" });
  assert.deepEqual((await readAgentOutput("iso-1", wsB)).output, { workspace: "a" });
});

test("a child cwd resolves parent output by immutable publication id and correlation alias", async () => {
  const parent = join(root, "parent-workspace");
  const child = join(parent, "packages", "child");
  await mkdir(child, { recursive: true });
  await persistAgentOutputChecked(
    "parent-explorer",
    "parent-findings",
    "explorer",
    { source: "parent" },
    parent,
    "parent-publication",
  );

  assert.deepEqual((await readAgentOutput("parent-publication", child)).output, { source: "parent" });
  assert.deepEqual((await readAgentOutput("parent-explorer", child)).output, { source: "parent" });
  await assert.rejects(
    () => readAgentOutput("parent-findings", child),
    (err: unknown) => err instanceof Error
      && err.message.includes('No persisted teammate output for "parent-findings"'),
  );
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

test("readAgentOutput resolves a unique correlation-id prefix", async () => {
  await persistAgentOutput("shortprefix-alpha-9", "prefix-unique", "explorer", { ok: "yes" }, root);
  const record = await readAgentOutput("shortprefix-al", root);
  assert.equal(record.correlationId, "shortprefix-alpha-9");
});

test("readAgentOutput resolves an immutable publication id by its prefix", async () => {
  const publicationId = "pub-prefix-0001";
  await persistAgentOutputChecked("short-pub-corr", "prefix-pub", "explorer", { ok: true }, root, publicationId);
  const record = await readAgentOutput(publicationId.slice(0, 6), root);
  assert.equal(record.publicationId, publicationId);
  assert.equal(record.correlationId, "short-pub-corr");
});

test("ambiguous id prefix lists matches instead of guessing", async () => {
  await persistAgentOutput("dup-prefix-alpha-1", "dup-a", "explorer", { n: 1 }, root);
  await persistAgentOutput("dup-prefix-beta-2", "dup-b", "explorer", { n: 2 }, root);
  const resolved = await resolveAgentOutput("dup-prefix", root);
  assert.equal(resolved.kind, "ambiguous");
  if (resolved.kind === "ambiguous") {
    assert.deepEqual(resolved.matches.map((match) => match.correlationId).sort(), [
      "dup-prefix-alpha-1",
      "dup-prefix-beta-2",
    ]);
  }
});

test("a sub-4-character id is never treated as a prefix query", async () => {
  await assert.rejects(() => readAgentOutput("run", root), /No persisted teammate output for "run"/);
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

test("publication records remain immutable while correlation id resolves the latest turn", async () => {
  const workspace = join(root, "publication-workspace");
  assert.equal(
    await persistAgentOutputChecked("versioned-agent", "versioned", "general", { turn: 1 }, workspace, "publication-turn-1"),
    "stored",
  );
  assert.equal(
    await persistAgentOutputChecked("versioned-agent", "versioned", "general", { turn: 2 }, workspace, "publication-turn-2"),
    "stored",
  );

  assert.deepEqual((await readAgentOutput("publication-turn-1", workspace)).output, { turn: 1 });
  assert.deepEqual((await readAgentOutput("publication-turn-2", workspace)).output, { turn: 2 });
  assert.deepEqual((await readAgentOutput("versioned-agent", workspace)).output, { turn: 2 });
  assert.equal((await readAgentOutput("publication-turn-1", workspace)).publicationId, "publication-turn-1");
  await assert.rejects(
    () => persistAgentOutputChecked("versioned-agent", "versioned", "general", { turn: 99 }, workspace, "publication-turn-1"),
    /Immutable agent output already exists with different content/,
  );
});

test("pending alias falls back to the prior turn and retry completes publication", async () => {
  const workspace = join(root, "interrupted-publication-workspace");
  await persistAgentOutputChecked(
    "interrupted-agent",
    "interrupted",
    "general",
    { turn: 1 },
    workspace,
    "interrupted-publication-1",
  );
  const bucket = await bucketContaining("interrupted-publication-1.json");
  await writeFile(join(bucket, "interrupted-agent.alias.json"), JSON.stringify({
    kind: "agent-output-alias",
    correlationId: "interrupted-agent",
    publicationId: "interrupted-publication-2",
    fallbackPublicationId: "interrupted-publication-1",
  }), "utf8");

  assert.deepEqual((await readAgentOutput("interrupted-agent", workspace)).output, { turn: 1 });
  assert.equal(
    await persistAgentOutputChecked(
      "interrupted-agent",
      "interrupted",
      "general",
      { turn: 2 },
      workspace,
      "interrupted-publication-2",
    ),
    "stored",
  );
  assert.deepEqual((await readAgentOutput("interrupted-agent", workspace)).output, { turn: 2 });
  assert.deepEqual((await readAgentOutput("interrupted-publication-1", workspace)).output, { turn: 1 });
});

test("superseding an unresolved alias preserves the last readable fallback", async () => {
  const workspace = join(root, "repeated-interruption-workspace");
  await persistAgentOutputChecked(
    "repeated-interruption-agent",
    "repeated-interruption",
    "general",
    { turn: 1 },
    workspace,
    "repeated-interruption-publication-1",
  );
  const bucket = await bucketContaining("repeated-interruption-publication-1.json");
  await writeFile(join(bucket, "repeated-interruption-agent.alias.json"), JSON.stringify({
    kind: "agent-output-alias",
    correlationId: "repeated-interruption-agent",
    publicationId: "repeated-interruption-publication-2",
    fallbackPublicationId: "repeated-interruption-publication-1",
  }), "utf8");
  assert.equal(
    await persistAgentOutputChecked(
      "repeated-interruption-agent",
      "repeated-interruption",
      "general",
      { turn: 3 },
      workspace,
      "repeated-interruption-publication-3",
    ),
    "stored",
  );
  await unlink(join(bucket, "repeated-interruption-publication-3.json"));
  assert.deepEqual((await readAgentOutput("repeated-interruption-agent", workspace)).output, { turn: 1 });
  assert.deepEqual((await readAgentOutput("repeated-interruption-publication-1", workspace)).output, { turn: 1 });
});

test("legacy aliases cannot traverse outside the workspace output directory", async () => {
  const workspace = join(root, "alias-security-workspace");
  const legacyDir = join(workspace, ".pi", "agents");
  const outsideDir = join(workspace, "outside");
  await mkdir(legacyDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "secret.json"), JSON.stringify({
    correlationId: "secret",
    capturedAt: new Date().toISOString(),
    output: { secret: true },
  }), "utf8");
  await writeFile(join(legacyDir, "probe.alias.json"), JSON.stringify({
    kind: "agent-output-alias",
    correlationId: "probe",
    publicationId: "../../../outside/secret",
  }), "utf8");

  await assert.rejects(
    () => readAgentOutput("probe", workspace),
    /No persisted teammate output/,
  );
});

test("global aliases reject traversal and correlation mismatches", async () => {
  const workspace = join(root, "global-alias-security-workspace");
  await persistAgentOutputChecked(
    "alias-owner",
    "alias-owner",
    "general",
    { safe: true },
    workspace,
    "alias-owner-publication",
  );
  const bucket = await bucketContaining("alias-owner-publication.json");
  await writeFile(join(bucket, "probe.alias.json"), JSON.stringify({
    kind: "agent-output-alias",
    correlationId: "other-agent",
    publicationId: "alias-owner-publication",
  }), "utf8");
  await assert.rejects(() => readAgentOutput("probe", workspace), /No persisted teammate output/);

  await writeFile(join(bucket, "probe.alias.json"), JSON.stringify({
    kind: "agent-output-alias",
    correlationId: "probe",
    publicationId: "../../../outside/secret",
  }), "utf8");
  await assert.rejects(() => readAgentOutput("probe", workspace), /No persisted teammate output/);
});

test("usage lists current-workspace records and deletion repairs the latest alias", async () => {
  const workspace = join(root, "managed-output-workspace");
  await persistAgentOutputChecked(
    "managed-agent",
    "managed-task",
    "general",
    { turn: 1 },
    workspace,
    "managed-publication-1",
  );
  await persistAgentOutputChecked(
    "managed-agent",
    "managed-task",
    "general",
    { turn: 2 },
    workspace,
    "managed-publication-2",
  );

  const usage = await getAgentOutputStoreUsage(workspace);
  assert.equal(usage.records, 2);
  assert.equal(usage.maxRecords, MAX_AGENT_FILES);
  assert.ok(usage.totalBytes > 0);
  assert.deepEqual(usage.entries.map((entry) => entry.id), [
    "managed-agent",
    "managed-agent",
  ]);
  assert.equal(usage.entries[0]?.name, "managed-task");
  assert.equal(usage.entries[0]?.preview, '{"turn":2}');

  assert.equal(await deleteAgentOutput("managed-agent", workspace), true);
  assert.deepEqual((await readAgentOutput("managed-agent", workspace)).output, { turn: 1 });
  assert.equal((await getAgentOutputStoreUsage(workspace)).records, 1);
  assert.equal(await deleteAgentOutput("managed-agent", workspace), true);
  assert.equal(await deleteAgentOutput("../outside", workspace), false);
});

test("rolling capacity evicts the oldest record to make room for new publications", async () => {
  const workspace = join(root, "capacity-workspace");
  for (let index = 0; index < MAX_AGENT_FILES; index += 1) {
    assert.equal(
      await persistAgentOutputChecked(
        "capacity-agent",
        "capacity",
        "general",
        { index },
        workspace,
        `capacity-publication-${index}`,
      ),
      "stored",
    );
  }

  assert.equal(
    await persistAgentOutputChecked(
      "capacity-agent",
      "capacity",
      "general",
      { index: MAX_AGENT_FILES },
      workspace,
      `capacity-publication-${MAX_AGENT_FILES}`,
    ),
    "stored",
  );
  assert.deepEqual((await readAgentOutput(`capacity-publication-${MAX_AGENT_FILES}`, workspace)).output, { index: MAX_AGENT_FILES });
  await assert.rejects(() => readAgentOutput("capacity-publication-0", workspace));
  assert.deepEqual((await readAgentOutput("capacity-agent", workspace)).output, { index: MAX_AGENT_FILES });
  assert.equal((await getAgentOutputStoreUsage(workspace)).records, MAX_AGENT_FILES);
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
    "skipped-invalid",
  );
  await assert.rejects(
    () => readAgentOutput("run-abc-3", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(
    await persistAgentOutputChecked("run-abc-4", "cyclic", undefined, cyclic, root),
    "skipped-invalid",
  );
  await assert.rejects(
    () => readAgentOutput("run-abc-4", root),
    (err: unknown) => err instanceof Error && err.message.includes("No persisted teammate output"),
  );
});

test("resolveAgentOutput falls back to descendant workspace buckets", async () => {
  const parent = join(root, "descendant-proj");
  const child = join(parent, "sub");
  await mkdir(child, { recursive: true });
  // 模拟 per-task cwd 派发：teammate 写入子目录工作区，父目录会话可读。
  await persistAgentOutput("descendant-cid-1", "audit", "general", { ok: true }, child);

  const byId = await readAgentOutput("descendant-cid-1", parent);
  assert.equal(byId.correlationId, "descendant-cid-1");
  const byName = await readAgentOutput("audit", parent);
  assert.equal(byName.correlationId, "descendant-cid-1");

  // 精确 id 是全局能力引用；任务名仍保持工作区/子树隔离。
  const sibling = join(root, "sibling-proj");
  await mkdir(sibling, { recursive: true });
  assert.equal((await readAgentOutput("descendant-cid-1", sibling)).correlationId, "descendant-cid-1");
  await assert.rejects(
    () => readAgentOutput("audit", sibling),
    /No persisted teammate output/,
  );
});

test("legacy bucket without .workspace metadata is not discovered via subtree scan", async () => {
  const parent = join(root, "legacy-scan-proj");
  const child = join(parent, "sub");
  await mkdir(child, { recursive: true });
  await persistAgentOutput("old-cid-1", "old-task", "general", { legacy: true }, child);
  const bucket = await bucketContaining("old-cid-1.json");
  await rm(join(bucket, ".workspace"));
  // 无元数据的旧桶不参与子树发现；该工作区下次写入后自动补齐元数据即可见。
  await assert.rejects(
    () => readAgentOutput("old-cid-1", parent),
    /No persisted teammate output/,
  );
  await persistAgentOutput("old-cid-2", "old-task", "general", { fresh: true }, child);
  assert.equal((await readAgentOutput("old-cid-1", parent)).correlationId, "old-cid-1");
});

test("current workspace bucket takes priority over descendant buckets", async () => {
  const parent = join(root, "priority-proj");
  const child = join(parent, "sub");
  await mkdir(child, { recursive: true });
  await persistAgentOutput("priority-cid-1", "audit", "general", { from: "child" }, child);
  await persistAgentOutput("priority-cid-1", "audit", "general", { from: "parent" }, parent);

  const fromParent = await readAgentOutput("priority-cid-1", parent);
  assert.deepEqual(fromParent.output, { from: "parent" });
  const fromChild = await readAgentOutput("priority-cid-1", child);
  assert.deepEqual(fromChild.output, { from: "child" });
});

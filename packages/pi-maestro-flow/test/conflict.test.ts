import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

const {
  createConflictTool,
  conflictParseIssue,
  parseConflictHunks,
  scanConflicts,
} = await import("../src/tools/conflict.ts");
const { evaluatePermission } = await import("../src/permissions/policy.ts");

interface GitRunner {
  run(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

const empty = { allow: [], ask: [], deny: [] };

const MARKERS = [
  "<<<<<<< HEAD",
  "const timeout = 5000;",
  "=======",
  "const timeout = 10000;",
  ">>>>>>> feature-x",
  "",
  "export default timeout;",
  "",
  "<<<<<<< HEAD",
  "old()",
  "=======",
  "new()",
  ">>>>>>> feature-x",
].join("\n");

let root: string;
let tool: ReturnType<typeof createConflictTool>;
let calls: string[][] = [];

function fakeRunner(stdout: string): GitRunner {
  return {
    async run(args) {
      calls.push(args);
      return { ok: true, stdout, stderr: "" };
    },
  };
}

const emptyCtx = { cwd: "" } as never;
const ctx = (cwd: string): unknown => ({ cwd });

async function exec(params: Record<string, unknown>, cwd: string) {
  return tool.execute(
    "id",
    params as never,
    undefined,
    undefined,
    ctx(cwd) as never,
  );
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-conflict-"));
  await writeFile(join(root, "auth.ts"), MARKERS, "utf8");
  await writeFile(join(root, "config.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n", "utf8");
  calls = [];
  tool = createConflictTool(fakeRunner("auth.ts\0config.ts\0"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("parseConflictHunks extracts ours/theirs with precise offsets", () => {
  const hunks = parseConflictHunks(MARKERS);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.ours, "const timeout = 5000;");
  assert.equal(hunks[0]!.theirs, "const timeout = 10000;");
  assert.equal(hunks[1]!.ours, "old()");
  assert.equal(hunks[1]!.theirs, "new()");
  assert.equal(MARKERS.slice(hunks[0]!.start, hunks[0]!.start + hunks[0]!.length).startsWith("<<<<<<<"), true);
  assert.ok(hunks[1]!.start > hunks[0]!.start + hunks[0]!.length);
  assert.equal(hunks[0]!.raw, MARKERS.slice(hunks[0]!.start, hunks[0]!.start + hunks[0]!.length));
});

test("parseConflictHunks handles CRLF, empty sides, and missing trailing newline", () => {
  const crlf = "<<<<<<< HEAD\r\nconst a = 1;\r\n=======\r\nconst b = 2;\r\n>>>>>>> branch\r\n";
  const crlfHunks = parseConflictHunks(crlf);
  assert.equal(crlfHunks.length, 1);
  assert.equal(crlfHunks[0]!.ours, "const a = 1;");
  assert.equal(crlfHunks[0]!.theirs, "const b = 2;");

  const emptyOurs = "<<<<<<< HEAD\n=======\nconst b = 2;\n>>>>>>> branch\n";
  const emptyOursHunks = parseConflictHunks(emptyOurs);
  assert.equal(emptyOursHunks.length, 1);
  assert.equal(emptyOursHunks[0]!.ours, "");
  assert.equal(emptyOursHunks[0]!.theirs, "const b = 2;");

  const emptyTheirs = "<<<<<<< HEAD\nconst a = 1;\n=======\n>>>>>>> branch\n";
  const emptyTheirsHunks = parseConflictHunks(emptyTheirs);
  assert.equal(emptyTheirsHunks.length, 1);
  assert.equal(emptyTheirsHunks[0]!.ours, "const a = 1;");
  assert.equal(emptyTheirsHunks[0]!.theirs, "");

  const noTrailingNewline = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch";
  assert.equal(parseConflictHunks(noTrailingNewline).length, 1);
});

test("parseConflictHunks fails closed on unbalanced and diff3 markers", () => {
  const unbalanced = "<<<<<<< HEAD\na\n=======\nb\n";
  assert.equal(parseConflictHunks(unbalanced).length, 0);
  assert.match(conflictParseIssue(unbalanced) ?? "", /unbalanced/);

  const diff3 = "<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> branch\n";
  assert.equal(parseConflictHunks(diff3).length, 0);
  assert.match(conflictParseIssue(diff3) ?? "", /diff3/);
});

test("scanConflicts lists unmerged files with hunks", async () => {
  const scan = await scanConflicts(root, fakeRunner("auth.ts\0config.ts\0"));
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.files.map((f) => f.path), ["auth.ts", "config.ts"]);
  assert.equal(scan.files[0]!.hunks.length, 2);
  assert.equal(scan.files[1]!.hunks.length, 1);
});

test("scanConflicts reports git failure", async () => {
  const failing: GitRunner = {
    async run() {
      return { ok: false, stdout: "", stderr: "not a git repository" };
    },
  };
  const scan = await scanConflicts(root, failing);
  assert.equal(scan.ok, false);
  assert.match(scan.error ?? "", /not a git repository/);
});

test("conflict list numbers every conflict", async () => {
  const result = await exec({ action: "list" }, root);
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /Found 3 conflict\(s\)/);
  assert.match(text, /auth\.ts: conflict:\/\/1, conflict:\/\/2/);
  assert.match(text, /config\.ts: conflict:\/\/3/);
  const details = result.details as { conflict_count: number; files: string[] };
  assert.equal(details.conflict_count, 3);
  assert.deepEqual(details.files, ["auth.ts", "config.ts"]);
});

test("conflict diff shows @ours and @theirs sides", async () => {
  const result = await exec({ action: "diff", uri: "conflict://2" }, root);
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /## conflict:\/\/2 · auth\.ts/);
  assert.match(text, /### @ours\n\nold\(\)/);
  assert.match(text, /### @theirs\n\nnew\(\)/);
  assert.match(text, /hunk 2 of 2/);
});

test("conflict diff rejects invalid and bulk uris", async () => {
  await assert.rejects(
    () => exec({ action: "diff", uri: "conflict://99" }, root),
    (err: unknown) => err instanceof Error && err.message.includes("not found"),
  );
  await assert.rejects(
    () => exec({ action: "diff", uri: "conflict://*" }, root),
    (err: unknown) => err instanceof Error && err.message.includes("does not support conflict://*"),
  );
  await assert.rejects(
    () => exec({ action: "diff" }, root),
    (err: unknown) => err instanceof Error && err.message.includes("requires a uri"),
  );
});

test("conflict resolve applies @theirs to one hunk", async () => {
  const result = await exec({ action: "resolve", uri: "conflict://1", content: "@theirs" }, root);
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  assert.match(text, /Resolved 1 conflict\(s\)/);
  assert.match(text, /- auth\.ts/);

  const content = await readFile(join(root, "auth.ts"), "utf8");
  assert.match(content, /const timeout = 10000;/);
  assert.doesNotMatch(content, /const timeout = 5000;/);
  // 第二个冲突保留
  assert.match(content, /<<<<<<< HEAD/);
  assert.match(content, /new\(\)/);
});

test("conflict resolve applies custom content", async () => {
  // 恢复 auth.ts 双冲突状态，使 config.ts 重新编号为 conflict://3
  await writeFile(join(root, "auth.ts"), MARKERS, "utf8");
  await writeFile(join(root, "config.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n", "utf8");
  await exec({ action: "resolve", uri: "conflict://3", content: "c" }, root);
  const content = await readFile(join(root, "config.ts"), "utf8");
  assert.equal(content, "c\n");
});

test("conflict resolve bulk conflict://* with @ours", async () => {
  await writeFile(join(root, "auth.ts"), MARKERS, "utf8");
  await writeFile(join(root, "config.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n", "utf8");
  const result = await exec({ action: "resolve", uri: "conflict://*", content: "@ours" }, root);
  const details = result.details as { resolved: number; files: string[] };
  assert.equal(details.resolved, 3);
  assert.deepEqual(details.files, ["auth.ts", "config.ts"]);

  const auth = await readFile(join(root, "auth.ts"), "utf8");
  assert.doesNotMatch(auth, /<<<<<<<|=======|>>>>>>>/);
  assert.match(auth, /const timeout = 5000;/);
  assert.match(auth, /old\(\)/);
  const config = await readFile(join(root, "config.ts"), "utf8");
  assert.equal(config, "a\n");
});

test("conflict resolve preserves custom content whitespace", async () => {
  await writeFile(join(root, "auth.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n", "utf8");
  await exec({ action: "resolve", uri: "conflict://1", content: "  padded  " }, root);
  const content = await readFile(join(root, "auth.ts"), "utf8");
  assert.equal(content, "  padded  \n");
});

test("conflict resolve requires content and valid uri", async () => {
  await writeFile(join(root, "auth.ts"), MARKERS, "utf8");
  await assert.rejects(
    () => exec({ action: "resolve", uri: "conflict://1" }, root),
    (err: unknown) => err instanceof Error && err.message.includes("requires content"),
  );
  await assert.rejects(
    () => exec({ action: "resolve", uri: "conflict://9", content: "@ours" }, root),
    (err: unknown) => err instanceof Error && err.message.includes("not found"),
  );
});

test("resolve after resolution reports stale numbering", async () => {
  await writeFile(join(root, "auth.ts"), "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n", "utf8");
  await exec({ action: "resolve", uri: "conflict://1", content: "@ours" }, root);
  // 已解决后再次按旧编号 resolve → 重新扫描发现不再有该编号
  await assert.rejects(
    () => exec({ action: "resolve", uri: "conflict://1", content: "@theirs" }, root),
    (err: unknown) => err instanceof Error && err.message.includes("not found"),
  );
});

test("permission policy allows conflict list/diff, gates resolve", () => {
  const list = { toolName: "conflict", input: { action: "list" } };
  const diff = { toolName: "conflict", input: { action: "diff", uri: "conflict://1" } };
  const resolve = { toolName: "conflict", input: { action: "resolve", uri: "conflict://1", content: "@ours" } };

  assert.equal(evaluatePermission(list, "default", empty).behavior, "allow");
  assert.equal(evaluatePermission(diff, "dontAsk", empty).behavior, "allow", "read-only actions stay allowed in dontAsk");
  assert.equal(evaluatePermission(resolve, "default", empty).behavior, "ask");
  assert.equal(evaluatePermission(resolve, "acceptEdits", empty).behavior, "allow");
  assert.equal(evaluatePermission(resolve, "dontAsk", empty).behavior, "deny");
  assert.equal(evaluatePermission(resolve, "bypassPermissions", empty).behavior, "allow");
});

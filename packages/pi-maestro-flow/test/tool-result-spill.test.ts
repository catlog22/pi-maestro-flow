import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import test from "node:test";
import {
  buildSpillReplacementText,
  cleanupSpillDir,
  generatePreview,
  spillDir,
  spillPath,
  spillToolResult,
  validateSpillPath,
  SPILL_PREVIEW_CHARS,
  SPILL_THRESHOLD_CHARS,
} from "../src/compaction/tool-result-spill.ts";

test("generatePreview returns full content when under limit", () => {
  const { preview, hasMore } = generatePreview("short text", 100);
  assert.equal(preview, "short text");
  assert.equal(hasMore, false);
});

test("generatePreview truncates at newline when near limit", () => {
  const content = "line1\nline2\nline3\nline4\nline5";
  const { preview, hasMore } = generatePreview(content, 15);
  assert.equal(hasMore, true);
  assert.ok(preview.endsWith("\nline2") || preview.length <= 15);
  assert.ok(!preview.includes("line5"));
});

test("generatePreview falls back to exact limit when newline is too early", () => {
  const content = "a\n" + "b".repeat(100);
  const { preview, hasMore } = generatePreview(content, 50);
  assert.equal(hasMore, true);
  assert.equal(preview.length, 50);
});

test("spillToolResult writes file and returns preview", async () => {
  const sessionId = `test-spill-${Date.now()}`;
  const content = "x".repeat(SPILL_THRESHOLD_CHARS + 100);
  try {
    const result = await spillToolResult(sessionId, "call-1", content);
    assert.ok(result.path.length > 0);
    assert.equal(result.originalChars, content.length);
    assert.equal(result.hasMore, true);
    assert.ok(result.preview.length <= SPILL_PREVIEW_CHARS);
    const written = await readFile(result.path, "utf8");
    assert.equal(written, content);
  } finally {
    await cleanupSpillDir(sessionId);
  }
});

test("spillToolResult is idempotent (wx flag)", async () => {
  const sessionId = `test-idempotent-${Date.now()}`;
  const content = "y".repeat(SPILL_THRESHOLD_CHARS);
  try {
    const first = await spillToolResult(sessionId, "call-dup", content);
    const second = await spillToolResult(sessionId, "call-dup", content);
    assert.equal(first.path, second.path);
    assert.equal(first.preview, second.preview);
    const written = await readFile(second.path, "utf8");
    assert.equal(written, content);
  } finally {
    await cleanupSpillDir(sessionId);
  }
});

test("buildSpillReplacementText includes persisted-output tag and path", () => {
  const text = buildSpillReplacementText(
    { ok: true, path: "/tmp/test/call-1.txt", preview: "first lines", originalChars: 50_000, hasMore: true },
    "bash",
  );
  assert.ok(text.startsWith("<persisted-output>"));
  assert.ok(text.endsWith("</persisted-output>"));
  assert.ok(text.includes("/tmp/test/call-1.txt"));
  assert.ok(text.includes("bash"));
  assert.ok(text.includes("first lines"));
  assert.ok(text.includes("..."));
  assert.ok(text.includes("read tool"));
});

test("buildSpillReplacementText degrades when path is empty", () => {
  const text = buildSpillReplacementText(
    { ok: false, path: "", preview: "preview text", originalChars: 10_000, hasMore: true },
    "grep",
  );
  assert.ok(!text.includes("<persisted-output>"));
  assert.ok(text.includes("pruned"));
  assert.ok(text.includes("preview text"));
});

test("cleanupSpillDir removes the session directory", async () => {
  const sessionId = `test-cleanup-${Date.now()}`;
  const content = "z".repeat(SPILL_THRESHOLD_CHARS);
  const result = await spillToolResult(sessionId, "call-clean", content);
  assert.ok(result.path.length > 0);
  await cleanupSpillDir(sessionId);
  let rejected = false;
  try { await readFile(result.path, "utf8"); } catch { rejected = true; }
  assert.ok(rejected, "file should not exist after cleanup");
});

test("spillPath is deterministic", () => {
  const a = spillPath("session-1", "call-abc");
  const b = spillPath("session-1", "call-abc");
  assert.equal(a, b);
  assert.ok(a.includes("session-1"));
  assert.ok(a.includes("call-abc"));
  assert.ok(a.endsWith(".txt"));
});

test("spillPath stays injective past the sanitizer's 16-char truncation", () => {
  // Sanitizing truncates, and spillToolResult treats EEXIST as "already
  // persisted" — so a collision here would silently serve one call's payload
  // in answer to another. Both ids below share their first 16 characters.
  const a = spillPath("session-1", "toolcall-aaaaaaa-ONE");
  const b = spillPath("session-1", "toolcall-aaaaaaa-TWO");
  assert.notEqual(a, b);
});

test("spillDir is under tmpdir", () => {
  const dir = spillDir("my-session");
  assert.ok(dir.includes("pi-spill-my-session"));
  assert.ok(dir.includes("tool-spill"));
});

// S1 — a traversal-shaped callId cannot escape the session spill dir.
test("spillPath sanitizes traversal-shaped callId and stays inside spillDir", () => {
  const sessionId = "sess-traversal";
  const dir = resolve(spillDir(sessionId));
  const path = resolve(spillPath(sessionId, "../../../../etc/passwd"));
  assert.ok(
    path === dir || path.startsWith(dir + sep),
    `expected ${path} to stay inside ${dir}`,
  );
  assert.ok(!path.includes(".."));
});

// S1 — an actual write with a traversal callId must land inside the spill dir.
test("spillToolResult with traversal callId writes inside the spill dir", async () => {
  const sessionId = `test-traversal-${Date.now()}`;
  const content = "t".repeat(SPILL_THRESHOLD_CHARS + 10);
  try {
    const result = await spillToolResult(sessionId, "../../evil", content);
    assert.equal(result.ok, true);
    const dir = resolve(spillDir(sessionId));
    assert.ok(resolve(result.path).startsWith(dir + sep));
    const written = await readFile(result.path, "utf8");
    assert.equal(written, content);
  } finally {
    await cleanupSpillDir(sessionId);
  }
});

// S3 — spill dir is created with mode 0o700 (not world-listable).
test("spillToolResult creates the spill dir with 0o700 mode", async () => {
  const sessionId = `test-mode-${Date.now()}`;
  const content = "m".repeat(SPILL_THRESHOLD_CHARS);
  try {
    const result = await spillToolResult(sessionId, "call-mode", content);
    assert.equal(result.ok, true);
    if (process.platform !== "win32") {
      const st = await stat(spillDir(sessionId));
      assert.equal(st.mode & 0o777, 0o700);
    }
  } finally {
    await cleanupSpillDir(sessionId);
  }
});

// S5 — a traversal-shaped sessionId cannot make cleanup escape tmpdir.
test("cleanupSpillDir with traversal sessionId cannot escape tmpdir", async () => {
  // A sentinel outside tmpdir that must survive the cleanup call.
  const sentinelDir = dirname(tmpdir());
  const before = await readDirNames(sentinelDir);
  // Even if a naive join were used, sanitization + the tmpdir containment
  // guard must prevent any deletion outside tmpdir.
  await cleanupSpillDir("../../../../../../../../etc");
  const after = await readDirNames(sentinelDir);
  assert.deepEqual(after, before, "cleanup must not touch anything outside tmpdir");
});

// R5/O6 — ok is false when the durable write fails, true on the EEXIST path.
test("spillToolResult returns ok:false when the durable write fails", async () => {
  const sessionId = `test-fail-${Date.now()}`;
  const content = "f".repeat(SPILL_THRESHOLD_CHARS);
  // Occupy the session root path with a FILE so mkdir of the spill subdir
  // fails with a non-EEXIST error (ENOTDIR / ENOENT), simulating a durable
  // write failure.
  const root = dirname(spillDir(sessionId));
  await mkdir(dirname(root), { recursive: true });
  await writeFile(root, "occupied", "utf8");
  try {
    const result = await spillToolResult(sessionId, "call-fail", content);
    assert.equal(result.ok, false);
    assert.equal(result.path, "");
    assert.equal(result.originalChars, content.length);
  } finally {
    await rm(root, { force: true });
    await cleanupSpillDir(sessionId);
  }
});

test("spillToolResult rejects a symlinked session root", async () => {
  const sessionId = `test-symlink-${Date.now()}`;
  const root = dirname(spillDir(sessionId));
  const target = await mkdtemp(resolve(tmpdir(), "spill-target-"));
  try {
    await symlink(target, root, process.platform === "win32" ? "junction" : "dir");
    const result = await spillToolResult(sessionId, "call-symlink", "s".repeat(SPILL_THRESHOLD_CHARS));
    assert.equal(result.ok, false);
    assert.equal(result.path, "");
    assert.deepEqual(await readDirNames(target), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("spillToolResult rejects mismatched content at an existing path", async () => {
  const sessionId = `test-mismatch-${Date.now()}`;
  const firstContent = "a".repeat(SPILL_THRESHOLD_CHARS);
  const secondContent = "b".repeat(SPILL_THRESHOLD_CHARS);
  try {
    const first = await spillToolResult(sessionId, "call-mismatch", firstContent);
    const second = await spillToolResult(sessionId, "call-mismatch", secondContent);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(await readFile(first.path, "utf8"), firstContent);
  } finally {
    await cleanupSpillDir(sessionId);
  }
});

test("spillToolResult returns ok:true on the EEXIST (already persisted) path", async () => {
  const sessionId = `test-eexist-${Date.now()}`;
  const content = "e".repeat(SPILL_THRESHOLD_CHARS);
  try {
    const first = await spillToolResult(sessionId, "call-eexist", content);
    const second = await spillToolResult(sessionId, "call-eexist", content);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.path, second.path);
    const written = await readFile(second.path, "utf8");
    assert.equal(written, content);
  } finally {
    await cleanupSpillDir(sessionId);
  }
});

test("validateSpillPath accepts a live spill file and rejects dead or foreign paths", async () => {
  const sessionId = `test-validate-${Date.now()}`;
  const otherSessionId = `test-validate-other-${Date.now()}`;
  const content = "v".repeat(SPILL_THRESHOLD_CHARS);
  try {
    const result = await spillToolResult(sessionId, "call-validate", content);
    assert.equal(result.ok, true);
    assert.equal(await validateSpillPath(sessionId, result.path), true);
    // Expected shape, but no file behind it (cleaned tmpdir / failed write).
    assert.equal(await validateSpillPath(sessionId, spillPath(sessionId, "call-missing")), false);
    // A live file owned by another session's root is foreign.
    const foreign = await spillToolResult(otherSessionId, "call-foreign", content);
    assert.equal(foreign.ok, true);
    assert.equal(await validateSpillPath(sessionId, foreign.path), false);
    // A path outside any spill root.
    assert.equal(await validateSpillPath(sessionId, resolve(tmpdir(), "not-a-spill-file.txt")), false);
  } finally {
    await cleanupSpillDir(sessionId);
    await cleanupSpillDir(otherSessionId);
  }
});

test("validateSpillPath rejects a symlink planted at the expected spill path", async (t) => {
  const sessionId = `test-validate-link-${Date.now()}`;
  const content = "l".repeat(SPILL_THRESHOLD_CHARS);
  const real = await spillToolResult(sessionId, "call-real", content);
  assert.equal(real.ok, true);
  const linkPath = spillPath(sessionId, "call-link");
  try {
    try {
      await symlink(real.path, linkPath);
    } catch {
      t.skip("file symlinks require elevated privileges on this platform");
      return;
    }
    assert.equal(await validateSpillPath(sessionId, linkPath), false);
  } finally {
    await rm(linkPath, { force: true });
    await cleanupSpillDir(sessionId);
  }
});

test("validateSpillPath rejects a spill dir whose realpath escapes the session root", async () => {
  const sessionId = `test-validate-escape-${Date.now()}`;
  const root = dirname(spillDir(sessionId));
  const dir = spillDir(sessionId);
  const target = await mkdtemp(resolve(tmpdir(), "spill-escape-"));
  try {
    await mkdir(root, { recursive: true });
    await symlink(target, dir, process.platform === "win32" ? "junction" : "dir");
    const escapedPath = resolve(dir, "call-escape.txt");
    await writeFile(escapedPath, "x", "utf8");
    // Lexically inside spillDir and a regular file, but realpath lands outside
    // the session root.
    assert.equal(await validateSpillPath(sessionId, escapedPath), false);
  } finally {
    // Remove the junction/symlink itself, never through it into the target.
    await rm(dir, { force: true });
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

async function readDirNames(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(dir);
  return names.sort();
}

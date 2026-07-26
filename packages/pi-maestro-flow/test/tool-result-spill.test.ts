import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  buildSpillReplacementText,
  cleanupSpillDir,
  generatePreview,
  spillDir,
  spillPath,
  spillToolResult,
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
    { path: "/tmp/test/call-1.txt", preview: "first lines", originalChars: 50_000, hasMore: true },
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
    { path: "", preview: "preview text", originalChars: 10_000, hasMore: true },
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
  assert.ok(a.includes("call-abc.txt"));
});

test("spillDir is under tmpdir", () => {
  const dir = spillDir("my-session");
  assert.ok(dir.includes("pi-spill-my-session"));
  assert.ok(dir.includes("tool-spill"));
});

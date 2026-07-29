import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  exportSessionHistory,
  formatBytes,
  formatSessionLocation,
  probeSessionFile,
  resolveExportTarget,
  tryCopyToClipboard,
} from "../src/session/session-export.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-session-export-"));
  const sessionFile = join(root, "sessions", "abc123.jsonl");
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(sessionFile, '{"role":"user"}\n{"role":"assistant"}\n', "utf8");
  return { root, sessionFile };
}

test("formatBytes renders human-readable sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(4096), "4.0 KB");
  assert.equal(formatBytes(undefined), "unknown size");
});

test("formatSessionLocation reports id, name, and history storage location", () => {
  const report = formatSessionLocation({
    sessionId: "sess-1",
    sessionName: "my session",
    sessionFile: "/home/u/.pi/agent/sessions/sess-1.jsonl",
    sessionDir: "/home/u/.pi/agent/sessions",
  });
  assert.match(report, /Session ID\s*: sess-1/);
  assert.match(report, /Session name: my session/);
  assert.match(report, /History file: .*sess-1\.jsonl/);
  assert.match(report, /Session dir\s*: .*sessions/);
});

test("formatSessionLocation handles a missing session file", () => {
  const report = formatSessionLocation({
    sessionId: undefined,
    sessionName: undefined,
    sessionFile: undefined,
    sessionDir: undefined,
  });
  assert.match(report, /Session ID\s*: \(unknown\)/);
  assert.match(report, /History file: \(no active session history file\)/);
});

test("formatSessionLocation includes existence status when provided", () => {
  const present = formatSessionLocation(
    { sessionId: "s", sessionName: undefined, sessionFile: "/x.jsonl", sessionDir: undefined },
    { exists: true, bytes: 4096, modified: new Date("2026-01-02T03:04:05.000Z") },
  );
  assert.match(present, /Status\s*: exists · 4\.0 KB · modified 2026-01-02T03:04:05\.000Z/);

  const missing = formatSessionLocation(
    { sessionId: "s", sessionName: undefined, sessionFile: "/x.jsonl", sessionDir: undefined },
    { exists: false, bytes: undefined, modified: undefined },
  );
  assert.match(missing, /Status\s*: not found on disk/);
});

test("tryCopyToClipboard returns true and forwards the text on success", async () => {
  const seen: string[] = [];
  const ok = await tryCopyToClipboard("payload", async (text) => {
    seen.push(text);
  });
  assert.equal(ok, true);
  assert.deepEqual(seen, ["payload"]);
});

test("tryCopyToClipboard swallows clipboard failures and returns false", async () => {
  const ok = await tryCopyToClipboard("payload", async () => {
    throw new Error("clipboard denied");
  });
  assert.equal(ok, false);
});

test("probeSessionFile reports existence and size", async () => {
  const { root, sessionFile } = await fixture();
  try {
    const present = await probeSessionFile(sessionFile);
    assert.equal(present.exists, true);
    assert.ok((present.bytes ?? 0) > 0);
    assert.ok(present.modified instanceof Date);

    const absent = await probeSessionFile(join(root, "nope.jsonl"));
    assert.equal(absent.exists, false);
    assert.equal(absent.bytes, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveExportTarget treats directories and file paths distinctly", async () => {
  const { root, sessionFile } = await fixture();
  try {
    // Existing directory → copy into it, keeping the source file name.
    const intoDir = await resolveExportTarget(root, sessionFile, root);
    assert.equal(intoDir, join(root, "abc123.jsonl"));

    // Trailing separator → directory mode even without an existing dir.
    const trailing = await resolveExportTarget(`${join(root, "out")}/`, sessionFile, root);
    assert.equal(trailing, join(root, "out", "abc123.jsonl"));

    // Explicit file path (non-existent) → resolved against cwd verbatim.
    const explicit = await resolveExportTarget("copy.jsonl", sessionFile, root);
    assert.equal(explicit, join(root, "copy.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exportSessionHistory copies the transcript to the resolved target", async () => {
  const { root, sessionFile } = await fixture();
  try {
    const target = join(root, "exported", "backup.jsonl");
    const result = await exportSessionHistory(sessionFile, target);
    assert.equal(result.written, target);
    const copied = await readFile(target, "utf8");
    const original = await readFile(sessionFile, "utf8");
    assert.equal(copied, original);
    assert.equal(result.bytes, Buffer.byteLength(original, "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

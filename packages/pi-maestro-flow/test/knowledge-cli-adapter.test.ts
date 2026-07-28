import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLatestSessionId } from "../src/knowledge/cli-adapter.ts";

test("latest knowledge session ignores newer legacy and invalid directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-knowledge-session-"));
  try {
    const sessionsDir = join(root, ".workflow", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeCanonicalSession(sessionsDir, "valid-older", new Date("2026-01-01T00:00:00Z"));
    await writeCanonicalSession(sessionsDir, "valid-latest", new Date("2026-02-01T00:00:00Z"));

    await mkdir(join(sessionsDir, "legacy-ui-craft-20260710-161213"));
    await mkdir(join(sessionsDir, "malformed"));
    await writeFile(join(sessionsDir, "malformed", "session.json"), "{not-json", "utf8");
    await mkdir(join(sessionsDir, "identity-mismatch"));
    await writeFile(
      join(sessionsDir, "identity-mismatch", "session.json"),
      JSON.stringify({ session_id: "different-id" }),
      "utf8",
    );

    assert.equal(resolveLatestSessionId(root), "valid-latest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("latest knowledge session returns null without a valid canonical session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-knowledge-session-empty-"));
  try {
    const sessionsDir = join(root, ".workflow", "sessions");
    await mkdir(join(sessionsDir, "legacy-only"), { recursive: true });
    await mkdir(join(sessionsDir, "mismatch"));
    await writeFile(join(sessionsDir, "mismatch", "session.json"), JSON.stringify({ session_id: "other" }), "utf8");

    assert.equal(resolveLatestSessionId(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeCanonicalSession(sessionsDir: string, id: string, mtime: Date): Promise<void> {
  const dir = join(sessionsDir, id);
  const sessionPath = join(dir, "session.json");
  await mkdir(dir);
  await writeFile(sessionPath, JSON.stringify({ session_id: id }), "utf8");
  await utimes(sessionPath, mtime, mtime);
}

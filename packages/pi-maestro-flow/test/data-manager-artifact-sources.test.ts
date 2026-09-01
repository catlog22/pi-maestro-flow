import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createArtifactExportDataSource,
  createToolSpillDataSource,
} from "../src/tools/data-manager-artifact-sources.ts";
import {
  artifactExportOwnershipDir,
  recordArtifactExportOwnership,
} from "../src/tools/session-artifact-export-store.ts";
import { writeArtifactMarkdownExclusive } from "../src/tools/session-artifact-command.ts";
import {
  cleanupSpillDir,
  guardedCleanupSpillOwner,
  spillOwnerMarkerPath,
  spillOwnerRoot,
  spillSessionDigest,
  spillToolResult,
} from "../src/compaction/tool-result-spill.ts";
import type { ManagedDataContext } from "../src/tools/data-manager.ts";
import { lockSettingsResource } from "../src/settings/resource-lock.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function context(cwd: string, currentSessionId?: string, currentSessionDir?: string): ManagedDataContext {
  return {
    cwd,
    now: new Date("2030-01-01T00:00:00.000Z"),
    ...(currentSessionId ? { currentSessionId } : {}),
    ...(currentSessionDir ? { currentSessionDir } : {}),
  };
}

async function transcriptDir(cwd: string, sessionIds: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dm-transcripts-"));
  for (const sessionId of sessionIds) {
    await writeFile(join(dir, `${digest(sessionId)}.jsonl`), `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
  }
  return dir;
}

async function managedArtifact(cwd: string, name: string, markdown = `# ${name}`): Promise<string> {
  const target = await writeArtifactMarkdownExclusive(markdown, join(cwd, `${name}.md`));
  await recordArtifactExportOwnership({
    cwd,
    writtenPath: target,
    source: "plan",
    artifactId: `artifact:${name}`,
    markdown,
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
  });
  return target;
}

async function markOwnerDead(sessionId: string): Promise<void> {
  const markerPath = spillOwnerMarkerPath(sessionId);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.pid = 2_147_483_646;
  marker.heartbeatAt = "2020-01-01T00:00:00.000Z";
  await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
}

test("artifact source deletes only digest-matched managed regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-artifact-"));
  try {
    const unowned = join(root, "artifact-unowned.md");
    await writeFile(unowned, "legacy/unowned");
    const managed = await managedArtifact(root, "managed");
    const source = createArtifactExportDataSource();
    const snapshot = await source.load(root, context(root));
    assert.equal(snapshot.items.length, 1, "unowned Markdown is not inferred from its filename");
    const item = snapshot.items[0]!;
    assert.match(item.id, /^[a-f0-9]{64}-[a-f0-9]{64}$/);
    assert.equal(item.cleanupEligible, true);
    assert.ok(item.revision);
    const stale = await source.guardedDelete!({ cwd: root, itemId: item.id, revision: "0".repeat(64), item, context: context(root) });
    assert.equal(stale.status, "stale");
    assert.equal(await readFile(managed, "utf8"), "# managed");
    const deleted = await source.guardedDelete!({ cwd: root, itemId: item.id, revision: item.revision!, item, context: context(root) });
    assert.equal(deleted.status, "deleted");
    await assert.rejects(() => readFile(managed));
    assert.equal(await readFile(unowned, "utf8"), "legacy/unowned");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact source protects mismatches, forged escapes, and symlink targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dm-artifact-protect-"));
  const outside = join(await mkdtemp(join(tmpdir(), "dm-artifact-outside-")), "outside.md");
  try {
    const mismatched = await managedArtifact(root, "mismatch");
    await writeFile(mismatched, "tampered");

    const store = artifactExportOwnershipDir(root);
    await mkdir(store, { recursive: true });
    const escapedTarget = "../outside.md";
    const artifactDigest = digest("forged-artifact");
    const targetDigest = digest(escapedTarget);
    await writeFile(join(store, `${artifactDigest}-${targetDigest}.json`), JSON.stringify({
      version: 1,
      target: escapedTarget,
      source: "plan",
      createdAt: "2020-01-01T00:00:00.000Z",
      bytes: 7,
      contentDigest: digest("outside"),
      artifactIdDigest: artifactDigest,
      targetDigest,
    }));
    await writeFile(outside, "outside");

    const linked = await managedArtifact(root, "linked");
    let linkCreated = false;
    try {
      await unlink(linked);
      await symlink(outside, linked, "file");
      linkCreated = true;
    } catch (error) {
      if (process.platform !== "win32") throw error;
      t.diagnostic(`file symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const source = createArtifactExportDataSource();
    const snapshot = await source.load(root, context(root));
    assert.ok(snapshot.items.find((item) => item.title === "mismatch.md")?.protectionReason?.includes("digest"));
    assert.ok(snapshot.items.find((item) => item.id === `${artifactDigest}-${targetDigest}`)?.protectionReason?.includes("escapes"));
    if (linkCreated) assert.ok(snapshot.items.find((item) => item.title === "linked.md")?.protectionReason?.includes("non-symlink"));
    for (const item of snapshot.items) {
      if (item.protectionReason) assert.equal(item.cleanupEligible, false);
    }
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(outside, ".."), { recursive: true, force: true });
  }
});

test("artifact guarded deletion rejects a replaced ownership store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dm-artifact-store-race-"));
  const outside = await mkdtemp(join(tmpdir(), "dm-artifact-store-outside-"));
  try {
    const target = await managedArtifact(root, "store-race");
    const source = createArtifactExportDataSource();
    const item = (await source.load(root, context(root))).items[0]!;
    const store = artifactExportOwnershipDir(root);
    const sidecarName = (await readdir(store)).find((name) => name.endsWith(".json"))!;
    await copyFile(join(store, sidecarName), join(outside, sidecarName));
    await rm(store, { recursive: true, force: true });
    try {
      await symlink(outside, store, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory link unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const result = await source.guardedDelete!({ cwd: root, itemId: item.id, revision: item.revision!, item, context: context(root) });
    assert.equal(result.status, "protected");
    assert.equal(await readFile(target, "utf8"), "# store-race");
    assert.equal((await readFile(join(outside, sidecarName), "utf8")).length > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("artifact guarded deletion does not delete a target replaced while waiting for its production lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "dm-artifact-target-race-"));
  try {
    const target = await managedArtifact(root, "target-race");
    const source = createArtifactExportDataSource();
    const item = (await source.load(root, context(root))).items[0]!;
    const store = artifactExportOwnershipDir(root);
    const release = await lockSettingsResource(join(store, ".artifact-export-store"));
    const pending = source.guardedDelete!({ cwd: root, itemId: item.id, revision: item.revision!, item, context: context(root) });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    await unlink(target);
    await writeFile(target, "replacement", "utf8");
    await release();

    const result = await pending;
    assert.ok(result.status === "protected" || result.status === "stale");
    assert.equal(await readFile(target, "utf8"), "replacement");
    assert.equal((await source.load(root, context(root))).items.length, 1, "sidecar is retained for protected mismatch review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool spill source protects current/live/unknown owners and cleans only a revision-matched dead owner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "dm-spill-cwd-"));
  const suffix = `${process.pid}-${Date.now()}`;
  const liveSession = `dm-live-${suffix}`;
  const currentSession = `dm-current-${suffix}`;
  const deadSession = `dm-dead-${suffix}`;
  const missingSession = `dm-missing-${suffix}`;
  const sessions = [liveSession, currentSession, deadSession, missingSession];
  const sessionsDir = await transcriptDir(cwd, sessions);
  try {
    for (const sessionId of [liveSession, currentSession, deadSession, missingSession]) {
      assert.equal((await spillToolResult(sessionId, "call", "x".repeat(9000))).ok, true);
    }
    await markOwnerDead(currentSession);
    await markOwnerDead(deadSession);
    await unlink(spillOwnerMarkerPath(missingSession));

    const source = createToolSpillDataSource();
    const ctx = context(cwd, currentSession, sessionsDir);
    const snapshot = await source.load(cwd, ctx);
    const live = snapshot.items.find((item) => item.id.startsWith(`${spillSessionDigest(liveSession)}-`));
    const current = snapshot.items.find((item) => item.id.startsWith(`${spillSessionDigest(currentSession)}-`));
    const dead = snapshot.items.find((item) => item.id.startsWith(`${spillSessionDigest(deadSession)}-`));
    const missing = snapshot.items.find((item) => item.title.includes("Untrusted") && item.detail.includes(missingSession.slice(0, 8)));
    assert.match(live?.protectionReason ?? "", /alive/);
    assert.match(current?.protectionReason ?? "", /current session/);
    assert.equal(dead?.cleanupEligible, true);
    assert.ok(dead?.revision);
    assert.ok(snapshot.items.some((item) => item.protectionReason?.includes("marker is missing")), "missing marker remains protected");
    void missing;

    const stale = await source.guardedDelete!({ cwd, itemId: dead!.id, revision: "0".repeat(64), item: dead!, context: ctx });
    assert.equal(stale.status, "stale");
    const deleted = await source.guardedDelete!({ cwd, itemId: dead!.id, revision: dead!.revision!, item: dead!, context: ctx });
    assert.equal(deleted.status, "deleted");
    const after = await source.load(cwd, ctx);
    assert.equal(after.items.some((item) => item.id === dead!.id), false);
    assert.ok(after.items.some((item) => item.id === live!.id));
    assert.ok(after.items.some((item) => item.id === current!.id));
  } finally {
    for (const sessionId of sessions) await cleanupSpillDir(sessionId);
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tool spill inventory and guarded cleanup stay isolated to validated workspace transcripts", async () => {
  const workspaceA = await mkdtemp(join(tmpdir(), "dm-spill-a-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "dm-spill-b-"));
  const sessionA = `workspace-a-${process.pid}-${Date.now()}`;
  const sessionB = `workspace-b-${process.pid}-${Date.now()}`;
  const dirA = await transcriptDir(workspaceA, [sessionA]);
  const dirB = await transcriptDir(workspaceB, [sessionB]);
  try {
    await spillToolResult(sessionA, "call", "a".repeat(9000));
    await spillToolResult(sessionB, "call", "b".repeat(9000));
    await markOwnerDead(sessionA);
    await markOwnerDead(sessionB);

    const source = createToolSpillDataSource();
    const snapshotA = await source.load(workspaceA, context(workspaceA, undefined, dirA));
    const snapshotB = await source.load(workspaceB, context(workspaceB, undefined, dirB));
    const itemA = snapshotA.items.find((item) => item.id.startsWith(spillSessionDigest(sessionA)))!;
    assert.ok(itemA);
    assert.equal(snapshotA.items.some((item) => item.id.startsWith(spillSessionDigest(sessionB))), false);
    const itemB = snapshotB.items.find((item) => item.id.startsWith(spillSessionDigest(sessionB)))!;

    // Reverse the association after preview: guarded deletion must inventory
    // the transcript directory again rather than trusting the old snapshot.
    await writeFile(join(dirA, `${digest(sessionA)}.jsonl`), `${JSON.stringify({ type: "session", id: sessionA, cwd: workspaceB })}\n`);
    const reassociated = await source.guardedDelete!({
      cwd: workspaceA,
      itemId: itemA.id,
      revision: itemA.revision!,
      item: itemA,
      context: context(workspaceA, undefined, dirA),
    });
    assert.equal(reassociated.status, "protected");
    assert.equal((await readFile(spillOwnerMarkerPath(sessionA), "utf8")).length > 0, true);

    const crossWorkspace = await source.guardedDelete!({
      cwd: workspaceA,
      itemId: itemB.id,
      revision: itemB.revision!,
      item: itemB,
      context: context(workspaceA, undefined, dirA),
    });
    assert.equal(crossWorkspace.status, "protected");
    assert.equal((await readFile(spillOwnerMarkerPath(sessionB), "utf8")).length > 0, true);
  } finally {
    await cleanupSpillDir(sessionA);
    await cleanupSpillDir(sessionB);
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
  }
});

test("guarded spill cleanup never removes an owner-root replacement", async () => {
  const sessionId = `dm-replaced-owner-${process.pid}-${Date.now()}`;
  const root = spillOwnerRoot(sessionId);
  const original = `${root}.verified-original`;
  try {
    await spillToolResult(sessionId, "call", "x".repeat(9000));
    await markOwnerDead(sessionId);
    const source = createToolSpillDataSource();
    const sessionsDir = await transcriptDir("/workspace", [sessionId]);
    const snapshot = await source.load("/workspace", context("/workspace", undefined, sessionsDir));
    const item = snapshot.items.find((candidate) => candidate.id.startsWith(spillSessionDigest(sessionId)))!;

    const deleted = await guardedCleanupSpillOwner({
      sessionId,
      expectedRevision: item.revision!,
      authorizeSession: async () => {
        await rename(root, original);
        await mkdir(root);
        await writeFile(join(root, "replacement.txt"), "keep", "utf8");
        return true;
      },
    });

    assert.equal(deleted, false);
    assert.equal(await readFile(join(root, "replacement.txt"), "utf8"), "keep");
    assert.ok((await readdir(original)).includes(".owner.json"), "the verified original is not mistaken for the replacement");
    await rm(sessionsDir, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(original, { recursive: true, force: true });
  }
});

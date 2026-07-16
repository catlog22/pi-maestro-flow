import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checksumText,
  PlanApprovalError,
  PlanRevisionConflictError,
  PlanStore,
  planSessionStorageId,
  workspaceStorageId,
} from "../src/tools/plan-store.ts";

test("workspace storage IDs are readable and collision resistant", () => {
  const first = workspaceStorageId(join("C:\\work", "demo"));
  const second = workspaceStorageId(join("D:\\other", "demo"));
  assert.match(first, /^demo-[a-f0-9]{8}$/);
  assert.match(second, /^demo-[a-f0-9]{8}$/);
  assert.notEqual(first, second);
});

test("session storage IDs are readable, stable and collision resistant", () => {
  const first = planSessionStorageId("019f-chat-a");
  const repeated = planSessionStorageId("019f-chat-a");
  const second = planSessionStorageId("019f-chat-b");
  assert.match(first, /^019f-chat-a-[a-f0-9]{8}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, second);
});

test("PlanStore isolates chat sessions and assigns legacy workspace data once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-session-store-"));
  const cwd = join(root, "workspace");
  const rootDir = join(root, "global");
  try {
    const legacy = new PlanStore(cwd, { rootDir });
    await legacy.saveDraft("legacy workspace draft", 0);

    const chatA = new PlanStore(cwd, { rootDir, session: { id: "chat-a", file: "chat-a.jsonl", name: "Chat A" } });
    const loadedA = await chatA.load();
    assert.equal(loadedA.markdown, "legacy workspace draft");
    assert.equal(loadedA.manifest.sessionId, "chat-a");
    assert.equal(loadedA.manifest.sessionFile, "chat-a.jsonl");
    assert.equal(loadedA.manifest.sessionName, "Chat A");
    assert.match(chatA.plansDir.replaceAll("\\", "/"), /\/sessions\/chat-a-[a-f0-9]{8}\/plans$/);

    const chatB = new PlanStore(cwd, { rootDir, session: { id: "chat-b" } });
    const loadedB = await chatB.load();
    assert.equal(loadedB.markdown, "");
    assert.equal(loadedB.manifest.sessionId, "chat-b");
    await chatB.saveDraft("chat B draft", 0);

    assert.equal((await new PlanStore(cwd, { rootDir, session: { id: "chat-a" } }).load()).markdown, "legacy workspace draft");
    assert.equal((await new PlanStore(cwd, { rootDir, session: { id: "chat-b" } }).load()).markdown, "chat B draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore persists drafts, revisions and restart state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-store-"));
  const now = new Date("2026-07-11T10:00:00.000Z");
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global"), now: () => now });
    const initial = await store.load();
    assert.equal(initial.markdown, "");
    assert.equal(initial.manifest.revision, 0);

    const saved = await store.saveDraft("# Draft\n\nStep one", 0);
    assert.equal(saved.manifest.revision, 1);
    assert.equal(saved.manifest.status, "draft");
    assert.equal(await readFile(store.currentPath, "utf8"), "# Draft\n\nStep one");

    const restarted = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global"), now: () => now });
    const loaded = await restarted.load();
    assert.equal(loaded.markdown, saved.markdown);
    assert.equal(loaded.manifest.revision, 1);

    await assert.rejects(
      restarted.saveDraft("stale overwrite", 0),
      (error) => error instanceof PlanRevisionConflictError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore approval archives the exact draft and commits manifest last", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-approve-"));
  const now = new Date("2026-07-11T10:15:30.000Z");
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global"), now: () => now });
    const markdown = "# Approved plan\n\n1. Implement storage\n2. Verify";
    const approved = await store.approve(markdown, 0);
    assert.equal(approved.manifest.status, "approved");
    assert.equal(approved.manifest.approvedChecksum, checksumText(markdown));
    assert.match(approved.manifest.handoffKey ?? "", /^[a-f0-9]{64}$/);
    assert.ok(approved.manifest.approvedPath);
    const archive = join(store.plansDir, approved.manifest.approvedPath!);
    assert.equal(await readFile(archive, "utf8"), markdown);

    const persistedManifest = JSON.parse(await readFile(store.manifestPath, "utf8"));
    assert.equal(persistedManifest.status, "approved");
    assert.equal(persistedManifest.approvedPath, approved.manifest.approvedPath);
    assert.equal(persistedManifest.handoffKey, approved.manifest.handoffKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore uses private files and directories and tightens existing POSIX permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-private-mode-"));
  let commitStarted!: () => void;
  let releaseCommit!: () => void;
  const started = new Promise<void>((resolve) => { commitStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
  let approval: ReturnType<PlanStore["approve"]> | undefined;
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      approvalCommitHook: async () => {
        commitStarted();
        await release;
      },
    });
    await store.saveDraft("initial", 0);
    if (process.platform !== "win32") {
      await Promise.all([
        chmod(store.plansDir, 0o777),
        chmod(store.currentPath, 0o666),
        chmod(store.manifestPath, 0o666),
      ]);
    }

    approval = store.approve("private approval", 1);
    await started;
    const archiveName = (await readdir(store.approvalsDir)).find((entry) => entry.endsWith(".md"));
    assert.ok(archiveName);
    const privateDirectories = [store.plansDir, store.approvalsDir, store.recoveryDir, store.lockPath];
    const privateFiles = [
      store.currentPath,
      store.manifestPath,
      store.pendingPath,
      store.lockOwnerPath,
      join(store.approvalsDir, archiveName),
    ];
    for (const directory of privateDirectories) {
      const details = await lstat(directory);
      assert.equal(details.isSymbolicLink(), false);
      assert.equal(details.isDirectory(), true);
      if (process.platform !== "win32") assert.equal(details.mode & 0o777, 0o700);
    }
    for (const file of privateFiles) {
      const details = await lstat(file);
      assert.equal(details.isSymbolicLink(), false);
      assert.equal(details.isFile(), true);
      if (process.platform !== "win32") assert.equal(details.mode & 0o777, 0o600);
    }

    releaseCommit();
    assert.equal((await approval).manifest.status, "approved");
  } finally {
    releaseCommit?.();
    await approval?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore rejects a non-regular persisted file target", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-non-file-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    await store.saveDraft("initial", 0);
    await rm(store.currentPath);
    await mkdir(store.currentPath);
    await assert.rejects(store.load(), /Plan storage path must be a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore rejects a symlink persisted file target on POSIX", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-symlink-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    await store.saveDraft("initial", 0);
    const outside = join(root, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await rm(store.currentPath);
    await symlink(outside, store.currentPath);
    await assert.rejects(store.load(), /Plan storage path must be a regular file/);
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore recovers an externally changed current.md as a new draft revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-recover-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    await store.saveDraft("first", 0);
    await writeFile(store.currentPath, "human edit", "utf8");
    const recovered = await store.load();
    assert.equal(recovered.markdown, "human edit");
    assert.equal(recovered.manifest.revision, 2);
    assert.equal(recovered.manifest.status, "draft");
    assert.deepEqual(await readdir(store.approvalsDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore removes orphan approval files but preserves committed history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-orphan-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    const approved = await store.approve("committed", 0);
    assert.ok(approved.manifest.approvedPath);
    await mkdir(store.approvalsDir, { recursive: true });
    await writeFile(join(store.approvalsDir, "orphan.md"), "orphan", "utf8");
    await store.load();
    const entries = await readdir(store.approvalsDir);
    assert.ok(entries.includes(approved.manifest.approvedPath!.split(/[\\/]/).at(-1)!));
    assert.ok(!entries.includes("orphan.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore rebuilds approval history when manifest.json is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-manifest-rebuild-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    const approved = await store.approve("durable approval", 0);
    const archiveName = approved.manifest.approvedPath!.split(/[\\/]/).at(-1)!;
    await rm(store.manifestPath, { force: true });

    const recovered = await new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") }).load();
    assert.equal(recovered.manifest.status, "approved");
    assert.ok(recovered.manifest.approvals.some((path) => path.endsWith(archiveName)));
    assert.equal(await readFile(join(store.approvalsDir, archiveName), "utf8"), "durable approval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore advances the recovered revision when current.md diverges from the latest approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-manifest-diverged-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    const approved = await store.approve("approved text", 0);
    await writeFile(store.currentPath, "later human draft", "utf8");
    await rm(store.manifestPath, { force: true });

    const recovered = await new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") }).load();
    assert.equal(recovered.manifest.status, "draft");
    assert.equal(recovered.manifest.revision, approved.manifest.revision + 1);
    assert.equal(recovered.markdown, "later human draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore rebuilds semantically damaged manifest without deleting valid approval history", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-manifest-invariant-"));
  try {
    const store = new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") });
    const approved = await store.approve("historical approval", 0);
    const archivePath = join(store.plansDir, approved.manifest.approvedPath!);
    const damaged = {
      ...approved.manifest,
      status: "draft",
      approvals: [],
    };
    delete damaged.approvedAt;
    delete damaged.approvedPath;
    delete damaged.approvedChecksum;
    await writeFile(store.manifestPath, `${JSON.stringify(damaged, null, 2)}\n`, "utf8");

    const recovered = await new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") }).load();
    assert.equal(recovered.manifest.status, "approved");
    assert.deepEqual(recovered.manifest.approvals, approved.manifest.approvals);
    assert.equal(await readFile(archivePath, "utf8"), "historical approval");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore chooses the highest approval revision when the clock moves backwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-clock-rollback-"));
  let current = new Date("2026-07-11T12:00:00.000Z");
  try {
    const cwd = join(root, "workspace");
    const options = { rootDir: join(root, "global"), now: () => current };
    const store = new PlanStore(cwd, options);
    await store.approve("revision one", 0);
    current = new Date("2026-07-11T11:00:00.000Z");
    const second = await store.approve("revision two", 1);
    await rm(store.manifestPath, { force: true });

    const recovered = await new PlanStore(cwd, options).load();
    assert.equal(recovered.manifest.revision, 2);
    assert.equal(recovered.manifest.approvedPath, second.manifest.approvedPath);
    assert.equal(recovered.markdown, "revision two");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore quarantines an interrupted pending approval instead of approving or deleting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-pending-recovery-"));
  try {
    const cwd = join(root, "workspace");
    const options = { rootDir: join(root, "global") };
    const store = new PlanStore(cwd, options);
    await store.saveDraft("pending draft", 0);
    const checksum = checksumText("pending draft");
    const archiveName = `20260711T120000000Z-r0001-${checksum.slice(0, 8)}.md`;
    await writeFile(join(store.approvalsDir, archiveName), "pending draft", "utf8");
    await writeFile(store.pendingPath, `${JSON.stringify({
      version: 1,
      token: "interrupted-owner",
      archiveName,
      revision: 1,
      checksum,
      createdAt: "2026-07-11T12:00:00.000Z",
    })}\n`, "utf8");

    const recovered = await new PlanStore(cwd, options).load();
    assert.equal(recovered.manifest.status, "draft");
    assert.deepEqual(recovered.manifest.approvals, []);
    assert.equal((await readdir(store.approvalsDir)).includes(archiveName), false);
    assert.ok((await readdir(store.recoveryDir)).some((entry) => entry.startsWith(archiveName)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore quarantines archives associated with a structurally invalid pending marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-invalid-pending-"));
  try {
    const cwd = join(root, "workspace");
    const options = { rootDir: join(root, "global") };
    const store = new PlanStore(cwd, options);
    await store.saveDraft("invalid pending draft", 0);
    const checksum = checksumText("invalid pending draft");
    const archiveName = `20260711T120000000Z-r0001-${checksum.slice(0, 8)}.md`;
    await writeFile(join(store.approvalsDir, archiveName), "invalid pending draft", "utf8");
    await writeFile(store.pendingPath, `${JSON.stringify({ version: 1, token: "missing-fields" })}\n`, "utf8");

    const recovered = await new PlanStore(cwd, options).load();
    assert.equal(recovered.manifest.status, "draft");
    assert.deepEqual(recovered.manifest.approvals, []);
    assert.equal((await readdir(store.approvalsDir)).includes(archiveName), false);
    const recoveryEntries = await readdir(store.recoveryDir);
    assert.ok(recoveryEntries.some((entry) => entry.startsWith(archiveName)));
    assert.ok(recoveryEntries.some((entry) => entry.startsWith("invalid-pending.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore heartbeat prevents a live long approval from being reclaimed as stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-lock-heartbeat-"));
  let releaseCommit: (() => void) | undefined;
  let commitStarted: (() => void) | undefined;
  let ownerClockReads = 0;
  let approval: ReturnType<PlanStore["approve"]> | undefined;
  const started = new Promise<void>((resolve) => { commitStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
  try {
    const cwd = join(root, "workspace");
    const rootDir = join(root, "global");
    const owner = new PlanStore(cwd, {
      rootDir,
      lockStaleMs: 20,
      lockHeartbeatMs: 1,
      lockNow: () => {
        ownerClockReads += 1;
        return ownerClockReads > 2 ? 100 : 0;
      },
      isProcessAlive: () => false,
      getProcessIdentity: (pid: number) => `test-process:${pid}`,
      approvalCommitHook: async () => {
        commitStarted?.();
        await release;
      },
    });
    approval = owner.approve("long approval", 0);
    await started;
    await waitForCondition(async () => {
      try {
        const lockOwner = JSON.parse(await readFile(owner.lockOwnerPath, "utf8"));
        return lockOwner.heartbeatAt === 100;
      } catch {
        return false;
      }
    });
    assert.equal(
      JSON.parse(await readFile(owner.lockOwnerPath, "utf8")).processIdentity,
      `test-process:${process.pid}`,
    );

    const contender = new PlanStore(cwd, {
      rootDir,
      lockStaleMs: 20,
      lockRetryMs: 1,
      lockTimeoutMs: 1,
      lockNow: () => 100,
      isProcessAlive: () => false,
      getProcessIdentity: (pid: number) => `test-process:${pid}`,
    });
    await assert.rejects(contender.load(), /Timed out waiting for Plan transaction lock/);
    assert.equal(
      JSON.parse(await readFile(owner.lockOwnerPath, "utf8")).processIdentity,
      `test-process:${process.pid}`,
    );

    releaseCommit?.();
    const approved = await approval;
    assert.equal(approved.manifest.status, "approved");
  } finally {
    releaseCommit?.();
    await approval?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore reclaims a dead stale owner and releases only its own token", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-stale-owner-"));
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      lockStaleMs: 10,
      lockRetryMs: 2,
      lockTimeoutMs: 500,
      isProcessAlive: () => false,
      getProcessIdentity: () => "test-process:current",
    });
    await mkdir(store.lockPath, { recursive: true });
    await writeFile(store.lockOwnerPath, `${JSON.stringify({
      token: "dead-owner",
      pid: 999_999,
      processIdentity: "test-process:dead",
      createdAt: Date.now() - 1_000,
      heartbeatAt: Date.now() - 1_000,
    })}\n`, "utf8");

    const loaded = await store.load();
    assert.equal(loaded.manifest.revision, 0);
    assert.equal(await storePathExists(store.lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore does not reclaim a stale lock when the live PID birth identity matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-live-owner-"));
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      lockStaleMs: 10,
      lockRetryMs: 1,
      lockTimeoutMs: 1,
      lockNow: () => 1_000,
      isProcessAlive: () => true,
      getProcessIdentity: (pid) => pid === 42_424 ? "test-process:birth-a" : "test-process:contender",
    });
    await mkdir(store.lockPath, { recursive: true });
    await writeFile(store.lockOwnerPath, `${JSON.stringify({
      token: "live-owner",
      pid: 42_424,
      processIdentity: "test-process:birth-a",
      createdAt: 0,
      heartbeatAt: 0,
    })}\n`, "utf8");

    await assert.rejects(store.load(), /Timed out waiting for Plan transaction lock/);
    assert.equal(JSON.parse(await readFile(store.lockOwnerPath, "utf8")).token, "live-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore reclaims a stale lock when a live PID was reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-reused-pid-"));
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      lockStaleMs: 10,
      lockRetryMs: 1,
      lockTimeoutMs: 100,
      lockNow: () => 1_000,
      isProcessAlive: () => true,
      getProcessIdentity: (pid) => pid === 42_424 ? "test-process:birth-new" : "test-process:contender",
    });
    await mkdir(store.lockPath, { recursive: true });
    await writeFile(store.lockOwnerPath, `${JSON.stringify({
      token: "reused-pid-owner",
      pid: 42_424,
      processIdentity: "test-process:birth-old",
      createdAt: 0,
      heartbeatAt: 0,
    })}\n`, "utf8");

    const loaded = await store.load();
    assert.equal(loaded.manifest.revision, 0);
    assert.equal(await storePathExists(store.lockPath), false);
    assert.deepEqual(
      (await readdir(store.plansDir)).filter((entry) => entry.includes(".transaction-lock.stale-")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore keeps legacy stale locks fail-closed while their PID is live", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-legacy-live-owner-"));
  let legacyIdentityReads = 0;
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      lockStaleMs: 10,
      lockRetryMs: 1,
      lockTimeoutMs: 1,
      lockNow: () => 1_000,
      isProcessAlive: () => true,
      getProcessIdentity: (pid) => {
        if (pid === 42_424) legacyIdentityReads += 1;
        return "test-process:contender";
      },
    });
    await mkdir(store.lockPath, { recursive: true });
    await writeFile(store.lockOwnerPath, `${JSON.stringify({
      token: "legacy-live-owner",
      pid: 42_424,
      createdAt: 0,
      heartbeatAt: 0,
    })}\n`, "utf8");

    await assert.rejects(store.load(), /Timed out waiting for Plan transaction lock/);
    assert.equal(legacyIdentityReads, 0);
    assert.equal(JSON.parse(await readFile(store.lockOwnerPath, "utf8")).token, "legacy-live-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A stale former owner cannot remove a replacement owner's lock or pending approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-owner-handoff-"));
  let releaseOld: (() => void) | undefined;
  let oldStarted: (() => void) | undefined;
  let releaseReplacement: (() => void) | undefined;
  let replacementStarted: (() => void) | undefined;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldReady = new Promise<void>((resolve) => { oldStarted = resolve; });
  const replacementGate = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  const replacementReady = new Promise<void>((resolve) => { replacementStarted = resolve; });
  try {
    const cwd = join(root, "workspace");
    const baseOptions = {
      rootDir: join(root, "global"),
      lockStaleMs: 20,
      lockRetryMs: 2,
      lockTimeoutMs: 1_000,
      isProcessAlive: () => false,
    };
    const oldStore = new PlanStore(cwd, {
      ...baseOptions,
      lockHeartbeatMs: 1_000,
      approvalCommitHook: async () => {
        oldStarted?.();
        await oldGate;
      },
    });
    const oldApproval = oldStore.approve("old approval", 0);
    await oldReady;
    await new Promise((resolve) => setTimeout(resolve, 40));

    const recovered = await new PlanStore(cwd, { ...baseOptions, lockHeartbeatMs: 5 }).load();
    assert.equal(recovered.manifest.status, "draft");

    const replacementStore = new PlanStore(cwd, {
      ...baseOptions,
      lockHeartbeatMs: 5,
      approvalCommitHook: async () => {
        replacementStarted?.();
        await replacementGate;
      },
    });
    const replacementApproval = replacementStore.approve("replacement approval", recovered.manifest.revision);
    await replacementReady;

    releaseOld?.();
    await assert.rejects(
      oldApproval,
      (error) => error instanceof PlanApprovalError && /ownership was lost/.test(error.message),
    );
    const replacementPending = JSON.parse(await readFile(replacementStore.pendingPath, "utf8"));
    const replacementOwner = JSON.parse(await readFile(replacementStore.lockOwnerPath, "utf8"));
    assert.equal(replacementPending.token, replacementOwner.token);

    releaseReplacement?.();
    const approved = await replacementApproval;
    assert.equal(
      await readFile(join(replacementStore.plansDir, approved.manifest.approvedPath!), "utf8"),
      "replacement approval",
    );
  } finally {
    releaseOld?.();
    releaseReplacement?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore serializes approval commit and concurrent recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-approval-lock-"));
  let releaseCommit: (() => void) | undefined;
  let commitStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { commitStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
  try {
    const cwd = join(root, "workspace");
    const options = { rootDir: join(root, "global") };
    const approvingStore = new PlanStore(cwd, {
      ...options,
      approvalCommitHook: async () => {
        commitStarted?.();
        await release;
      },
    });
    const approval = approvingStore.approve("concurrent approval", 0);
    await started;

    let recoveryFinished = false;
    const recovery = new PlanStore(cwd, options).load().then((loaded) => {
      recoveryFinished = true;
      return loaded;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recoveryFinished, false);

    releaseCommit?.();
    const [approved, recovered] = await Promise.all([approval, recovery]);
    assert.equal(recovered.manifest.approvedPath, approved.manifest.approvedPath);
    assert.equal(
      await readFile(join(approvingStore.plansDir, approved.manifest.approvedPath!), "utf8"),
      "concurrent approval",
    );
  } finally {
    releaseCommit?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore keeps a recoverable draft revision when approval commit fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-approval-fail-"));
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      approvalCommitHook: async () => { throw new Error("manifest unavailable"); },
    });
    await assert.rejects(
      store.approve("human buffer", 0),
      (error) => error instanceof PlanApprovalError
        && error.revision === 1
        && error.draftPersisted,
    );
    const recovered = await store.load();
    assert.equal(recovered.markdown, "human buffer");
    assert.equal(recovered.manifest.revision, 1);
    assert.equal(recovered.manifest.status, "draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PlanStore keeps a committed approval when pending cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-cleanup-fail-"));
  try {
    const store = new PlanStore(join(root, "workspace"), {
      rootDir: join(root, "global"),
      approvalCleanupHook: async () => { throw new Error("cleanup unavailable"); },
    });
    const approved = await store.approve("committed before cleanup", 0);
    assert.equal(approved.manifest.status, "approved");
    assert.equal(
      await readFile(join(store.plansDir, approved.manifest.approvedPath!), "utf8"),
      "committed before cleanup",
    );
    const reloaded = await new PlanStore(join(root, "workspace"), { rootDir: join(root, "global") }).load();
    assert.equal(reloaded.manifest.approvedPath, approved.manifest.approvedPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function storePathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForCondition(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for deterministic PlanStore test condition");
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checksumText,
  PlanApprovalError,
  PlanRevisionConflictError,
  PlanStore,
  workspaceStorageId,
} from "../src/tools/plan-store.ts";

test("workspace storage IDs are readable and collision resistant", () => {
  const first = workspaceStorageId(join("C:\\work", "demo"));
  const second = workspaceStorageId(join("D:\\other", "demo"));
  assert.match(first, /^demo-[a-f0-9]{8}$/);
  assert.match(second, /^demo-[a-f0-9]{8}$/);
  assert.notEqual(first, second);
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
    assert.ok(approved.manifest.approvedPath);
    const archive = join(store.plansDir, approved.manifest.approvedPath!);
    assert.equal(await readFile(archive, "utf8"), markdown);

    const persistedManifest = JSON.parse(await readFile(store.manifestPath, "utf8"));
    assert.equal(persistedManifest.status, "approved");
    assert.equal(persistedManifest.approvedPath, approved.manifest.approvedPath);
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
  const started = new Promise<void>((resolve) => { commitStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseCommit = resolve; });
  try {
    const cwd = join(root, "workspace");
    const lockOptions = {
      rootDir: join(root, "global"),
      lockStaleMs: 20,
      lockHeartbeatMs: 5,
      lockRetryMs: 2,
      lockTimeoutMs: 1_000,
      isProcessAlive: () => false,
    };
    const owner = new PlanStore(cwd, {
      ...lockOptions,
      approvalCommitHook: async () => {
        commitStarted?.();
        await release;
      },
    });
    const approval = owner.approve("long approval", 0);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 60));

    let recoveryFinished = false;
    const recovery = new PlanStore(cwd, lockOptions).load().then((loaded) => {
      recoveryFinished = true;
      return loaded;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(recoveryFinished, false);

    releaseCommit?.();
    const [approved, recovered] = await Promise.all([approval, recovery]);
    assert.equal(recovered.manifest.approvedPath, approved.manifest.approvedPath);
  } finally {
    releaseCommit?.();
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
    });
    await mkdir(store.lockPath, { recursive: true });
    await writeFile(store.lockOwnerPath, `${JSON.stringify({
      token: "dead-owner",
      pid: 999_999,
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

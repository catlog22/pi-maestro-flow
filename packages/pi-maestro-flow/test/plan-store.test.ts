import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

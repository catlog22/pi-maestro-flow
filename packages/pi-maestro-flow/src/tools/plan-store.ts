import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type PlanExecutionBackend = "standalone" | "workflow";
export type PlanExecutionContextMode = "current" | "compact";
export type PlanWorkflowTarget = "current" | "new";

export interface PlanExecutionChoice {
  backend: PlanExecutionBackend;
  context: PlanExecutionContextMode;
  workflowTarget?: PlanWorkflowTarget;
}

export interface PlanWorkflowBinding {
  status: "pending" | "bound" | "failed";
  handoffKey: string;
  sourceChecksum: string;
  workflowSessionId?: string;
  workflowSessionGeneration?: string;
  artifactId?: string;
  producerRunId?: string;
  executionRunId?: string;
  requestId?: string;
  deliveryId?: string;
  deliveryStatus?: "pending" | "delivered";
  deliveredAt?: string;
  error?: string;
  updatedAt: string;
}

export interface PlanManifest {
  version: 1;
  workspaceId: string;
  workspacePath: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  revision: number;
  status: "draft" | "approved";
  draftChecksum: string;
  updatedAt: string;
  approvedAt?: string;
  approvedPath?: string;
  approvedChecksum?: string;
  handoffKey?: string;
  execution?: PlanExecutionChoice;
  workflowBinding?: PlanWorkflowBinding;
  approvals: string[];
}

export interface LoadedPlan {
  markdown: string;
  manifest: PlanManifest;
  currentPath: string;
  manifestPath: string;
  plansDir: string;
}

export interface LoadedApprovedPlan {
  markdown: string;
  manifest: PlanManifest;
  approvedPath: string;
  plansDir: string;
}

export interface PlanApprovalOptions {
  inheritedHandoffKey?: string;
  execution?: PlanExecutionChoice;
}

export interface PlanStoreOptions {
  rootDir?: string;
  session?: PlanSessionIdentity;
  now?: () => Date;
  approvalCommitHook?: () => Promise<void>;
  approvalCleanupHook?: () => Promise<void>;
  lockStaleMs?: number;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  lockHeartbeatMs?: number;
  lockNow?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: (pid: number) => string | null | Promise<string | null>;
  /** Max number of archived draft revisions kept in drafts/. Older are pruned. Default 20. */
  draftHistoryLimit?: number;
}

export interface PlanSessionIdentity {
  id: string;
  file?: string;
  name?: string;
}

/** A historical draft snapshot archived under drafts/, available for rollback. */
export interface PlanDraftArchiveEntry {
  revision: number;
  checksum: string;
  archivedAt: string;
  /** Path relative to plansDir, e.g. "drafts/20260824T120000Z-r0003-ab12cd34.md". */
  path: string;
}

/** A draft archive entry together with its restored Markdown content. */
export interface PlanDraftArchive extends PlanDraftArchiveEntry {
  markdown: string;
}

interface LockOwner {
  token: string;
  pid: number;
  processIdentity?: string;
  createdAt: number;
  heartbeatAt: number;
}

interface PendingApproval {
  version: 1;
  token: string;
  archiveName: string;
  revision: number;
  checksum: string;
  createdAt: string;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class PlanRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Plan revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "PlanRevisionConflictError";
  }
}

export class PlanApprovalError extends Error {
  constructor(
    message: string,
    readonly revision: number,
    readonly draftPersisted: boolean,
  ) {
    super(message);
    this.name = "PlanApprovalError";
  }
}

export class PlanStore {
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly workspaceDir: string;
  readonly sessionId: string | undefined;
  readonly sessionStorageId: string | undefined;
  readonly plansDir: string;
  readonly approvalsDir: string;
  readonly recoveryDir: string;
  readonly draftsDir: string;
  readonly currentPath: string;
  readonly manifestPath: string;
  readonly pendingPath: string;
  readonly lockPath: string;
  readonly lockOwnerPath: string;

  private readonly legacyPlansDir: string;
  private readonly sessionFile: string | undefined;
  private readonly sessionName: string | undefined;

  private readonly now: () => Date;
  private readonly approvalCommitHook?: () => Promise<void>;
  private readonly approvalCleanupHook?: () => Promise<void>;
  private readonly lockStaleMs: number;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;
  private readonly lockHeartbeatMs: number;
  private readonly lockNow: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly getProcessIdentity: (pid: number) => string | null | Promise<string | null>;
  private readonly draftHistoryLimit: number;

  constructor(cwd: string, options: PlanStoreOptions = {}) {
    this.workspacePath = normalizeWorkspacePath(cwd);
    this.workspaceId = workspaceStorageId(cwd);
    const rootDir = options.rootDir ?? join(homedir(), ".pi", "workspaces");
    this.workspaceDir = join(rootDir, this.workspaceId);
    this.legacyPlansDir = join(this.workspaceDir, "plans");
    this.sessionId = options.session?.id.trim() || undefined;
    this.sessionStorageId = this.sessionId ? planSessionStorageId(this.sessionId) : undefined;
    this.sessionFile = options.session?.file;
    this.sessionName = options.session?.name;
    this.plansDir = this.sessionStorageId
      ? join(this.workspaceDir, "sessions", this.sessionStorageId, "plans")
      : this.legacyPlansDir;
    this.approvalsDir = join(this.plansDir, "approvals");
    this.recoveryDir = join(this.plansDir, "recovery");
    this.draftsDir = join(this.plansDir, "drafts");
    this.currentPath = join(this.plansDir, "current.md");
    this.manifestPath = join(this.plansDir, "manifest.json");
    this.pendingPath = join(this.plansDir, "approval.pending.json");
    this.lockPath = join(this.plansDir, ".transaction-lock");
    this.lockOwnerPath = join(this.lockPath, "owner.json");
    this.now = options.now ?? (() => new Date());
    this.approvalCommitHook = options.approvalCommitHook;
    this.approvalCleanupHook = options.approvalCleanupHook;
    this.lockStaleMs = options.lockStaleMs ?? 5 * 60_000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.lockHeartbeatMs = options.lockHeartbeatMs ?? Math.max(10, Math.min(30_000, Math.floor(this.lockStaleMs / 3)));
    this.lockNow = options.lockNow ?? (() => Date.now());
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.getProcessIdentity = options.getProcessIdentity ?? processIdentity;
    this.draftHistoryLimit = Math.max(0, options.draftHistoryLimit ?? 20);
  }

  async load(): Promise<LoadedPlan> {
    return this.withWorkspaceLock((token) => this.loadUnlocked(token));
  }

  /** Lock-free fast path for display/entry: reads current.md + manifest.json only.
   *  Falls back to the full locked load() when the manifest is missing or stale. */
  async loadQuick(): Promise<LoadedPlan> {
    const markdown = await readOptionalText(this.currentPath);
    const manifest = await this.readManifest();
    if (manifest && manifest.draftChecksum === checksumText(markdown)) {
      return {
        markdown,
        manifest,
        currentPath: this.currentPath,
        manifestPath: this.manifestPath,
        plansDir: this.plansDir,
      };
    }
    return this.load();
  }

  /**
   * Read and validate the immutable approved archive without recovery, locking,
   * chmod, or any other storage mutation.
   */
  async loadApprovedSnapshotReadOnly(): Promise<LoadedApprovedPlan> {
    const manifestDetails = await lstat(this.manifestPath);
    if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile()) {
      throw new Error(`Plan manifest path must be a regular file: ${this.manifestPath}`);
    }
    const raw: unknown = JSON.parse(await readFile(this.manifestPath, "utf8"));
    const manifest = validateManifest(raw, this.workspaceId, this.workspacePath, this.sessionId);
    if (
      manifest.status !== "approved"
      || !manifest.approvedPath
      || !manifest.approvedChecksum
      || !manifest.handoffKey
    ) {
      throw new Error("Plan has no complete approved snapshot");
    }

    const approvedPath = join(this.plansDir, manifest.approvedPath);
    const archiveDetails = await lstat(approvedPath);
    if (archiveDetails.isSymbolicLink() || !archiveDetails.isFile()) {
      throw new Error(`Approved Plan path must be a regular file: ${approvedPath}`);
    }
    const markdown = await readFile(approvedPath, "utf8");
    if (checksumText(markdown) !== manifest.approvedChecksum) {
      throw new Error("Approved Plan archive checksum does not match its manifest");
    }
    return { markdown, manifest, approvedPath, plansDir: this.plansDir };
  }

  async saveDraft(markdown: string, expectedRevision?: number): Promise<LoadedPlan> {
    return this.withWorkspaceLock((token) => this.saveDraftUnlocked(markdown, expectedRevision, token));
  }

  /** List archived draft snapshots (newest revision first), available for rollback. */
  async listDrafts(): Promise<PlanDraftArchiveEntry[]> {
    await ensurePrivateDirectory(this.draftsDir);
    let entries: string[];
    try {
      entries = await readdir(this.draftsDir);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const recovered: PlanDraftArchiveEntry[] = [];
    for (const entry of entries) {
      const parsed = parseDraftArchiveName(entry);
      if (!parsed) continue;
      try {
        const markdown = await readFile(join(this.draftsDir, entry), "utf8");
        const checksum = checksumText(markdown);
        if (!checksum.startsWith(parsed.checksumPrefix)) continue;
        recovered.push({
          revision: parsed.revision,
          checksum,
          archivedAt: parsed.archivedAt,
          path: join("drafts", entry),
        });
      } catch {
        // Unreadable archive is skipped, not fatal.
      }
    }
    return recovered.sort((left, right) => right.revision - left.revision || right.path.localeCompare(left.path));
  }

  /** Read the Markdown of an archived draft by its plansDir-relative path. */
  async readDraft(path: string): Promise<string> {
    return readFile(this.resolveDraftPath(path), "utf8");
  }

  /** Restore a previously archived draft as the current draft (new revision). */
  async restoreDraft(revision: number, expectedCurrentRevision?: number): Promise<LoadedPlan> {
    const drafts = await this.listDrafts();
    const target = drafts.find((entry) => entry.revision === revision);
    if (!target) {
      throw new Error(`Plan draft archive for revision ${revision} was not found`);
    }
    const markdown = await this.readDraft(target.path);
    return this.saveDraft(markdown, expectedCurrentRevision);
  }

  /** Validate and resolve a drafts-relative path, rejecting traversal. */
  private resolveDraftPath(path: string): string {
    const entry = basename(path);
    if (path !== join("drafts", entry) || !parseDraftArchiveName(entry)) {
      throw new Error("Invalid draft archive path");
    }
    return join(this.draftsDir, entry);
  }

  /** Archive the current draft content before it is overwritten, pruning old entries. */
  private async archiveDraft(markdown: string, manifest: PlanManifest, ownerToken: string): Promise<void> {
    await ensurePrivateDirectory(this.draftsDir);
    const checksum = checksumText(markdown);
    const archiveName = `${archiveTimestamp(this.now().toISOString())}-r${String(manifest.revision).padStart(4, "0")}-${checksum.slice(0, 8)}.md`;
    const archivePath = join(this.draftsDir, archiveName);
    await this.assertLockOwnership(ownerToken);
    await atomicWriteText(archivePath, markdown);
    await this.pruneDrafts();
  }

  /** Keep only the newest draftHistoryLimit archive entries. */
  private async pruneDrafts(): Promise<void> {
    if (this.draftHistoryLimit <= 0) return;
    let entries: string[];
    try {
      entries = await readdir(this.draftsDir);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const parsed = entries
      .map((entry) => ({ entry, info: parseDraftArchiveName(entry) }))
      .filter((item): item is { entry: string; info: { revision: number; checksumPrefix: string; archivedAt: string } } => item.info !== null)
      .sort((left, right) => right.info.revision - left.info.revision || right.info.archivedAt.localeCompare(left.info.archivedAt));
    for (const item of parsed.slice(this.draftHistoryLimit)) {
      await rm(join(this.draftsDir, item.entry), { force: true }).catch(() => { /* best effort */ });
    }
  }

  async approve(
    markdown: string,
    expectedRevision?: number,
    options: PlanApprovalOptions = {},
  ): Promise<LoadedPlan> {
    return this.withWorkspaceLock(async (ownerToken) => {
      const draft = await this.saveDraftUnlocked(markdown, expectedRevision, ownerToken);
      let archivePath: string | undefined;
      let pendingToken: string | undefined;
      let committed: LoadedPlan | undefined;
      try {
        const approvedAt = this.now().toISOString();
        const checksum = checksumText(markdown);
        const handoffKey = options.inheritedHandoffKey
          ?? approvalHandoffKey(this.workspaceId, this.sessionId, draft.manifest.revision, checksum);
        const archiveName = `${archiveTimestamp(approvedAt)}-r${String(draft.manifest.revision).padStart(4, "0")}-${checksum.slice(0, 8)}-h${handoffKey}.md`;
        archivePath = join(this.approvalsDir, archiveName);
        pendingToken = ownerToken;
        const pending: PendingApproval = {
          version: 1,
          token: pendingToken,
          archiveName,
          revision: draft.manifest.revision,
          checksum,
          createdAt: approvedAt,
        };
        await atomicWriteJson(this.pendingPath, pending);
        await atomicWriteText(archivePath, markdown);
        await this.approvalCommitHook?.();
        await this.assertLockOwnership(ownerToken);
        const approvedPath = join("approvals", archiveName);

        const manifest: PlanManifest = {
          ...draft.manifest,
          status: "approved",
          approvedAt,
          approvedPath,
          approvedChecksum: checksum,
          handoffKey,
          ...(options.execution ? { execution: normalizeExecutionChoice(options.execution) } : {}),
          ...(options.execution?.backend === "workflow"
            ? {
                workflowBinding: {
                  status: "pending",
                  handoffKey,
                  sourceChecksum: checksum,
                  updatedAt: approvedAt,
                } satisfies PlanWorkflowBinding,
              }
            : {}),
          approvals: [...draft.manifest.approvals, approvedPath],
          updatedAt: approvedAt,
        };
        await atomicWriteJson(this.manifestPath, manifest);
        committed = { ...draft, manifest };
      } catch (error) {
        if (archivePath) await rm(archivePath, { force: true }).catch(() => {});
        if (pendingToken) await this.removePendingIfOwned(pendingToken);
        throw new PlanApprovalError(
          `Plan approval commit failed: ${errorMessage(error)}`,
          draft.manifest.revision,
          true,
        );
      }
      await this.approvalCleanupHook?.().catch(() => {});
      if (pendingToken) await this.removePendingIfOwned(pendingToken).catch(() => {});
      return committed!;
    });
  }

  async updateWorkflowBinding(
    handoffKey: string,
    binding: PlanWorkflowBinding,
  ): Promise<LoadedPlan> {
    return this.withWorkspaceLock(async (ownerToken) => {
      const current = await this.loadUnlocked(ownerToken);
      if (current.manifest.status !== "approved" || current.manifest.handoffKey !== handoffKey) {
        throw new Error("Approved Plan handoff changed before Workflow binding update");
      }
      if (current.manifest.execution?.backend !== "workflow") {
        throw new Error("Approved Plan is not configured for Workflow execution");
      }
      const normalized = normalizeWorkflowBinding(binding, current.manifest);
      assertWorkflowBindingTransition(current.manifest.workflowBinding, normalized);
      const manifest: PlanManifest = {
        ...current.manifest,
        workflowBinding: normalized,
        updatedAt: normalized.updatedAt,
      };
      await this.assertLockOwnership(ownerToken);
      await atomicWriteJson(this.manifestPath, manifest);
      return { ...current, manifest };
    });
  }

  private async loadUnlocked(ownerToken: string): Promise<LoadedPlan> {
    await this.ensureDirectories();
    await this.removeStaleTemps();
    const markdown = await readOptionalText(this.currentPath);
    let manifest = await this.readManifest();
    const checksum = checksumText(markdown);

    await this.recoverPendingApproval(manifest);
    if (manifest && !(await this.manifestArchivesAreValid(manifest))) manifest = null;
    if (manifest) {
      const recoverable = await this.recoverableApprovalPaths();
      if (recoverable.some((path) => !manifest!.approvals.includes(path))) manifest = null;
    }

    if (!manifest) {
      manifest = await this.rebuildManifest(markdown, checksum);
      await this.assertLockOwnership(ownerToken);
      await atomicWriteJson(this.manifestPath, manifest);
    } else {
      if (manifest.status === "approved" && !manifest.handoffKey) {
        manifest = {
          ...manifest,
          handoffKey: approvalHandoffKey(
            this.workspaceId,
            this.sessionId,
            manifest.revision,
            manifest.approvedChecksum!,
          ),
        };
        await this.assertLockOwnership(ownerToken);
        await atomicWriteJson(this.manifestPath, manifest);
      }
      if (manifest.draftChecksum === checksum) {
        await this.assertLockOwnership(ownerToken);
        await this.removeOrphanApprovals(manifest);
        return {
          markdown,
          manifest,
          currentPath: this.currentPath,
          manifestPath: this.manifestPath,
          plansDir: this.plansDir,
        };
      }
      manifest = {
        ...manifest,
        revision: manifest.revision + 1,
        status: "draft",
        draftChecksum: checksum,
        updatedAt: this.now().toISOString(),
      };
      delete manifest.approvedAt;
      delete manifest.approvedPath;
      delete manifest.approvedChecksum;
      delete manifest.handoffKey;
      delete manifest.execution;
      delete manifest.workflowBinding;
      await this.assertLockOwnership(ownerToken);
      await atomicWriteJson(this.manifestPath, manifest);
    }

    await this.assertLockOwnership(ownerToken);
    await this.removeOrphanApprovals(manifest);

    return {
      markdown,
      manifest,
      currentPath: this.currentPath,
      manifestPath: this.manifestPath,
      plansDir: this.plansDir,
    };
  }

  private async saveDraftUnlocked(markdown: string, expectedRevision: number | undefined, ownerToken: string): Promise<LoadedPlan> {
    const current = await this.loadUnlocked(ownerToken);
    assertRevision(expectedRevision, current.manifest.revision);
    // Archive the soon-to-be-overwritten draft so the user can roll back to it.
    if (current.markdown && checksumText(current.markdown) !== checksumText(markdown)) {
      await this.archiveDraft(current.markdown, current.manifest, ownerToken);
    }
    const updatedAt = this.now().toISOString();
    const manifest: PlanManifest = {
      ...this.manifestIdentity(),
      revision: current.manifest.revision + 1,
      status: "draft",
      draftChecksum: checksumText(markdown),
      updatedAt,
      approvals: [...current.manifest.approvals],
    };

    await this.assertLockOwnership(ownerToken);
    await atomicWriteText(this.currentPath, markdown);
    await this.assertLockOwnership(ownerToken);
    await atomicWriteJson(this.manifestPath, manifest);
    return { ...current, markdown, manifest };
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      ensurePrivateDirectory(this.approvalsDir),
      ensurePrivateDirectory(this.recoveryDir),
      ensurePrivateDirectory(this.draftsDir),
    ]);
  }

  private async readManifest(): Promise<PlanManifest | null> {
    try {
      await secureExistingPrivateFile(this.manifestPath);
      const raw: unknown = JSON.parse(await readFile(this.manifestPath, "utf8"));
      return validateManifest(raw, this.workspaceId, this.workspacePath, this.sessionId);
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError || errorMessage(error) === "Invalid Plan manifest") return null;
      throw error;
    }
  }

  private async rebuildManifest(markdown: string, checksum: string): Promise<PlanManifest> {
    const approvals = await this.recoverableApprovalPaths();
    const lastApproval = approvals.at(-1);
    const lastArchive = lastApproval ? await readOptionalText(join(this.plansDir, lastApproval)) : "";
    const lastRevision = approvals.reduce((highest, path) =>
      Math.max(highest, parseArchivePath(path)?.revision ?? 0), 0);
    const approved = Boolean(lastApproval && checksumText(lastArchive) === checksum);
    const updatedAt = this.now().toISOString();
    return {
      ...this.manifestIdentity(),
      revision: lastRevision > 0
        ? lastRevision + (approved ? 0 : 1)
        : markdown ? 1 : 0,
      status: approved ? "approved" : "draft",
      draftChecksum: checksum,
      updatedAt,
      approvals,
      ...(approved && lastApproval
        ? {
            approvedAt: updatedAt,
            approvedPath: lastApproval,
            approvedChecksum: checksum,
            handoffKey: parseArchivePath(lastApproval)?.handoffKey
              ?? approvalHandoffKey(this.workspaceId, this.sessionId, lastRevision, checksum),
          }
        : {}),
    };
  }

  private async recoverableApprovalPaths(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.approvalsDir);
    } catch {
      return [];
    }
    const recovered: Array<{ path: string; revision: number }> = [];
    for (const entry of entries) {
      const parsed = parseArchiveName(entry);
      if (!parsed) continue;
      try {
        const markdown = await readFile(join(this.approvalsDir, entry), "utf8");
        if (!checksumText(markdown).startsWith(parsed.checksumPrefix)) continue;
        recovered.push({ path: join("approvals", entry), revision: parsed.revision });
      } catch {
        // A missing or unreadable archive is not recoverable history.
      }
    }
    return recovered
      .sort((left, right) => left.revision - right.revision || left.path.localeCompare(right.path))
      .map((entry) => entry.path);
  }

  private async withWorkspaceLock<T>(operation: (ownerToken: string) => Promise<T>): Promise<T> {
    await this.prepareSessionStorage();
    await ensurePrivateDirectory(this.plansDir);
    const lockDeadline = performance.now() + this.lockTimeoutMs;
    const ownerProcessIdentity = await this.resolveProcessIdentity(process.pid);
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      ...(ownerProcessIdentity ? { processIdentity: ownerProcessIdentity } : {}),
      createdAt: this.lockNow(),
      heartbeatAt: this.lockNow(),
    };
    for (let attempt = 0; attempt === 0 || performance.now() < lockDeadline; attempt += 1) {
      try {
        await mkdir(this.lockPath, { mode: PRIVATE_DIRECTORY_MODE });
        try {
          await atomicWriteJsonExistingDir(this.lockOwnerPath, owner);
        } catch (error) {
          await removeDirectory(this.lockPath);
          throw error;
        }
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await this.reclaimStaleLock();
        const retryBudget = lockDeadline - performance.now();
        if (retryBudget <= 0) break;
        await delay(Math.min(this.lockRetryMs, retryBudget));
      }
    }
    if (!(await this.lockIsOwnedBy(owner.token))) {
      throw new Error(`Timed out waiting for Plan transaction lock: ${this.lockPath}`);
    }

    let heartbeat = Promise.resolve();
    const heartbeatTimer = setInterval(() => {
      heartbeat = heartbeat.then(() => this.refreshLock(owner)).catch(() => {});
    }, this.lockHeartbeatMs);
    heartbeatTimer.unref?.();
    try {
      return await operation(owner.token);
    } finally {
      clearInterval(heartbeatTimer);
      await heartbeat;
      await this.releaseLock(owner.token);
    }
  }

  private manifestIdentity(): Pick<PlanManifest, "version" | "workspaceId" | "workspacePath" | "sessionId" | "sessionFile" | "sessionName"> {
    return {
      version: 1,
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
      ...(this.sessionName ? { sessionName: this.sessionName } : {}),
    };
  }

  private async prepareSessionStorage(): Promise<void> {
    if (!this.sessionStorageId || await pathExists(this.plansDir)) return;
    await mkdir(dirname(this.plansDir), { recursive: true });
    if (await pathExists(join(this.legacyPlansDir, ".transaction-lock"))) return;
    try {
      await rename(this.legacyPlansDir, this.plansDir);
    } catch (error) {
      if (!isMissingFile(error) && !isAlreadyExists(error)) throw error;
    }
  }

  private async manifestArchivesAreValid(manifest: PlanManifest): Promise<boolean> {
    for (const approvalPath of manifest.approvals) {
      const parsed = parseArchivePath(approvalPath);
      if (!parsed) return false;
      try {
        const markdown = await readFile(join(this.plansDir, approvalPath), "utf8");
        const checksum = checksumText(markdown);
        if (!checksum.startsWith(parsed.checksumPrefix)) return false;
        if (approvalPath === manifest.approvedPath && checksum !== manifest.approvedChecksum) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async recoverPendingApproval(manifest: PlanManifest | null): Promise<void> {
    const pending = await this.readPendingApproval();
    if (!pending) return;
    if (pending === "invalid") {
      const committed = new Set(manifest?.approvals ?? []);
      for (const approvalPath of await this.recoverableApprovalPaths()) {
        if (!committed.has(approvalPath)) {
          await this.quarantineArchive(basename(approvalPath), "invalid-pending");
        }
      }
      return;
    }
    const approvalPath = join("approvals", pending.archiveName);
    if (!manifest?.approvals.includes(approvalPath)) {
      await this.quarantineArchive(pending.archiveName, `pending-${safeLockToken(pending.token)}`);
    }
    await this.removePendingIfOwned(pending.token);
  }

  private async readPendingApproval(): Promise<PendingApproval | "invalid" | null> {
    try {
      await secureExistingPrivateFile(this.pendingPath);
      const raw: unknown = JSON.parse(await readFile(this.pendingPath, "utf8"));
      const pending = validatePendingApproval(raw);
      if (pending) return pending;
      await this.quarantineFile(this.pendingPath, "invalid-pending.json");
      return "invalid";
    } catch (error) {
      if (isMissingFile(error)) return null;
      if (error instanceof SyntaxError) {
        await this.quarantineFile(this.pendingPath, "invalid-pending.json");
        return null;
      }
      throw error;
    }
  }

  private async removePendingIfOwned(token: string): Promise<void> {
    const pending = await this.readPendingApproval();
    if (pending && pending !== "invalid" && pending.token === token) await rm(this.pendingPath, { force: true });
  }

  private async quarantineArchive(archiveName: string, suffix: string): Promise<void> {
    const source = join(this.approvalsDir, archiveName);
    try {
      await this.quarantineFile(source, `${archiveName}.${suffix}`);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private async quarantineFile(source: string, name: string): Promise<void> {
    await ensurePrivateDirectory(this.recoveryDir);
    const destination = join(this.recoveryDir, `${name}.${randomUUID()}`);
    await rename(source, destination);
  }

  private async assertLockOwnership(token: string): Promise<void> {
    if (!(await this.lockIsOwnedBy(token))) {
      throw new Error("Plan transaction lock ownership was lost");
    }
  }

  private async refreshLock(owner: LockOwner): Promise<void> {
    if (!(await this.lockIsOwnedBy(owner.token))) return;
    owner.heartbeatAt = this.lockNow();
    await atomicWriteJsonExistingDir(this.lockOwnerPath, owner);
  }

  private async releaseLock(token: string): Promise<void> {
    if (!(await this.lockIsOwnedBy(token))) return;
    await removeDirectory(this.lockPath);
  }

  private async lockIsOwnedBy(token: string): Promise<boolean> {
    const owner = await this.readLockOwner();
    return owner?.token === token;
  }

  private async reclaimStaleLock(): Promise<void> {
    const observed = await this.readLockIdentity();
    if (!observed || !(await this.lockIdentityIsStale(observed))) return;
    const claimPath = `${this.lockPath}.reclaim-${safeLockToken(observed.token)}`;
    try {
      await mkdir(claimPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw error;
    }
    try {
      const current = await this.readLockIdentity();
      if (!current || current.token !== observed.token || !(await this.lockIdentityIsStale(current))) return;
      const quarantinePath = `${this.lockPath}.stale-${safeLockToken(current.token)}-${randomUUID()}`;
      try {
        await rename(this.lockPath, quarantinePath);
      } catch (error) {
        if (isMissingFile(error)) return;
        throw error;
      }
      await removeDirectory(quarantinePath);
    } finally {
      await removeDirectory(claimPath);
    }
  }

  private async readLockIdentity(): Promise<{ token: string; owner: LockOwner | null; mtimeMs: number } | null> {
    try {
      const details = await stat(this.lockPath);
      const owner = await this.readLockOwner();
      return { token: owner?.token ?? `missing-${Math.floor(details.mtimeMs)}`, owner, mtimeMs: details.mtimeMs };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async readLockOwner(): Promise<LockOwner | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await secureExistingPrivateFile(this.lockOwnerPath);
        const raw: unknown = JSON.parse(await readFile(this.lockOwnerPath, "utf8"));
        return validateLockOwner(raw);
      } catch (error) {
        if (isMissingFile(error) || error instanceof SyntaxError) return null;
        if (isTransientLockReadError(error) && attempt < 4) {
          await delay(2);
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  private async lockIdentityIsStale(identity: { owner: LockOwner | null; mtimeMs: number }): Promise<boolean> {
    const lastActiveAt = identity.owner?.heartbeatAt ?? identity.mtimeMs;
    if (this.lockNow() - lastActiveAt <= this.lockStaleMs) return false;
    if (identity.owner && this.isProcessAlive(identity.owner.pid)) {
      // Legacy owners have no birth identity. Keep them fail-closed while their PID is live.
      if (!identity.owner.processIdentity) return false;
      const liveProcessIdentity = await this.resolveProcessIdentity(identity.owner.pid);
      if (!liveProcessIdentity || liveProcessIdentity === identity.owner.processIdentity) return false;
    }
    return true;
  }

  private async resolveProcessIdentity(pid: number): Promise<string | null> {
    try {
      const identity = await this.getProcessIdentity(pid);
      return typeof identity === "string" && identity.trim() ? identity.trim() : null;
    } catch {
      return null;
    }
  }

  private async removeStaleTemps(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.plansDir);
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.endsWith(".tmp"))
      .map((entry) => rm(join(this.plansDir, entry), { force: true })));
  }

  private async removeOrphanApprovals(manifest: PlanManifest): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.approvalsDir);
    } catch {
      return;
    }
    const committed = new Set(manifest.approvals.map((path) => basename(path)));
    await Promise.all(entries
      .filter((entry) => entry.endsWith(".md") && !committed.has(entry))
      .map(async (entry) => {
        if (parseArchiveName(entry)) {
          await this.quarantineArchive(entry, "uncommitted");
        } else {
          await rm(join(this.approvalsDir, entry), { force: true });
        }
      }));
  }
}

export function workspaceStorageId(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  const slug = basename(resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  return `${slug}-${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}`;
}

export function planSessionStorageId(sessionId: string): string {
  const normalized = sessionId.trim();
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "session";
  return `${slug}-${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}`;
}

export function normalizeWorkspacePath(cwd: string): string {
  const normalized = resolve(cwd).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function checksumText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function approvalHandoffKey(
  workspaceId: string,
  sessionId: string | undefined,
  revision: number,
  checksum: string,
): string {
  return createHash("sha256")
    .update(`${workspaceId}\0${sessionId ?? "workspace"}\0${revision}\0${checksum}`)
    .digest("hex");
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await ensurePrivateDirectory(dirname(filePath));
  await secureExistingPrivateFile(filePath);
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await secureExistingPrivateFile(filePath);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteJsonExistingDir(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(filePath));
  await secureExistingPrivateFile(filePath);
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await secureExistingPrivateFile(filePath);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    await secureExistingPrivateFile(filePath);
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Plan storage path must be a real directory: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function secureExistingPrivateFile(path: string): Promise<void> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Plan storage path must be a regular file: ${path}`);
  }
  if (process.platform !== "win32") await chmod(path, PRIVATE_FILE_MODE);
}

function assertRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new PlanRevisionConflictError(expected, actual);
  }
}

function normalizeExecutionChoice(choice: PlanExecutionChoice): PlanExecutionChoice {
  const normalized = validateExecutionChoice(choice);
  if (!normalized) throw new Error("Invalid Plan execution choice");
  return normalized;
}

function validateExecutionChoice(raw: unknown): PlanExecutionChoice | null {
  if (!isRecord(raw)
    || (raw.backend !== "standalone" && raw.backend !== "workflow")
    || (raw.context !== "current" && raw.context !== "compact")) return null;
  if (raw.backend === "standalone") {
    return raw.workflowTarget === undefined
      ? { backend: "standalone", context: raw.context }
      : null;
  }
  if (raw.workflowTarget !== "current" && raw.workflowTarget !== "new") return null;
  return { backend: "workflow", context: raw.context, workflowTarget: raw.workflowTarget };
}

function normalizeWorkflowBinding(
  binding: PlanWorkflowBinding,
  manifest: Pick<PlanManifest, "handoffKey" | "approvedChecksum">,
): PlanWorkflowBinding {
  const normalized = validateWorkflowBinding(binding, manifest.handoffKey, manifest.approvedChecksum);
  if (!normalized) throw new Error("Invalid Plan Workflow binding");
  return normalized;
}

function assertWorkflowBindingTransition(
  previous: PlanWorkflowBinding | undefined,
  next: PlanWorkflowBinding,
): void {
  if (!previous || previous.status !== "bound") return;
  if (next.status !== "bound") {
    throw new Error("Bound Plan Workflow binding is terminal and cannot be downgraded");
  }
  const identityFields = [
    "handoffKey", "sourceChecksum", "workflowSessionId", "workflowSessionGeneration",
    "artifactId", "producerRunId", "executionRunId", "requestId",
  ] as const;
  if (identityFields.some((field) => previous[field] !== next[field])) {
    throw new Error("Bound Plan Workflow identity cannot be replaced");
  }
  if (previous.deliveryStatus === "delivered" && next.deliveryStatus !== "delivered") {
    throw new Error("Delivered Plan Workflow handoff cannot return to pending");
  }
  if (previous.deliveryId !== undefined && previous.deliveryId !== next.deliveryId) {
    throw new Error("Plan Workflow delivery identity cannot be replaced");
  }
}

function validateWorkflowBinding(
  raw: unknown,
  handoffKey: string | undefined,
  approvedChecksum: string | undefined,
): PlanWorkflowBinding | null {
  if (!isRecord(raw)
    || (raw.status !== "pending" && raw.status !== "bound" && raw.status !== "failed")
    || !isChecksum(raw.handoffKey)
    || !isChecksum(raw.sourceChecksum)
    || raw.handoffKey !== handoffKey
    || raw.sourceChecksum !== approvedChecksum
    || !isIsoDate(raw.updatedAt)) return null;
  for (const field of [
    "workflowSessionId",
    "workflowSessionGeneration",
    "artifactId",
    "producerRunId",
    "executionRunId",
    "requestId",
    "deliveryId",
    "error",
  ] as const) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) return null;
  }
  if (raw.status === "bound"
    && (typeof raw.workflowSessionId !== "string"
      || typeof raw.artifactId !== "string"
      || typeof raw.producerRunId !== "string"
      || typeof raw.requestId !== "string")) return null;
  if (raw.deliveryStatus !== undefined
    && raw.deliveryStatus !== "pending"
    && raw.deliveryStatus !== "delivered") return null;
  if (raw.deliveryStatus !== undefined
    && (raw.status !== "bound" || typeof raw.deliveryId !== "string")) return null;
  if (raw.deliveryId !== undefined && raw.deliveryStatus === undefined) return null;
  if (raw.deliveryStatus === "delivered" && !isIsoDate(raw.deliveredAt)) return null;
  if (raw.deliveryStatus !== "delivered" && raw.deliveredAt !== undefined) return null;
  if (raw.status === "failed" && typeof raw.error !== "string") return null;
  return {
    status: raw.status,
    handoffKey: raw.handoffKey as string,
    sourceChecksum: raw.sourceChecksum as string,
    ...(typeof raw.workflowSessionId === "string" ? { workflowSessionId: raw.workflowSessionId } : {}),
    ...(typeof raw.workflowSessionGeneration === "string" ? { workflowSessionGeneration: raw.workflowSessionGeneration } : {}),
    ...(typeof raw.artifactId === "string" ? { artifactId: raw.artifactId } : {}),
    ...(typeof raw.producerRunId === "string" ? { producerRunId: raw.producerRunId } : {}),
    ...(typeof raw.executionRunId === "string" ? { executionRunId: raw.executionRunId } : {}),
    ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
    ...(typeof raw.deliveryId === "string" ? { deliveryId: raw.deliveryId } : {}),
    ...(raw.deliveryStatus === "pending" || raw.deliveryStatus === "delivered"
      ? { deliveryStatus: raw.deliveryStatus }
      : {}),
    ...(typeof raw.deliveredAt === "string" ? { deliveredAt: raw.deliveredAt } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    updatedAt: raw.updatedAt as string,
  };
}

function validateManifest(
  raw: unknown,
  workspaceId: string,
  workspacePath: string,
  sessionId: string | undefined,
): PlanManifest {
  if (!isRecord(raw)
    || raw.version !== 1
    || raw.workspaceId !== workspaceId
    || raw.workspacePath !== workspacePath
    || (sessionId ? raw.sessionId !== sessionId : raw.sessionId !== undefined)
    || (raw.sessionFile !== undefined && typeof raw.sessionFile !== "string")
    || (raw.sessionName !== undefined && typeof raw.sessionName !== "string")
    || !Number.isInteger(raw.revision)
    || (raw.revision as number) < 0
    || (raw.status !== "draft" && raw.status !== "approved")
    || !isChecksum(raw.draftChecksum)
    || !isIsoDate(raw.updatedAt)
    || !Array.isArray(raw.approvals)) invalidManifest();

  const approvals = raw.approvals as unknown[];
  if (!approvals.every((value): value is string => typeof value === "string" && Boolean(parseArchivePath(value)))) {
    invalidManifest();
  }
  if (new Set(approvals).size !== approvals.length) invalidManifest();
  let previousRevision = 0;
  for (const approvalPath of approvals) {
    const parsed = parseArchivePath(approvalPath)!;
    if (parsed.revision <= previousRevision || parsed.revision > (raw.revision as number)) invalidManifest();
    previousRevision = parsed.revision;
  }

  const execution = raw.execution === undefined ? undefined : validateExecutionChoice(raw.execution);
  if (raw.execution !== undefined && !execution) invalidManifest();
  const workflowBinding = raw.workflowBinding === undefined
    ? undefined
    : validateWorkflowBinding(raw.workflowBinding, raw.handoffKey as string | undefined, raw.approvedChecksum as string | undefined);
  if (raw.workflowBinding !== undefined && !workflowBinding) invalidManifest();

  if (raw.status === "approved") {
    if (!isIsoDate(raw.approvedAt)
      || typeof raw.approvedPath !== "string"
      || !isChecksum(raw.approvedChecksum)
      || (raw.handoffKey !== undefined && !isChecksum(raw.handoffKey))
      || approvals.at(-1) !== raw.approvedPath) invalidManifest();
    if (execution?.backend === "workflow" && !workflowBinding) invalidManifest();
    if (execution?.backend !== "workflow" && workflowBinding) invalidManifest();
    const approvedArchive = parseArchivePath(raw.approvedPath as string);
    if (!approvedArchive
      || approvedArchive.revision !== raw.revision
      || (approvedArchive.handoffKey !== undefined && approvedArchive.handoffKey !== raw.handoffKey)
      || !(raw.approvedChecksum as string).startsWith(approvedArchive.checksumPrefix)) invalidManifest();
  } else if (
    raw.approvedAt !== undefined
    || raw.approvedPath !== undefined
    || raw.approvedChecksum !== undefined
    || raw.handoffKey !== undefined
    || raw.execution !== undefined
    || raw.workflowBinding !== undefined
  ) {
    invalidManifest();
  }

  return {
    version: 1,
    workspaceId,
    workspacePath,
    ...(sessionId ? { sessionId } : {}),
    ...(typeof raw.sessionFile === "string" ? { sessionFile: raw.sessionFile } : {}),
    ...(typeof raw.sessionName === "string" ? { sessionName: raw.sessionName } : {}),
    revision: raw.revision as number,
    status: raw.status,
    draftChecksum: raw.draftChecksum as string,
    updatedAt: raw.updatedAt as string,
    ...(raw.status === "approved"
      ? {
          approvedAt: raw.approvedAt as string,
          approvedPath: raw.approvedPath as string,
          approvedChecksum: raw.approvedChecksum as string,
          ...(typeof raw.handoffKey === "string" ? { handoffKey: raw.handoffKey } : {}),
          ...(execution ? { execution } : {}),
          ...(workflowBinding ? { workflowBinding } : {}),
        }
      : {}),
    approvals,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function invalidManifest(): never {
  throw new Error("Invalid Plan manifest");
}

function parseArchivePath(value: string): { revision: number; checksumPrefix: string; handoffKey?: string } | null {
  const entry = basename(value);
  if (value !== join("approvals", entry)) return null;
  return parseArchiveName(entry);
}

function parseArchiveName(value: string): { revision: number; checksumPrefix: string; handoffKey?: string } | null {
  const match = /^\d{8}T\d{6,9}Z-r(\d+)-([a-f0-9]{8})(?:-h([a-f0-9]{64}))?\.md$/i.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return {
    revision,
    checksumPrefix: match[2].toLowerCase(),
    ...(match[3] ? { handoffKey: match[3].toLowerCase() } : {}),
  };
}

/** Parse a drafts/ archive name: {timestamp}Z-r{revision}-{checksum8}.md (no handoff suffix). */
function parseDraftArchiveName(value: string): { revision: number; checksumPrefix: string; archivedAt: string } | null {
  const match = /^(\d{8}T\d{6,9}Z)-r(\d+)-([a-f0-9]{8})\.md$/i.exec(value);
  if (!match) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  return { revision, checksumPrefix: match[3].toLowerCase(), archivedAt: match[1] };
}

function isChecksum(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  return new Date(value).toISOString() === value;
}

function validateLockOwner(raw: unknown): LockOwner | null {
  if (!isRecord(raw)
    || typeof raw.token !== "string"
    || !raw.token
    || !Number.isInteger(raw.pid)
    || (raw.pid as number) < 0
    || typeof raw.createdAt !== "number"
    || !Number.isFinite(raw.createdAt)
    || typeof raw.heartbeatAt !== "number"
    || !Number.isFinite(raw.heartbeatAt)
    || (raw.processIdentity !== undefined
      && (typeof raw.processIdentity !== "string" || !raw.processIdentity.trim()))) return null;
  return {
    token: raw.token,
    pid: raw.pid as number,
    ...(typeof raw.processIdentity === "string" ? { processIdentity: raw.processIdentity } : {}),
    createdAt: raw.createdAt,
    heartbeatAt: raw.heartbeatAt,
  };
}

function validatePendingApproval(raw: unknown): PendingApproval | null {
  if (!isRecord(raw)
    || raw.version !== 1
    || typeof raw.token !== "string"
    || !raw.token
    || typeof raw.archiveName !== "string"
    || !parseArchiveName(raw.archiveName)
    || !Number.isInteger(raw.revision)
    || (raw.revision as number) < 1
    || !isChecksum(raw.checksum)
    || !isIsoDate(raw.createdAt)) return null;
  const archive = parseArchiveName(raw.archiveName)!;
  if (archive.revision !== raw.revision || !(raw.checksum as string).startsWith(archive.checksumPrefix)) return null;
  return {
    version: 1,
    token: raw.token,
    archiveName: raw.archiveName,
    revision: raw.revision as number,
    checksum: raw.checksum as string,
    createdAt: raw.createdAt as string,
  };
}

function safeLockToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

let ownProcessIdentity: Promise<string | null> | undefined;

function processIdentity(pid: number): Promise<string | null> {
  if (pid !== process.pid) return readProcessIdentity(pid);
  ownProcessIdentity ??= readProcessIdentity(pid).then((identity) => {
    if (!identity) ownProcessIdentity = undefined;
    return identity;
  });
  return ownProcessIdentity;
}

/** Fire-and-forget: warm the own-PID identity cache so later lock acquisitions don't pay the subprocess cost. */
export function prewarmProcessIdentity(): void {
  processIdentity(process.pid).catch(() => {});
}

async function readProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid < 0) return null;
  if (process.platform === "linux") {
    try {
      const [rawStat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const commandEnd = rawStat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fieldsAfterCommand = rawStat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      return startTicks ? `linux:${bootId.trim()}:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const windowsDir = process.env.SystemRoot ?? process.env.WINDIR;
    const powershell = windowsDir
      ? join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const script = `$processInfo = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $processInfo) { $processInfo.CreationDate.ToUniversalTime().Ticks }`;
    const output = await execFileText(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]);
    return output ? `win32:${output}` : null;
  }
  // Unsupported platforms stay fail-closed instead of comparing locale- or timezone-dependent ps output.
  return null;
}

function execFileText(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 2_000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function archiveTimestamp(iso: string): string {
  return iso.replace(/[-:.]/g, "");
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isTransientLockReadError(error: unknown): boolean {
  return isRecord(error) && ["EPERM", "EACCES", "EBUSY"].includes(String(error.code));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 5 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

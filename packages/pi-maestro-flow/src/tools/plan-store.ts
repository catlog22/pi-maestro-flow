import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
  approvals: string[];
}

export interface LoadedPlan {
  markdown: string;
  manifest: PlanManifest;
  currentPath: string;
  manifestPath: string;
  plansDir: string;
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
}

export interface PlanSessionIdentity {
  id: string;
  file?: string;
  name?: string;
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
  }

  async load(): Promise<LoadedPlan> {
    return this.withWorkspaceLock((token) => this.loadUnlocked(token));
  }

  async saveDraft(markdown: string, expectedRevision?: number): Promise<LoadedPlan> {
    return this.withWorkspaceLock((token) => this.saveDraftUnlocked(markdown, expectedRevision, token));
  }

  async approve(markdown: string, expectedRevision?: number, inheritedHandoffKey?: string): Promise<LoadedPlan> {
    return this.withWorkspaceLock(async (ownerToken) => {
      const draft = await this.saveDraftUnlocked(markdown, expectedRevision, ownerToken);
      let archivePath: string | undefined;
      let pendingToken: string | undefined;
      let committed: LoadedPlan | undefined;
      try {
        const approvedAt = this.now().toISOString();
        const checksum = checksumText(markdown);
        const handoffKey = inheritedHandoffKey
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
      mkdir(this.approvalsDir, { recursive: true }),
      mkdir(this.recoveryDir, { recursive: true }),
    ]);
  }

  private async readManifest(): Promise<PlanManifest | null> {
    try {
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
    await mkdir(this.plansDir, { recursive: true });
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
        await mkdir(this.lockPath);
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
    await mkdir(this.recoveryDir, { recursive: true });
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
      await mkdir(claimPath);
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
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
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
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

function assertRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new PlanRevisionConflictError(expected, actual);
  }
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

  if (raw.status === "approved") {
    if (!isIsoDate(raw.approvedAt)
      || typeof raw.approvedPath !== "string"
      || !isChecksum(raw.approvedChecksum)
      || (raw.handoffKey !== undefined && !isChecksum(raw.handoffKey))
      || approvals.at(-1) !== raw.approvedPath) invalidManifest();
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

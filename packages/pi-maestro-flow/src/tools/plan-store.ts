import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface PlanManifest {
  version: 1;
  workspaceId: string;
  workspacePath: string;
  revision: number;
  status: "draft" | "approved";
  draftChecksum: string;
  updatedAt: string;
  approvedAt?: string;
  approvedPath?: string;
  approvedChecksum?: string;
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
  now?: () => Date;
  approvalCommitHook?: () => Promise<void>;
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
  readonly plansDir: string;
  readonly approvalsDir: string;
  readonly currentPath: string;
  readonly manifestPath: string;

  private readonly now: () => Date;
  private readonly approvalCommitHook?: () => Promise<void>;

  constructor(cwd: string, options: PlanStoreOptions = {}) {
    this.workspacePath = normalizeWorkspacePath(cwd);
    this.workspaceId = workspaceStorageId(cwd);
    const rootDir = options.rootDir ?? join(homedir(), ".pi", "workspaces");
    this.plansDir = join(rootDir, this.workspaceId, "plans");
    this.approvalsDir = join(this.plansDir, "approvals");
    this.currentPath = join(this.plansDir, "current.md");
    this.manifestPath = join(this.plansDir, "manifest.json");
    this.now = options.now ?? (() => new Date());
    this.approvalCommitHook = options.approvalCommitHook;
  }

  async load(): Promise<LoadedPlan> {
    await this.ensureDirectories();
    await this.removeStaleTemps();
    const markdown = await readOptionalText(this.currentPath);
    let manifest = await this.readManifest();
    const checksum = checksumText(markdown);

    if (!manifest) {
      manifest = this.newManifest(markdown, checksum);
      await atomicWriteJson(this.manifestPath, manifest);
    } else if (manifest.draftChecksum !== checksum) {
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
      await atomicWriteJson(this.manifestPath, manifest);
    }

    return {
      markdown,
      manifest,
      currentPath: this.currentPath,
      manifestPath: this.manifestPath,
      plansDir: this.plansDir,
    };
  }

  async saveDraft(markdown: string, expectedRevision?: number): Promise<LoadedPlan> {
    const current = await this.load();
    assertRevision(expectedRevision, current.manifest.revision);
    const updatedAt = this.now().toISOString();
    const manifest: PlanManifest = {
      version: 1,
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      revision: current.manifest.revision + 1,
      status: "draft",
      draftChecksum: checksumText(markdown),
      updatedAt,
    };

    await atomicWriteText(this.currentPath, markdown);
    await atomicWriteJson(this.manifestPath, manifest);
    return { ...current, markdown, manifest };
  }

  async approve(markdown: string, expectedRevision?: number): Promise<LoadedPlan> {
    const draft = await this.saveDraft(markdown, expectedRevision);
    try {
      const approvedAt = this.now().toISOString();
      const checksum = checksumText(markdown);
      const archiveName = `${archiveTimestamp(approvedAt)}-r${String(draft.manifest.revision).padStart(4, "0")}-${checksum.slice(0, 8)}.md`;
      const archivePath = join(this.approvalsDir, archiveName);
      await mkdir(this.approvalsDir, { recursive: true });
      await writeFile(archivePath, markdown, { encoding: "utf8", flag: "wx" });
      await this.approvalCommitHook?.();

      const manifest: PlanManifest = {
        ...draft.manifest,
        status: "approved",
        approvedAt,
        approvedPath: join("approvals", archiveName),
        approvedChecksum: checksum,
        updatedAt: approvedAt,
      };
      await atomicWriteJson(this.manifestPath, manifest);
      return { ...draft, manifest };
    } catch (error) {
      throw new PlanApprovalError(
        `Plan approval commit failed: ${errorMessage(error)}`,
        draft.manifest.revision,
        true,
      );
    }
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.approvalsDir, { recursive: true });
  }

  private async readManifest(): Promise<PlanManifest | null> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.manifestPath, "utf8"));
      return validateManifest(raw, this.workspaceId, this.workspacePath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private newManifest(markdown: string, checksum: string): PlanManifest {
    return {
      version: 1,
      workspaceId: this.workspaceId,
      workspacePath: this.workspacePath,
      revision: markdown ? 1 : 0,
      status: "draft",
      draftChecksum: checksum,
      updatedAt: this.now().toISOString(),
    };
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
}

export function workspaceStorageId(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  const slug = basename(resolve(cwd))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
  return `${slug}-${createHash("sha256").update(normalized).digest("hex").slice(0, 8)}`;
}

export function normalizeWorkspacePath(cwd: string): string {
  const normalized = resolve(cwd).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function checksumText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function validateManifest(raw: unknown, workspaceId: string, workspacePath: string): PlanManifest {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.revision !== "number") {
    throw new Error("Invalid Plan manifest");
  }
  return {
    version: 1,
    workspaceId,
    workspacePath,
    revision: raw.revision,
    status: raw.status === "approved" ? "approved" : "draft",
    draftChecksum: typeof raw.draftChecksum === "string" ? raw.draftChecksum : checksumText(""),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    ...(typeof raw.approvedAt === "string" ? { approvedAt: raw.approvedAt } : {}),
    ...(typeof raw.approvedPath === "string" ? { approvedPath: raw.approvedPath } : {}),
    ...(typeof raw.approvedChecksum === "string" ? { approvedChecksum: raw.approvedChecksum } : {}),
  };
}

function archiveTimestamp(iso: string): string {
  return iso.replace(/[-:.]/g, "");
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

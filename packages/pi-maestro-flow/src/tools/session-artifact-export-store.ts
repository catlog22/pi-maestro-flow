import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lockSettingsResource } from "../settings/resource-lock.ts";

const STORE_RELATIVE_DIR = join(".pi", "artifact-exports");
const SIDECAR_VERSION = 1 as const;
const HASH = /^[a-f0-9]{64}$/;

export interface ArtifactExportOwnership {
  version: typeof SIDECAR_VERSION;
  target: string;
  source: string;
  createdAt: string;
  bytes: number;
  contentDigest: string;
  artifactIdDigest: string;
  targetDigest: string;
}

export interface ArtifactExportInspection {
  id: string;
  sidecarPath: string;
  targetPath?: string;
  ownership?: ArtifactExportOwnership;
  sizeBytes: number;
  updatedAt?: string;
  revision: string;
  protectionReason?: string;
}

export type ArtifactExportDeleteStatus = "deleted" | "missing" | "protected" | "stale" | "partial" | "failed";

interface StoreIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface QuarantinedFile {
  originalPath: string;
  quarantinePath: string;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function contained(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function artifactExportOwnershipDir(cwd: string): string {
  return resolve(cwd, STORE_RELATIVE_DIR);
}

function ownershipId(artifactIdDigest: string, targetDigest: string): string {
  return `${artifactIdDigest}-${targetDigest}`;
}

async function ensureStore(cwd: string, expected?: StoreIdentity): Promise<StoreIdentity> {
  const root = resolve(cwd);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Artifact workspace must be a real directory: ${root}`);
  const piDir = join(root, ".pi");
  await mkdir(piDir, { mode: 0o700 }).catch((error) => {
    if (code(error) !== "EEXIST") throw error;
  });
  const piInfo = await lstat(piDir);
  if (!piInfo.isDirectory() || piInfo.isSymbolicLink()) throw new Error(`Artifact ownership parent must be a real directory: ${piDir}`);
  const store = artifactExportOwnershipDir(root);
  await mkdir(store, { mode: 0o700 }).catch((error) => {
    if (code(error) !== "EEXIST") throw error;
  });
  const storeInfo = await lstat(store);
  if (!storeInfo.isDirectory() || storeInfo.isSymbolicLink()) throw new Error(`Artifact ownership store must be a real directory: ${store}`);
  await chmod(store, 0o700);
  const [realRoot, realStore] = await Promise.all([realpath(root), realpath(store)]);
  if (!contained(realRoot, realStore)) throw new Error(`Artifact ownership store escapes workspace: ${realStore}`);
  const identity = { path: store, realPath: realStore, dev: storeInfo.dev, ino: storeInfo.ino };
  if (expected && (identity.path !== expected.path || identity.realPath !== expected.realPath
    || identity.dev !== expected.dev || identity.ino !== expected.ino)) {
    throw new Error(`Artifact ownership store changed while acquiring its lock: ${store}`);
  }
  return identity;
}

async function privateRead(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Artifact ownership must be a regular file: ${path}`);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) throw new Error(`Artifact ownership must be a regular file: ${path}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeSidecarExclusive(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    // Hard-link publication is atomic and fails if the destination appeared;
    // unlike rename it can never replace an existing ownership record.
    await link(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function regularFileDigest(path: string): Promise<{ content: Buffer; dev: number; ino: number }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Artifact file must be a regular non-symlink file: ${path}`);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new Error(`Artifact file changed while opening: ${path}`);
    return { content: await handle.readFile(), dev: info.dev, ino: info.ino };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function restoreQuarantine(file: QuarantinedFile): Promise<boolean> {
  try {
    // link is exclusive: a newly-created pathname is never overwritten.
    await link(file.quarantinePath, file.originalPath);
    await unlink(file.quarantinePath);
    return true;
  } catch {
    return false;
  }
}

async function quarantineVerified(
  path: string,
  expected: { digest: string; dev: number; ino: number },
): Promise<QuarantinedFile> {
  const quarantined: QuarantinedFile = {
    originalPath: path,
    quarantinePath: join(dirname(path), `.${randomUUID()}.artifact-delete`),
  };
  await rename(path, quarantined.quarantinePath);
  try {
    const verified = await regularFileDigest(quarantined.quarantinePath);
    if (verified.dev !== expected.dev || verified.ino !== expected.ino || digest(verified.content) !== expected.digest) {
      throw new Error(`Artifact file changed before quarantine: ${path}`);
    }
    return quarantined;
  } catch (error) {
    const restored = await restoreQuarantine(quarantined);
    if (!restored) throw new Error(`Artifact file changed and could not be safely restored; quarantined at ${quarantined.quarantinePath}`);
    throw error;
  }
}

function parseOwnership(text: string): ArtifactExportOwnership | undefined {
  try {
    const value = JSON.parse(text) as Partial<ArtifactExportOwnership>;
    if (value.version !== SIDECAR_VERSION
      || typeof value.target !== "string" || value.target.length === 0 || isAbsolute(value.target)
      || typeof value.source !== "string" || value.source.length === 0
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || !Number.isSafeInteger(value.bytes) || (value.bytes ?? -1) < 0
      || typeof value.contentDigest !== "string" || !HASH.test(value.contentDigest)
      || typeof value.artifactIdDigest !== "string" || !HASH.test(value.artifactIdDigest)
      || typeof value.targetDigest !== "string" || !HASH.test(value.targetDigest)) return undefined;
    return value as ArtifactExportOwnership;
  } catch {
    return undefined;
  }
}

/**
 * Publish a private ownership record after Markdown is durable. If ownership
 * publication fails, the Markdown is rolled back; a failed rollback leaves it
 * deliberately unmanaged rather than inventing ownership.
 */
export async function recordArtifactExportOwnership(input: {
  cwd: string;
  writtenPath: string;
  source: string;
  artifactId: string;
  markdown: string;
  createdAt: Date;
}): Promise<void> {
  const root = resolve(input.cwd);
  const target = resolve(input.writtenPath);
  const relativeTarget = relative(root, target);
  if (!contained(root, target) || isAbsolute(relativeTarget)) throw new Error(`Artifact export escapes workspace: ${target}`);
  const bytes = Buffer.from(input.markdown, "utf8");
  const contentDigest = digest(bytes);
  const initial = await regularFileDigest(target);
  if (!initial.content.equals(bytes)) throw new Error(`Artifact export contents changed before ownership publication: ${target}`);

  try {
    const store = await ensureStore(root);
    const artifactIdDigest = digest(input.artifactId);
    const targetDigest = digest(relativeTarget);
    const ownership: ArtifactExportOwnership = {
      version: SIDECAR_VERSION,
      target: relativeTarget,
      source: input.source,
      createdAt: input.createdAt.toISOString(),
      bytes: bytes.byteLength,
      contentDigest,
      artifactIdDigest,
      targetDigest,
    };
    const sidecarPath = join(store.path, `${ownershipId(artifactIdDigest, targetDigest)}.json`);
    const release = await lockSettingsResource(join(store.path, ".artifact-export-store"));
    try {
      await ensureStore(root, store);
      const current = await regularFileDigest(target);
      if (current.dev !== initial.dev || current.ino !== initial.ino || !current.content.equals(bytes)) {
        throw new Error(`Artifact export changed while publishing ownership: ${target}`);
      }
      await writeSidecarExclusive(sidecarPath, JSON.stringify(ownership));
    } finally {
      await release();
    }
  } catch (error) {
    try {
      const quarantined = await quarantineVerified(target, { digest: contentDigest, dev: initial.dev, ino: initial.ino });
      await unlink(quarantined.quarantinePath);
    } catch (rollbackError) {
      if (code(rollbackError) !== "ENOENT") {
        throw new Error(`Artifact ownership failed and Markdown rollback refused to delete a changed pathname; export remains unmanaged: ${target}`);
      }
    }
    // Never remove an existing sidecar on a collision: it may describe a
    // different, already-managed export. The exclusive writer cleans only its
    // own temporary file.
    throw error;
  }
}

async function inspectSidecar(cwd: string, store: string, fileName: string): Promise<ArtifactExportInspection> {
  const id = fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
  const sidecarPath = join(store, fileName);
  let text: string;
  try {
    text = await privateRead(sidecarPath) ?? "";
  } catch (error) {
    return { id, sidecarPath, sizeBytes: 0, revision: digest(`unreadable:${id}`), protectionReason: error instanceof Error ? error.message : String(error) };
  }
  const revision = digest(text);
  const ownership = parseOwnership(text);
  if (!ownership) return { id, sidecarPath, sizeBytes: 0, revision, protectionReason: "ownership sidecar is invalid" };
  if (id !== ownershipId(ownership.artifactIdDigest, ownership.targetDigest)) {
    return { id, sidecarPath, ownership, sizeBytes: ownership.bytes, updatedAt: ownership.createdAt, revision, protectionReason: "ownership key does not match full digests" };
  }
  const targetPath = resolve(cwd, ownership.target);
  if (!contained(cwd, targetPath) || digest(ownership.target) !== ownership.targetDigest) {
    return { id, sidecarPath, ownership, targetPath, sizeBytes: ownership.bytes, updatedAt: ownership.createdAt, revision, protectionReason: "owned target path escapes the workspace or has a mismatched digest" };
  }
  try {
    const info = await lstat(targetPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("owned target is not a regular non-symlink file");
    const [realRoot, realTarget] = await Promise.all([realpath(cwd), realpath(targetPath)]);
    if (!contained(realRoot, realTarget)) throw new Error("owned target realpath escapes the workspace");
    const content = await readFile(targetPath);
    if (info.size !== ownership.bytes || content.byteLength !== ownership.bytes || digest(content) !== ownership.contentDigest) {
      throw new Error("owned target size or content digest does not match sidecar");
    }
  } catch (error) {
    return { id, sidecarPath, ownership, targetPath, sizeBytes: ownership.bytes, updatedAt: ownership.createdAt, revision, protectionReason: error instanceof Error ? error.message : String(error) };
  }
  return { id, sidecarPath, ownership, targetPath, sizeBytes: ownership.bytes, updatedAt: ownership.createdAt, revision };
}

export async function listArtifactExportOwnership(cwd: string): Promise<ArtifactExportInspection[]> {
  const root = resolve(cwd);
  const store = artifactExportOwnershipDir(root);
  try {
    const info = await lstat(store);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
  const names = (await readdir(store, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(names.map((name) => inspectSidecar(root, store, name)));
}

export async function guardedDeleteArtifactExport(
  cwd: string,
  itemId: string,
  expectedRevision: string,
): Promise<ArtifactExportDeleteStatus> {
  if (!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(itemId) || !HASH.test(expectedRevision)) return "stale";
  const root = resolve(cwd);
  let store: StoreIdentity;
  try {
    // Validate before lock acquisition. lockSettingsResource may create its
    // lock path, so it must never be the operation that first trusts a store.
    store = await ensureStore(root);
  } catch {
    return "protected";
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockSettingsResource(join(store.path, ".artifact-export-store"));
    // A junction/symlink or directory replacement installed while waiting for
    // the lock invalidates the operation before any owned file is touched.
    await ensureStore(root, store);
    const sidecarPath = join(store.path, `${itemId}.json`);
    if (await privateRead(sidecarPath) === undefined) return "missing";
    const current = await inspectSidecar(root, store.path, `${itemId}.json`);
    if (current.revision !== expectedRevision) return "stale";
    if (current.protectionReason || !current.targetPath || !current.ownership) return "protected";

    // Re-inspect at the mutation edge, then atomically move both pathnames to
    // unpredictable same-directory quarantine names. Verification happens on
    // the renamed regular files, so replacement pathnames are never unlinked.
    const final = await inspectSidecar(root, store.path, `${itemId}.json`);
    if (final.revision !== expectedRevision || final.protectionReason || final.targetPath !== current.targetPath || !final.ownership) return "stale";
    const targetExpected = await regularFileDigest(final.targetPath);
    const sidecarExpected = await regularFileDigest(sidecarPath);
    if (digest(targetExpected.content) !== final.ownership.contentDigest || digest(sidecarExpected.content) !== expectedRevision) return "stale";
    await ensureStore(root, store);

    let target: QuarantinedFile;
    try {
      target = await quarantineVerified(final.targetPath, { digest: final.ownership.contentDigest, dev: targetExpected.dev, ino: targetExpected.ino });
    } catch {
      return "stale";
    }
    let sidecar: QuarantinedFile;
    try {
      sidecar = await quarantineVerified(sidecarPath, { digest: expectedRevision, dev: sidecarExpected.dev, ino: sidecarExpected.ino });
    } catch {
      return await restoreQuarantine(target) ? "stale" : "partial";
    }

    // These names are random quarantines whose exact inodes were verified
    // after rename. A failure after either unlink is partial, not a false claim
    // that no destructive progress occurred.
    try {
      await unlink(target.quarantinePath);
    } catch {
      await restoreQuarantine(sidecar);
      await restoreQuarantine(target);
      return "partial";
    }
    try {
      await unlink(sidecar.quarantinePath);
    } catch {
      await restoreQuarantine(sidecar);
      return "partial";
    }
    return "deleted";
  } catch {
    return "protected";
  } finally {
    await release?.().catch(() => undefined);
  }
}

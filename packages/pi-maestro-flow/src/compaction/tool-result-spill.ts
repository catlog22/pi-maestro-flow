import { constants as fsConstants, type Dirent } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lockSettingsResource } from "../settings/resource-lock.ts";

export const SPILL_THRESHOLD_CHARS = 8_000;
export const SPILL_PREVIEW_CHARS = 1_500;
export const SPILL_SUBDIR = "tool-spill";
export const SPILL_OWNER_FILE = ".owner.json";

const PRIVATE_DIRECTORY_MODE = 0o700;
const OWNER_VERSION = 1 as const;
const HASH = /^[a-f0-9]{64}$/;

export interface SpillResult {
  ok: boolean;
  path: string;
  preview: string;
  originalChars: number;
  hasMore: boolean;
  /** SHA-256 of the full persisted text, used to verify it before restoration. */
  contentDigest?: string;
}

export interface SpillOwnerMarker {
  version: typeof OWNER_VERSION;
  sessionId: string;
  sessionDigest: string;
  writerId?: string;
  writerDigest?: string;
  pid: number;
  createdAt: string;
  heartbeatAt: string;
  ownerToken: string;
}

export interface SpillOwnerInspection {
  id: string;
  root: string;
  markerPath: string;
  marker?: SpillOwnerMarker;
  revision: string;
  sizeBytes: number;
  updatedAt?: string;
  processState: "alive" | "dead" | "unknown";
  protectionReason?: string;
}

export function spillContentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fullDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function spillSessionDigest(sessionId: string): string {
  return fullDigest(sessionId);
}

export function spillWriterDigest(writerId: string): string {
  return fullDigest(writerId);
}

function sessionRoot(sessionId: string): string {
  return join(tmpdir(), spillRootName(sessionId));
}

export function spillOwnerRoot(sessionId: string, writerId?: string): string {
  const root = sessionRoot(sessionId);
  return writerId ? join(root, `writer-${pathToken(writerId)}`) : root;
}

export function spillOwnerMarkerPath(sessionId: string, writerId?: string): string {
  return join(spillOwnerRoot(sessionId, writerId), SPILL_OWNER_FILE);
}

export function spillDir(sessionId: string, writerId?: string): string {
  return join(spillOwnerRoot(sessionId, writerId), SPILL_SUBDIR);
}

export function spillPath(sessionId: string, callId: string, writerId?: string): string {
  return join(spillDir(sessionId, writerId), `${pathToken(callId)}.txt`);
}

function spillOwnerLockPath(ownerRoot: string): string {
  // Keep the production lock outside the directory cleanup removes.
  return join(tmpdir(), `.pi-spill-owner-${fullDigest(resolve(ownerRoot))}`);
}

function ownerId(marker: SpillOwnerMarker): string {
  return `${marker.sessionDigest}-${marker.writerDigest ?? "root"}`;
}

function parseOwnerMarker(text: string): SpillOwnerMarker | undefined {
  try {
    const marker = JSON.parse(text) as Partial<SpillOwnerMarker>;
    if (marker.version !== OWNER_VERSION
      || typeof marker.sessionId !== "string" || marker.sessionId.length === 0
      || typeof marker.sessionDigest !== "string" || !HASH.test(marker.sessionDigest)
      || marker.sessionDigest !== spillSessionDigest(marker.sessionId)
      || (marker.writerId === undefined) !== (marker.writerDigest === undefined)
      || (marker.writerId !== undefined && (typeof marker.writerId !== "string" || marker.writerId.length === 0
        || typeof marker.writerDigest !== "string" || !HASH.test(marker.writerDigest)
        || marker.writerDigest !== spillWriterDigest(marker.writerId)))
      || !Number.isSafeInteger(marker.pid) || (marker.pid ?? 0) <= 0
      || typeof marker.createdAt !== "string" || !Number.isFinite(Date.parse(marker.createdAt))
      || typeof marker.heartbeatAt !== "string" || !Number.isFinite(Date.parse(marker.heartbeatAt))
      || typeof marker.ownerToken !== "string" || marker.ownerToken.length < 16) return undefined;
    return marker as SpillOwnerMarker;
  } catch {
    return undefined;
  }
}

function fileCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

async function readPrivate(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Spill owner marker must be a regular file: ${path}`);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) throw new Error(`Spill owner marker must be a regular file: ${path}`);
    return await handle.readFile("utf8");
  } catch (error) {
    if (fileCode(error) === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function replacePrivate(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    const existing = await lstat(path).catch((error) => fileCode(error) === "ENOENT" ? undefined : Promise.reject(error));
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Spill owner marker must be a regular file: ${path}`);
    if (existing && process.platform === "win32") await unlink(path);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function refreshOwnerMarker(sessionId: string, writerId: string | undefined, ownerRoot: string): Promise<boolean> {
  const release = await lockSettingsResource(spillOwnerLockPath(ownerRoot));
  try {
    const path = join(ownerRoot, SPILL_OWNER_FILE);
    const currentText = await readPrivate(path);
    const current = currentText === undefined ? undefined : parseOwnerMarker(currentText);
    if (currentText !== undefined && (!current
      || current.sessionId !== sessionId || current.writerId !== writerId || current.pid !== process.pid)) return false;
    const now = new Date().toISOString();
    const next: SpillOwnerMarker = current
      ? { ...current, heartbeatAt: now }
      : {
        version: OWNER_VERSION,
        sessionId,
        sessionDigest: spillSessionDigest(sessionId),
        ...(writerId ? { writerId, writerDigest: spillWriterDigest(writerId) } : {}),
        pid: process.pid,
        createdAt: now,
        heartbeatAt: now,
        ownerToken: randomUUID(),
      };
    await replacePrivate(path, JSON.stringify(next));
    return true;
  } finally {
    await release();
  }
}

export async function spillToolResult(
  sessionId: string,
  callId: string,
  content: string,
  writerId?: string,
): Promise<SpillResult> {
  const root = sessionRoot(sessionId);
  const ownerRoot = spillOwnerRoot(sessionId, writerId);
  const dir = spillDir(sessionId, writerId);
  const path = spillPath(sessionId, callId, writerId);
  const { preview, hasMore } = generatePreview(content, SPILL_PREVIEW_CHARS);
  const contentDigest = spillContentDigest(content);
  const failure: SpillResult = { ok: false, path: "", preview, originalChars: content.length, hasMore, contentDigest };

  if (!isInside(dir, path)) return failure;
  try {
    if (!await ensurePrivateDirectory(root)
      || (ownerRoot !== root && !await ensurePrivateDirectory(ownerRoot))
      || !await ensurePrivateDirectory(dir)) return failure;
    const realTmp = await realpath(tmpdir());
    const realRoot = await realpath(root);
    const realOwner = await realpath(ownerRoot);
    const realDir = await realpath(dir);
    if (!isInside(realTmp, realRoot)
      || (realOwner !== realRoot && !isInside(realRoot, realOwner))
      || !isInside(realOwner, realDir)) return failure;
    if (!await refreshOwnerMarker(sessionId, writerId, ownerRoot)) return failure;

    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      const errorCode = isNodeError(error) ? error.code : undefined;
      if (errorCode !== "EEXIST" || !await existingSpillMatches(path, realDir, content)) return failure;
    }
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) return failure;
    await chmod(path, 0o600);
  } catch {
    return failure;
  }
  return { ok: true, path, preview, originalChars: content.length, hasMore, contentDigest };
}

/** Validate a persisted spill path before restoration advertises it. */
export async function validateSpillPath(
  sessionId: string,
  path: string,
  writerId?: string,
  expectedContentDigest?: string,
): Promise<boolean> {
  const root = sessionRoot(sessionId);
  const dir = spillDir(sessionId, writerId);
  if (!isInside(dir, path)) return false;
  try {
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) return false;
    const realTmp = await realpath(tmpdir());
    const realRoot = await realpath(root);
    const realDir = await realpath(dir);
    const realTarget = await realpath(path);
    if (!isInside(realTmp, realRoot) || !isInside(realRoot, realDir) || !isInside(realDir, realTarget)) return false;
    if (expectedContentDigest === undefined) return true;
    return spillContentDigest(await readFile(path, "utf8")) === expectedContentDigest;
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") return false;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  await chmod(path, PRIVATE_DIRECTORY_MODE);
  return true;
}

async function existingSpillMatches(path: string, realDir: string, content: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const realTarget = await realpath(path);
    if (!isInside(realDir, realTarget)) return false;
    return await readFile(path, "utf8") === content;
  } catch {
    return false;
  }
}

export function generatePreview(content: string, maxChars: number): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) return { preview: content, hasMore: false };
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}

export function buildSpillReplacementText(result: SpillResult, toolName: string): string {
  const sizeLabel = formatChars(result.originalChars);
  if (!result.path) return `[Maestro context pressure: output from ${toolName} (${sizeLabel}) was pruned. Preview:\n${result.preview}${result.hasMore ? "\n..." : ""}]`;
  return [
    "<persisted-output>",
    `Output from ${toolName} saved to: ${result.path} (${sizeLabel})`,
    `Preview (first ${formatChars(result.preview.length)}):`,
    result.preview,
    result.hasMore ? "..." : "",
    "Use read tool with offset/limit to inspect the full output.",
    "</persisted-output>",
  ].filter(Boolean).join("\n");
}

export function spillProcessState(pid: number): "alive" | "dead" | "unknown" {
  if (pid === process.pid) return "alive";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return fileCode(error) === "ESRCH" ? "dead" : "unknown";
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name === SPILL_OWNER_FILE) continue;
      total += (await lstat(join(path, entry.name))).size;
    }
  } catch {
    // Invalid/unreadable roots are protected; size is diagnostic only.
  }
  return total;
}

async function inspectOwnerRoot(root: string): Promise<SpillOwnerInspection> {
  const markerPath = join(root, SPILL_OWNER_FILE);
  const invalidId = `invalid-${fullDigest(resolve(root))}`;
  let text: string | undefined;
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      return { id: invalidId, root, markerPath, revision: fullDigest("invalid-root"), sizeBytes: 0, processState: "unknown", protectionReason: "spill owner root is not a regular non-symlink directory" };
    }
    const realTmp = await realpath(tmpdir());
    const realRoot = await realpath(root);
    if (!isInside(realTmp, realRoot)) throw new Error("spill owner realpath escapes tmpdir");
    text = await readPrivate(markerPath);
  } catch (error) {
    return { id: invalidId, root, markerPath, revision: fullDigest(`unreadable:${resolve(root)}`), sizeBytes: 0, processState: "unknown", protectionReason: error instanceof Error ? error.message : String(error) };
  }
  if (text === undefined) return { id: invalidId, root, markerPath, revision: fullDigest(`missing:${resolve(root)}`), sizeBytes: await directorySize(join(root, SPILL_SUBDIR)), processState: "unknown", protectionReason: "spill owner marker is missing" };
  const revision = fullDigest(text);
  const marker = parseOwnerMarker(text);
  if (!marker) return { id: invalidId, root, markerPath, revision, sizeBytes: await directorySize(join(root, SPILL_SUBDIR)), processState: "unknown", protectionReason: "spill owner marker is invalid" };
  const expectedRoot = spillOwnerRoot(marker.sessionId, marker.writerId);
  if (resolve(expectedRoot) !== resolve(root)) {
    return { id: ownerId(marker), root, markerPath, marker, revision, sizeBytes: 0, updatedAt: marker.heartbeatAt, processState: "unknown", protectionReason: "spill owner path does not match marker identity" };
  }
  const state = spillProcessState(marker.pid);
  return {
    id: ownerId(marker),
    root,
    markerPath,
    marker,
    revision,
    sizeBytes: await directorySize(spillDir(marker.sessionId, marker.writerId)),
    updatedAt: marker.heartbeatAt,
    processState: state,
    ...(state === "dead" ? {} : { protectionReason: state === "alive" ? "spill owner process is alive" : "spill owner process liveness is unknown" }),
  };
}

async function inspectSessionOwners(root: string): Promise<SpillOwnerInspection[]> {
  const rootInfo = await lstat(root).catch((error) => fileCode(error) === "ENOENT" ? undefined : Promise.reject(error));
  if (!rootInfo) return [];
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [await inspectOwnerRoot(root)];
  const children = await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent<string>[]);
  const writerDirs = children.filter((child) => child.name.startsWith("writer-")).map((child) => join(root, child.name));
  const results: SpillOwnerInspection[] = [];
  if (children.some((child) => child.name === SPILL_OWNER_FILE) || writerDirs.length === 0) results.push(await inspectOwnerRoot(root));
  for (const writerRoot of writerDirs) results.push(await inspectOwnerRoot(writerRoot));
  return results;
}

/**
 * Inventory only explicitly authorized session roots. This avoids exposing or
 * probing other workspaces' spill owners through the data manager.
 */
export async function listSpillOwnersForSessions(sessionIds: Iterable<string>): Promise<SpillOwnerInspection[]> {
  const results: SpillOwnerInspection[] = [];
  for (const sessionId of new Set(sessionIds)) {
    if (!sessionId) continue;
    results.push(...await inspectSessionOwners(sessionRoot(sessionId)));
  }
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

interface CleanupGuard {
  expectedRevision: string;
  requireDead: true;
  currentSessionDigest?: string;
  authorizeSession: () => Promise<boolean>;
}

/**
 * Real spill cleanup entry. Guarded data-manager callers provide a revision;
 * lifecycle callers retain the existing unguarded compatibility behavior.
 */
export async function cleanupSpillDir(sessionId: string, writerId?: string, guard?: CleanupGuard): Promise<boolean> {
  const sessionPath = sessionRoot(sessionId);
  const root = spillOwnerRoot(sessionId, writerId);
  if (!isInside(tmpdir(), root)) return false;
  const release = await lockSettingsResource(spillOwnerLockPath(root));
  try {
    let guardedIdentity: { dev: number; ino: number } | undefined;
    if (guard) {
      if (!HASH.test(guard.expectedRevision) || guard.currentSessionDigest === spillSessionDigest(sessionId)) return false;
      const current = await inspectOwnerRoot(root);
      if (!current.marker || current.revision !== guard.expectedRevision || current.protectionReason || current.processState !== "dead") return false;
      const rootInfo = await lstat(root).catch(() => undefined);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return false;
      guardedIdentity = { dev: rootInfo.dev, ino: rootInfo.ino };
      // Authorization is deliberately re-evaluated under the deletion lock so
      // a transcript moved/replaced after preview cannot authorize cleanup.
      if (!await guard.authorizeSession()) return false;
    }
    try {
      if (guardedIdentity) {
        // Rename the path to an unpredictable same-parent quarantine, then bind
        // recursive removal to the directory identity inspected before the
        // authorization await. A replacement installed during that await is
        // restored (when possible) and never recursively deleted.
        const quarantine = join(dirname(root), `.pi-spill-cleanup-${randomUUID()}`);
        await rename(root, quarantine);
        const quarantined = await lstat(quarantine).catch(() => undefined);
        if (!quarantined?.isDirectory() || quarantined.isSymbolicLink()
          || quarantined.dev !== guardedIdentity.dev || quarantined.ino !== guardedIdentity.ino) {
          const replacement = await lstat(root).catch((error) => fileCode(error) === "ENOENT" ? undefined : Promise.reject(error));
          if (!replacement) await rename(quarantine, root).catch(() => undefined);
          return false;
        }
        await rm(quarantine, { recursive: true, force: true });
      } else {
        const stat = await lstat(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          await rm(root, { force: true });
          return true;
        }
        await rm(root, { recursive: true, force: true });
      }
      // Removing one writer must not remove sibling owners. Best-effort prune
      // the now-empty session directory only.
      if (writerId) await rm(sessionPath).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  } finally {
    await release();
  }
}

export async function guardedCleanupSpillOwner(input: {
  sessionId: string;
  writerId?: string;
  expectedRevision: string;
  currentSessionId?: string;
  /** Revalidates current-workspace transcript ownership at the deletion edge. */
  authorizeSession: () => Promise<boolean>;
}): Promise<boolean> {
  return cleanupSpillDir(input.sessionId, input.writerId, {
    expectedRevision: input.expectedRevision,
    requireDead: true,
    ...(input.currentSessionId ? { currentSessionDigest: spillSessionDigest(input.currentSessionId) } : {}),
    authorizeSession: input.authorizeSession,
  });
}

function formatChars(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}K chars`;
  return `${(chars / (1024 * 1024)).toFixed(1)}M chars`;
}

function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "unknown";
}

/** Full SHA-256 digest keeps keyed spill storage collision resistant. */
function pathToken(value: string): string {
  return `${safeToken(value)}-${fullDigest(value)}`;
}

function spillRootName(sessionId: string): string {
  return `pi-spill-${pathToken(sessionId)}`;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

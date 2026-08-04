import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const SPILL_THRESHOLD_CHARS = 8_000;
export const SPILL_PREVIEW_CHARS = 1_500;
export const SPILL_SUBDIR = "tool-spill";

const PRIVATE_DIRECTORY_MODE = 0o700;

export interface SpillResult {
  ok: boolean;
  path: string;
  preview: string;
  originalChars: number;
  hasMore: boolean;
  /** SHA-256 of the full persisted text, used to verify it before restoration. */
  contentDigest?: string;
}

export function spillContentDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function spillDir(sessionId: string, writerId?: string): string {
  const root = join(tmpdir(), spillRootName(sessionId));
  return writerId
    ? join(root, `writer-${pathToken(writerId)}`, SPILL_SUBDIR)
    : join(root, SPILL_SUBDIR);
}

export function spillPath(sessionId: string, callId: string, writerId?: string): string {
  return join(spillDir(sessionId, writerId), `${pathToken(callId)}.txt`);
}

export async function spillToolResult(
  sessionId: string,
  callId: string,
  content: string,
  writerId?: string,
): Promise<SpillResult> {
  const root = join(tmpdir(), spillRootName(sessionId));
  const dir = spillDir(sessionId, writerId);
  const ownerRoot = writerId ? dirname(dir) : root;
  const path = spillPath(sessionId, callId, writerId);
  const { preview, hasMore } = generatePreview(content, SPILL_PREVIEW_CHARS);
  const contentDigest = spillContentDigest(content);
  const failure: SpillResult = {
    ok: false,
    path: "",
    preview,
    originalChars: content.length,
    hasMore,
    contentDigest,
  };

  // Defense in depth: even though both segments are sanitized, refuse to write
  // outside the session's spill directory.
  if (!isInside(dir, path)) {
    return failure;
  }

  try {
    if (!await ensurePrivateDirectory(root)
      || (ownerRoot !== root && !await ensurePrivateDirectory(ownerRoot))
      || !await ensurePrivateDirectory(dir)) return failure;
    const realTmp = await realpath(tmpdir());
    const realRoot = await realpath(root);
    const realDir = await realpath(dir);
    if (!isInside(realTmp, realRoot) || !isInside(realRoot, realDir)) return failure;

    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      const code = isNodeError(error) ? error.code : undefined;
      if (code !== "EEXIST" || !await existingSpillMatches(path, realDir, content)) return failure;
    }
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) return failure;
    await chmod(path, 0o600);
  } catch {
    return failure;
  }

  return { ok: true, path, preview, originalChars: content.length, hasMore, contentDigest };
}

/**
 * Liveness check for a persisted spill path before a restored prune entry may
 * advertise it. Mirrors the write-time defenses of spillToolResult: the path
 * must sit inside this session's spill directory, be a regular non-symlink
 * file, and resolve (realpath) back into the session root under tmpdir. A
 * cleaned tmpdir, a foreign path, or a symlink planted at the expected name
 * all fail so hydration can downgrade to the plain placeholder instead of
 * pointing the model at a dead or attacker-controlled file.
 */
export async function validateSpillPath(
  sessionId: string,
  path: string,
  writerId?: string,
  expectedContentDigest?: string,
): Promise<boolean> {
  const root = join(tmpdir(), spillRootName(sessionId));
  const dir = spillDir(sessionId, writerId);
  if (!isInside(dir, path)) return false;
  try {
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) return false;
    const realTmp = await realpath(tmpdir());
    const realRoot = await realpath(root);
    const realDir = await realpath(dir);
    const realTarget = await realpath(path);
    if (!isInside(realTmp, realRoot) || !isInside(realRoot, realDir) || !isInside(realDir, realTarget)) {
      return false;
    }
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

export function generatePreview(
  content: string,
  maxChars: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) {
    return { preview: content, hasMore: false };
  }
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = lastNewline > maxChars * 0.5 ? lastNewline : maxChars;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}

export function buildSpillReplacementText(result: SpillResult, toolName: string): string {
  const sizeLabel = formatChars(result.originalChars);
  if (!result.path) {
    return `[Maestro context pressure: output from ${toolName} (${sizeLabel}) was pruned. Preview:\n${result.preview}${result.hasMore ? "\n..." : ""}]`;
  }
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

export async function cleanupSpillDir(sessionId: string, writerId?: string): Promise<void> {
  const sessionRoot = join(tmpdir(), spillRootName(sessionId));
  const root = writerId ? join(sessionRoot, `writer-${pathToken(writerId)}`) : sessionRoot;
  // Defense in depth: never let a crafted sessionId escape tmpdir into a
  // recursive force rm.
  if (!isInside(tmpdir(), root)) {
    return;
  }
  try {
    const stat = await lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await rm(root, { force: true });
      return;
    }
    await rm(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function formatChars(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}K chars`;
  return `${(chars / (1024 * 1024)).toFixed(1)}M chars`;
}

// Mirrors safeToken() in maestro-compaction.ts — collapses any character
// outside [a-zA-Z0-9_-] so provider/model-supplied ids cannot inject path
// separators or `..` traversal segments.
function safeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "unknown";
}

/**
 * Path-safe encoding of an untrusted id.
 *
 * Keep the full SHA-256 digest: keyed spill storage must not rely on a 32-bit
 * prefix, and the readable token is diagnostic only.
 */
function pathToken(value: string): string {
  return `${safeToken(value)}-${createHash("sha256").update(value).digest("hex")}`;
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

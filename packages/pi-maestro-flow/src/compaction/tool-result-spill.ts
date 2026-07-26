import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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
}

export function spillDir(sessionId: string): string {
  return join(tmpdir(), spillRootName(sessionId), SPILL_SUBDIR);
}

export function spillPath(sessionId: string, callId: string): string {
  return join(spillDir(sessionId), `${pathToken(callId)}.txt`);
}

export async function spillToolResult(
  sessionId: string,
  callId: string,
  content: string,
): Promise<SpillResult> {
  const dir = spillDir(sessionId);
  const path = spillPath(sessionId, callId);
  const { preview, hasMore } = generatePreview(content, SPILL_PREVIEW_CHARS);
  const failure: SpillResult = { ok: false, path: "", preview, originalChars: content.length, hasMore };

  // Defense in depth: even though both segments are sanitized, refuse to write
  // outside the session's spill directory.
  if (!isInside(dir, path)) {
    return failure;
  }

  try {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (code !== "EEXIST") {
      return failure;
    }
    // EEXIST: the content is already durably persisted at `path`.
  }

  return { ok: true, path, preview, originalChars: content.length, hasMore };
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

export async function cleanupSpillDir(sessionId: string): Promise<void> {
  const root = join(tmpdir(), spillRootName(sessionId));
  // Defense in depth: never let a crafted sessionId escape tmpdir into a
  // recursive force rm.
  if (!isInside(tmpdir(), root)) {
    return;
  }
  try {
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
 * Path-safe *and injective* encoding of an untrusted id.
 *
 * safeToken alone is lossy: it collapses character classes and truncates to 16
 * chars, so two distinct ids can land on one filename. That is harmless for the
 * human-facing knowhow filename it was written for, but not here — spill files
 * are keyed storage, and spillToolResult treats EEXIST as "already persisted",
 * which on a collision would hand back a different call's payload. The digest
 * restores the one-to-one mapping while the readable prefix keeps the directory
 * greppable by eye.
 */
function pathToken(value: string): string {
  return `${safeToken(value)}-${createHash("sha1").update(value).digest("hex").slice(0, 8)}`;
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

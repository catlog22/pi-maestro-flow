import { writeFile } from "node:fs/promises";
import { rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SPILL_THRESHOLD_CHARS = 8_000;
export const SPILL_PREVIEW_CHARS = 1_500;
export const SPILL_SUBDIR = "tool-spill";

export interface SpillResult {
  path: string;
  preview: string;
  originalChars: number;
  hasMore: boolean;
}

export function spillDir(sessionId: string): string {
  return join(tmpdir(), `pi-spill-${sessionId}`, SPILL_SUBDIR);
}

export function spillPath(sessionId: string, callId: string): string {
  return join(spillDir(sessionId), `${callId}.txt`);
}

export async function spillToolResult(
  sessionId: string,
  callId: string,
  content: string,
): Promise<SpillResult> {
  const dir = spillDir(sessionId);
  const path = spillPath(sessionId, callId);
  const { preview, hasMore } = generatePreview(content, SPILL_PREVIEW_CHARS);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = isNodeError(error) ? error.code : undefined;
    if (code !== "EEXIST") {
      return { path: "", preview, originalChars: content.length, hasMore };
    }
  }

  return { path, preview, originalChars: content.length, hasMore };
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
  try {
    await rm(join(tmpdir(), `pi-spill-${sessionId}`), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function formatChars(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}K chars`;
  return `${(chars / (1024 * 1024)).toFixed(1)}M chars`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Identity and history-storage snapshot for the active session. Fields are
 * optional because a command can run before a session file is bound.
 */
export interface SessionLocationInfo {
  sessionId: string | undefined;
  sessionName: string | undefined;
  /** Transcript file backing the session history — the history storage location. */
  sessionFile: string | undefined;
  sessionDir: string | undefined;
}

export interface SessionFileStatus {
  exists: boolean;
  bytes: number | undefined;
  modified: Date | undefined;
}

export interface SessionTranscriptInventoryEntry {
  path: string;
  fileName: string;
  sessionId?: string;
  cwd?: string;
  sizeBytes: number;
  modified: Date;
  /** Full-entropy identity; never expose a truncated filename as an item key. */
  id: string;
  revision: string;
  headerValid: boolean;
}

function fullDigest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readSessionHeader(file: string): Promise<{ sessionId?: string; cwd?: string; valid: boolean }> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const sessionId = typeof parsed.id === "string" ? parsed.id : undefined;
      const cwd = typeof parsed.cwd === "string" ? parsed.cwd : undefined;
      return { sessionId, cwd, valid: parsed.type === "session" && Boolean(sessionId) && Boolean(cwd) };
    }
  } catch {
    // Invalid/unreadable transcript headers remain visible but protected.
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return { valid: false };
}

/**
 * Inventory transcript files in exactly one host-provided session directory.
 * Symlinks and non-regular entries are ignored; callers must treat every
 * returned transcript as read-only host-owned data.
 */
export async function inventorySessionTranscripts(sessionDir: string): Promise<SessionTranscriptInventoryEntry[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }
  const entries: SessionTranscriptInventoryEntry[] = [];
  for (const fileName of names.sort()) {
    if (!fileName.endsWith(".jsonl")) continue;
    const path = join(sessionDir, fileName);
    let info;
    try {
      info = await lstat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const header = await readSessionHeader(path);
    const identity = fullDigest(resolve(path));
    const revision = fullDigest(`${resolve(path)}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}`);
    entries.push({
      path,
      fileName,
      ...(header.sessionId ? { sessionId: header.sessionId } : {}),
      ...(header.cwd ? { cwd: header.cwd } : {}),
      sizeBytes: info.size,
      modified: info.mtime,
      id: `transcript:${identity}`,
      revision,
      headerValid: header.valid,
    });
  }
  return entries;
}

/** Stat the session history file without throwing when it is absent. */
export async function probeSessionFile(sessionFile: string): Promise<SessionFileStatus> {
  try {
    const info = await stat(sessionFile);
    return { exists: true, bytes: info.size, modified: info.mtime };
  } catch {
    return { exists: false, bytes: undefined, modified: undefined };
  }
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Build the human-readable report shown by the `/session-path` command. */
export function formatSessionLocation(info: SessionLocationInfo, status?: SessionFileStatus): string {
  const lines: string[] = [];
  lines.push(`Session ID  : ${info.sessionId ?? "(unknown)"}`);
  if (info.sessionName) lines.push(`Session name: ${info.sessionName}`);
  lines.push(`History file: ${info.sessionFile ?? "(no active session history file)"}`);
  if (info.sessionDir) lines.push(`Session dir : ${info.sessionDir}`);
  if (info.sessionFile && status) {
    if (status.exists) {
      const modified = status.modified ? ` · modified ${status.modified.toISOString()}` : "";
      lines.push(`Status      : exists · ${formatBytes(status.bytes)}${modified}`);
    } else {
      lines.push("Status      : not found on disk");
    }
  }
  return lines.join("\n");
}

/**
 * Resolve a user-supplied export destination against `cwd`. A trailing
 * separator or an existing directory means "copy into this directory keeping
 * the source file name"; anything else is treated as an explicit file path.
 */
export async function resolveExportTarget(arg: string, sourceFile: string, cwd: string): Promise<string> {
  const trimmed = arg.trim();
  const resolved = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) {
    return join(resolved, basename(sourceFile));
  }
  try {
    const info = await stat(resolved);
    if (info.isDirectory()) return join(resolved, basename(sourceFile));
  } catch {
    // Destination does not exist yet — treat it as an explicit file path.
  }
  return resolved;
}

/**
 * Best-effort clipboard write. The copy implementation is injected so the
 * command can pass the SDK's `copyToClipboard` while tests pass a fake.
 * Returns true when the text was copied, false when clipboard access failed.
 */
export async function tryCopyToClipboard(
  text: string,
  copy: (text: string) => Promise<void>,
): Promise<boolean> {
  try {
    await copy(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy the session history file to `targetPath`, creating parent directories. */
export async function exportSessionHistory(
  sourceFile: string,
  targetPath: string,
): Promise<{ written: string; bytes: number }> {
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourceFile, targetPath);
  const info = await stat(targetPath);
  return { written: targetPath, bytes: info.size };
}

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Crash-durable atomic file replacement.
 *
 * A settings write only counts as durable once the new content is both on disk
 * and the containing directory entry is stable: fsync the temp file before the
 * rename (so the bytes survive), then fsync the parent directory after the
 * rename (so the rename itself survives). Directory fsync is unsupported on
 * Windows, so it is skipped there; the temp-file fsync still applies.
 *
 * Writers create the temp file with `wx` + 0600 so an in-flight temp never
 * overwrites another writer's file, and clean up on failure.
 */

/** POSIX-only parent-directory fsync; a no-op on Windows and on filesystems that reject it. */
export function fsyncDirectorySync(dirPath: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(dirPath, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some filesystems (e.g. certain network mounts) reject directory fsync;
    // the temp-file fsync already guarantees content, this only strengthens it.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Async POSIX-only parent-directory fsync; a no-op on Windows and on failures. */
export async function fsyncDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dirPath, "r");
    await handle.sync();
  } catch {
    // best effort, see fsyncDirectorySync
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Sync durable write: fsynced temp + rename + parent-directory fsync. */
export function writeFileDurableSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectorySync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Async durable write: fsynced temp + rename + parent-directory fsync. */
export async function writeFileDurable(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

import fs from "node:fs";
import path from "node:path";

/**
 * Atomic JSON state write for .experts-mode.json (and similar).
 * Writes to a temp file in the same directory then renames (best-effort
 * atomic on Windows with short retries).
 */
export function writeJsonStateFile(
  filePath: string,
  data: unknown,
  opts: { retries?: number } = {},
): void {
  const file = path.resolve(filePath);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(tmp, payload, "utf8");
      try {
        fs.renameSync(tmp, file);
      } catch {
        // Windows: replace existing target
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
        fs.renameSync(tmp, file);
      }
      return;
    } catch (err) {
      lastErr = err;
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  // Last resort: direct write so callers still persist state
  try {
    fs.writeFileSync(file, payload, "utf8");
  } catch (err) {
    throw lastErr || err;
  }
}

export function readJsonStateFile(filePath: string): Record<string, unknown> {
  const file = path.resolve(filePath);
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Per-path async mutex chain (MV-02). */
const lockChains = new Map<string, Promise<void>>();
/** Sync re-entry depth per path (same tick / nested mutate). */
const syncDepth = new Map<string, number>();

function lockKey(filePath: string): string {
  return path.resolve(filePath);
}

/**
 * MV-02: serialize async RMW on a state file.
 * Callers that await between read and write should wrap the whole critical section.
 */
export async function withStateLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = lockKey(filePath);
  const prev = lockChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => gate);
  lockChains.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Drop the chain head when we are still the tail waiter
    if (lockChains.get(key) === next) {
      lockChains.delete(key);
    }
  }
}

/**
 * MV-02: single-process sync critical section for state RMW.
 * Nesting on the same path is allowed (depth counter); concurrent async
 * callers still rely on withStateLock or on not awaiting mid-mutation.
 */
export function withStateLockSync<T>(filePath: string, fn: () => T): T {
  const key = lockKey(filePath);
  const depth = syncDepth.get(key) ?? 0;
  syncDepth.set(key, depth + 1);
  try {
    return fn();
  } finally {
    const d = (syncDepth.get(key) ?? 1) - 1;
    if (d <= 0) syncDepth.delete(key);
    else syncDepth.set(key, d);
  }
}

/**
 * Read → mutate → atomic write under the sync lock (preferred RMW helper).
 */
export function mutateJsonStateFile(
  filePath: string,
  mutator: (prev: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return withStateLockSync(filePath, () => {
    const prev = readJsonStateFile(filePath);
    const next = mutator({ ...prev });
    writeJsonStateFile(filePath, next);
    return next;
  });
}

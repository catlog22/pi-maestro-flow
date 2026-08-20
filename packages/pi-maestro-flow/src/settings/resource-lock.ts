import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const properLockfile = require("proper-lockfile") as {
  lock(filePath: string, options: LockOptions): Promise<() => Promise<void>>;
  lockSync(filePath: string, options: LockOptions): () => void;
};

interface LockOptions {
  realpath: boolean;
  stale: number;
  update: number;
  retries?: { retries: number; factor: number; minTimeout: number; maxTimeout: number };
}

const OPTIONS: LockOptions = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  // Higher retry capacity than a typical settings-file lock needs, so that
  // high-contention mutations (e.g. 12 concurrent fresh-process hook-trust
  // workers locking the same hook-trust.json) do not exhaust retries before
  // the lock frees. Backoff is capped at maxTimeout=500ms, so 64 retries
  // still bounds worst-case wait time to ~30s; settings mutations never
  // approach this, and trust mutations only reach it under heavy contention.
  retries: { retries: 64, factor: 2, minTimeout: 25, maxTimeout: 500 },
};

function lockTarget(filePath: string): string {
  const canonicalPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  return canonicalPath;
}

export function lockSettingsResource(filePath: string): Promise<() => Promise<void>> {
  return properLockfile.lock(lockTarget(filePath), OPTIONS);
}

export function lockSettingsResourceSync(filePath: string): () => void {
  const { retries: _retries, ...syncOptions } = OPTIONS;
  return properLockfile.lockSync(lockTarget(filePath), syncOptions);
}

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
  retries: { retries: 4, factor: 1.5, minTimeout: 25, maxTimeout: 250 },
};

function lockTarget(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

export function lockSettingsResource(filePath: string): Promise<() => Promise<void>> {
  return properLockfile.lock(lockTarget(filePath), OPTIONS);
}

export function lockSettingsResourceSync(filePath: string): () => void {
  const { retries: _retries, ...syncOptions } = OPTIONS;
  return properLockfile.lockSync(lockTarget(filePath), syncOptions);
}

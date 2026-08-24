import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function topLevelEntryNames(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort();
}

export function removeRetiredPackageAgentsFile(packageRoot) {
  const target = join(packageRoot, 'AGENTS.md');
  const removed = existsSync(target);
  rmSync(target, { force: true });
  return { target, removed };
}

export function deployPackagedAgents(canonicalAgentsDir, packageAgentsDir) {
  rmSync(packageAgentsDir, { recursive: true, force: true });
  mkdirSync(packageAgentsDir, { recursive: true });
  let deployed = 0;
  for (const name of topLevelEntryNames(canonicalAgentsDir)) {
    if (!name.endsWith('.md') && !name.endsWith('.schema.json')) continue;
    cpSync(join(canonicalAgentsDir, name), join(packageAgentsDir, name), { recursive: true });
    deployed += 1;
  }
  return { deployed };
}

/**
 * Deploy one generated mirror without deleting canonical Pi-only entries.
 * Entries managed by the previous mirror are cleared first so source deletions
 * propagate, while entries never managed by the mirror survive.
 */
export function deployMirrorSubdir(from, to, previousManagedNames = []) {
  if (!existsSync(from)) return { deployed: 0, removed: 0 };
  mkdirSync(to, { recursive: true });

  let removed = 0;
  for (const name of new Set(previousManagedNames)) {
    const target = join(to, name);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed += 1;
  }

  let deployed = 0;
  for (const name of topLevelEntryNames(from)) {
    const source = join(from, name);
    const target = join(to, name);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
    deployed += 1;
  }
  return { deployed, removed };
}

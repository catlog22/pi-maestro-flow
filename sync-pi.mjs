#!/usr/bin/env node
/**
 * sync-pi.mjs — One-shot sync of the pi-maestro-flow skill/agent mirror.
 *
 * Runs the full 3-phase conversion pipeline that ports the Claude harness
 * (D:/maestro2/.claude) into the pi build output (.pi-sync/), then verifies that
 * every skill subfolder was carried over (the old whitelist bug dropped
 * roles/, specs/, phases/, ... — see convert.mjs).
 *
 *   Phase 1  convert.mjs        copy .claude → .pi-sync/  (full recursive copy)
 *   Phase 2  convert-pi.mjs     Claude patterns → pi  (in-place rewrite)
 *   Phase 3  convert-paths.mjs  legacy package paths → ~/.maestro paths
 *
 * Usage:
 *   node sync-pi.mjs                 # sync .pi-sync/ and verify
 *   node sync-pi.mjs --also-pi       # additionally deploy the converted
 *                                    # mirror (skills/ + agents/) to .pi/
 *   node sync-pi.mjs --skip-verify   # skip the parity check
 *
 * Environment overrides (mainly for verification / phase 2):
 *   PI_SYNC_SRC   source Claude dir   (default D:/maestro2/.claude)
 *   PI_SYNC_DST   pi build output dir (default <repo>/.pi-sync)
 *
 * Exit code: 0 on success, 1 if any phase fails or verification finds a
 * mismatch.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));

const SRC = resolve(process.env.PI_SYNC_SRC || 'D:/maestro2/.claude');
const DST = resolve(process.env.PI_SYNC_DST || join(repoRoot, '.pi-sync'));

const argv = process.argv.slice(2);
const ALSO_PI = argv.includes('--also-pi');
const SKIP_VERIFY = argv.includes('--skip-verify');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) { process.stdout.write(msg + '\n'); }

function runPhase(label, script, extraEnv = {}) {
  log(`\n══════ ${label}: ${script} ══════`);
  const res = spawnSync(process.execPath, [join(repoRoot, script)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    log(`✗ ${label} failed to start: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    log(`✗ ${label} exited with code ${res.status}`);
    process.exit(1);
  }
  log(`✓ ${label} done`);
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

log('pi-maestro-flow sync');
log(`  source: ${SRC}`);
log(`  target: ${DST}`);

if (!existsSync(SRC)) {
  log(`✗ source not found: ${SRC}`);
  process.exit(1);
}

// Phases 2 and 3 honour the destination override. Phase 1 still writes .pi-sync/.
runPhase('Phase 1 (copy .claude → flow)', 'convert.mjs');
runPhase('Phase 2 (Claude → pi rewrite)', 'convert-pi.mjs', {
  PI_MAESTRO_CONVERT_DST: DST,
});
runPhase('Phase 3 (normalize Maestro paths)', 'convert-paths.mjs');

// ---------------------------------------------------------------------------
// Optional skills (选装) — mirror <src>/optional/skills → <repo>/optional/skills
// ---------------------------------------------------------------------------

log('\n══════ Sync optional skills (选装) ══════');
const srcOptional = join(SRC, '..', 'optional', 'skills');
const dstOptional = join(repoRoot, 'optional', 'skills');
if (existsSync(srcOptional)) {
  if (existsSync(dstOptional)) rmSync(dstOptional, { recursive: true, force: true });
  cpSync(srcOptional, dstOptional, { recursive: true });
  log(`  ✓ optional/skills ← ${srcOptional} (${countFiles(dstOptional)} files)`);
} else {
  log('  - source optional/skills not found, skipped');
}

// ---------------------------------------------------------------------------
// Verification — every skill subfolder must be fully ported
// ---------------------------------------------------------------------------

if (!SKIP_VERIFY) {
  log('\n══════ Verify: skill subfolder parity ══════');
  const srcSkills = join(SRC, 'skills');
  const dstSkills = join(DST, 'skills');
  let mismatches = 0;
  let checked = 0;

  if (existsSync(srcSkills)) {
    for (const name of readdirSync(srcSkills)) {
      const sDir = join(srcSkills, name);
      if (!statSync(sDir).isDirectory()) continue;
      checked++;
      const sCount = countFiles(sDir);
      const dCount = countFiles(join(dstSkills, name));
      if (sCount !== dCount) {
        log(`  ✗ ${name}: source=${sCount} target=${dCount}`);
        mismatches++;
      }
    }
  }

  if (mismatches > 0) {
    log(`\n✗ ${mismatches}/${checked} skills lost files during conversion.`);
    process.exit(1);
  }
  log(`✓ ${checked} skills — full parity, no subfolder/file lost.`);
}

// ---------------------------------------------------------------------------
// Optional: deploy the converted mirror from .pi-sync/ to .pi/
// ---------------------------------------------------------------------------

if (ALSO_PI) {
  log('\n══════ Deploy converted mirror to .pi/ ══════');
  const piDir = join(repoRoot, '.pi');
  for (const sub of ['skills', 'agents']) {
    const from = join(DST, sub);
    const to = join(piDir, sub);
    if (!existsSync(from)) continue;
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    log(`  ✓ .pi/${sub} ← .pi-sync/${sub} (${countFiles(to)} files)`);
  }
  // Package mirror: the published pi-maestro-flow npm package ships its role
  // catalog at <pkgRoot>/.pi/agents. The teammate package resolver finds that
  // sibling in global npm installs and uses the workspace-root canonical .pi
  // as a dev/npm-link fallback, so roles remain discoverable from ANY cwd.
  const pkgAgentsDir = join(repoRoot, 'packages', 'pi-maestro-flow', '.pi', 'agents');
  const agentsFrom = join(DST, 'agents');
  if (existsSync(agentsFrom)) {
    if (existsSync(pkgAgentsDir)) rmSync(pkgAgentsDir, { recursive: true, force: true });
    cpSync(agentsFrom, pkgAgentsDir, { recursive: true });
    log(`  ✓ packages/pi-maestro-flow/.pi/agents ← .pi-sync/agents (${countFiles(pkgAgentsDir)} files)`);
  }
}

log('\n✓ sync-pi complete.');

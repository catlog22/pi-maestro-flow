#!/usr/bin/env node
/**
 * Phase 3: Normalize legacy pi-maestro-flow workflow/template references back
 * to Maestro Home. Workflow resources are installed under ~/.maestro and the
 * Pi package's npm location is not a stable public path.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DST = resolve(process.env.PI_SYNC_DST || join(repoRoot, '.pi-sync'));
const LEGACY_PI_PKG = '~/.pi/agent/packages/pi-maestro-flow';
const MAESTRO_HOME = '~/.maestro';

function walkMd(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkMd(full));
    } else if (entry.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

export function transformMaestroPaths(content) {
  return content
    .replaceAll(`${LEGACY_PI_PKG}/workflows/`, `${MAESTRO_HOME}/workflows/`)
    .replaceAll(`${LEGACY_PI_PKG}/templates/`, `${MAESTRO_HOME}/templates/`);
}

export function normalizeMaestroPaths(dst = DEFAULT_DST) {
  const stats = { processed: 0, modified: 0 };
  const allFiles = [
    ...walkMd(join(dst, 'skills')),
    ...walkMd(join(dst, 'agents')),
  ];

  for (const filePath of allFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const modified = transformMaestroPaths(content);

    stats.processed++;
    if (modified !== content) {
      writeFileSync(filePath, modified, 'utf-8');
      stats.modified++;
    }
  }

  return stats;
}

function run() {
  const stats = normalizeMaestroPaths();
  console.log(`\n=== Maestro Path Normalization ===`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Modified: ${stats.modified}`);
  console.log(`Pattern: ${LEGACY_PI_PKG}/workflows/ -> ${MAESTRO_HOME}/workflows/`);
  console.log(`Pattern: ${LEGACY_PI_PKG}/templates/ -> ${MAESTRO_HOME}/templates/`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();

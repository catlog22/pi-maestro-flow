#!/usr/bin/env node
/**
 * Phase 3: Replace ~/.maestro/workflows/ and ~/.maestro/templates/ paths
 * with pi-maestro-flow package-relative paths.
 *
 * Pi packages are installed to ~/.pi/agent/packages/<name>/
 * So workflows become: ~/.pi/agent/packages/pi-maestro-flow/workflows/
 *
 * For local dev: just use the package-local path.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DST = 'D:/pi-maestro-flow/flow';

// Pi package install path
const PI_PKG = '~/.pi/agent/packages/pi-maestro-flow';

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

const stats = { processed: 0, modified: 0 };

const allFiles = [
  ...walkMd(join(DST, 'skills')),
  ...walkMd(join(DST, 'agents')),
];

for (const filePath of allFiles) {
  const content = readFileSync(filePath, 'utf-8');
  let modified = content;

  // Replace ~/.maestro/workflows/ → package path
  modified = modified.replace(
    /~\/\.maestro\/workflows\//g,
    `${PI_PKG}/workflows/`
  );

  // Replace ~/.maestro/templates/ → package path
  modified = modified.replace(
    /~\/\.maestro\/templates\//g,
    `${PI_PKG}/templates/`
  );

  stats.processed++;
  if (modified !== content) {
    writeFileSync(filePath, modified, 'utf-8');
    stats.modified++;
  }
}

console.log(`\n=== Path Replacement ===`);
console.log(`Processed: ${stats.processed}`);
console.log(`Modified: ${stats.modified}`);
console.log(`Pattern: ~/.maestro/workflows/ → ${PI_PKG}/workflows/`);
console.log(`Pattern: ~/.maestro/templates/ → ${PI_PKG}/templates/`);

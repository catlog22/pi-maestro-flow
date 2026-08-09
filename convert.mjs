#!/usr/bin/env node
/**
 * Convert .claude commands/agents/skills → pi-compatible format
 *
 * Commands → Skills (SKILL.md in directories)
 * Agents → Agent definitions (agents/*.md)
 * Skills → Skills (format adjustment)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = 'D:/maestro2/.claude';
const DST = join(dirname(fileURLToPath(import.meta.url)), '.pi-sync');

// --- Frontmatter parser ---
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const rawYaml = match[1];
  const body = match[2];
  const meta = {};

  let currentKey = null;
  let listItems = [];

  for (const line of rawYaml.split(/\r?\n/)) {
    // List item
    if (/^\s+-\s+/.test(line) && currentKey) {
      listItems.push(line.replace(/^\s+-\s+/, '').trim());
      continue;
    }

    // Flush previous list
    if (currentKey && listItems.length > 0) {
      meta[currentKey] = listItems;
      listItems = [];
    }

    // Key-value pair
    const kvMatch = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '' || val === '|') {
        // Will collect list items or multiline
        meta[currentKey] = val === '|' ? '|' : '';
      } else {
        meta[currentKey] = val;
        currentKey = null;
      }
    }
  }

  // Flush final list
  if (currentKey && listItems.length > 0) {
    meta[currentKey] = listItems;
  }

  return { meta, body };
}

// --- Convert allowed-tools ---
function convertAllowedTools(tools) {
  if (!tools) return '';

  if (Array.isArray(tools)) {
    return tools.map(t => t.replace(/\(\*\)/g, '').trim()).join(' ');
  }

  if (typeof tools === 'string') {
    // Comma-separated: "Read(*), Write(*), Bash(*)" → "Read Write Bash"
    return tools.split(',')
      .map(t => t.replace(/\(\*\)/g, '').trim())
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

// --- Build SKILL.md frontmatter ---
function buildSkillFrontmatter(meta) {
  const lines = ['---'];

  if (meta.name) lines.push(`name: ${meta.name}`);

  let desc = (meta.description || '').replace(/^["']|["']$/g, '');
  if (meta['argument-hint']) {
    const hint = meta['argument-hint'].replace(/^["']|["']$/g, '');
    desc += ` Arguments: ${hint}`;
  }
  if (desc) lines.push(`description: ${JSON.stringify(desc)}`);

  const tools = convertAllowedTools(meta['allowed-tools']);
  if (tools) lines.push(`allowed-tools: ${tools}`);

  // Preserve other useful fields
  if (meta['auto-continue']) lines.push(`auto-continue: ${meta['auto-continue']}`);
  if (meta['disable-model-invocation']) lines.push(`disable-model-invocation: ${meta['disable-model-invocation']}`);

  lines.push('---');
  return lines.join('\n');
}

// --- Build agent frontmatter ---
function buildAgentFrontmatter(meta) {
  const lines = ['---'];

  if (meta.name) lines.push(`name: ${meta.name}`);
  if (meta.description) {
    const desc = meta.description.replace(/^["']|["']$/g, '');
    lines.push(`description: ${JSON.stringify(desc)}`);
  }

  const tools = meta['allowed-tools'];
  if (tools) {
    if (Array.isArray(tools)) {
      lines.push('tools:');
      for (const t of tools) {
        lines.push(`  - ${t.replace(/\(\*\)/g, '').trim()}`);
      }
    } else if (typeof tools === 'string') {
      const toolList = tools.split(',').map(t => t.replace(/\(\*\)/g, '').trim()).filter(Boolean);
      lines.push('tools:');
      for (const t of toolList) {
        lines.push(`  - ${t}`);
      }
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// --- Stats ---
const stats = { commands: 0, agents: 0, skills: 0, errors: [] };

// === 1. Convert Commands → Skills ===
function convertCommands() {
  const srcDir = join(SRC, 'commands');
  const dstDir = join(DST, 'skills');

  const files = readdirSync(srcDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      const name = meta.name || basename(file, '.md');

      const skillDir = join(dstDir, name);
      mkdirSync(skillDir, { recursive: true });

      const frontmatter = buildSkillFrontmatter(meta);
      const output = frontmatter + '\n\n' + body.trim() + '\n';

      writeFileSync(join(skillDir, 'SKILL.md'), output, 'utf-8');
      stats.commands++;
    } catch (e) {
      stats.errors.push(`command/${file}: ${e.message}`);
    }
  }
}

// === 2. Convert Agents → Agent definitions ===
function convertAgents() {
  const srcDir = join(SRC, 'agents');
  const dstDir = join(DST, 'agents');
  mkdirSync(dstDir, { recursive: true });

  const files = readdirSync(srcDir).filter(f => f.endsWith('.md'));

  for (const file of files) {
    try {
      const content = readFileSync(join(srcDir, file), 'utf-8');
      const { meta, body } = parseFrontmatter(content);

      const frontmatter = buildAgentFrontmatter(meta);
      const output = frontmatter + '\n\n' + body.trim() + '\n';

      writeFileSync(join(dstDir, file), output, 'utf-8');
      stats.agents++;
    } catch (e) {
      stats.errors.push(`agent/${file}: ${e.message}`);
    }
  }
}

// === 3. Convert Skills → Skills ===
function convertSkills() {
  const srcDir = join(SRC, 'skills');
  const dstDir = join(DST, 'skills');

  const dirs = readdirSync(srcDir).filter(d => {
    const full = join(srcDir, d);
    return statSync(full).isDirectory();
  });

  for (const dir of dirs) {
    try {
      const skillFile = join(srcDir, dir, 'SKILL.md');
      if (!existsSync(skillFile)) {
        stats.errors.push(`skill/${dir}: no SKILL.md found`);
        continue;
      }

      const content = readFileSync(skillFile, 'utf-8');
      const { meta, body } = parseFrontmatter(content);

      const targetDir = join(dstDir, dir);
      mkdirSync(targetDir, { recursive: true });

      const frontmatter = buildSkillFrontmatter(meta);
      const output = frontmatter + '\n\n' + body.trim() + '\n';

      // Recursively copy the ENTIRE skill directory so no subsidiary
      // subfolder is lost. The previous hardcoded whitelist
      //   ['scripts', 'references', 'assets']
      // silently dropped every other subfolder (roles/, specs/, phases/,
      // templates/, examples/, workflows/, agents/, index/, wisdom/, ...)
      // plus any non-.md files nested inside them (e.g. team-review lost
      // roles/ and specs/*.json). cpSync carries .md/.json/.ps1/etc. at
      // any depth.
      cpSync(join(srcDir, dir), targetDir, { recursive: true });

      // Overwrite SKILL.md with the frontmatter-converted version
      // (Claude tool names -> pi). Subsidiary .md/.json files are left as
      // raw source here; convert-pi.mjs (phase 2) rewrites them in place.
      writeFileSync(join(targetDir, 'SKILL.md'), output, 'utf-8');

      stats.skills++;
    } catch (e) {
      stats.errors.push(`skill/${dir}: ${e.message}`);
    }
  }
}

// === Execute ===
// Prune stale skill dirs first — .pi-sync/skills must mirror the CURRENT .claude
// source exactly (deleted/renamed skills would otherwise linger forever).
const skillsDst = join(DST, 'skills');
mkdirSync(skillsDst, { recursive: true });
for (const entry of readdirSync(skillsDst)) {
  if (statSync(join(skillsDst, entry)).isDirectory()) {
    rmSync(join(skillsDst, entry), { recursive: true, force: true });
  }
}
mkdirSync(join(DST, 'agents'), { recursive: true });

console.log('Converting commands → skills...');
convertCommands();

console.log('Converting agents → agent definitions...');
convertAgents();

console.log('Converting skills → skills...');
convertSkills();

console.log('\n=== Conversion Complete ===');
console.log(`Commands → Skills: ${stats.commands}`);
console.log(`Agents: ${stats.agents}`);
console.log(`Skills: ${stats.skills}`);
console.log(`Total: ${stats.commands + stats.agents + stats.skills}`);

if (stats.errors.length > 0) {
  console.log(`\nErrors (${stats.errors.length}):`);
  for (const e of stats.errors) {
    console.log(`  - ${e}`);
  }
}

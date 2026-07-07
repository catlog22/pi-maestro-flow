#!/usr/bin/env node
/**
 * Phase 2: Convert Claude-specific patterns → pi-compatible
 *
 * 1. allowed-tools: Claude tool names → pi tool names
 * 2. Body: @~/.maestro/workflows/ → explicit read instructions
 * 3. Body: <required_reading>/<deferred_reading> → markdown
 * 4. Body: Agent/AskUserQuestion/Skill references → pi equivalents
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DST = 'D:/pi-maestro-flow/flow';

// --- Tool name mapping for allowed-tools ---
const TOOL_REMAP = {
  'Agent': 'teammate',
  'AskUserQuestion': null,     // pi handles via conversation
  'Skill': null,               // pi loads skills directly
  'SendMessage': null,         // teammate handles
  'TaskCreate': null,          // not in pi
  'TaskUpdate': null,
  'TaskList': null,
  'TaskGet': null,
  'TaskOutput': null,
  'TaskStop': null,
  'TeamCreate': null,          // Claude-specific
  'TeamDelete': null,
  'TodoWrite': null,
  'mcp__maestro__team_msg': null,
};

// --- Remap allowed-tools line ---
function remapAllowedTools(line) {
  // Parse: "allowed-tools: Read Write Agent AskUserQuestion ..."
  const match = line.match(/^allowed-tools:\s*(.+)$/);
  if (!match) return line;

  const tools = match[1].split(/\s+/).filter(Boolean);
  const mapped = [];
  const seen = new Set();

  for (const tool of tools) {
    const cleaned = tool.replace(/\(\*\)/g, '');
    if (cleaned in TOOL_REMAP) {
      const replacement = TOOL_REMAP[cleaned];
      if (replacement && !seen.has(replacement)) {
        mapped.push(replacement);
        seen.add(replacement);
      }
    } else if (!seen.has(cleaned)) {
      mapped.push(cleaned);
      seen.add(cleaned);
    }
  }

  // Add maestro tool if skills reference maestro CLI
  if (!seen.has('maestro')) {
    mapped.push('maestro');
    seen.add('maestro');
  }

  return `allowed-tools: ${mapped.join(' ')}`;
}

// --- Remap agent tools list ---
function remapAgentTools(content) {
  // Handle YAML list format:
  //   tools:
  //     - Agent
  //     - AskUserQuestion
  const lines = content.split('\n');
  const result = [];
  let inTools = false;
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^tools:\s*$/.test(line)) {
      inTools = true;
      result.push(line);
      continue;
    }

    if (inTools) {
      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch) {
        const tool = itemMatch[1].trim().replace(/\(\*\)/g, '');
        if (tool in TOOL_REMAP) {
          const replacement = TOOL_REMAP[tool];
          if (replacement && !seen.has(replacement)) {
            result.push(`  - ${replacement}`);
            seen.add(replacement);
          }
          // Skip null mappings (remove tool)
        } else if (!seen.has(tool)) {
          result.push(line);
          seen.add(tool);
        }
        continue;
      } else {
        inTools = false;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

// --- Body content transformations ---
function transformBody(body) {
  let result = body;

  // 1. @~/.maestro/workflows/xxx.md → read instruction
  //    <required_reading>@~/.maestro/workflows/xxx.md</required_reading>
  //    → **Required**: Read `~/.maestro/workflows/xxx.md` before proceeding.
  result = result.replace(
    /<required_reading>\s*@?(~\/.maestro\/workflows\/[^\s<]+)\s*<\/required_reading>/g,
    '> **Required**: Read `$1` before proceeding.'
  );

  // 2. <deferred_reading> blocks → reference list
  result = result.replace(
    /<deferred_reading>\s*([\s\S]*?)\s*<\/deferred_reading>/g,
    (_, content) => {
      const items = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
      return '> **Reference files** (read when needed):\n' + items.map(item => {
        return '> ' + item.replace(/@(~\/.maestro\/[^\s)]+)/g, '`$1`');
      }).join('\n');
    }
  );

  // 3. Standalone @~/.maestro/workflows/ references in body
  result = result.replace(
    /^@(~\/.maestro\/workflows\/\S+)/gm,
    'Read and follow `$1`.'
  );

  // 4. Inline @ references (not at line start, not in code blocks)
  result = result.replace(
    /(?<![`"])@(~\/.maestro\/workflows\/\S+)/g,
    '`$1`'
  );

  // 5. "Agent tool" / "Agent(" references → teammate
  result = result.replace(/\bAgent\s+tool\b/g, 'teammate tool');
  result = result.replace(/\bAgent\(\s*\{/g, 'teammate({');
  result = result.replace(/\bspawn(?:ing)?\s+(?:an?\s+)?Agent\b/gi, 'dispatch via teammate');
  result = result.replace(/\bAgent\(\s*name:/g, 'teammate(name:');

  // 6. AskUserQuestion → ask the user
  result = result.replace(/\bAskUserQuestion\b(?!\s*\()/g, 'user prompt');
  result = result.replace(/AskUserQuestion\s*\(\s*\{/g, 'ask user ({');

  // 7. Skill tool references
  result = result.replace(/\bSkill\s*\(\s*\{\s*skill:/g, 'invoke /skill:');
  result = result.replace(/\bSkill\s+tool\b/g, '/skill: command');

  // 8. maestro explore Bash calls → maestro tool action
  // Keep as CLI call since maestro CLI is a dependency, but add note
  // Don't transform these - maestro CLI is available

  return result;
}

// --- Process a single file ---
function processFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  let modified = content;
  let changes = 0;

  // Check if it's an agent file (tools: list format)
  if (filePath.endsWith('.md') && filePath.includes('/agents/')) {
    const before = modified;
    modified = remapAgentTools(modified);
    if (modified !== before) changes++;
  }

  // Check for allowed-tools line (skills)
  if (modified.includes('allowed-tools:')) {
    const lines = modified.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('allowed-tools:')) {
        const newLine = remapAllowedTools(lines[i]);
        if (newLine !== lines[i]) {
          lines[i] = newLine;
          changes++;
        }
      }
    }
    modified = lines.join('\n');
  }

  // Transform body content
  const before = modified;
  modified = transformBody(modified);
  if (modified !== before) changes++;

  if (changes > 0) {
    writeFileSync(filePath, modified, 'utf-8');
  }

  return changes;
}

// --- Walk directories ---
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

// === Execute ===
const stats = { processed: 0, modified: 0, errors: [] };

// Process skills
const skillFiles = walkMd(join(DST, 'skills'));
for (const f of skillFiles) {
  try {
    const changes = processFile(f);
    stats.processed++;
    if (changes > 0) stats.modified++;
  } catch (e) {
    stats.errors.push(`${f}: ${e.message}`);
  }
}

// Process agents
const agentFiles = walkMd(join(DST, 'agents'));
for (const f of agentFiles) {
  try {
    const changes = processFile(f);
    stats.processed++;
    if (changes > 0) stats.modified++;
  } catch (e) {
    stats.errors.push(`${f}: ${e.message}`);
  }
}

console.log('\n=== Pi Compatibility Conversion ===');
console.log(`Processed: ${stats.processed}`);
console.log(`Modified: ${stats.modified}`);
if (stats.errors.length > 0) {
  console.log(`Errors (${stats.errors.length}):`);
  for (const e of stats.errors) console.log(`  - ${e}`);
}

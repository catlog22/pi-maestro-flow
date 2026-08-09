#!/usr/bin/env node
/**
 * Phase 2: Convert Claude-specific patterns → pi-compatible
 *
 * 1. allowed-tools: Claude tool names → pi tool names
 * 2. Body: @~/.maestro/workflows/ → explicit read instructions
 * 3. Body: <required_reading>/<deferred_reading> → markdown
 * 4. Body: Agent/AskUserQuestion/Skill references → pi equivalents
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const converterPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(converterPath);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

const defaultDst = join(repoRoot, '.pi-sync');
const DST = resolve(optionValue('--dst') || process.env.PI_MAESTRO_CONVERT_DST || defaultDst);

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
  const carriage = line.endsWith('\r') ? '\r' : '';
  const source = carriage ? line.slice(0, -1) : line;
  const match = source.match(/^allowed-tools:\s*(.+)$/);
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

  // teammate background results are consumed through observe; keep the pair
  // available whenever conversion introduces or preserves teammate.
  if (seen.has('teammate') && !seen.has('observe')) {
    mapped.push('observe');
    seen.add('observe');
  }

  // Add maestro tool if skills reference maestro CLI
  if (!seen.has('maestro')) {
    mapped.push('maestro');
    seen.add('maestro');
  }

  return `allowed-tools: ${mapped.join(' ')}${carriage}`;
}

// --- Remap agent tools list ---
function remapAgentTools(content) {
  // Handle YAML list format:
  //   tools:
  //     - Agent
  //     - AskUserQuestion
  const usesCrLf = content.includes('\r\n');
  const insertedLine = (value) => `${value}${usesCrLf ? '\r' : ''}`;
  const lines = content.split('\n');
  const result = [];
  let inTools = false;
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const carriage = line.endsWith('\r') ? '\r' : '';
    const source = carriage ? line.slice(0, -1) : line;

    if (/^tools:\s*$/.test(source)) {
      inTools = true;
      result.push(line);
      continue;
    }

    if (inTools) {
      const itemMatch = source.match(/^\s+-\s+(.+)$/);
      if (itemMatch) {
        const tool = itemMatch[1].trim().replace(/\(\*\)/g, '');
        if (tool in TOOL_REMAP) {
          const replacement = TOOL_REMAP[tool];
          if (replacement && !seen.has(replacement)) {
            result.push(`  - ${replacement}${carriage}`);
            seen.add(replacement);
          }
          // Skip null mappings (remove tool)
        } else if (!seen.has(tool)) {
          result.push(line);
          seen.add(tool);
        }
        continue;
      } else {
        if (seen.has('teammate') && !seen.has('observe')) {
          result.push(insertedLine('  - observe'));
          seen.add('observe');
        }
        inTools = false;
      }
    }

    result.push(line);
  }

  if (inTools && seen.has('teammate') && !seen.has('observe')) {
    result.push(insertedLine('  - observe'));
  }

  return result.join('\n');
}

// --- Body content transformations ---
function insertAfter(content, anchor, block) {
  const trimmed = block.trim();
  if (includesBlock(content, trimmed) || !content.includes(anchor)) return content;
  return content.replace(anchor, `${anchor}\n\n${trimmed}`);
}

function insertBefore(content, anchor, block) {
  const trimmed = block.trim();
  if (includesBlock(content, trimmed) || !content.includes(anchor)) return content;
  return content.replace(anchor, `${trimmed}\n${anchor}`);
}

function includesBlock(content, block) {
  return content.replaceAll('\r\n', '\n').includes(block.replaceAll('\r\n', '\n'));
}

function dedupeBlock(content, block) {
  const normalizedBlock = block.trim().replaceAll('\r\n', '\n');
  const source = normalizedBlock
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('\n', '\\r?\\n');
  const matches = [...content.matchAll(new RegExp(source, 'g'))];
  for (let index = matches.length - 1; index > 0; index--) {
    const match = matches[index];
    let start = match.index;
    const precedingBlankLines = content.slice(0, start).match(/(?:\r?\n){2}$/)?.[0];
    if (precedingBlankLines) start -= precedingBlankLines.length;
    content = content.slice(0, start) + content.slice(match.index + match[0].length);
  }
  return content;
}

function replaceAll(content, replacements) {
  let result = content;
  for (const [from, to] of replacements) {
    result = result.replaceAll(from, to);
  }
  return result;
}

function splitFrontmatter(content) {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) return null;
  return { frontmatter: match[1], body: match[2] };
}

function restoreFrontmatterToolAliases(content) {
  const parts = splitFrontmatter(content);
  if (!parts) return content;
  const frontmatter = parts.frontmatter.replace(/\buser prompt\b/g, 'AskUserQuestion');
  return frontmatter + parts.body;
}

function ensureSkillSessionMode(content, filePath) {
  const normalizedPath = normalizePath(filePath);
  if (!normalizedPath.endsWith('/SKILL.md') || !normalizedPath.includes('/skills/')) return content;
  const parts = splitFrontmatter(content);
  if (!parts || /^session-mode\s*:/m.test(parts.frontmatter)) return content;
  const frontmatter = parts.frontmatter.replace(
    /(\r?\n)(---\r?\n?)$/,
    '$1session-mode: none$1$2',
  );
  return frontmatter + parts.body;
}

function remapAllowedToolsInFrontmatter(content) {
  const parts = splitFrontmatter(content);
  if (!parts || !parts.frontmatter.includes('allowed-tools:')) return content;
  const lines = parts.frontmatter.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('allowed-tools:')) {
      const newLine = remapAllowedTools(lines[i]);
      if (newLine !== lines[i]) {
        lines[i] = newLine;
        changed = true;
      }
    }
  }
  return changed ? lines.join('\n') + parts.body : content;
}

const piTeammateContractBlock = `
<teammate_contract>

- \`background: false\` is the default. Use foreground dispatch whenever the result determines the current answer or next action.
- Use \`background: true\` only for independent work. If this turn must consume a background result, call \`observe\` exactly once with \`action: "wait"\` and a bounded timeout before continuing; never continue independently while the result is pending.
- Otherwise end the turn and wait for the automatic \`teammate-complete\` notification. Do not rely on \`SendMessage\`, \`team_msg\`, or hook callbacks as completion signals.
- Never silently ignore an unfinished dispatch.

</teammate_contract>`;

function ensurePiTeammateContract(content, filePath) {
  const path = normalizePath(filePath);
  if (!path.endsWith('/SKILL.md') || !path.includes('/skills/')) return content;
  const parts = splitFrontmatter(content);
  if (!parts || parts.body.includes('<teammate_contract>')) return content;
  const usesTeammate = /allowed-tools:[^\r\n]*\bteammate\b/.test(parts.frontmatter)
    || /\bteammate\s*\(/.test(parts.body);
  if (!usesTeammate) return content;

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const block = piTeammateContractBlock.trim().replaceAll('\n', newline);
  const body = parts.body.replace(/^\r?\n/, '');
  return `${parts.frontmatter}${newline}${block}${newline}${newline}${body}`;
}

const maestroCliSurface = `
<cli_surface>

Human-facing orchestration uses the unified Run surface:

- Single step: \`maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .\`
- Simple command chain: \`maestro run start --platform pi "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .\`
- Advanced chain: \`maestro run start --platform pi "<intent>" --chain-file - --id <session-slug> --no-dispatch --workflow-root .\`
- Completion: \`maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .\`
- Mid-task changes: \`maestro run edit <cmd...> --after latest --workflow-root .\`

\`--chain-file -\` is reserved for advanced coordinator chains that need structured JSON fields such as \`decision_points\`, \`decomposition\`, \`argument_requirements\`, retry budgets, or executor metadata.

</cli_surface>`;

const ralphCliSurface = `
<cli_surface>

Human-facing orchestration should stay on one topic Session:

- Start one step with \`maestro run start "<intent>" --cmd <step> --arg "<step input>" --platform pi --workflow-root .\`
- Start a simple chain with \`maestro run start --platform pi "<intent>" --chain analyze plan execute --no-dispatch --workflow-root .\`
- Complete the active Run with \`maestro run done [run_id] --verdict done|done-with-concerns|needs-retry|blocked --workflow-root .\`
- Add or change future simple steps with \`maestro run edit <cmd...> --after latest --workflow-root .\`

Advanced coordinator chains use \`maestro run start --platform pi "<intent>" --chain-file - --id <session-slug> --no-dispatch\`. Ralph has no separate CLI driver or Session type.

</cli_surface>`;

const piHostMirrorBlock = `
<host_mirror>

Pi mirrors canonical Session/Run state automatically:

- Advance only with \`todo({ action: "next" })\`; do not create or update mirror tasks manually.
- Goal completion is derived from terminal chain state and clean gates.
- After compaction, reattach through the current Run's \`brief.command\`.

</host_mirror>`;

const piCoordinatorContextBlock = `
<pi_context_contract>

- Consume the injected Topic Session resolution and ReuseAssessment as read-only routing evidence.
- Accept upstream only from same-Session sealed outputs.
- Resolve each \`argument_requirements\` entry through \`required\`, \`missing\`, \`type\`, \`source\`, optional \`default\`, and \`question\`.
- Treat the birth packet as compact routing; load the execution protocol from \`brief.command\`.
- A completion hint with \`suggest_only=true\` is displayed and never executed implicitly.

</pi_context_contract>`;

const maestroNextInvariantBlock = '9. simple chain 只通过 `maestro run start --platform pi --chain ... --no-dispatch` 创建；不得为同一任务的每个 skill 新建独立 Session。\n10. 中途新增下一步用 `maestro run edit <cmd...>` 修改未来 chain，不调用新的 `run start` 制造第二个 Topic Session。';

function normalizePath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function bindPiPlatformToLifecycleCalls(content) {
  let result = content;

  result = result.replace(
    /\b(maestro skills\b[^\n`]*?--platform)\s+(?:claude|\{target_platform\})/g,
    '$1 pi',
  );
  result = result.replace(
    /\b(maestro (?:run (?:start|create|prepare|skill|brief)|session (?:start|create)))\b([^\n`]*?--platform)\s+(?:claude|\{target_platform\})/g,
    '$1$2 pi',
  );
  result = result.replace(
    /\bmaestro run (start|create|prepare|skill|brief)\b(?![^\n`]*--platform)/g,
    'maestro run $1 --platform pi',
  );
  result = result.replace(
    /\bmaestro session (start|create)\b(?![^\n`]*--platform)/g,
    'maestro session $1 --platform pi',
  );

  return result;
}

export function transformSessionRunCli(body, filePath) {
  const path = normalizePath(filePath);
  let result = body;

  result = result.replace(
    /^(.*allowed-tools:.*)\buser prompt\b(.*)$/gm,
    '$1AskUserQuestion$2',
  );
  result = replaceAll(result, [
    ['allowed-tools: {tools} # omit if unrestricted maestro', 'allowed-tools: {tools} # omit if unrestricted'],
    ['allowed-tools: Tool1, Tool2 # Optional: restricted tool set maestro', 'allowed-tools: Tool1, Tool2 # Optional: restricted tool set'],
    ['allowed-tools: {tools} maestro', 'allowed-tools: {tools}'],
    ['allowed-tools: {{allowed_tools}} maestro', 'allowed-tools: {{allowed_tools}}'],
    ['allowed-tools: Agent, Read, Write, Glob, Grep, Bash maestro', 'allowed-tools: Agent, Read, Write, Glob, Grep, Bash'],
    ['allowed-tools: Agent, AskUserQuestion, Read, Write maestro', 'allowed-tools: Agent, AskUserQuestion, Read, Write'],
    ['allowed-tools: ${config.allowed_tools.join(", ")} maestro', 'allowed-tools: ${config.allowed_tools.join(", ")}'],
    ['allowed-tools: TeamCreate, TeamDelete, SendMessage, todo({ action: "create" }), "update" "list" "get" teammate, AskUserQuestion, Read, Write, Edit, Bash, Glob, Grep maestro', 'allowed-tools: TeamCreate(*), TeamDelete(*), SendMessage(*), todo({ action: "create" })(*), todo({ action: "update" })(*), todo({ action: "list" })(*), todo({ action: "get" })(*), teammate(*), AskUserQuestion(*), Read(*), Write(*), Edit(*), Bash(*), Glob(*), Grep(*)'],
  ]);

  if (path.endsWith('/skills/maestro/SKILL.md')) {
    result = insertAfter(result, '</purpose>', maestroCliSurface);
    result = insertAfter(result, '</purpose>', piCoordinatorContextBlock);
    result = insertAfter(
      result,
      '5. required missing 依次尝试 known args、default、LLM 明确推断、AskUserQuestion；仍 missing 则 BLOCK。',
      '6. 中途新增或替换未来步骤时，使用 `maestro run edit` 的 insert/replace/remove 与 position/decomposition file 选项。',
    );
    result = result.replace(
      '- `ReuseAssessment=fresh`：通过 `maestro session create ... --engine ralph --chain-file -` 创建 Session。',
      '- `ReuseAssessment=fresh`：简单链使用 `maestro run start "<intent>" --chain <cmd...> --no-dispatch`；高级链使用 `maestro run start "<intent>" --chain-file - --id <session-slug> --no-dispatch`。',
    );
    result = result.replace(
      'Turn a user intent into the initial Skill chain, create one canonical topic Session through `maestro session create --chain-file`, then execute the shared Run loop.',
      'Turn a user intent into the initial Skill chain, create one canonical topic Session through `maestro run start --chain-file`, then execute the shared Run loop.',
    );
    result = result.replace(
      '`maestro session create "{intent}" --id maestro-{slug} --chain-file {path}`',
      '`maestro run start "{intent}" --id maestro-{slug} --chain-file {path} --no-dispatch`',
    );
  }

  if (path.endsWith('/skills/maestro-ralph/SKILL.md')) {
    result = insertAfter(result, '</purpose>', ralphCliSurface);
    result = insertAfter(result, '</purpose>', piCoordinatorContextBlock);
    result = insertAfter(
      result,
      '7. decomposed goals 必须插入 final goal-audit decision。',
      '8. 任务中途新增工作时保持同一 Topic Session，并通过 `maestro run edit` 修改 pending tail。',
    );
    result = result.replace(
      '- 创建独立 Session 时，通过 `maestro session create ... --engine ralph --chain-file -` 写 canonical chain。',
      '- 创建独立 Session 时：简单链使用 `maestro run start "<intent>" --chain <cmd...> --no-dispatch`；含 decision/decomposition/typed args 的 coordinator chain 使用 `maestro run start "<intent>" --chain-file - --id <session-slug> --no-dispatch`。',
    );
  }

  if (path.endsWith('/skills/maestro-next/SKILL.md')) {
    result = insertAfter(result, '</purpose>', piCoordinatorContextBlock);
    result = result.replace(
      '- **Standard** (single run): recommend a step → confirm → execute via `maestro run prepare --platform pi` + `maestro run create`',
      '- **Standard** (single run): recommend a step → confirm → execute via `maestro run start --cmd`',
    );
    result = result.replace(
      '- **Standard** (single run): recommend a step → confirm → execute via `maestro run prepare` + `maestro run start`',
      '- **Standard** (single run): recommend a step → confirm → execute via `maestro run start --cmd`',
    );
    result = result.replace(
      'maestro run prepare --platform pi --workflow-root .   # check if prepare command works',
      'maestro run status --workflow-root .   # read canonical Session/Run position',
    );
    result = result.replace(
      'maestro run prepare   # check if prepare command works',
      'maestro run status --workflow-root .   # read canonical Session/Run position',
    );
    result = result.replace(
      'cat .workflow/state.json 2>/dev/null',
      '# Topic Session resolution and ReuseAssessment are injected read-only inputs',
    );
    result = result.replace(
      '多步工作可逐步调用本 Skill，或显式交给 `/maestro`；本 Skill 不无人值守遍历 chain。',
      '多步工作可逐步调用本 Skill、创建 user-confirmed simple chain，或显式交给 `/maestro`；本 Skill 不无人值守遍历 chain。',
    );
    result = result.replace(
      'Multi-step work has three paths: stepwise (each completed step re-enters lifecycle inference), a user-confirmed manual-engine chain (explicit short chain in session.json, advanced step-by-step via `maestro run next`), or handoff to /maestro. Never auto-orchestrates.',
      'Multi-step work has three paths: stepwise, a user-confirmed simple chain created through `maestro run start --chain ... --no-dispatch`, or handoff to /maestro. Never auto-orchestrates.',
    );
    result = insertAfter(
      result,
      '| `--run` | 强制 standard single-Run channel |',
      '| `--chain` | 用户明确要求多步时，创建 simple manual chain 后停止，不自动派发 |',
    );
    result = insertBefore(
      result,
      '</invariants>',
      maestroNextInvariantBlock,
    );
    result = result.replace(
      '1. `maestro run prepare --platform pi <step> --workflow-root .`。\n2. 使用已解析的 `argument_requirements` 创建当前 step 的 Run；不得用路径扫描补 upstream。\n3. 按 create result 的 `brief.command` 加载完整执行指南。\n4. 执行 workflow，写正式 deliverables，运行 gates。\n5. `maestro run complete <run_id> --verdict done --workflow-root .`。',
      '1. 使用已解析的 `argument_requirements` 创建当前 step 的 Run：\n   `maestro run start "<intent>" --cmd <step> --arg "<resolved step input>" --platform pi --workflow-root .`。\n2. 不得用路径扫描补 upstream；artifact 输入必须来自 authoritative same-Session sealed refs。\n3. 按 start result 的 `brief.command` 加载完整执行指南。\n4. 执行 workflow，写正式 deliverables，运行 gates。\n5. `maestro run done <run_id> --verdict done --workflow-root .`。',
    );
    result = result.replace(
      '4. 完成当前 step 后调用 `maestro run complete <run_id> --verdict done --workflow-root .`。',
      '4. 完成当前 step 后调用 `maestro run done <run_id> --verdict done --workflow-root .`。',
    );
    result = insertAfter(
      result,
      '4. 完成当前 step 后调用 `maestro run done <run_id> --verdict done --workflow-root .`。',
      'Multi-step simple chain：\n\n1. 仅当用户明确选择 `--chain` 或在确认界面选择 simple chain 时进入。\n2. 将 2-5 个 first-tier step 排成命令名列表，展示 topic、chain、argument gaps。\n3. 用户确认后调用：\n   `maestro run start "<intent>" --chain <cmd...> --no-dispatch --platform pi --workflow-root .`。\n4. 展示返回的 `session_id` 与 `maestro run next --session <session_id>`，然后停止；后续每次推进都必须重新由用户确认。\n5. 如果用户在同一任务中追加 step，使用 `maestro run edit <cmd...> --after latest --workflow-root .`，不要创建第二个 Session。',
    );
    result = result.replace(
      /maestro run prepare(?: --platform pi)? <step> --workflow-root \.\n[\s\S]*?maestro run complete <run_id> --workflow-root \./,
      'maestro run start "<short goal>" --cmd <step> --platform pi --workflow-root . [--arg "<required command input>"]\n# Returns run_id, run_dir, authoritative upstream refs, and brief.command.\nmaestro run brief --platform pi <run_id> --workflow-root .\nmaestro run done <run_id> --workflow-root .',
    );
    result = result.replace(
      /For first-tier steps \(those with prepare\/ \+ workflows\/ files\):[\s\S]*?# 3a\. Entry blocker degradation/,
      `For first-tier steps (those with prepare/ + workflows/ files):

\`\`\`bash
# Create one Run through the friendly unified entry.
maestro run start "<short goal>" --cmd <step> --platform pi --workflow-root . [--arg "<required command input>"]
# Returns run_id, run_dir, authoritative upstream refs, entry gates/blockers, and brief.command.
\`\`\`

# Entry blocker degradation`,
    );
    result = result.replaceAll('maestro run complete <run_id>', 'maestro run done <run_id>');
  }

  if (path.endsWith('/skills/maestro-odyssey/SKILL.md')) {
    result = result.replace(
      'Compatibility: `maestro session start` is an alias for `maestro run create` (see companion.md). Both resolve the same lifecycle.',
      'Use `maestro run start` as the only lifecycle entry; no compatibility alias is required.',
    );
  }

  if (
    path.endsWith('/skills/maestro/SKILL.md')
    || path.endsWith('/skills/maestro-ralph/SKILL.md')
    || path.endsWith('/skills/maestro-next/SKILL.md')
    || path.endsWith('/skills/maestro-session-seal/SKILL.md')
  ) {
    result = insertAfter(result, '</required_reading>', piHostMirrorBlock);
  }

  result = replaceAll(result, [
    ['step `roadmap` (`maestro run prepare --platform pi roadmap` + `maestro run create roadmap --session YYYYMMDD-roadmap-{topic} --intent "{goal}"`)', 'step `roadmap` (`maestro run start "{goal}" --cmd roadmap --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `roadmap` (`maestro run prepare roadmap` + `maestro run create roadmap --session YYYYMMDD-roadmap-{topic} --intent "{goal}"`)', 'step `roadmap` (`maestro run start "{goal}" --cmd roadmap --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `blueprint` (`maestro run prepare --platform pi blueprint` + `maestro run create blueprint --session YYYYMMDD-blueprint-{topic} --intent "{goal}"`)', 'step `blueprint` (`maestro run start "{goal}" --cmd blueprint --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `blueprint` (`maestro run prepare blueprint` + `maestro run create blueprint --session YYYYMMDD-blueprint-{topic} --intent "{goal}"`)', 'step `blueprint` (`maestro run start "{goal}" --cmd blueprint --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `brainstorm` (`maestro run prepare --platform pi brainstorm` + `maestro run create brainstorm --session YYYYMMDD-brainstorm-{topic} --intent "{goal}"`)', 'step `brainstorm` (`maestro run start "{goal}" --cmd brainstorm --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `brainstorm` (`maestro run prepare brainstorm` + `maestro run create brainstorm --session YYYYMMDD-brainstorm-{topic} --intent "{goal}"`)', 'step `brainstorm` (`maestro run start "{goal}" --cmd brainstorm --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `quick` (`maestro run prepare --platform pi quick` + `maestro run create quick --session YYYYMMDD-quick-{topic} --intent "{goal}"`)', 'step `quick` (`maestro run start "{goal}" --cmd quick --topic "{topic}" --platform pi --workflow-root .`)'],
    ['`cd {wt.path}` then step `analyze` (`maestro run prepare --platform pi analyze` + `maestro run create analyze --session YYYYMMDD-analyze-{topic} --intent "{goal}"`)', '`cd {wt.path}` then `maestro run start "{goal}" --cmd analyze --topic "{topic}" --platform pi --workflow-root .`'],
    ['`cd {wt.path}` then step `analyze` (`maestro run prepare analyze` + `maestro run create analyze --session YYYYMMDD-analyze-{topic} --intent "{goal}"`)', '`cd {wt.path}` then `maestro run start "{goal}" --cmd analyze --topic "{topic}" --platform pi --workflow-root .`'],
    ['Run step `roadmap` first (`maestro run prepare --platform pi roadmap` + `maestro run create roadmap --session YYYYMMDD-roadmap-{topic} --intent "{goal}"`)', 'Run step `roadmap` first (`maestro run start "{goal}" --cmd roadmap --topic "{topic}" --platform pi --workflow-root .`)'],
    ['Run step `roadmap` first (`maestro run prepare roadmap` + `maestro run create roadmap --session YYYYMMDD-roadmap-{topic} --intent "{goal}"`)', 'Run step `roadmap` first (`maestro run start "{goal}" --cmd roadmap --topic "{topic}" --platform pi --workflow-root .`)'],
    ['step `analyze` for session (`maestro run prepare --platform pi analyze --session {next-dep-ready-slug}` + `maestro run create analyze --session {next-dep-ready-slug} --intent "{goal}"`)', '`maestro run start "{goal}" --cmd analyze --session {next-dep-ready-slug} --platform pi --workflow-root .`'],
    ['step `analyze` for session (`maestro run prepare analyze --session {next-dep-ready-slug}` + `maestro run create analyze --session {next-dep-ready-slug} --intent "{goal}"`)', '`maestro run start "{goal}" --cmd analyze --session {next-dep-ready-slug} --platform pi --workflow-root .`'],
    ['step `analyze` (`maestro run prepare --platform pi analyze` + `maestro run create analyze --session {next-slug} --intent "{goal}"`)', '`maestro run start "{goal}" --cmd analyze --session {next-slug} --platform pi --workflow-root .`'],
    ['step `analyze` (`maestro run prepare analyze` + `maestro run create analyze --session {next-slug} --intent "{goal}"`)', '`maestro run start "{goal}" --cmd analyze --session {next-slug} --platform pi --workflow-root .`'],
    ['a step like `review`, `execute`, `test` invoked via `maestro run prepare --platform pi <step>` + `maestro run create <step> --session YYYYMMDD-<step>-{topic} --intent "{goal}"`', 'a step like `review`, `execute`, `test` invoked via `maestro run start "{goal}" --cmd <step> --topic "{topic}" --platform pi --workflow-root .`, or via `maestro run edit <step> --after latest --workflow-root .` inside an existing chain'],
    ['a step like `review`, `execute`, `test` invoked via `maestro run prepare <step>` + `maestro run create <step> --session YYYYMMDD-<step>-{topic} --intent "{goal}"`', 'a step like `review`, `execute`, `test` invoked via `maestro run start "{goal}" --cmd <step> --topic "{topic}" --platform pi --workflow-root .`, or via `maestro run edit <step> --after latest --workflow-root .` inside an existing chain'],
    ['Hand off to step `review` (`maestro run prepare --platform pi review` + `maestro run create review --session YYYYMMDD-review-{topic} --intent "{goal}"`)', 'Hand off to step `review` (`maestro run edit review --after latest --workflow-root .`, or `maestro run start "{goal}" --cmd review --topic "{topic}" --platform pi --workflow-root .` when no chain exists)'],
    ['Hand off to step `review` (`maestro run prepare review` + `maestro run create review --session YYYYMMDD-review-{topic} --intent "{goal}"`)', 'Hand off to step `review` (`maestro run edit review --after latest --workflow-root .`, or `maestro run start "{goal}" --cmd review --topic "{topic}" --platform pi --workflow-root .` when no chain exists)'],
    ['Proceed → run step `review` (`maestro run prepare --platform pi review` + `maestro run create review --session YYYYMMDD-review-{topic} --intent "{goal}"`)', 'Proceed → run step `review` (`maestro run edit review --after latest --workflow-root .`, or `maestro run start "{goal}" --cmd review --topic "{topic}" --platform pi --workflow-root .` when no chain exists)'],
    ['Proceed → run step `review` (`maestro run prepare review` + `maestro run create review --session YYYYMMDD-review-{topic} --intent "{goal}"`)', 'Proceed → run step `review` (`maestro run edit review --after latest --workflow-root .`, or `maestro run start "{goal}" --cmd review --topic "{topic}" --platform pi --workflow-root .` when no chain exists)'],
    ['Alternative → run step `execute` (`maestro run prepare --platform pi execute` + `maestro run create execute --session YYYYMMDD-execute-{topic} --intent "{goal}"`)', 'Alternative → run step `execute` (`maestro run edit execute --after latest --workflow-root .`, or `maestro run start "{goal}" --cmd execute --topic "{topic}" --platform pi --workflow-root .` when no chain exists)'],
    ['Alternative → run step `execute` (`maestro run prepare execute` + `maestro run create execute --session YYYYMMDD-execute-{topic} --intent "{goal}"`)', 'Alternative → run step `execute` (`maestro run edit execute --after latest --workflow-root .`, or `maestro run start "{goal}" --cmd execute --topic "{topic}" --platform pi --workflow-root .` when no chain exists)'],
    ['`maestro run create debug --session YYYYMMDD-debug-{topic} --intent "test failures after refactor in {scope}"`', '`maestro run start "test failures after refactor in {scope}" --cmd debug --topic "{topic}" --platform pi --workflow-root .`'],
    ['`maestro run create auto-test --session YYYYMMDD-auto-test-{topic} --intent "{goal}" -- {phase}`', '`maestro run start "{goal}" --cmd auto-test --topic "{topic}" --arg "{phase}" --platform pi --workflow-root .`'],
    ['`maestro run create review --session YYYYMMDD-review-{topic} --intent "{goal}" -- {phase}`', '`maestro run start "{goal}" --cmd review --topic "{topic}" --arg "{phase}" --platform pi --workflow-root .`'],
    ['`maestro run create plan --session YYYYMMDD-plan-{topic} --intent "{goal}" -- {phase} --gaps`', '`maestro run start "{goal}" --cmd plan --topic "{topic}" --arg "{phase}" --arg "--gaps" --platform pi --workflow-root .`'],
    ['经 `/maestro "<意图>"` 自动路由，或 `maestro run prepare --platform pi <step>` + `maestro run create <step> ...` 直接执行', '经 `/maestro "<意图>"` 自动路由，或 `maestro run start "<intent>" --cmd <step> --platform pi ...` 直接执行'],
    ['经 `/maestro "<意图>"` 自动路由，或 `maestro run prepare <step>` + `maestro run create <step> ...` 直接执行', '经 `/maestro "<意图>"` 自动路由，或 `maestro run start "<intent>" --cmd <step> --platform pi ...` 直接执行'],
    ['经 /maestro 自动路由，或 maestro run prepare/create 执行', '经 /maestro 自动路由，或 maestro run start --cmd 执行'],
    ['单步执行器 — ralph next + 内联 skill 执行，多 agent 编排的无名嵌套', '单步执行器 — run next/run brief + 内联 skill 执行，多 agent 编排的无名嵌套'],
  ]);

  result = result.replace(
    /maestro run create odyssey-<mode> \\\n  --session YYYYMMDD-odyssey-\{mode\}-\{topic\} \\\n  --intent "<short goal phrase>" \\\n  \[-- flags\.\.\.\]/,
    'maestro run start "<short goal phrase>" \\\n  --cmd odyssey-<mode> \\\n  --topic "odyssey-{mode}-{topic}" \\\n  --platform pi \\\n  [--arg "<flags...>"]',
  );

  result = result.replace(
    /Otherwise: `maestro run create ([^`\s]+) --session <slug> --intent (\\?"|')<task summary>(?:\\?"|')`/g,
    'Otherwise: `maestro run start $2<task summary>$2 --cmd $1 --session <slug> --platform pi --workflow-root .`',
  );

  result = result.replace(
    /maestro run create ([^\s`]+) --session ([^\s`]+) --intent "([^"\n]*)"/g,
    'maestro run start "$3" --cmd $1 --session $2 --platform pi',
  );
  result = result.replace(
    /maestro run create ([^\s`]+) --session ([^\s`]+) --intent '([^'\n]*)'/g,
    "maestro run start '$3' --cmd $1 --session $2 --platform pi",
  );
  result = result.replace(
    /todo\(\{\s*action:\s*"create",\s*subject:\s*("[^"]*"),\s*activeForm:\s*"[^"]*"\s*\}\)/g,
    'todo({ action: "create", subject: $1 })',
  );
  result = result.replace(
    'Record promoted IDs in `session.json.lifecycle.promoted[]`',
    'Use the Runtime CLI to persist promoted IDs in `session.json.lifecycle.promoted[]`',
  );
  result = result.replaceAll(
    '9. simple chain 只通过 `maestro run start --chain ... --no-dispatch` 或 `maestro session create --chain ...` 创建；不得为同一任务的每个 skill 新建独立 Session。',
    '9. simple chain 只通过 `maestro run start --chain ... --no-dispatch` 创建；不得为同一任务的每个 skill 新建独立 Session。',
  );
  result = result.replace(
    /(9\. simple chain 只通过 `maestro run start --chain \.\.\. --no-dispatch` 创建；不得为同一任务的每个 skill 新建独立 Session。\n10\. 中途新增下一步用 `maestro run edit <cmd\.\.\.>` 修改未来 chain，不调用新的 `run start` 制造第二个 Topic Session。\n)\1/g,
    '$1',
  );
  result = result.replaceAll(
    '// maestro run create return value when self-starting. See run-mode.md.',
    '// maestro run start return value when self-starting. See run-mode.md.',
  );
  result = result.replaceAll(
    "coordinatorMd.includes('maestro run create')",
    "coordinatorMd.includes('maestro run start')",
  );
  result = result.replaceAll(
    'Run Lifecycle Integration (maestro run create)',
    'Run Lifecycle Integration (maestro run start)',
  );

  const shouldUseDoneAlias =
    path.includes('/skills/team-') &&
    (path.endsWith('/SKILL.md') || path.includes('/roles/coordinator/commands/monitor.md') || path.includes('/roles/coordinator/commands/converge.md') || path.includes('/roles/coordinator/role.md'));
  if (shouldUseDoneAlias) {
    result = result.replaceAll('maestro run complete <run_id>', 'maestro run done <run_id>');
  }

  for (const block of [
    piHostMirrorBlock,
    piCoordinatorContextBlock,
    maestroCliSurface,
    ralphCliSurface,
    maestroNextInvariantBlock,
  ]) {
    result = dedupeBlock(result, block);
  }
  result = result.replace(
    /(10\. 中途新增下一步[^\r\n]*)(?:\r?\n){2}(?=<\/invariants>)/,
    '$1\n',
  );

  return bindPiPlatformToLifecycleCalls(result);
}

// ---------------------------------------------------------------------------
// maestro delegate/explore CLI → teammate() tool rewriting
// ---------------------------------------------------------------------------

function parseDelegateOptions(optsStr) {
  const opts = {};
  const re = /--([\w][\w-]*)(?:\s+((?!--)[\w./${}"'\\:@<>-]+(?:\s+(?!--)[\w./${}"'\\:@<>-]+)*))?/g;
  let m;
  while ((m = re.exec(optsStr)) !== null) {
    const val = m[2]?.trim().replace(/["'`\\]+$/, '') ?? 'true';
    opts[m[1]] = val;
  }
  return opts;
}

function delegateModeToTaskType(mode) {
  return mode === 'write' ? 'development' : 'analysis';
}

// Delegate CLI has no direct agent equivalent; the catalog `general` role is the
// safe target. `--to <tool>` (external model) survives as a routing comment only.
function formatTeammateCall(prompt, opts) {
  const taskType = delegateModeToTaskType(opts['mode']);
  const parts = ['agent: "general"'];
  parts.push(`taskType: "${taskType}"`);
  const taskParts = [];
  if (opts['id']) taskParts.push(`name: "${opts['id']}"`);
  const cleanPrompt = prompt.trim();
  if (cleanPrompt && cleanPrompt !== '<PROMPT>') {
    const escaped = cleanPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    taskParts.push(`prompt: "${escaped}"`);
  } else {
    taskParts.push('prompt: "<PROMPT>"');
  }
  parts.push(`tasks: [{ ${taskParts.join(', ')} }]`);
  if (opts['cd']) parts.push(`cwd: "${opts['cd']}"`);
  if (opts['rule']) parts.push(`/* --rule ${opts['rule']}: inline the template content into prompt */`);
  if (opts['to']) parts.push(`/* --to ${opts['to']}: set model via model-availability */`);
  if (opts['resume']) parts.push('/* --resume: no teammate equivalent; re-dispatch or use resident agent */');
  return `teammate({ ${parts.join(', ')} })`;
}

function rewriteDelegateCallsPi(body) {
  let out = body;

  // Tier 0: escaped-quote delegate calls — Bash("maestro delegate \\\"...\\\" ...")
  out = out.replace(
    /maestro delegate\s+\\+"([\s\S]*?)\\+"((?:\s+--[\w-]+(?:\s+(?!--)[\S]+)?)*)/g,
    (_full, prompt, optsStr) => formatTeammateCall(prompt, parseDelegateOptions(optsStr)),
  );

  // Tier 1: maestro delegate "PROMPT" [options] — standard quoted prompt
  out = out.replace(
    /maestro delegate\s+(["'`])([\s\S]*?)\1((?:\s+--[\w-]+(?:\s+(?!--)[\S]+)?)*)/g,
    (_full, _q, prompt, optsStr) => formatTeammateCall(prompt, parseDelegateOptions(optsStr)),
  );

  // Tier 2: maestro explore "PROMPT" [options]
  out = out.replace(
    /maestro explore\s+(["'`])([\s\S]*?)\1((?:\s+--[\w-]+(?:\s+(?!--)[\S]+)?)*)/g,
    (_full, _q, prompt, _optsStr) => {
      const escaped = prompt.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
      return `teammate({ agent: "explorer", tasks: [{ prompt: "${escaped}" }] })`;
    },
  );

  // Tier 3: prose / table inline — maestro delegate --mode analysis (no quoted prompt)
  out = out.replace(
    /maestro delegate((?:\s+--[\w-]+(?:\s+[\w./${}"'<>-]+)?)*)/g,
    (_full, optsStr) => {
      if (!optsStr.trim()) return 'teammate';
      const opts = parseDelegateOptions(optsStr);
      const parts = [`agent: "general"`, `taskType: "${delegateModeToTaskType(opts['mode'])}"`];
      if (opts['rule']) parts.push(`/* --rule ${opts['rule']} */`);
      if (opts['to']) parts.push(`/* --to ${opts['to']} */`);
      if (opts['id']) parts.push(`/* --id ${opts['id']} */`);
      return `teammate({ ${parts.join(', ')} })`;
    },
  );

  // Tier 4: bare maestro explore prose reference
  out = out.replace(/\bmaestro explore\b/g, 'teammate({ agent: "explorer" })');

  // Tier 5: run_in_background → background
  out = out.replace(/\brun_in_background\s*:\s*true/g, 'background: true');
  out = out.replace(/\brun_in_background\s*:\s*false/g, 'background: false');

  // Tier 6: section headers / prose mentions
  out = out.replace(/Execute via maestro delegate (\w+)/gi, 'Execute via teammate ($1)');
  out = out.replace(/via maestro delegate/g, 'via teammate');
  out = out.replace(/maestro delegate message/g, 'teammate-send');

  return out;
}

// ---------------------------------------------------------------------------
// teammate({ subagent_type: ... }) object form → current contract
// ---------------------------------------------------------------------------

// Claude-era subagent_type names → current teammate-agent-catalog roles.
// Unknown names pass through (they may be project-registered roles).
const SUBAGENT_AGENT_MAP = {
  'universal-executor': 'general',
  'general-purpose': 'general',
  'Explore': 'explorer',
  'delegate': 'general',
  'cli-explore-agent': 'cli-explore-agent',
  'team-worker': 'team-worker',
  'team-supervisor': 'team-supervisor',
};

function mapSubagentAgent(name) {
  return SUBAGENT_AGENT_MAP[name] ?? name;
}

/**
 * Rewrite legacy `teammate({ ... })` object literals into the current contract:
 *   - `subagent_type: "X"`           → `agent: <mapped>`
 *   - `agent: "delegate"`            → `agent: "general"`
 *   - top-level `task: "..."`         → `tasks[0].prompt` (TaskSpec has no `task`)
 *   - `name`/`description` move into `tasks[0]`
 *   - `background`/`cwd`/`model`/`thinking`/`taskType` stay top-level
 *   - a residual `prompt: "<rule>"` alongside `task:` is kept as a `--rule` note
 * Unknown keys are dropped; unknown subagent_type names pass via mapSubagentAgent.
 *
 * Implemented as a line scanner (not a regex over the whole block) because
 * prompt bodies are often JS template literals containing arbitrary backticks,
 * `${...}` interpolations and braces — a non-greedy regex cannot bound the block.
 */
function extractQuotedField(source, fieldName) {
  const match = new RegExp(`\\b${fieldName}\\s*[:=]\\s*`).exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;

  // Generated-skill source often escapes template delimiters as \`...\`.
  // Preserve the raw delimiters and use the final escaped backtick in this
  // object block as the close; inner literal backticks may also be escaped.
  if (source.startsWith('\\`', start)) {
    const end = source.lastIndexOf('\\`');
    return end > start ? source.slice(start, end + 2) : null;
  }

  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  if (quote === '`') {
    const end = source.lastIndexOf('`');
    return end > start ? source.slice(start, end + 1) : null;
  }

  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return source.slice(start, index + 1);
  }
  return null;
}

function rewriteLegacyTeammateInner(inner) {
  const hasSubagent = /\bsubagent_type\s*[:=]/.test(inner);
  const isDelegate = /\bagent\s*[:=]\s*["']delegate["']/.test(inner);
  const hasLegacyTask = /\btask\s*[:=]/.test(inner) && !/\btasks\s*[:=]/.test(inner);
  if (!hasSubagent && !isDelegate && !hasLegacyTask) return null;

  const subType = inner.match(/\bsubagent_type\s*[:=]\s*["']([^"']+)["']/)?.[1];
  const agentField = inner.match(/\bagent\s*[:=]\s*["']([^"']+)["']/)?.[1];
  const agent = subType
    ? mapSubagentAgent(subType)
    : (agentField && agentField !== 'delegate' ? mapSubagentAgent(agentField) : 'general');

  const taskType = extractQuotedField(inner, 'taskType');
  const name = extractQuotedField(inner, 'name');
  const description = extractQuotedField(inner, 'description');
  const background = inner.match(/\b(?:run_in_background|background)\s*[:=]\s*([^,\r\n]+)/)?.[1]?.trim();
  const cwd = extractQuotedField(inner, 'cwd');
  const model = extractQuotedField(inner, 'model');
  const thinking = extractQuotedField(inner, 'thinking');
  // Task body: `task:` (delegate legacy) wins over `prompt:`; a `prompt:`
  // alongside `task:` is a rule-template name, kept as a note.
  const task = extractQuotedField(inner, 'task');
  const prompt = extractQuotedField(inner, 'prompt');

  const parts = [`agent: "${agent}"`];
  if (taskType) parts.push(`taskType: ${taskType}`);

  // Team-role spawns without a taskType get a dynamic placeholder: the
  // dispatching agent fills it at dispatch time (role/task judgment beats any
  // static mapping). A stale placeholder is rejected by parseTeammateTaskType
  // and degrades to prompt inference, so it never forces a wrong mapping.
  const TEAM_TASK_TYPE_PLACEHOLDER_AGENTS = new Set(['team-worker', 'team-supervisor']);
  const needsTaskTypePlaceholder = !taskType && TEAM_TASK_TYPE_PLACEHOLDER_AGENTS.has(agent);
  const taskParts = [];
  if (needsTaskTypePlaceholder) taskParts.push(`taskType: "<task_type>"`);
  if (name) taskParts.push(`name: ${name}`);
  const bodyVal = task ?? prompt;
  if (bodyVal) taskParts.push(`prompt: ${bodyVal}`);
  if (description) taskParts.push(`description: ${description}`);
  if (taskParts.length) parts.push(`tasks: [{ ${taskParts.join(', ')} }]`);

  if (task && prompt) parts.push(`/* --rule ${prompt} */`);
  if (background) parts.push(`background: ${background}`);
  if (cwd) parts.push(`cwd: ${cwd}`);
  if (model) parts.push(`model: ${model}`);
  if (thinking) parts.push(`thinking: ${thinking}`);

  return `teammate({ ${parts.join(', ')} })`;
}

function rewriteAgentObjectCallsPi(body) {
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const out = [];
  let index = 0;
  while (index < lines.length) {
    // Rewrite complete single-line teammate object calls wherever they occur
    // (including command-string examples in documentation).
    const singleLine = lines[index].replace(
      /teammate\(\s*\{(.*?)\}\)/g,
      (_full, inner) => rewriteLegacyTeammateInner(inner) ?? _full,
    );
    if (singleLine !== lines[index]) {
      out.push(singleLine);
      index++;
      continue;
    }

    // Multi-line object: preserve indentation/prefix (`const x = await`) and
    // closing suffix (`;`).
    const open = lines[index].match(/^(\s*)(.*?)\bteammate\(\s*\{\s*$/);
    if (!open) {
      out.push(lines[index]);
      index++;
      continue;
    }

    const indent = open[1];
    const prefix = open[2];
    let inTemplate = false;
    let cursor = index + 1;
    let suffix = '';
    let closed = false;
    while (cursor < lines.length) {
      const line = lines[cursor];
      for (let charIndex = 0; charIndex < line.length; charIndex++) {
        if (line[charIndex] !== '`') continue;
        let slashCount = 0;
        for (let prev = charIndex - 1; prev >= 0 && line[prev] === '\\'; prev--) slashCount++;
        if (slashCount % 2 === 0) inTemplate = !inTemplate;
      }
      const close = !inTemplate ? line.match(/^\s*\}\)\s*(.*)$/) : null;
      if (close) {
        suffix = close[1];
        closed = true;
        break;
      }
      cursor++;
    }

    if (!closed) {
      out.push(lines[index]);
      index++;
      continue;
    }

    const inner = lines.slice(index + 1, cursor).join('\n');
    const rewritten = rewriteLegacyTeammateInner(inner);
    if (!rewritten) {
      out.push(...lines.slice(index, cursor + 1));
    } else {
      out.push(`${indent}${prefix}${rewritten}${suffix}`);
    }
    index = cursor + 1;
  }
  return out.join(newline);
}

function rewriteTeammateWaitSemanticsPi(body) {
  let out = body;
  const waitText = 'wait for the automatic teammate-complete notification (or call observe exactly once with action="wait" when this turn must consume the result)';
  out = out.replace(/wait for hook callback/gi, waitText);
  out = out.replace(/\bSendMessage callback\b/g, 'teammate-complete notification');
  out = out.replace(/\bOn callback\b/g, 'On teammate-complete notification');
  out = out.replace(/\bworker callbacks\b/gi, 'teammate-complete notifications');
  out = out.replace(/\bworker callback\b/gi, 'teammate-complete notification');
  out = out.replace(/\bwait for callbacks\b/gi, 'wait for teammate-complete notifications');
  return out;
}

/**
 * Strip a Bash wrapper around a teammate tool call where the command string is
 * a literal teammate call: `Bash({ command: 'teammate({...})', background: true })`
 * → the bare `teammate({...})` with `background` lifted to the call top level.
 * Variable-indirection forms (`const c = \`teammate(...)\`; Bash({ command: c })`)
 * are out of scope for mechanical rewriting.
 */
function stripBashWrapperTeammate(body) {
  return body.replace(
    /Bash\(\{\s*command\s*:\s*[`'"](teammate\(\{[\s\S]*?\}\))[`'"]\s*(?:,\s*background\s*:\s*(true|false))?[^}]*\}\)/g,
    (_full, call, background) => {
      if (!background) return call;
      // Lift background into the teammate call top level.
      return call.replace(/\}\s*\)$/, `, background: ${background} })`);
    },
  );
}

export function transformBody(body, filePath) {
  let result = body;

  // Keep XML tags as-is — they're prompt structure, not platform-specific.
  // Only strip the @ prefix from file references (Claude-specific inlining syntax).
  result = result.replace(
    /(@)(~\/.maestro\/)/g,
    '$2'
  );

  // 5. "Agent tool" / "Agent(" references → teammate
  result = result.replace(/\bAgent\s+tool\b/g, 'teammate tool');
  result = result.replace(/\bAgent\(\s*\{/g, 'teammate({');
  result = result.replace(/\bspawn(?:ing)?\s+(?:an?\s+)?Agent\b/gi, 'dispatch via teammate');
  result = result.replace(/\bAgent\(\s*name:/g, 'teammate(name:');

  // 5b. maestro delegate/explore CLI → teammate() tool calls
  result = rewriteDelegateCallsPi(result);

  // 5c. teammate({ subagent_type: ... }) object form → agent + tasks[] contract
  result = rewriteAgentObjectCallsPi(result);

  // 5d. Legacy callback prose → teammate-complete / observe wait semantics
  result = rewriteTeammateWaitSemanticsPi(result);

  // 5e. Bash({ command: 'teammate({...})' }) wrapper → bare teammate call
  result = stripBashWrapperTeammate(result);

  // 6. AskUserQuestion → ask the user
  result = result.replace(/\bAskUserQuestion\b(?!\s*\()/g, 'user prompt');
  result = result.replace(/AskUserQuestion\s*\(\s*\{/g, 'ask user ({');

  // 7. Skill tool references
  result = result.replace(/\bSkill\s*\(\s*\{\s*skill:/g, 'invoke /skill:');
  result = result.replace(/\bSkill\s+tool\b/g, '/skill: command');

  // 8. maestro explore Bash calls → maestro tool action
  // Keep as CLI call since maestro CLI is a dependency, but add note
  // Don't transform these - maestro CLI is available

  return transformSessionRunCli(result, filePath);
}

// Keep the conversion pure so fixtures can verify the generated Pi surface without writes.
export function transformPiContent(content, filePath) {
  let modified = restoreFrontmatterToolAliases(content);
  const normalizedPath = normalizePath(filePath);

  // Check if it's an agent file (tools: list format)
  if (filePath.endsWith('.md') && normalizedPath.includes('/agents/')) {
    modified = remapAgentTools(modified);
  }

  modified = ensureSkillSessionMode(modified, filePath);
  modified = remapAllowedToolsInFrontmatter(modified);

  // Transform body content
  const parts = splitFrontmatter(modified);
  if (parts) {
    modified = parts.frontmatter + transformBody(parts.body, filePath);
  } else {
    modified = transformBody(modified, filePath);
  }

  modified = ensurePiTeammateContract(modified, filePath);
  return modified.replace(/[ \t]+$/gm, '');
}

// --- Process a single file ---
function processFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const modified = transformPiContent(content, filePath);

  if (modified !== content) {
    writeFileSync(filePath, modified, 'utf-8');
  }

  return modified === content ? 0 : 1;
}

// --- Walk directories ---
function walkContentFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkContentFiles(full));
    } else if (entry.endsWith('.md') || entry.endsWith('.json')) {
      files.push(full);
    }
  }
  return files;
}

export function convertPiDirectory(destination = DST) {
  const stats = { processed: 0, modified: 0, errors: [] };
  for (const directory of ['skills', 'agents']) {
    for (const filePath of walkContentFiles(join(destination, directory))) {
      try {
        const changes = processFile(filePath);
        stats.processed++;
        if (changes > 0) stats.modified++;
      } catch (error) {
        stats.errors.push(`${filePath}: ${error.message}`);
      }
    }
  }
  return stats;
}

function main() {
  const stats = convertPiDirectory();
  console.log('\n=== Pi Compatibility Conversion ===');
  console.log(`Target: ${DST}`);
  console.log(`Processed: ${stats.processed}`);
  console.log(`Modified: ${stats.modified}`);
  if (stats.errors.length > 0) {
    console.log(`Errors (${stats.errors.length}):`);
    for (const error of stats.errors) console.log(`  - ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === converterPath) main();

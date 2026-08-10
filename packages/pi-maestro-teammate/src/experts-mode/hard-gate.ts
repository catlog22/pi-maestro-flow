import path from "node:path";
import { getMode } from "./mode.ts";
import { loadRules } from "./rules.ts";
import { getStagePolicy, readActiveStage, resolveStageName } from "./stage-policy.ts";
import type {
  ExpertsMode,
  ExpertsRules,
  GateDecision,
  GateResult,
  RewriteSuggestion,
} from "./types.ts";

export interface HardGateOptions {
  mode?: ExpertsMode;
  cwd?: string;
  rules?: ExpertsRules;
  /** Tool arguments (write path, bash command, …). */
  toolInput?: unknown;
  /** Optional Maestro stage override; falls back to activeStage / MAESTRO_STAGE. */
  stage?: string;
}

const HEAVY_MUTATION_TOOLS = new Set(["write", "edit", "bash", "bash_bg"]);

const DEFAULT_LEADER_ALLOW_PATHS = [
  "report.md",
  "**/report.md",
  "outputs/**",
  "**/outputs/**",
  ".workflow/**",
  "**/.workflow/**",
  ".experts-mode.json",
  "notes/**",
  "**/notes/**",
];

const DEFAULT_BASH_ALLOW_PREFIXES = [
  "maestro ",
  "maestro\t",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "npm test",
  "npm run test",
  "node --test",
  "node --experimental-transform-types --test",
  "rg ",
  "ls ",
  "dir ",
  "pwd",
  "cat ",
  "type ",
  "head ",
  "tail ",
];

/**
 * P5 Lead discipline hard-gate for tool calls under Experts Mode.
 *
 * Defaults (default-rules): write/edit/bash → deny, with:
 * - path allowlist for orchestration artifacts (report/outputs/.workflow/notes)
 * - bash allowlist for maestro/git-read/test/search commands
 * - deny reason always carries rewriteSuggestion → teammate + taskType
 */
export function evaluateHardGate(toolName: string, opts: HardGateOptions = {}): GateResult {
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? getMode(cwd);
  const rules = opts.rules ?? loadRules();
  const name = normalizeToolName(toolName);

  if (mode !== "experts") {
    return { decision: "allow", reason: "normal mode — no experts gate" };
  }

  const table = rules.hardGate?.tools || {};
  const fallback = rules.hardGate?.default || "allow";
  let decision: GateDecision = (table[name] || fallback) as GateDecision;
  if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
    decision = "allow";
  }

  const stage = resolveGateStage(opts.stage, cwd, rules);
  const rewrite = buildRewriteSuggestion(name, opts.toolInput, stage, rules, cwd);

  // Path / command allowlists only apply when the base decision is deny|ask.
  if (decision === "deny" || decision === "ask") {
    if (isLeaderAllowed(name, opts.toolInput, stage, rules, cwd)) {
      return {
        decision: "allow",
        reason: `experts mode allows leader orchestration use of "${name}" (allowlist)`,
        stage,
        rewriteSuggestion: rewrite,
      };
    }
  }

  if (decision === "deny") {
    return {
      decision: "deny",
      reason: formatDenyReason(name, rewrite),
      stage,
      rewriteSuggestion: rewrite,
    };
  }
  if (decision === "ask") {
    return {
      decision: "ask",
      reason: formatAskReason(name, rewrite),
      stage,
      rewriteSuggestion: rewrite,
    };
  }
  return {
    decision: "allow",
    reason: `experts mode allows tool "${name}"`,
    stage,
  };
}

/**
 * Build a teammate rewrite suggestion for a blocked heavy tool call.
 * Pure helper — safe to call from adapters without re-evaluating the gate.
 */
export function buildRewriteSuggestion(
  toolName: string,
  toolInput: unknown,
  stage: string | undefined,
  rules: ExpertsRules = loadRules(),
  cwd = process.cwd(),
): RewriteSuggestion {
  const name = normalizeToolName(toolName);
  const stageKey = resolveStageName(stage, rules) || stage;
  const policy = stageKey ? getStagePolicy(stageKey, rules)?.policy : undefined;
  const primary = policy?.pipeline?.[0];
  const taskType =
    (primary?.taskType && String(primary.taskType))
    || rules.defaultTaskType
    || "development";
  const agent =
    (primary?.agent && String(primary.agent))
    || rules.taskTypes?.[taskType]?.agent
    || rules.defaultAgent
    || "general-executor";

  const pathHint = extractPathHint(name, toolInput, cwd);
  const commandHint = extractCommandHint(name, toolInput);
  const intentBits = [
    stageKey ? `Maestro stage=${stageKey}` : null,
    pathHint ? `path=${pathHint}` : null,
    commandHint ? `command=${commandHint}` : null,
    name ? `blocked_tool=${name}` : null,
  ].filter(Boolean);

  const prompt = [
    "Lead discipline rewrite: complete this work as an expert teammate.",
    intentBits.length ? `Context: ${intentBits.join("; ")}` : "",
    "Implement only the blocked leader action; return a concise RESULT with files touched and verification.",
    "Do not hardcode model ids; role ≠ model.",
  ].filter(Boolean).join("\n");

  return {
    action: "teammate",
    taskType,
    agent,
    stage: stageKey,
    prompt,
    blockedTool: name,
    pathHint,
    commandHint,
  };
}

export function formatDenyReason(toolName: string, rewrite: RewriteSuggestion): string {
  return [
    `experts mode DENIES tool "${toolName}" for Leader — do not implement with ${toolName}.`,
    `Rewrite: dispatch teammate with taskType=${rewrite.taskType} agent=${rewrite.agent}`
      + (rewrite.stage ? ` stage=${rewrite.stage}` : "")
      + ".",
    rewrite.pathHint ? `Blocked path: ${rewrite.pathHint}.` : "",
    rewrite.commandHint ? `Blocked command: ${rewrite.commandHint}.` : "",
    "Example: teammate({ tasks:[{ prompt, taskType, agent, stage }], ... }) then wait/settle.",
  ].filter(Boolean).join(" ");
}

export function formatAskReason(toolName: string, rewrite: RewriteSuggestion): string {
  return [
    `experts mode: tool "${toolName}" is heavy-side; prefer teammate+taskType or confirm.`,
    `Suggested rewrite: taskType=${rewrite.taskType} agent=${rewrite.agent}`
      + (rewrite.stage ? ` stage=${rewrite.stage}` : "")
      + ".",
  ].join(" ");
}

function resolveGateStage(
  explicit: string | undefined,
  cwd: string,
  rules: ExpertsRules,
): string | undefined {
  if (explicit) return resolveStageName(explicit, rules) || explicit;
  try {
    const active = readActiveStage(cwd)?.stage;
    if (active) return resolveStageName(active, rules) || active;
  } catch {
    // ignore
  }
  if (typeof process.env.MAESTRO_STAGE === "string" && process.env.MAESTRO_STAGE.trim()) {
    return resolveStageName(process.env.MAESTRO_STAGE, rules) || process.env.MAESTRO_STAGE;
  }
  return undefined;
}

function normalizeToolName(toolName: string): string {
  return String(toolName || "").trim();
}

function isLeaderAllowed(
  toolName: string,
  toolInput: unknown,
  stage: string | undefined,
  rules: ExpertsRules,
  cwd: string,
): boolean {
  if (toolName === "write" || toolName === "edit") {
    const filePath = extractPathHint(toolName, toolInput, cwd);
    if (!filePath) return false;
    const patterns = collectPathAllowlist(stage, rules);
    return patterns.some((pattern) => matchPathPattern(filePath, pattern, cwd));
  }
  if (toolName === "bash" || toolName === "bash_bg") {
    const command = extractCommandHint(toolName, toolInput);
    if (!command) return false;
    const prefixes = [
      ...(rules.hardGate?.bashAllowPrefixes || []),
      ...DEFAULT_BASH_ALLOW_PREFIXES,
    ];
    const normalized = command.replace(/^\s+/, "");
    return prefixes.some((prefix) => {
      const p = prefix.toLowerCase();
      const c = normalized.toLowerCase();
      return c === p.trim() || c.startsWith(p);
    });
  }
  return false;
}

function collectPathAllowlist(stage: string | undefined, rules: ExpertsRules): string[] {
  const fromRules = rules.hardGate?.leaderAllowPaths || [];
  const fromStage = stage
    ? (getStagePolicy(stage, rules)?.policy.leaderMayWrite || [])
    : [];
  return [...DEFAULT_LEADER_ALLOW_PATHS, ...fromRules, ...fromStage];
}

function extractPathHint(toolName: string, toolInput: unknown, cwd: string): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const input = toolInput as Record<string, unknown>;
  const candidates = [
    input.path,
    input.file_path,
    input.filePath,
    input.filename,
    input.target,
  ];
  // edit tools sometimes nest
  if (input.file && typeof input.file === "object") {
    const file = input.file as Record<string, unknown>;
    candidates.push(file.path, file.file_path);
  }
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return normalizePathForMatch(value, cwd);
    }
  }
  // Some hosts pass path as first positional-like field
  if (toolName === "write" || toolName === "edit") {
    for (const value of Object.values(input)) {
      if (typeof value === "string" && looksLikePath(value)) {
        return normalizePathForMatch(value, cwd);
      }
    }
  }
  return undefined;
}

function extractCommandHint(toolName: string, toolInput: unknown): string | undefined {
  if (toolName !== "bash" && toolName !== "bash_bg") return undefined;
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const input = toolInput as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "bash"]) {
    if (typeof input[key] === "string" && input[key].trim()) return String(input[key]).trim();
  }
  return undefined;
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[a-z0-9]+$/i.test(value);
}

function normalizePathForMatch(filePath: string, cwd: string): string {
  const resolved = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(cwd, filePath));
  // Prefer project-relative POSIX-ish path for glob matching
  const rel = path.relative(cwd, resolved);
  const useRel = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : resolved;
  return useRel.split(path.sep).join("/");
}

/**
 * Minimal glob matcher: supports ** and * segments, case-insensitive on win.
 */
export function matchPathPattern(filePath: string, pattern: string, cwd = process.cwd()): boolean {
  const file = normalizePathForMatch(filePath, cwd).replace(/^\.\//, "");
  const pat = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  const fileNorm = process.platform === "win32" ? file.toLowerCase() : file;
  const patNorm = process.platform === "win32" ? pat.toLowerCase() : pat;

  // Exact or basename-only pattern like report.md
  if (fileNorm === patNorm) return true;
  if (!patNorm.includes("/") && fileNorm.endsWith("/" + patNorm)) return true;

  const regex = globToRegExp(patNorm);
  return regex.test(fileNorm);
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      // ** optional slash
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    if ("+.^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
      continue;
    }
    re += ch;
  }
  re += "$";
  return new RegExp(re);
}

export function isHeavyMutationTool(toolName: string): boolean {
  return HEAVY_MUTATION_TOOLS.has(normalizeToolName(toolName));
}

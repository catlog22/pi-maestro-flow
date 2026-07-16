import { realpathSync } from "node:fs";
import * as path from "node:path";
import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRuleSettings,
  PermissionToolCall,
} from "./types.ts";

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
  rule?: string;
}

const CANONICAL_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  powershell: "PowerShell",
  edit: "Edit",
  write: "Write",
  notebook_edit: "NotebookEdit",
  read: "Read",
  grep: "Grep",
  glob: "Glob",
  ls: "Ls",
  find: "Find",
};

const ALWAYS_ALLOWED_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Ls",
  "Find",
  "ask-user-question",
  "teammate",
  "teammate-send",
  "teammate-list",
  "teammate-watch",
  "goal",
  "todo",
  "plan-enter",
  "plan-update",
  "plan-review",
  "plan-confirm",
  "plan-exit",
  "plan-status",
  "search_tool_bm25",
]);

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

export function canonicalToolName(toolName: string): string {
  return CANONICAL_TOOL_NAMES[toolName] ?? toolName;
}

export function evaluatePermission(
  call: PermissionToolCall,
  mode: PermissionMode,
  settings: PermissionRuleSettings,
  cwd?: string,
): PermissionDecision {
  if (mode === "bypassPermissions") {
    return { behavior: "allow", reason: "bypassPermissions (YOLO) mode allows every tool." };
  }
  const explicit = explicitDecision(call, settings, cwd);
  if (explicit) return explicit;

  const toolName = canonicalToolName(call.toolName);
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: `${toolName} is an internal or read-only tool.` };
  }
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: "acceptEdits mode allows file edit tools." };
  }
  if (mode === "dontAsk") {
    return { behavior: "deny", reason: `${toolName} is not pre-approved in dontAsk mode.` };
  }
  if (mode === "plan") {
    return { behavior: "allow", reason: "The Plan hard boundary already accepted this tool call." };
  }
  return { behavior: "ask", reason: `${toolName} requires user approval in ${mode} mode.` };
}

export function suggestedAllowRule(call: PermissionToolCall, cwd?: string): string {
  const toolName = canonicalToolName(call.toolName);
  const specifier = toolSpecifier(toolName, call.input);
  if (specifier) {
    const stableSpecifier = isFileTool(toolName)
      ? fileSpecifierCandidates(specifier, cwd)[0] ?? specifier
      : specifier;
    return `${toolName}(${stableSpecifier})`;
  }
  for (const key of ["action", "operation", "mode", "model"]) {
    if (scalar(call.input[key])) return `${toolName}(${key}:${String(call.input[key])})`;
  }
  const generic = Object.entries(call.input).find(([, value]) => scalar(value));
  return generic ? `${toolName}(${generic[0]}:${String(generic[1])})` : toolName;
}

export function matchesPermissionRule(rule: string, call: PermissionToolCall, cwd?: string): boolean {
  if (isShellTool(call.toolName)) {
    const command = stringField(call.input, "command", "cmd");
    if (!command) return false;
    const backslashEscapes = usesBackslashEscapes(call.toolName);
    return matchesRuleAgainstValue(rule, call, command, cwd)
      || shellSegments(command, backslashEscapes)
        .some((segment) => matchesRuleAgainstValue(rule, call, segment, cwd));
  }
  return matchesRuleAgainstValue(rule, call, undefined, cwd);
}

function matchesRuleAgainstValue(
  rule: string,
  call: PermissionToolCall,
  shellCommand?: string,
  cwd?: string,
  restrictFileAllow = false,
): boolean {
  const parsed = /^(?<tool>[^()]+?)(?:\((?<specifier>.*)\))?$/.exec(rule.trim());
  if (!parsed?.groups) return false;
  const toolName = canonicalToolName(call.toolName);
  if (!globMatches(parsed.groups.tool.trim(), toolName)) return false;
  const expected = parsed.groups.specifier;
  if (expected === undefined || expected === "" || expected === "*") return true;

  const parameter = /^([^:]+):\s*(.*)$/.exec(expected);
  if (parameter && !canonicalSpecifierTools.has(toolName)) {
    const value = call.input[parameter[1].trim()];
    return scalar(value) && globMatches(parameter[2], String(value));
  }

  const actual = shellCommand ?? toolSpecifier(toolName, call.input);
  if (actual === undefined) return false;
  if (isFileTool(toolName)) {
    const expectedCandidates = fileSpecifierCandidates(expected, cwd);
    const actualCandidates = fileSpecifierCandidates(actual, cwd, restrictFileAllow);
    const ignoreCase = pathFlavor(actual, cwd) === path.win32;
    return expectedCandidates.some((pattern) =>
      actualCandidates.some((value) => fileGlobMatches(pattern, value, ignoreCase))
    );
  }
  return globMatches(expected, actual);
}

const canonicalSpecifierTools = new Set([
  "Bash",
  "PowerShell",
  "Read",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
]);

function explicitDecision(
  call: PermissionToolCall,
  settings: PermissionRuleSettings,
  cwd?: string,
): PermissionDecision | undefined {
  for (const behavior of ["deny", "ask"] as const) {
    const rule = settings[behavior].find((candidate) => matchesPermissionRule(candidate, call, cwd));
    if (rule) return { behavior, rule, reason: `Matched ${behavior} rule: ${rule}` };
  }
  if (isShellTool(call.toolName)) {
    const command = stringField(call.input, "command", "cmd");
    if (!command) return undefined;
    const backslashEscapes = usesBackslashEscapes(call.toolName);
    const segments = shellSegments(command, backslashEscapes);
    const exactWholeRule = settings.allow.find((rule) => {
      const specifier = ruleSpecifier(rule, canonicalToolName(call.toolName));
      return specifier !== undefined && !specifier.includes("*") && specifier === command;
    });
    if (exactWholeRule) {
      return { behavior: "allow", rule: exactWholeRule, reason: `Matched allow rule: ${exactWholeRule}` };
    }
    // A wildcard allow such as Bash(echo *) must not cover nested execution
    // or redirection. Exact whole-command rules remain an explicit escape hatch.
    if (hasUnsafeShellExpansion(command, backslashEscapes)) return undefined;
    const allAllowed = segments.length > 0 && segments.every((segment) =>
      settings.allow.some((rule) => matchesRuleAgainstValue(rule, call, segment, cwd))
    );
    if (allAllowed) {
      return { behavior: "allow", reason: "Every shell subcommand matched an allow rule." };
    }
    return undefined;
  }
  const rule = settings.allow.find((candidate) =>
    matchesRuleAgainstValue(candidate, call, undefined, cwd, true)
  );
  if (rule) return { behavior: "allow", rule, reason: `Matched allow rule: ${rule}` };
  return undefined;
}

function toolSpecifier(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "Bash" || toolName === "PowerShell") return stringField(input, "command", "cmd");
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(toolName)) {
    return stringField(input, "file_path", "path", "notebook_path");
  }
  if (toolName === "WebFetch") {
    const raw = stringField(input, "url");
    if (!raw) return undefined;
    try {
      return `domain:${new URL(raw).hostname}`;
    } catch {
      return raw;
    }
  }
  return undefined;
}

function isFileTool(toolName: string): boolean {
  return ["Read", "Edit", "Write", "NotebookEdit"].includes(toolName);
}

function fileSpecifierCandidates(value: string, cwd?: string, actual = false): string[] {
  const pathApi = pathFlavor(value, cwd);
  const input = pathForFlavor(value.trim(), pathApi);
  if (!cwd) return [portablePath(pathApi.normalize(input), pathApi)];

  const workspace = pathApi.resolve(pathForFlavor(cwd, pathApi));
  const absolute = pathApi.isAbsolute(input) ? pathApi.normalize(input) : pathApi.resolve(workspace, input);
  const candidates = new Set<string>();
  addPathPair(candidates, pathApi, workspace, absolute);

  if (pathApi === nativePathFlavor()) {
    const real = resolveRealPathCandidate(absolute, pathApi);
    if (real) {
      if (actual && !isWithinWorkspace(pathApi, workspace, real)) candidates.clear();
      addPathPair(candidates, pathApi, workspace, real);
    }
  }
  return [...candidates];
}

function resolveRealPathCandidate(
  absolute: string,
  pathApi: typeof path.posix | typeof path.win32,
): string | undefined {
  const suffix: string[] = [];
  const wildcard = absolute.indexOf("*");
  let probe = absolute;
  if (wildcard >= 0) {
    const boundary = absolute.lastIndexOf(pathApi.sep, wildcard);
    if (boundary >= 0) {
      suffix.push(...absolute.slice(boundary + 1).split(pathApi.sep));
      probe = absolute.slice(0, boundary) || pathApi.parse(absolute).root;
    }
  }

  while (true) {
    try {
      const real = realpathSync.native(probe);
      return suffix.length ? pathApi.join(real, ...suffix) : real;
    } catch {
      const parent = pathApi.dirname(probe);
      if (parent === probe) return undefined;
      suffix.unshift(pathApi.basename(probe));
      probe = parent;
    }
  }
}

function addPathPair(
  candidates: Set<string>,
  pathApi: typeof path.posix | typeof path.win32,
  workspace: string,
  absolute: string,
): void {
  const relative = pathApi.relative(workspace, absolute) || ".";
  candidates.add(portablePath(relative, pathApi));
  candidates.add(portablePath(absolute, pathApi));
}

function isWithinWorkspace(
  pathApi: typeof path.posix | typeof path.win32,
  workspace: string,
  candidate: string,
): boolean {
  const relative = pathApi.relative(workspace, candidate);
  return relative === ""
    || (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`));
}

function pathFlavor(value: string, cwd?: string): typeof path.posix | typeof path.win32 {
  return looksLikeWindowsPath(value) || (cwd !== undefined && looksLikeWindowsPath(cwd))
    ? path.win32
    : path.posix;
}

function nativePathFlavor(): typeof path.posix | typeof path.win32 {
  return process.platform === "win32" ? path.win32 : path.posix;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

function pathForFlavor(
  value: string,
  pathApi: typeof path.posix | typeof path.win32,
): string {
  return pathApi === path.win32 ? value.replaceAll("/", "\\") : value;
}

function portablePath(value: string, pathApi: typeof path.posix | typeof path.win32): string {
  return pathApi === path.win32 ? value.replaceAll("\\", "/") : value;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return undefined;
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function globMatches(pattern: string, value: string): boolean {
  return regexGlobMatches(pattern, value, true);
}

function fileGlobMatches(pattern: string, value: string, ignoreCase: boolean): boolean {
  return regexGlobMatches(pattern, value, ignoreCase);
}

function regexGlobMatches(pattern: string, value: string, ignoreCase: boolean): boolean {
  const source = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${source}$`, ignoreCase ? "i" : undefined).test(value);
}

function isShellTool(toolName: string): boolean {
  const canonical = canonicalToolName(toolName);
  return canonical === "Bash" || canonical === "PowerShell";
}

function usesBackslashEscapes(toolName: string): boolean {
  return canonicalToolName(toolName) === "Bash";
}

function ruleSpecifier(rule: string, toolName: string): string | undefined {
  const parsed = /^(?<tool>[^()]+?)(?:\((?<specifier>.*)\))?$/.exec(rule.trim());
  if (!parsed?.groups || !globMatches(parsed.groups.tool.trim(), toolName)) return undefined;
  return parsed.groups.specifier;
}

function shellSegments(command: string, backslashEscapes: boolean): string[] {
  const segments: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let current = "";
  const flush = () => {
    const value = current.trim();
    if (value) segments.push(value);
    current = "";
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (backslashEscapes && char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      flush();
      if ((char === "|" || char === "&") && command[index + 1] === char) index++;
      continue;
    }
    current += char;
  }
  flush();
  return segments;
}

function hasUnsafeShellExpansion(command: string, backslashEscapes: boolean): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (backslashEscapes && char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (char === "`" || char === ">" || char === "<") return true;
    if (char === "$" && command[index + 1] === "(") return true;
  }
  return quote !== undefined || escaped;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
}

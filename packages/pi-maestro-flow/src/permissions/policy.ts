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
): PermissionDecision {
  if (mode === "bypassPermissions") {
    return { behavior: "allow", reason: "bypassPermissions (YOLO) mode allows every tool." };
  }
  const explicit = explicitDecision(call, settings);
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

export function suggestedAllowRule(call: PermissionToolCall): string {
  const toolName = canonicalToolName(call.toolName);
  const specifier = toolSpecifier(toolName, call.input);
  if (specifier) return `${toolName}(${specifier})`;
  for (const key of ["action", "operation", "mode", "model"]) {
    if (scalar(call.input[key])) return `${toolName}(${key}:${String(call.input[key])})`;
  }
  const generic = Object.entries(call.input).find(([, value]) => scalar(value));
  return generic ? `${toolName}(${generic[0]}:${String(generic[1])})` : toolName;
}

export function matchesPermissionRule(rule: string, call: PermissionToolCall): boolean {
  if (isShellTool(call.toolName)) {
    const command = stringField(call.input, "command", "cmd");
    if (!command) return false;
    return matchesRuleAgainstValue(rule, call, command)
      || shellSegments(command).some((segment) => matchesRuleAgainstValue(rule, call, segment));
  }
  return matchesRuleAgainstValue(rule, call);
}

function matchesRuleAgainstValue(
  rule: string,
  call: PermissionToolCall,
  shellCommand?: string,
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
  return actual !== undefined && globMatches(expected, actual);
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
): PermissionDecision | undefined {
  for (const behavior of ["deny", "ask"] as const) {
    const rule = settings[behavior].find((candidate) => matchesPermissionRule(candidate, call));
    if (rule) return { behavior, rule, reason: `Matched ${behavior} rule: ${rule}` };
  }
  if (isShellTool(call.toolName)) {
    const command = stringField(call.input, "command", "cmd");
    if (!command) return undefined;
    const segments = shellSegments(command);
    const exactWholeRule = settings.allow.find((rule) => {
      const specifier = ruleSpecifier(rule, canonicalToolName(call.toolName));
      return specifier !== undefined && !specifier.includes("*") && specifier === command;
    });
    if (exactWholeRule) {
      return { behavior: "allow", rule: exactWholeRule, reason: `Matched allow rule: ${exactWholeRule}` };
    }
    // A wildcard allow such as Bash(echo *) must not cover nested execution
    // or redirection. Exact whole-command rules remain an explicit escape hatch.
    if (hasUnsafeShellExpansion(command)) return undefined;
    const allAllowed = segments.length > 0 && segments.every((segment) =>
      settings.allow.some((rule) => matchesRuleAgainstValue(rule, call, segment))
    );
    if (allAllowed) {
      return { behavior: "allow", reason: "Every shell subcommand matched an allow rule." };
    }
    return undefined;
  }
  const rule = settings.allow.find((candidate) => matchesPermissionRule(candidate, call));
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
  const source = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

function isShellTool(toolName: string): boolean {
  const canonical = canonicalToolName(toolName);
  return canonical === "Bash" || canonical === "PowerShell";
}

function ruleSpecifier(rule: string, toolName: string): string | undefined {
  const parsed = /^(?<tool>[^()]+?)(?:\((?<specifier>.*)\))?$/.exec(rule.trim());
  if (!parsed?.groups || !globMatches(parsed.groups.tool.trim(), toolName)) return undefined;
  return parsed.groups.specifier;
}

function shellSegments(command: string): string[] {
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
    if (char === "\\" && quote !== "'") {
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

function hasUnsafeShellExpansion(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
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

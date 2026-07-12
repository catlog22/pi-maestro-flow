import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SubagentStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

export interface CodexCommandHook {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout: number;
  statusMessage?: string;
  async?: boolean;
}

export interface CodexSkippedHook {
  type: "prompt" | "agent";
  [key: string]: unknown;
}

export type CodexHookHandler = CodexCommandHook | CodexSkippedHook;

export interface CodexHookMatcherGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}

export interface CodexHooksFile {
  hooks: Partial<Record<CodexHookEvent, CodexHookMatcherGroup[]>>;
}

export interface LoadedCodexHooks {
  config: CodexHooksFile;
  filePath: string;
  hash: string | null;
  exists: boolean;
}

export class CodexHookConfigError extends Error {
  constructor(readonly filePath: string, message: string) {
    super(`E_CODEX_HOOK_CONFIG_INVALID: ${message} (${filePath})`);
    this.name = "CodexHookConfigError";
  }
}

const EVENT_SET = new Set<string>(CODEX_HOOK_EVENTS);
const DEFAULT_TIMEOUT_SECONDS = 600;

export async function loadCodexHooks(cwd: string): Promise<LoadedCodexHooks> {
  const filePath = join(cwd, ".pi", "hooks.json");
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { config: { hooks: {} }, filePath, hash: null, exists: false };
    }
    throw new CodexHookConfigError(filePath, errorMessage(error));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CodexHookConfigError(filePath, `invalid JSON: ${errorMessage(error)}`);
  }

  return {
    config: validateCodexHooks(raw, filePath),
    filePath,
    hash: createHash("sha256").update(text).digest("hex"),
    exists: true,
  };
}

export function validateCodexHooks(raw: unknown, filePath = ".pi/hooks.json"): CodexHooksFile {
  if (!isRecord(raw)) throw new CodexHookConfigError(filePath, "root must be an object");
  if (!isRecord(raw.hooks)) throw new CodexHookConfigError(filePath, "hooks must be an object");

  const hooks: Partial<Record<CodexHookEvent, CodexHookMatcherGroup[]>> = {};
  for (const [eventName, groupsRaw] of Object.entries(raw.hooks)) {
    if (!EVENT_SET.has(eventName)) {
      throw new CodexHookConfigError(filePath, `hooks.${eventName} is not a supported Codex event`);
    }
    if (!Array.isArray(groupsRaw)) {
      throw new CodexHookConfigError(filePath, `hooks.${eventName} must be an array`);
    }
    hooks[eventName as CodexHookEvent] = groupsRaw.map((group, groupIndex) =>
      validateGroup(group, filePath, eventName as CodexHookEvent, groupIndex),
    );
  }
  return { hooks };
}

function validateGroup(
  raw: unknown,
  filePath: string,
  eventName: CodexHookEvent,
  groupIndex: number,
): CodexHookMatcherGroup {
  const field = `hooks.${eventName}[${groupIndex}]`;
  if (!isRecord(raw)) throw new CodexHookConfigError(filePath, `${field} must be an object`);
  if (raw.matcher !== undefined && typeof raw.matcher !== "string") {
    throw new CodexHookConfigError(filePath, `${field}.matcher must be a string`);
  }
  if (typeof raw.matcher === "string" && raw.matcher !== "*") {
    try {
      new RegExp(raw.matcher);
    } catch (error) {
      throw new CodexHookConfigError(filePath, `${field}.matcher is invalid: ${errorMessage(error)}`);
    }
  }
  if (raw.hooks !== undefined && !Array.isArray(raw.hooks)) {
    throw new CodexHookConfigError(filePath, `${field}.hooks must be an array`);
  }
  return {
    ...(typeof raw.matcher === "string" ? { matcher: raw.matcher } : {}),
    hooks: (raw.hooks ?? []).map((handler: unknown, handlerIndex: number) =>
      validateHandler(handler, filePath, `${field}.hooks[${handlerIndex}]`),
    ),
  };
}

function validateHandler(raw: unknown, filePath: string, field: string): CodexHookHandler {
  if (!isRecord(raw)) throw new CodexHookConfigError(filePath, `${field} must be an object`);
  if (raw.type === "prompt" || raw.type === "agent") return { ...raw, type: raw.type };
  if (raw.type !== "command") {
    throw new CodexHookConfigError(filePath, `${field}.type must be command, prompt, or agent`);
  }
  if (typeof raw.command !== "string" || raw.command.trim() === "") {
    throw new CodexHookConfigError(filePath, `${field}.command must be a non-empty string`);
  }
  if (raw.commandWindows !== undefined && typeof raw.commandWindows !== "string") {
    throw new CodexHookConfigError(filePath, `${field}.commandWindows must be a string`);
  }
  if (raw.command_windows !== undefined && typeof raw.command_windows !== "string") {
    throw new CodexHookConfigError(filePath, `${field}.command_windows must be a string`);
  }
  if (raw.timeout !== undefined && (!Number.isInteger(raw.timeout) || Number(raw.timeout) < 0)) {
    throw new CodexHookConfigError(filePath, `${field}.timeout must be a non-negative integer`);
  }
  if (raw.statusMessage !== undefined && typeof raw.statusMessage !== "string") {
    throw new CodexHookConfigError(filePath, `${field}.statusMessage must be a string`);
  }
  if (raw.async !== undefined && typeof raw.async !== "boolean") {
    throw new CodexHookConfigError(filePath, `${field}.async must be a boolean`);
  }
  return {
    type: "command",
    command: raw.command,
    commandWindows: typeof raw.commandWindows === "string"
      ? raw.commandWindows
      : typeof raw.command_windows === "string"
        ? raw.command_windows
        : undefined,
    timeout: raw.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(raw.timeout),
    statusMessage: typeof raw.statusMessage === "string" ? raw.statusMessage : undefined,
    async: raw.async === true,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SkillParamValue = string | boolean | number;

export interface SkillDefaults {
  params: Record<string, SkillParamValue>;
  updated?: string;
}

export interface SkillPromptBudgets {
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface SkillConfigFile {
  version: string;
  skills: Record<string, SkillDefaults>;
  limits: SkillPromptBudgets;
}

export interface LoadedSkillConfig {
  config: SkillConfigFile;
  configHash: string;
  globalPath: string;
  projectPath: string;
}

export const DEFAULT_SKILL_PROMPT_BUDGETS: SkillPromptBudgets = {
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 512 * 1024,
};

const DEFAULT_CONFIG: SkillConfigFile = {
  version: "1.0.0",
  skills: {},
  limits: DEFAULT_SKILL_PROMPT_BUDGETS,
};

export class SkillConfigError extends Error {
  constructor(
    readonly code: "E_SKILL_CONFIG_INVALID",
    readonly filePath: string,
    message: string,
  ) {
    super(`${code}: ${message} (${filePath})`);
    this.name = "SkillConfigError";
  }
}

export async function loadSkillConfig(
  cwd: string,
  agentDir = getAgentDir(),
): Promise<LoadedSkillConfig> {
  const globalPath = join(agentDir, "skill-config.json");
  const projectPath = join(cwd, ".pi", "skill-config.json");
  const global = await readConfigFile(globalPath);
  const project = await readConfigFile(projectPath);

  const config: SkillConfigFile = {
    version: project?.version ?? global?.version ?? DEFAULT_CONFIG.version,
    skills: mergeSkills(global?.skills ?? {}, project?.skills ?? {}),
    limits: {
      ...DEFAULT_SKILL_PROMPT_BUDGETS,
      ...(global?.limits ?? {}),
      ...(project?.limits ?? {}),
    },
  };

  return { config, configHash: hashSkillConfig(config), globalPath, projectPath };
}

export function hashSkillConfig(config: SkillConfigFile): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

export function renderSkillConfigDefaults(
  skillName: string,
  defaults: SkillDefaults | undefined,
  args: string | undefined,
): string | null {
  if (!defaults || Object.keys(defaults.params).length === 0) return null;
  const explicitKeys = extractExplicitArgKeys(args ?? "");
  const entries = Object.entries(defaults.params)
    .filter(([key]) => !explicitKeys.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;

  return [
    `## Skill Config Defaults (${skillName})`,
    "Apply these defaults unless the task-level skill args explicitly provide the same parameter:",
    ...entries.map(([key, value]) => `${key}: ${String(value)}`),
  ].join("\n");
}

export function extractExplicitArgKeys(args: string): Set<string> {
  const keys = new Set<string>();
  const flagPattern = /(?:^|\s)--?([A-Za-z][\w-]*)(?==|\s|$)/g;
  const assignmentPattern = /(?:^|\s)([A-Za-z][\w-]*)=/g;
  let match: RegExpExecArray | null;
  while ((match = flagPattern.exec(args)) !== null) keys.add(match[1]);
  while ((match = assignmentPattern.exec(args)) !== null) keys.add(match[1]);
  return keys;
}

async function readConfigFile(filePath: string): Promise<SkillConfigFile | null> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, errorMessage(error));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, `invalid JSON: ${errorMessage(error)}`);
  }
  return validateConfig(raw, filePath);
}

function validateConfig(raw: unknown, filePath: string): SkillConfigFile {
  if (!isRecord(raw)) {
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, "root must be an object");
  }
  const version = typeof raw.version === "string" ? raw.version : DEFAULT_CONFIG.version;
  const skillsRaw = raw.skills ?? {};
  if (!isRecord(skillsRaw)) {
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, "skills must be an object");
  }

  const skills: Record<string, SkillDefaults> = {};
  for (const [skillName, value] of Object.entries(skillsRaw)) {
    if (!isRecord(value) || !isRecord(value.params)) {
      throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, `skills.${skillName}.params must be an object`);
    }
    const params: Record<string, SkillParamValue> = {};
    for (const [param, paramValue] of Object.entries(value.params)) {
      if (!["string", "boolean", "number"].includes(typeof paramValue)) {
        throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, `skills.${skillName}.params.${param} must be a primitive`);
      }
      params[param] = paramValue as SkillParamValue;
    }
    skills[skillName] = {
      params,
      ...(typeof value.updated === "string" ? { updated: value.updated } : {}),
    };
  }

  const limitsRaw = raw.limits ?? {};
  if (!isRecord(limitsRaw)) {
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, "limits must be an object");
  }
  const limits = {
    maxFileBytes: positiveInteger(limitsRaw.maxFileBytes, DEFAULT_SKILL_PROMPT_BUDGETS.maxFileBytes, filePath, "limits.maxFileBytes"),
    maxTotalBytes: positiveInteger(limitsRaw.maxTotalBytes, DEFAULT_SKILL_PROMPT_BUDGETS.maxTotalBytes, filePath, "limits.maxTotalBytes"),
  };
  if (limits.maxTotalBytes < limits.maxFileBytes) {
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, "limits.maxTotalBytes must be >= limits.maxFileBytes");
  }

  return { version, skills, limits };
}

function mergeSkills(
  globalSkills: Record<string, SkillDefaults>,
  projectSkills: Record<string, SkillDefaults>,
): Record<string, SkillDefaults> {
  const merged: Record<string, SkillDefaults> = { ...globalSkills };
  for (const [skillName, defaults] of Object.entries(projectSkills)) {
    const existing = merged[skillName];
    merged[skillName] = existing
      ? {
          params: { ...existing.params, ...defaults.params },
          updated: defaults.updated ?? existing.updated,
        }
      : defaults;
  }
  return merged;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  filePath: string,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new SkillConfigError("E_SKILL_CONFIG_INVALID", filePath, `${field} must be a positive integer`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

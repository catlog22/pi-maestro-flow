import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunTeammateParams } from "../runs/execution.ts";
import { resolveAgent } from "../agents/agents.ts";
import {
  TEAMMATE_TASK_TYPES,
  parseTeammateTaskType,
  type TeammateTaskType,
} from "../shared/task-types.ts";
import { parseTeammateThinkingLevel, type TeammateThinkingLevel } from "../shared/thinking.ts";

export { TEAMMATE_TASK_TYPES, parseTeammateTaskType } from "../shared/task-types.ts";
export type { TeammateTaskType } from "../shared/task-types.ts";

export const TEAMMATE_TASK_TYPE_META: Record<
  string,
  { label: string; roles: string; description: string }
> = {
  explore: { label: "Explore", roles: "explorer", description: "File discovery, definitions, and call sites" },
  analysis: { label: "Analysis", roles: "analyst / research / general", description: "Read-only tracing and technical investigation" },
  debug: { label: "Debug", roles: "analyst / general", description: "Root-cause diagnosis and runtime debugging" },
  planning: { label: "Planning", roles: "planner / workflow", description: "Architecture and execution planning" },
  development: { label: "Development", roles: "general", description: "Implementation and refactoring" },
  review: { label: "Review", roles: "analyst", description: "Correctness, quality, and security review" },
  testing: { label: "Testing", roles: "general / analyst", description: "Tests, coverage, and regression validation" },
};

export interface ModelRoutingConfig {
  version: 2;
  mappings: Partial<Record<TeammateTaskType, string | null>>;
  fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
  thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
}

export interface TaskTypeInput {
  taskType?: TeammateTaskType;
  agent?: string;
  task?: string;
}

const CONFIG_FILE = "teammate-models.json";

export function getGlobalModelRoutingPath(): string {
  return path.join(os.homedir(), ".pi", "agent", CONFIG_FILE);
}

export function getProjectModelRoutingPath(cwd: string): string {
  return path.join(cwd, ".pi", CONFIG_FILE);
}

function readConfig(filePath: string): ModelRoutingConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ModelRoutingConfig>;
    const mappings: Partial<Record<TeammateTaskType, string | null>> = {};
    const fallbackMappings: Partial<Record<TeammateTaskType, string[] | null>> = {};
    const thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>> = {};
    const rawMappings = parsed.mappings && typeof parsed.mappings === "object" ? parsed.mappings : {};
    const rawFallbacks = parsed.fallbackMappings && typeof parsed.fallbackMappings === "object" ? parsed.fallbackMappings : {};
    const rawThinking = parsed.thinkingLevels && typeof parsed.thinkingLevels === "object" ? parsed.thinkingLevels : {};
    const taskTypes = new Set([...Object.keys(rawMappings), ...Object.keys(rawFallbacks), ...Object.keys(rawThinking)]);
    for (const rawTaskType of taskTypes) {
      const taskType = parseTeammateTaskType(rawTaskType);
      if (!taskType) continue;
      const value = rawMappings[rawTaskType];
      if (typeof value === "string" && value.trim()) mappings[taskType] = value.trim();
      else if (value === null) mappings[taskType] = null;
      const fallback = rawFallbacks[rawTaskType];
      if (fallback === null) fallbackMappings[taskType] = null;
      else if (Array.isArray(fallback)) {
        const models = [...new Set(fallback.filter((model): model is string => typeof model === "string").map((model) => model.trim()).filter(Boolean))];
        fallbackMappings[taskType] = models;
      }
      const thinking = rawThinking[rawTaskType];
      if (thinking === null) thinkingLevels[taskType] = null;
      else {
        const parsedThinking = parseTeammateThinkingLevel(thinking);
        if (parsedThinking) thinkingLevels[taskType] = parsedThinking;
      }
    }
    return {
      version: 2,
      mappings,
      ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
      thinkingLevels,
    };
  } catch {
    return { version: 2, mappings: {}, thinkingLevels: {} };
  }
}

export function loadModelRoutingConfig(cwd: string): ModelRoutingConfig {
  const globalConfig = readConfig(getGlobalModelRoutingPath());
  const projectConfig = readConfig(getProjectModelRoutingPath(cwd));
  return {
    version: 2,
    mappings: { ...globalConfig.mappings, ...projectConfig.mappings },
    fallbackMappings: { ...globalConfig.fallbackMappings, ...projectConfig.fallbackMappings },
    thinkingLevels: { ...globalConfig.thinkingLevels, ...projectConfig.thinkingLevels },
  };
}

export function discoverRoutingTaskTypes(
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
): TeammateTaskType[] {
  const config = loadModelRoutingConfig(cwd);
  const taskTypes = new Set<TeammateTaskType>(TEAMMATE_TASK_TYPES);
  for (const agent of agents) {
    const taskType = parseTeammateTaskType(agent.taskType);
    if (taskType) taskTypes.add(taskType);
  }
  for (const taskType of [
    ...Object.keys(config.mappings),
    ...Object.keys(config.fallbackMappings ?? {}),
    ...Object.keys(config.thinkingLevels),
  ]) {
    const normalized = parseTeammateTaskType(taskType);
    if (normalized) taskTypes.add(normalized);
  }
  const builtins = new Set<string>(TEAMMATE_TASK_TYPES);
  return [...taskTypes].sort((left, right) => {
    const leftIndex = TEAMMATE_TASK_TYPES.indexOf(left as typeof TEAMMATE_TASK_TYPES[number]);
    const rightIndex = TEAMMATE_TASK_TYPES.indexOf(right as typeof TEAMMATE_TASK_TYPES[number]);
    if (builtins.has(left) && builtins.has(right)) return leftIndex - rightIndex;
    if (builtins.has(left)) return -1;
    if (builtins.has(right)) return 1;
    return left.localeCompare(right);
  });
}

export function saveProjectThinkingLevel(
  cwd: string,
  taskType: TeammateTaskType,
  thinking: TeammateThinkingLevel | null,
): ModelRoutingConfig {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  const filePath = getProjectModelRoutingPath(cwd);
  const config = readConfig(filePath);
  config.thinkingLevels[normalizedTaskType] = thinking;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return loadModelRoutingConfig(cwd);
}

export function saveProjectModelMapping(
  cwd: string,
  taskType: TeammateTaskType,
  model: string | null,
): ModelRoutingConfig {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  const filePath = getProjectModelRoutingPath(cwd);
  const config = readConfig(filePath);
  config.mappings[normalizedTaskType] = model;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return loadModelRoutingConfig(cwd);
}

export function saveProjectFallbackMapping(
  cwd: string,
  taskType: TeammateTaskType,
  models: string[] | null,
): ModelRoutingConfig {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  const filePath = getProjectModelRoutingPath(cwd);
  const config = readConfig(filePath);
  config.fallbackMappings ??= {};
  config.fallbackMappings[normalizedTaskType] = models === null
    ? null
    : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return loadModelRoutingConfig(cwd);
}

export function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined {
  if (input.taskType) return input.taskType;

  const agent = input.agent?.toLowerCase() ?? "";
  if (agent.includes("explorer") || agent === "explore") return "explore";
  if (agent.includes("analyst") || agent.includes("research")) return "analysis";
  if (agent.includes("debug")) return "debug";
  if (agent.includes("planner") || agent.includes("architect")) return "planning";
  if (agent.includes("review")) return "review";
  if (agent.includes("test") || agent.includes("qa")) return "testing";
  if (agent.includes("developer") || agent.includes("implement") || agent.includes("worker")) return "development";

  const task = input.task?.toLowerCase() ?? "";
  if (/\b(debug|bug|root cause|reproduce|stack trace)\b/.test(task)) return "debug";
  if (/\b(plan|architecture design|migration strategy|break down)\b/.test(task)) return "planning";
  if (/\b(review|audit|assess quality|security risk)\b/.test(task)) return "review";
  if (/\b(test|coverage|regression|qa)\b/.test(task)) return "testing";
  if (/\b(implement|develop|refactor|fix|write code)\b/.test(task)) return "development";
  if (/\b(find|locate|search|where is|call site|definition)\b/.test(task)) return "explore";
  if (/\b(analyze|trace|investigate|explain)\b/.test(task)) return "analysis";
  return undefined;
}

function mappedModel(
  config: ModelRoutingConfig,
  input: TaskTypeInput,
  availableModels: readonly string[],
): string | undefined {
  const taskType = inferTaskType(input);
  if (!taskType) return undefined;
  const configured = config.mappings[taskType];
  if (!configured) return undefined;
  if (availableModels.length > 0 && !availableModels.includes(configured)) return undefined;
  return configured;
}

function mappedFallbackModels(
  config: ModelRoutingConfig,
  input: TaskTypeInput,
  availableModels: readonly string[],
): string[] | undefined {
  const taskType = inferTaskType(input);
  if (!taskType) return undefined;
  const configured = config.fallbackMappings?.[taskType];
  if (!configured) return undefined;
  const filtered = availableModels.length > 0
    ? configured.filter((model) => availableModels.includes(model))
    : configured;
  return filtered.length > 0 ? [...new Set(filtered)] : undefined;
}

function mappedThinking(config: ModelRoutingConfig, input: TaskTypeInput): TeammateThinkingLevel | undefined {
  const taskType = inferTaskType(input);
  if (!taskType) return undefined;
  return config.thinkingLevels[taskType] ?? undefined;
}

export function applyModelRouting(
  params: RunTeammateParams,
  cwd: string,
  availableModels: readonly string[] = [],
): RunTeammateParams {
  const topLevelModel = params.model;
  const topLevelThinking = parseTeammateThinkingLevel(params.thinking);

  const tasks = params.tasks.map((task) => {
    const routingCwd = path.resolve(cwd, task.cwd ?? params.cwd ?? ".");
    const config = loadModelRoutingConfig(routingCwd);
    const agent = task.agent ?? params.agent ?? "general";
    const explicitTaskType = task.taskType ?? params.taskType;
    const roleTaskType = resolveAgent(routingCwd, agent)?.taskType;
    const taskType = explicitTaskType
      ?? roleTaskType
      ?? inferTaskType({ agent, task: task.prompt });
    return {
      ...task,
      ...(taskType ? { taskType } : {}),
      model: task.model ?? topLevelModel ?? mappedModel(config, {
        taskType,
        agent,
        task: task.prompt,
      }, availableModels),
      fallbackModels: task.fallbackModels ?? params.fallbackModels ?? mappedFallbackModels(config, {
        taskType,
        agent,
        task: task.prompt,
      }, availableModels),
      thinking: parseTeammateThinkingLevel(task.thinking) ?? topLevelThinking ?? mappedThinking(config, {
        taskType,
        agent,
        task: task.prompt,
      }),
    };
  });

  return {
    ...params,
    tasks,
    thinking: topLevelThinking,
  };
}

export function formatModelRoutingConfig(
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
): string {
  const config = loadModelRoutingConfig(cwd);
  return discoverRoutingTaskTypes(cwd, agents)
    .map((taskType) => {
      const fallbacks = config.fallbackMappings?.[taskType]?.join(",") || "none";
      return `- ${taskType}: model=${config.mappings[taskType] ?? "auto/default"}, fallbacks=${fallbacks}, thinking=${config.thinkingLevels[taskType] ?? "inherit/default"}`;
    })
    .join("\n");
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunTeammateParams } from "../runs/execution.ts";

export const TEAMMATE_TASK_TYPES = [
  "explore",
  "analysis",
  "debug",
  "planning",
  "development",
  "review",
  "testing",
] as const;

export type TeammateTaskType = (typeof TEAMMATE_TASK_TYPES)[number];

export interface ModelRoutingConfig {
  version: 1;
  mappings: Partial<Record<TeammateTaskType, string | null>>;
}

export interface TaskTypeInput {
  taskType?: TeammateTaskType;
  prompt?: string;
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
    for (const taskType of TEAMMATE_TASK_TYPES) {
      const value = parsed.mappings?.[taskType];
      if (typeof value === "string" && value.trim()) mappings[taskType] = value.trim();
      else if (value === null) mappings[taskType] = null;
    }
    return { version: 1, mappings };
  } catch {
    return { version: 1, mappings: {} };
  }
}

export function loadModelRoutingConfig(cwd: string): ModelRoutingConfig {
  const globalConfig = readConfig(getGlobalModelRoutingPath());
  const projectConfig = readConfig(getProjectModelRoutingPath(cwd));
  return {
    version: 1,
    mappings: { ...globalConfig.mappings, ...projectConfig.mappings },
  };
}

export function saveProjectModelMapping(
  cwd: string,
  taskType: TeammateTaskType,
  model: string | null,
): ModelRoutingConfig {
  const filePath = getProjectModelRoutingPath(cwd);
  const config = readConfig(filePath);
  config.mappings[taskType] = model;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return loadModelRoutingConfig(cwd);
}

export function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined {
  if (input.taskType) return input.taskType;

  const prompt = input.prompt?.toLowerCase() ?? "";
  if (prompt.includes("diagnose-bug") || prompt.includes("debug-runtime")) return "debug";
  if (prompt.includes("review-architecture") || prompt.includes("review-code-quality")) return "review";
  if (prompt.startsWith("analysis-")) return "analysis";
  if (prompt.startsWith("planning-")) return "planning";
  if (prompt.startsWith("development-generate-tests")) return "testing";
  if (prompt.startsWith("development-")) return "development";
  if (prompt === "review" || prompt.includes("review-code-quality")) return "review";

  const agent = input.agent?.toLowerCase() ?? "";
  if (agent.includes("explorer") || agent === "explore") return "explore";
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

export function applyModelRouting(
  params: RunTeammateParams,
  cwd: string,
  availableModels: readonly string[] = [],
): RunTeammateParams {
  const config = loadModelRoutingConfig(cwd);
  const topLevelModel = params.model;

  const tasks = params.tasks?.map((task) => ({
    ...task,
    taskType: task.taskType ?? params.taskType,
    model: task.model ?? topLevelModel ?? mappedModel(config, {
      taskType: task.taskType ?? params.taskType,
      prompt: task.prompt ?? params.prompt,
      agent: task.agent,
      task: task.task,
    }, availableModels),
  }));

  const chain = params.chain?.map((step) => ({
    ...step,
    taskType: step.taskType ?? params.taskType,
    model: step.model ?? topLevelModel ?? mappedModel(config, {
      taskType: step.taskType ?? params.taskType,
      prompt: step.prompt ?? params.prompt,
      agent: step.agent,
      task: step.task,
    }, availableModels),
  }));

  const isSingle = !tasks?.length && !chain?.length;
  return {
    ...params,
    ...(tasks ? { tasks } : {}),
    ...(chain ? { chain } : {}),
    ...(isSingle && !params.model
      ? { model: mappedModel(config, params, availableModels) }
      : {}),
  };
}

export function formatModelRoutingConfig(cwd: string): string {
  const config = loadModelRoutingConfig(cwd);
  return TEAMMATE_TASK_TYPES
    .map((taskType) => `- ${taskType}: ${config.mappings[taskType] ?? "auto/default"}`)
    .join("\n");
}

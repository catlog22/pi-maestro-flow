import { getMode, resolveStatePath } from "./mode.ts";
import { recordLastDispatch } from "./observe.ts";
import { loadRules } from "./rules.ts";
import { classifyIntent } from "./triage.ts";
import type {
  ExpertsMode,
  ExpertsRules,
  ExpertsTaskType,
  StageExpertsPlan,
  StagePipelineStep,
  StagePolicy,
  TeammateTaskLike,
} from "./types.ts";
import fs from "node:fs";
import path from "node:path";

/** Built-in aliases so Maestro chain commands map to policy keys. */
export const DEFAULT_STAGE_ALIASES: Record<string, string> = {
  analyze: "analyze",
  "analyze-macro": "analyze",
  "maestro-analyze": "analyze",
  plan: "plan",
  "maestro-plan": "plan",
  planning: "plan",
  execute: "execute",
  "maestro-execute": "execute",
  development: "execute",
  implement: "execute",
  review: "review",
  "maestro-review": "review",
  "quality-review": "review",
  test: "test",
  "quality-test": "test",
  "auto-test": "test",
  testing: "test",
  debug: "debug",
  "quality-debug": "debug",
  verify: "test",
  verification: "test",
  harvest: "review",
  learn: "analyze",
  grill: "analyze",
  companion: "execute",
};

export interface ResolveStageExpertsPlanOptions {
  mode?: ExpertsMode;
  cwd?: string;
  rules?: ExpertsRules;
  chainCommand?: string;
  /** When true, persist activeStage + lastStagePlan into .experts-mode.json */
  record?: boolean;
  /** Extra leader-facing notes appended to leaderInstructions */
  extraLeaderNotes?: string;
}

/**
 * Normalize a Maestro step/command/stage string to a stage policy key.
 */
export function resolveStageName(
  stageOrCommand: string | undefined | null,
  rules: ExpertsRules = loadRules(),
): string | undefined {
  if (!stageOrCommand || typeof stageOrCommand !== "string") return undefined;
  const raw = stageOrCommand.trim().toLowerCase();
  if (!raw) return undefined;
  const aliases = { ...DEFAULT_STAGE_ALIASES, ...(rules.stageAliases || {}) };
  if (aliases[raw]) return aliases[raw];
  // strip leading maestro- / quality-
  const stripped = raw.replace(/^(maestro-|quality-)/, "");
  if (aliases[stripped]) return aliases[stripped];
  if (rules.stagePolicies?.[raw]) return raw;
  if (rules.stagePolicies?.[stripped]) return stripped;
  return raw;
}

export function getStagePolicy(
  stageOrCommand: string | undefined | null,
  rules: ExpertsRules = loadRules(),
): { stage: string; policy: StagePolicy } | undefined {
  const stage = resolveStageName(stageOrCommand, rules);
  if (!stage) return undefined;
  const policy = rules.stagePolicies?.[stage];
  if (!policy || !Array.isArray(policy.pipeline) || policy.pipeline.length === 0) {
    return undefined;
  }
  return { stage, policy };
}

function agentForType(taskType: string, rules: ExpertsRules): string {
  return rules.taskTypes?.[taskType]?.agent || rules.defaultAgent || "general";
}

function stepToTask(
  step: StagePipelineStep,
  index: number,
  intent: string,
  stage: string,
  rules: ExpertsRules,
): TeammateTaskLike {
  const taskType = String(step.taskType || rules.defaultTaskType || "development");
  const agent = step.agent || agentForType(taskType, rules);
  const name = step.name || `${stage}-${taskType}-${index + 1}`;
  const roleHint = `You are the ${agent} expert for Maestro stage "${stage}" (taskType=${taskType}).`;
  const prompt = [
    roleHint,
    `Stage goal / user intent: ${intent || "(unspecified)"}`,
    "Produce concrete, evidence-backed work for this stage only.",
    "Do not hardcode model ids. Keep role ≠ model.",
  ].join("\n");
  const task: TeammateTaskLike = {
    name,
    prompt,
    agent,
    taskType,
  };
  if (Array.isArray(step.dependsOn) && step.dependsOn.length > 0) {
    task.dependsOn = step.dependsOn;
  }
  return task;
}

/**
 * Resolve the experts plan for a Maestro chain stage.
 * Stage policy defaults beat keyword triage when a policy exists.
 * In normal mode returns empty tasks (no force).
 */
export function resolveStageExpertsPlan(
  stageOrCommand: string,
  intent: string,
  opts: ResolveStageExpertsPlanOptions = {},
): StageExpertsPlan {
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? getMode(cwd);
  const rules = opts.rules ?? loadRules();
  const stage = resolveStageName(stageOrCommand, rules) || String(stageOrCommand || "").trim() || "unknown";
  const found = getStagePolicy(stage, rules);

  if (mode !== "experts") {
    return {
      mode: "normal",
      stage,
      source: "none",
      tasks: [],
      leaderInstructions:
        "Experts Mode is OFF. Execute normally; no stage expert pipeline is forced.",
      policy: found?.policy,
    };
  }

  let tasks: TeammateTaskLike[] = [];
  let source: StageExpertsPlan["source"] = "none";
  let policy = found?.policy;

  if (found) {
    tasks = found.policy.pipeline.map((step, i) =>
      stepToTask(step, i, intent, found.stage, rules),
    );
    source = "stage-policy";
    policy = found.policy;
  } else {
    // Fallback: keyword triage single task + optional pipeline expansion from rules.pipelines
    const triage = classifyIntent(intent || stage, rules);
    const pipelineTypes: string[] =
      (triage.pipeline && triage.pipeline.length > 0
        ? triage.pipeline
        : rules.pipelines?.full_feature) || [triage.taskType];
    tasks = pipelineTypes.map((taskType, i) =>
      stepToTask(
        { taskType: taskType as ExpertsTaskType, agent: agentForType(taskType, rules) },
        i,
        intent,
        stage,
        rules,
      ),
    );
    // Prefer primary triage type on first task
    if (tasks[0]) {
      tasks[0].taskType = triage.taskType;
      tasks[0].agent = triage.agent;
    }
    source = "triage-fallback";
  }

  const forbid = policy?.forbidMain?.length
    ? `Forbid main-session heavy work: ${policy.forbidMain.join("; ")}.`
    : "Do not implement broad feature work yourself with write/edit/bash.";
  const mayWrite = policy?.leaderMayWrite?.length
    ? `Leader may write only: ${policy.leaderMayWrite.join(", ")}.`
    : "Leader writes orchestration artifacts only (report.md, outputs/*.json, session/run commands).";

  const leaderInstructions = [
    `Experts Mode ON · stage="${stage}" · source=${source}.`,
    "You are the Leader (orchestrator) for this Maestro stage.",
    `Dispatch the stage expert pipeline via teammate (tasks already typed). ${forbid}`,
    mayWrite,
    "Call order: ensureExpertsDispatch(params,{stage}) → applyModelRouting — never hardcode models.",
    "After experts settle: synthesize into Run artifacts and continue Maestro session done/check.",
    opts.extraLeaderNotes || "",
    opts.chainCommand ? `chainCommand=${opts.chainCommand}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const plan: StageExpertsPlan = {
    mode: "experts",
    stage: found?.stage || stage,
    source,
    tasks,
    leaderInstructions,
    policy,
  };

  if (opts.record !== false) {
    try {
      writeActiveStage(cwd, {
        stage: plan.stage,
        source: plan.source,
        taskTypes: plan.tasks.map((t) => String(t.taskType || "")),
        agents: plan.tasks.map((t) => String(t.agent || "")),
        intentPreview: String(intent || "").slice(0, 160),
        at: new Date().toISOString(),
      });
      if (plan.tasks[0]) {
        recordLastDispatch(
          {
            mode: "experts",
            taskType: plan.tasks[0].taskType ? String(plan.tasks[0].taskType) : undefined,
            agent: plan.tasks[0].agent ? String(plan.tasks[0].agent) : undefined,
            forced: true,
            at: new Date().toISOString(),
            promptPreview: String(intent || "").slice(0, 120),
            stage: plan.stage,
          },
          cwd,
        );
      }
    } catch {
      // state persistence must not break planning
    }
  }

  return plan;
}

export interface ActiveStageState {
  stage: string;
  source?: string;
  taskTypes?: string[];
  agents?: string[];
  intentPreview?: string;
  /** P4.1: Maestro session/run that produced this stage (source="maestro-session"). */
  sessionId?: string;
  runId?: string;
  at?: string;
}

export function writeActiveStage(
  cwd = process.cwd(),
  activeStage: ActiveStageState,
  statePath?: string,
): void {
  const file = resolveStatePath(cwd, statePath);
  let prev: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) prev = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    prev = {};
  }
  const next = {
    ...prev,
    mode: prev.mode === "experts" || prev.mode === "normal" ? prev.mode : getMode(cwd, statePath),
    activeStage,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function readActiveStage(cwd = process.cwd(), statePath?: string): ActiveStageState | null {
  const file = resolveStatePath(cwd, statePath);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { activeStage?: ActiveStageState };
    if (!raw?.activeStage || typeof raw.activeStage.stage !== "string") return null;
    return raw.activeStage;
  } catch {
    return null;
  }
}

/**
 * Given a single teammate task without taskType, fill from stage policy primary step.
 * Returns undefined when no stage policy applies.
 */
export function primaryStageAssignment(
  stageOrCommand: string | undefined,
  rules: ExpertsRules = loadRules(),
): { taskType: string; agent: string; stage: string } | undefined {
  const found = getStagePolicy(stageOrCommand, rules);
  if (!found) return undefined;
  const step = found.policy.pipeline[0];
  if (!step) return undefined;
  const taskType = String(step.taskType);
  return {
    stage: found.stage,
    taskType,
    agent: step.agent || agentForType(taskType, rules),
  };
}

import { trackInFlight } from "./inflight.ts";
import { resolveMaestroStageFromWorkspace, setMaestroStageEnvIfUnset } from "./maestro-stage.ts";
import { getMode } from "./mode.ts";
import { recordLastDispatch } from "./observe.ts";
import { loadRules } from "./rules.ts";
import { primaryStageAssignment, writeActiveStage } from "./stage-policy.ts";
import { classifyIntent } from "./triage.ts";
import { setLeaderWaiting } from "./waiting.ts";
import type {
  ExpertsMode,
  ExpertsRules,
  TeammateParamsLike,
  TeammateTaskLike,
} from "./types.ts";

export interface EnsureExpertsDispatchOptions {
  mode?: ExpertsMode;
  cwd?: string;
  record?: boolean;
  rules?: ExpertsRules;
  /**
   * P4: Maestro chain stage / command name.
   * When set under experts mode, missing taskType is filled from stagePolicies
   * before keyword triage.
   */
  stage?: string;
}

/** Meta attached by ensureExpertsDispatch when experts mode forced assignments. */
export type ExpertsDispatchMeta = {
  mode: ExpertsMode;
  forced: boolean;
  stage?: string;
  stageForced?: boolean;
  triage: Array<{ taskType?: string; agent?: string }>;
};

/**
 * Ensure teammate-like params carry taskType/agent when Experts Mode is on.
 * Does NOT set model — leave that to applyModelRouting / teammate-models.
 *
 * Call order (required):
 *   ensureExpertsDispatch(params) → applyModelRouting(params, ...)
 *
 * The param contract is deliberately loose (`T extends object`): callers pass
 * RunTeammateParams / teammate tool params whose task specs carry no index
 * signature, so they do not structurally match TeammateParamsLike. We widen
 * internally and preserve the caller's concrete type on the way out.
 */
export function ensureExpertsDispatch<T extends object>(
  params: T,
  opts: EnsureExpertsDispatchOptions = {},
): T & { __experts?: ExpertsDispatchMeta } {
  const p = params as T & TeammateParamsLike;
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? getMode(cwd);
  const record = opts.record !== false;
  const rules = opts.rules ?? loadRules();
  let stageHint =
    opts.stage
    || (typeof p.stage === "string" ? p.stage : undefined)
    || (typeof process.env.MAESTRO_STAGE === "string" && process.env.MAESTRO_STAGE
      ? process.env.MAESTRO_STAGE
      : undefined);

  // P4.1: auto-detect the Maestro stage from session.json when nothing else
  // supplied, so stagePolicies apply without the Leader passing stage by hand.
  if (!stageHint && mode === "experts") {
    try {
      const found = resolveMaestroStageFromWorkspace(cwd);
      if (found?.stage) {
        stageHint = found.stage;
        try {
          setMaestroStageEnvIfUnset(found.stage);
        } catch {
          // env set must not break dispatch
        }
      }
    } catch {
      // workspace scan must never break dispatch
    }
  }

  if (mode !== "experts") {
    if (record) {
      recordLastDispatch({
        mode: "normal",
        taskType: firstTaskType(p),
        agent: firstAgent(p),
        model: firstModel(p),
        forced: false,
        at: new Date().toISOString(),
        promptPreview: preview(p),
      }, cwd);
    }
    return { ...params } as T & { __experts?: ExpertsDispatchMeta };
  }

  const tasks: TeammateTaskLike[] = Array.isArray(p.tasks) && p.tasks.length > 0
    ? p.tasks
    : [{
      prompt: typeof p.prompt === "string" ? p.prompt : "",
      agent: typeof p.agent === "string" ? p.agent : undefined,
      taskType: typeof p.taskType === "string" ? p.taskType : undefined,
      model: typeof p.model === "string" ? p.model : undefined,
    }];

  const stageAssignment = primaryStageAssignment(stageHint, rules);
  let anyForced = false;
  let stageForced = false;
  const nextTasks = tasks.map((task) => {
    if (typeof task.taskType === "string" && task.taskType) {
      return {
        ...task,
        agent: task.agent || agentForType(String(task.taskType), rules),
      };
    }
    // P4: stage policy primary assignment beats keyword triage.
    if (stageAssignment) {
      anyForced = true;
      stageForced = true;
      return {
        ...task,
        taskType: stageAssignment.taskType,
        agent: task.agent || stageAssignment.agent,
      };
    }
    const triage = classifyIntent(String(task.prompt || p.prompt || ""), rules);
    anyForced = true;
    return {
      ...task,
      taskType: triage.taskType,
      agent: task.agent || triage.agent,
    };
  });

  const out = {
    ...params,
    tasks: nextTasks,
  } as T & {
    taskType?: string;
    agent?: string;
    __experts?: ExpertsDispatchMeta;
  };

  if (!out.taskType && nextTasks[0]?.taskType) out.taskType = String(nextTasks[0].taskType);
  if (!out.agent && nextTasks[0]?.agent) out.agent = String(nextTasks[0].agent);

  out.__experts = {
    mode,
    forced: anyForced,
    stage: stageAssignment?.stage || stageHint,
    stageForced,
    triage: nextTasks.map((t) => ({
      taskType: t.taskType ? String(t.taskType) : undefined,
      agent: t.agent ? String(t.agent) : undefined,
    })),
  };

  if (record) {
    recordLastDispatch({
      mode: "experts",
      taskType: nextTasks[0]?.taskType ? String(nextTasks[0].taskType) : undefined,
      agent: nextTasks[0]?.agent ? String(nextTasks[0].agent) : undefined,
      // model is observed only if caller already set it — we never assign models here.
      model: nextTasks[0]?.model
        ? String(nextTasks[0].model)
        : (typeof p.model === "string" ? p.model : undefined),
      forced: anyForced,
      at: new Date().toISOString(),
      promptPreview: preview(p),
      stage: stageAssignment?.stage || stageHint,
    }, cwd);
    if (stageAssignment) {
      try {
        writeActiveStage(cwd, {
          stage: stageAssignment.stage,
          source: "stage-policy",
          taskTypes: nextTasks.map((t) => String(t.taskType || "")),
          agents: nextTasks.map((t) => String(t.agent || "")),
          intentPreview: preview(p),
          at: new Date().toISOString(),
        });
      } catch {
        // ignore state write failures
      }
    }
  }

  // Qoder leaderWaiting: mark leader waiting when experts mode dispatches work.
  try {
    const names = nextTasks
      .map((t) => (typeof t.name === "string" ? t.name : typeof t.agent === "string" ? t.agent : ""))
      .filter(Boolean);
    setLeaderWaiting(true, {
      cwd,
      activeDelta: nextTasks.length,
      agentIds: names,
    });
    // P6: track in-flight experts for getStatus / canvas snapshot.
    trackInFlight(
      nextTasks.map((t, i) => ({
        id: typeof t.name === "string" && t.name
          ? t.name
          : `${String(t.agent || "expert")}-${i}`,
        name: typeof t.name === "string" ? t.name : undefined,
        agent: typeof t.agent === "string" ? t.agent : undefined,
        taskType: typeof t.taskType === "string" ? t.taskType : undefined,
        stage: stageAssignment?.stage || stageHint,
      })),
      { cwd, stage: stageAssignment?.stage || stageHint },
    );
  } catch {
    // state write must not break dispatch
  }

  return out;
}

function agentForType(taskType: string, rules: ExpertsRules): string {
  return rules.taskTypes?.[taskType]?.agent || rules.defaultAgent || "general";
}

function preview(params: TeammateParamsLike): string {
  const text = params.tasks?.[0]?.prompt ?? params.prompt ?? "";
  return String(text).slice(0, 120);
}

function firstTaskType(params: TeammateParamsLike): string | undefined {
  if (typeof params.taskType === "string") return params.taskType;
  if (typeof params.tasks?.[0]?.taskType === "string") return params.tasks[0].taskType;
  return undefined;
}

function firstAgent(params: TeammateParamsLike): string | undefined {
  if (typeof params.agent === "string") return params.agent;
  if (typeof params.tasks?.[0]?.agent === "string") return params.tasks[0].agent;
  return undefined;
}

function firstModel(params: TeammateParamsLike): string | undefined {
  if (typeof params.model === "string") return params.model;
  if (typeof params.tasks?.[0]?.model === "string") return params.tasks[0].model;
  return undefined;
}

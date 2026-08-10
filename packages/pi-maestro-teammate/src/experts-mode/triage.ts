import { loadRules } from "./rules.ts";
import type { ExpertsRules, ExpertsTaskType, TriageResult } from "./types.ts";

function matchesKeyword(text: string, keyword: string): boolean {
  const t = text.toLowerCase();
  const k = keyword.toLowerCase();
  if (!k) return false;
  if (/[\u4e00-\u9fff]/.test(k) || k.length <= 3) return t.includes(k);
  const re = new RegExp(
    `(?:^|[^a-z0-9_])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9_])`,
    "i",
  );
  return re.test(text) || t.includes(k);
}

export function classifyIntent(text: string, rules: ExpertsRules = loadRules()): TriageResult {
  const input = String(text ?? "").trim();
  const matchedRules: string[] = [];

  if (!input) {
    return {
      taskType: (rules.defaultTaskType as ExpertsTaskType) || "development",
      agent: rules.defaultAgent || "general-executor",
      heavy: false,
      pipeline: (rules.pipelines?.tiny_fix as ExpertsTaskType[]) || ["development"],
      matchedRules: ["empty"],
      reason: "empty input → default light development",
    };
  }

  for (const kw of rules.lightKeywords || []) {
    if (matchesKeyword(input, kw) && input.length < 40) {
      matchedRules.push(`light:${kw}`);
      return {
        taskType: "analysis",
        agent: "general",
        heavy: false,
        pipeline: [],
        matchedRules,
        reason: `light intent matched "${kw}"`,
      };
    }
  }

  const hits: Array<{
    taskType: ExpertsTaskType;
    score: number;
    agent: string;
    heavy: boolean;
  }> = [];

  for (const [taskType, meta] of Object.entries(rules.taskTypes || {})) {
    let score = 0;
    for (const kw of meta.keywords || []) {
      if (matchesKeyword(input, kw)) {
        score += Math.max(1, Math.min(kw.length / 4, 3));
        matchedRules.push(`${taskType}:${kw}`);
      }
    }
    if (score > 0) {
      hits.push({
        taskType: taskType as ExpertsTaskType,
        score,
        agent: meta.agent || rules.defaultAgent || "general",
        heavy: meta.heavy !== false,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0];

  if (!best) {
    return {
      taskType: (rules.defaultTaskType as ExpertsTaskType) || "development",
      agent: rules.defaultAgent || "general-executor",
      heavy: true,
      pipeline: (rules.pipelines?.full_feature as ExpertsTaskType[])
        || (rules.defaultPipeline as ExpertsTaskType[])
        || ["explore", "planning", "development", "review"],
      matchedRules: ["fallback-default"],
      reason: "no keyword hit → default heavy development pipeline",
    };
  }

  let pipelineKey = "full_feature";
  if (best.taskType === "explore" || best.taskType === "analysis") pipelineKey = "investigation";
  else if (best.taskType === "debug") pipelineKey = "debug";
  else if (best.taskType === "review" || best.taskType === "testing" || best.taskType === "verification") {
    pipelineKey = "tiny_fix";
  } else if (input.length < 50 && best.taskType === "development") {
    pipelineKey = "tiny_fix";
  }

  const pipeline = (rules.pipelines?.[pipelineKey] as ExpertsTaskType[])
    || (rules.defaultPipeline as ExpertsTaskType[])
    || [best.taskType];

  return {
    taskType: best.taskType,
    agent: best.agent,
    heavy: best.heavy,
    pipeline,
    matchedRules,
    reason: `best=${best.taskType} score=${best.score.toFixed(1)} pipeline=${pipelineKey}`,
  };
}

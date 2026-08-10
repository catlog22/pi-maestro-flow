import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpertsRules } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_PATH = path.resolve(__dirname, "./config/default-rules.json");

/** Project-level override (merged over package defaults). */
export const PROJECT_RULES_FILENAME = ".experts-rules.json";

let cachedRules: ExpertsRules | null = null;
let cachedKey: string | null = null;

/**
 * Load experts rules: package default-rules.json, optionally merged with
 * `<cwd>/.experts-rules.json` (shallow + settle/hardGate/stagePolicies deep-ish merge).
 */
export function loadRules(
  rulesPath: string = DEFAULT_RULES_PATH,
  cwd: string = process.cwd(),
): ExpertsRules {
  const basePath = path.resolve(rulesPath || DEFAULT_RULES_PATH);
  const projectPath = path.resolve(cwd || process.cwd(), PROJECT_RULES_FILENAME);
  const key = `${basePath}::${projectPath}`;
  if (cachedRules && cachedKey === key) return cachedRules;

  const base = JSON.parse(fs.readFileSync(basePath, "utf8")) as ExpertsRules;
  let merged: ExpertsRules = base;
  try {
    if (fs.existsSync(projectPath)) {
      const overlay = JSON.parse(fs.readFileSync(projectPath, "utf8")) as ExpertsRules;
      merged = mergeRules(base, overlay);
    }
  } catch {
    merged = base;
  }

  cachedRules = merged;
  cachedKey = key;
  return merged;
}

export function clearRulesCache(): void {
  cachedRules = null;
  cachedKey = null;
}

export function defaultRulesPath(): string {
  return DEFAULT_RULES_PATH;
}

export function projectRulesPath(cwd = process.cwd()): string {
  return path.resolve(cwd, PROJECT_RULES_FILENAME);
}

/** Shallow merge with nested merge for settle / hardGate / stagePolicies / roster / stageAliases. */
export function mergeRules(base: ExpertsRules, overlay: ExpertsRules): ExpertsRules {
  return {
    ...base,
    ...overlay,
    hardGate: overlay.hardGate
      ? {
        ...base.hardGate,
        ...overlay.hardGate,
        tools: {
          ...(base.hardGate?.tools || {}),
          ...(overlay.hardGate?.tools || {}),
        },
        leaderAllowPaths: overlay.hardGate.leaderAllowPaths
          ?? base.hardGate?.leaderAllowPaths,
        bashAllowPrefixes: overlay.hardGate.bashAllowPrefixes
          ?? base.hardGate?.bashAllowPrefixes,
      }
      : base.hardGate,
    settle: overlay.settle
      ? { ...base.settle, ...overlay.settle }
      : base.settle,
    orchestrator: overlay.orchestrator
      ? { ...(base.orchestrator || {}), ...overlay.orchestrator }
      : base.orchestrator,
    stagePolicies: overlay.stagePolicies
      ? { ...(base.stagePolicies || {}), ...overlay.stagePolicies }
      : base.stagePolicies,
    stageAliases: overlay.stageAliases
      ? { ...(base.stageAliases || {}), ...overlay.stageAliases }
      : base.stageAliases,
    roster: overlay.roster
      ? { ...(base.roster || {}), ...overlay.roster }
      : base.roster,
    taskTypes: overlay.taskTypes
      ? { ...(base.taskTypes || {}), ...overlay.taskTypes }
      : base.taskTypes,
    pipelines: overlay.pipelines
      ? { ...(base.pipelines || {}), ...overlay.pipelines }
      : base.pipelines,
  };
}

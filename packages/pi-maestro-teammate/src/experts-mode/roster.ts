import { loadRules } from "./rules.ts";
import type { ExpertsRules, RosterEntry } from "./types.ts";

/**
 * P6: resolve the project experts roster.
 * Prefer explicit rules.roster; fall back to taskTypes → agent mapping.
 * Never assigns models (role ≠ model).
 */
export function getRoster(rules: ExpertsRules = loadRules()): RosterEntry[] {
  const fromConfig = rosterFromConfig(rules);
  if (fromConfig.length > 0) return fromConfig;
  return rosterFromTaskTypes(rules);
}

/** Lookup one roster entry by role id, agent name, or defaultTaskType. */
export function resolveRosterEntry(
  query: string,
  rules: ExpertsRules = loadRules(),
): RosterEntry | undefined {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return undefined;
  const list = getRoster(rules);
  return (
    list.find((e) => e.id.toLowerCase() === q)
    || list.find((e) => e.agent.toLowerCase() === q)
    || list.find((e) => e.defaultTaskType.toLowerCase() === q)
    || list.find((e) => (e.label || "").toLowerCase() === q)
  );
}

/** Map taskType → preferred agent via roster (else taskTypes / defaultAgent). */
export function agentForTaskTypeFromRoster(
  taskType: string,
  rules: ExpertsRules = loadRules(),
): string {
  const list = getRoster(rules);
  const hit = list.find(
    (e) => e.enabled !== false && e.defaultTaskType === taskType,
  );
  if (hit?.agent) return hit.agent;
  return rules.taskTypes?.[taskType]?.agent || rules.defaultAgent || "general";
}

function rosterFromConfig(rules: ExpertsRules): RosterEntry[] {
  const raw = rules.roster;
  if (!raw || typeof raw !== "object") return [];
  const out: RosterEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const agent = String(value.agent || key).trim();
    const defaultTaskType = String(
      value.defaultTaskType || rules.defaultTaskType || "development",
    ).trim();
    if (!agent || !defaultTaskType) continue;
    out.push({
      id: String(value.id || key).trim() || key,
      agent,
      defaultTaskType,
      label: value.label ? String(value.label) : undefined,
      capabilities: Array.isArray(value.capabilities)
        ? value.capabilities.map(String)
        : undefined,
      tools: Array.isArray(value.tools) ? value.tools.map(String) : undefined,
      enabled: value.enabled === false ? false : true,
    });
  }
  return out;
}

function rosterFromTaskTypes(rules: ExpertsRules): RosterEntry[] {
  const types = rules.taskTypes || {};
  return Object.entries(types).map(([taskType, cfg]) => {
    const agent = String(cfg?.agent || rules.defaultAgent || "general");
    return {
      id: taskType,
      agent,
      defaultTaskType: taskType,
      label: taskType,
      capabilities: [taskType],
      enabled: true,
    } satisfies RosterEntry;
  });
}

import { loadRules } from "./rules.ts";
import type { ExpertsRules, RosterEntry } from "./types.ts";

/**
 * P6: resolve the project experts roster.
 * Prefer explicit rules.roster (+ expertProfiles overlay); fall back to taskTypes.
 * Role name ≠ model id — optional model/channel/skills are config mappings only.
 */
export function getRoster(rules: ExpertsRules = loadRules()): RosterEntry[] {
  const fromConfig = rosterFromConfig(rules);
  const merged = mergeExpertProfiles(fromConfig, rules);
  if (merged.length > 0) return merged;
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

function parseRosterValue(
  key: string,
  value: Omit<RosterEntry, "id"> & { id?: string },
  rules: ExpertsRules,
): RosterEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const agent = String(value.agent || key).trim();
  const defaultTaskType = String(
    value.defaultTaskType || rules.defaultTaskType || "development",
  ).trim();
  if (!agent || !defaultTaskType) return undefined;
  const fallbackModels = Array.isArray(value.fallbackModels)
    ? value.fallbackModels.map(String).map((s) => s.trim()).filter(Boolean)
    : undefined;
  const skills = Array.isArray(value.skills)
    ? value.skills.map(String).map((s) => s.trim()).filter(Boolean)
    : undefined;
  return {
    id: String(value.id || key).trim() || key,
    agent,
    defaultTaskType,
    label: value.label ? String(value.label) : undefined,
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.map(String)
      : undefined,
    tools: Array.isArray(value.tools) ? value.tools.map(String) : undefined,
    enabled: value.enabled === false ? false : true,
    model: value.model ? String(value.model).trim() : undefined,
    fallbackModels: fallbackModels?.length ? fallbackModels : undefined,
    thinking: value.thinking ? String(value.thinking).trim() : undefined,
    channel: value.channel ? String(value.channel).trim() : undefined,
    skills: skills?.length ? skills : undefined,
  };
}

function rosterFromConfig(rules: ExpertsRules): RosterEntry[] {
  const raw = rules.roster;
  if (!raw || typeof raw !== "object") return [];
  const out: RosterEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const entry = parseRosterValue(key, value, rules);
    if (entry) out.push(entry);
  }
  return out;
}

/** Overlay expertProfiles onto roster (profiles win on same id/agent/key). */
function mergeExpertProfiles(base: RosterEntry[], rules: ExpertsRules): RosterEntry[] {
  const profiles = rules.expertProfiles;
  if (!profiles || typeof profiles !== "object") return base;
  const byId = new Map(base.map((e) => [e.id.toLowerCase(), { ...e }]));
  for (const [key, value] of Object.entries(profiles)) {
    const entry = parseRosterValue(key, value, rules);
    if (!entry) continue;
    const existing =
      byId.get(entry.id.toLowerCase())
      || byId.get(entry.agent.toLowerCase())
      || byId.get(key.toLowerCase());
    if (existing) {
      const merged: RosterEntry = {
        ...existing,
        ...entry,
        id: existing.id,
        // Prefer profile fields when set; keep base when profile omits
        model: entry.model ?? existing.model,
        fallbackModels: entry.fallbackModels ?? existing.fallbackModels,
        thinking: entry.thinking ?? existing.thinking,
        channel: entry.channel ?? existing.channel,
        skills: entry.skills ?? existing.skills,
        agent: entry.agent || existing.agent,
        defaultTaskType: entry.defaultTaskType || existing.defaultTaskType,
      };
      byId.set(existing.id.toLowerCase(), merged);
    } else {
      byId.set(entry.id.toLowerCase(), entry);
    }
  }
  return [...byId.values()];
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

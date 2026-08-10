/**
 * Expert profile resolution — maps roster roles to preferred model / channel / skills.
 *
 * Precedence for model (applied only under experts mode):
 *   explicit task.model > expert profile (roster) > applyModelRouting (taskType/roleMappings)
 *
 * This module never invents models from keywords. All model/channel/skills values
 * come from project `.experts-rules.json` (or package defaults). Role name ≠ model id.
 */
import { getMode } from "./mode.ts";
import { loadRules, defaultRulesPath } from "./rules.ts";
import { resolveRosterEntry } from "./roster.ts";
import type {
  ExpertsMode,
  ExpertsRules,
  TeammateParamsLike,
  TeammateTaskLike,
} from "./types.ts";

export const EXPERTS_SKILLS_START = "<!-- experts-skills:start -->";
export const EXPERTS_SKILLS_END = "<!-- experts-skills:end -->";

export interface ExpertProfileResolved {
  id: string;
  agent: string;
  defaultTaskType: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  channel?: string;
  skills?: string[];
  source: "roster" | "taskTypes-fallback";
}

/** Resolve channel alias via rules.channels, else return the raw channel string. */
export function resolveChannel(
  channel: string | undefined,
  rules: ExpertsRules,
): string | undefined {
  const c = String(channel ?? "").trim();
  if (!c) return undefined;
  const alias = rules.channels?.[c] ?? rules.channels?.[c.toLowerCase()];
  if (alias && String(alias).trim()) return String(alias).trim();
  return c;
}

/**
 * Build a full provider/model ref.
 * - model with "/" is returned as-is
 * - bare model + channel → `${resolvedChannel}/${model}`
 * - bare model only → model
 */
export function resolveModelRef(
  model: string | undefined,
  channel: string | undefined,
  rules: ExpertsRules,
): string | undefined {
  const m = String(model ?? "").trim();
  if (!m) return undefined;
  if (m.includes("/")) return m;
  const ch = resolveChannel(channel, rules);
  if (ch) return `${ch}/${m}`;
  return m;
}

/** Lookup roster entry by agent / taskType / name and resolve model through channel. */
export function resolveExpertProfile(
  query: { agent?: string; taskType?: string; name?: string },
  rules: ExpertsRules = loadRules(),
): ExpertProfileResolved | undefined {
  let entry =
    (query.agent ? resolveRosterEntry(query.agent, rules) : undefined)
    || (query.taskType ? resolveRosterEntry(query.taskType, rules) : undefined)
    || (query.name ? resolveRosterEntry(query.name, rules) : undefined);
  if (!entry) return undefined;

  const model = resolveModelRef(entry.model, entry.channel, rules);
  const fallbackModels = entry.fallbackModels
    ?.map((f) => resolveModelRef(f, entry!.channel, rules) || f)
    .filter(Boolean) as string[] | undefined;

  return {
    id: entry.id,
    agent: entry.agent,
    defaultTaskType: entry.defaultTaskType,
    model,
    fallbackModels: fallbackModels?.length ? fallbackModels : undefined,
    thinking: entry.thinking,
    channel: entry.channel,
    skills: entry.skills,
    source: (rules.roster || rules.expertProfiles) ? "roster" : "taskTypes-fallback",
  };
}

function injectSkills(prompt: string | undefined, skills: string[]): string {
  const base = String(prompt ?? "");
  if (!skills.length) return base;
  if (base.includes(EXPERTS_SKILLS_START)) return base;
  const block = [
    EXPERTS_SKILLS_START,
    "Required skills for this expert (load via resource skill://name when available):",
    ...skills.map((s) => `- ${s}`),
    EXPERTS_SKILLS_END,
  ].join("\n");
  return base ? `${base}\n\n${block}` : block;
}

/**
 * Apply expert roster profiles onto teammate params (experts mode only).
 * Fills model / fallbackModels / thinking when unset; injects skills marker into prompt.
 * Never overrides explicit task.model.
 */
export function applyExpertProfiles<T extends object>(
  params: T,
  opts: { cwd?: string; rules?: ExpertsRules; mode?: ExpertsMode } = {},
): T {
  const cwd = opts.cwd ?? process.cwd();
  const mode = opts.mode ?? getMode(cwd);
  if (mode !== "experts") return params;

  const rules = opts.rules ?? loadRules(defaultRulesPath(), cwd);
  const p = params as T & TeammateParamsLike;
  const tasks = Array.isArray(p.tasks) ? p.tasks : undefined;

  if (!tasks || tasks.length === 0) {
    const profile = resolveExpertProfile(
      {
        agent: typeof p.agent === "string" ? p.agent : undefined,
        taskType: typeof p.taskType === "string" ? p.taskType : undefined,
      },
      rules,
    );
    if (!profile) return params;
    const out = { ...p } as T & TeammateParamsLike;
    if (!out.model && profile.model) out.model = profile.model;
    if (!out.fallbackModels && profile.fallbackModels) out.fallbackModels = profile.fallbackModels;
    if (!out.thinking && profile.thinking) out.thinking = profile.thinking;
    if (profile.skills?.length) {
      out.prompt = injectSkills(
        typeof out.prompt === "string" ? out.prompt : undefined,
        profile.skills,
      );
    }
    return out as T;
  }

  const nextTasks = tasks.map((task) => {
    const t = { ...task } as TeammateTaskLike;
    const profile = resolveExpertProfile(
      {
        agent: typeof t.agent === "string"
          ? t.agent
          : (typeof p.agent === "string" ? p.agent : undefined),
        taskType: typeof t.taskType === "string"
          ? t.taskType
          : (typeof p.taskType === "string" ? p.taskType : undefined),
        name: typeof t.name === "string" ? t.name : undefined,
      },
      rules,
    );
    if (!profile) return t;
    if (!t.model && profile.model) t.model = profile.model;
    if (!t.fallbackModels && profile.fallbackModels) t.fallbackModels = profile.fallbackModels;
    if (!t.thinking && profile.thinking) t.thinking = profile.thinking;
    if (profile.skills?.length) {
      t.prompt = injectSkills(
        typeof t.prompt === "string" ? t.prompt : undefined,
        profile.skills,
      );
    }
    return t;
  });

  return { ...p, tasks: nextTasks } as T;
}

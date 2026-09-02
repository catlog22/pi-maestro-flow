import { execFileSync } from "node:child_process";
import { logDiagnosticError, logDiagnosticWarn } from "../shared/diagnostic-log.ts";

import { randomUUID } from "node:crypto";
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
import type {
  ModelCircuitPolicy,
  ModelCircuitBreaker,
  ModelHealthCoordinator,
} from "./model-circuit-breaker.ts";
import type {
  DispatchAuthorityProjection,
  ModelDeploymentRoute,
  ModelDispatchRoute,
} from "./model-registry.ts";

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

/**
 * Effective metadata for a task type: the user-defined `typeMeta` keywords
 * from the routing config, if any (custom types have no built-in meta).
 */
export function resolveTaskTypeMeta(
  config: ModelRoutingConfig,
  taskType: TeammateTaskType,
): { keywords?: string[] } | undefined {
  const override = config.typeMeta?.[taskType];
  if (!override || override === null || !override.keywords || override.keywords.length === 0) return undefined;
  return { keywords: [...override.keywords] };
}

export interface ModelRoutingRoleRules {
  model?: string | null;
  fallbackModels?: string[] | null;
  thinking?: TeammateThinkingLevel | null;
  /** Per-role circuit breaker policy applied to the role's mapped model. */
  circuit?: ModelCircuitPolicy | null;
  /** Assigned task type; outranks the agent's frontmatter taskType at routing time. */
  taskType?: TeammateTaskType | null;
}

/** User-editable metadata for a task type: trigger keywords, like a skill description. */
export interface ModelRoutingTypeMeta {
  /** Trigger keywords defining when to use the type; `null` clears them. */
  keywords?: string[] | null;
}

export interface ModelRoutingRules {
  mappings: Partial<Record<TeammateTaskType, string | null>>;
  fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
  thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
  roleMappings?: Record<string, ModelRoutingRoleRules | null>;
  /** Trigger-keyword metadata per task type; `null` clears an override. */
  typeMeta?: Record<string, ModelRoutingTypeMeta | null>;
}

export interface ModelRoutingProfile extends ModelRoutingRules {
  name: string;
}

export interface GlobalModelRoutingStore {
  version: 3;
  defaultProfile: string;
  profiles: Record<string, ModelRoutingProfile>;
  retiredProfileIds?: string[];
  /** Ask the user to confirm/pick model provider + thinking before each root dispatch. */
  askBeforeDispatch?: boolean;
}

export interface ProjectModelRoutingStore {
  version: 3;
  activeProfile?: string;
  applyOverrides: boolean;
  overrides: ModelRoutingRules;
}

interface ModelRoutingTransaction {
  version: 1;
  mode: "forward" | "rollback";
  projectFilePath: string;
  globalBefore: GlobalModelRoutingStore;
  globalAfter: GlobalModelRoutingStore;
  projectAfter: ProjectModelRoutingStore;
}

export interface ModelRoutingConfig extends ModelRoutingRules {
  version: 3;
  profileId: string;
  profileName: string;
  projectOverridesEnabled: boolean;
}

export interface ModelRoutingState {
  global: GlobalModelRoutingStore;
  project: ProjectModelRoutingStore;
  config: ModelRoutingConfig;
  /** Effective ask-before-dispatch flag (global store, default off). */
  askBeforeDispatch: boolean;
  requestedProfile?: string;
  missingProfile?: string;
  changedProfileId?: string;
}

export interface TaskTypeInput {
  taskType?: TeammateTaskType;
  agent?: string;
  task?: string;
}

const CONFIG_FILE = "teammate-models.json";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Default";
const LOCK_WAIT_MS = 15_000;
const LOCK_RENAME_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 20;
const LOCK_IDENTITY_CHECK_MS = 5_000;

export function getGlobalModelRoutingPath(): string {
  return path.join(os.homedir(), ".pi", "agent", CONFIG_FILE);
}

export function getProjectModelRoutingPath(cwd: string): string {
  return path.join(cwd, ".pi", CONFIG_FILE);
}

/**
 * Per-session routing overrides file path. The sessionId is sanitized to a
 * filesystem-safe slug so an untrusted id cannot escape the `.pi/` directory.
 * Session overrides stack on top of project overrides at the task-type mapping
 * layer and are scoped to the single Pi session that wrote them.
 */
export function getSessionModelRoutingPath(cwd: string, sessionId: string): string {
  // Strip everything except [a-zA-Z0-9_-] and collapse runs so an untrusted
  // session id cannot smuggle path separators or traversal sequences into the
  // `.pi/` directory. Dots are excluded on purpose: a slug like `..etcpasswd`
  // would otherwise survive path.join and leak a traversal into the filename.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "unknown";
  return path.join(cwd, ".pi", `teammate-models.session.${safe}.json`);
}

export interface SessionModelRoutingStore {
  version: 3;
  sessionId: string;
  createdAtMs: number;
  rules: ModelRoutingRules;
}

function emptyRules(): ModelRoutingRules {
  return { mappings: {}, thinkingLevels: {} };
}

function cloneRoleMappings(roleMappings: ModelRoutingRules["roleMappings"]): ModelRoutingRules["roleMappings"] {
  if (!roleMappings) return undefined;
  return Object.fromEntries(Object.entries(roleMappings).map(([role, rules]) => [
    role,
    rules === null ? null : {
      ...(hasOwn(rules, "model") ? { model: rules.model } : {}),
      ...(hasOwn(rules, "fallbackModels")
        ? { fallbackModels: rules.fallbackModels === null ? null : [...(rules.fallbackModels ?? [])] }
        : {}),
      ...(hasOwn(rules, "thinking") ? { thinking: rules.thinking } : {}),
      ...(hasOwn(rules, "circuit") ? { circuit: rules.circuit === null ? null : { ...rules.circuit } } : {}),
      ...(hasOwn(rules, "taskType") ? { taskType: rules.taskType } : {}),
    },
  ]));
}

function cloneTypeMeta(typeMeta: ModelRoutingRules["typeMeta"]): ModelRoutingRules["typeMeta"] {
  if (!typeMeta) return undefined;
  return Object.fromEntries(Object.entries(typeMeta).map(([taskType, meta]) => [
    taskType,
    meta === null ? null : { keywords: meta.keywords === null ? null : [...(meta.keywords ?? [])] },
  ]));
}

function cloneRules(rules: ModelRoutingRules): ModelRoutingRules {
  const fallbackMappings = rules.fallbackMappings
    ? Object.fromEntries(Object.entries(rules.fallbackMappings).map(([taskType, models]) => [
      taskType,
      Array.isArray(models) ? [...models] : models,
    ]))
    : undefined;
  const roleMappings = cloneRoleMappings(rules.roleMappings);
  const typeMeta = cloneTypeMeta(rules.typeMeta);
  return {
    mappings: { ...rules.mappings },
    ...(fallbackMappings && Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels: { ...rules.thinkingLevels },
    ...(roleMappings && Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
    ...(typeMeta && Object.keys(typeMeta).length > 0 ? { typeMeta } : {}),
  };
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in teammate model config: ${filePath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid teammate model config object: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`Unknown ${label} field: ${unknown}`);
}

function assertRoleName(role: string): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(role)) {
    throw new Error(`Invalid teammate role mapping: ${role}`);
  }
}

function validateRoleMappings(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} roleMappings`);
  for (const [role, rawRules] of Object.entries(value as Record<string, unknown>)) {
    assertRoleName(role);
    if (rawRules === null) continue;
    if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) {
      throw new Error(`Invalid ${label} role mapping: ${role}`);
    }
    const rules = rawRules as Record<string, unknown>;
    assertKnownKeys(rules, ["model", "fallbackModels", "thinking", "circuit", "taskType"], `Role ${role}`);
    if (rules.model !== undefined && rules.model !== null && (typeof rules.model !== "string" || !rules.model.trim())) {
      throw new Error(`Invalid ${label} role model: ${role}`);
    }
    if (rules.fallbackModels !== undefined && rules.fallbackModels !== null
      && (!Array.isArray(rules.fallbackModels)
        || rules.fallbackModels.some((model) => typeof model !== "string" || !model.trim()))) {
      throw new Error(`Invalid ${label} role fallback mapping: ${role}`);
    }
    if (rules.thinking !== undefined && rules.thinking !== null && !parseTeammateThinkingLevel(rules.thinking)) {
      throw new Error(`Invalid ${label} role thinking level: ${role}`);
    }
    if (rules.taskType !== undefined && rules.taskType !== null && !parseTeammateTaskType(rules.taskType)) {
      throw new Error(`Invalid ${label} role task type: ${role}`);
    }
    if (rules.circuit !== undefined && rules.circuit !== null) {
      if (!rules.circuit || typeof rules.circuit !== "object" || Array.isArray(rules.circuit)) {
        throw new Error(`Invalid ${label} role circuit policy: ${role}`);
      }
      const circuit = rules.circuit as Record<string, unknown>;
      assertKnownKeys(circuit, ["threshold", "cooldownMs"], `Role ${role} circuit`);
      if (circuit.threshold !== undefined
        && (typeof circuit.threshold !== "number" || !Number.isInteger(circuit.threshold) || circuit.threshold < 1)) {
        throw new Error(`Invalid ${label} role circuit threshold: ${role}`);
      }
      if (circuit.cooldownMs !== undefined
        && (typeof circuit.cooldownMs !== "number" || !Number.isFinite(circuit.cooldownMs) || circuit.cooldownMs < 0)) {
        throw new Error(`Invalid ${label} role circuit cooldown: ${role}`);
      }
    }
  }
}

function validateV3Rules(value: Record<string, unknown>, label: string): void {
  assertKnownKeys(value, ["mappings", "fallbackMappings", "thinkingLevels", "roleMappings", "typeMeta"], label);
  if (!value.mappings || typeof value.mappings !== "object" || Array.isArray(value.mappings)
    || !value.thinkingLevels || typeof value.thinkingLevels !== "object" || Array.isArray(value.thinkingLevels)
    || (value.fallbackMappings !== undefined
      && (!value.fallbackMappings || typeof value.fallbackMappings !== "object" || Array.isArray(value.fallbackMappings)))) {
    throw new Error(`Invalid ${label}`);
  }
  for (const [taskType, model] of Object.entries(value.mappings as Record<string, unknown>)) {
    if (!parseTeammateTaskType(taskType)
      || (model !== null && (typeof model !== "string" || !model.trim()))) {
      throw new Error(`Invalid ${label} mapping: ${taskType}`);
    }
  }
  for (const [taskType, models] of Object.entries((value.fallbackMappings ?? {}) as Record<string, unknown>)) {
    if (!parseTeammateTaskType(taskType)
      || (models !== null && (!Array.isArray(models)
        || models.some((model) => typeof model !== "string" || !model.trim())))) {
      throw new Error(`Invalid ${label} fallback mapping: ${taskType}`);
    }
  }
  for (const [taskType, thinking] of Object.entries(value.thinkingLevels as Record<string, unknown>)) {
    if (!parseTeammateTaskType(taskType)
      || (thinking !== null && !parseTeammateThinkingLevel(thinking))) {
      throw new Error(`Invalid ${label} thinking level: ${taskType}`);
    }
  }
  validateRoleMappings(value.roleMappings, label);
  if (value.typeMeta !== undefined) {
    if (!value.typeMeta || typeof value.typeMeta !== "object" || Array.isArray(value.typeMeta)) {
      throw new Error(`Invalid ${label} typeMeta`);
    }
    for (const [taskType, rawMeta] of Object.entries(value.typeMeta as Record<string, unknown>)) {
      if (!parseTeammateTaskType(taskType)) throw new Error(`Invalid ${label} typeMeta type: ${taskType}`);
      if (rawMeta === null) continue;
      if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
        throw new Error(`Invalid ${label} typeMeta entry: ${taskType}`);
      }
      const meta = rawMeta as Record<string, unknown>;
      assertKnownKeys(meta, ["keywords"], `Type ${taskType} meta`);
      if (meta.keywords !== undefined && meta.keywords !== null
        && (!Array.isArray(meta.keywords)
          || meta.keywords.some((keyword) => typeof keyword !== "string" || !keyword.trim()))) {
        throw new Error(`Invalid ${label} typeMeta keywords: ${taskType}`);
      }
    }
  }
}

function normalizeRules(value: unknown): ModelRoutingRules {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mappings: Partial<Record<TeammateTaskType, string | null>> = {};
  const fallbackMappings: Partial<Record<TeammateTaskType, string[] | null>> = {};
  const thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>> = {};
  const roleMappings: Record<string, ModelRoutingRoleRules | null> = {};
  const rawMappings = parsed.mappings && typeof parsed.mappings === "object" && !Array.isArray(parsed.mappings)
    ? parsed.mappings as Record<string, unknown>
    : {};
  const rawFallbacks = parsed.fallbackMappings && typeof parsed.fallbackMappings === "object" && !Array.isArray(parsed.fallbackMappings)
    ? parsed.fallbackMappings as Record<string, unknown>
    : {};
  const rawThinking = parsed.thinkingLevels && typeof parsed.thinkingLevels === "object" && !Array.isArray(parsed.thinkingLevels)
    ? parsed.thinkingLevels as Record<string, unknown>
    : {};
  const rawRoleMappings = parsed.roleMappings && typeof parsed.roleMappings === "object" && !Array.isArray(parsed.roleMappings)
    ? parsed.roleMappings as Record<string, unknown>
    : {};
  const taskTypes = new Set([...Object.keys(rawMappings), ...Object.keys(rawFallbacks), ...Object.keys(rawThinking)]);
  for (const rawTaskType of taskTypes) {
    const taskType = parseTeammateTaskType(rawTaskType);
    if (!taskType) continue;
    const model = rawMappings[rawTaskType];
    if (typeof model === "string" && model.trim()) mappings[taskType] = model.trim();
    else if (model === null) mappings[taskType] = null;
    const fallback = rawFallbacks[rawTaskType];
    if (fallback === null) fallbackMappings[taskType] = null;
    else if (Array.isArray(fallback)) {
      fallbackMappings[taskType] = [...new Set(fallback
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean))];
    }
    const thinking = rawThinking[rawTaskType];
    if (thinking === null) thinkingLevels[taskType] = null;
    else {
      const normalizedThinking = parseTeammateThinkingLevel(thinking);
      if (normalizedThinking) thinkingLevels[taskType] = normalizedThinking;
    }
  }
  for (const [role, rawRoleRules] of Object.entries(rawRoleMappings)) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(role)) continue;
    if (rawRoleRules === null) {
      roleMappings[role] = null;
      continue;
    }
    if (!rawRoleRules || typeof rawRoleRules !== "object" || Array.isArray(rawRoleRules)) continue;
    const rules = rawRoleRules as Record<string, unknown>;
    const normalized: ModelRoutingRoleRules = {};
    if (typeof rules.model === "string" && rules.model.trim()) normalized.model = rules.model.trim();
    else if (rules.model === null) normalized.model = null;
    if (rules.fallbackModels === null) normalized.fallbackModels = null;
    else if (Array.isArray(rules.fallbackModels)) {
      normalized.fallbackModels = [...new Set(rules.fallbackModels
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean))];
    }
    if (rules.thinking === null) normalized.thinking = null;
    else {
      const normalizedThinking = parseTeammateThinkingLevel(rules.thinking);
      if (normalizedThinking) normalized.thinking = normalizedThinking;
    }
    if (rules.taskType === null) normalized.taskType = null;
    else {
      const normalizedTaskType = parseTeammateTaskType(rules.taskType);
      if (normalizedTaskType) normalized.taskType = normalizedTaskType;
    }
    if (rules.circuit === null) normalized.circuit = null;
    else if (rules.circuit && typeof rules.circuit === "object" && !Array.isArray(rules.circuit)) {
      const circuit = rules.circuit as Record<string, unknown>;
      const normalizedCircuit: ModelCircuitPolicy = {};
      if (typeof circuit.threshold === "number" && Number.isInteger(circuit.threshold) && circuit.threshold >= 1) {
        normalizedCircuit.threshold = circuit.threshold;
      }
      if (typeof circuit.cooldownMs === "number" && Number.isFinite(circuit.cooldownMs) && circuit.cooldownMs >= 0) {
        normalizedCircuit.cooldownMs = circuit.cooldownMs;
      }
      if (normalizedCircuit.threshold !== undefined || normalizedCircuit.cooldownMs !== undefined) {
        normalized.circuit = normalizedCircuit;
      }
    }
    roleMappings[role] = normalized;
  }
  const typeMeta: Record<string, ModelRoutingTypeMeta | null> = {};
  const rawTypeMeta = parsed.typeMeta && typeof parsed.typeMeta === "object" && !Array.isArray(parsed.typeMeta)
    ? parsed.typeMeta as Record<string, unknown>
    : {};
  for (const [taskType, rawMeta] of Object.entries(rawTypeMeta)) {
    const normalizedTaskType = parseTeammateTaskType(taskType);
    if (!normalizedTaskType) continue;
    if (rawMeta === null) {
      typeMeta[normalizedTaskType] = null;
      continue;
    }
    if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) continue;
    const meta = rawMeta as Record<string, unknown>;
    const normalizedMeta: ModelRoutingTypeMeta = {};
    if (meta.keywords !== null && Array.isArray(meta.keywords)) {
      const keywords = [...new Set(meta.keywords
        .filter((keyword): keyword is string => typeof keyword === "string")
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean))];
      if (keywords.length > 0) normalizedMeta.keywords = keywords;
    }
    if (normalizedMeta.keywords !== undefined) {
      typeMeta[normalizedTaskType] = normalizedMeta;
    }
  }
  return {
    mappings,
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels,
    ...(Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
    ...(Object.keys(typeMeta).length > 0 ? { typeMeta } : {}),
  };
}

function mergeRules(base: ModelRoutingRules, overrides: ModelRoutingRules): ModelRoutingRules {
  const fallbackMappings = { ...base.fallbackMappings, ...overrides.fallbackMappings };
  const roleMappings: Record<string, ModelRoutingRoleRules | null> = {
    ...(base.roleMappings ?? {}),
  };
  for (const [role, override] of Object.entries(overrides.roleMappings ?? {})) {
    if (override === null) {
      roleMappings[role] = null;
      continue;
    }
    const inherited = roleMappings[role];
    roleMappings[role] = {
      ...(inherited && inherited !== null ? inherited : {}),
      ...override,
      ...(override.fallbackModels !== undefined
        ? { fallbackModels: override.fallbackModels === null ? null : [...override.fallbackModels] }
        : {}),
    };
  }
  const typeMeta: Record<string, ModelRoutingTypeMeta | null> = {
    ...(base.typeMeta ?? {}),
    ...(overrides.typeMeta ?? {}),
  };
  return {
    mappings: { ...base.mappings, ...overrides.mappings },
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels: { ...base.thinkingLevels, ...overrides.thinkingLevels },
    ...(Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
    ...(Object.keys(typeMeta).length > 0 ? { typeMeta } : {}),
  };
}

function hasRules(rules: ModelRoutingRules): boolean {
  return Object.keys(rules.mappings).length > 0
    || Object.keys(rules.fallbackMappings ?? {}).length > 0
    || Object.keys(rules.thinkingLevels).length > 0
    || Object.keys(rules.roleMappings ?? {}).length > 0
    || Object.keys(rules.typeMeta ?? {}).length > 0;
}

function normalizeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return normalized ? normalized.slice(0, 64) : fallback;
}

function isProfileId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,47}$/.test(value);
}

function profileIdFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "profile";
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nextProfileId(store: GlobalModelRoutingStore, name: string): string {
  const base = profileIdFromName(name);
  const unavailable = (candidate: string): boolean =>
    hasOwn(store.profiles, candidate) || (store.retiredProfileIds?.includes(candidate) ?? false);
  if (!unavailable(base)) return base;
  for (let index = 2; index < 10_000; index++) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!unavailable(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a teammate model profile ID");
}

function invalidGlobalStore(): never {
  throw new Error("Invalid v3 global teammate model config");
}

function normalizeGlobalStore(parsed: Record<string, unknown> | undefined): GlobalModelRoutingStore {
  if (parsed?.version === 3) {
    assertKnownKeys(parsed, ["version", "defaultProfile", "profiles", "retiredProfileIds", "askBeforeDispatch"], "v3 global config");
    if (!parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
      return invalidGlobalStore();
    }
    const profiles: Record<string, ModelRoutingProfile> = {};
    for (const [profileId, rawProfile] of Object.entries(parsed.profiles as Record<string, unknown>)) {
      if (!isProfileId(profileId) || !rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        return invalidGlobalStore();
      }
      const profile = rawProfile as Record<string, unknown>;
      assertKnownKeys(profile, ["name", "mappings", "fallbackMappings", "thinkingLevels", "roleMappings", "typeMeta"], `Profile ${profileId}`);
      if (typeof profile.name !== "string" || !normalizeProfileName(profile.name, "")) return invalidGlobalStore();
      validateV3Rules({
        mappings: profile.mappings,
        ...(hasOwn(profile, "fallbackMappings") ? { fallbackMappings: profile.fallbackMappings } : {}),
        thinkingLevels: profile.thinkingLevels,
        ...(hasOwn(profile, "roleMappings") ? { roleMappings: profile.roleMappings } : {}),
        ...(hasOwn(profile, "typeMeta") ? { typeMeta: profile.typeMeta } : {}),
      }, `Profile ${profileId}`);
      profiles[profileId] = {
        name: normalizeProfileName(profile.name, profileId),
        ...normalizeRules(profile),
      };
    }
    if (Object.keys(profiles).length === 0) return invalidGlobalStore();
    const requestedDefault = typeof parsed.defaultProfile === "string" ? parsed.defaultProfile.trim() : "";
    if (!hasOwn(profiles, requestedDefault)) return invalidGlobalStore();
    const retiredProfileIds = parsed.retiredProfileIds === undefined
      ? []
      : Array.isArray(parsed.retiredProfileIds)
        && new Set(parsed.retiredProfileIds).size === parsed.retiredProfileIds.length
        && parsed.retiredProfileIds.every((entry) =>
          typeof entry === "string" && isProfileId(entry) && !hasOwn(profiles, entry)
        )
        ? [...new Set(parsed.retiredProfileIds as string[])]
        : invalidGlobalStore();
    if (parsed.askBeforeDispatch !== undefined && typeof parsed.askBeforeDispatch !== "boolean") {
      return invalidGlobalStore();
    }
    return {
      version: 3,
      defaultProfile: requestedDefault,
      profiles,
      ...(retiredProfileIds.length > 0 ? { retiredProfileIds } : {}),
      ...(parsed.askBeforeDispatch === true ? { askBeforeDispatch: true } : {}),
    };
  }
  if (parsed?.version !== undefined && parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unsupported teammate model config version: ${String(parsed.version)}`);
  }
  const legacyRules = normalizeRules(parsed);
  return {
    version: 3,
    defaultProfile: DEFAULT_PROFILE_ID,
    profiles: {
      [DEFAULT_PROFILE_ID]: { name: DEFAULT_PROFILE_NAME, ...legacyRules },
    },
  };
}

function readGlobalStore(filePath = getGlobalModelRoutingPath()): GlobalModelRoutingStore {
  return normalizeGlobalStore(readJsonObject(filePath));
}

function normalizeProjectStore(parsed: Record<string, unknown> | undefined): ProjectModelRoutingStore {
  if (parsed?.version === 3) {
    assertKnownKeys(parsed, ["version", "activeProfile", "applyOverrides", "overrides"], "v3 project config");
    if (typeof parsed.applyOverrides !== "boolean"
      || !parsed.overrides
      || typeof parsed.overrides !== "object"
      || Array.isArray(parsed.overrides)) {
      throw new Error("Invalid v3 project teammate model config");
    }
    if (parsed.activeProfile !== undefined
      && (typeof parsed.activeProfile !== "string" || !isProfileId(parsed.activeProfile.trim()))) {
      throw new Error("Invalid active Profile in project teammate model config");
    }
    const activeProfile = typeof parsed.activeProfile === "string" && parsed.activeProfile.trim()
      ? parsed.activeProfile.trim()
      : undefined;
    const overridesRecord = parsed.overrides as Record<string, unknown>;
    validateV3Rules(overridesRecord, "project overrides");
    const overrides = normalizeRules(overridesRecord);
    return {
      version: 3,
      ...(activeProfile ? { activeProfile } : {}),
      applyOverrides: parsed.applyOverrides,
      overrides,
    };
  }
  if (parsed?.version !== undefined && parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unsupported project teammate model config version: ${String(parsed.version)}`);
  }
  const overrides = normalizeRules(parsed);
  return {
    version: 3,
    applyOverrides: hasRules(overrides),
    overrides,
  };
}

function readProjectStore(filePath: string): ProjectModelRoutingStore {
  return normalizeProjectStore(readJsonObject(filePath));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

interface ConfigLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAtMs: number;
  startedAtMs: number;
  startIdentity?: string;
  startObserved?: boolean;
}

function lockOwner(lockPath: string): ConfigLockOwner | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")) as Partial<ConfigLockOwner>;
    if (
      parsed.version !== 1
      || typeof parsed.pid !== "number"
      || !Number.isInteger(parsed.pid)
      || typeof parsed.token !== "string"
      || !/^[a-f0-9-]{36}$/.test(parsed.token)
      || typeof parsed.createdAtMs !== "number"
      || !Number.isFinite(parsed.createdAtMs)
      || typeof parsed.startedAtMs !== "number"
      || !Number.isFinite(parsed.startedAtMs)
      || (parsed.startIdentity !== undefined && typeof parsed.startIdentity !== "string")
      || (parsed.startObserved !== undefined && typeof parsed.startObserved !== "boolean")
    ) return undefined;
    return parsed as ConfigLockOwner;
  } catch {
    return undefined;
  }
}

interface ProcessStartObservation {
  identity?: string;
  startedAtMs?: number;
}

const nextIdentityCheck = new Map<string, number>();
let ownStartObservation: ProcessStartObservation | undefined;
let ownStartObservationLoaded = false;

function processStartObservation(pid: number): ProcessStartObservation | undefined {
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      const startTime = fields[19];
      return startTime ? { identity: `linux:${startTime}` } : undefined;
    }
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `([DateTimeOffset](Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`,
      ], {
        encoding: "utf8",
        timeout: 2_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const startedAtMs = Number(output);
      return Number.isFinite(startedAtMs) ? { startedAtMs } : undefined;
    }
    const output = execFileSync("ps", ["-o", "state=", "-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    }).trim();
    const [state, ...startedAtParts] = output.split(/\s+/);
    if (state?.startsWith("Z")) return { identity: "dead:zombie" };
    const startedAtMs = Date.parse(startedAtParts.join(" "));
    return Number.isFinite(startedAtMs) ? { startedAtMs } : undefined;
  } catch {
    return undefined;
  }
}

function currentProcessStartObservation(): ProcessStartObservation | undefined {
  if (!ownStartObservationLoaded) {
    ownStartObservation = processStartObservation(process.pid);
    ownStartObservationLoaded = true;
  }
  return ownStartObservation;
}

function lockOwnerIsLive(lockPath: string, owner: ConfigLockOwner): boolean {
  // A process start that was explicitly observed cannot be the Unix epoch for
  // a live Pi process. Treat contradictory owner metadata as stale instead of
  // letting a recycled PID hold the lock when process inspection is unavailable.
  if (owner.startObserved && owner.startedAtMs <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
  if (Date.now() - owner.createdAtMs < LOCK_IDENTITY_CHECK_MS) return true;
  const checkKey = `${lockPath}:${owner.token}`;
  const now = Date.now();
  if ((nextIdentityCheck.get(checkKey) ?? 0) > now) return true;
  nextIdentityCheck.set(checkKey, now + 1_000);
  const observed = processStartObservation(owner.pid);
  if (!observed) return true;
  if (observed.identity === "dead:zombie") return false;
  if (owner.startIdentity && observed.identity) return owner.startIdentity === observed.identity;
  if (owner.startObserved && observed.startedAtMs !== undefined) {
    return Math.abs(observed.startedAtMs - owner.startedAtMs) <= 2_000;
  }
  return true;
}

function reclaimDeadLock(lockPath: string): boolean {
  const owner = lockOwner(lockPath);
  if (!owner || lockOwnerIsLive(lockPath, owner)) return false;
  const quarantinePath = `${lockPath}.stale.${owner.token}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
    nextIdentityCheck.delete(`${lockPath}:${owner.token}`);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM" || code === "EACCES") return false;
    throw error;
  }
}

function renameLockDirectory(sourcePath: string, destinationPath: string): void {
  const startedAt = Date.now();
  while (true) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "EPERM" && code !== "EACCES") || Date.now() - startedAt >= LOCK_RENAME_WAIT_MS) throw error;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function withConfigLock<T>(filePath: string, action: () => T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  const candidatePath = `${lockPath}.candidate.${process.pid}.${token}`;
  const observedStart = currentProcessStartObservation();
  const startedAtMs = observedStart?.startedAtMs ?? Date.now() - process.uptime() * 1_000;
  const owner: ConfigLockOwner = {
    version: 1,
    pid: process.pid,
    token,
    createdAtMs: Date.now(),
    startedAtMs,
    ...(observedStart?.identity ? { startIdentity: observedStart.identity } : {}),
    ...(observedStart?.startedAtMs !== undefined ? { startObserved: true } : {}),
  };
  const startedAt = Date.now();
  let acquired = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    fs.mkdirSync(candidatePath, { mode: 0o700 });
    fs.writeFileSync(path.join(candidatePath, "owner.json"), JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    while (!acquired) {
      try {
        fs.renameSync(candidatePath, lockPath);
        acquired = true;
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") throw error;
        if (reclaimDeadLock(lockPath)) continue;
        if (Date.now() - startedAt >= LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for teammate model config lock: ${lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    return action();
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    if (!acquired) {
      try {
        fs.rmSync(candidatePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch (cleanupError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, cleanupError],
            `Teammate model lock initialization and candidate cleanup both failed: ${candidatePath}`,
          );
        }
        throw cleanupError;
      }
    } else {
      const current = lockOwner(lockPath);
      if (current?.token !== token) throw new Error(`Teammate model config lock ownership changed: ${lockPath}`);
      const releasedPath = `${lockPath}.released.${token}`;
      renameLockDirectory(lockPath, releasedPath);
      nextIdentityCheck.delete(`${lockPath}:${token}`);
      try {
        fs.rmSync(releasedPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // The canonical lock is already released. Cleanup failure must not invalidate a committed action.
      }
    }
  }
}

function withGlobalConfigLock<T>(globalFilePath: string, action: () => T): T {
  return withConfigLock(globalFilePath, () => {
    recoverPendingTransactionLocked(globalFilePath);
    return action();
  });
}

function withGlobalAndProjectLocks<T>(
  cwd: string,
  globalFilePath: string,
  action: (projectFilePath: string) => T,
): T {
  const projectFilePath = path.resolve(getProjectModelRoutingPath(cwd));
  return withGlobalConfigLock(globalFilePath, () =>
    withConfigLock(projectFilePath, () => action(projectFilePath))
  );
}

function fsyncDirectory(directoryPath: string): void {
  if (process.platform === "win32") return;
  const handle = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function fsyncFile(filePath: string): void {
  const handle = fs.openSync(filePath, "r+");
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

class PublishedWriteError extends Error {
  readonly published = true;

  constructor(filePath: string, cause: unknown) {
    super(`Teammate model config was published but durability sync failed: ${filePath}`, { cause });
  }
}

function isPublishedWriteError(error: unknown): error is PublishedWriteError {
  return error instanceof PublishedWriteError;
}

function writeJson(filePath: string, value: unknown): void {
  const directoryPath = path.dirname(filePath);
  fs.mkdirSync(directoryPath, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  let published = false;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporaryPath, filePath);
    published = true;
    fsyncFile(filePath);
    fsyncDirectory(directoryPath);
  } catch (error) {
    if (published) throw new PublishedWriteError(filePath, error);
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

/**
 * Write a single store and, if the rename already published the new bytes before a
 * durability-sync failure, immediately restore the previous value so a failed single-file
 * commit cannot leave a published-but-unreported change on disk.
 */
function writeJsonRestoringOnPublish(filePath: string, next: unknown, previous: unknown): void {
  try {
    writeJson(filePath, next);
  } catch (error) {
    if (!isPublishedWriteError(error)) throw error;
    try {
      writeJson(filePath, previous);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Teammate routing was published for ${filePath} but its restore failed`,
      );
    }
    throw error;
  }
}

function transactionPath(globalFilePath: string): string {
  return `${globalFilePath}.transaction.json`;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} in teammate model transaction`);
  return value as Record<string, unknown>;
}

function readTransaction(globalFilePath: string): ModelRoutingTransaction | undefined {
  const journalPath = transactionPath(globalFilePath);
  if (!fs.existsSync(journalPath)) return undefined;
  const parsed = readJsonObject(journalPath);
  if (!parsed) throw new Error("Invalid teammate model transaction journal");
  if (parsed.version !== 1 || (parsed.mode !== "forward" && parsed.mode !== "rollback")) {
    throw new Error("Invalid teammate model transaction journal");
  }
  if (typeof parsed.projectFilePath !== "string") throw new Error("Invalid project path in teammate model transaction");
  const projectFilePath = path.resolve(parsed.projectFilePath);
  if (path.basename(projectFilePath) !== CONFIG_FILE || path.basename(path.dirname(projectFilePath)) !== ".pi") {
    throw new Error("Unsafe project path in teammate model transaction");
  }
  const globalBeforeValue = requiredRecord(parsed.globalBefore, "globalBefore");
  const globalAfterValue = requiredRecord(parsed.globalAfter, "globalAfter");
  const projectAfterValue = requiredRecord(parsed.projectAfter, "projectAfter");
  if (globalBeforeValue.version !== 3 || globalAfterValue.version !== 3 || projectAfterValue.version !== 3) {
    throw new Error("Invalid store version in teammate model transaction");
  }
  return {
    version: 1,
    mode: parsed.mode,
    projectFilePath,
    globalBefore: normalizeGlobalStore(globalBeforeValue),
    globalAfter: normalizeGlobalStore(globalAfterValue),
    projectAfter: normalizeProjectStore(projectAfterValue),
  };
}

function removeTransaction(globalFilePath: string): void {
  const journalPath = transactionPath(globalFilePath);
  try {
    fs.rmSync(journalPath);
    fsyncDirectory(path.dirname(journalPath));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function recoverPendingTransactionLocked(globalFilePath: string): void {
  const transaction = readTransaction(globalFilePath);
  if (!transaction) return;
  if (transaction.mode === "rollback") {
    writeJson(globalFilePath, transaction.globalBefore);
    removeTransaction(globalFilePath);
    return;
  }
  withConfigLock(transaction.projectFilePath, () => {
    writeJson(globalFilePath, transaction.globalAfter);
    writeJson(transaction.projectFilePath, transaction.projectAfter);
    removeTransaction(globalFilePath);
  });
}

function writeGlobalAndProject(
  globalFilePath: string,
  originalGlobal: GlobalModelRoutingStore,
  global: GlobalModelRoutingStore,
  projectFilePath: string,
  project: ProjectModelRoutingStore,
): void {
  const journal: ModelRoutingTransaction = {
    version: 1,
    mode: "forward",
    projectFilePath: path.resolve(projectFilePath),
    globalBefore: originalGlobal,
    globalAfter: global,
    projectAfter: project,
  };
  writeJson(transactionPath(globalFilePath), journal);
  try {
    writeJson(globalFilePath, global);
  } catch (error) {
    if (isPublishedWriteError(error)) {
      try {
        writeJson(globalFilePath, global);
      } catch (retryError) {
        throw new AggregateError(
          [error, retryError],
          "Global Profile was published but its durability retry failed; forward recovery remains journaled",
        );
      }
    } else {
      try {
        if (JSON.stringify(readGlobalStore(globalFilePath)) === JSON.stringify(originalGlobal)) {
          removeTransaction(globalFilePath);
        }
      } catch {}
      throw error;
    }
  }
  try {
    writeJson(projectFilePath, project);
  } catch (projectError) {
    if (isPublishedWriteError(projectError)) {
      try {
        writeJson(projectFilePath, project);
      } catch (retryError) {
        throw new AggregateError(
          [projectError, retryError],
          "Project selection was published but its durability retry failed; forward recovery remains journaled",
        );
      }
    } else {
      let journalError: unknown;
      try {
        writeJson(transactionPath(globalFilePath), { ...journal, mode: "rollback" });
      } catch (error) {
        journalError = error;
      }
      try {
        writeJson(globalFilePath, originalGlobal);
        removeTransaction(globalFilePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [projectError, ...(journalError ? [journalError] : []), rollbackError],
          "Project routing write failed and the global Profile rollback could not be completed",
        );
      }
      if (journalError) {
        throw new AggregateError(
          [projectError, journalError],
          "Project routing write failed; global rollback succeeded but rollback intent could not be journaled",
        );
      }
      throw projectError;
    }
  }
  try {
    removeTransaction(globalFilePath);
  } catch {
    // A forward journal is idempotent and will be cleared on the next locked read.
  }
}

function readSessionStore(filePath: string): SessionModelRoutingStore | undefined {
  const parsed = readJsonObject(filePath);
  if (!parsed || parsed.version !== 3 || typeof parsed.sessionId !== "string") return undefined;
  return {
    version: 3,
    sessionId: parsed.sessionId as string,
    createdAtMs: typeof parsed.createdAtMs === "number" && Number.isFinite(parsed.createdAtMs)
      ? parsed.createdAtMs
      : Date.now(),
    rules: normalizeRules(parsed.rules),
  };
}

/**
 * Persist a session-scoped routing override. Session overrides stack on top
 * of project overrides (and the active profile) and apply only to the single
 * Pi session identified by `sessionId`. The file is written atomically under
 * the same lock protocol as the project config. A corrupted session file is
 * ignored at read time, so a bad write never blocks dispatch.
 */
export function saveSessionModelRoutingOverrides(
  cwd: string,
  sessionId: string,
  rules: ModelRoutingRules,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  const sessionFilePath = getSessionModelRoutingPath(cwd, sessionId);
  return withConfigLock(sessionFilePath, () => {
    const store: SessionModelRoutingStore = {
      version: 3,
      sessionId,
      createdAtMs: Date.now(),
      rules: normalizeRules(rules),
    };
    writeJson(sessionFilePath, store);
    return loadModelRoutingConfig(cwd, globalFilePath, sessionId);
  });
}

function resolvedState(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
  sessionId?: string,
): ModelRoutingState {
  const global = readGlobalStore(globalFilePath);
  const project = readProjectStore(getProjectModelRoutingPath(cwd));
  const requestedProfile = project.activeProfile ?? global.defaultProfile;
  const missingProfile = hasOwn(global.profiles, requestedProfile) ? undefined : requestedProfile;
  const profileId = missingProfile ? global.defaultProfile : requestedProfile;
  const profile = global.profiles[profileId];
  let rules = project.applyOverrides ? mergeRules(profile, project.overrides) : cloneRules(profile);
  // Session overrides are the highest-priority layer of the task-type mapping
  // stack. A missing or corrupted session file is silently ignored so a
  // transient per-session config never blocks dispatch.
  if (sessionId) {
    try {
      const sessionStore = readSessionStore(getSessionModelRoutingPath(cwd, sessionId));
      if (sessionStore && hasRules(sessionStore.rules)) rules = mergeRules(rules, sessionStore.rules);
    } catch {
      // Ignore unreadable session overrides; the base config stays authoritative.
    }
  }
  return {
    global,
    project,
    config: {
      version: 3,
      profileId,
      profileName: profile.name,
      projectOverridesEnabled: project.applyOverrides,
      ...rules,
    },
    askBeforeDispatch: global.askBeforeDispatch === true,
    requestedProfile,
    ...(missingProfile ? { missingProfile } : {}),
  };
}

/**
 * Persist the ask-before-dispatch flag on the global teammate model config.
 * The flag is user-level (not per profile/project): it controls whether the
 * root teammate tool asks the user to confirm or pick model provider/thinking
 * before every dispatch.
 */
export function setGlobalAskBeforeDispatch(
  enabled: boolean,
  globalFilePath = getGlobalModelRoutingPath(),
): boolean {
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    const next: GlobalModelRoutingStore = enabled
      ? { ...store, askBeforeDispatch: true }
      : (() => {
        const { askBeforeDispatch: _dropped, ...rest } = store;
        return rest;
      })();
    writeJson(globalFilePath, next);
    return enabled;
  });
}

/** Effective ask-before-dispatch flag without a cwd (global store only). */
export function getGlobalAskBeforeDispatch(
  globalFilePath = getGlobalModelRoutingPath(),
): boolean {
  try {
    return readGlobalStore(globalFilePath).askBeforeDispatch === true;
  } catch {
    return false;
  }
}

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function readConsistentState(cwd: string, globalFilePath: string, sessionId?: string): ModelRoutingState {
  const projectFilePath = getProjectModelRoutingPath(cwd);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (fs.existsSync(transactionPath(globalFilePath))) {
      return withGlobalConfigLock(globalFilePath, () => resolvedState(cwd, globalFilePath, sessionId));
    }
    const globalBefore = fileSignature(globalFilePath);
    const projectBefore = fileSignature(projectFilePath);
    const state = resolvedState(cwd, globalFilePath, sessionId);
    const globalAfter = fileSignature(globalFilePath);
    const projectAfter = fileSignature(projectFilePath);
    if (
      !fs.existsSync(transactionPath(globalFilePath))
      && globalBefore === globalAfter
      && projectBefore === projectAfter
    ) return state;
  }
  return withGlobalConfigLock(globalFilePath, () => resolvedState(cwd, globalFilePath, sessionId));
}

export function loadModelRoutingState(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
  sessionId?: string,
): ModelRoutingState {
  return readConsistentState(cwd, globalFilePath, sessionId);
}

export function loadModelRoutingConfig(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
  sessionId?: string,
): ModelRoutingConfig {
  return readConsistentState(cwd, globalFilePath, sessionId).config;
}

export interface ModelRoutingStorePair {
  global: GlobalModelRoutingStore;
  project: ProjectModelRoutingStore;
}

export interface ModelRoutingStoreContentPair {
  global: string;
  project: string;
}

/** @internal Shared persistence bridge for the unified Settings provider. */
export function loadModelRoutingStores(
  globalFilePath: string,
  projectFilePath: string,
): ModelRoutingStorePair {
  const resolvedProjectPath = path.resolve(projectFilePath);
  return withGlobalConfigLock(globalFilePath, () => withConfigLock(resolvedProjectPath, () => ({
    global: readGlobalStore(globalFilePath),
    project: readProjectStore(resolvedProjectPath),
  })));
}

/** @internal Publish a prepared Settings transaction through the routing lock/journal protocol. */
export function replaceModelRoutingStores(
  globalFilePath: string,
  projectFilePath: string,
  expected: ModelRoutingStorePair,
  next: ModelRoutingStorePair,
  expectedContent?: ModelRoutingStoreContentPair,
): ModelRoutingStorePair {
  const resolvedProjectPath = path.resolve(projectFilePath);
  return withGlobalConfigLock(globalFilePath, () => withConfigLock(resolvedProjectPath, () => {
    if (expectedContent
      && (readConfigContent(globalFilePath) !== expectedContent.global
        || readConfigContent(resolvedProjectPath) !== expectedContent.project)) {
      throw new Error("Teammate model routing bytes changed after Settings preparation");
    }
    const current = {
      global: readGlobalStore(globalFilePath),
      project: readProjectStore(resolvedProjectPath),
    };
    if (JSON.stringify(current.global) !== JSON.stringify(expected.global)
      || JSON.stringify(current.project) !== JSON.stringify(expected.project)) {
      throw new Error("Teammate model routing changed after Settings preparation");
    }
    const normalized = {
      global: normalizeGlobalStore(next.global as unknown as Record<string, unknown>),
      project: normalizeProjectStore(next.project as unknown as Record<string, unknown>),
    };
    const globalChanged = JSON.stringify(current.global) !== JSON.stringify(normalized.global);
    const projectChanged = JSON.stringify(current.project) !== JSON.stringify(normalized.project);
    if (globalChanged && projectChanged) {
      writeGlobalAndProject(
        globalFilePath,
        current.global,
        normalized.global,
        resolvedProjectPath,
        normalized.project,
      );
    } else if (globalChanged) {
      writeJsonRestoringOnPublish(globalFilePath, normalized.global, current.global);
    } else if (projectChanged) {
      writeJsonRestoringOnPublish(resolvedProjectPath, normalized.project, current.project);
    }
    return normalized;
  }));
}

function readConfigContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}

export function discoverRoutingTaskTypes(
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
  loadedConfig?: ModelRoutingConfig,
): TeammateTaskType[] {
  const config = loadedConfig ?? loadModelRoutingConfig(cwd);
  const taskTypes = new Set<TeammateTaskType>(TEAMMATE_TASK_TYPES);
  for (const agent of agents) {
    const taskType = parseTeammateTaskType(agent.taskType);
    if (taskType) taskTypes.add(taskType);
  }
  for (const taskType of [
    ...Object.keys(config.mappings),
    ...Object.keys(config.fallbackMappings ?? {}),
    ...Object.keys(config.thinkingLevels),
    ...Object.keys(config.typeMeta ?? {}),
    ...Object.values(config.roleMappings ?? {}).flatMap((rules) => rules?.taskType ? [rules.taskType] : []),
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

function projectStoreForWrite(cwd: string, globalFilePath: string): ProjectModelRoutingStore {
  const state = resolvedState(cwd, globalFilePath);
  return {
    ...state.project,
    activeProfile: state.project.activeProfile ?? state.config.profileId,
    overrides: cloneRules(state.project.overrides),
  };
}

function saveProjectOverride(
  cwd: string,
  update: (rules: ModelRoutingRules) => void,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const store = projectStoreForWrite(cwd, globalFilePath);
    update(store.overrides);
    store.applyOverrides = true;
    writeJson(projectFilePath, store);
    return resolvedState(cwd, globalFilePath).config;
  });
}

export function saveProjectThinkingLevel(
  cwd: string,
  taskType: TeammateTaskType,
  thinking: TeammateThinkingLevel | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveProjectOverride(cwd, (rules) => {
    rules.thinkingLevels[normalizedTaskType] = thinking;
  }, globalFilePath);
}

export function saveProjectModelMapping(
  cwd: string,
  taskType: TeammateTaskType,
  model: string | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveProjectOverride(cwd, (rules) => {
    rules.mappings[normalizedTaskType] = model;
  }, globalFilePath);
}

export function saveProjectFallbackMapping(
  cwd: string,
  taskType: TeammateTaskType,
  models: string[] | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveProjectOverride(cwd, (rules) => {
    rules.fallbackMappings ??= {};
    rules.fallbackMappings[normalizedTaskType] = models === null
      ? null
      : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  }, globalFilePath);
}

function normalizeRoleRulesInput(rules: ModelRoutingRoleRules | null): ModelRoutingRoleRules | null {
  if (rules === null) return null;
  const normalized: ModelRoutingRoleRules = {};
  if (rules.model !== undefined) {
    if (rules.model === null) normalized.model = null;
    else if (rules.model.trim()) normalized.model = rules.model.trim();
    else throw new Error("Role model must not be empty");
  }
  if (rules.fallbackModels !== undefined) {
    normalized.fallbackModels = rules.fallbackModels === null
      ? null
      : [...new Set(rules.fallbackModels.map((model) => model.trim()).filter(Boolean))];
  }
  if (rules.thinking !== undefined) normalized.thinking = rules.thinking;
  if (rules.taskType !== undefined) {
    if (rules.taskType === null) normalized.taskType = null;
    else {
      const taskType = parseTeammateTaskType(rules.taskType);
      if (!taskType) throw new Error(`Invalid role task type: ${rules.taskType}`);
      normalized.taskType = taskType;
    }
  }
  if (rules.circuit !== undefined) {
    if (rules.circuit === null) {
      normalized.circuit = null;
    } else {
      const circuit: ModelCircuitPolicy = {};
      if (rules.circuit.threshold !== undefined) {
        if (!Number.isInteger(rules.circuit.threshold) || rules.circuit.threshold < 1) {
          throw new Error("Role circuit threshold must be a positive integer");
        }
        circuit.threshold = rules.circuit.threshold;
      }
      if (rules.circuit.cooldownMs !== undefined) {
        if (!Number.isFinite(rules.circuit.cooldownMs) || rules.circuit.cooldownMs < 0) {
          throw new Error("Role circuit cooldownMs must be a non-negative number");
        }
        circuit.cooldownMs = rules.circuit.cooldownMs;
      }
      normalized.circuit = circuit;
    }
  }
  return normalized;
}

export function saveProjectRoleMapping(
  cwd: string,
  role: string,
  rules: ModelRoutingRoleRules | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  assertRoleName(role);
  const normalized = normalizeRoleRulesInput(rules);
  return saveProjectOverride(cwd, (routing) => {
    routing.roleMappings ??= {};
    routing.roleMappings[role] = normalized;
  }, globalFilePath);
}

function requireProfile(store: GlobalModelRoutingStore, profileId: string): ModelRoutingProfile {
  if (!hasOwn(store.profiles, profileId)) throw new Error(`Unknown teammate model profile: ${profileId}`);
  return store.profiles[profileId];
}

/** A saved teammate model routing template (called a Profile in the Control Center). */
export interface ModelRoutingProfileSummary {
  id: string;
  name: string;
  active: boolean;
  default: boolean;
}

function sortedProfileSummaries(
  store: GlobalModelRoutingStore,
  activeProfileId?: string,
): ModelRoutingProfileSummary[] {
  return Object.entries(store.profiles)
    .map(([id, profile]) => ({
      id,
      name: profile.name,
      active: id === activeProfileId,
      default: id === store.defaultProfile,
    }))
    .sort((left, right) =>
      Number(right.active) - Number(left.active)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    );
}

function resolveProfileId(store: GlobalModelRoutingStore, reference: string): string {
  const query = reference.trim();
  if (!query) throw new Error("Teammate model profile or template name is required");
  if (hasOwn(store.profiles, query)) return query;

  const entries = Object.entries(store.profiles);
  const lowerQuery = query.toLowerCase();
  const caseInsensitiveIds = entries.filter(([id]) => id.toLowerCase() === lowerQuery);
  if (caseInsensitiveIds.length === 1) return caseInsensitiveIds[0]![0];

  const exactNames = entries.filter(([, profile]) => profile.name === query);
  if (exactNames.length === 1) return exactNames[0]![0];
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous teammate model template "${query}"; use one of these IDs: ${exactNames.map(([id]) => id).join(", ")}`);
  }

  const names = entries.filter(([, profile]) => profile.name.toLowerCase() === lowerQuery);
  if (names.length === 1) return names[0]![0];
  if (names.length > 1) {
    throw new Error(`Ambiguous teammate model template "${query}"; use one of these IDs: ${names.map(([id]) => id).join(", ")}`);
  }
  throw new Error(`Unknown teammate model profile or template: ${query}`);
}

/** List saved routing templates with the current project's active selection. */
export function listModelRoutingProfiles(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingProfileSummary[] {
  const state = loadModelRoutingState(cwd, globalFilePath);
  return sortedProfileSummaries(state.global, state.config.profileId);
}

/** Resolve a stable Profile id or display name without changing the selection. */
export function resolveModelRoutingProfile(
  cwd: string,
  reference: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingProfileSummary {
  const state = loadModelRoutingState(cwd, globalFilePath);
  const profileId = resolveProfileId(state.global, reference);
  return sortedProfileSummaries(state.global, state.config.profileId)
    .find((profile) => profile.id === profileId)!;
}

function saveGlobalProfile(
  cwd: string,
  profileId: string,
  update: (profile: ModelRoutingProfile) => void,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    update(requireProfile(store, profileId));
    writeJson(globalFilePath, store);
    return resolvedState(cwd, globalFilePath);
  });
}

export function saveGlobalProfileModelMapping(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  model: string | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.mappings[normalizedTaskType] = model;
  }, globalFilePath);
}

export function saveGlobalProfileThinkingLevel(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  thinking: TeammateThinkingLevel | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.thinkingLevels[normalizedTaskType] = thinking;
  }, globalFilePath);
}

export function saveGlobalProfileFallbackMapping(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  models: string[] | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.fallbackMappings ??= {};
    profile.fallbackMappings[normalizedTaskType] = models === null
      ? null
      : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  }, globalFilePath);
}

export function saveGlobalProfileRoleMapping(
  cwd: string,
  profileId: string,
  role: string,
  rules: ModelRoutingRoleRules | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  assertRoleName(role);
  const normalized = normalizeRoleRulesInput(rules);
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.roleMappings ??= {};
    profile.roleMappings[role] = normalized;
  }, globalFilePath);
}

/** Atomically assign a task type to the requested roles and clear stale assignments to that type. */
export function saveGlobalProfileTypeRoles(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  roles: readonly string[],
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  const requestedRoles = new Set(roles.map((role) => {
    assertRoleName(role);
    return role;
  }));
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.roleMappings ??= {};
    for (const [role, existing] of Object.entries(profile.roleMappings)) {
      if (existing?.taskType !== normalizedTaskType || requestedRoles.has(role)) continue;
      profile.roleMappings[role] = { ...existing, taskType: null };
    }
    for (const role of requestedRoles) {
      const existing = profile.roleMappings[role];
      profile.roleMappings[role] = { ...(existing ?? {}), taskType: normalizedTaskType };
    }
  }, globalFilePath);
}

function normalizeTypeMetaInput(meta: ModelRoutingTypeMeta | null): ModelRoutingTypeMeta {
  const normalized: ModelRoutingTypeMeta = {};
  if (meta === null) return normalized;
  if (meta.keywords !== undefined) {
    if (meta.keywords === null) return normalized;
    if (!Array.isArray(meta.keywords)) throw new Error("Type keywords must be an array");
    const keywords = [...new Set(meta.keywords
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean))];
    if (keywords.length > 0) normalized.keywords = keywords;
  }
  return normalized;
}

/** Set, merge, or clear (null) the user-editable keywords for a task type. */
export function saveGlobalProfileTypeMeta(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  meta: ModelRoutingTypeMeta | null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.typeMeta ??= {};
    const patch = normalizeTypeMetaInput(meta);
    if (meta === null || patch.keywords === undefined) {
      delete profile.typeMeta[normalizedTaskType];
      return;
    }
    profile.typeMeta[normalizedTaskType] = patch;
  }, globalFilePath);
}

/**
 * Register a custom agent type in the active Profile. The type is marked by
 * an explicit `mappings[type] = null` entry ("auto model"), which keeps it
 * discoverable for routing configuration without forcing a model.
 */
export function saveGlobalProfileCustomType(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  meta: ModelRoutingTypeMeta | null = null,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  if ((TEAMMATE_TASK_TYPES as readonly string[]).includes(normalizedTaskType)) {
    throw new Error(`Cannot register a built-in teammate task type: ${normalizedTaskType}`);
  }
  const normalizedMeta = normalizeTypeMetaInput(meta);
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.mappings[normalizedTaskType] = null;
    if (normalizedMeta.keywords !== undefined) {
      profile.typeMeta ??= {};
      profile.typeMeta[normalizedTaskType] = normalizedMeta;
    }
  }, globalFilePath);
}

/** Remove a custom agent type and all of its routing entries from the active Profile. */
export function deleteGlobalProfileCustomType(
  cwd: string,
  profileId: string,
  taskType: TeammateTaskType,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  if ((TEAMMATE_TASK_TYPES as readonly string[]).includes(normalizedTaskType)) {
    throw new Error(`Cannot delete a built-in teammate task type: ${normalizedTaskType}`);
  }
  return saveGlobalProfile(cwd, profileId, (profile) => {
    delete profile.mappings[normalizedTaskType];
    if (profile.fallbackMappings) delete profile.fallbackMappings[normalizedTaskType];
    if (profile.thinkingLevels) delete profile.thinkingLevels[normalizedTaskType];
    if (profile.typeMeta) delete profile.typeMeta[normalizedTaskType];
    if (profile.roleMappings) {
      for (const [role, rules] of Object.entries(profile.roleMappings)) {
        if (rules?.taskType === normalizedTaskType) profile.roleMappings[role] = { ...rules, taskType: null };
      }
    }
  }, globalFilePath);
}

export function createGlobalModelRoutingProfile(
  cwd: string,
  name: string,
  sourceProfileId?: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = normalizeProfileName(name, "");
  if (!normalizedName) throw new Error("Profile name is required");
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    const profileId = nextProfileId(store, normalizedName);
    const source = sourceProfileId ? requireProfile(store, sourceProfileId) : undefined;
    store.profiles[profileId] = {
      name: normalizedName,
      ...(source ? cloneRules(source) : emptyRules()),
    };
    writeJson(globalFilePath, store);
    return { ...resolvedState(cwd, globalFilePath), changedProfileId: profileId };
  });
}

export function createAndActivateGlobalModelRoutingProfile(
  cwd: string,
  name: string,
  sourceProfileId?: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = normalizeProfileName(name, "");
  if (!normalizedName) throw new Error("Profile name is required");
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const originalGlobal = structuredClone(global);
    const profileId = nextProfileId(global, normalizedName);
    const source = sourceProfileId ? requireProfile(global, sourceProfileId) : undefined;
    global.profiles[profileId] = {
      name: normalizedName,
      ...(source ? cloneRules(source) : emptyRules()),
    };
    const project = readProjectStore(projectFilePath);
    project.activeProfile = profileId;
    project.applyOverrides = false;
    writeGlobalAndProject(globalFilePath, originalGlobal, global, projectFilePath, project);
    return { ...resolvedState(cwd, globalFilePath), changedProfileId: profileId };
  });
}

export function renameGlobalModelRoutingProfile(
  cwd: string,
  profileId: string,
  name: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = normalizeProfileName(name, "");
  if (!normalizedName) throw new Error("Profile name is required");
  return saveGlobalProfile(cwd, profileId, (profile) => {
    profile.name = normalizedName;
  }, globalFilePath);
}

export function setDefaultGlobalModelRoutingProfile(
  cwd: string,
  profileId: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalConfigLock(globalFilePath, () => {
    const store = readGlobalStore(globalFilePath);
    requireProfile(store, profileId);
    store.defaultProfile = profileId;
    writeJson(globalFilePath, store);
    return resolvedState(cwd, globalFilePath);
  });
}

export function setProjectActiveModelRoutingProfile(
  cwd: string,
  profileId: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    requireProfile(global, profileId);
    const project = readProjectStore(projectFilePath);
    project.activeProfile = profileId;
    project.applyOverrides = false;
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}

/**
 * Activate a saved routing template for this project by stable id or display
 * name. Profile resolution and the project write share the existing global +
 * project lock, so a concurrent rename/delete cannot race the selection.
 */
export function activateModelRoutingProfile(
  cwd: string,
  reference: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const profileId = resolveProfileId(global, reference);
    const project = readProjectStore(projectFilePath);
    project.activeProfile = profileId;
    project.applyOverrides = false;
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}

export function setProjectModelRoutingOverridesEnabled(
  cwd: string,
  enabled: boolean,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const project = projectStoreForWrite(cwd, globalFilePath);
    project.applyOverrides = enabled && hasRules(project.overrides);
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}

export function clearProjectModelRoutingOverrides(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const project = projectStoreForWrite(cwd, globalFilePath);
    project.applyOverrides = false;
    project.overrides = emptyRules();
    writeJson(projectFilePath, project);
    return resolvedState(cwd, globalFilePath);
  });
}

export function promoteProjectModelRoutingOverrides(
  cwd: string,
  name: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const normalizedName = normalizeProfileName(name, "");
  if (!normalizedName) throw new Error("Profile name is required");
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    const originalGlobal = structuredClone(global);
    const project = readProjectStore(projectFilePath);
    if (!hasRules(project.overrides)) throw new Error("This project has no teammate model routing overrides");
    const requestedProfile = project.activeProfile ?? global.defaultProfile;
    const selectedProfileId = hasOwn(global.profiles, requestedProfile) ? requestedProfile : global.defaultProfile;
    const profileId = nextProfileId(global, normalizedName);
    global.profiles[profileId] = {
      name: normalizedName,
      ...mergeRules(global.profiles[selectedProfileId], project.overrides),
    };
    project.activeProfile = profileId;
    project.applyOverrides = false;
    writeGlobalAndProject(globalFilePath, originalGlobal, global, projectFilePath, project);
    return { ...resolvedState(cwd, globalFilePath), changedProfileId: profileId };
  });
}

export function deleteGlobalModelRoutingProfile(
  cwd: string,
  profileId: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return withGlobalAndProjectLocks(cwd, globalFilePath, (projectFilePath) => {
    const global = readGlobalStore(globalFilePath);
    requireProfile(global, profileId);
    if (global.defaultProfile === profileId) throw new Error("The default teammate model profile cannot be deleted");
    const originalGlobal = structuredClone(global);
    const project = readProjectStore(projectFilePath);
    const projectChanged = project.activeProfile === profileId;
    delete global.profiles[profileId];
    global.retiredProfileIds = [...new Set([...(global.retiredProfileIds ?? []), profileId])];
    if (projectChanged) {
      project.activeProfile = global.defaultProfile;
      project.applyOverrides = false;
    }
    if (projectChanged) writeGlobalAndProject(globalFilePath, originalGlobal, global, projectFilePath, project);
    else writeJson(globalFilePath, global);
    return resolvedState(cwd, globalFilePath);
  });
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

function roleRules(config: ModelRoutingConfig, input: TaskTypeInput): ModelRoutingRoleRules | undefined {
  const role = input.agent?.trim();
  if (!role) return undefined;
  const configured = config.roleMappings?.[role];
  return configured && configured !== null ? configured : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a task prompt against configured type keywords: the first type whose
 * keyword appears as a whole word wins, in discovery order (built-ins first,
 * then custom types alphabetically). Keywords are lowercased at normalize.
 */
export function inferTaskTypeByKeywords(
  config: ModelRoutingConfig,
  task: string | undefined,
): TeammateTaskType | undefined {
  const text = task?.toLowerCase() ?? "";
  if (!text) return undefined;
  for (const taskType of discoverRoutingTaskTypes("", [], config)) {
    const meta = config.typeMeta?.[taskType];
    if (!meta || !meta.keywords || meta.keywords.length === 0) continue;
    for (const keyword of meta.keywords) {
      if (new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(text)) return taskType;
    }
  }
  return undefined;
}

function inferTaskTypeWithKeywords(config: ModelRoutingConfig, input: TaskTypeInput): TeammateTaskType | undefined {
  // Explicit user-configured keywords outrank the built-in heuristic regexes:
  // a configured trigger word is a higher-confidence signal than the generic
  // prompt patterns, so a custom type can claim prompts the heuristics would
  // otherwise route to a built-in type.
  return inferTaskTypeByKeywords(config, input.task) ?? inferTaskType(input);
}

function mappedModel(
  config: ModelRoutingConfig,
  input: TaskTypeInput,
  availableModels: readonly string[],
): string | undefined {
  const taskType = inferTaskTypeWithKeywords(config, input);
  if (taskType) {
    const configured = config.mappings[taskType];
    if (configured) {
      if (availableModels.length === 0 || availableModels.includes(configured)) return configured;
    }
  }
  const configured = roleRules(config, input)?.model;
  if (!configured) return undefined;
  if (availableModels.length > 0 && !availableModels.includes(configured)) return undefined;
  return configured;
}

function mappedFallbackModels(
  config: ModelRoutingConfig,
  input: TaskTypeInput,
  availableModels: readonly string[],
): string[] | undefined {
  const taskType = inferTaskTypeWithKeywords(config, input);
  const configured = taskType ? config.fallbackMappings?.[taskType] : undefined;
  if (configured) {
    const filtered = availableModels.length > 0
      ? configured.filter((model) => availableModels.includes(model))
      : configured;
    if (filtered.length > 0) return [...new Set(filtered)];
  }
  const roleFallbacks = roleRules(config, input)?.fallbackModels;
  if (!roleFallbacks) return undefined;
  const filtered = availableModels.length > 0
    ? roleFallbacks.filter((model) => availableModels.includes(model))
    : roleFallbacks;
  return filtered.length > 0 ? [...new Set(filtered)] : undefined;
}

function mappedThinking(config: ModelRoutingConfig, input: TaskTypeInput): TeammateThinkingLevel | undefined {
  const taskType = inferTaskTypeWithKeywords(config, input);
  if (taskType) {
    const configured = config.thinkingLevels[taskType];
    if (configured) return configured;
  }
  return roleRules(config, input)?.thinking ?? undefined;
}

export function applyModelRouting(
  params: RunTeammateParams,
  cwd: string,
  availableModels: readonly string[] = [],
  globalFilePath = getGlobalModelRoutingPath(),
  inheritModel?: string,
  sessionId?: string,
): RunTeammateParams {
  const topLevelModel = params.model;
  const topLevelThinking = parseTeammateThinkingLevel(params.thinking);
  // Default resolution: when neither the task nor the top level pins a model,
  // configured task-type/role mappings still win, otherwise the dispatch
  // inherits the main session's model (or the parent agent's resolved model for
  // nested dispatches). An inherited model absent from the teammate catalog is
  // skipped so a stale session model cannot force an invalid child spawn.
  const resolvedInheritModel = inheritModel
    && (availableModels.length === 0 || availableModels.includes(inheritModel))
    ? inheritModel
    : undefined;

  const tasks = params.tasks.map((task) => {
    const routingCwd = path.resolve(cwd, task.cwd ?? params.cwd ?? ".");
    const config = loadModelRoutingConfig(routingCwd, globalFilePath, sessionId);
    const agent = task.agent ?? params.agent ?? "general";
    const agentConfig = resolveAgent(routingCwd, agent);
    const explicitTaskType = task.taskType ?? params.taskType;
    const assignedRoleTaskType = roleRules(config, { agent, task: task.prompt })?.taskType;
    const roleTaskType = assignedRoleTaskType ?? agentConfig?.taskType;
    const taskType = explicitTaskType
      ?? roleTaskType
      ?? inferTaskTypeWithKeywords(config, { agent, task: task.prompt });
    return {
      ...task,
      ...(taskType ? { taskType } : {}),
      model: task.model ?? topLevelModel ?? mappedModel(config, {
        taskType,
        agent,
        task: task.prompt,
      }, availableModels) ?? agentConfig?.model ?? resolvedInheritModel,
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

/**
 * Sync per-role circuit policies from the routing config onto a circuit
 * breaker: each role rule with a `circuit` policy uses the assigned task
 * type's mapped model first, then the role model when the type has no model.
 * The breaker's policy map is rebuilt from the config on every call, so
 * removed policies do not linger.
 */
export function syncModelCircuitPolicies(
  breaker: ModelCircuitBreaker,
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): void {
  breaker.clearPolicies();
  const config = loadModelRoutingConfig(cwd, globalFilePath);
  for (const rules of Object.values(config.roleMappings ?? {})) {
    if (!rules || !rules.circuit) continue;
    const typeModel = rules.taskType ? config.mappings[rules.taskType] : undefined;
    const model = typeModel ?? rules.model;
    if (!model) continue;
    breaker.setPolicy(model, rules.circuit);
  }
}

/** Reconcile registry-mode health against the dispatch projection's stable hash. */
export function reconcileModelHealthProjection(
  health: ModelHealthCoordinator,
  projection: DispatchAuthorityProjection,
): boolean {
  return health.reconcileProjection(projection);
}

export interface ModelRegistrationRoutingInput {
  model?: string;
  fallbackModels?: readonly string[];
  backend?: string;
  cwd?: string;
}

export interface ResolvedModelRegistrationCandidate {
  modelRegistrationId: string;
  route: ModelDispatchRoute;
  deployment: ModelDeploymentRoute;
}

export interface ResolvedModelRegistrationRouting {
  candidates: readonly ResolvedModelRegistrationCandidate[];
  requestedDeploymentId?: string;
  remoteLocation?: string;
}

function canonicalModelRegistrationId(
  projection: DispatchAuthorityProjection,
  requested: string,
): string {
  const canonical = projection.modelAliases.get(requested) ?? requested;
  if (!projection.routesByRegistrationId.has(canonical)) {
    throw new TypeError(
      `Unknown teammate model registration ${JSON.stringify(requested)}. Use an available canonical registration id or configured model alias.`,
    );
  }
  return canonical;
}

function canonicalDeploymentId(
  projection: DispatchAuthorityProjection,
  requested: string,
): string {
  const canonical = projection.backendAliases.get(requested) ?? requested;
  if (!projection.deploymentsById.has(canonical)) {
    throw new TypeError(
      `Unknown teammate deployment ${JSON.stringify(requested)}. Use a registered deployment id or configured backend alias.`,
    );
  }
  return canonical;
}

function deploymentDefaultRegistrationId(
  projection: DispatchAuthorityProjection,
  deploymentId: string,
): string {
  for (const [registrationId, route] of projection.routesByRegistrationId) {
    if (route.deploymentId === deploymentId && route.deploymentDefault) return registrationId;
  }
  throw new TypeError(
    `Teammate deployment ${JSON.stringify(deploymentId)} has no model registration marked deploymentDefault.`,
  );
}

function registrationCandidate(
  projection: DispatchAuthorityProjection,
  modelRegistrationId: string,
): ResolvedModelRegistrationCandidate {
  const route = projection.routesByRegistrationId.get(modelRegistrationId);
  if (route === undefined) {
    throw new TypeError(`Unknown canonical teammate model registration ${JSON.stringify(modelRegistrationId)}.`);
  }
  const deployment = projection.deploymentsById.get(route.deploymentId);
  if (deployment === undefined) {
    throw new TypeError(
      `Teammate model registration ${JSON.stringify(modelRegistrationId)} targets unknown deployment ${JSON.stringify(route.deploymentId)}.`,
    );
  }
  return Object.freeze({ modelRegistrationId, route, deployment });
}

/**
 * Resolve one registry-mode task entirely through the captured dispatch
 * authority. No adapter model id, backend heuristic, or remote target name is
 * treated as a registration implicitly.
 */
export function resolveModelRegistrationRouting(
  projection: DispatchAuthorityProjection,
  input: ModelRegistrationRoutingInput,
): ResolvedModelRegistrationRouting {
  const requestedDeploymentId = input.backend === undefined
    ? undefined
    : canonicalDeploymentId(projection, input.backend);
  const remoteLocation = input.cwd?.startsWith("remote:") === true ? input.cwd : undefined;
  const remoteRegistrationId = remoteLocation === undefined
    ? undefined
    : projection.remoteLocations.get(remoteLocation);

  if (remoteLocation !== undefined && remoteRegistrationId === undefined) {
    throw new TypeError(
      `Unknown model-registry remote location ${JSON.stringify(remoteLocation)}. Configure an explicit remoteLocations registration mapping.`,
    );
  }

  const explicitPrimary = input.model === undefined
    ? undefined
    : canonicalModelRegistrationId(projection, input.model);
  const primary = explicitPrimary
    ?? remoteRegistrationId
    ?? (requestedDeploymentId === undefined
      ? projection.defaultModel
      : deploymentDefaultRegistrationId(projection, requestedDeploymentId));
  const canonicalFallbacks = (input.fallbackModels ?? []).map((model) =>
    canonicalModelRegistrationId(projection, model));
  const candidateIds = [...new Set([primary, ...canonicalFallbacks])];
  const candidates = candidateIds.map((registrationId) => registrationCandidate(projection, registrationId));

  if (remoteRegistrationId !== undefined) {
    const remote = registrationCandidate(projection, remoteRegistrationId);
    if (remote.deployment.runtime.transport.kind !== "remote-worker") {
      throw new TypeError(
        `Model-registry remote location ${JSON.stringify(remoteLocation)} maps to non-remote model registration ${JSON.stringify(remoteRegistrationId)}.`,
      );
    }
    const conflict = candidates.find((candidate) => candidate.modelRegistrationId !== remoteRegistrationId);
    if (conflict !== undefined) {
      throw new TypeError(
        `Teammate model registration ${JSON.stringify(conflict.modelRegistrationId)} conflicts with remote location ${JSON.stringify(remoteLocation)}, which selects ${JSON.stringify(remoteRegistrationId)}.`,
      );
    }
  }

  if (requestedDeploymentId !== undefined) {
    const conflict = candidates.find((candidate) => candidate.route.deploymentId !== requestedDeploymentId);
    if (conflict !== undefined) {
      throw new TypeError(
        `Teammate model registration ${JSON.stringify(conflict.modelRegistrationId)} targets deployment ${JSON.stringify(conflict.route.deploymentId)}, which conflicts with requested deployment ${JSON.stringify(requestedDeploymentId)}.`,
      );
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    ...(requestedDeploymentId === undefined ? {} : { requestedDeploymentId }),
    ...(remoteLocation === undefined ? {} : { remoteLocation }),
  });
}

/** Pi can hot-switch only between adapter selectors owned by one Pi deployment. */
export function canHotSwitchModelRegistration(
  from: ResolvedModelRegistrationCandidate,
  to: ResolvedModelRegistrationCandidate,
): boolean {
  return from.route.deploymentId === to.route.deploymentId
    && from.deployment.runtime.harness === "pi"
    && to.deployment.runtime.harness === "pi"
    && from.route.selector.kind === "adapter-model"
    && to.route.selector.kind === "adapter-model";
}

export interface ModelRegistryRefreshContext {
  modelRegistry?: { refresh?: () => Promise<unknown> } | undefined;
}

const modelRegistryRefreshInFlight = new WeakMap<object, Promise<void>>();

/**
 * Await a coalesced refresh of the host model registry before reading its
 * getAvailable() snapshot. The sync snapshot is only rebuilt by refresh();
 * without it, models deleted from config/auth stay visible to catalog,
 * routing and modelCapabilities validation until unrelated code refreshes.
 */
export async function refreshModelRegistry(ctx: ModelRegistryRefreshContext): Promise<void> {
  const registry = ctx.modelRegistry;
  if (!registry?.refresh) return;
  // Call through the registry object: the host's refresh() is a class method
  // that reads `this.runtime`. A detached call would throw
  // "Cannot read properties of undefined (reading 'runtime')" and leave the
  // synchronous getAvailable() snapshot stale. Coalesce only calls against the
  // same registry: separate extension runtimes must each refresh their snapshot.
  let refresh = modelRegistryRefreshInFlight.get(registry);
  if (!refresh) {
    refresh = Promise.resolve()
      .then(() => registry.refresh!())
      .then(() => undefined, (error) => {
        // A failed registry refresh must not block dispatch; the previous
        // snapshot stays authoritative until the next successful refresh.
        logDiagnosticError(
          `[pi-maestro-teammate] model registry refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (modelRegistryRefreshInFlight.get(registry) === refresh) {
          modelRegistryRefreshInFlight.delete(registry);
        }
      });
    modelRegistryRefreshInFlight.set(registry, refresh);
  }
  await refresh;
}

/**
 * Configured routing targets that the current teammate catalog cannot reach.
 *
 * `mappedModel` skips unreachable targets silently (the dispatch then falls
 * back down the inheritance chain), so this is the one place an operator can
 * see that a task-type or role mapping names a model no gate currently
 * admits. Empty `availableModels` means "no catalog knowledge" and yields no
 * findings — absence of evidence must not read as breakage.
 */
export interface UnreachableRoutingTarget {
  kind: "taskType" | "role";
  key: string;
  model: string;
}

export function unreachableRoutingTargets(
  config: ModelRoutingConfig,
  availableModels: readonly string[],
): UnreachableRoutingTarget[] {
  if (availableModels.length === 0) return [];
  const known = new Set(availableModels);
  const missing = (model: string | null | undefined): boolean =>
    typeof model === "string" && model.trim().length > 0 && !known.has(model);
  const targets: UnreachableRoutingTarget[] = [];
  for (const [taskType, model] of Object.entries(config.mappings)) {
    if (missing(model)) targets.push({ kind: "taskType", key: taskType, model: model! });
  }
  for (const [role, rules] of Object.entries(config.roleMappings ?? {})) {
    if (rules && missing(rules.model)) targets.push({ kind: "role", key: role, model: rules.model! });
  }
  return targets;
}

export function formatModelRoutingConfig(
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
  globalFilePath = getGlobalModelRoutingPath(),
  availableModels: readonly string[] = [],
): string {
  const config = loadModelRoutingConfig(cwd, globalFilePath);
  const table = discoverRoutingTaskTypes(cwd, agents, config)
    .map((taskType) => {
      const fallbacks = config.fallbackMappings?.[taskType]?.join(",") || "none";
      return `- ${taskType}: model=${config.mappings[taskType] ?? "auto/inherit main session"}, fallbacks=${fallbacks}, thinking=${config.thinkingLevels[taskType] ?? "inherit/default"}`;
    })
    .join("\n");
  const unreachable = unreachableRoutingTargets(config, availableModels);
  const warnings = unreachable.map((target) =>
    `- ⚠ ${target.model} (${target.kind} "${target.key}") is not in the current teammate catalog; routing will skip it and fall back to inheritance`
  );
  return [table, ...warnings].filter((part) => part.length > 0).join("\n");
}

export const TASK_TYPE_ROUTING_START_MARKER = "<!-- teammate-tasktype-routing:start -->";
export const TASK_TYPE_ROUTING_END_MARKER = "<!-- teammate-tasktype-routing:end -->";

/**
 * Inject concise taskType model-routing guidance for agents that can dispatch
 * teammates. Replaces an existing block in place so repeated injection stays
 * idempotent.
 */
export function appendTaskTypeRoutingContext(
  systemPrompt: string,
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
  globalFilePath = getGlobalModelRoutingPath(),
  availableModels: readonly string[] = [],
): string {
  const config = loadModelRoutingConfig(cwd, globalFilePath);
  const routingTable = formatModelRoutingConfig(cwd, agents, globalFilePath, availableModels);
  const customTypes = discoverRoutingTaskTypes(cwd, agents, config)
    .filter((taskType) => !(TEAMMATE_TASK_TYPES as readonly string[]).includes(taskType))
    .map((taskType) => `  - ${taskType}`);
  const lines = [
    TASK_TYPE_ROUTING_START_MARKER,
    "## Teammate taskType routing",
    "`taskType` selects configured model, fallback-model, and thinking defaults (and, in experts mode, the default expert agent when none is given); it never changes a chosen agent's role, tools, permissions, or task scope.",
    "Set `tasks[].taskType` by the task's actual phase; top-level `taskType` is the default for all tasks. If omitted, the runtime uses the agent default or prompt inference and may inherit the parent model. Set `model` only to override routing.",
    "",
    "Legal task types (agents may declare more):",
    ...TEAMMATE_TASK_TYPES.map((type) => `  - ${type}`),
    ...(customTypes.length > 0 ? customTypes : []),
    "",
    "Current task-type model routing:",
    ...routingTable.split("\n").map((line) => `  ${line}`),
    TASK_TYPE_ROUTING_END_MARKER,
  ];
  const block = lines.join("\n");
  const start = systemPrompt.indexOf(TASK_TYPE_ROUTING_START_MARKER);
  const end = systemPrompt.indexOf(TASK_TYPE_ROUTING_END_MARKER);
  if (start >= 0 && end >= start) {
    return `${systemPrompt.slice(0, start)}${block}${systemPrompt.slice(end + TASK_TYPE_ROUTING_END_MARKER.length)}`;
  }
  return `${systemPrompt}\n\n${block}`;
}

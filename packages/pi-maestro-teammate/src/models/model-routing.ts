import { execFileSync } from "node:child_process";
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

export interface ModelRoutingRoleRules {
  model?: string | null;
  fallbackModels?: string[] | null;
  thinking?: TeammateThinkingLevel | null;
}

export interface ModelRoutingRules {
  mappings: Partial<Record<TeammateTaskType, string | null>>;
  fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
  thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
  roleMappings?: Record<string, ModelRoutingRoleRules | null>;
}

export interface ModelRoutingProfile extends ModelRoutingRules {
  name: string;
}

export interface GlobalModelRoutingStore {
  version: 3;
  defaultProfile: string;
  profiles: Record<string, ModelRoutingProfile>;
  retiredProfileIds?: string[];
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
    },
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
  return {
    mappings: { ...rules.mappings },
    ...(fallbackMappings && Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels: { ...rules.thinkingLevels },
    ...(roleMappings && Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
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
    assertKnownKeys(rules, ["model", "fallbackModels", "thinking"], `Role ${role}`);
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
  }
}

function validateV3Rules(value: Record<string, unknown>, label: string): void {
  assertKnownKeys(value, ["mappings", "fallbackMappings", "thinkingLevels", "roleMappings"], label);
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
    roleMappings[role] = normalized;
  }
  return {
    mappings,
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels,
    ...(Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
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
  return {
    mappings: { ...base.mappings, ...overrides.mappings },
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels: { ...base.thinkingLevels, ...overrides.thinkingLevels },
    ...(Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
  };
}

function hasRules(rules: ModelRoutingRules): boolean {
  return Object.keys(rules.mappings).length > 0
    || Object.keys(rules.fallbackMappings ?? {}).length > 0
    || Object.keys(rules.thinkingLevels).length > 0
    || Object.keys(rules.roleMappings ?? {}).length > 0;
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
    assertKnownKeys(parsed, ["version", "defaultProfile", "profiles", "retiredProfileIds"], "v3 global config");
    if (!parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
      return invalidGlobalStore();
    }
    const profiles: Record<string, ModelRoutingProfile> = {};
    for (const [profileId, rawProfile] of Object.entries(parsed.profiles as Record<string, unknown>)) {
      if (!isProfileId(profileId) || !rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        return invalidGlobalStore();
      }
      const profile = rawProfile as Record<string, unknown>;
      assertKnownKeys(profile, ["name", "mappings", "fallbackMappings", "thinkingLevels", "roleMappings"], `Profile ${profileId}`);
      if (typeof profile.name !== "string" || !normalizeProfileName(profile.name, "")) return invalidGlobalStore();
      validateV3Rules({
        mappings: profile.mappings,
        ...(hasOwn(profile, "fallbackMappings") ? { fallbackMappings: profile.fallbackMappings } : {}),
        thinkingLevels: profile.thinkingLevels,
        ...(hasOwn(profile, "roleMappings") ? { roleMappings: profile.roleMappings } : {}),
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
    return {
      version: 3,
      defaultProfile: requestedDefault,
      profiles,
      ...(retiredProfileIds.length > 0 ? { retiredProfileIds } : {}),
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

function resolvedState(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  const global = readGlobalStore(globalFilePath);
  const project = readProjectStore(getProjectModelRoutingPath(cwd));
  const requestedProfile = project.activeProfile ?? global.defaultProfile;
  const missingProfile = hasOwn(global.profiles, requestedProfile) ? undefined : requestedProfile;
  const profileId = missingProfile ? global.defaultProfile : requestedProfile;
  const profile = global.profiles[profileId];
  const rules = project.applyOverrides ? mergeRules(profile, project.overrides) : cloneRules(profile);
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
    requestedProfile,
    ...(missingProfile ? { missingProfile } : {}),
  };
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

function readConsistentState(cwd: string, globalFilePath: string): ModelRoutingState {
  const projectFilePath = getProjectModelRoutingPath(cwd);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (fs.existsSync(transactionPath(globalFilePath))) {
      return withGlobalConfigLock(globalFilePath, () => resolvedState(cwd, globalFilePath));
    }
    const globalBefore = fileSignature(globalFilePath);
    const projectBefore = fileSignature(projectFilePath);
    const state = resolvedState(cwd, globalFilePath);
    const globalAfter = fileSignature(globalFilePath);
    const projectAfter = fileSignature(projectFilePath);
    if (
      !fs.existsSync(transactionPath(globalFilePath))
      && globalBefore === globalAfter
      && projectBefore === projectAfter
    ) return state;
  }
  return withGlobalConfigLock(globalFilePath, () => resolvedState(cwd, globalFilePath));
}

export function loadModelRoutingState(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingState {
  return readConsistentState(cwd, globalFilePath);
}

export function loadModelRoutingConfig(
  cwd: string,
  globalFilePath = getGlobalModelRoutingPath(),
): ModelRoutingConfig {
  return readConsistentState(cwd, globalFilePath).config;
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

function mappedModel(
  config: ModelRoutingConfig,
  input: TaskTypeInput,
  availableModels: readonly string[],
): string | undefined {
  const taskType = inferTaskType(input);
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
  const taskType = inferTaskType(input);
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
  const taskType = inferTaskType(input);
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
    const config = loadModelRoutingConfig(routingCwd, globalFilePath);
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
      }, availableModels) ?? resolvedInheritModel,
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
        console.error(
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

export function formatModelRoutingConfig(
  cwd: string,
  agents: readonly { taskType?: TeammateTaskType }[] = [],
): string {
  const config = loadModelRoutingConfig(cwd);
  return discoverRoutingTaskTypes(cwd, agents, config)
    .map((taskType) => {
      const fallbacks = config.fallbackMappings?.[taskType]?.join(",") || "none";
      return `- ${taskType}: model=${config.mappings[taskType] ?? "auto/inherit main session"}, fallbacks=${fallbacks}, thinking=${config.thinkingLevels[taskType] ?? "inherit/default"}`;
    })
    .join("\n");
}

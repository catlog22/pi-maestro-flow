import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * Absolute upper bound for `reserveTokens`, applied at load time where the
 * model context window is unknown. `evaluate()` disables all context
 * management when `contextWindow <= reserveTokens`, so a malformed/oversized
 * value would silently turn compaction off. This ceiling sits above the
 * largest real-world context windows (~1-2M tokens), so any plausibly valid
 * configuration is unaffected while a value that could exceed every model's
 * window is treated as invalid and falls back to the default.
 */
export const MAX_RESERVE_TOKENS = 2_000_000;

export interface VelocityCompactionConfigPatch {
  enabled?: boolean;
  epochsToCritical?: number;
  minFullness?: number;
}

export interface VelocityCompactionSettings {
  enabled: boolean;
  epochsToCritical: number;
  minFullness: number;
}

export interface CacheCompactionConfigPatch {
  enabled?: boolean;
}

export interface CacheCompactionSettings {
  enabled: boolean;
}

export interface SpillCompactionConfigPatch {
  enabled?: boolean;
  thresholdChars?: number;
  previewChars?: number;
  protectedChars?: number;
}

export interface SpillCompactionSettings {
  enabled: boolean;
  thresholdChars: number;
  previewChars: number;
  protectedChars: number;
}

export interface SoftCompactionConfigPatch {
  enabled?: boolean;
  nudgeRatio?: number;
  pruneRatio?: number;
  pruneTargetRatio?: number;
  velocity?: VelocityCompactionConfigPatch;
  cache?: CacheCompactionConfigPatch;
  spill?: SpillCompactionConfigPatch;
}

export interface SoftCompactionSettings {
  enabled: boolean;
  nudgeRatio: number;
  pruneRatio: number;
  pruneTargetRatio: number;
  velocity: VelocityCompactionSettings;
  cache: CacheCompactionSettings;
  spill: SpillCompactionSettings;
}

/**
 * Balanced soft-layer conditions; equivalent to the historical hardcoded ratios.
 *
 * `velocity` defaults off — it escalates compaction, so an unresolved setting
 * must not compact earlier than the historical token-ratio-only behavior.
 * `cache` defaults ON: it only ever *declines* prune runs whose savings cannot
 * pay for the cached prefix they invalidate, so the failure mode is "kept a
 * cheap prefix" rather than "compacted unexpectedly". Measured worst case for
 * the ungated path was 2.2K tokens saved against 81K invalidated.
 */
export function createDefaultSpillCompaction(): SpillCompactionSettings {
  return {
    enabled: true,
    thresholdChars: 8_000,
    previewChars: 1_500,
    protectedChars: 500,
  };
}

export function createDefaultSoftCompaction(): SoftCompactionSettings {
  return {
    enabled: true,
    nudgeRatio: 0.7,
    pruneRatio: 0.8,
    pruneTargetRatio: 0.7,
    velocity: { enabled: false, epochsToCritical: 3, minFullness: 0.7 },
    cache: { enabled: true },
    spill: createDefaultSpillCompaction(),
  };
}

export const DEFAULT_SOFT_COMPACTION: SoftCompactionSettings = createDefaultSoftCompaction();

export interface CompactionConfigPatch {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  soft?: SoftCompactionConfigPatch;
}

export const COMPACTION_FIELDS = ["enabled", "reserveTokens", "keepRecentTokens"] as const;

export type CompactionSettingSource = "project" | "user" | "default";

export interface EffectiveCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  soft: SoftCompactionSettings;
  source: Record<keyof CompactionConfigPatch, CompactionSettingSource>;
}

export type CompactionScope = "project" | "user";

export interface CompactionSettingsSnapshot {
  scopes: Record<CompactionScope, CompactionConfigPatch>;
  effective: EffectiveCompactionSettings;
}

export interface CompactionValidation {
  errors: string[];
  warnings: string[];
}

export function resolveUserSettingsPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(dir, "settings.json");
}

export function resolveProjectSettingsPath(projectRoot: string): string {
  return join(projectRoot, ".pi", "settings.json");
}

function settingsPathForScope(scope: CompactionScope, projectRoot: string): string {
  return scope === "project" ? resolveProjectSettingsPath(projectRoot) : resolveUserSettingsPath();
}

function readRawCompaction(path: string): CompactionConfigPatch {
  if (!existsSync(path)) return {};
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as { compaction?: unknown };
    if (!payload.compaction || typeof payload.compaction !== "object") return {};
    const c = payload.compaction as Record<string, unknown>;
    const patch: CompactionConfigPatch = {};
    if (typeof c.enabled === "boolean") patch.enabled = c.enabled;
    const hard = isRecord(c.hard) ? c.hard : undefined;
    const rt = boundedReserveTokens(hard?.reserveTokens) ?? boundedReserveTokens(c.reserveTokens);
    if (rt !== undefined) patch.reserveTokens = rt;
    const kr = positiveNumber(hard?.keepRecentTokens) ?? positiveNumber(c.keepRecentTokens);
    if (kr !== undefined) patch.keepRecentTokens = kr;
    const soft = readRawSoft(c.soft);
    if (soft) patch.soft = soft;
    return patch;
  } catch {
    return {};
  }
}

function readRawSoft(value: unknown): SoftCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const soft: SoftCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") soft.enabled = value.enabled;
  const nudgeRatio = ratioNumber(value.nudgeRatio);
  if (nudgeRatio !== undefined) soft.nudgeRatio = nudgeRatio;
  const pruneRatio = ratioNumber(value.pruneRatio);
  if (pruneRatio !== undefined) soft.pruneRatio = pruneRatio;
  const pruneTargetRatio = ratioNumber(value.pruneTargetRatio);
  if (pruneTargetRatio !== undefined) soft.pruneTargetRatio = pruneTargetRatio;
  const velocity = readRawVelocity(value.velocity);
  if (velocity) soft.velocity = velocity;
  const cache = readRawCache(value.cache);
  if (cache) soft.cache = cache;
  const spill = readRawSpill(value.spill);
  if (spill) soft.spill = spill;
  return Object.keys(soft).length > 0 ? soft : undefined;
}

function readRawSpill(value: unknown): SpillCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const spill: SpillCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") spill.enabled = value.enabled;
  if (typeof value.thresholdChars === "number" && Number.isSafeInteger(value.thresholdChars) && value.thresholdChars > 0) {
    spill.thresholdChars = value.thresholdChars;
  }
  if (typeof value.previewChars === "number" && Number.isSafeInteger(value.previewChars) && value.previewChars > 0) {
    spill.previewChars = value.previewChars;
  }
  if (typeof value.protectedChars === "number" && Number.isSafeInteger(value.protectedChars) && value.protectedChars > 0) {
    spill.protectedChars = value.protectedChars;
  }
  return Object.keys(spill).length > 0 ? spill : undefined;
}

function readRawVelocity(value: unknown): VelocityCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const velocity: VelocityCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") velocity.enabled = value.enabled;
  if (typeof value.epochsToCritical === "number" && Number.isSafeInteger(value.epochsToCritical) && value.epochsToCritical >= 1) {
    velocity.epochsToCritical = value.epochsToCritical;
  }
  const minFullness = ratioNumber(value.minFullness);
  if (minFullness !== undefined) velocity.minFullness = minFullness;
  return Object.keys(velocity).length > 0 ? velocity : undefined;
}

function readRawCache(value: unknown): CacheCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const cache: CacheCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") cache.enabled = value.enabled;
  return Object.keys(cache).length > 0 ? cache : undefined;
}

function ratioNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : undefined;
}

export function readScopeCompaction(scope: CompactionScope, projectRoot: string): CompactionConfigPatch {
  return readRawCompaction(settingsPathForScope(scope, projectRoot));
}

export function readEffectiveCompactionSettings(projectRoot: string): EffectiveCompactionSettings {
  return readCompactionSettings(projectRoot).effective;
}

export function readCompactionSettings(projectRoot: string): CompactionSettingsSnapshot {
  const scopes = {
    user: readRawCompaction(resolveUserSettingsPath()),
    project: readRawCompaction(resolveProjectSettingsPath(projectRoot)),
  };
  return {
    scopes,
    effective: resolveEffectiveCompactionSettings(scopes.user, scopes.project),
  };
}

export function resolveEffectiveCompactionSettings(
  userPatch: CompactionConfigPatch,
  projectPatch: CompactionConfigPatch,
): EffectiveCompactionSettings {
  const source: Record<keyof CompactionConfigPatch, CompactionSettingSource> = {
    enabled: "default",
    reserveTokens: "default",
    keepRecentTokens: "default",
    soft: "default",
  };

  let enabled = true;
  let reserveTokens = DEFAULT_RESERVE_TOKENS;
  let keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
  const soft: SoftCompactionSettings = createDefaultSoftCompaction();

  for (const [patch, src] of [[userPatch, "user"], [projectPatch, "project"]] as const) {
    if (patch.enabled !== undefined) { enabled = patch.enabled; source.enabled = src; }
    if (patch.reserveTokens !== undefined) { reserveTokens = patch.reserveTokens; source.reserveTokens = src; }
    if (patch.keepRecentTokens !== undefined) { keepRecentTokens = patch.keepRecentTokens; source.keepRecentTokens = src; }
    if (patch.soft !== undefined) {
      if (patch.soft.enabled !== undefined) soft.enabled = patch.soft.enabled;
      if (patch.soft.nudgeRatio !== undefined) soft.nudgeRatio = patch.soft.nudgeRatio;
      if (patch.soft.pruneRatio !== undefined) soft.pruneRatio = patch.soft.pruneRatio;
      if (patch.soft.pruneTargetRatio !== undefined) soft.pruneTargetRatio = patch.soft.pruneTargetRatio;
      if (patch.soft.velocity !== undefined) {
        if (patch.soft.velocity.enabled !== undefined) soft.velocity.enabled = patch.soft.velocity.enabled;
        if (patch.soft.velocity.epochsToCritical !== undefined) soft.velocity.epochsToCritical = patch.soft.velocity.epochsToCritical;
        if (patch.soft.velocity.minFullness !== undefined) soft.velocity.minFullness = patch.soft.velocity.minFullness;
      }
      if (patch.soft.cache !== undefined) {
        if (patch.soft.cache.enabled !== undefined) soft.cache.enabled = patch.soft.cache.enabled;
      }
      if (patch.soft.spill !== undefined) {
        if (patch.soft.spill.enabled !== undefined) soft.spill.enabled = patch.soft.spill.enabled;
        if (patch.soft.spill.thresholdChars !== undefined) soft.spill.thresholdChars = patch.soft.spill.thresholdChars;
        if (patch.soft.spill.previewChars !== undefined) soft.spill.previewChars = patch.soft.spill.previewChars;
        if (patch.soft.spill.protectedChars !== undefined) soft.spill.protectedChars = patch.soft.spill.protectedChars;
      }
      source.soft = src;
    }
  }

  return { enabled, reserveTokens, keepRecentTokens, soft, source };
}

export function validateCompactionPatch(
  patch: CompactionConfigPatch,
  contextWindow?: number,
  maxTokens?: number,
): CompactionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of ["reserveTokens", "keepRecentTokens"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(`${field} must be a positive safe integer`);
    }
  }

  const rt = patch.reserveTokens;
  if (rt !== undefined && Number.isSafeInteger(rt) && rt > 0) {
    if (rt > MAX_RESERVE_TOKENS) {
      errors.push(`reserveTokens (${rt}) must be <= ${MAX_RESERVE_TOKENS}`);
    }
    if (contextWindow !== undefined && rt >= contextWindow) {
      errors.push(`reserveTokens (${rt}) must be less than contextWindow (${contextWindow})`);
    }
    if (contextWindow !== undefined && rt < contextWindow) {
      const threshold = contextWindow - rt;
      const kr = patch.keepRecentTokens;
      if (kr !== undefined && kr >= threshold) {
        warnings.push(`keepRecentTokens (${kr}) >= thresholdTokens (${threshold}): little compressible history`);
      }
      if (maxTokens !== undefined && rt < maxTokens) {
        warnings.push(`reserveTokens (${rt}) < maxTokens (${maxTokens}): may not leave enough room for a single response`);
      }
    }
  }

  const soft = patch.soft;
  if (soft !== undefined) {
    for (const field of ["nudgeRatio", "pruneRatio", "pruneTargetRatio"] as const) {
      const value = soft[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
        errors.push(`soft.${field} must be a number in (0, 1)`);
      }
    }
    if (soft.nudgeRatio !== undefined && soft.pruneRatio !== undefined && soft.nudgeRatio >= soft.pruneRatio) {
      errors.push(`soft.nudgeRatio (${soft.nudgeRatio}) must be less than soft.pruneRatio (${soft.pruneRatio})`);
    }
    if (soft.pruneTargetRatio !== undefined && soft.pruneRatio !== undefined && soft.pruneTargetRatio >= soft.pruneRatio) {
      errors.push(`soft.pruneTargetRatio (${soft.pruneTargetRatio}) must be less than soft.pruneRatio (${soft.pruneRatio})`);
    }
    const velocity = soft.velocity;
    if (velocity !== undefined) {
      if (velocity.epochsToCritical !== undefined
        && (!Number.isSafeInteger(velocity.epochsToCritical) || velocity.epochsToCritical < 1)) {
        errors.push(`soft.velocity.epochsToCritical must be a positive safe integer`);
      }
      if (velocity.minFullness !== undefined
        && (typeof velocity.minFullness !== "number" || !Number.isFinite(velocity.minFullness)
          || velocity.minFullness <= 0 || velocity.minFullness >= 1)) {
        errors.push(`soft.velocity.minFullness must be a number in (0, 1)`);
      }
    }
  }

  if (contextWindow === undefined) {
    warnings.push("No model context window available; threshold validation skipped");
  }

  return { errors, warnings };
}

/**
 * Full invariant check on a resolved effective settings object. Per-patch
 * validation cannot catch invalid combinations produced by layering user and
 * project scopes; callers (TUI, tests) use this to validate the merged result.
 */
export function validateEffectiveCompactionSettings(settings: EffectiveCompactionSettings): CompactionValidation {
  const errors: string[] = [];
  const soft = settings.soft;
  for (const field of ["nudgeRatio", "pruneRatio", "pruneTargetRatio"] as const) {
    const value = soft[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
      errors.push(`soft.${field} must be a number in (0, 1)`);
    }
  }
  if (soft.nudgeRatio >= soft.pruneRatio) {
    errors.push(`soft.nudgeRatio (${soft.nudgeRatio}) must be less than soft.pruneRatio (${soft.pruneRatio})`);
  }
  if (soft.pruneTargetRatio >= soft.pruneRatio) {
    errors.push(`soft.pruneTargetRatio (${soft.pruneTargetRatio}) must be less than soft.pruneRatio (${soft.pruneRatio})`);
  }
  if (!Number.isSafeInteger(soft.velocity.epochsToCritical) || soft.velocity.epochsToCritical < 1) {
    errors.push(`soft.velocity.epochsToCritical must be a positive safe integer`);
  }
  if (typeof soft.velocity.minFullness !== "number" || !Number.isFinite(soft.velocity.minFullness)
    || soft.velocity.minFullness <= 0 || soft.velocity.minFullness >= 1) {
    errors.push(`soft.velocity.minFullness must be a number in (0, 1)`);
  }
  if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens <= 0) {
    errors.push(`reserveTokens must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens <= 0) {
    errors.push(`keepRecentTokens must be a positive safe integer`);
  }
  return { errors, warnings: [] };
}

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(path: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const settled = next.catch(() => undefined);
  writeQueues.set(path, settled);
  void settled.finally(() => {
    if (writeQueues.get(path) === settled) writeQueues.delete(path);
  });
  return next;
}

export async function saveCompactionPatch(
  scope: CompactionScope,
  projectRoot: string,
  patch: CompactionConfigPatch,
): Promise<void> {
  const path = settingsPathForScope(scope, projectRoot);
  return enqueueWrite(path, () => patchSettingsFile(path, patch));
}

export async function unsetCompactionField(
  scope: CompactionScope,
  projectRoot: string,
  field: keyof CompactionConfigPatch,
): Promise<void> {
  const path = settingsPathForScope(scope, projectRoot);
  return enqueueWrite(path, () => unsetFieldInSettingsFile(path, field));
}

export async function saveCompactionScope(
  scope: CompactionScope,
  projectRoot: string,
  values: CompactionConfigPatch,
): Promise<void> {
  const path = settingsPathForScope(scope, projectRoot);
  return enqueueWrite(path, () => replaceKnownFieldsInSettingsFile(path, values));
}

function normalizeCompactionRecord(compaction: Record<string, unknown>): Record<string, unknown> {
  const result = { ...compaction };
  const hard = isRecord(result.hard) ? { ...result.hard } : {};
  if (result.reserveTokens !== undefined) { hard.reserveTokens = result.reserveTokens; delete result.reserveTokens; }
  if (result.keepRecentTokens !== undefined) { hard.keepRecentTokens = result.keepRecentTokens; delete result.keepRecentTokens; }
  if (Object.keys(hard).length > 0) result.hard = hard;
  return result;
}

async function patchSettingsFile(path: string, patch: CompactionConfigPatch): Promise<void> {
  const root = readJsonRoot(path);
  const compaction = normalizeCompactionRecord(isRecord(root.compaction) ? { ...root.compaction } : {});
  if (patch.enabled !== undefined) compaction.enabled = patch.enabled;
  if (patch.reserveTokens !== undefined || patch.keepRecentTokens !== undefined) {
    const hard = isRecord(compaction.hard) ? { ...compaction.hard } : {};
    if (patch.reserveTokens !== undefined) hard.reserveTokens = patch.reserveTokens;
    if (patch.keepRecentTokens !== undefined) hard.keepRecentTokens = patch.keepRecentTokens;
    compaction.hard = hard;
  }
  if (patch.soft !== undefined) {
    const merged: Record<string, unknown> = isRecord(compaction.soft) ? { ...compaction.soft } : {};
    for (const [key, value] of Object.entries(patch.soft)) {
      if (value !== undefined) merged[key] = value;
    }
    compaction.soft = merged;
  }
  root.compaction = compaction;
  await atomicWriteJson(path, root);
}

async function unsetFieldInSettingsFile(path: string, field: keyof CompactionConfigPatch): Promise<void> {
  const root = readJsonRoot(path);
  if (isRecord(root.compaction)) {
    if (field === "reserveTokens" || field === "keepRecentTokens") {
      delete root.compaction[field];
      if (isRecord(root.compaction.hard)) {
        delete root.compaction.hard[field];
        if (Object.keys(root.compaction.hard).length === 0) delete root.compaction.hard;
      }
    } else {
      delete root.compaction[field];
    }
    if (Object.keys(root.compaction).length === 0) {
      delete root.compaction;
    }
  }
  await atomicWriteJson(path, root);
}

async function replaceKnownFieldsInSettingsFile(path: string, values: CompactionConfigPatch): Promise<void> {
  const root = readJsonRoot(path);
  const compaction = normalizeCompactionRecord(isRecord(root.compaction) ? { ...root.compaction } : {});
  if (values.enabled === undefined) delete compaction.enabled;
  else compaction.enabled = values.enabled;
  const hard = isRecord(compaction.hard) ? { ...compaction.hard } : {};
  if (values.reserveTokens === undefined) delete hard.reserveTokens;
  else hard.reserveTokens = values.reserveTokens;
  if (values.keepRecentTokens === undefined) delete hard.keepRecentTokens;
  else hard.keepRecentTokens = values.keepRecentTokens;
  if (Object.keys(hard).length === 0) delete compaction.hard;
  else compaction.hard = hard;
  if (values.soft !== undefined) {
    const soft: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values.soft)) {
      if (value !== undefined) soft[key] = value;
    }
    compaction.soft = soft;
  }
  if (Object.keys(compaction).length === 0) delete root.compaction;
  else root.compaction = compaction;
  await atomicWriteJson(path, root);
}

function readJsonRoot(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error(`Settings root must be a JSON object: ${path}`);
    return parsed;
  } catch (error) {
    throw new Error(
      `Cannot safely update malformed settings file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (process.platform === "win32" && ["EEXIST", "EPERM", "ENOTEMPTY"].includes(code)) {
      await unlink(path).catch(() => undefined);
      await rename(temporaryPath, path);
      return;
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A positive `reserveTokens` capped by {@link MAX_RESERVE_TOKENS}. Oversized
 * values return undefined so the caller falls back to the default instead of
 * silently disabling compaction on every model.
 */
function boundedReserveTokens(value: unknown): number | undefined {
  const rt = positiveNumber(value);
  return rt !== undefined && rt <= MAX_RESERVE_TOKENS ? rt : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

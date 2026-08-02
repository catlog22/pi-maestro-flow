import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lockSettingsResource } from "../settings/resource-lock.ts";
import { effectiveReserveTokens } from "./compaction-threshold.ts";
import type { RelevanceMode } from "./relevance.ts";
import { DEFAULT_DEDUP_MIN_CHARS, DEFAULT_DEDUP_MIN_LINES } from "./dedup.ts";

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
  /** Dynamic prune-savings gate range (fraction of invalidated suffix). */
  minRatioRange?: [number, number];
}

export interface CacheCompactionSettings {
  enabled: boolean;
  /** Optional for source compatibility; resolved defaults provide [0.1, 0.5]. */
  minRatioRange?: [number, number];
}

export interface TimeBasedCompactionConfigPatch {
  enabled?: boolean;
  gapThresholdMinutes?: number;
}

/**
 * Time-based cache-cold detection (mirrors Claude Code's time-based
 * microcompact). When the gap since the last main-loop assistant message
 * exceeds `gapThresholdMinutes`, the provider's prompt cache has almost
 * certainly expired, so the full prefix will be rewritten anyway — pruning
 * then costs nothing extra and the cache gate is bypassed.
 */
export interface TimeBasedCompactionSettings {
  enabled: boolean;
  gapThresholdMinutes: number;
}

export interface RelevanceCompactionConfigPatch {
  enabled?: boolean;
  mode?: RelevanceMode;
}

export interface RelevanceCompactionSettings {
  enabled: boolean;
  mode: RelevanceMode;
}

export interface CrossTurnDedupConfigPatch {
  enabled?: boolean;
  minLines?: number;
  minChars?: number;
}

/**
 * Cross-turn verbatim de-duplication (mirrors headroom cross_turn_dedup).
 * Replaces later spans that already appeared verbatim in an earlier tool output
 * with an in-context pointer; the referenced output is protected from pruning.
 */
export interface CrossTurnDedupSettings {
  enabled: boolean;
  minLines: number;
  minChars: number;
}

export interface LosslessCompactionConfigPatch {
  enabled?: boolean;
}

/**
 * Format-native lossless folding (ported from headroom lossless_compaction).
 *
 * Defaults ON: unlike the other soft-layer toggles it only ever *shrinks*
 * tool output without losing information (run collapse, grep heading folding,
 * diff index stripping), and every transform self-checks its round-trip, so
 * the failure mode is "kept the original bytes" rather than corruption or
 * inflation.
 */
export interface LosslessCompactionSettings {
  enabled: boolean;
}

export interface SoftCompactionConfigPatch {
  enabled?: boolean;
  nudgeRatio?: number;
  pruneRatio?: number;
  pruneTargetRatio?: number;
  velocity?: VelocityCompactionConfigPatch;
  cache?: CacheCompactionConfigPatch;
  timeBased?: TimeBasedCompactionConfigPatch;
  relevance?: RelevanceCompactionConfigPatch;
  crossTurnDedup?: CrossTurnDedupConfigPatch;
  lossless?: LosslessCompactionConfigPatch;
}

export interface SoftCompactionSettings {
  enabled: boolean;
  nudgeRatio: number;
  pruneRatio: number;
  pruneTargetRatio: number;
  velocity: VelocityCompactionSettings;
  cache: CacheCompactionSettings;
  /** Optional for source compatibility; resolved defaults provide this group. */
  timeBased?: TimeBasedCompactionSettings;
  /** Optional for source compatibility; resolved defaults provide this group. */
  relevance?: RelevanceCompactionSettings;
  /** Optional for source compatibility; resolved defaults provide this group. */
  crossTurnDedup?: CrossTurnDedupSettings;
  lossless: LosslessCompactionSettings;
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
 *
 * `lossless` defaults ON: zero-risk format folding (see LosslessCompactionSettings).
 * `timeBased` defaults OFF: cache-cold detection only declines the gate when
 * enabled — an unresolved setting must not compact earlier than historical
 * token-ratio-only behavior.
 * `relevance` defaults OFF: lexical ranking changes which eligible outputs are
 * pruned first, so historical newest-first ordering remains the safe default.
 */
export function createDefaultSoftCompaction(): SoftCompactionSettings {
  return {
    enabled: true,
    nudgeRatio: 0.7,
    pruneRatio: 0.8,
    pruneTargetRatio: 0.7,
    velocity: { enabled: false, epochsToCritical: 3, minFullness: 0.7 },
    cache: { enabled: true, minRatioRange: [0.1, 0.5] },
    timeBased: { enabled: false, gapThresholdMinutes: 60 },
    relevance: { enabled: false, mode: "bm25" },
    crossTurnDedup: {
      enabled: false,
      minLines: DEFAULT_DEDUP_MIN_LINES,
      minChars: DEFAULT_DEDUP_MIN_CHARS,
    },
    lossless: { enabled: true },
  };
}

export const DEFAULT_SOFT_COMPACTION: SoftCompactionSettings = createDefaultSoftCompaction();

export interface CompactionConfigPatch {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  /** Compaction summary model as `provider/id`; undefined follows the active session model. */
  model?: string;
  soft?: SoftCompactionConfigPatch;
}

export const COMPACTION_FIELDS = ["enabled", "reserveTokens", "keepRecentTokens", "model"] as const;

export type CompactionSettingSource = "project" | "user" | "default";

export interface EffectiveCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  /** Configured compaction model (`provider/id`); undefined follows the active session model. */
  model?: string;
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
    if (typeof c.model === "string" && c.model.trim().length > 0) patch.model = c.model.trim();
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
  const timeBased = readRawTimeBased(value.timeBased);
  if (timeBased) soft.timeBased = timeBased;
  const relevance = readRawRelevance(value.relevance);
  if (relevance) soft.relevance = relevance;
  const crossTurnDedup = readRawCrossTurnDedup(value.crossTurnDedup);
  if (crossTurnDedup) soft.crossTurnDedup = crossTurnDedup;
  const lossless = readRawLossless(value.lossless);
  if (lossless) soft.lossless = lossless;
  return Object.keys(soft).length > 0 ? soft : undefined;
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
  if (Array.isArray(value.minRatioRange)
    && value.minRatioRange.length === 2
    && value.minRatioRange.every((v) => typeof v === "number" && Number.isFinite(v))) {
    const [lo, hi] = value.minRatioRange as [number, number];
    if (lo >= 0 && hi <= 1 && lo < hi) cache.minRatioRange = [lo, hi];
  }
  return Object.keys(cache).length > 0 ? cache : undefined;
}

function readRawTimeBased(value: unknown): TimeBasedCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const timeBased: TimeBasedCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") timeBased.enabled = value.enabled;
  const minutes = positiveNumber(value.gapThresholdMinutes);
  if (minutes !== undefined) timeBased.gapThresholdMinutes = minutes;
  return Object.keys(timeBased).length > 0 ? timeBased : undefined;
}

function readRawRelevance(value: unknown): RelevanceCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const relevance: RelevanceCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") relevance.enabled = value.enabled;
  if (value.mode === "bm25" || value.mode === "keyword") relevance.mode = value.mode;
  return Object.keys(relevance).length > 0 ? relevance : undefined;
}

function readRawCrossTurnDedup(value: unknown): CrossTurnDedupConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const crossTurnDedup: CrossTurnDedupConfigPatch = {};
  if (typeof value.enabled === "boolean") crossTurnDedup.enabled = value.enabled;
  const minLines = positiveInt(value.minLines);
  if (minLines !== undefined) crossTurnDedup.minLines = minLines;
  const minChars = positiveInt(value.minChars);
  if (minChars !== undefined) crossTurnDedup.minChars = minChars;
  return Object.keys(crossTurnDedup).length > 0 ? crossTurnDedup : undefined;
}

function readRawLossless(value: unknown): LosslessCompactionConfigPatch | undefined {
  if (!isRecord(value)) return undefined;
  const lossless: LosslessCompactionConfigPatch = {};
  if (typeof value.enabled === "boolean") lossless.enabled = value.enabled;
  return Object.keys(lossless).length > 0 ? lossless : undefined;
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
    model: "default",
    soft: "default",
  };

  let enabled = true;
  let reserveTokens = DEFAULT_RESERVE_TOKENS;
  let keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
  let model: string | undefined;
  const soft: SoftCompactionSettings = createDefaultSoftCompaction();

  for (const [patch, src] of [[userPatch, "user"], [projectPatch, "project"]] as const) {
    if (patch.enabled !== undefined) { enabled = patch.enabled; source.enabled = src; }
    if (patch.reserveTokens !== undefined) { reserveTokens = patch.reserveTokens; source.reserveTokens = src; }
    if (patch.keepRecentTokens !== undefined) { keepRecentTokens = patch.keepRecentTokens; source.keepRecentTokens = src; }
    if (patch.model !== undefined) { model = patch.model; source.model = src; }
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
        if (patch.soft.cache.minRatioRange !== undefined) soft.cache.minRatioRange = patch.soft.cache.minRatioRange;
      }
      if (patch.soft.timeBased !== undefined) {
        const timeBased = soft.timeBased ?? (soft.timeBased = { enabled: false, gapThresholdMinutes: 60 });
        if (patch.soft.timeBased.enabled !== undefined) timeBased.enabled = patch.soft.timeBased.enabled;
        if (patch.soft.timeBased.gapThresholdMinutes !== undefined) timeBased.gapThresholdMinutes = patch.soft.timeBased.gapThresholdMinutes;
      }
      if (patch.soft.relevance !== undefined) {
        const relevance = soft.relevance ?? (soft.relevance = { enabled: false, mode: "bm25" });
        if (patch.soft.relevance.enabled !== undefined) relevance.enabled = patch.soft.relevance.enabled;
        if (patch.soft.relevance.mode !== undefined) relevance.mode = patch.soft.relevance.mode;
      }
      if (patch.soft.crossTurnDedup !== undefined) {
        const crossTurnDedup = soft.crossTurnDedup ?? (soft.crossTurnDedup = {
          enabled: false,
          minLines: DEFAULT_DEDUP_MIN_LINES,
          minChars: DEFAULT_DEDUP_MIN_CHARS,
        });
        if (patch.soft.crossTurnDedup.enabled !== undefined) crossTurnDedup.enabled = patch.soft.crossTurnDedup.enabled;
        if (patch.soft.crossTurnDedup.minLines !== undefined) crossTurnDedup.minLines = patch.soft.crossTurnDedup.minLines;
        if (patch.soft.crossTurnDedup.minChars !== undefined) crossTurnDedup.minChars = patch.soft.crossTurnDedup.minChars;
      }
      if (patch.soft.lossless !== undefined) {
        if (patch.soft.lossless.enabled !== undefined) soft.lossless.enabled = patch.soft.lossless.enabled;
      }
      source.soft = src;
    }
  }

  return { enabled, reserveTokens, keepRecentTokens, model, soft, source };
}

export function validateCompactionPatch(
  patch: CompactionConfigPatch,
  contextWindow?: number,
  modelMaxTokens?: number,
): CompactionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (patch.model !== undefined && (typeof patch.model !== "string" || !patch.model.includes("/"))) {
    errors.push(`model must be a "provider/id" reference`);
  }

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
      const threshold = contextWindow - effectiveReserveTokens({ reserveTokens: rt }, contextWindow, modelMaxTokens);
      const kr = patch.keepRecentTokens;
      if (kr !== undefined && kr >= threshold) {
        warnings.push(`keepRecentTokens (${kr}) >= thresholdTokens (${threshold}): little compressible history`);
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
    if (soft.cache?.minRatioRange !== undefined && !isValidMinRatioRange(soft.cache.minRatioRange)) {
      errors.push(`soft.cache.minRatioRange must be [lo, hi] with 0 <= lo < hi <= 1`);
    }
    if (soft.timeBased?.gapThresholdMinutes !== undefined
      && !isPositiveFiniteNumber(soft.timeBased.gapThresholdMinutes)) {
      errors.push(`soft.timeBased.gapThresholdMinutes must be a positive finite number`);
    }
    if (soft.relevance?.mode !== undefined
      && soft.relevance.mode !== "bm25" && soft.relevance.mode !== "keyword") {
      errors.push(`soft.relevance.mode must be "bm25" or "keyword"`);
    }
    if (soft.crossTurnDedup?.minLines !== undefined && !positiveInt(soft.crossTurnDedup.minLines)) {
      errors.push(`soft.crossTurnDedup.minLines must be a positive safe integer`);
    }
    if (soft.crossTurnDedup?.minChars !== undefined && !positiveInt(soft.crossTurnDedup.minChars)) {
      errors.push(`soft.crossTurnDedup.minChars must be a positive safe integer`);
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
  if (soft.cache.minRatioRange !== undefined && !isValidMinRatioRange(soft.cache.minRatioRange)) {
    errors.push(`soft.cache.minRatioRange must be [lo, hi] with 0 <= lo < hi <= 1`);
  }
  if (soft.timeBased?.gapThresholdMinutes !== undefined
    && !isPositiveFiniteNumber(soft.timeBased.gapThresholdMinutes)) {
    errors.push(`soft.timeBased.gapThresholdMinutes must be a positive finite number`);
  }
  if (soft.relevance?.mode !== undefined
    && soft.relevance.mode !== "bm25" && soft.relevance.mode !== "keyword") {
    errors.push(`soft.relevance.mode must be "bm25" or "keyword"`);
  }
  if (soft.crossTurnDedup?.minLines !== undefined && !positiveInt(soft.crossTurnDedup.minLines)) {
    errors.push(`soft.crossTurnDedup.minLines must be a positive safe integer`);
  }
  if (soft.crossTurnDedup?.minChars !== undefined && !positiveInt(soft.crossTurnDedup.minChars)) {
    errors.push(`soft.crossTurnDedup.minChars must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(settings.reserveTokens) || settings.reserveTokens <= 0) {
    errors.push(`reserveTokens must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(settings.keepRecentTokens) || settings.keepRecentTokens <= 0) {
    errors.push(`keepRecentTokens must be a positive safe integer`);
  }
  if (settings.model !== undefined && (typeof settings.model !== "string" || !settings.model.includes("/"))) {
    errors.push(`model must be a "provider/id" reference`);
  }
  return { errors, warnings: [] };
}

function isValidMinRatioRange(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === "number" && Number.isFinite(part))
    && value[0] >= 0
    && value[0] < value[1]
    && value[1] <= 1;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const writeQueues = new Map<string, Promise<void>>();

type CompactionSettingsFileOperations = {
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
};

const defaultFileOperations: CompactionSettingsFileOperations = { rename, unlink };
let fileOperations = defaultFileOperations;

/** Test only: inject filesystem failures into the atomic replacement protocol. */
export function setCompactionSettingsFileOperationsForTesting(
  overrides: Partial<CompactionSettingsFileOperations> | null,
): () => void {
  const previous = fileOperations;
  fileOperations = overrides ? { ...defaultFileOperations, ...overrides } : defaultFileOperations;
  return () => { fileOperations = previous; };
}

function replacementBackupPath(path: string): string {
  return `${path}.backup`;
}

async function recoverSettingsReplacement(path: string): Promise<void> {
  const backupPath = replacementBackupPath(path);
  if (!existsSync(backupPath)) return;
  if (existsSync(path)) {
    await fileOperations.unlink(backupPath);
    return;
  }
  try {
    await fileOperations.rename(backupPath, path);
  } catch (error) {
    throw new Error(`Cannot recover interrupted settings replacement for ${path}`, { cause: error });
  }
}

function enqueueWrite(path: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const release = await lockSettingsResource(path);
    try {
      await recoverSettingsReplacement(path);
      await fn();
    } finally { await release(); }
  });
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
  if (result.reserveTokens !== undefined) hard.reserveTokens = result.reserveTokens;
  if (result.keepRecentTokens !== undefined) hard.keepRecentTokens = result.keepRecentTokens;
  if (Object.keys(hard).length > 0) result.hard = hard;
  return result;
}

async function patchSettingsFile(path: string, patch: CompactionConfigPatch): Promise<void> {
  const root = readJsonRoot(path);
  const compaction = normalizeCompactionRecord(isRecord(root.compaction) ? { ...root.compaction } : {});
  if (patch.enabled !== undefined) compaction.enabled = patch.enabled;
  if (patch.model !== undefined) compaction.model = patch.model;
  if (patch.reserveTokens !== undefined || patch.keepRecentTokens !== undefined) {
    const hard = isRecord(compaction.hard) ? { ...compaction.hard } : {};
    if (patch.reserveTokens !== undefined) {
      hard.reserveTokens = patch.reserveTokens;
      compaction.reserveTokens = patch.reserveTokens;
    }
    if (patch.keepRecentTokens !== undefined) {
      hard.keepRecentTokens = patch.keepRecentTokens;
      compaction.keepRecentTokens = patch.keepRecentTokens;
    }
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
  if (values.model === undefined) delete compaction.model;
  else compaction.model = values.model;
  // Native compact routing was removed; clear any stale setting on save.
  delete compaction.endpoint;
  const hard = isRecord(compaction.hard) ? { ...compaction.hard } : {};
  if (values.reserveTokens === undefined) {
    delete hard.reserveTokens;
    delete compaction.reserveTokens;
  } else {
    hard.reserveTokens = values.reserveTokens;
    compaction.reserveTokens = values.reserveTokens;
  }
  if (values.keepRecentTokens === undefined) {
    delete hard.keepRecentTokens;
    delete compaction.keepRecentTokens;
  } else {
    hard.keepRecentTokens = values.keepRecentTokens;
    compaction.keepRecentTokens = values.keepRecentTokens;
  }
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
  const backupPath = replacementBackupPath(path);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fileOperations.rename(temporaryPath, path);
    return;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(code)) {
      await fileOperations.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  try {
    await fileOperations.rename(path, backupPath);
  } catch (error) {
    await fileOperations.unlink(temporaryPath).catch(() => undefined);
    throw new Error(`Cannot preserve existing settings before replacing ${path}`, { cause: error });
  }

  try {
    await fileOperations.rename(temporaryPath, path);
  } catch (replacementError) {
    let recoveryError: unknown;
    try {
      await fileOperations.rename(backupPath, path);
    } catch (error) {
      recoveryError = error;
    }
    await fileOperations.unlink(temporaryPath).catch(() => undefined);
    if (recoveryError) {
      throw new AggregateError(
        [replacementError, recoveryError],
        `Settings replacement failed and the previous settings remain recoverable at ${backupPath}`,
      );
    }
    throw replacementError;
  }

  await fileOperations.unlink(backupPath);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
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

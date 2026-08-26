import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ProviderKey =
  | "codex"
  | "claude"
  | "zai"
  | "zai-cn"
  | "kimi"
  | "minimax"
  | "minimax-cn"
  | "openrouter"
  | "deepseek"
  | "moonshot"
  | "moonshot-cn";
export type PiProviderId =
  | "openai-codex"
  | "anthropic"
  | "zai"
  | "zai-coding-cn"
  | "kimi-coding"
  | "minimax"
  | "minimax-cn"
  | "openrouter"
  | "deepseek"
  | "moonshotai"
  | "moonshotai-cn";

export interface AccountBalance {
  amount: number;
  unit: string;
  label: string;
}

export interface AccountSpend {
  unit: string;
  daily?: number;
  weekly?: number;
  monthly?: number;
  lifetime?: number;
}

export interface UsageData {
  session: number;
  weekly: number;
  quotaHidden?: boolean;
  accountBalance?: AccountBalance;
  accountBalanceDetails?: AccountBalance[];
  accountSpend?: AccountSpend;
  sessionResetsIn?: string;
  weeklyResetsIn?: string;
  sessionResetsAt?: string;
  weeklyResetsAt?: string;
  extraSpend?: number;
  extraLimit?: number;
  sessionLabel?: string;
  weeklyLabel?: string;
  sessionHidden?: boolean;
  weeklyHidden?: boolean;
  notice?: string;
  warning?: string;
  stale?: boolean;
  fetchedAt?: number;
  error?: string;
}

export type UsageByProvider = Record<ProviderKey, UsageData | null>;
export type UsageTokens = Partial<Record<ProviderKey, string>>;

export interface UsageEndpoints {
  zai: string;
  zaiCn: string;
  kimi: string;
  minimax: string;
  minimaxLegacy: string;
  minimaxCn: string;
  minimaxCnLegacy: string;
  openRouterCredits: string;
  openRouterKey: string;
  deepSeekBalance: string;
  moonshotBalance: string;
  moonshotCnBalance: string;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: HeadersLike;
  json(): Promise<unknown>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface RequestConfig {
  fetchFn?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchConfig extends RequestConfig {
  endpoints?: UsageEndpoints;
  env?: NodeJS.ProcessEnv;
}

export interface FetchAllUsagesConfig extends FetchConfig {
  cacheFile?: string;
  nowMs?: number;
}

export interface ClaudeUsageFetchConfig extends RequestConfig {
  cacheFile?: string;
  nowMs?: number;
}

interface JsonRequestSuccess {
  ok: true;
  data: unknown;
  status: number;
  headers?: HeadersLike;
}

interface JsonRequestError {
  ok: false;
  error: string;
  status: number | null;
  headers?: HeadersLike;
}

type JsonRequestResult = JsonRequestSuccess | JsonRequestError;

interface ClaudeUsageAttemptResult {
  usage: UsageData;
  status: number | null;
  retryAfterMs: number | null;
}

interface ClaudeUsageCacheState {
  lastSuccess?: UsageData;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  consecutive429s?: number;
  lastError?: string;
}

interface UsageBarsCacheFile {
  version: 1;
  claude?: ClaudeUsageCacheState;
}

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const CLAUDE_SHARED_FRESH_TTL_MS = 2 * 60 * 1000;
const CLAUDE_BASE_BACKOFF_MS = 2 * 60 * 1000;
const CLAUDE_MAX_BACKOFF_MS = 30 * 60 * 1000;
const CLAUDE_LOCK_WAIT_MS = 4_000;
const CLAUDE_LOCK_POLL_MS = 125;
const CLAUDE_LOCK_STALE_MS = 20_000;

export const DEFAULT_USAGE_CACHE_FILE = path.join(os.tmpdir(), "pi", "usage-bars-cache.json");
export const DEFAULT_ZAI_USAGE_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
export const DEFAULT_ZAI_CN_USAGE_ENDPOINT = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
export const DEFAULT_KIMI_USAGE_ENDPOINT = "https://api.kimi.com/coding/v1/usages";
export const DEFAULT_MINIMAX_USAGE_ENDPOINT = "https://api.minimax.io/v1/token_plan/remains";
export const DEFAULT_MINIMAX_LEGACY_USAGE_ENDPOINT = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
export const DEFAULT_MINIMAX_CN_USAGE_ENDPOINT = "https://api.minimaxi.com/v1/token_plan/remains";
export const DEFAULT_MINIMAX_CN_LEGACY_USAGE_ENDPOINT = "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains";
export const DEFAULT_OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";
export const DEFAULT_OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
export const DEFAULT_DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance";
export const DEFAULT_MOONSHOT_BALANCE_ENDPOINT = "https://api.moonshot.ai/v1/users/me/balance";
export const DEFAULT_MOONSHOT_CN_BALANCE_ENDPOINT = "https://api.moonshot.cn/v1/users/me/balance";

export function resolveUsageEndpoints(env: NodeJS.ProcessEnv = process.env): UsageEndpoints {
  const configured = (value: string | undefined, fallback: string) => {
    const trimmed = value?.trim();
    return trimmed || fallback;
  };

  return {
    zai: configured(env.PI_ZAI_USAGE_ENDPOINT, DEFAULT_ZAI_USAGE_ENDPOINT),
    zaiCn: configured(env.PI_ZAI_CODING_CN_USAGE_ENDPOINT, DEFAULT_ZAI_CN_USAGE_ENDPOINT),
    kimi: configured(env.PI_KIMI_USAGE_ENDPOINT, DEFAULT_KIMI_USAGE_ENDPOINT),
    minimax: configured(env.PI_MINIMAX_USAGE_ENDPOINT, DEFAULT_MINIMAX_USAGE_ENDPOINT),
    minimaxLegacy: configured(env.PI_MINIMAX_LEGACY_USAGE_ENDPOINT, DEFAULT_MINIMAX_LEGACY_USAGE_ENDPOINT),
    minimaxCn: configured(env.PI_MINIMAX_CN_USAGE_ENDPOINT, DEFAULT_MINIMAX_CN_USAGE_ENDPOINT),
    minimaxCnLegacy: configured(env.PI_MINIMAX_CN_LEGACY_USAGE_ENDPOINT, DEFAULT_MINIMAX_CN_LEGACY_USAGE_ENDPOINT),
    openRouterCredits: configured(env.PI_OPENROUTER_CREDITS_ENDPOINT, DEFAULT_OPENROUTER_CREDITS_ENDPOINT),
    openRouterKey: configured(env.PI_OPENROUTER_KEY_ENDPOINT, DEFAULT_OPENROUTER_KEY_ENDPOINT),
    deepSeekBalance: configured(env.PI_DEEPSEEK_BALANCE_ENDPOINT, DEFAULT_DEEPSEEK_BALANCE_ENDPOINT),
    moonshotBalance: configured(env.PI_MOONSHOT_BALANCE_ENDPOINT, DEFAULT_MOONSHOT_BALANCE_ENDPOINT),
    moonshotCnBalance: configured(env.PI_MOONSHOT_CN_BALANCE_ENDPOINT, DEFAULT_MOONSHOT_CN_BALANCE_ENDPOINT),
  };
}

function toErrorMessage(error: unknown, externalSignal?: AbortSignal): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return externalSignal?.aborted ? "request cancelled" : "request timeout";
    }
    return error.message || String(error);
  }
  return String(error);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function normalizeUsagePair(session: number, weekly: number): { session: number; weekly: number } {
  const clean = (value: number) => Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
  return { session: clean(session), weekly: clean(weekly) };
}

function getHeader(headers: HeadersLike | undefined, name: string): string | null {
  if (!headers) return null;
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

function combineSignals(timeoutSignal: AbortSignal | undefined, externalSignal: AbortSignal | undefined): AbortSignal | undefined {
  if (timeoutSignal && externalSignal) return AbortSignal.any([timeoutSignal, externalSignal]);
  return timeoutSignal ?? externalSignal;
}

async function requestJson(url: string, init: RequestInit, config: RequestConfig = {}): Promise<JsonRequestResult> {
  const fetchFn = config.fetchFn ?? (fetch as unknown as FetchLike);
  const timeoutMs = config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const timeoutController = timeoutMs > 0 ? new AbortController() : undefined;
  const timeout = timeoutController
    ? setTimeout(() => timeoutController.abort(), timeoutMs)
    : undefined;
  const signal = combineSignals(timeoutController?.signal, config.signal);

  try {
    if (config.signal?.aborted) {
      return { ok: false, error: "request cancelled", status: null };
    }

    const response = await fetchFn(url, { ...init, signal });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status, headers: response.headers };
    }

    try {
      return { ok: true, data: await response.json(), status: response.status, headers: response.headers };
    } catch {
      return { ok: false, error: "invalid JSON response", status: response.status, headers: response.headers };
    }
  } catch (error) {
    return { ok: false, error: toErrorMessage(error, config.signal), status: null };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

export function formatResetsAt(isoDate: string, nowMs = Date.now()): string {
  const resetTime = new Date(isoDate).getTime();
  if (!Number.isFinite(resetTime)) return "";
  return formatDuration(Math.max(0, resetTime - nowMs) / 1000);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1000;
  const dateMs = new Date(value).getTime();
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

function readUsageCache(cacheFile = DEFAULT_USAGE_CACHE_FILE): UsageBarsCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    if (parsed?.version === 1 && typeof parsed === "object") return parsed as UsageBarsCacheFile;
  } catch {
    // Invalid or missing caches are treated as empty.
  }
  return { version: 1 };
}

function writeUsageCache(cache: UsageBarsCacheFile, cacheFile = DEFAULT_USAGE_CACHE_FILE): boolean {
  try {
    const directory = path.dirname(cacheFile);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, cacheFile);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function ensureParentDir(filePath: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup races.
  }
}

async function acquireFileLock(lockFile: string, signal?: AbortSignal): Promise<(() => void) | null> {
  ensureParentDir(lockFile);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= CLAUDE_LOCK_WAIT_MS) {
    if (signal?.aborted) return null;
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      fs.closeSync(fd);
      return () => safeUnlink(lockFile);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs >= CLAUDE_LOCK_STALE_MS) {
          safeUnlink(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      try {
        await sleep(CLAUDE_LOCK_POLL_MS, signal);
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function readPercentCandidate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return Number.isInteger(value) ? value : value * 100;
  return value >= 0 && value <= 100 ? value : null;
}

export function readLimitPercent(limit: unknown): number | null {
  const value = asObject(limit);
  const direct = [
    value?.percentage,
    value?.utilization,
    value?.used_percent,
    value?.usedPercent,
    value?.usagePercent,
    value?.usage_percent,
  ].map(readPercentCandidate).find((candidate) => candidate !== null);
  if (direct !== undefined) return direct;

  const current = typeof value?.currentValue === "number" ? value.currentValue : null;
  const remaining = typeof value?.remaining === "number" ? value.remaining : null;
  if (current !== null && remaining !== null && current + remaining > 0) {
    return (current / (current + remaining)) * 100;
  }
  return null;
}

export function extractUsageFromPayload(payload: unknown): { session: number; weekly: number } | null {
  const data = payload as any;
  const limitArrays = [data?.data?.limits, data?.limits, data?.quota?.limits, data?.data?.quota?.limits];
  const limits = limitArrays.find(Array.isArray) as unknown[] | undefined;

  if (limits) {
    const byType = (types: string[]) => limits.find((entry) => {
      const type = String((entry as any)?.type || "").toUpperCase();
      return types.includes(type);
    });
    const session = readLimitPercent(byType(["TIME_LIMIT", "SESSION_LIMIT", "REQUEST_LIMIT", "RPM_LIMIT", "RPD_LIMIT"]));
    const weekly = readLimitPercent(byType(["TOKENS_LIMIT", "TOKEN_LIMIT", "WEEK_LIMIT", "WEEKLY_LIMIT", "TPM_LIMIT", "DAILY_LIMIT"]));
    if (session !== null && weekly !== null) return normalizeUsagePair(session, weekly);
  }

  const sessionCandidates = [
    data?.session,
    data?.sessionPercent,
    data?.session_percent,
    data?.five_hour?.utilization,
    data?.rate_limit?.primary_window?.used_percent,
    data?.limits?.session?.utilization,
    data?.usage?.session,
    data?.data?.session,
    data?.data?.sessionPercent,
    data?.data?.session_percent,
    data?.data?.usage?.session,
    data?.quota?.session?.percentage,
    data?.data?.quota?.session?.percentage,
  ];
  const weeklyCandidates = [
    data?.weekly,
    data?.weeklyPercent,
    data?.weekly_percent,
    data?.seven_day?.utilization,
    data?.rate_limit?.secondary_window?.used_percent,
    data?.limits?.weekly?.utilization,
    data?.usage?.weekly,
    data?.data?.weekly,
    data?.data?.weeklyPercent,
    data?.data?.weekly_percent,
    data?.data?.usage?.weekly,
    data?.quota?.weekly?.percentage,
    data?.data?.quota?.weekly?.percentage,
    data?.quota?.daily?.percentage,
    data?.data?.quota?.daily?.percentage,
  ];

  const session = sessionCandidates.map(readPercentCandidate).find((candidate) => candidate !== null);
  const weekly = weeklyCandidates.map(readPercentCandidate).find((candidate) => candidate !== null);
  return session === undefined || weekly === undefined ? null : normalizeUsagePair(session, weekly);
}

function hydrateUsageResets(usage: UsageData, nowMs = Date.now()): UsageData {
  return {
    ...usage,
    sessionResetsIn: usage.sessionResetsAt ? formatResetsAt(usage.sessionResetsAt, nowMs) : usage.sessionResetsIn,
    weeklyResetsIn: usage.weeklyResetsAt ? formatResetsAt(usage.weeklyResetsAt, nowMs) : usage.weeklyResetsIn,
  };
}

function snapshotUsage(usage: UsageData, nowMs = Date.now()): UsageData {
  return {
    session: usage.session,
    weekly: usage.weekly,
    quotaHidden: usage.quotaHidden,
    accountBalance: usage.accountBalance,
    accountBalanceDetails: usage.accountBalanceDetails,
    accountSpend: usage.accountSpend,
    sessionResetsAt: usage.sessionResetsAt,
    weeklyResetsAt: usage.weeklyResetsAt,
    sessionResetsIn: usage.sessionResetsIn,
    weeklyResetsIn: usage.weeklyResetsIn,
    extraSpend: usage.extraSpend,
    extraLimit: usage.extraLimit,
    sessionLabel: usage.sessionLabel,
    weeklyLabel: usage.weeklyLabel,
    sessionHidden: usage.sessionHidden,
    weeklyHidden: usage.weeklyHidden,
    notice: usage.notice,
    fetchedAt: usage.fetchedAt ?? nowMs,
  };
}

function staleCachedUsage(cached: UsageData, warning: string, nowMs = Date.now()): UsageData {
  return { ...hydrateUsageResets(snapshotUsage(cached, nowMs), nowMs), stale: true, warning };
}

function readClaudeCacheState(cacheFile = DEFAULT_USAGE_CACHE_FILE): ClaudeUsageCacheState {
  return readUsageCache(cacheFile).claude ?? {};
}

function writeClaudeCacheState(state: ClaudeUsageCacheState, cacheFile = DEFAULT_USAGE_CACHE_FILE): boolean {
  const cache = readUsageCache(cacheFile);
  cache.claude = state;
  return writeUsageCache(cache, cacheFile);
}

function clearClaudeCooldown(state: ClaudeUsageCacheState): ClaudeUsageCacheState {
  return { ...state, cooldownUntil: undefined, consecutive429s: 0, lastError: undefined };
}

function computeClaudeBackoffMs(state: ClaudeUsageCacheState, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(CLAUDE_MAX_BACKOFF_MS, Math.max(CLAUDE_BASE_BACKOFF_MS, retryAfterMs));
  }
  const count = Math.max(1, state.consecutive429s ?? 0);
  return Math.min(CLAUDE_MAX_BACKOFF_MS, CLAUDE_BASE_BACKOFF_MS * 2 ** Math.max(0, count - 1));
}

function cooldownMessage(untilMs: number, nowMs = Date.now()): string {
  return `rate limited; retry in ${formatDuration(Math.max(0, untilMs - nowMs) / 1000)}`;
}

function readClaudeCacheOutcome(cacheFile = DEFAULT_USAGE_CACHE_FILE, nowMs = Date.now()): UsageData | null {
  const state = readClaudeCacheState(cacheFile);
  if (state.cooldownUntil && state.cooldownUntil > nowMs) {
    const warning = cooldownMessage(state.cooldownUntil, nowMs);
    return state.lastSuccess
      ? staleCachedUsage(state.lastSuccess, warning, nowMs)
      : { session: 0, weekly: 0, error: warning };
  }
  if (state.lastSuccess && state.lastSuccessAt && nowMs - state.lastSuccessAt <= CLAUDE_SHARED_FRESH_TTL_MS) {
    return hydrateUsageResets(snapshotUsage(state.lastSuccess, state.lastSuccessAt), nowMs);
  }
  return null;
}

export function parseCodexRateLimit(data: any): UsageData {
  const rateLimit = data?.rate_limit ?? data?.rate_limits;
  const primary = rateLimit?.primary_window ?? rateLimit?.primary ?? rateLimit?.five_hour;
  const secondary = rateLimit?.secondary_window ?? rateLimit?.secondary ?? rateLimit?.weekly;

  let sessionWindow: any = null;
  let weeklyWindow: any = null;
  for (const [position, window] of [["primary", primary], ["secondary", secondary]] as const) {
    if (!window || typeof window !== "object") continue;
    const duration = window.limit_window_seconds;
    if (typeof duration === "number" && Number.isFinite(duration)) {
      // Some Codex accounts return their seven-day quota as primary_window
      // and omit secondary_window, so position alone does not identify it.
      if (duration >= 2 * 24 * 60 * 60) weeklyWindow ??= window;
      else sessionWindow ??= window;
    } else if (position === "primary") {
      sessionWindow ??= window;
    } else {
      weeklyWindow ??= window;
    }
  }

  const reset = (window: any) =>
    typeof window?.reset_after_seconds === "number" ? formatDuration(window.reset_after_seconds) : undefined;

  return {
    session: readPercentCandidate(sessionWindow?.used_percent) ?? 0,
    weekly: readPercentCandidate(weeklyWindow?.used_percent) ?? 0,
    ...(!sessionWindow ? { sessionHidden: true } : {}),
    ...(!weeklyWindow ? { weeklyHidden: true } : {}),
    sessionResetsIn: reset(sessionWindow),
    weeklyResetsIn: reset(weeklyWindow),
  };
}

export async function fetchCodexUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  const result = await requestJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { headers: { Authorization: `Bearer ${token}` } },
    config,
  );
  if (!result.ok) return { session: 0, weekly: 0, error: result.error };
  return parseCodexRateLimit(result.data);
}

async function fetchClaudeUsageAttempt(
  token: string,
  config: RequestConfig = {},
  nowMs = Date.now(),
): Promise<ClaudeUsageAttemptResult> {
  const result = await requestJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    config,
  );
  const retryAfterMs = parseRetryAfterMs(getHeader(result.headers, "retry-after"), nowMs);
  if (!result.ok) {
    return { usage: { session: 0, weekly: 0, error: result.error }, status: result.status, retryAfterMs };
  }

  const data = result.data as any;
  const usage: UsageData = hydrateUsageResets({
    session: readPercentCandidate(data?.five_hour?.utilization) ?? 0,
    weekly: readPercentCandidate(data?.seven_day?.utilization) ?? 0,
    sessionResetsAt: typeof data?.five_hour?.resets_at === "string" ? data.five_hour.resets_at : undefined,
    weeklyResetsAt: typeof data?.seven_day?.resets_at === "string" ? data.seven_day.resets_at : undefined,
    fetchedAt: nowMs,
  }, nowMs);

  if (data?.extra_usage?.is_enabled) {
    usage.extraSpend = typeof data.extra_usage.used_credits === "number" ? data.extra_usage.used_credits : undefined;
    usage.extraLimit = typeof data.extra_usage.monthly_limit === "number" ? data.extra_usage.monthly_limit : undefined;
  }
  return { usage, status: result.status, retryAfterMs };
}

export async function fetchClaudeUsage(token: string, config: RequestConfig = {}): Promise<UsageData> {
  return (await fetchClaudeUsageAttempt(token, config)).usage;
}

export async function fetchClaudeUsageWithFallback(
  token: string,
  config: ClaudeUsageFetchConfig = {},
): Promise<UsageData> {
  const cacheFile = config.cacheFile ?? DEFAULT_USAGE_CACHE_FILE;
  const nowMs = config.nowMs ?? Date.now();
  const cachedOutcome = readClaudeCacheOutcome(cacheFile, nowMs);
  if (cachedOutcome) return cachedOutcome;
  if (config.signal?.aborted) return { session: 0, weekly: 0, error: "request cancelled" };

  const lockFile = `${cacheFile}.claude.lock`;
  const releaseLock = await acquireFileLock(lockFile, config.signal);
  if (!releaseLock) {
    const waitedOutcome = readClaudeCacheOutcome(cacheFile, nowMs);
    if (waitedOutcome) return waitedOutcome;
    if (config.signal?.aborted) return { session: 0, weekly: 0, error: "request cancelled" };
  }

  try {
    const lockOutcome = readClaudeCacheOutcome(cacheFile, nowMs);
    if (lockOutcome) return lockOutcome;

    let state = readClaudeCacheState(cacheFile);
    const attempt = await fetchClaudeUsageAttempt(token, config, nowMs);
    if (!attempt.usage.error) {
      state = clearClaudeCooldown(state);
      state.lastSuccess = snapshotUsage(attempt.usage, nowMs);
      state.lastSuccessAt = nowMs;
      writeClaudeCacheState(state, cacheFile);
      return attempt.usage;
    }

    if (attempt.status === 429) {
      const consecutive429s = Math.max(1, (state.consecutive429s ?? 0) + 1);
      const cooldownUntil = nowMs + computeClaudeBackoffMs({ ...state, consecutive429s }, attempt.retryAfterMs);
      state = { ...state, cooldownUntil, consecutive429s, lastError: attempt.usage.error };
      writeClaudeCacheState(state, cacheFile);
      return state.lastSuccess
        ? staleCachedUsage(state.lastSuccess, cooldownMessage(cooldownUntil, nowMs), nowMs)
        : { session: 0, weekly: 0, error: `${attempt.usage.error}; ${cooldownMessage(cooldownUntil, nowMs)}` };
    }

    return attempt.usage;
  } finally {
    releaseLock?.();
  }
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function usedPercentFromCounts(
  value: Record<string, unknown> | null | undefined,
  options: { remainingPercent?: string; used?: string; total?: string; remaining?: string } = {},
): number | null {
  if (!value) return null;
  const remainingPercent = readNumber(value[options.remainingPercent ?? "remaining_percent"]);
  if (remainingPercent !== null) return Math.max(0, Math.min(100, 100 - remainingPercent));

  const total = readNumber(value[options.total ?? "limit"]);
  const used = readNumber(value[options.used ?? "used"]);
  const remaining = readNumber(value[options.remaining ?? "remaining"]);
  if (total === null || total <= 0) return null;
  if (used !== null) return Math.max(0, Math.min(100, used / total * 100));
  if (remaining !== null) return Math.max(0, Math.min(100, (total - remaining) / total * 100));
  return null;
}

function normalizeIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().replace(/(\.\d{3})\d+(?=Z|[+-]\d\d:\d\d$)/, "$1");
  return Number.isFinite(new Date(normalized).getTime()) ? normalized : undefined;
}

function isoFromEpoch(value: unknown): string | undefined {
  const raw = readNumber(value);
  if (raw === null || raw <= 0) return undefined;
  const milliseconds = raw > 1_000_000_000_000 ? raw : raw * 1000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function resetFromRemains(value: unknown, nowMs: number): string | undefined {
  const raw = readNumber(value);
  if (raw === null || raw <= 0) return undefined;
  const milliseconds = raw > 1_000_000 ? raw : raw * 1000;
  return new Date(nowMs + milliseconds).toISOString();
}

export function extractKimiUsageFromPayload(payload: unknown, nowMs = Date.now()): UsageData | null {
  const root = asObject(payload);
  if (!root) return null;
  const webUsages = Array.isArray(root.usages) ? root.usages : undefined;
  const codingUsage = webUsages?.map(asObject).find((entry) =>
    String(entry?.scope ?? "").toUpperCase() === "FEATURE_CODING") ?? root;
  const dataRows = Array.isArray(codingUsage.data) ? codingUsage.data.map(asObject).filter(Boolean) : [];
  const usage = asObject(codingUsage.usage) ?? asObject(codingUsage.detail) ??
    dataRows.find((entry) => String(entry?.model_name ?? entry?.modelName ?? "").toLowerCase() === "all");
  const limits = Array.isArray(codingUsage.limits)
    ? codingUsage.limits
    : dataRows.filter((entry) => entry !== usage);
  const sessionLimit = limits.map(asObject).find((entry) => {
    const window = asObject(entry?.window);
    const duration = readNumber(window?.duration);
    const unit = String(window?.timeUnit ?? window?.time_unit ?? "").toUpperCase();
    return duration === 300 && unit.includes("MINUTE");
  }) ?? limits.map(asObject).find((entry) => entry !== null);
  const sessionDetail = asObject(sessionLimit?.detail) ?? sessionLimit;

  const session = usedPercentFromCounts(sessionDetail);
  const weekly = usedPercentFromCounts(usage);
  if (session === null || weekly === null) return null;

  const sessionReset = normalizeIsoDate(sessionDetail?.resetTime ?? sessionDetail?.reset_at ?? sessionDetail?.reset_time);
  const weeklyReset = normalizeIsoDate(usage?.resetTime ?? usage?.reset_at ?? usage?.reset_time);
  return hydrateUsageResets({
    ...normalizeUsagePair(session, weekly),
    sessionLabel: "5-hour",
    weeklyLabel: "Weekly",
    sessionResetsAt: sessionReset,
    weeklyResetsAt: weeklyReset,
  }, nowMs);
}

export async function fetchKimiUsage(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const result = await requestJson(endpoints.kimi, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "KimiCLI/1.5",
    },
  }, config);
  if (!result.ok) return { session: 0, weekly: 0, error: result.error };
  return extractKimiUsageFromPayload(result.data) ?? {
    session: 0,
    weekly: 0,
    error: "unrecognized response shape",
  };
}

interface MiniMaxWindow {
  percent: number;
  resetsAt?: string;
}

function pickHighestWindow(windows: MiniMaxWindow[]): MiniMaxWindow | undefined {
  return windows.reduce<MiniMaxWindow | undefined>((highest, window) =>
    !highest || window.percent > highest.percent ? window : highest, undefined);
}

function miniMaxResetAt(value: Record<string, unknown>, prefix: "current" | "weekly", nowMs: number): string | undefined {
  const end = prefix === "current"
    ? value.end_time ?? value.endTime
    : value.weekly_end_time ?? value.weeklyEndTime;
  const remains = prefix === "current"
    ? value.remains_time ?? value.remainsTime
    : value.weekly_remains_time ?? value.weeklyRemainsTime;
  const resetsAt = prefix === "current"
    ? value.current_resets_at ?? value.currentResetsAt
    : value.weekly_resets_at ?? value.weeklyResetsAt;
  return normalizeIsoDate(resetsAt) ?? isoFromEpoch(end) ?? resetFromRemains(remains, nowMs);
}

function extractMiniMaxCreditBalance(payload: unknown): AccountBalance | undefined {
  const root = asObject(payload);
  const data = asObject(root?.data) ?? root;
  if (!data) return undefined;
  const amount = readNumber(
    data.points_balance ?? data.pointsBalance ??
    data.point_balance ?? data.pointBalance ??
    data.credits_balance ?? data.creditsBalance ??
    data.credit_balance ?? data.creditBalance,
  );
  return amount === null ? undefined : { amount, unit: "credits", label: "Credit balance" };
}

export function extractMiniMaxUsageFromPayload(payload: unknown, nowMs = Date.now()): UsageData | null {
  const root = asObject(payload);
  const data = asObject(root?.data) ?? root;
  if (!data) return null;
  const accountBalance = extractMiniMaxCreditBalance(payload);

  const intervalWindows: MiniMaxWindow[] = [];
  const weeklyWindows: MiniMaxWindow[] = [];
  if (Array.isArray(data.services)) {
    for (const rawService of data.services) {
      const service = asObject(rawService);
      if (!service) continue;
      const directPercent = readPercentCandidate(readNumber(service.percent));
      const percent = directPercent ?? usedPercentFromCounts(service, { total: "limit", used: "usage" });
      if (percent === null) continue;
      const windowType = String(service.window_type ?? service.windowType ?? "").toLowerCase();
      const resetsAt = normalizeIsoDate(service.resets_at ?? service.reset_time ?? service.end_time);
      (windowType.includes("week") ? weeklyWindows : intervalWindows).push({ percent, resetsAt });
    }
  }

  if (Array.isArray(data.model_remains ?? data.modelRemains)) {
    for (const rawModel of (data.model_remains ?? data.modelRemains) as unknown[]) {
      const raw = asObject(rawModel);
      if (!raw) continue;
      const model: Record<string, unknown> = {
        ...raw,
        current_interval_remaining_percent:
          raw.current_interval_remaining_percent ?? raw.currentIntervalRemainingPercent,
        current_interval_total_count: raw.current_interval_total_count ?? raw.currentIntervalTotalCount,
        current_interval_usage_count: raw.current_interval_usage_count ?? raw.currentIntervalUsageCount,
        current_interval_status: raw.current_interval_status ?? raw.currentIntervalStatus,
        current_weekly_remaining_percent:
          raw.current_weekly_remaining_percent ?? raw.currentWeeklyRemainingPercent,
        current_weekly_total_count: raw.current_weekly_total_count ?? raw.currentWeeklyTotalCount,
        current_weekly_usage_count: raw.current_weekly_usage_count ?? raw.currentWeeklyUsageCount,
        current_weekly_status: raw.current_weekly_status ?? raw.currentWeeklyStatus,
      };
      const unavailable = (prefix: "interval" | "weekly") =>
        readNumber(model[`current_${prefix}_status`]) === 3 &&
        (readNumber(model[`current_${prefix}_remaining_percent`]) ?? 0) >= 100 &&
        (readNumber(model[`current_${prefix}_total_count`]) ?? 0) === 0 &&
        (readNumber(model[`current_${prefix}_usage_count`]) ?? 0) === 0;
      const interval = unavailable("interval") ? null : usedPercentFromCounts(model, {
        remainingPercent: "current_interval_remaining_percent",
        total: "current_interval_total_count",
        remaining: "current_interval_usage_count",
      });
      if (interval !== null) {
        intervalWindows.push({ percent: interval, resetsAt: miniMaxResetAt(model, "current", nowMs) });
      }
      const weekly = unavailable("weekly") ? null : usedPercentFromCounts(model, {
        remainingPercent: "current_weekly_remaining_percent",
        total: "current_weekly_total_count",
        remaining: "current_weekly_usage_count",
      });
      if (weekly !== null) {
        weeklyWindows.push({ percent: weekly, resetsAt: miniMaxResetAt(model, "weekly", nowMs) });
      }
    }
  }

  const session = pickHighestWindow(intervalWindows);
  const weekly = pickHighestWindow(weeklyWindows);
  if (!session) {
    return accountBalance
      ? { session: 0, weekly: 0, quotaHidden: true, accountBalance }
      : null;
  }
  return hydrateUsageResets({
    session: Number(session.percent.toFixed(2)),
    accountBalance,
    weekly: Number((weekly?.percent ?? 0).toFixed(2)),
    sessionLabel: "Interval",
    weeklyLabel: "Weekly",
    weeklyHidden: !weekly,
    sessionResetsAt: session.resetsAt,
    weeklyResetsAt: weekly?.resetsAt,
  }, nowMs);
}

function miniMaxPayloadStatus(payload: unknown): number | null {
  const root = asObject(payload);
  const data = asObject(root?.data);
  const baseResponse = asObject(data?.base_resp ?? data?.baseResp ?? root?.base_resp ?? root?.baseResp);
  return readNumber(baseResponse?.status_code ?? baseResponse?.statusCode);
}

function miniMaxPayloadError(payload: unknown): string | null {
  const root = asObject(payload);
  const data = asObject(root?.data);
  const baseResponse = asObject(data?.base_resp ?? data?.baseResp ?? root?.base_resp ?? root?.baseResp);
  const status = miniMaxPayloadStatus(payload);
  if (status === null || status === 0) return null;
  const message = baseResponse?.status_msg ?? baseResponse?.statusMessage;
  return typeof message === "string" && message.trim()
    ? `API ${status}: ${message.trim()}`
    : `API ${status}`;
}

export async function fetchMiniMaxUsage(
  token: string,
  provider: "minimax" | "minimax-cn" = "minimax",
  config: FetchConfig = {},
): Promise<UsageData> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const candidates = provider === "minimax-cn"
    ? [endpoints.minimaxCn, endpoints.minimaxCnLegacy]
    : [endpoints.minimax, endpoints.minimaxLegacy];
  let lastError = "usage request failed";
  let credentialError: string | undefined;
  let noActiveTokenPlan = false;

  for (const endpoint of [...new Set(candidates)]) {
    const result = await requestJson(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }, config);
    if (!result.ok) {
      lastError = result.error;
      if (result.status === 401 || result.status === 403) credentialError ??= result.error;
      if (config.signal?.aborted) break;
      continue;
    }
    const payloadStatus = miniMaxPayloadStatus(result.data);
    const payloadError = miniMaxPayloadError(result.data);
    const usage = extractMiniMaxUsageFromPayload(result.data);
    if (usage && (!payloadError || usage.quotaHidden)) return usage;
    if (payloadStatus === 2062) {
      noActiveTokenPlan = true;
      continue;
    }
    if (payloadError) {
      lastError = payloadError;
      continue;
    }
    lastError = "unrecognized response shape";
  }

  if (noActiveTokenPlan) {
    return {
      session: 0,
      weekly: 0,
      quotaHidden: true,
      notice: "No active Token Plan · check Credit balance in the MiniMax console",
    };
  }
  return { session: 0, weekly: 0, error: credentialError ?? lastError };
}

export function extractOpenRouterUsageFromPayloads(
  creditsPayload: unknown,
  keyPayload: unknown,
): UsageData | null {
  const credits = asObject(asObject(creditsPayload)?.data) ?? asObject(creditsPayload);
  const key = asObject(asObject(keyPayload)?.data) ?? asObject(keyPayload);

  const totalCredits = readNumber(credits?.total_credits ?? credits?.totalCredits);
  const totalUsage = readNumber(credits?.total_usage ?? credits?.totalUsage);
  const accountBalance = totalCredits !== null && totalUsage !== null
    ? {
        amount: Number((totalCredits - totalUsage).toFixed(6)),
        unit: "USD",
        label: "Balance",
      }
    : undefined;

  const spendValues = {
    daily: readNumber(key?.usage_daily ?? key?.usageDaily),
    weekly: readNumber(key?.usage_weekly ?? key?.usageWeekly),
    monthly: readNumber(key?.usage_monthly ?? key?.usageMonthly),
    lifetime: readNumber(key?.usage),
  };
  const accountSpend = Object.values(spendValues).some((value) => value !== null)
    ? {
        unit: "USD",
        daily: spendValues.daily ?? undefined,
        weekly: spendValues.weekly ?? undefined,
        monthly: spendValues.monthly ?? undefined,
        lifetime: spendValues.lifetime ?? undefined,
      }
    : undefined;

  const limit = readNumber(key?.limit);
  const remaining = readNumber(key?.limit_remaining ?? key?.limitRemaining);
  const limitUsed = limit !== null && limit > 0 && remaining !== null
    ? Math.max(0, Math.min(limit, limit - remaining))
    : null;
  const limitPercent = limitUsed !== null && limit !== null ? limitUsed / limit * 100 : null;
  if (!accountBalance && !accountSpend && limitPercent === null) return null;

  return {
    session: limitPercent === null ? 0 : Number(limitPercent.toFixed(2)),
    weekly: 0,
    quotaHidden: limitPercent === null,
    weeklyHidden: true,
    sessionLabel: "Key limit",
    accountBalance,
    accountSpend,
  };
}

export async function fetchOpenRouterUsage(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const [creditsResult, keyResult] = await Promise.all([
    requestJson(endpoints.openRouterCredits, { headers }, config),
    requestJson(endpoints.openRouterKey, { headers }, config),
  ]);
  const usage = extractOpenRouterUsageFromPayloads(
    creditsResult.ok ? creditsResult.data : undefined,
    keyResult.ok ? keyResult.data : undefined,
  );
  if (usage) return usage;

  const errors = [
    creditsResult.ok ? undefined : `credits: ${creditsResult.error}`,
    keyResult.ok ? undefined : `key: ${keyResult.error}`,
  ].filter((value): value is string => Boolean(value));
  return {
    session: 0,
    weekly: 0,
    error: errors.length > 0 ? errors.join("; ") : "unrecognized response shape",
  };
}

export function extractDeepSeekBalanceFromPayload(payload: unknown): UsageData | null {
  const root = asObject(payload);
  const rawBalances = Array.isArray(root?.balance_infos) ? root.balance_infos : [];
  const balances = rawBalances.map(asObject).filter((value): value is Record<string, unknown> => value !== null);
  if (balances.length === 0) return null;

  const parsed = balances.flatMap((balance) => {
    const unit = typeof balance.currency === "string" ? balance.currency.toUpperCase() : "USD";
    const total = readNumber(balance.total_balance ?? balance.totalBalance);
    if (total === null) return [];
    return [{
      total: { amount: total, unit, label: "Total balance" } satisfies AccountBalance,
      toppedUp: readNumber(balance.topped_up_balance ?? balance.toppedUpBalance),
      granted: readNumber(balance.granted_balance ?? balance.grantedBalance),
    }];
  });
  const primary = parsed[0];
  if (!primary) return null;

  const details: AccountBalance[] = [];
  if (primary.toppedUp !== null) {
    details.push({ amount: primary.toppedUp, unit: primary.total.unit, label: "Topped up" });
  }
  if (primary.granted !== null) {
    details.push({ amount: primary.granted, unit: primary.total.unit, label: "Granted" });
  }
  for (const additional of parsed.slice(1)) details.push(additional.total);

  return {
    session: 0,
    weekly: 0,
    quotaHidden: true,
    accountBalance: primary.total,
    accountBalanceDetails: details,
    warning: root?.is_available === false ? "Balance is not currently available for API use" : undefined,
  };
}

export async function fetchDeepSeekBalance(token: string, config: FetchConfig = {}): Promise<UsageData> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const result = await requestJson(endpoints.deepSeekBalance, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, config);
  if (!result.ok) return { session: 0, weekly: 0, error: result.error };
  return extractDeepSeekBalanceFromPayload(result.data) ?? {
    session: 0,
    weekly: 0,
    error: "unrecognized response shape",
  };
}

export function extractMoonshotBalanceFromPayload(
  payload: unknown,
  provider: "moonshot" | "moonshot-cn" = "moonshot",
): UsageData | null {
  const root = asObject(payload);
  const data = asObject(root?.data) ?? root;
  if (!data) return null;
  const available = readNumber(data.available_balance ?? data.availableBalance);
  if (available === null) return null;
  const cash = readNumber(data.cash_balance ?? data.cashBalance);
  const voucher = readNumber(data.voucher_balance ?? data.voucherBalance);
  const unit = provider === "moonshot-cn" ? "CNY" : "USD";
  const details: AccountBalance[] = [];
  if (cash !== null) details.push({ amount: cash, unit, label: "Cash" });
  if (voucher !== null) details.push({ amount: voucher, unit, label: "Voucher" });

  return {
    session: 0,
    weekly: 0,
    quotaHidden: true,
    accountBalance: { amount: available, unit, label: "Available balance" },
    accountBalanceDetails: details,
    warning: available <= 0 ? "Balance exhausted; inference requests may be rejected" : undefined,
  };
}

export async function fetchMoonshotBalance(
  token: string,
  provider: "moonshot" | "moonshot-cn" = "moonshot",
  config: FetchConfig = {},
): Promise<UsageData> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const endpoint = provider === "moonshot-cn" ? endpoints.moonshotCnBalance : endpoints.moonshotBalance;
  const result = await requestJson(endpoint, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }, config);
  if (!result.ok) return { session: 0, weekly: 0, error: result.error };
  return extractMoonshotBalanceFromPayload(result.data, provider) ?? {
    session: 0,
    weekly: 0,
    error: "unrecognized response shape",
  };
}

/** Parse ZAI limits where unit 3 is the five-hour window and unit 6 the weekly window. */
export function extractZaiUsageFromPayload(payload: unknown, nowMs = Date.now()): UsageData | null {
  const data = payload as any;
  const arrays = [data?.data?.limits, data?.limits, data?.quota?.limits, data?.data?.quota?.limits];
  const limits = arrays.find(Array.isArray) as any[] | undefined;
  if (!limits?.length) return null;

  // CREDIT_LIMIT (GLM Coding Plan "lite"/credit-based tiers) reports the same
  // unit/percentage/nextResetTime shape as TOKENS_LIMIT, so treat both as the
  // quota windows for session (unit 3) and weekly (unit 6).
  const tokenLimits = limits.filter((entry) => {
    const type = String(entry?.type || "").toUpperCase();
    return type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
  });
  const sessionEntry = tokenLimits.find((entry) => entry?.unit === 3);
  const weeklyEntry = tokenLimits.find((entry) => entry?.unit === 6);
  if (!sessionEntry || !weeklyEntry) return null;

  const session = readPercentCandidate(sessionEntry.percentage);
  const weekly = readPercentCandidate(weeklyEntry.percentage);
  if (session === null || weekly === null) return null;
  const normalized = normalizeUsagePair(session, weekly);

  return {
    ...normalized,
    sessionResetsIn: typeof sessionEntry.nextResetTime === "number" && sessionEntry.nextResetTime > 0
      ? formatDuration(Math.max(0, sessionEntry.nextResetTime - nowMs) / 1000)
      : undefined,
    weeklyResetsIn: typeof weeklyEntry.nextResetTime === "number" && weeklyEntry.nextResetTime > 0
      ? formatDuration(Math.max(0, weeklyEntry.nextResetTime - nowMs) / 1000)
      : undefined,
  };
}

export async function fetchZaiUsage(
  token: string,
  provider: "zai" | "zai-cn" = "zai",
  config: FetchConfig = {},
): Promise<UsageData> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const endpoint = provider === "zai-cn" ? endpoints.zaiCn : endpoints.zai;
  const result = await requestJson(endpoint, { headers: { Authorization: `Bearer ${token}` } }, config);
  if (!result.ok) return { session: 0, weekly: 0, error: result.error };

  const zaiUsage = extractZaiUsageFromPayload(result.data);
  if (zaiUsage) return zaiUsage;
  return extractUsageFromPayload(result.data) ?? { session: 0, weekly: 0, error: "unrecognized response shape" };
}

export function detectProvider(
  model: { provider?: string } | string | undefined | null,
): ProviderKey | null {
  if (!model || typeof model === "string") return null;
  switch ((model.provider || "").toLowerCase()) {
    case "openai-codex": return "codex";
    case "anthropic": return "claude";
    case "zai": return "zai";
    case "zai-coding-cn": return "zai-cn";
    case "kimi-coding": return "kimi";
    case "minimax": return "minimax";
    case "minimax-cn": return "minimax-cn";
    case "openrouter": return "openrouter";
    case "deepseek": return "deepseek";
    case "moonshotai": return "moonshot";
    case "moonshotai-cn": return "moonshot-cn";
    default: return null;
  }
}

export function providerToPiProviderId(provider: ProviderKey): PiProviderId {
  switch (provider) {
    case "codex": return "openai-codex";
    case "claude": return "anthropic";
    case "zai": return "zai";
    case "zai-cn": return "zai-coding-cn";
    case "kimi": return "kimi-coding";
    case "minimax": return "minimax";
    case "minimax-cn": return "minimax-cn";
    case "openrouter": return "openrouter";
    case "deepseek": return "deepseek";
    case "moonshot": return "moonshotai";
    case "moonshot-cn": return "moonshotai-cn";
  }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function colorForPercent(value: number): "success" | "warning" | "error" {
  if (value >= 90) return "error";
  if (value >= 70) return "warning";
  return "success";
}

export async function fetchAllUsages(
  tokens: UsageTokens,
  config: FetchAllUsagesConfig = {},
): Promise<UsageByProvider> {
  const endpoints = config.endpoints ?? resolveUsageEndpoints(config.env);
  const results: UsageByProvider = {
    codex: null,
    claude: null,
    zai: null,
    "zai-cn": null,
    kimi: null,
    minimax: null,
    "minimax-cn": null,
    openrouter: null,
    deepseek: null,
    moonshot: null,
    "moonshot-cn": null,
  };
  const tasks: Promise<void>[] = [];

  const assign = (provider: ProviderKey, request: Promise<UsageData>) => {
    tasks.push(request.then((usage) => {
      results[provider] = usage;
    }).catch((error) => {
      results[provider] = { session: 0, weekly: 0, error: toErrorMessage(error, config.signal) };
    }));
  };

  if (tokens.codex) assign("codex", fetchCodexUsage(tokens.codex, config));
  if (tokens.claude) {
    assign("claude", fetchClaudeUsageWithFallback(tokens.claude, {
      ...config,
      cacheFile: config.cacheFile,
      nowMs: config.nowMs,
    }));
  }
  if (tokens.zai) assign("zai", fetchZaiUsage(tokens.zai, "zai", { ...config, endpoints }));
  if (tokens["zai-cn"]) assign("zai-cn", fetchZaiUsage(tokens["zai-cn"], "zai-cn", { ...config, endpoints }));
  if (tokens.kimi) assign("kimi", fetchKimiUsage(tokens.kimi, { ...config, endpoints }));
  if (tokens.minimax) assign("minimax", fetchMiniMaxUsage(tokens.minimax, "minimax", { ...config, endpoints }));
  if (tokens["minimax-cn"]) {
    assign("minimax-cn", fetchMiniMaxUsage(tokens["minimax-cn"], "minimax-cn", { ...config, endpoints }));
  }
  if (tokens.openrouter) assign("openrouter", fetchOpenRouterUsage(tokens.openrouter, { ...config, endpoints }));
  if (tokens.deepseek) assign("deepseek", fetchDeepSeekBalance(tokens.deepseek, { ...config, endpoints }));
  if (tokens.moonshot) assign("moonshot", fetchMoonshotBalance(tokens.moonshot, "moonshot", { ...config, endpoints }));
  if (tokens["moonshot-cn"]) {
    assign("moonshot-cn", fetchMoonshotBalance(tokens["moonshot-cn"], "moonshot-cn", { ...config, endpoints }));
  }

  await Promise.all(tasks);

  // Pi intentionally uses MOONSHOT_API_KEY for both regional providers. When one
  // key works in only one region, hide the expected regional auth failure from
  // the all-provider view while preserving active-provider polling behavior.
  if (tokens.moonshot && tokens.moonshot === tokens["moonshot-cn"]) {
    if (results.moonshot && !results.moonshot.error && results["moonshot-cn"]?.error) {
      results["moonshot-cn"] = null;
    } else if (results["moonshot-cn"] && !results["moonshot-cn"].error && results.moonshot?.error) {
      results.moonshot = null;
    }
  }
  return results;
}

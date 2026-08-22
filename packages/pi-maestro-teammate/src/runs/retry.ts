import type { ModelHealthScope, ModelHealthTarget } from "../models/model-circuit-breaker.ts";

export const NETWORK_RETRY_POLICY = Object.freeze({
  maxRetries: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 16_000,
});

const RETRY_MAX_DELAY_ENV = "PI_RETRY_MAX_DELAY_MS";
const DEFAULT_RETRY_MAX_DELAY_MS = 16_000;

function readRetryMaxDelayMs(env: Record<string, string | undefined>): number {
  const raw = env[RETRY_MAX_DELAY_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETRY_MAX_DELAY_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_RETRY_MAX_DELAY_MS;
}

/**
 * Resolve the network retry policy, honoring the `PI_RETRY_MAX_DELAY_MS`
 * override for the backoff cap (last retry's maximum wait).
 */
export function resolveNetworkRetryPolicy(
  env: Record<string, string | undefined> = process.env,
): Readonly<{
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}> {
  return Object.freeze({
    maxRetries: 10,
    initialDelayMs: 1_000,
    maxDelayMs: readRetryMaxDelayMs(env),
  });
}

export const RESOLVED_NETWORK_RETRY_POLICY = resolveNetworkRetryPolicy();

export type RetryErrorKind = "network" | "provider" | "fallback-only" | "auth" | "non-retryable";

export type ModelHealthFailureScope = ModelHealthScope | "none";

export interface ModelHealthFailureInput {
  message?: string;
  status?: number;
  /** Authoritative backend-aware override when the text cannot identify ownership. */
  scope?: ModelHealthFailureScope;
}

export interface ModelHealthFailureFacts extends ModelHealthFailureInput {
  retryKind: RetryErrorKind;
}

export interface ModelHealthFailureClassification {
  retryKind: RetryErrorKind;
  scope: ModelHealthFailureScope;
  affectsCircuit: boolean;
  suppressAuth: boolean;
}

/** Optional backend hook for assigning a failure to deployment or route health. */
export type ModelHealthFailureScopeClassifier = (
  failure: Readonly<ModelHealthFailureFacts>,
) => ModelHealthFailureScope | undefined;

export interface ModelHealthAttemptSnapshot {
  projectionFingerprint?: string;
  quarantinedDeployments: readonly string[];
  authSuppressions: readonly string[];
}

/**
 * Authentication/permission failures: a bad key, expired/revoked token, or a
 * 401/403 response. Retrying the same model/credential cannot clear these, so
 * callers switch candidates instead of backing off (see `retryDelayMs`).
 *
 * Split out of the old non-retryable bucket so the main-agent failover can
 * keep its "auth never initiates a fresh logical replay" semantics while the
 * teammate candidate sweep treats auth as fallback-eligible (the next model
 * may carry a valid key).
 */
const AUTH_ERROR =
  /\b(?:unauthori[sz]ed|unauthenticated|authentication failed|invalid api key|(?:api |access |auth )?token (?:expired|invalid|revoked)|invalid credentials?|forbidden)\b/i;

// Status codes carry a (?<![:.\w]) guard instead of a leading \b so host:port
// text in connection errors ("ECONNREFUSED 127.0.0.1:401") is not mistaken
// for an HTTP 401/403 response and wrongly classified as permanent.
const NON_RETRYABLE_ERROR =
  /usage[_\s-]*limit|multi-auth rotation failed|bad request|invalid request|invalid model|unknown model|context[_\s-]*length[_\s-]*exceeded|input exceeds the context window|schema[-\s]*valid|validation (?:failed|error)/i;

// Local teammate infrastructure failures are deterministic: re-dispatching a
// whole run cannot fix a missing binary or a killed child process. They are
// matched explicitly so the unknown-failure default below can stay retryable
// without relaunching doomed runs.
const LOCAL_INFRASTRUCTURE_ERROR =
  /\b(?:failed to spawn pi subprocess|teammate child process exited abnormally|child exited before the correction prompt started|partial response was not accepted as success)\b/i;

// Abort/cancellation diagnostics. fetch/AbortController surfaces these as
// "This operation was aborted", "The user aborted a request", or a bare
// "aborted"/"Request was aborted". They are NOT model failures: the user or a
// lifecycle hook cancelled the run, so retrying the same model or switching to
// a fallback would replay work the user just stopped. Must be matched before
// the unknown-failure default (which is retryable) so an abort stopReason
// mislabelled as "error" does not trigger failover.
const ABORT_ERROR = /\b(?:this operation was aborted|the (?:user|operation) aborted(?: a request)?|request was aborted|operation aborted|aborted)\b/i;

// `recordRuntimeEventError` wraps every Pi-reported diagnostic in a bounded
// "Teammate runtime error (phase=…, agent=…, model=…, correlationId=…): <inner>"
// envelope. Classification must judge the inner diagnostic — the wrapper text
// itself carries no retry semantics, and matching it would mark every wrapped
// provider/network failure non-retryable and silently disable fallback.
const RUNTIME_ERROR_WRAPPER =
  /^Teammate runtime error \(phase=[^)]*, agent=[^)]*, model=[^)]*, correlationId=[^)]*\): /;

function unwrapRuntimeDiagnostic(message: string): string {
  return message.replace(RUNTIME_ERROR_WRAPPER, "");
}

// A configured model can exist in the local catalog while the upstream
// account group does not actually serve it. This is candidate-specific: a
// different model, including one from the same provider, may still work.
const MODEL_UNAVAILABLE_ERROR =
  /\bmodel[_\s-]*not[_\s-]*found\b|model\s+["']?[^\s"']+["']?\s+is not supported by any configured account|model\s+["']?[^\s"']+["']?\s+(?:does not exist|is unavailable)(?:\s+or\s+you\s+do\s+not\s+have\s+access)?/i;

const FALLBACK_ONLY_ERROR =
  /\b(?:402|insufficient[_\s-]*(?:quota|balance|credits?)|credits? exhausted|billing quota|quota exceeded|out of budget)\b/i;

const STREAM_READ_ERROR = /\bstream[_\s-]*read[_\s-]*error\b/i;

const NETWORK_ERROR =
  /\b(?:econnreset|econnrefused|econnaborted|enetunreach|enetdown|ehostunreach|enotfound|eai_again|etimedout|epipe|socket hang up|fetch failed|failed to fetch|getaddrinfo|network(?: ?error| request)?|connection (?:error|failed|failure|reset|refused|lost|timed out|timeout|closed|terminated)|other side closed|upstream connect|reset before headers|request timed out|timed out waiting|signal timed out|timed? out|timeout|terminated|(?:web)?socket (?:was )?(?:closed|error)|sse response headers timed out|headers timed out|stream ended (?:without|before)|http2 request did not get a response|connectionerror|connectionreseterror|connectionrefusederror|connectionabortederror|brokenpipeerror|timeouterror|remotedisconnected|read timed out|requests\.exceptions)\b/i;

const PROVIDER_ERROR =
  /\b(?:408|429|500|502|503|504|524|rate[_\s-]*limit(?:ed|[_\s-]*exceeded|[_\s-]*error)?|too many (?:concurrent |simultaneous )?requests?|requests too quickly|concurr(?:ency|ent)|capacity|overloaded(?:_error)?|service[_\s-]*unavailable|provider returned error|server[_\s-]*error|internal[_\s-]*error|resource[_\s-]*exhausted)\b/i;

// Mirrors the status-class guard above: a 3-digit 4xx/5xx token NOT preceded by
// a colon/dot/word char. The trailing \b keeps 4-digit numbers ("4000") and
// fractional timings ("0.500") from matching.
const HTTP_STATUS_IN_MESSAGE = /(?<![:.\w])\b(4\d\d|5\d\d)\b/i;

function extractHttpStatusFromMessage(message: string): number | undefined {
  const match = HTTP_STATUS_IN_MESSAGE.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Map an HTTP status to its retry kind. Status is authoritative over message
 * text: a real 401/403 is always auth, a real 429/5xx is always provider,
 * other 4xx are permanent. Returns `undefined` for sub-400 statuses so the
 * message-path classifiers decide.
 */
function classifyByStatus(status: number | undefined): RetryErrorKind | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "fallback-only";
  if (status === 408 || status === 429 || status >= 500) return "provider";
  if (status >= 400 && status < 500) return "non-retryable";
  return undefined;
}

/**
 * Classify a provider failure for retry/fallback decisions.
 *
 * `status` (when known) normally short-circuits via {@link classifyByStatus};
 * an explicit upstream model-unavailable diagnostic is the narrow exception
 * because another configured candidate may still work. Otherwise the message
 * patterns apply, in order: auth → abort/cancel → permanent → local
 * infrastructure → quota/payment → transport → provider overload. Anything
 * unrecognized defaults to retryable (`provider`): at the provider boundary an
 * unknown diagnostic is far more often transient than permanent, and the
 * retry/fallback paths are bounded anyway. Abort/cancel diagnostics are the
 * exception: a user/lifecycle cancellation is never a model failure, so they
 * classify as `non-retryable` to avoid replaying stopped work on any model.
 */
export function classifyRetryError(message: string | undefined, status?: number): RetryErrorKind {
  if (!message) return "provider";
  const diagnostic = unwrapRuntimeDiagnostic(message);
  const effectiveStatus = status ?? extractHttpStatusFromMessage(diagnostic);
  if (effectiveStatus === 401) return "auth";
  if (MODEL_UNAVAILABLE_ERROR.test(diagnostic)) return "fallback-only";
  if (effectiveStatus === 403) return "auth";
  const byStatus = classifyByStatus(effectiveStatus);
  if (byStatus !== undefined) return byStatus;
  if (AUTH_ERROR.test(diagnostic)) return "auth";
  if (ABORT_ERROR.test(diagnostic)) return "non-retryable";
  if (NON_RETRYABLE_ERROR.test(diagnostic)) return "non-retryable";
  if (LOCAL_INFRASTRUCTURE_ERROR.test(diagnostic)) return "non-retryable";
  if (FALLBACK_ONLY_ERROR.test(diagnostic)) return "fallback-only";
  if (STREAM_READ_ERROR.test(diagnostic)) return "network";
  if (NETWORK_ERROR.test(diagnostic)) return "network";
  if (PROVIDER_ERROR.test(diagnostic)) return "provider";
  return "provider";
}

function defaultModelHealthFailureScope(retryKind: RetryErrorKind): ModelHealthFailureScope {
  if (retryKind === "network" || retryKind === "auth") return "deployment";
  if (retryKind === "provider" || retryKind === "fallback-only") return "route";
  return "none";
}

/**
 * Classify a registry-mode failure without coupling retry text parsing to a
 * backend implementation. Backends may supply a scope directly or a hook for
 * structured transport/provider errors; the retry kind remains the shared
 * legacy classifier result.
 */
export function classifyModelHealthFailure(
  failure: ModelHealthFailureInput,
  classifyScope?: ModelHealthFailureScopeClassifier,
): ModelHealthFailureClassification {
  const retryKind = classifyRetryError(
    failure.message ?? (failure.status === undefined ? undefined : `HTTP ${failure.status}`),
    failure.status,
  );
  const facts = Object.freeze({ ...failure, retryKind });
  const scope = failure.scope ?? classifyScope?.(facts) ?? defaultModelHealthFailureScope(retryKind);
  return Object.freeze({
    retryKind,
    scope,
    affectsCircuit: scope !== "none" && retryKind !== "non-retryable",
    suppressAuth: retryKind === "auth" && scope !== "none",
  });
}

/** Collision-safe key for an attempt-local, scope-specific auth suppression. */
export function modelHealthAuthSuppressionKey(
  scope: ModelHealthScope,
  target: ModelHealthTarget,
): string {
  const value = scope === "deployment" ? target.deploymentId : target.modelRegistrationId;
  if (!value) throw new TypeError(`Model health ${scope} key must not be empty`);
  return `${scope}:${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function isModelHealthAuthSuppressed(
  suppressions: ReadonlySet<string>,
  target: ModelHealthTarget,
): boolean {
  return suppressions.has(modelHealthAuthSuppressionKey("deployment", target))
    || suppressions.has(modelHealthAuthSuppressionKey("route", target));
}

/** Candidate-sweep state; never survives the attempt that created it. */
export class ModelHealthAttemptState {
  private fingerprint: string | undefined;
  private readonly quarantinedDeployments = new Set<string>();
  private readonly authSuppressions = new Set<string>();

  constructor(projectionFingerprint?: string) {
    this.fingerprint = projectionFingerprint;
  }

  get projectionFingerprint(): string | undefined {
    return this.fingerprint;
  }

  /** Clear attempt-local decisions when a new registry projection is observed. */
  reconcileProjectionFingerprint(projectionFingerprint: string): boolean {
    if (!projectionFingerprint) throw new TypeError("Model health projection fingerprint must not be empty");
    if (projectionFingerprint === this.fingerprint) return false;
    this.fingerprint = projectionFingerprint;
    this.quarantinedDeployments.clear();
    this.authSuppressions.clear();
    return true;
  }

  quarantineDeployment(deploymentId: string): void {
    if (!deploymentId) throw new TypeError("Model health deployment id must not be empty");
    this.quarantinedDeployments.add(deploymentId);
  }

  isDeploymentQuarantined(deploymentId: string): boolean {
    return this.quarantinedDeployments.has(deploymentId);
  }

  suppressAuth(scope: ModelHealthScope, target: ModelHealthTarget): void {
    this.authSuppressions.add(modelHealthAuthSuppressionKey(scope, target));
  }

  isAuthSuppressed(target: ModelHealthTarget): boolean {
    return isModelHealthAuthSuppressed(this.authSuppressions, target);
  }

  shouldSkip(target: ModelHealthTarget): boolean {
    return this.isDeploymentQuarantined(target.deploymentId) || this.isAuthSuppressed(target);
  }

  noteFailure(target: ModelHealthTarget, failure: ModelHealthFailureClassification): void {
    if (failure.scope === "deployment") this.quarantineDeployment(target.deploymentId);
    if (failure.suppressAuth && failure.scope !== "none") this.suppressAuth(failure.scope, target);
  }

  snapshot(): ModelHealthAttemptSnapshot {
    return Object.freeze({
      ...(this.fingerprint === undefined ? {} : { projectionFingerprint: this.fingerprint }),
      quarantinedDeployments: Object.freeze([...this.quarantinedDeployments].sort()),
      authSuppressions: Object.freeze([...this.authSuppressions].sort()),
    });
  }
}

/**
 * Pi core owns same-model provider retries in both the root session and
 * teammate children, but older Pi retry classifiers do not recognize the
 * machine-readable `stream_read_error` code. Add a semantic marker they
 * understand without replacing the original diagnostic.
 */
export function normalizePiRetryErrorMessage(message: string | undefined): string | undefined {
  if (
    !message
    || classifyRetryError(message) !== "network"
    || !STREAM_READ_ERROR.test(message)
    || /\bnetwork(?: ?error| request)?\b/i.test(message)
  ) {
    return message;
  }
  return `${message} (network error)`;
}

/** True when the failure is an authentication/permission problem. */
export function isAuthError(message: string | undefined, status?: number): boolean {
  return classifyRetryError(message, status) === "auth";
}

/** Whether the same model/credential is worth retrying (transient transport or provider overload). */
export function isRetryableProviderError(message: string | undefined, status?: number): boolean {
  const kind = classifyRetryError(message, status);
  return kind === "network" || kind === "provider";
}

/** Whether switching to another model candidate can plausibly recover the failure. */
export function isFallbackProviderError(message: string | undefined, status?: number): boolean {
  return classifyRetryError(message, status) !== "non-retryable";
}

/**
 * Extract a provider-requested retry delay from an error message, in
 * milliseconds relative to `now`. Understands the standard `Retry-After`
 * header (relative seconds), `x-ratelimit-reset-ms` (epoch ms),
 * `x-ratelimit-reset` (epoch seconds, or ms past the 1e12 boundary), and an
 * ISO-8601 reset timestamp. Returns `undefined` when no hint is present.
 */
export function extractRetryAfterMs(message: string | undefined, now = Date.now()): number | undefined {
  if (!message) return undefined;

  const retryAfter = /retry[-_ ]?after\s*[:=]\s*(\d+)/i.exec(message);
  if (retryAfter) {
    const seconds = Number(retryAfter[1]);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }

  const resetMs = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(message);
  if (resetMs) {
    const value = Number(resetMs[1]);
    if (Number.isFinite(value)) return Math.max(0, value - now);
  }

  const reset = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(message);
  if (reset) {
    const value = Number(reset[1]);
    if (!Number.isFinite(value)) return undefined;
    if (value > 1_000_000_000_000) return Math.max(0, value - now);
    return Math.max(0, value * 1000 - now);
  }

  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(message);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - now);
  }

  return undefined;
}

/**
 * Backoff delay before the next attempt, in milliseconds.
 *
 * Quota/payment, model-unavailable, auth, and permanent failures return 0 —
 * those conditions are resolved by switching candidates or reporting the
 * terminal error, not by waiting on the same model. Transient failures get
 * the exponential backoff (1s → maxDelayMs); a
 * provider-requested `retryAfterMs` caps the delay (earliest of the two).
 */
export function retryDelayMs(retry: number, kind?: RetryErrorKind, retryAfterMs?: number): number {
  if (kind === "fallback-only" || kind === "auth" || kind === "non-retryable") return 0;
  const normalizedRetry = Math.max(1, Math.floor(retry));
  const backoff = Math.min(
    RESOLVED_NETWORK_RETRY_POLICY.initialDelayMs * 2 ** (normalizedRetry - 1),
    RESOLVED_NETWORK_RETRY_POLICY.maxDelayMs,
  );
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(backoff, retryAfterMs);
  }
  return backoff;
}

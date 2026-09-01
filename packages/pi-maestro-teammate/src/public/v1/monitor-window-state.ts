/**
 * Versioned, root-side Monitor window read-model and facet contribution contract.
 *
 * The state is intentionally read-only. Registering a facet provider grants no
 * cross-window write authority and does not register an LLM tool.
 */

export const MONITOR_WINDOW_STATE_VERSION = 1 as const;
export const MAX_MONITOR_WINDOW_FACETS = 256;
export const MAX_MONITOR_WINDOW_FACET_CANDIDATES = 1_024;
export const MAX_MONITOR_WINDOW_FACET_ATTENTION = 64;
export const MAX_MONITOR_WINDOW_FACET_JSON_DEPTH = 32;
export const MAX_MONITOR_WINDOW_FACET_JSON_NODES = 4_096;
export const MAX_MONITOR_WINDOW_FACET_JSON_BYTES = 64 * 1_024;
export const MONITOR_WINDOW_FACET_READ_TIMEOUT_MS = 1_000;

/** Exact root endpoint incarnation. Every item of work evidence is fenced by all four fields. */
export interface MonitorWindowIdentityV1 {
  workspaceId: string;
  ownerId: string;
  ownerNonce: string;
  endpointId: string;
}

/** Provider-defined work identity. Both fields participate in exact equality. */
export interface MonitorWorkRefV1 {
  kind: string;
  id: string;
}

export interface MonitorWindowFacetTargetV1 {
  identity: MonitorWindowIdentityV1;
  /** Omit only for a facet about the window rather than its current work. */
  workRef?: MonitorWorkRefV1;
}

export type MonitorWindowAttentionSeverityV1 = "info" | "warning" | "error";

export interface MonitorWindowFacetAttentionV1 {
  code: string;
  severity: MonitorWindowAttentionSeverityV1;
  message: string;
  /** Stable provider key. Equal keys for one exact target are displayed once. */
  dedupeKey?: string;
}

export type MonitorWindowJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly MonitorWindowJsonValueV1[]
  | { readonly [key: string]: MonitorWindowJsonValueV1 };

/** One bounded, display-only contribution from a root-side package such as Flow. */
export interface MonitorWindowFacetV1 {
  /** Must equal the emitting provider's kind. */
  kind: string;
  target: MonitorWindowFacetTargetV1;
  /** Opaque provider content revision. */
  revision: string;
  data: MonitorWindowJsonValueV1;
  attention?: readonly MonitorWindowFacetAttentionV1[];
}

export interface MonitorWindowFacetReadRequestV1 {
  version: typeof MONITOR_WINDOW_STATE_VERSION;
  /** Exact targets captured by the root Monitor at the start of a read tick. */
  targets: readonly MonitorWindowFacetTargetV1[];
}

export interface MonitorWindowFacetProvider {
  /** Stable process-local provider kind. */
  kind: string;
  /**
   * Read bounded display facets for the captured targets. Providers must not
   * mutate windows or infer authority from a Todo projection.
   */
  read(
    request: MonitorWindowFacetReadRequestV1,
  ): readonly MonitorWindowFacetV1[] | Promise<readonly MonitorWindowFacetV1[]>;
}

export interface MonitorWindowFacetReadOptionsV1 {
  /** Request cancellation; provider promises are raced even if they ignore it. */
  signal?: AbortSignal;
  /** Absolute wall-clock deadline shared with the surrounding Monitor read. */
  deadline?: number;
  /** Per-provider read budget when no earlier deadline is supplied. */
  timeoutMs?: number;
}

const FACET_REGISTRY_KEY = Symbol.for("pi-maestro.monitor-window-facet-providers.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

function facetRegistry(): Map<string, MonitorWindowFacetProvider> {
  const existing = globals[FACET_REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, MonitorWindowFacetProvider>;
  const created = new Map<string, MonitorWindowFacetProvider>();
  globals[FACET_REGISTRY_KEY] = created;
  return created;
}

/** Register a process-local root facet provider. Stale disposers cannot remove replacements. */
export function registerMonitorWindowFacetProvider(provider: MonitorWindowFacetProvider): () => void {
  if (!provider || typeof provider.kind !== "string" || !provider.kind.trim()) {
    throw new TypeError("Monitor window facet provider kind must not be empty.");
  }
  if (typeof provider.read !== "function") {
    throw new TypeError("Monitor window facet provider read must be a function.");
  }
  facetRegistry().set(provider.kind, provider);
  return () => {
    if (facetRegistry().get(provider.kind) === provider) facetRegistry().delete(provider.kind);
  };
}

export function getMonitorWindowFacetProvider(kind: string): MonitorWindowFacetProvider | undefined {
  return facetRegistry().get(kind);
}

export function listMonitorWindowFacetProviders(): MonitorWindowFacetProvider[] {
  return [...facetRegistry().values()].sort((left, right) => binaryTextCompare(left.kind, right.kind));
}

/**
 * Read every registered provider without allowing one failure or malformed
 * target to poison the root Monitor snapshot. The returned facets remain
 * inputs to the pure reducer; this function itself performs no state reduction.
 */
export async function readMonitorWindowFacets(
  request: MonitorWindowFacetReadRequestV1,
  onError?: (message: string) => void,
  options?: MonitorWindowFacetReadOptionsV1,
): Promise<MonitorWindowFacetV1[]> {
  const allowed = new Set(request.targets.map(facetTargetKey));
  const providers = listMonitorWindowFacetProviders();
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs;
  const timeoutDeadline = Number.isFinite(timeoutMs) && timeoutMs! >= 0
    ? startedAt + timeoutMs!
    : undefined;
  const suppliedDeadline = Number.isFinite(options?.deadline) ? options!.deadline : undefined;
  const deadline = timeoutDeadline === undefined
    ? suppliedDeadline
    : suppliedDeadline === undefined ? timeoutDeadline : Math.min(timeoutDeadline, suppliedDeadline);

  // Providers start together and receive independent candidate budgets. A hung
  // or flooding kind therefore cannot consume another kind's time/candidates.
  const outcomes = await Promise.all(providers.map(async (provider) => {
    const facets: MonitorWindowFacetV1[] = [];
    const errors: string[] = [];
    try {
      const emitted = await awaitFacetProvider(() => provider.read(request), options?.signal, deadline);
      if (!Array.isArray(emitted)) {
        errors.push(`monitor window facet provider "${provider.kind}" returned a non-array result`);
        return { facets, errors };
      }
      const candidateCount = Math.min(emitted.length, MAX_MONITOR_WINDOW_FACET_CANDIDATES);
      for (let index = 0; index < candidateCount; index++) {
        const facet: unknown = emitted[index];
        if (!validFacet(facet, provider.kind) || !allowed.has(facetTargetKey(facet.target))) {
          errors.push(`monitor window facet provider "${provider.kind}" returned an invalid or uncaptured facet`);
          continue;
        }
        facets.push(cloneFacet(facet));
      }
      if (emitted.length > MAX_MONITOR_WINDOW_FACET_CANDIDATES) {
        errors.push(`monitor window facet provider "${provider.kind}" candidate limit reached`);
      }
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason ?? error;
      errors.push(error instanceof MonitorWindowFacetDeadlineError
        ? `monitor window facet provider "${provider.kind}" exceeded the read deadline`
        : `monitor window facet provider "${provider.kind}" read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { facets, errors };
  }));

  for (const outcome of outcomes) {
    for (const message of outcome.errors) onError?.(message);
  }
  const facets: MonitorWindowFacetV1[] = [];
  // Deterministic binary-kind round-robin prevents a valid flood from one kind
  // consuming the entire global facet cap before a healthy later kind appears.
  for (let index = 0; facets.length < MAX_MONITOR_WINDOW_FACETS; index++) {
    let added = false;
    for (const outcome of outcomes) {
      const facet = outcome.facets[index];
      if (!facet) continue;
      facets.push(facet);
      added = true;
      if (facets.length >= MAX_MONITOR_WINDOW_FACETS) break;
    }
    if (!added) break;
  }
  return facets;
}

export type MonitorWindowLifecycleStatusV1 =
  | "running"
  | "sleeping"
  | "settled"
  | "launching"
  | "failed"
  | "disconnected"
  | "unknown";

export interface MonitorWindowLifecycleV1 {
  status: MonitorWindowLifecycleStatusV1;
  source: "endpoint" | "managed-window" | "unknown";
  /** Heartbeat/display timestamp. Deliberately excluded from the state revision. */
  ownerPublishedAt?: number;
  lastSettle?: {
    at: number;
    lastResult?: string;
    source: "lifecycle";
  };
}

export interface MonitorWindowDeliveryV1 {
  publicationStage: "unknown" | "pending" | "accepted" | "rejected" | "timeout";
  consumptionStage: "unknown" | "queued" | "injected" | "replied";
  source: "thread" | "unknown";
  /** True only for injected/replied. Publication acceptance and queueing are not consumption. */
  consumed: boolean;
  messageId?: string;
  updatedAt?: number;
}

export type MonitorWindowCompletionOutcomeV1 = "completed" | "failed" | "cancelled" | "no-result";
export type MonitorWindowCompletionSourceV1 = "canonical-completion" | "exact-report";

/** Exact, owner- and work-fenced evidence that may authoritatively complete work. */
export interface MonitorWindowCompletionEvidenceV1 {
  target: Required<MonitorWindowFacetTargetV1>;
  source: MonitorWindowCompletionSourceV1;
  outcome: MonitorWindowCompletionOutcomeV1;
  /** Opaque producer revision used to distinguish same-status reports. */
  revision: string;
  completedAt: number;
  summary?: string;
}

export interface MonitorWindowCompletionV1 {
  outcome: MonitorWindowCompletionOutcomeV1 | "unknown";
  source: MonitorWindowCompletionSourceV1 | "unknown";
  revision?: string;
  completedAt?: number;
  summary?: string;
}

export interface MonitorWindowTodoDisplayV1 {
  id: string;
  subject: string;
  status: string;
  assigneeLabel?: string;
  dispatchId?: string;
  scheduleId?: string;
  stepId?: string;
  bindingActive?: boolean;
  updatedAt: number;
  /** Todo is an observer projection and never completion authority. */
  authority: "display-only";
  source: "workspace-owner";
}

export type MonitorWindowWorkStatusV1 =
  | "unknown"
  | "waiting-delivery"
  | "active"
  | "delivery-failed"
  | MonitorWindowCompletionOutcomeV1;

export interface MonitorWindowWorkV1 {
  ref?: MonitorWorkRefV1;
  status: MonitorWindowWorkStatusV1;
  delivery: MonitorWindowDeliveryV1;
  completion: MonitorWindowCompletionV1;
  todos: readonly MonitorWindowTodoDisplayV1[];
}

export interface MonitorWindowAttentionV1 extends MonitorWindowFacetAttentionV1 {
  target: MonitorWindowFacetTargetV1;
  source: "reducer" | "lifecycle" | `facet:${string}`;
  dedupeKey: string;
}

export interface MonitorWindowCardV1 {
  identity: MonitorWindowIdentityV1;
  endpoint: {
    status: string;
    scope: string;
    transport: string;
    contentRevision: string;
  };
  window: {
    name?: string;
    sessionName?: string;
    objective?: string;
    presentation?: "interactive" | "headless";
    management?: "monitor" | "delegation";
    pid?: number;
    startedAt?: number;
    lifecycle: MonitorWindowLifecycleV1;
  };
  work: MonitorWindowWorkV1;
  facets: readonly MonitorWindowFacetV1[];
  attention: readonly MonitorWindowAttentionV1[];
}

export interface MonitorWindowStateV1 {
  version: typeof MONITOR_WINDOW_STATE_VERSION;
  /** Opaque hash of semantic state; heartbeat-only timestamps are excluded. */
  revision: string;
  /** Opaque continuation token for this exact semantic snapshot. */
  cursor: string;
  observedAt: number;
  windows: readonly MonitorWindowCardV1[];
  attention: readonly MonitorWindowAttentionV1[];
}

function facetTargetKey(target: MonitorWindowFacetTargetV1): string {
  const identity = target?.identity;
  return [
    identity?.workspaceId,
    identity?.ownerId,
    identity?.ownerNonce,
    identity?.endpointId,
    target?.workRef?.kind ?? "",
    target?.workRef?.id ?? "",
  ].join("\u0000");
}

interface MonitorFacetValidationBudget {
  nodes: number;
}

const FACET_TEXT_ENCODER = new TextEncoder();

function validFacet(value: unknown, kind: string): value is MonitorWindowFacetV1 {
  try {
    if (!dataRecord(value, ["kind", "target", "revision", "data", "attention"])) return false;
    const budget: MonitorFacetValidationBudget = { nodes: 0 };
    if (value.kind !== kind || !boundedText(value.kind, true)) return false;
    if (!boundedText(value.revision, true)) return false;
    if (!validFacetTarget(value.target)) return false;
    if (!validJsonValue(value.data, budget, 0, new WeakSet<object>())) return false;
    if (value.attention !== undefined && !validFacetAttention(value.attention)) return false;
    // Enforce the hard cap on the actual serialized facet after the complete
    // depth/node/cycle/shape validation, including escapes, numbers and syntax.
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      && FACET_TEXT_ENCODER.encode(serialized).byteLength <= MAX_MONITOR_WINDOW_FACET_JSON_BYTES;
  } catch {
    return false;
  }
}

function validFacetTarget(value: unknown): value is MonitorWindowFacetTargetV1 {
  if (!dataRecord(value, ["identity", "workRef"]) || !validFacetIdentity(value.identity)) return false;
  if (value.workRef === undefined) return true;
  return dataRecord(value.workRef, ["kind", "id"])
    && boundedText(value.workRef.kind, true)
    && boundedText(value.workRef.id, true);
}

function validFacetIdentity(value: unknown): value is MonitorWindowIdentityV1 {
  return dataRecord(value, ["workspaceId", "ownerId", "ownerNonce", "endpointId"])
    && boundedText(value.workspaceId, true)
    && boundedText(value.ownerId, true)
    && boundedText(value.ownerNonce, true)
    && boundedText(value.endpointId, true);
}

function validFacetAttention(value: unknown): value is readonly MonitorWindowFacetAttentionV1[] {
  if (!Array.isArray(value) || value.length > MAX_MONITOR_WINDOW_FACET_ATTENTION) return false;
  for (const item of value) {
    if (!dataRecord(item, ["code", "severity", "message", "dedupeKey"])
      || !boundedText(item.code, true)
      || (item.severity !== "info" && item.severity !== "warning" && item.severity !== "error")
      || !boundedText(item.severity, true)
      || !boundedText(item.message, true)
      || (item.dedupeKey !== undefined && !boundedText(item.dedupeKey, true))) {
      return false;
    }
  }
  return true;
}

function validJsonValue(
  value: unknown,
  budget: MonitorFacetValidationBudget,
  depth: number,
  active: WeakSet<object>,
): value is MonitorWindowJsonValueV1 {
  if (++budget.nodes > MAX_MONITOR_WINDOW_FACET_JSON_NODES || depth > MAX_MONITOR_WINDOW_FACET_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return boundedText(value, false);
  if (typeof value !== "object" || active.has(value)) return false;

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !arrayIndex(key, value.length)))) return false;
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)
          || !validJsonValue(descriptor.value, budget, depth + 1, active)) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !boundedText(key, false)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
        || !validJsonValue(descriptor.value, budget, depth + 1, active)) return false;
    }
    return true;
  } finally {
    active.delete(value);
  }
}

function dataRecord(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function arrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function boundedText(value: unknown, nonEmpty: boolean): value is string {
  return typeof value === "string" && (!nonEmpty || Boolean(value.trim()));
}

function cloneFacet(facet: MonitorWindowFacetV1): MonitorWindowFacetV1 {
  return {
    kind: facet.kind,
    target: {
      identity: { ...facet.target.identity },
      ...(facet.target.workRef === undefined ? {} : { workRef: { ...facet.target.workRef } }),
    },
    revision: facet.revision,
    data: cloneJsonValue(facet.data),
    ...(facet.attention === undefined ? {} : { attention: facet.attention.map((item) => ({ ...item })) }),
  };
}

function cloneJsonValue(value: MonitorWindowJsonValueV1): MonitorWindowJsonValueV1 {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)]));
  }
  return value;
}

class MonitorWindowFacetDeadlineError extends Error {
  constructor() {
    super("Monitor window facet read deadline elapsed.");
    this.name = "MonitorWindowFacetDeadlineError";
  }
}

function awaitFacetProvider<T>(
  operation: () => T | Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Monitor facet read aborted."));
  if (deadline !== undefined && deadline <= Date.now()) return Promise.reject(new MonitorWindowFacetDeadlineError());
  // Compatibility: public v1 reads with no options have no implicit timeout.
  if (!signal && deadline === undefined) return Promise.resolve().then(operation);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settle();
    };
    const onAbort = (): void => finish(() => reject(signal?.reason ?? new Error("Monitor facet read aborted.")));
    if (deadline !== undefined) {
      timer = setTimeout(
        () => finish(() => reject(new MonitorWindowFacetDeadlineError())),
        Math.max(0, deadline - Date.now()),
      );
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => deadline !== undefined && Date.now() >= deadline
          ? finish(() => reject(new MonitorWindowFacetDeadlineError()))
          : finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

function binaryTextCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

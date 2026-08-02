export type ObservationAction = "status" | "wait" | "watch";
export type ObservationDetail = "summary" | "tail" | "full";
export type ObservationWaitMode = "all" | "any" | "count";
export type ObservationPhase = "pending" | "active" | "settled" | "unknown";
export type ObservationOutcome = "success" | "failure" | "stalled" | "aborted";
export type ObservationWaitStatus =
  | "completed"
  | "failed"
  | "terminated"
  | "result-ready"
  | "stalled"
  | "timeout"
  | "aborted"
  | "not-found";

export interface ObservationTarget {
  kind: string;
  id: string;
}

export interface ObservationCapabilities {
  inspect: boolean;
  wait: boolean;
  cancel?: boolean;
  message?: boolean;
  supervise?: boolean;
}

export interface ObservationSnapshot {
  target: ObservationTarget;
  found: boolean;
  nativeStatus: string;
  phase: ObservationPhase;
  outcome?: ObservationOutcome;
  waitStatus?: ObservationWaitStatus;
  summary: string;
  detail?: string[];
  updatedAt: number;
  capabilities?: ObservationCapabilities;
  error?: string;
}

export interface ObservationReadOptions {
  detail: ObservationDetail;
  lines: number;
}

export interface ObservationWaitOptions extends ObservationReadOptions {
  deadline: number;
  signal: AbortSignal;
  /** When the wait settles: "result-ready" (default) or "completed" (terminal lifecycle). */
  until?: "result-ready" | "completed";
}

export interface ObservationProvider {
  kind: string;
  capabilities: ObservationCapabilities;
  snapshot(id: string, options: ObservationReadOptions): ObservationSnapshot | Promise<ObservationSnapshot>;
  wait(id: string, options: ObservationWaitOptions): Promise<ObservationSnapshot>;
}

export interface ObserveParams {
  action: ObservationAction;
  targets: ObservationTarget[];
  detail?: ObservationDetail;
  lines?: number;
  waitMode?: ObservationWaitMode;
  waitCount?: number;
  timeoutMs?: number;
  /** Block until "result-ready" (default) or "completed" (terminal lifecycle). */
  until?: "result-ready" | "completed";
}

export interface ObserveResult {
  action: ObservationAction;
  reason: "snapshot" | "all" | "any" | "count" | "timeout" | "aborted" | "watch";
  observations: ObservationSnapshot[];
  durationMs: number;
}

const REGISTRY_KEY = Symbol.for("pi-maestro.observation-providers.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

function registry(): Map<string, ObservationProvider> {
  const existing = globals[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, ObservationProvider>;
  const created = new Map<string, ObservationProvider>();
  globals[REGISTRY_KEY] = created;
  return created;
}

export function registerObservationProvider(provider: ObservationProvider): () => void {
  if (!provider.kind.trim()) throw new Error("Observation provider kind must not be empty.");
  registry().set(provider.kind, provider);
  return () => {
    if (registry().get(provider.kind) === provider) registry().delete(provider.kind);
  };
}

export function getObservationProvider(kind: string): ObservationProvider | undefined {
  return registry().get(kind);
}

export function listObservationProviders(): ObservationProvider[] {
  return [...registry().values()];
}

function unavailable(target: ObservationTarget, waitStatus: ObservationWaitStatus, message: string): ObservationSnapshot {
  return {
    target,
    found: false,
    nativeStatus: waitStatus,
    phase: "unknown",
    outcome: waitStatus === "aborted" ? "aborted" : "failure",
    waitStatus,
    summary: message,
    updatedAt: Date.now(),
    error: message,
  };
}

function failedObservation(target: ObservationTarget, error: unknown): ObservationSnapshot {
  const message = error instanceof Error ? error.message : String(error);
  return unavailable(target, "failed", message);
}

function pendingObservation(target: ObservationTarget, waitStatus?: "timeout" | "aborted"): ObservationSnapshot {
  return {
    target,
    found: true,
    nativeStatus: "pending",
    phase: "active",
    ...(waitStatus ? { waitStatus, outcome: waitStatus === "aborted" ? "aborted" as const : undefined } : {}),
    summary: waitStatus ? `Observation ${waitStatus}.` : "Still active.",
    updatedAt: Date.now(),
  };
}

function normalizedParams(params: ObserveParams): Required<Pick<ObserveParams, "detail" | "lines" | "waitMode" | "waitCount" | "timeoutMs" | "until">> {
  return {
    detail: params.detail ?? "summary",
    lines: params.lines ?? 20,
    waitMode: params.waitMode ?? "all",
    waitCount: params.waitCount ?? 1,
    timeoutMs: params.timeoutMs ?? 10 * 60_000,
    until: params.until ?? "result-ready",
  };
}

function validate(params: ObserveParams): void {
  if (params.targets.length === 0) throw new Error("Observe requires at least one target.");
  if (params.targets.some((target) => !target.kind.trim() || !target.id.trim())) {
    throw new Error("Every observation target requires non-empty kind and id.");
  }
  if (params.lines !== undefined && (!Number.isInteger(params.lines) || params.lines < 1)) {
    throw new Error("Observe lines must be a positive integer.");
  }
  if (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1)) {
    throw new Error("Observe timeoutMs must be a positive integer.");
  }
  if (params.waitMode === "count") {
    if (!Number.isInteger(params.waitCount) || (params.waitCount ?? 0) < 1 || (params.waitCount ?? 0) > params.targets.length) {
      throw new Error("Observe waitCount must be between 1 and the number of targets.");
    }
  }
}

export async function observeTargets(params: ObserveParams, signal?: AbortSignal): Promise<ObserveResult> {
  validate(params);
  const startedAt = Date.now();
  const options = normalizedParams(params);

  if (params.action === "status") {
    const observations = await Promise.all(params.targets.map(async (target) => {
      const provider = getObservationProvider(target.kind);
      if (!provider) return unavailable(target, "not-found", `No observation provider for kind \"${target.kind}\".`);
      try {
        return await provider.snapshot(target.id, { detail: options.detail, lines: options.lines });
      } catch (error) {
        return failedObservation(target, error);
      }
    }));
    return { action: "status", reason: "snapshot", observations, durationMs: Date.now() - startedAt };
  }

  if (params.action === "watch") {
    // Persistent observation: poll every target until the deadline, recording
    // every status transition. Returns the full transition timeline (initial
    // snapshot plus each change), which is richer than a one-shot status and
    // does not require a barrier condition like wait.
    return watchTargets(params, options, startedAt, signal);
  }

  const controller = new AbortController();
  const deadline = startedAt + options.timeoutMs;
  const observations = new Array<ObservationSnapshot | undefined>(params.targets.length);
  const pending = new Set(params.targets.map((_target, index) => index));
  const required = options.waitMode === "all"
    ? params.targets.length
    : options.waitMode === "any"
      ? 1
      : options.waitCount;

  return new Promise<ObserveResult>((resolve) => {
    let finished = false;
    let settledCount = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (reason: ObserveResult["reason"]): void => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      const pendingStatus = reason === "timeout" ? "timeout" : reason === "aborted" ? "aborted" : undefined;
      const completed = params.targets.map((target, index) => observations[index] ?? pendingObservation(target, pendingStatus));
      resolve({ action: "wait", reason, observations: completed, durationMs: Date.now() - startedAt });
    };
    const onAbort = (): void => finish("aborted");

    // Arm the outer deadline before any provider wait starts. A provider cannot
    // strand later targets by delaying their timeout registration.
    timeout = setTimeout(() => finish("timeout"), options.timeoutMs);
    if (signal?.aborted) {
      finish("aborted");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    params.targets.forEach((target, index) => {
      const provider = getObservationProvider(target.kind);
      const wait = provider
        ? Promise.resolve().then(() => {
            if (controller.signal.aborted) return pendingObservation(target);
            return provider.wait(target.id, {
              detail: options.detail,
              lines: options.lines,
              deadline,
              until: options.until,
              signal: controller.signal,
            });
          }).catch((error) => failedObservation(target, error))
        : Promise.resolve(unavailable(target, "not-found", `No observation provider for kind \"${target.kind}\".`));

      void wait.then((observation) => {
        if (finished || !pending.delete(index)) return;
        observations[index] = observation;
        settledCount += 1;
        if (settledCount < required) return;
        finish(options.waitMode);
      });
    });
  });
}

/**
 * Persistent observation: poll every target until the deadline, recording each
 * status transition. Returns the initial snapshot plus every change as a
 * timeline. Unlike wait, no barrier condition is required — the caller sees the
 * full progression until timeoutMs elapses (or until aborted).
 */
async function watchTargets(
  params: ObserveParams,
  options: ReturnType<typeof normalizedParams>,
  startedAt: number,
  signal?: AbortSignal,
): Promise<ObserveResult> {
  const pollMs = Math.min(1_000, Math.max(100, Math.round(options.timeoutMs / 10)));
  const deadline = startedAt + options.timeoutMs;
  const providers = params.targets.map((target) => getObservationProvider(target.kind));
  const lastSeen = new Map<number, string>();
  const transitions: ObservationSnapshot[] = [];

  const snapshotAll = async (): Promise<void> => {
    await Promise.all(params.targets.map(async (target, index) => {
      const provider = providers[index];
      if (!provider) {
        if (!lastSeen.has(index)) {
          transitions.push(unavailable(target, "not-found", `No observation provider for kind \"${target.kind}\".`));
          lastSeen.set(index, "not-found");
        }
        return;
      }
      try {
        const observation = await provider.snapshot(target.id, { detail: options.detail, lines: options.lines });
        const key = `${observation.nativeStatus}|${observation.phase}`;
        if (lastSeen.get(index) !== key) {
          transitions.push(observation);
          lastSeen.set(index, key);
        }
      } catch (error) {
        if (!lastSeen.has(index)) {
          transitions.push(failedObservation(target, error));
          lastSeen.set(index, "error");
        }
      }
    }));
  };

  await snapshotAll();
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    await snapshotAll();
  }

  return {
    action: "watch",
    reason: signal?.aborted ? "aborted" : "watch",
    observations: transitions,
    durationMs: Date.now() - startedAt,
  };
}

export function formatObserveResult(result: ObserveResult, verbose = false): string[] {
  const header = `${result.observations.length} targets: ${result.reason} (${result.durationMs}ms)`;
  const lines = [header];
  for (const observation of result.observations) {
    const label = `${observation.target.kind}:${observation.target.id}`;
    lines.push(`${label}\t${observation.nativeStatus}\t${observation.summary}`.trimEnd());
    if (verbose && observation.detail) {
      for (const detail of observation.detail) lines.push(`  ${detail}`);
    }
  }
  return lines;
}

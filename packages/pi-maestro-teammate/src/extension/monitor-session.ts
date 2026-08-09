import { randomUUID } from "node:crypto";
import type { AnalysisResult, MonitorSupervisionMode } from "./monitor.ts";

export const MONITOR_SESSION_NAME = "monitor-session";
export const MONITOR_SESSION_ENV_VAR = "PI_TEAMMATE_MONITOR";
export const MONITOR_SESSION_RELATIVE_DIR = ".pi/monitor-sessions";

export interface MonitorEvaluationTarget {
  key: string;
  endpointId: string;
  ownerId: string;
  ownerNonce: string;
  displayName: string;
  mode: MonitorSupervisionMode;
  customPrompt?: string;
  goalId?: string;
  goalContext?: string;
  trend?: string;
  status: string;
  idleSeconds: number;
  objective: string;
  outputTail: readonly string[];
  hasPendingInteractions: boolean;
  contextPressure?: number;
  activeBackgroundJobs?: readonly string[];
}

export interface MonitorEvaluationRequest {
  requestId: string;
  capturedAt: number;
  targets: readonly MonitorEvaluationTarget[];
}

export interface MonitorEvaluationVerdict extends AnalysisResult {
  target: string;
}

export interface MonitorEvaluationResponse {
  requestId: string;
  results: readonly MonitorEvaluationVerdict[];
}

export const MONITOR_EVALUATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    requestId: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string" },
          status: { enum: ["on-track", "drift"] },
          reason: { type: "string" },
          action: { enum: ["none", "send"] },
          message: { type: "string" },
        },
        required: ["target", "status", "action"],
      },
    },
  },
  required: ["requestId", "results"],
};

export function createMonitorEvaluationRequest(
  targets: readonly MonitorEvaluationTarget[],
  capturedAt = Date.now(),
): MonitorEvaluationRequest {
  return {
    requestId: `monitor-eval-${capturedAt.toString(36)}-${randomUUID().slice(0, 8)}`,
    capturedAt,
    targets,
  };
}

export function buildMonitorEvaluationPrompt(request: MonitorEvaluationRequest): string {
  return [
    "You are the persistent structured evaluator for the workspace Monitor runtime.",
    "The parent runtime owns scheduling, policy, cooldowns, delivery, and audit records.",
    "Evaluate only the supplied immutable snapshot. Do not call observe, teammate-send, or any other tool.",
    "Never send an intervention yourself. Return one structured verdict per target using the provided schema.",
    "When action=send, message must be a concrete instruction for the target; routing and reply metadata are supplied automatically.",
    "For a status request, state the exact fields or evidence to return. Prefer time-sensitive corrective instructions; non-urgent coordination belongs in follow_up delivery.",
    "Do not treat queued or accepted delivery as model consumption or evidence that a prior intervention worked.",
    "Copy requestId and target keys exactly. Use action=send only when a short corrective message is warranted.",
    "A foreground background-job entry means active work is expected; do not call that target stalled solely from idle output.",
    "",
    JSON.stringify(request),
  ].join("\n");
}

export function validateMonitorEvaluationResponse(
  value: unknown,
  request: MonitorEvaluationRequest,
): { ok: true; response: MonitorEvaluationResponse; analyses: ReadonlyMap<string, AnalysisResult> }
  | { ok: false; reason: string } {
  if (!plainObject(value)) return { ok: false, reason: "Monitor evaluation result must be an object." };
  if (value.requestId !== request.requestId) {
    return { ok: false, reason: `Monitor evaluation requestId mismatch: expected ${request.requestId}.` };
  }
  if (!Array.isArray(value.results)) return { ok: false, reason: "Monitor evaluation result requires a results array." };
  if (value.results.length !== request.targets.length) {
    return { ok: false, reason: "Monitor evaluation result must contain exactly one verdict per target." };
  }

  const expected = new Set(request.targets.map((target) => target.key));
  const seen = new Set<string>();
  const results: MonitorEvaluationVerdict[] = [];
  const analyses = new Map<string, AnalysisResult>();
  for (const candidate of value.results) {
    if (!plainObject(candidate) || typeof candidate.target !== "string" || !expected.has(candidate.target)) {
      return { ok: false, reason: "Monitor evaluation result contains an unknown target." };
    }
    if (seen.has(candidate.target)) return { ok: false, reason: `Duplicate monitor verdict for ${candidate.target}.` };
    if (candidate.status !== "on-track" && candidate.status !== "drift") {
      return { ok: false, reason: `Invalid monitor status for ${candidate.target}.` };
    }
    if (candidate.action !== "none" && candidate.action !== "send") {
      return { ok: false, reason: `Invalid monitor action for ${candidate.target}.` };
    }
    if (candidate.status === "on-track" && candidate.action !== "none") {
      return { ok: false, reason: `On-track verdict for ${candidate.target} cannot request delivery.` };
    }
    const message = typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message.trim()
      : undefined;
    if (candidate.action === "send" && !message) {
      return { ok: false, reason: `Send verdict for ${candidate.target} requires a message.` };
    }
    const reason = typeof candidate.reason === "string" && candidate.reason.trim()
      ? candidate.reason.trim()
      : undefined;
    const verdict: MonitorEvaluationVerdict = {
      target: candidate.target,
      status: candidate.status,
      action: candidate.action,
      ...(reason ? { reason } : {}),
      ...(message ? { message } : {}),
    };
    seen.add(candidate.target);
    results.push(verdict);
    analyses.set(candidate.target, {
      status: verdict.status,
      action: verdict.action,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.message ? { message: verdict.message } : {}),
    });
  }
  if (seen.size !== expected.size) return { ok: false, reason: "Monitor evaluation result omitted a target." };
  return {
    ok: true,
    response: { requestId: request.requestId, results },
    analyses,
  };
}

export interface MonitorSessionInvocation {
  requestId: string;
  correlationId: string;
  promptSequence: number;
  /** Exact host-owned session object used to reject replacement sessions. */
  sessionIdentity: object;
}

export interface MonitorSessionTurnResult extends MonitorSessionInvocation {
  structuredOutput?: unknown;
  text?: string;
}

export interface MonitorSessionHost {
  invoke(
    request: MonitorEvaluationRequest,
    prompt: string,
    outputSchema: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MonitorSessionInvocation>;
  waitForResult(
    invocation: MonitorSessionInvocation,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<MonitorSessionTurnResult>;
  stop(signal: AbortSignal): Promise<void>;
}

export type MonitorSessionEvaluation =
  | { status: "ok"; analyses: ReadonlyMap<string, AnalysisResult>; response: MonitorEvaluationResponse }
  | { status: "stale"; reason: string }
  | { status: "invalid"; reason: string };

/** Serializes all turns through one persistent, wakeable evaluator session. */
export class MonitorSessionEvaluator {
  readonly host: MonitorSessionHost;
  #tail: Promise<void> = Promise.resolve();

  constructor(host: MonitorSessionHost) {
    this.host = host;
  }

  async evaluate(
    request: MonitorEvaluationRequest,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<MonitorSessionEvaluation> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      if (!isCurrent() || signal.aborted) return { status: "stale", reason: "Monitor evaluation generation changed before dispatch." };
      const invocation = await this.host.invoke(
        request,
        buildMonitorEvaluationPrompt(request),
        MONITOR_EVALUATION_SCHEMA,
        signal,
      );
      if (!isCurrent() || signal.aborted) return { status: "stale", reason: "Monitor evaluation generation changed after dispatch." };
      if (invocation.requestId !== request.requestId) {
        return { status: "invalid", reason: "Monitor session invocation returned a mismatched requestId." };
      }
      const turn = await this.host.waitForResult(invocation, signal, isCurrent);
      if (!isCurrent() || signal.aborted) return { status: "stale", reason: "Monitor evaluation generation changed after response wait." };
      if (turn.sessionIdentity !== invocation.sessionIdentity
        || turn.correlationId !== invocation.correlationId
        || turn.promptSequence !== invocation.promptSequence
        || turn.requestId !== invocation.requestId) {
        return { status: "stale", reason: "Monitor session identity or prompt sequence changed before result publication." };
      }
      const validated = validateMonitorEvaluationResponse(turn.structuredOutput, request);
      return validated.ok
        ? { status: "ok", analyses: validated.analyses, response: validated.response }
        : { status: "invalid", reason: validated.reason };
    } catch (error) {
      if (!isCurrent() || signal.aborted) {
        return { status: "stale", reason: error instanceof Error ? error.message : String(error) };
      }
      return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      release();
    }
  }

  async quiesce(): Promise<void> {
    await this.#tail;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

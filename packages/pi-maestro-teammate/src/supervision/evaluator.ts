import type { SingleResult } from "../shared/types.ts";
import type { TeammateThinkingInput } from "../shared/thinking.ts";

/**
 * Unified model-evaluation wrapper shared by supervision consumers
 * (Goal verifier, Monitor drift analysis, future Advisor).
 *
 * Semantics:
 *  - an overall `deadlineMs` aborts the dispatch signal (child tree) when exceeded
 *  - consecutive dispatch failures retry up to `maxFailures`, then give up
 *  - verdict extraction: structured output first, then `fallbackTextParser`
 *  - failures never throw: the result carries `{ ok: false }` plus a reason
 */

export interface SupervisedEvaluationParams {
  task: string;
  agent?: string;
  thinking?: TeammateThinkingInput;
  /** Per-attempt budget forwarded to the dispatch; caller decides how to apply. */
  timeoutMs?: number;
  /** Overall deadline; aborts the dispatch signal when exceeded. 0 disables. */
  deadlineMs?: number;
  outputSchema?: Record<string, unknown>;
  /** Legacy text-verdict fallback used when structured output is absent. */
  fallbackTextParser?: (text: string) => unknown;
  /** Consecutive dispatch failures before giving up. Default 3. */
  maxFailures?: number;
  /** Caller gate: return a failure reason to reject a result before verdict extraction. */
  beforeVerdict?: (result: SingleResult) => string | undefined;
  /** Retryability predicate; default retries every failure. */
  isRetryable?: (error: unknown) => boolean;
  /** Parent signal cascaded into the internal abort controller. */
  signal?: AbortSignal;
}

export interface SupervisedEvaluationContext {
  task: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
}

export type SupervisionDispatch = (ctx: SupervisedEvaluationContext) => Promise<SingleResult>;

export interface SupervisedEvaluationResult<T = unknown> {
  ok: boolean;
  verdict?: T;
  raw?: SingleResult;
  reason?: string;
}

export function describeSupervisionError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runSupervisedEvaluation<T = unknown>(
  dispatch: SupervisionDispatch,
  params: SupervisedEvaluationParams,
): Promise<SupervisedEvaluationResult<T>> {
  const {
    maxFailures = 3,
    deadlineMs = 0,
    outputSchema,
    fallbackTextParser,
    beforeVerdict,
    isRetryable,
  } = params;

  const controller = new AbortController();
  const parentSignal = params.signal;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const deadlineError = new Error(`Supervised evaluation timed out after ${deadlineMs}ms.`);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineMs > 0) {
    // Not unref'd: the deadline must keep the event loop alive while the
    // dispatch is pending (mocked dispatches have no child-process handle).
    deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
    }, deadlineMs);
  }

  let lastError: unknown;
  let lastResult: SingleResult | undefined;
  try {
    for (let attempt = 1; attempt <= maxFailures; attempt++) {
      if (controller.signal.aborted) break;
      try {
        const result = await dispatch({
          task: params.task,
          signal: controller.signal,
          timeoutMs: params.timeoutMs,
          outputSchema,
        });
        lastResult = result;
        if (beforeVerdict) {
          const gateReason = beforeVerdict(result);
          if (gateReason !== undefined) {
            return { ok: false, raw: result, reason: gateReason };
          }
        }
        if (result.structuredOutput !== undefined) {
          return { ok: true, verdict: result.structuredOutput as T, raw: result };
        }
        if (fallbackTextParser) {
          const text = result.messages[result.messages.length - 1]?.content ?? "";
          const verdict = fallbackTextParser(text);
          if (verdict !== undefined) {
            return { ok: true, verdict: verdict as T, raw: result };
          }
        }
        return {
          ok: false,
          raw: result,
          reason: "Evaluation produced no structured output and no parseable text verdict.",
        };
      } catch (error) {
        lastError = error;
        if (isRetryable && !isRetryable(error)) {
          return { ok: false, raw: lastResult, reason: `Evaluation failed: ${describeSupervisionError(error)}` };
        }
        // otherwise retry
      }
    }

    return {
      ok: false,
      raw: lastResult,
      reason: controller.signal.aborted
        ? `Supervised evaluation aborted: ${describeSupervisionError(controller.signal.reason ?? deadlineError)}`
        : `Evaluation failed after ${maxFailures} attempt(s): ${lastError === undefined ? "no result" : describeSupervisionError(lastError)}`,
    };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

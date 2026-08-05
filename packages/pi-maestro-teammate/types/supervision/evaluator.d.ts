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
export declare function describeSupervisionError(error: unknown): string;
export declare function runSupervisedEvaluation<T = unknown>(dispatch: SupervisionDispatch, params: SupervisedEvaluationParams): Promise<SupervisedEvaluationResult<T>>;

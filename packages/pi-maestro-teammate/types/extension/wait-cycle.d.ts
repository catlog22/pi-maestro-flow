export type WaitCycleAction = "status" | "diagnose" | "wait" | "watch";
export type WaitCycleMode = "all" | "any" | "count";
export interface WaitCycleValidationInput {
    callerCorrelationId: string;
    action: WaitCycleAction;
    waitMode?: WaitCycleMode;
    waitCount?: number;
    resolvedTargetIds: readonly string[];
    callerDependentIds: ReadonlySet<string>;
}
export interface WaitCycleDiagnostic {
    code: "self-wait-deadlock";
    cyclicIds: string[];
}
/** Returns a diagnostic only when a wait barrier must settle a cyclic target. */
export declare function validateWaitCycle(input: WaitCycleValidationInput): WaitCycleDiagnostic | undefined;

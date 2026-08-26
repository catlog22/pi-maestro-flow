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
export function validateWaitCycle(input: WaitCycleValidationInput): WaitCycleDiagnostic | undefined {
  if (input.action !== "wait") return undefined;

  const cyclicIds: string[] = [];
  const seenCyclicIds = new Set<string>();
  let noncyclicTargetCount = 0;

  for (const targetId of input.resolvedTargetIds) {
    const cyclic = targetId === input.callerCorrelationId || input.callerDependentIds.has(targetId);
    if (!cyclic) {
      noncyclicTargetCount += 1;
      continue;
    }
    if (!seenCyclicIds.has(targetId)) {
      seenCyclicIds.add(targetId);
      cyclicIds.push(targetId);
    }
  }

  if (cyclicIds.length === 0) return undefined;

  const waitMode = input.waitMode ?? "all";
  const requiredTargetCount = waitMode === "all"
    ? input.resolvedTargetIds.length
    : waitMode === "any"
      ? 1
      : input.waitCount ?? 1;

  if (requiredTargetCount <= noncyclicTargetCount) return undefined;
  return { code: "self-wait-deadlock", cyclicIds };
}

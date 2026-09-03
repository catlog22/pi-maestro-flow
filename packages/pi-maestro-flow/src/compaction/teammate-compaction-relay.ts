export type TeammateCompactionPhase = "pending" | "continuation" | "completed" | "failed" | "cancelled";

export interface TeammateCompactionStateEvent {
  type: "teammate_compaction_state";
  recoveryId: string;
  phase: TeammateCompactionPhase;
  generation: number;
  reason?: string;
}

export function isTeammateForkStartup(
  reason: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return reason === "fork"
    || (environment.PI_TEAMMATE_CHILD === "1" && environment.PI_TEAMMATE_CONTEXT_MODE === "fork");
}

export function publishTeammateCompactionState(
  event: Omit<TeammateCompactionStateEvent, "type">,
): boolean {
  if (process.env.PI_TEAMMATE_CHILD !== "1" || typeof process.send !== "function") return false;
  try {
    process.send({
      type: "teammate_compaction_state",
      ...event,
      correlationId: process.env.PI_TEAMMATE_CORRELATION_ID,
    });
    return true;
  } catch {
    return false;
  }
}

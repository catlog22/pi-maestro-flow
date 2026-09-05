export type TeammateCompactionPhase = "pending" | "continuation" | "completed" | "failed" | "cancelled";
export type TeammateCompactionProducer = "auto" | "new-context" | "output-limit";
export type TeammateCompactionWakeState = "prepared" | "queued" | "consumed" | "turn-started" | "cancelled" | "failed";

export interface TeammateCompactionWakeReceipt {
  type: "teammate_compaction_wake_receipt";
  version: 1;
  recoveryId: string;
  producer: TeammateCompactionProducer;
  generation: number;
  wakeId: string;
  state: TeammateCompactionWakeState;
  sequence: number;
  deadlineAt: number;
  runtimeGeneration?: number;
  sessionId?: string;
  branchCheckpointId?: string;
  messageId?: string;
  turnId?: string;
  reason?: string;
}

export interface TeammateCompactionStateEvent {
  type: "teammate_compaction_state";
  recoveryId: string;
  producer: TeammateCompactionProducer;
  phase: TeammateCompactionPhase;
  /** Monotonic only within producer; different producers are never compared. */
  generation: number;
  /** Advertises correlated receipts before cross-channel delivery can reorder them behind stdout. */
  wakeProtocolVersion?: 1;
  reason?: string;
}

export function isTeammateForkStartup(
  reason: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return reason === "fork"
    || (environment.PI_TEAMMATE_CHILD === "1" && environment.PI_TEAMMATE_CONTEXT_MODE === "fork");
}

function publishTeammateEnvelope(event: Record<string, unknown>): boolean {
  if (process.env.PI_TEAMMATE_CHILD !== "1" || typeof process.send !== "function") return false;
  try {
    process.send({ ...event, correlationId: process.env.PI_TEAMMATE_CORRELATION_ID });
    return true;
  } catch {
    return false;
  }
}

export function publishTeammateCompactionState(
  event: Omit<TeammateCompactionStateEvent, "type">,
): boolean {
  return publishTeammateEnvelope({ type: "teammate_compaction_state", ...event });
}

/** Publishing to IPC is telemetry only; its return value is never an acknowledgement. */
export function publishTeammateCompactionWakeReceipt(
  receipt: Omit<TeammateCompactionWakeReceipt, "type" | "version">,
): boolean {
  return publishTeammateEnvelope({
    type: "teammate_compaction_wake_receipt",
    version: 1,
    ...receipt,
  });
}

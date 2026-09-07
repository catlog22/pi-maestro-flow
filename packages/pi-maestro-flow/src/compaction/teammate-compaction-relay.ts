export type TeammateCompactionPhase = "pending" | "continuation" | "completed" | "failed" | "cancelled";
export type TeammateCompactionProducer = "auto" | "new-context" | "output-limit";
export type TeammateCompactionWakeState = "prepared" | "queued" | "consumed" | "turn-started" | "cancelled" | "failed";

export interface TeammateCompactionCapability {
  type: "teammate_compaction_capability";
  version: 1;
  wakeProtocolVersion: 1;
  runtimeGeneration: number;
}

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
  runtimeGeneration: number;
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
  /** Binds the ordered state channel to the companion receipt identity. */
  wakeId?: string;
  /** Carries the original absolute deadline before companion IPC can be reordered. */
  wakeDeadlineAt?: number;
  reason?: string;
}

export function isTeammateForkStartup(
  reason: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return reason === "fork"
    || (environment.PI_TEAMMATE_CHILD === "1" && environment.PI_TEAMMATE_CONTEXT_MODE === "fork");
}

function isClosedIpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_IPC_CHANNEL_CLOSED";
}

function publishTeammateEnvelope(event: Record<string, unknown>): boolean {
  if (process.env.PI_TEAMMATE_CHILD !== "1" || typeof process.send !== "function" || process.connected === false) return false;
  try {
    return process.send(
      { ...event, correlationId: process.env.PI_TEAMMATE_CORRELATION_ID },
      (error) => {
        if (error && !isClosedIpcError(error)) {
          console.warn(`[pi-maestro-flow] Teammate compaction telemetry send failed: ${error.message}`);
        }
      },
    );
  } catch (error) {
    if (!isClosedIpcError(error)) {
      console.warn(`[pi-maestro-flow] Teammate compaction telemetry send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

export function publishTeammateCompactionState(
  event: Omit<TeammateCompactionStateEvent, "type">,
): boolean {
  return publishTeammateEnvelope({ type: "teammate_compaction_state", ...event });
}

export function publishTeammateCompactionCapability(runtimeGeneration: number): boolean {
  return publishTeammateEnvelope({
    type: "teammate_compaction_capability",
    version: 1,
    wakeProtocolVersion: 1,
    runtimeGeneration,
  });
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

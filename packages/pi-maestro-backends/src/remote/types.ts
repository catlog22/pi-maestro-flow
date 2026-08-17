/**
 * The backends-side port for the host's remote worker manager, and structural
 * copies of the protocol data a remote run reports.
 *
 * The data types below are copied from the teammate package's own
 * `remote/types.ts` rather than imported, because the dependency direction is
 * teammate → backends: teammate assembles the registry and hands a backend its
 * manager, so a backend importing teammate would close the cycle. This file is
 * therefore the backends-side statement of what a remote run reports, not a
 * re-export of someone else's. Drift between the two sides is caught at
 * typecheck by the compile-time consistency assertion that lives in teammate,
 * where the import runs with the dependency direction rather than against it.
 *
 * Types only; this module contains no runtime code.
 */

export type RemoteStatus =
  | "connecting" | "ready" | "running" | "waiting"
  | "completed" | "failed" | "cancelled" | "disconnected" | "lost";

/** The statuses a run can settle on; every other member is still in flight. */
export type RemoteTerminalStatus = Extract<RemoteStatus, "completed" | "failed" | "cancelled" | "lost">;

/** Which wire protocol a configured target speaks. */
export type RemoteDriverId = "pi-rpc" | "acp";

/** How an input message reaches a running remote run. */
export type RemoteInputMode = "follow_up" | "steer";

export interface RemoteWorkerIdentity { workerId: string; instanceNonce: string }

export interface RemoteRunIdentity extends RemoteWorkerIdentity { runId: string; generation: number }

/** Exact ownership fence captured by the local Monitor. */
export interface RemoteRunCapture extends RemoteRunIdentity { monitorOwnerNonce: string; targetId: string }

export interface RemoteRunSnapshot extends RemoteRunIdentity {
  targetId?: string; status: RemoteStatus; lastSequence: number; updatedAt: number;
  nativeStatus?: string; degradedReason?: string; summary?: string;
}

/**
 * Token and cost accounting a remote driver reports.
 *
 * Every member is optional: a driver reports what its provider told it, and
 * `totalTokens` is a provider-side sum rather than an independent quantity.
 */
export interface RemoteUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number }

export interface RemoteToolEvent { toolCallId: string; toolName: string; phase: "start" | "end"; isError?: boolean; summary?: string }

export type RemoteDriverEvent =
  | { type: "text"; text: string }
  | { type: "tool"; tool: RemoteToolEvent }
  | { type: "usage"; usage: RemoteUsage }
  | { type: "native"; name: string; data?: unknown };

export interface RemoteRunStateEvent extends RemoteRunIdentity {
  type: "run/state"; sequence: number; status: RemoteStatus; updatedAt: number;
  nativeStatus?: string; degradedReason?: string; summary?: string;
}

export interface RemoteRunProgressEvent extends RemoteRunIdentity {
  type: "run/event"; sequence: number; event: RemoteDriverEvent; updatedAt: number;
}

/** The remote's own settlement statement; the only authoritative turn end. */
export interface RemoteRunResultEvent extends RemoteRunIdentity {
  type: "run/result"; sequence: number;
  status: RemoteTerminalStatus; updatedAt: number;
  result?: string; structuredOutput?: unknown; error?: string;
  nativeStatus?: string; degradedReason?: string;
}

export type RemoteRunEvent = RemoteRunStateEvent | RemoteRunProgressEvent | RemoteRunResultEvent;

export interface RemoteRunInputResult { accepted: boolean; effectiveMode: RemoteInputMode; receipt: "queued" | "accepted" | "injected" }

export interface RemoteRunCancelResult { accepted: boolean; status: RemoteStatus }

export interface RemoteWorkerWaitOptions { statuses?: readonly RemoteStatus[]; timeoutMs?: number; signal?: AbortSignal }

/**
 * What a backend asks the manager to start.
 *
 * The manager's capability-requirement field is deliberately absent. On the
 * production path it is always the empty array, and the `RemoteCapability`
 * vocabulary itself is being retired; a field no backend will ever fill would
 * only be one more call site to unpick later. Method parameters are bivariant
 * in TypeScript, so the real `RemoteWorkerManager.start` carrying one extra
 * optional parameter still satisfies this port.
 */
export interface RemoteWorkerStartRequest {
  targetId: string; name: string; objective: string;
  commandId?: string; outputSchema?: unknown; signal?: AbortSignal;
}

/**
 * Structural port over the host's `RemoteWorkerManager`.
 *
 * This package does not depend on teammate, so a backend cannot import the real
 * implementation; the host injects an adapter while assembling the registry.
 * The adapter's conformance to this port is asserted at compile time on the
 * teammate side, where the dependency already points this way and no cycle
 * forms.
 *
 * The member set is exactly what a backend calls. `subscribe` and
 * `resolveTargetDriver` have no one-to-one method on the real manager and are
 * served by the host adapter, but neither can be dropped: the manager publishes
 * events only through its constructor's `onEvent` callback, so without a
 * per-capture subscription a backend has no event stream and could only report
 * a constant `completedToolCount`; and `resolveRemoteTarget` lives in
 * teammate's config module, so without `resolveTargetDriver` a backend cannot
 * check a registration's declared driver against the target's real one.
 */
export interface RemoteWorkerManagerLike {
  /** This Monitor term's ownership nonce; the capture tuple's fifth member. */
  readonly monitorOwnerNonce: string;
  /** The driver the remote configuration really resolves for a target, so a registration's declaration can be checked against it. */
  resolveTargetDriver(targetId: string): RemoteDriverId;
  start(request: RemoteWorkerStartRequest): Promise<RemoteRunCapture>;
  /** Subscribe to one captured run's event stream; the returned function unsubscribes. */
  subscribe(capture: RemoteRunCapture, listener: (event: RemoteRunEvent) => void): () => void;
  send(capture: RemoteRunCapture, mode: RemoteInputMode, message: string, commandId?: string): Promise<RemoteRunInputResult>;
  cancel(capture: RemoteRunCapture, reason?: string, commandId?: string): Promise<RemoteRunCancelResult>;
  wait(capture: RemoteRunCapture, options?: RemoteWorkerWaitOptions): Promise<RemoteRunSnapshot>;
  snapshot(capture: RemoteRunCapture): RemoteRunSnapshot;
}

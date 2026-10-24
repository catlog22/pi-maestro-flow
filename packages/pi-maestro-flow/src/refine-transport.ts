/**
 * Optional remote presentation transport for the Plan Review & Refine panel.
 *
 * Flow stays the business authority for role subagents, model resolution,
 * Plan revisions, Artifacts and terminal outcomes. A transport only presents
 * that state to a remote surface and relays user actions back; it never decides
 * whether a refine run succeeded or whether an Apply was committed.
 *
 * This is a sibling of `plan-transport.ts`, which carries the one-shot Plan
 * confirmation decision. Refine needs a multi-round session, so it gets its own
 * additive registry instead of overloading the Plan contract.
 */

import type { RefineAppliesAs, RefineRole, RefineSession, RefineTurn } from "./tools/plan-refine.ts";

export type RefineTransportStatus = "opening" | "ready" | "running";

export type RefineTransportTerminal =
  | "applied"
  | "discarded"
  | "cancelled"
  | "failed"
  | "revision_conflict"
  | "disconnected";

export type RefineTransportErrorCode =
  | "target_mismatch"
  | "invalid_state"
  | "session_terminal"
  | "deadline_exceeded"
  | "disconnected"
  | "run_failed"
  | "apply_failed";

/** Exact identity of the Pi session that owns this refine session. */
export interface RefineTransportTarget {
  readonly sessionId: string;
  readonly endpointId?: string;
  readonly normalizedCwd: string;
  readonly processGeneration?: number;
}

export interface RefineTransportTurn extends RefineTurn {
  readonly turnId: string;
  readonly appliesAs: RefineAppliesAs;
}

export interface RefineTransportSnapshot {
  readonly refineSessionId: string;
  readonly operationId: number;
  readonly target: RefineTransportTarget;
  readonly revision: number;
  readonly status: RefineTransportStatus;
  readonly highWaterSequence: number;
  readonly session: RefineSession;
  readonly turns: readonly RefineTransportTurn[];
}

/**
 * Event bodies without the transport sequence; Flow owns sequence assignment so
 * the presenter never has to renumber or infer ordering.
 */
export type RefineTransportEventBody =
  | { readonly type: "status"; readonly status: RefineTransportStatus }
  | { readonly type: "snapshot"; readonly snapshot: RefineTransportSnapshot }
  | { readonly type: "turn"; readonly turn: RefineTransportTurn }
  | {
      readonly type: "action_result";
      readonly actionId: string;
      readonly status: "accepted" | "succeeded" | "rejected" | "failed";
      readonly errorCode?: RefineTransportErrorCode;
      readonly turnId?: string;
    }
  | {
      readonly type: "terminal";
      readonly status: RefineTransportTerminal;
      readonly errorCode?: RefineTransportErrorCode;
    };

export type RefineTransportEvent = RefineTransportEventBody & { readonly sequence: number };

export type RefineTransportAction =
  | {
      readonly type: "run";
      readonly actionId: string;
      readonly role: RefineRole;
      readonly model: string;
      readonly modelLabel: string;
      readonly userInput: string;
    }
  | { readonly type: "apply"; readonly actionId: string; readonly turnId: string }
  | { readonly type: "discard"; readonly actionId: string }
  | { readonly type: "cancel"; readonly actionId: string }
  | { readonly type: "snapshot_request"; readonly actionId: string };

export interface RefineTransportRequest {
  readonly sessionId: string;
  readonly refineSessionId: string;
  readonly operationId: number;
  readonly target: RefineTransportTarget;
  readonly cwd: string;
  readonly mode: string;
  readonly markdown: string;
  readonly revision: number;
  readonly session: RefineSession;
  readonly initialRole: RefineRole;
  readonly signal: AbortSignal;
  readonly handleAction: (action: RefineTransportAction) => Promise<void>;
}

/**
 * Presentation choice made on the remote surface. `finalize` is only present for
 * `apply`: Flow emits the business terminal after the PlanStore commit, never
 * from the presentation layer.
 */
export type RefineTransportResult = {
  readonly action: "apply" | "discard" | "cancel";
  readonly turnId?: string;
  readonly terminal?: RefineTransportTerminal;
};

export type RefineTransportCancelReason =
  | "tui_answered"
  | "cancelled"
  | "aborted"
  | "transport_error";

export interface RefineTransportHandle {
  readonly promise: Promise<RefineTransportResult>;
  /** Push one authoritative presentation event; Flow has already sequenced it. */
  emit(event: RefineTransportEvent): void;
  /** Complete the caller's presentation choice without closing the session. */
  finish(result: RefineTransportResult): void;
  cancel(reason: RefineTransportCancelReason): void | Promise<void>;
}

export interface RefineTransport {
  open(request: RefineTransportRequest): RefineTransportHandle | undefined;
}

const registryKey = Symbol.for("pi-maestro-flow.refine-transports");

interface RefineTransportRegistry {
  transports: RefineTransport[];
}

function registry(): RefineTransportRegistry {
  const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globals[registryKey] as RefineTransportRegistry | undefined;
  if (existing) return existing;
  const created: RefineTransportRegistry = { transports: [] };
  globals[registryKey] = created;
  return created;
}

/** Register an optional external Refine transport and return its disposer. */
export function registerRefineTransport(transport: RefineTransport): () => void {
  const state = registry();
  if (!state.transports.includes(transport)) state.transports.push(transport);
  return () => {
    const index = state.transports.indexOf(transport);
    if (index >= 0) state.transports.splice(index, 1);
  };
}

export function getRefineTransports(): readonly RefineTransport[] {
  return [...registry().transports];
}

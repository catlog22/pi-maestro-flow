/**
 * The backend seam: what an execution backend must provide, and what the host
 * lends it.
 *
 * Boundary rule (load-bearing): a capability is something the *orchestrator can
 * request* — it is named by a `TaskSpec` field or a teammate-send mode. How a
 * backend gets the work done is an implementation detail and never appears
 * here. IPC relays, wire formats, and process layout are therefore absent by
 * construction, not by omission.
 *
 * Types only; this module contains no runtime code.
 */

import type {
  ControlMode,
  SingleResult,
  TeammateRunSpec,
} from "./spec.ts";

/**
 * How completely a backend serves one capability.
 *
 * `emulated` exists so a backend lacking a native contract can still serve the
 * request through host-side compensation (for example, appending a schema
 * instruction to the prompt and extracting the value from the final text).
 * Emulation is always recorded on the result — a degraded path must never be
 * indistinguishable from a native one.
 */
export type CapabilitySupport = "native" | "emulated" | "unsupported";

/**
 * The capability set, derived from orchestrator-visible surface only.
 *
 * Each member corresponds to a `TaskSpec` field or a teammate-send control
 * mode. Adding a member requires a matching orchestrator-visible input;
 * a purely internal concern does not belong here.
 */
export interface BackendCapabilities {
  /** `TaskSpec.outputSchema` — a validated machine-readable result. */
  outputSchema: CapabilitySupport;
  /** `TaskSpec.context: "fork"` — the child inherits parent conversation history. */
  forkContext: CapabilitySupport;
  /** teammate-send `steer` — interrupt the current turn and inject. */
  steer: CapabilitySupport;
  /** teammate-send `follow_up` — queue for the next turn. */
  followUp: CapabilitySupport;
  /** Cancel a running task. */
  abort: CapabilitySupport;
  /** Restrict the child's visible tool set. */
  toolFilter: CapabilitySupport;
}

/** Capability names, for diagnostics that must name the failing member. */
export type CapabilityName = keyof BackendCapabilities;

/**
 * Host-owned abilities a backend may borrow.
 *
 * These are passed as closures rather than declared as interface methods
 * precisely because backends satisfy them by different mechanisms, or not at
 * all: a subprocess backend may relay a permission question to the parent UI,
 * while an out-of-process peer runtime resolves permission from its own
 * configuration and never calls back. A backend that does not need one simply
 * ignores it.
 */
export interface BackendHostCapabilities {
  requestPermission?(request: {
    toolName: string;
    detail: string;
    correlationId: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
  proxyToolCall?(request: {
    toolName: string;
    args: unknown;
    correlationId: string;
  }): Promise<unknown>;
}

/** Everything a backend needs beyond the run spec itself. */
export interface BackendRunOptions {
  correlationId: string;
  baseCwd: string;
  signal?: AbortSignal;
  /** Advisory progress sink; a throwing observer must never interrupt the run. */
  onProgress?: (data: Record<string, unknown>) => void;
  host: BackendHostCapabilities;
  /** Backend-specific settings, opaque to the registry and to every other backend. */
  config?: Record<string, unknown>;
}

/**
 * A started run.
 *
 * `start()` resolves once the run is live, not once it finishes, because
 * teammate-send addresses running tasks by name and needs the control channel
 * while `result` is still pending.
 */
export interface BackendRun {
  /** Settles with the run's outcome; rejects only on backend-internal faults. */
  readonly result: Promise<SingleResult>;
  /** Returns false when the backend cannot deliver the message. */
  send(message: string, mode: ControlMode): boolean;
  abort(): void;
}

/** One execution backend. */
export interface TeammateBackend {
  readonly name: string;
  /** Protocol version this backend implements; the registry rejects a mismatch. */
  readonly protocolVersion: 1;
  readonly capabilities: BackendCapabilities;
  start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun>;
}

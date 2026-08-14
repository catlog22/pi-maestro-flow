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
 * The capability set, derived exhaustively from orchestrator-visible surface.
 *
 * Every `TaskSpec` field and teammate-send control mode that a backend could
 * fail to honour has a member here. The set is exhaustive by construction: a
 * field with no member would be one a backend could ignore without the
 * orchestrator ever learning of it, which is the exact failure this table
 * exists to prevent.
 *
 * Declaring a capability is not a restriction. A backend that serves the whole
 * surface declares every member `native` and loses nothing; the table's purpose
 * is to force a backend that *cannot* serve one to say so.
 */
export interface BackendCapabilities {
  /** `TaskSpec.outputSchema` — a validated machine-readable result. */
  outputSchema: CapabilitySupport;
  /** `TaskSpec.context: "fork"` — the child inherits parent conversation history. */
  forkContext: CapabilitySupport;
  /** `TaskSpec.model` — honour the requested provider/model route. */
  modelSelection: CapabilitySupport;
  /** `TaskSpec.fallbackModels` — ordered failover after a route fails. */
  modelFallback: CapabilitySupport;
  /** `TaskSpec.thinking` — per-task reasoning depth. */
  thinkingLevel: CapabilitySupport;
  /** `TaskSpec.maxNestingDepth` — enforce the child's own delegation budget. */
  nestingBudget: CapabilitySupport;
  /** `TaskSpec.todo` — bind Todo ids and inject them into the child's context. */
  todoBinding: CapabilitySupport;
  /** `TaskSpec.cwd` — run in the requested working directory. */
  workdir: CapabilitySupport;
  /** Restrict the child's visible tool set. */
  toolFilter: CapabilitySupport;
  /** teammate-send `steer` — interrupt the current turn and inject. */
  steer: CapabilitySupport;
  /** teammate-send `follow_up` — queue for the next turn. */
  followUp: CapabilitySupport;
  /** Cancel a running task. */
  abort: CapabilitySupport;
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
  /**
   * Backend-specific settings, opaque to the registry and to every other
   * backend.
   *
   * Provider credentials are deliberately not modelled here and are not the
   * host's concern: a backend that drives an external runtime lets that runtime
   * resolve its own credentials through its own configuration. Reading a
   * provider key in this process to hand it downward would duplicate a
   * resolution the child already owns and would put a secret on a path that has
   * no reason to carry one.
   */
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

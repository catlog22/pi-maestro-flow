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
 * The seam is bidirectional. A backend is called downward with a run spec, and
 * must report upward the facts the host's failover decision consumes. Those
 * facts are explicit members of the settled outcome rather than an out-of-band
 * channel, because a backend that omits them silently loses failover for every
 * task it serves — with no error, no warning, and nothing in the transcript.
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
 * The capability set: orchestrator-requestable behaviour a backend could fail
 * to honour.
 *
 * Membership is decided by one question — can a backend ignore this and leave
 * the orchestrator none the wiser? A `TaskSpec` field the host resolves and
 * enforces before dispatch fails that test and is absent here: `fallbackModels`
 * is sequenced by the host across attempts, `maxNestingDepth` is checked
 * host-side before a child is started, and `cwd` is resolved host-side and
 * passed already-absolute. A backend cannot violate them, so declaring support
 * for them would be a claim about nothing.
 *
 * Declaring a capability is not a restriction. A backend that serves the whole
 * surface declares every member `native` and loses nothing; the table's purpose
 * is to force a backend that *cannot* serve one to say so.
 */
export interface BackendCapabilities {
  /** `TaskSpec.outputSchema` — a validated machine-readable result. */
  outputSchema: CapabilitySupport;
  /**
   * `TaskSpec.context: "fork"` — the child inherits parent conversation history.
   *
   * Permanently `unsupported` for any backend that is not the Pi subprocess, and
   * the limit is semantic rather than protocol-level: a Pi history entry records
   * what a specific runtime did with a specific tool set. Replaying it into a
   * runtime with different tools, a different permission model, and a different
   * skill set hands the model a capability illusion — it will cite tool call ids
   * that never existed and assume file handle state that was never established.
   * A more faithful translation makes the illusion stronger, not weaker.
   *
   * Absence degrades rather than rejects; see `DegradableCapability` in
   * `./registry.ts`.
   */
  forkContext: CapabilitySupport;
  /** `TaskSpec.model` — honour the requested provider/model route. */
  modelSelection: CapabilitySupport;
  /** `TaskSpec.thinking` — per-task reasoning depth. */
  thinkingLevel: CapabilitySupport;
  /** `TaskSpec.todo` — bind Todo ids and expose the `todo` tool to the child. */
  todoBinding: CapabilitySupport;
  /** Restrict the child's visible tool set. */
  toolFilter: CapabilitySupport;
  /**
   * teammate-send `steer` — interrupt the current turn and inject.
   *
   * A backend without mid-turn cancellation may serve this `emulated` by
   * queueing the message and applying it at the next turn boundary. That is a
   * real behavioural difference — the injection lands later than asked — which
   * is exactly why it is recorded on the result instead of being silently
   * indistinguishable from native steering.
   */
  steer: CapabilitySupport;
  /** teammate-send `follow_up` — queue for the next turn. */
  followUp: CapabilitySupport;
  /** Cancel a running task. */
  abort: CapabilitySupport;
}

/** Capability names, for diagnostics that must name the failing member. */
export type CapabilityName = keyof BackendCapabilities;

/**
 * How a backend recovers after an attempt fails, which decides whether the
 * host's side-effect replay fence applies to it.
 *
 * `replay` — recovery re-runs the task from its original prompt. Side effects of
 * the failed attempt are invisible to the retry, so a completed tool call can be
 * repeated. The fence applies: recovery is unsafe once tools have completed or
 * their effects are unknown.
 *
 * `in-context-continuation` — recovery resumes the interrupted conversation in
 * place, so completed tool calls remain in history and are not re-executed. The
 * fence does not apply; it may still be recorded for diagnostics.
 *
 * This distinction is the seam's real parameter. Treating the fence as a
 * property of backend identity rather than of recovery shape forces every
 * backend into the replay assumption and then rejects the ones the fence cannot
 * clear — demoting a backend that was never unsafe.
 */
export type RecoveryShape = "replay" | "in-context-continuation";

/**
 * How authoritatively the backend established that the turn ended.
 *
 * `authoritative` — the backend emitted an explicit turn-end signal.
 * `inferred` — settlement was deduced from a weaker signal such as process exit.
 * `unknown` — the backend could not establish it at all.
 */
export type SettlementAuthority = "authoritative" | "inferred" | "unknown";

/**
 * What the host's failover decision reads from a failed attempt.
 *
 * Every field describes observed side-effect risk, not backend preference: the
 * host decides whether recovery is safe, and the backend only reports what it
 * saw. Counts are of tool calls this attempt actually observed.
 */
export interface AttemptRecoveryFacts {
  settlementAuthority: SettlementAuthority;
  /** Tool calls that ran to completion, whose effects a replay would repeat. */
  completedToolCount: number;
  /** Tool calls still outstanding at failure, whose effects are unknown. */
  inFlightToolCount: number;
  /** The attempt died before any model or tool activity — nothing to replay. */
  preActivityInfrastructureExit: boolean;
  /** Effects were observed outside this attempt's own tool accounting. */
  externalReplayRisk: boolean;
}

/**
 * Whether the backend confirmed release of the failed attempt's execution
 * resources.
 *
 * The host blocks recovery on `unreaped` so a stale runtime cannot deliver
 * callbacks into the replacement attempt. `reason` is diagnostic only.
 */
export type AttemptReclamation =
  | { status: "reclaimed" }
  | { status: "unreaped"; reason: string };

/**
 * One settled attempt.
 *
 * `reclamation` stays a promise because the host awaits it only on the failover
 * path, and that await serialises attempts: the replacement must not start while
 * the failed runtime may still be alive.
 */
export interface AttemptOutcome {
  result: SingleResult;
  recovery: AttemptRecoveryFacts;
  reclamation: Promise<AttemptReclamation>;
}

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
  /**
   * Run a host-implemented tool on the child's behalf.
   *
   * Tools the host owns rather than the runtime — `todo` and `browser` today —
   * reach a child only through this closure. A backend that accepts a `todos`
   * binding but never exposes the tool leaves the queue stalled at
   * `in_progress` while the host has already reassigned the item.
   */
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
   * The complete system prompt for this run.
   *
   * Assembled entirely by the host. Pi additionally appends model and agent
   * catalogues from inside the child through an extension event, which no other
   * runtime has; a backend receiving only the outer prompt would start a child
   * that cannot see the model catalogue and therefore cannot delegate further.
   */
  systemPrompt: string;
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
 * while `outcome` is still pending.
 */
export interface BackendRun {
  /** Settles with the attempt outcome; rejects only on backend-internal faults. */
  readonly outcome: Promise<AttemptOutcome>;
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
  /** Decides whether the host's replay fence gates this backend's failover. */
  readonly recoveryShape: RecoveryShape;
  start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun>;
}

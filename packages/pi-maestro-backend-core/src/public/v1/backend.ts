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
  AgentTerminalStatus,
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
 * How a backend recovers after an attempt fails.
 *
 * `replay` — recovery re-runs the task from its original prompt. Side effects of
 * the failed attempt are invisible to the retry, so a completed tool call can be
 * repeated.
 *
 * `in-context-continuation` — the backend can resume an interrupted conversation
 * in place, keeping completed tool calls in history rather than re-executing
 * them.
 *
 * This describes the backend, not the recovery the host performs. The host's
 * only recovery is a fresh attempt under the next model candidate, which starts
 * a new run with a new correlation id — a replay whichever value a backend
 * declares. The side-effect fence therefore gates every backend, and declaring
 * `in-context-continuation` neither clears it nor may be read as clearing it.
 * Honouring the declaration requires a host path that resumes the failed run's
 * own session; until one exists this value is descriptive only.
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

/** Value kinds a backend configuration field may hold. */
export type ConfigValue = string | number | boolean | readonly string[];

/**
 * One configuration field a backend declares for itself.
 *
 * A field that selects a credential uses `kind: "credential-ref"` and carries
 * the lookup name rather than the value. That is not host policy imposed on
 * backends: the DeepSeek adapter already models its key as a credential
 * reference for the same reason, so that one request can never pair one
 * generation's endpoint with another generation's secret.
 *
 * Backends differ in what they need to be told — a subprocess runtime needs an
 * executable and a config path, a remote peer needs an endpoint, a
 * profile-based runtime needs a profile name. Rather than widen the seam with
 * a union of every backend's settings, each backend publishes its own fields
 * and the host renders and validates them generically.
 *
 * Declaring fields is what makes a backend's configuration checkable at load
 * and editable in the settings shell. An undeclared key in a registration is a
 * load-time error, not a value the backend silently ignores.
 */
export interface BackendConfigField {
  /** Key under `BackendRegistration.config`. */
  key: string;
  kind:
    | "text"
    | "integer"
    | "number"
    | "boolean"
    | "enum"
    | "string-list"
    | "path"
    | "credential-ref";
  /** i18n key for the field label; the host owns presentation. */
  labelKey: string;
  descriptionKey?: string;
  /** Allowed values for `kind: "enum"`. */
  options?: readonly { value: string; labelKey: string }[];
  /** Applied by `resolveConfig` when the registration omits the key. */
  default?: ConfigValue;
  /** A missing value with no default is a load-time error. */
  required?: boolean;
  /**
   * For `kind: "credential-ref"`, where the host must put the secret.
   *
   * The field itself holds the name of that location, never the secret, so a
   * registration document can be committed and a settings editor can display
   * the value in full. Masking a stored secret only hides it on screen; storing
   * a reference means there is nothing to hide.
   *
   * `env-file-key` — a key in the runtime's own env file, which the runtime
   * loads for itself. This is the only location a host can serve without taking
   * custody of a provider credential.
   *
   * `env-var` — a variable in the runtime process's environment. A host that
   * does not construct that environment cannot serve it, and must reject the
   * registration rather than write the secret somewhere else.
   */
  credentialLocation?: "env-var" | "env-file-key";
}

/**
 * A backend's configuration after validation and defaulting.
 *
 * Resolution is a distinct step rather than a `?? default` inside `start()`, so
 * an `auto` mode resolves to a concrete choice that the host can log, display,
 * and reproduce. A run whose effective mode is only knowable by re-deriving it
 * inside the backend is a run nobody can explain afterwards.
 */
export interface ResolvedBackendConfig {
  /** Every declared key, with defaults applied. */
  values: Record<string, ConfigValue>;
  /** Load-time rejections; a non-empty list stops registration. */
  errors: readonly string[];
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
  /**
   * The host's base working directory.
   *
   * The directory a task's own `cwd` was resolved against, not the run's
   * effective directory: a backend runs in `spec.cwd` when the task named one
   * and falls back to this. Passing the resolved task cwd here as well would
   * give the same fact two homes, and a backend author no way to tell which one
   * a task-level `cwd` actually reached.
   */
  baseCwd: string;
  signal?: AbortSignal;
  /** Advisory progress sink; a throwing observer must never interrupt the run. */
  onProgress?: (data: Record<string, unknown>) => void;
  /**
   * The child runtime's own event stream, forwarded verbatim.
   *
   * Distinct from `onProgress`: progress is advisory display, while these are
   * the events the host records and replays. A backend that emits no event
   * stream simply never calls it.
   */
  onChildEvent?: (event: Record<string, unknown>) => void;
  /**
   * The turn settled, before the outcome is returned.
   *
   * The host buffers completions across a model-candidate sweep and publishes
   * only the surviving one, so it must learn of settlement while it can still
   * discard it — which the returned outcome is too late for.
   */
  onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
  host: BackendHostCapabilities;
  /**
   * The complete system prompt, when the host assembled it.
   *
   * Omitted only for a backend that assembles its own from the agent definition.
   * Prompt assembly currently happens in two places: the host writes a prompt
   * file, and Pi appends model and agent catalogues from inside the child
   * through an extension event no other runtime has. Until that second half
   * moves up, an external runtime given only the outer prompt starts a child
   * that cannot see the model catalogue and therefore cannot delegate further.
   */
  systemPrompt?: string;
  /**
   * This backend's own settings, already validated and defaulted by
   * `resolveConfig`, so `start()` reads concrete values and never re-derives an
   * `auto` choice.
   *
   * Provider credentials are deliberately not modelled here and are not the
   * host's concern: a backend that drives an external runtime lets that runtime
   * resolve its own credentials through its own configuration. Reading a
   * provider key in this process to hand it downward would duplicate a
   * resolution the child already owns and would put a secret on a path that has
   * no reason to carry one.
   */
  config: Record<string, ConfigValue>;
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
  /**
   * Deliver a live control message; false when the backend cannot.
   *
   * The teammate host addresses a running agent by writing control lines to a
   * pipe. A backend that publishes no pipe of its own is handed one that
   * translates those lines into this call, so implementing this method is all a
   * backend needs to be addressable — and returning false is how it declines a
   * message the host would otherwise report as delivered.
   */
  send(message: string, mode: ControlMode): boolean;
  abort(): void;
}

/** One execution backend. */
export interface TeammateBackend {
  readonly name: string;
  /** Protocol version this backend implements; the registry rejects a mismatch. */
  readonly protocolVersion: 1;
  readonly capabilities: BackendCapabilities;
  /** How this backend would recover; descriptive, and never clears the host fence. */
  readonly recoveryShape: RecoveryShape;
  /** Settings this backend accepts; omitted means it takes none. */
  readonly configFields?: readonly BackendConfigField[];
  /**
   * Validate a registration's config and apply defaults.
   *
   * Called once at registration, never per run. A backend declaring
   * `configFields` must implement this; the registry treats a missing
   * implementation alongside declared fields as a registration error rather
   * than skipping validation.
   */
  resolveConfig?(config: Record<string, ConfigValue>): ResolvedBackendConfig;
  start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun>;
}

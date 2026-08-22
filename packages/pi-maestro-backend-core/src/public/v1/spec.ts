/**
 * Backend-facing run contract — the exact input/output of one teammate task
 * execution, independent of which backend performs it.
 *
 * Types only. This module contains no runtime code so the package stays a pure
 * contract that any package may import without pulling in an implementation.
 */

/** Token and cost accounting for one settled run. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  turns: number;
}

/** Canonical lifecycle outcome; cancellation must never be inferred from `exitCode`. */
export type AgentTerminalStatus = "completed" | "failed" | "terminated";

/** Reasoning-depth request forwarded to the backend. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Session-history disposition for one task. */
export type RunContext = "fresh" | "fork";

/**
 * What the orchestrator asks a backend to run.
 *
 * Every field here is orchestrator-visible: it originates in a `TaskSpec` field
 * the model may set. Transport details (stdio layout, wire format, extension
 * loading, IPC channels) are deliberately absent — those belong to whichever
 * backend serves the request.
 *
 * Host-enforced fields are absent too. `fallbackModels`, `maxNestingDepth`, and
 * `cwd` are resolved and enforced by the orchestrator before any backend is
 * reached, so a backend neither declares support for them nor implements them.
 */
export interface TeammateRunSpec {
  agent: string;
  task: string;
  name?: string;
  /**
   * Registered backend name serving this task; the registry's default when
   * absent.
   *
   * Per-task rather than per-deployment because backends differ in what they
   * can do, not only in where they run: a deployment registering one backend
   * for code edits and another for long research picks between them the same
   * way it picks a model. A name that is not registered fails the dispatch
   * rather than falling back, so a typo cannot silently route elsewhere.
   */
  backend?: string;
  context?: RunContext;
  /** The single model for this attempt; the host owns the fallback sequence. */
  model?: string;
  thinking?: ThinkingLevel;
  /** Working directory, already resolved against the host's base cwd. */
  cwd?: string;
  outputSchema?: Record<string, unknown>;
  /** Todo task ids bound to this agent; injected into the child's prompt. */
  todos?: string[];
}

/**
 * How a backend delivered a capability it was asked for.
 *
 * `emulated` is recorded per run rather than inferred from the backend name, so
 * a consumer reading a result can always tell whether a structured value came
 * from a native contract or from host-side extraction.
 *
 * `withheld` records a capability the backend can serve but did not exercise on
 * this run because a host fence stopped it — the model-fallback replay fence is
 * the current instance. Without this state a fenced run is indistinguishable
 * from one whose backend simply never needed the capability.
 */
export interface CapabilityDelivery {
  capability: string;
  support: "native" | "emulated" | "withheld";
  /** Why the emulated or withheld path was taken. */
  note?: string;
}

/** Closed, descriptive transport metadata safe to expose on settled results. */
export type TeammateExecutionTransport =
  | { kind: "local-process"; protocol: "pi-rpc" | "json-rpc-stdio" | "acp" }
  | { kind: "acp-direct-ssh"; protocol: "acp" }
  | { kind: "dsh-direct-ssh"; protocol: "json-rpc-stdio" }
  | {
      kind: "remote-worker";
      gateway: "ssh";
      protocol: "remote/2";
      driver: "pi-rpc" | "acp";
    }
  | { kind: "adapter-owned" };

/** Secret-free identity of the pinned model-registry route that settled a run. */
export interface TeammateExecutionProvenance {
  registryVersion: number;
  registryRevision: number;
  registryHash: string;
  modelRegistrationId: string;
  modelId: string;
  deploymentId: string;
  harness: "pi" | "dsh" | "acp" | "adapter-owned";
  transport: TeammateExecutionTransport;
}

/** One settled task execution. */
export interface SingleResult {
  agent: string;
  /** Optional dispatch name shown in compact completion rows. */
  name?: string;
  task: string;
  exitCode: number;
  messages: Array<{ role: string; content: string }>;
  usage: Usage;
  model: string;
  correlationId: string;
  /** Unique identity of one published turn; stable across its compatibility projections. */
  publicationId?: string;
  /** Resolved task cwd used for durable result projection. */
  originCwd?: string;
  durationMs: number;
  /** Number of child tool completions observed before this result settled. */
  toolCount?: number;
  /** Whether the child remains available for teammate-send after this turn. */
  wakeable?: boolean;
  /**
   * The final assistant result is available, but the backend has not yet emitted
   * its authoritative lifecycle confirmation.
   */
  lifecyclePending?: boolean;
  terminalStatus?: AgentTerminalStatus;
  structuredOutput?: unknown;
  attemptedModels?: string[];
  /** Advisory dispatch diagnostics that do not change the terminal outcome. */
  warnings?: string[];
  /**
   * Which backend served this run, and every capability it satisfied by
   * emulation, or withheld under a fence, rather than natively. Populated by the
   * registry, never by the backend alone, so an omitted entry cannot silently
   * mean "native".
   */
  backend?: string;
  capabilityDeliveries?: CapabilityDelivery[];
  /** Pinned model-registry route identity; absent in legacy/backend-registry mode. */
  provenance?: TeammateExecutionProvenance;
}

/** Live control messages an orchestrator may send to a running task. */
export type ControlMode = "prompt" | "follow_up" | "steer";

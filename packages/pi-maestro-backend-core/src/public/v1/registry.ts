/**
 * Backend registration and capability adjudication.
 *
 * Registration is explicit configuration, never discovery by package-name
 * convention: a referenced backend that cannot be loaded is a hard failure, not
 * a silent fallback to the default.
 *
 * Types only; this module contains no runtime code.
 */

import type { BackendCapabilities, CapabilityName, TeammateBackend } from "./backend.ts";
import type { TeammateRunSpec } from "./spec.ts";

/**
 * Which dispatch path teammate takes.
 *
 * `legacy` — the historical path, unchanged and unaware of backends. It stays
 * the default so installing the registry cannot alter behaviour on its own;
 * opting in is an explicit act, and reverting is a settings change rather than
 * a downgrade.
 *
 * `backend-registry` — dispatch resolves a backend per task through
 * {@link BackendRegistry}. The Pi subprocess is registered as an ordinary
 * backend here, not as a bypass, so the seam is exercised by the default
 * deployment instead of only by third parties.
 */
export type TeammateExecutionMode = "legacy" | "backend-registry";

/** One entry of the backend registration document. */
export interface BackendRegistration {
  /** Module specifier resolved by the loader. */
  module: string;
  /** Passed verbatim to the backend; the registry never inspects it. */
  config?: Record<string, unknown>;
}

/** The backend registration document (`.pi/teammate-backends.json`). */
export interface BackendRegistryConfig {
  /** Backend used when a task names none. */
  default: string;
  backends: Record<string, BackendRegistration>;
}

/** Resolved backend plus the opaque config its registration carried. */
export interface ResolvedBackend {
  backend: TeammateBackend;
  config?: Record<string, unknown>;
}

/**
 * Which capabilities one task actually requires.
 *
 * Derived from the run spec plus the control modes the dispatch may use, so the
 * requirement set is a pure function of orchestrator-visible input.
 */
export interface RequiredCapabilities {
  required: CapabilityName[];
}

/**
 * Capabilities whose absence degrades the run instead of rejecting the graph.
 *
 * `forkContext` is the only member: a task that asked to inherit parent history
 * still runs correctly from a fresh context, so refusing the whole graph would
 * be a harsher answer than the request warrants. Every other capability either
 * changes the result the orchestrator will read or has no meaningful fallback.
 *
 * Degradation is never silent. The existing fork degradation path fires on
 * "parent session file unavailable" and writes a transcript notice; that trigger
 * cannot detect this case, because a backend-capability degradation happens
 * while the parent session file exists and is perfectly readable — by a runtime
 * that cannot interpret it. Backend-capability degradation therefore needs its
 * own branch reaching the same transcript exit.
 */
export type DegradableCapability = "forkContext";

/** One task's capability adjudication against its resolved backend. */
export interface CapabilityVerdict {
  taskIndex: number;
  taskName?: string;
  backendName: string;
  /** Capabilities the backend cannot serve at all — these reject the graph. */
  unsupported: CapabilityName[];
  /** Unsupported but degradable — the run proceeds with a recorded notice. */
  degraded: DegradableCapability[];
  /** Capabilities served by host-side compensation — allowed, and recorded. */
  emulated: CapabilityName[];
}

/**
 * Whole-graph adjudication, produced during graph validation rather than at
 * dispatch.
 *
 * Checking at dispatch is too late: a task declaring `outputSchema` whose
 * downstream sibling reads `{name.field}` would burn a full model turn before
 * the missing capability surfaced.
 */
export interface CapabilityValidation {
  verdicts: CapabilityVerdict[];
  /** Non-empty when at least one task requires an unsupported capability. */
  errors: string[];
  /** Advisory notices for emulated and degraded capabilities; these never reject. */
  warnings: string[];
}

/** Contract for the component that owns loading and adjudication. */
export interface BackendRegistry {
  resolve(spec: TeammateRunSpec, requestedBackend?: string): Promise<ResolvedBackend>;
  capabilitiesOf(backendName: string): Promise<BackendCapabilities>;
  listBackendNames(): string[];
  defaultBackendName(): string;
}

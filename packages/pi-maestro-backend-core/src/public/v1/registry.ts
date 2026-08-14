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

/** One task's capability adjudication against its resolved backend. */
export interface CapabilityVerdict {
  taskIndex: number;
  taskName?: string;
  backendName: string;
  /** Capabilities the backend cannot serve at all — these reject the graph. */
  unsupported: CapabilityName[];
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
  /** Advisory notices for emulated capabilities; these never reject. */
  warnings: string[];
}

/** Contract for the component that owns loading and adjudication. */
export interface BackendRegistry {
  resolve(spec: TeammateRunSpec, requestedBackend?: string): Promise<ResolvedBackend>;
  capabilitiesOf(backendName: string): Promise<BackendCapabilities>;
  listBackendNames(): string[];
  defaultBackendName(): string;
}

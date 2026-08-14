/**
 * v1 barrel.
 *
 * Prefer the narrow subpaths (`pi-maestro-backend-core/v1/spec`,
 * `/v1/backend`, `/v1/registry`) over this barrel: importing the barrel drags
 * every contract into a consumer that usually needs one of them.
 */

export type {
  AgentTerminalStatus,
  CapabilityDelivery,
  ControlMode,
  RunContext,
  SingleResult,
  TeammateRunSpec,
  ThinkingLevel,
  Usage,
} from "./spec.ts";

export type {
  BackendCapabilities,
  BackendHostCapabilities,
  BackendRun,
  BackendRunOptions,
  CapabilityName,
  CapabilitySupport,
  TeammateBackend,
} from "./backend.ts";

export type {
  BackendRegistration,
  BackendRegistry,
  BackendRegistryConfig,
  CapabilityValidation,
  CapabilityVerdict,
  RequiredCapabilities,
  ResolvedBackend,
} from "./registry.ts";

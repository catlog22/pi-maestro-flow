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
  AttemptOutcome,
  AttemptReclamation,
  AttemptRecoveryFacts,
  BackendCapabilities,
  BackendHostCapabilities,
  BackendRun,
  BackendRunOptions,
  CapabilityName,
  CapabilitySupport,
  RecoveryShape,
  SettlementAuthority,
  TeammateBackend,
} from "./backend.ts";

export type {
  BackendRegistration,
  BackendRegistry,
  BackendRegistryConfig,
  CapabilityValidation,
  CapabilityVerdict,
  DegradableCapability,
  RequiredCapabilities,
  ResolvedBackend,
  TeammateExecutionMode,
} from "./registry.ts";

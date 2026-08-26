import {
  createRuntimeActorHost as createInternalRuntimeActorHost,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
  type RuntimeActorRegistration,
} from "../../runtime-broker/actor-host.ts";
import type { RuntimeBrokerClientOptions } from "../../runtime-broker/client.ts";
import type { RuntimeBrokerMode } from "../../runtime-broker/rollout.ts";

/** Stable Runtime Broker client, capability, actor-host contract, and transport boundary. */
export {
  DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS,
  DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
} from "../../runtime-broker/actor-host.ts";
export type { RuntimeActorHostClient, RuntimeActorLease, RuntimeActorRegistration };

export interface RuntimeActorHostClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mode?: RuntimeBrokerMode;
  stateDirectory?: string;
  clientOptions?: RuntimeBrokerClientOptions;
}

export function createRuntimeActorHost(options: RuntimeActorHostClientOptions = {}): RuntimeActorHostClient {
  return createInternalRuntimeActorHost(options);
}

export * from "../../runtime-broker/contracts.ts";
export {
  RuntimeBrokerClient,
  type RuntimeBrokerClientOptions,
} from "../../runtime-broker/client.ts";
export {
  probeRuntimeBrokerCapability,
  type RuntimeBrokerCapability,
} from "../../runtime-broker/capability.ts";
export {
  RUNTIME_BROKER_ENV_VAR,
  createRuntimeTransport,
  parseRuntimeBrokerMode,
  runtimeBrokerModeFromEnv,
  selectRuntimeTransport,
  type RuntimeBrokerMode,
  type RuntimeTransportRolloutOptions,
  type RuntimeTransportSelection,
} from "../../runtime-broker/rollout.ts";
export type {
  RuntimeTransport,
  RuntimeTransportDeliveryMode,
  RuntimeTransportDeliveryState,
  RuntimeTransportDispatch,
  RuntimeTransportDriver,
  RuntimeTransportEnqueueFailureCode,
  RuntimeTransportEnqueueRequest,
  RuntimeTransportEnqueueResult,
  RuntimeTransportFactory,
  RuntimeTransportMessage,
  RuntimeTransportMessageKind,
  RuntimeTransportPriority,
  SqliteRuntimeTransportClient,
} from "../../runtime-broker/transport.ts";

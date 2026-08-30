import type { RuntimeBrokerMode } from "../runtime-broker/rollout.ts";
import type { SessionEndpoint } from "../sessions/session-core.ts";
import { type SessionDomainReadModelSnapshotV2, type SessionShadowComparisonV2 } from "./session-domain.ts";
export declare const SESSION_RUNTIME_V2_READ_ENV: "PI_TEAMMATE_SESSION_V2_READ";
export declare const SESSION_RUNTIME_V2_OUTBOX_ENV: "PI_TEAMMATE_SESSION_V2_OUTBOX";
export type SessionRuntimeV2RolloutMode = "disabled" | "shadow" | "canonical";
export interface SessionRuntimeV2RolloutDecision {
    read: SessionRuntimeV2RolloutMode;
    outbox: SessionRuntimeV2RolloutMode;
    requestedRead: SessionRuntimeV2RolloutMode;
    requestedOutbox: SessionRuntimeV2RolloutMode;
    reasons: readonly string[];
}
export declare function parseSessionRuntimeV2RolloutMode(value: unknown): SessionRuntimeV2RolloutMode;
/** Canonical authority requires SQLite; unsupported canonical requests fall back to advisory shadow. */
export declare function resolveSessionRuntimeV2Rollout(env: NodeJS.ProcessEnv | undefined, brokerMode: RuntimeBrokerMode): SessionRuntimeV2RolloutDecision;
export declare function sessionReadAuthority(decision: SessionRuntimeV2RolloutDecision, shadowMatches: boolean): "v1" | "runtime-v2";
export interface SessionEndpointReadSelectionV2 {
    source: "v1" | "runtime-v2";
    endpoints: readonly SessionEndpoint[];
    comparison: SessionShadowComparisonV2;
}
export declare function selectSessionEndpointReadModelV2(decision: SessionRuntimeV2RolloutDecision, v1: readonly SessionEndpoint[], v2: SessionDomainReadModelSnapshotV2 | undefined): SessionEndpointReadSelectionV2;
export declare function sessionOutboxAuthority(decision: SessionRuntimeV2RolloutDecision, shadowMatches: boolean): "v1" | "runtime-v2";

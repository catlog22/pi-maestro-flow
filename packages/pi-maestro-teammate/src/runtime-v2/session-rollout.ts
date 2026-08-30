import type { RuntimeBrokerMode } from "../runtime-broker/rollout.ts";
import type { SessionEndpoint } from "../sessions/session-core.ts";
import {
  compareSessionEndpointShadowV2,
  sessionEndpointsFromReadModelV2,
  type SessionDomainReadModelSnapshotV2,
  type SessionShadowComparisonV2,
} from "./session-domain.ts";

export const SESSION_RUNTIME_V2_READ_ENV = "PI_TEAMMATE_SESSION_V2_READ" as const;
export const SESSION_RUNTIME_V2_OUTBOX_ENV = "PI_TEAMMATE_SESSION_V2_OUTBOX" as const;

export type SessionRuntimeV2RolloutMode = "disabled" | "shadow" | "canonical";

export interface SessionRuntimeV2RolloutDecision {
  read: SessionRuntimeV2RolloutMode;
  outbox: SessionRuntimeV2RolloutMode;
  requestedRead: SessionRuntimeV2RolloutMode;
  requestedOutbox: SessionRuntimeV2RolloutMode;
  reasons: readonly string[];
}

export function parseSessionRuntimeV2RolloutMode(value: unknown): SessionRuntimeV2RolloutMode {
  if (typeof value !== "string") return "disabled";
  const normalized = value.trim().toLowerCase();
  return normalized === "shadow" || normalized === "canonical" ? normalized : "disabled";
}

/** Canonical authority requires SQLite; unsupported canonical requests fall back to advisory shadow. */
export function resolveSessionRuntimeV2Rollout(
  env: NodeJS.ProcessEnv = process.env,
  brokerMode: RuntimeBrokerMode,
): SessionRuntimeV2RolloutDecision {
  const requestedRead = parseSessionRuntimeV2RolloutMode(env[SESSION_RUNTIME_V2_READ_ENV]);
  const requestedOutbox = parseSessionRuntimeV2RolloutMode(env[SESSION_RUNTIME_V2_OUTBOX_ENV]);
  const reasons: string[] = [];
  const constrain = (requested: SessionRuntimeV2RolloutMode, surface: "read" | "outbox"): SessionRuntimeV2RolloutMode => {
    if (requested !== "canonical" || brokerMode === "sqlite") return requested;
    reasons.push(`${surface} canonical authority requires PI_RUNTIME_BROKER=sqlite; using shadow`);
    return "shadow";
  };
  return Object.freeze({
    read: constrain(requestedRead, "read"),
    outbox: constrain(requestedOutbox, "outbox"),
    requestedRead,
    requestedOutbox,
    reasons: Object.freeze(reasons),
  });
}

export function sessionReadAuthority(
  decision: SessionRuntimeV2RolloutDecision,
  shadowMatches: boolean,
): "v1" | "runtime-v2" {
  return decision.read === "canonical" && shadowMatches ? "runtime-v2" : "v1";
}

export interface SessionEndpointReadSelectionV2 {
  source: "v1" | "runtime-v2";
  endpoints: readonly SessionEndpoint[];
  comparison: SessionShadowComparisonV2;
}

export function selectSessionEndpointReadModelV2(
  decision: SessionRuntimeV2RolloutDecision,
  v1: readonly SessionEndpoint[],
  v2: SessionDomainReadModelSnapshotV2 | undefined,
): SessionEndpointReadSelectionV2 {
  const comparison = v2 === undefined
    ? Object.freeze({
        matches: false,
        missingFromV2: Object.freeze(v1.filter((endpoint) => endpoint.kind === "root").map((endpoint) => endpoint.id)),
        unexpectedInV2: Object.freeze([] as string[]),
        changed: Object.freeze([] as string[]),
      })
    : compareSessionEndpointShadowV2(v1, v2);
  const source = sessionReadAuthority(decision, comparison.matches);
  return Object.freeze({
    source,
    endpoints: source === "runtime-v2" && v2 ? sessionEndpointsFromReadModelV2(v2) : v1,
    comparison,
  });
}

export function sessionOutboxAuthority(
  decision: SessionRuntimeV2RolloutDecision,
  shadowMatches: boolean,
): "v1" | "runtime-v2" {
  return decision.outbox === "canonical" && shadowMatches ? "runtime-v2" : "v1";
}

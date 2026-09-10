/** Shared low-cardinality, redacted lifecycle observations and counters. */
import type { GatewayAuditSink } from "./audit.ts";
import { GATEWAY_TUNNEL_PHASES, type GatewayTunnelPhase } from "./tunnel/contracts.ts";

export type GatewayObservation =
  | { category: "tunnel"; event: "transition"; phase: GatewayTunnelPhase }
  | { category: "transport"; event: "connect"; transport: "https" | "stdio" }
  | { category: "transport"; event: "session-loss" }
  | { category: "transport"; event: "fallback" }
  | { category: "receipt"; event: "replay" | "conflict" | "outcome-unknown" }
  | { category: "stream"; event: "subscribe" | "gap" | "slow-consumer" }
  | { category: "lifecycle"; event: "quiesce" | "drain"; outcome: "started" | "completed" | "timeout" };

export interface GatewayObservationMetric {
  key: string;
  count: number;
}

export interface GatewayObservationSnapshot {
  version: 1;
  total: number;
  events: GatewayObservationMetric[];
}

export interface GatewayObservationSink {
  observe(observation: GatewayObservation): void;
}

/**
 * No free-form labels are accepted. Consequently both the serialized audit
 * shape and metric key space are bounded by the unions above.
 */
export class GatewayObserver implements GatewayObservationSink {
  private readonly counts = new Map<string, number>();
  private total = 0;

  constructor(private readonly audit?: GatewayAuditSink) {}

  observe(observation: GatewayObservation): void {
    const projected = projectGatewayObservation(observation);
    const key = observationKey(projected);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.total += 1;
    void this.audit?.writeObservation(projected).catch(() => undefined);
  }

  snapshot(): GatewayObservationSnapshot {
    return {
      version: 1,
      total: this.total,
      events: [...this.counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count })),
    };
  }
}

export function projectGatewayObservation(value: GatewayObservation): GatewayObservation {
  const observation = value as GatewayObservation & Record<string, unknown>;
  if (observation.category === "tunnel" && observation.event === "transition" && (GATEWAY_TUNNEL_PHASES as readonly unknown[]).includes(observation.phase)) {
    return { category: "tunnel", event: "transition", phase: observation.phase };
  }
  if (observation.category === "transport") {
    if (observation.event === "connect" && (observation.transport === "https" || observation.transport === "stdio")) return { category: "transport", event: "connect", transport: observation.transport };
    if (observation.event === "session-loss" || observation.event === "fallback") return { category: "transport", event: observation.event };
  }
  if (observation.category === "receipt" && (observation.event === "replay" || observation.event === "conflict" || observation.event === "outcome-unknown")) return { category: "receipt", event: observation.event };
  if (observation.category === "stream" && (observation.event === "subscribe" || observation.event === "gap" || observation.event === "slow-consumer")) return { category: "stream", event: observation.event };
  if (observation.category === "lifecycle" && (observation.event === "quiesce" || observation.event === "drain") && (observation.outcome === "started" || observation.outcome === "completed" || observation.outcome === "timeout")) {
    return { category: "lifecycle", event: observation.event, outcome: observation.outcome };
  }
  throw new Error("Unsupported Gateway observation");
}

function observationKey(observation: GatewayObservation): string {
  if (observation.category === "tunnel") return `tunnel.transition.${observation.phase}`;
  if (observation.category === "transport" && observation.event === "connect") return `transport.connect.${observation.transport}`;
  if (observation.category === "lifecycle") return `lifecycle.${observation.event}.${observation.outcome}`;
  return `${observation.category}.${observation.event}`;
}

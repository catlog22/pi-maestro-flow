/**
 * Supervision store — cockpit-side consumer of the unified SupervisionEvent
 * bus (`supervision:event`, published by the shared supervision layer in
 * pi-maestro-teammate and consumed by goal/monitor/advisor producers).
 *
 * Keeps a bounded recent-event ring plus aggregate counters, and renders a
 * compact footer status only while events exist. Pure and unit-testable.
 */

export const MAX_SUPERVISION_EVENTS = 50;

export const SUPERVISION_SOURCES = ["goal", "monitor", "advisor"] as const;
export const SUPERVISION_KINDS = ["evaluating", "verdict", "intervention", "notification"] as const;
export const SUPERVISION_SEVERITIES = ["info", "nit", "concern", "blocker"] as const;

export type SupervisionSource = (typeof SUPERVISION_SOURCES)[number];
export type SupervisionKind = (typeof SUPERVISION_KINDS)[number];
export type SupervisionSeverity = (typeof SUPERVISION_SEVERITIES)[number];

export interface SupervisionEventLike {
  source: SupervisionSource;
  kind: SupervisionKind;
  severity: SupervisionSeverity;
  target?: string;
  verdict?: { status: string; pass?: boolean };
  message?: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface SupervisionTotals {
  interventions: number;
  notifications: number;
  verdicts: number;
  evaluations: number;
}

/** Normalizes an unknown bus payload; returns undefined for malformed events. */
export function normalizeSupervisionEvent(payload: unknown): SupervisionEventLike | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const source = record.source;
  const kind = record.kind;
  const severity = record.severity;
  if (!SUPERVISION_SOURCES.includes(source as SupervisionSource)) return undefined;
  if (!SUPERVISION_KINDS.includes(kind as SupervisionKind)) return undefined;
  if (!SUPERVISION_SEVERITIES.includes(severity as SupervisionSeverity)) return undefined;
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : Date.now();
  const verdict = typeof record.verdict === "object" && record.verdict !== null
    ? { status: String((record.verdict as Record<string, unknown>).status ?? ""), pass: (record.verdict as Record<string, unknown>).pass === true }
    : undefined;
  return {
    source: source as SupervisionSource,
    kind: kind as SupervisionKind,
    severity: severity as SupervisionSeverity,
    target: typeof record.target === "string" ? record.target : undefined,
    verdict,
    message: typeof record.message === "string" ? record.message : undefined,
    timestamp,
    meta: typeof record.meta === "object" && record.meta !== null
      ? record.meta as Record<string, unknown>
      : undefined,
  };
}

export class SupervisionStore {
  private readonly events: SupervisionEventLike[] = [];
  private totals: SupervisionTotals = { interventions: 0, notifications: 0, verdicts: 0, evaluations: 0 };
  /** Most recent concern/blocker severity, if any. */
  private lastConcern?: "concern" | "blocker";

  /** @returns true when the event changed visible state (triggers repaint). */
  applyEvent(payload: unknown): boolean {
    const event = normalizeSupervisionEvent(payload);
    if (!event) return false;
    this.events.push(event);
    if (this.events.length > MAX_SUPERVISION_EVENTS) this.events.shift();
    if (event.kind === "intervention") this.totals.interventions++;
    if (event.kind === "notification") this.totals.notifications++;
    if (event.kind === "verdict") this.totals.verdicts++;
    if (event.kind === "evaluating") this.totals.evaluations++;
    if (event.severity === "concern" || event.severity === "blocker") {
      this.lastConcern = event.severity;
    }
    return true;
  }

  recentEvents(limit = 10): SupervisionEventLike[] {
    return this.events.slice(-Math.max(0, limit));
  }

  getTotals(): SupervisionTotals {
    return { ...this.totals };
  }

  /**
   * Compact footer segment text, or undefined when nothing has been observed.
   * Format: `I2·V1 ▲` (interventions · verdicts · latest concern marker).
   */
  footerStatus(): string | undefined {
    if (this.events.length === 0) return undefined;
    const parts: string[] = [];
    if (this.totals.interventions > 0) parts.push(`I${this.totals.interventions}`);
    if (this.totals.verdicts > 0) parts.push(`V${this.totals.verdicts}`);
    if (this.lastConcern === "blocker") parts.push("▲");
    else if (this.lastConcern === "concern") parts.push("△");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
}

/**
 * Unified supervision protocol shared by Goal verification, the fleet
 * Monitor engine, and (future) turn-level Advisor.
 *
 * The event namespace is intentionally separate from teammate lifecycle
 * events (`teammate:started` etc.) — supervision is a cross-cutting concern
 * with its own severity semantics, consumed by cockpit-style surfaces.
 */

export type SupervisionSeverity = "info" | "nit" | "concern" | "blocker";
export type SupervisionSource = "goal" | "monitor" | "advisor";
export type SupervisionKind = "evaluating" | "verdict" | "intervention" | "notification";

export interface SupervisionEvent {
  source: SupervisionSource;
  kind: SupervisionKind;
  severity: SupervisionSeverity;
  /** goalId / correlationId / session identifier being supervised. */
  target?: string;
  verdict?: { status: string; pass?: boolean };
  message?: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export const SUPERVISION_EVENT = "supervision:event";

export function createSupervisionEvent(
  source: SupervisionSource,
  kind: SupervisionKind,
  severity: SupervisionSeverity,
  overrides: Omit<SupervisionEvent, "source" | "kind" | "severity" | "timestamp"> = {},
): SupervisionEvent {
  return { source, kind, severity, timestamp: Date.now(), ...overrides };
}

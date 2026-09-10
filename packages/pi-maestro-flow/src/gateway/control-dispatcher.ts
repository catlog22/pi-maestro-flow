/** One audited, allow-listed dispatcher for every local Gateway control action. */
import { randomUUID } from "node:crypto";
import type { GatewayPrincipal } from "./contracts.ts";
import { GatewayAuditSink, type GatewayAuditOutcome } from "./audit.ts";
import { createLocalGatewayPrincipal } from "./principal.ts";

export const GATEWAY_CONTROL_ACTIONS = [
  "status",
  "stop",
  "pair",
  "pair-bootstrap",
  "pair-list",
  "pair-revoke",
  "workspace-list",
  "workspace-register",
  "workspace-renew",
  "workspace-remove",
  "tunnel-status",
  "tunnel-start",
  "tunnel-stop",
  "tunnel-restart",
] as const;
export type GatewayControlAction = typeof GATEWAY_CONTROL_ACTIONS[number];
export type GatewayTunnelControlAction = Extract<GatewayControlAction, `tunnel-${string}`>;

export interface GatewayControlContext {
  action: GatewayControlAction;
  requestId: string;
  principal: GatewayPrincipal;
}
export type GatewayControlHandler = (data: Record<string, unknown> | undefined, context: GatewayControlContext) => unknown | Promise<unknown>;
export interface GatewayControlDispatcherOptions {
  audit: GatewayAuditSink;
  handlers: Partial<Record<GatewayControlAction, GatewayControlHandler>>;
  principal?: GatewayPrincipal;
  requestId?: () => string;
  now?: () => number;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? String((error as { code: string }).code)
    : "control_failed";
}
function outcomeFor(code: string): GatewayAuditOutcome {
  return code === "control_unavailable" || code.endsWith("_denied") || code === "invalid_arguments" ? "denied" : "error";
}

export function isGatewayControlAction(value: unknown): value is GatewayControlAction {
  return typeof value === "string" && (GATEWAY_CONTROL_ACTIONS as readonly string[]).includes(value);
}

export class GatewayControlDispatcher {
  private readonly principal: GatewayPrincipal;
  private readonly requestId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: GatewayControlDispatcherOptions) {
    this.principal = options.principal ?? createLocalGatewayPrincipal("local-control", {
      authenticated: true,
      source: "local-ipc-control",
      scopes: ["gateway.control"],
    });
    this.requestId = options.requestId ?? randomUUID;
    this.now = options.now ?? (() => Date.now());
  }

  async dispatch(action: GatewayControlAction, data?: Record<string, unknown>): Promise<unknown> {
    const startedAt = this.now();
    const requestId = this.requestId();
    const handler = this.options.handlers[action];
    if (!handler) {
      const error = new Error(`Gateway IPC ${action} control is unavailable`) as Error & { code: string };
      error.code = "control_unavailable";
      await this.audit(requestId, action, "denied", error.code, startedAt);
      throw error;
    }
    try {
      const result = await handler(data, { action, requestId, principal: this.principal });
      await this.audit(requestId, action, "allowed", undefined, startedAt);
      return result;
    } catch (error) {
      const code = errorCode(error);
      await this.audit(requestId, action, outcomeFor(code), code, startedAt);
      throw error;
    }
  }

  private audit(requestId: string, action: GatewayControlAction, outcome: GatewayAuditOutcome, code: string | undefined, startedAt: number): Promise<void> {
    return this.options.audit.write({
      requestId,
      principal: this.principal,
      tool: "control",
      action,
      outcome,
      ...(code === undefined ? {} : { code }),
      durationMs: this.now() - startedAt,
    });
  }
}

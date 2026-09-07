/** Durable session-scoped Monitor facade over the single GatewayTeammateService runtime. */
import { randomUUID } from "node:crypto";
import type { GatewayAuthMode } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { assertSessionScope } from "../identity-store.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { SessionStore } from "../session-store.ts";
import { GatewayTeammateService, type GatewayTeammateSendMode } from "./teammate-service.ts";

export type GatewayMonitorAction = "list" | "observe" | "wait" | "message" | "cancel" | "result";
export interface GatewayMonitorRequest { action: GatewayMonitorAction; requestId?: string; [key: string]: unknown; }
export interface GatewayMonitorServiceOptions { sessions: SessionStore; teammate: GatewayTeammateService; authMode: GatewayAuthMode; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`); return value.trim(); }
function cursor(value: unknown): number { if (value === undefined) return 0; const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value; if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new Error("cursor must be a non-negative integer"); return parsed as number; }
function limit(value: unknown): number { if (value === undefined) return 64; if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 512) throw new Error("limit must be in [1, 512]"); return value as number; }

export class GatewayMonitorService {
  constructor(private readonly options: GatewayMonitorServiceOptions) {}
  async handle(principal: GatewayPrincipal, request: GatewayMonitorRequest): Promise<GatewayResult<unknown>> {
    const requestId = request.requestId ?? randomUUID(); const principalId = principalKey(principal);
    try {
      const sessionId = id(request.sessionId, "sessionId"); const memberId = id(request.memberId, "memberId"); const state = await this.options.sessions.require(sessionId);
      const scope = request.action === "message" ? "monitor:message" : request.action === "cancel" ? "monitor:cancel" : "monitor:read";
      assertSessionScope(state.session, state.members, { principal, memberId, authMode: this.options.authMode }, scope);
      let data: unknown;
      switch (request.action) {
        case "list": data = { monitors: (await this.options.teammate.monitorList(sessionId)).map((task) => ({ handle: task.id, task })) }; break;
        case "observe": data = { handle: id(request.handle, "handle"), ...(await this.options.teammate.monitorObserve(sessionId, id(request.handle, "handle"), cursor(request.cursor), limit(request.limit))) }; break;
        case "wait": data = { handle: id(request.handle, "handle"), ...(await this.options.teammate.monitorWait(sessionId, id(request.handle, "handle"), request.timeoutMs as number | undefined)) }; break;
        case "message": {
          const mode = request.mode ?? "follow_up"; if (mode !== "steer" && mode !== "follow_up" && mode !== "interrupt") throw new Error("mode must be steer, follow_up, or interrupt");
          const delivered = await this.options.teammate.monitorMessage(sessionId, id(request.handle, "handle"), id(request.message, "message"), mode as GatewayTeammateSendMode); data = { handle: request.handle, delivered, mode }; break;
        }
        case "cancel": data = { handle: id(request.handle, "handle"), task: await this.options.teammate.monitorCancel(sessionId, id(request.handle, "handle"), typeof request.reason === "string" ? request.reason : undefined) }; break;
        case "result": data = { handle: id(request.handle, "handle"), ...(await this.options.teammate.monitorResult(sessionId, id(request.handle, "handle"), cursor(request.cursor), limit(request.limit))) }; break;
        default: throw new Error("Unsupported monitor action");
      }
      return gatewayOk(data, { requestId, principalId });
    } catch (error) {
      const denied = error && typeof error === "object" && (error as { name?: string }).name === "SessionAuthorizationError";
      return gatewayError({ code: denied ? "session_scope_denied" : "monitor_action_failed", message: error instanceof Error ? error.message : String(error) }, { requestId, principalId });
    }
  }
}

/** Durable session-scoped Monitor facade over the single GatewayTeammateService runtime. */
import { randomUUID } from "node:crypto";
import type { GatewayAuthMode } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import type { GatewayEventNotification } from "../event-contracts.ts";
import { GatewayEventStream } from "../event-stream.ts";
import { assertSessionScope, type SessionIdentityContext } from "../identity-store.ts";
import { hashGatewayOperationPayload, type GatewayOperationReceiptV1, type GatewayOperationResultV1, type GatewayReceiptAction } from "../operation-contracts.ts";
import { GatewayOperationOutcomeUnknownError, GatewayOperationReceiptCapacityError, GatewayOperationReceiptConflictError, GatewayOperationReceiptStore } from "../operation-receipt-store.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { SessionStore } from "../session-store.ts";
import { GatewayTeammateService, type GatewayTeammateSendMode } from "./teammate-service.ts";

export type GatewayMonitorAction = "list" | "observe" | "wait" | "message" | "cancel" | "result" | "subscribe" | "unsubscribe";
export interface GatewayMonitorRequest { action: GatewayMonitorAction; requestId?: string; [key: string]: unknown; }
export interface GatewayMonitorStreamContext { connectionId: string; write(notification: GatewayEventNotification): Promise<void>; }
export interface GatewayMonitorServiceOptions { sessions: SessionStore; teammate: GatewayTeammateService; receipts: GatewayOperationReceiptStore; authMode: GatewayAuthMode; stream: GatewayEventStream; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`); return value.trim(); }
function cursor(value: unknown): number { if (value === undefined) return 0; const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value; if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new Error("cursor must be a non-negative integer"); return parsed as number; }
function limit(value: unknown): number { if (value === undefined) return 64; if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 512) throw new Error("limit must be in [1, 512]"); return value as number; }

export class GatewayMonitorService {
  constructor(private readonly options: GatewayMonitorServiceOptions) {}
  async handle(principal: GatewayPrincipal, request: GatewayMonitorRequest, streamContext?: GatewayMonitorStreamContext): Promise<GatewayResult<unknown>> {
    const requestId = request.requestId ?? randomUUID(); const principalId = principalKey(principal);
    try {
      const sessionId = id(request.sessionId, "sessionId"); const memberId = id(request.memberId, "memberId"); const state = await this.options.sessions.require(sessionId);
      const scope = request.action === "message" ? "monitor:message" : request.action === "cancel" ? "monitor:cancel" : "monitor:read";
      const identity: SessionIdentityContext = { principal, memberId, authMode: this.options.authMode };
      const member = assertSessionScope(state.session, state.members, identity, scope);
      let data: unknown;
      switch (request.action) {
        case "list": data = { monitors: (await this.options.teammate.monitorList(sessionId)).map((task) => ({ handle: task.id, task })) }; break;
        case "observe": data = { handle: id(request.handle, "handle"), ...(await this.options.teammate.monitorObserve(sessionId, id(request.handle, "handle"), cursor(request.cursor), limit(request.limit))) }; break;
        case "wait": data = { handle: id(request.handle, "handle"), ...(await this.options.teammate.monitorWait(sessionId, id(request.handle, "handle"), request.timeoutMs as number | undefined)) }; break;
        case "subscribe": {
          if (!streamContext) throw new Error("Monitor subscriptions require an MCP connection");
          const handle = id(request.handle, "handle");
          // Fail before installing a listener when the execution is not in the authorized session.
          await this.options.teammate.monitorObserve(sessionId, handle, cursor(request.cursor), 1);
          data = this.options.stream.subscribe({
            connectionId: streamContext.connectionId,
            workspaceId: state.session.workspaceId,
            sessionId,
            memberId,
            memberGeneration: member.generation,
            handle,
            cursor: cursor(request.cursor),
            write: streamContext.write,
            validate: async () => {
              const current = await this.options.sessions.load(sessionId);
              if (!current) return false;
              const active = current.members.find((candidate) => candidate.id === memberId);
              if (!active || active.generation !== member.generation || active.status !== "active") return false;
              try { assertSessionScope(current.session, current.members, identity, "monitor:read"); return true; } catch { return false; }
            },
          });
          break;
        }
        case "unsubscribe": {
          if (!streamContext) throw new Error("Monitor subscriptions require an MCP connection");
          data = this.options.stream.unsubscribe(id(request.subscriptionId, "subscriptionId"), streamContext.connectionId);
          break;
        }
        case "message": {
          const operationId = id(request.operationId, "operationId");
          const handle = id(request.handle, "handle");
          const message = id(request.message, "message");
          const mode = request.mode ?? "follow_up"; if (mode !== "steer" && mode !== "follow_up" && mode !== "interrupt") throw new Error("mode must be steer, follow_up, or interrupt");
          return await this.receipted(principal, request, { sessionId, workspaceId: state.session.workspaceId, memberId, memberGeneration: member.generation }, "message", operationId, { handle, message, mode }, async () => {
            const delivered = await this.options.teammate.monitorMessage(sessionId, handle, message, mode as GatewayTeammateSendMode);
            return { ok: true, status: "succeeded", data: { handle, delivered, mode: mode as GatewayTeammateSendMode } };
          });
        }
        case "cancel": {
          const operationId = id(request.operationId, "operationId");
          const handle = id(request.handle, "handle");
          const reason = typeof request.reason === "string" ? request.reason : "Cancelled by Monitor caller";
          return await this.receipted(principal, request, { sessionId, workspaceId: state.session.workspaceId, memberId, memberGeneration: member.generation }, "cancel", operationId, { handle, reason }, async () => {
            const task = await this.options.teammate.monitorCancel(sessionId, handle, reason);
            return { ok: true, status: "succeeded", data: { handle, cancelled: task.status === "cancelled", alreadyTerminal: task.status !== "cancelled", taskStatus: task.status as "queued" | "running" | "completed" | "failed" | "cancelled" | "lost" } };
          });
        }
        case "result": data = { handle: id(request.handle, "handle"), ...(await this.options.teammate.monitorResult(sessionId, id(request.handle, "handle"), cursor(request.cursor), limit(request.limit))) }; break;
        default: throw new Error("Unsupported monitor action");
      }
      return gatewayOk(data, { requestId, principalId });
    } catch (error) {
      const denied = error && typeof error === "object" && (error as { name?: string }).name === "SessionAuthorizationError";
      const code = denied ? "session_scope_denied"
        : error instanceof GatewayOperationReceiptConflictError ? "operation_receipt_conflict"
          : error instanceof GatewayOperationReceiptCapacityError ? "operation_receipt_capacity"
            : error instanceof GatewayOperationOutcomeUnknownError ? "operation_outcome_unknown"
              : "monitor_action_failed";
      return gatewayError({ code, message: error instanceof Error ? error.message : String(error) }, { requestId, principalId });
    }
  }

  private async receipted(
    principal: GatewayPrincipal,
    request: GatewayMonitorRequest,
    binding: { sessionId: string; workspaceId: string; memberId: string; memberGeneration: number },
    action: Extract<GatewayReceiptAction, "message" | "cancel">,
    operationId: string,
    behavior: unknown,
    dispatch: () => Promise<GatewayOperationResultV1>,
  ): Promise<GatewayResult<unknown>> {
    const key = { principalId: principalKey(principal), ...binding, tool: "monitor" as const, action, operationId };
    const payloadHash = hashGatewayOperationPayload(behavior);
    const receiptId = (await this.options.receipts.prepare({ ...key, payloadHash })).receipt.id;
    return this.options.receipts.serialized(receiptId, async () => {
      let receipt = (await this.options.receipts.prepare({ ...key, payloadHash })).receipt;
      if (receipt.state === "dispatching" || receipt.state === "outcome-unknown") {
        if (receipt.state === "dispatching") receipt = await this.options.receipts.markOutcomeUnknown(receipt);
        throw new GatewayOperationOutcomeUnknownError();
      }
      if (receipt.state === "accepted") receipt = await this.options.receipts.markTerminal(receipt);
      if (receipt.state === "terminal") return this.replay(principal, request, receipt);
      receipt = await this.options.receipts.markDispatching(receipt);
      let durable: GatewayOperationResultV1;
      try { durable = await dispatch(); }
      catch (error) {
        await this.options.receipts.markOutcomeUnknown(receipt).catch(() => undefined);
        throw new GatewayOperationOutcomeUnknownError();
      }
      try {
        const accepted = await this.options.receipts.markAccepted(receipt, durable);
        return this.replay(principal, request, await this.options.receipts.markTerminal(accepted));
      } catch {
        const persisted = await this.options.receipts.get(receiptId).catch(() => undefined);
        if (persisted?.state === "accepted" || persisted?.state === "terminal") return this.replay(principal, request, persisted.state === "accepted" ? await this.options.receipts.markTerminal(persisted) : persisted);
        await this.options.receipts.markOutcomeUnknown(receiptId).catch(() => undefined);
        throw new GatewayOperationOutcomeUnknownError();
      }
    });
  }

  private replay(principal: GatewayPrincipal, request: GatewayMonitorRequest, receipt: GatewayOperationReceiptV1): GatewayResult<unknown> {
    if (!receipt.result) throw new GatewayOperationOutcomeUnknownError();
    const meta = { requestId: request.requestId ?? randomUUID(), principalId: principalKey(principal), status: receipt.result.status };
    if (!receipt.result.ok) return gatewayError({ code: receipt.result.error?.code ?? "monitor_action_failed", message: "Receipt recorded a failed operation", retryable: receipt.result.error?.retryable ?? false }, meta);
    return gatewayOk({ ...(receipt.result.data ?? {}), receipt }, meta);
  }
}

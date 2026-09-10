/** Collaborative Session service exposed through the shared Gateway catalog. */
import { randomUUID } from "node:crypto";
import type { GatewayAuthMode } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { assertSessionScope, type SessionIdentityContext } from "../identity-store.ts";
import { principalKey } from "../principal.ts";
import { buildGatewayDelegationPrompt } from "../prompt-delegation.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import type { GatewayHandoffV1 } from "../handoff-contracts.ts";
import { gatewayHandoffOriginForTransport } from "../handoff-record-contracts.ts";
import type { SessionMemberV1 } from "../session-contracts.ts";
import { SessionStore } from "../session-store.ts";
import { GatewayTodoStore } from "../todo-store.ts";
import { workspaceIdForPath } from "../state-paths.ts";
import type { GatewayPolicy } from "../policy.ts";
import { hashGatewayOperationPayload, type GatewayOperationReceiptV1, type GatewayOperationResultV1 } from "../operation-contracts.ts";
import { GatewayOperationOutcomeUnknownError, GatewayOperationReceiptCapacityError, GatewayOperationReceiptConflictError, GatewayOperationReceiptStore } from "../operation-receipt-store.ts";
import type { GatewayEventStream } from "../event-stream.ts";
import type { GatewayTeammateService } from "./teammate-service.ts";

export type GatewaySessionAction = "create" | "get" | "list" | "join" | "renew" | "leave" | "handoff" | "close" | "start-pi";
export interface GatewaySessionRequest { action: GatewaySessionAction; requestId?: string; [key: string]: unknown; }
export interface GatewaySessionServiceOptions { store: SessionStore; todos: GatewayTodoStore; teammate: GatewayTeammateService; receipts: GatewayOperationReceiptStore; authMode: GatewayAuthMode; policy?: GatewayPolicy; stream?: GatewayEventStream; }

function id(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`); return value.trim(); }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`); return value as number; }
function identity(principal: GatewayPrincipal, memberId: unknown, authMode: GatewayAuthMode): SessionIdentityContext { return { principal, memberId: id(memberId, "memberId"), authMode }; }
function mutation(request: GatewaySessionRequest, context: SessionIdentityContext) { return { expectedSessionRevision: integer(request.expectedSessionRevision, "expectedSessionRevision"), operationId: id(request.operationId, "operationId"), actorId: context.memberId, identity: context }; }
function result<T>(principal: GatewayPrincipal, request: GatewaySessionRequest, data: T): GatewayResult<T> { return gatewayOk(data, { requestId: request.requestId ?? randomUUID(), principalId: principalKey(principal) }); }
function failure(principal: GatewayPrincipal, request: GatewaySessionRequest, error: unknown): GatewayResult<never> {
  const name = error && typeof error === "object" ? (error as { name?: string }).name : undefined;
  const code = name === "SessionAuthorizationError" ? "session_scope_denied"
    : error instanceof GatewayOperationReceiptConflictError ? "operation_receipt_conflict"
      : error instanceof GatewayOperationReceiptCapacityError ? "operation_receipt_capacity"
        : error instanceof GatewayOperationOutcomeUnknownError ? "operation_outcome_unknown"
          : "session_action_failed";
  return gatewayError({ code, message: error instanceof Error ? error.message : String(error) }, { requestId: request.requestId ?? randomUUID(), principalId: principalKey(principal) });
}
function replay(principal: GatewayPrincipal, request: GatewaySessionRequest, receipt: GatewayOperationReceiptV1): GatewayResult<unknown> {
  if (!receipt.result) return failure(principal, request, new GatewayOperationOutcomeUnknownError());
  const meta = { requestId: request.requestId ?? randomUUID(), principalId: principalKey(principal), status: receipt.result.status };
  if (!receipt.result.ok) return gatewayError({ code: receipt.result.error?.code ?? "session_action_failed", message: "Receipt recorded a failed operation", retryable: receipt.result.error?.retryable ?? false }, meta);
  return gatewayOk({ ...(receipt.result.data ?? {}), receipt }, meta);
}

export class GatewaySessionService {
  readonly store: SessionStore;
  private readonly todos: GatewayTodoStore;
  private readonly teammate: GatewayTeammateService;
  private readonly receipts: GatewayOperationReceiptStore;
  private readonly authMode: GatewayAuthMode;
  private readonly policy?: GatewayPolicy;
  private readonly stream?: GatewayEventStream;
  constructor(options: GatewaySessionServiceOptions) { this.store = options.store; this.todos = options.todos; this.teammate = options.teammate; this.receipts = options.receipts; this.authMode = options.authMode; this.policy = options.policy; this.stream = options.stream; }

  async handle(principal: GatewayPrincipal, request: GatewaySessionRequest): Promise<GatewayResult<unknown>> {
    try {
      switch (request.action) {
        case "create": {
          if (this.authMode === "open") throw new Error("auth.mode=open is read-only");
          const workspaceReference = id(request.workspaceId ?? request.workspacePath, "workspaceId or workspacePath");
          const decision = await this.policy?.authorizeWorkspace(principal, workspaceReference);
          if (decision && (!decision.allowed || decision.workspacePath === undefined)) throw new Error(decision.reason);
          const workspacePath = decision?.workspacePath ?? id(request.workspacePath, "workspacePath");
          if (request.workspaceId !== undefined && request.workspacePath !== undefined && this.policy) {
            const pathDecision = await this.policy.authorizeWorkspace(principal, id(request.workspacePath, "workspacePath"));
            if (!pathDecision.allowed || pathDecision.workspacePath !== workspacePath) throw new Error("workspaceId and workspacePath refer to different workspaces");
          }
          const ownerId = id(request.ownerId, "ownerId");
          const state = await this.store.create({ id: request.sessionId as string | undefined, workspacePath, ownerId, ownerPrincipalId: principalKey(principal), leaseTtlMs: request.leaseTtlMs as number | undefined }, { expectedSessionRevision: integer(request.expectedSessionRevision, "expectedSessionRevision"), operationId: id(request.operationId, "operationId"), actorId: ownerId });
          return result(principal, request, { session: state.session, member: state.members[0] });
        }
        case "get": {
          const state = await this.store.require(id(request.sessionId, "sessionId")); const context = identity(principal, request.memberId, this.authMode); assertSessionScope(state.session, state.members, context, "session:read"); return result(principal, request, state);
        }
        case "list": {
          const memberId = id(request.memberId, "memberId"); const states = await this.store.list(request.limit === undefined ? 256 : integer(request.limit, "limit"));
          const sessions = states.filter((state) => { try { assertSessionScope(state.session, state.members, { principal, memberId, authMode: this.authMode }, "session:read"); return true; } catch { return false; } }).map((state) => state.session);
          return result(principal, request, { sessions });
        }
        case "join": {
          const context = identity(principal, request.memberId, this.authMode); const member = await this.store.joinMember(id(request.sessionId, "sessionId"), { id: id(request.joiningMemberId, "joiningMemberId"), principalId: id(request.joiningPrincipalId, "joiningPrincipalId"), role: request.role as SessionMemberV1["role"], capabilities: request.capabilities as string[] | undefined, leaseTtlMs: request.leaseTtlMs as number | undefined }, mutation(request, context)); return result(principal, request, { member });
        }
        case "renew": {
          const context = identity(principal, request.memberId, this.authMode); const sessionId = id(request.sessionId, "sessionId");
          const member = await this.store.renewMember(sessionId, context.memberId, integer(request.expectedGeneration, "expectedGeneration"), integer(request.leaseTtlMs, "leaseTtlMs"), mutation(request, context));
          this.stream?.closeMatching((binding) => binding.sessionId === sessionId && binding.memberId === member.id && binding.memberGeneration !== member.generation);
          return result(principal, request, { member });
        }
        case "leave": {
          const context = identity(principal, request.memberId, this.authMode); const sessionId = id(request.sessionId, "sessionId"); const leavingMemberId = id(request.leavingMemberId ?? request.memberId, "leavingMemberId");
          const member = await this.store.setMemberStatus(sessionId, leavingMemberId, "left", integer(request.expectedGeneration, "expectedGeneration"), mutation(request, context));
          this.stream?.closeMatching((binding) => binding.sessionId === sessionId && binding.memberId === leavingMemberId);
          return result(principal, request, { member });
        }
        case "handoff": {
          const context = identity(principal, request.memberId, this.authMode);
          const session = await this.store.handoff(id(request.sessionId, "sessionId"), request.handoff as GatewayHandoffV1, mutation(request, context), gatewayHandoffOriginForTransport(principal.transport));
          return result(principal, request, { session });
        }
        case "close": {
          const context = identity(principal, request.memberId, this.authMode);
          const handoff = request.handoff as GatewayHandoffV1 | undefined;
          const sessionId = id(request.sessionId, "sessionId");
          const session = await this.store.close(sessionId, mutation(request, context), handoff, handoff === undefined ? undefined : gatewayHandoffOriginForTransport(principal.transport));
          this.stream?.closeMatching((binding) => binding.sessionId === sessionId);
          return result(principal, request, { session });
        }
        case "start-pi": {
          if (this.authMode === "open") throw new Error("auth.mode=open is read-only");
          const sessionId = id(request.sessionId, "sessionId");
          const context = identity(principal, request.memberId, this.authMode);
          const operationId = id(request.operationId, "operationId");
          const rawPrompt = id(request.prompt, "prompt");
          const agent = typeof request.agent === "string" && request.agent.trim() ? request.agent.trim() : "general";
          const state = await this.store.require(sessionId);
          assertSessionScope(state.session, state.members, context, "session:read");
          const member = assertSessionScope(state.session, state.members, context, "execution:start");
          if (state.session.status !== "active") throw new Error("Session is not active");
          const todoIds = request.todoIds === undefined ? [] : request.todoIds;
          if (!Array.isArray(todoIds) || todoIds.some((value) => typeof value !== "string")) throw new Error("todoIds must be an array of strings");
          if (todoIds.length > 0) assertSessionScope(state.session, state.members, context, "todo:read");
          const key = { principalId: principalKey(principal), workspaceId: state.session.workspaceId, sessionId, memberId: context.memberId, memberGeneration: member.generation, tool: "session" as const, action: "start-pi" as const, operationId };
          const payloadHash = hashGatewayOperationPayload({ prompt: rawPrompt, todoIds, agent });
          const receiptId = (await this.receipts.prepare({ ...key, payloadHash })).receipt.id;
          return await this.receipts.serialized(receiptId, async () => {
            let prepared = (await this.receipts.prepare({ ...key, payloadHash })).receipt;
            if (prepared.state === "dispatching" || prepared.state === "outcome-unknown") {
              if (prepared.state === "dispatching") prepared = await this.receipts.markOutcomeUnknown(prepared);
              return failure(principal, request, new GatewayOperationOutcomeUnknownError());
            }
            if (prepared.state === "accepted") prepared = await this.receipts.markTerminal(prepared);
            if (prepared.state === "terminal") return replay(principal, request, prepared);
            prepared = await this.receipts.markDispatching(prepared);
            const prompt = buildGatewayDelegationPrompt(rawPrompt, await this.todos.list(sessionId), todoIds as string[]);
            let started: GatewayResult<unknown>;
            try {
              started = await this.teammate.start(principal, { prompt, agent, workspacePath: state.session.workspacePath, workspaceId: workspaceIdForPath(state.session.workspacePath), objective: rawPrompt, gatewaySessionId: sessionId, gatewayMemberId: context.memberId, requestId: request.requestId });
            } catch (error) {
              await this.receipts.markOutcomeUnknown(prepared).catch(() => undefined);
              throw error;
            }
            const taskId = started.ok && started.data && typeof started.data === "object" && !Array.isArray(started.data) ? (started.data as { taskId?: unknown }).taskId : undefined;
            const durable: GatewayOperationResultV1 = started.ok && typeof taskId === "string" && taskId.length > 0
              ? { ok: true, status: "accepted", data: { taskId, monitorHandle: taskId } }
              : { ok: false, status: "failed", error: { code: started.error?.code ?? "task_start_failed", retryable: started.error?.retryable ?? false } };
            try {
              const accepted = await this.receipts.markAccepted(prepared, durable);
              return replay(principal, request, await this.receipts.markTerminal(accepted));
            } catch (error) {
              const durableReceipt = await this.receipts.get(receiptId).catch(() => undefined);
              if (durableReceipt?.state === "accepted" || durableReceipt?.state === "terminal") return replay(principal, request, durableReceipt.state === "accepted" ? await this.receipts.markTerminal(durableReceipt) : durableReceipt);
              await this.receipts.markOutcomeUnknown(receiptId).catch(() => undefined);
              throw new GatewayOperationOutcomeUnknownError();
            }
          });
        }
        default: throw new Error("Unsupported session action");
      }
    } catch (error) { return failure(principal, request, error); }
  }
}

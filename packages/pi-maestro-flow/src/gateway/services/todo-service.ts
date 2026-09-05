/** Independent Gateway Todo service. It never imports or synchronizes Pi Todo. */
import { randomUUID } from "node:crypto";
import type { GatewayAuthMode } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { assertSessionScope, type SessionIdentityContext } from "../identity-store.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import type { GatewayTodoTaskV1 } from "../session-contracts.ts";
import { SessionStore } from "../session-store.ts";
import { GatewayTodoStore } from "../todo-store.ts";

export type GatewayTodoAction = "create" | "update" | "list" | "get" | "delete" | "claim" | "release" | "advance";
export interface GatewayTodoRequest { action: GatewayTodoAction; requestId?: string; [key: string]: unknown; }
export interface GatewayTodoServiceOptions { store: GatewayTodoStore; sessions: SessionStore; authMode: GatewayAuthMode; }
function id(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`); return value.trim(); }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`); return value as number; }
function array(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`); return value; }

export class GatewayTodoService {
  constructor(private readonly options: GatewayTodoServiceOptions) {}
  async handle(principal: GatewayPrincipal, request: GatewayTodoRequest): Promise<GatewayResult<unknown>> {
    const requestId = request.requestId ?? randomUUID(); const principalId = principalKey(principal);
    try {
      const sessionId = id(request.sessionId, "sessionId"); const memberId = id(request.memberId, "memberId");
      const identity: SessionIdentityContext = { principal, memberId, authMode: this.options.authMode };
      const state = await this.options.sessions.require(sessionId);
      const read = request.action === "list" || request.action === "get";
      assertSessionScope(state.session, state.members, identity, read ? "todo:read" : "todo:write");
      if (read) {
        const data = request.action === "list" ? { todos: await this.options.store.list(sessionId) } : { todo: await this.options.store.get(sessionId, id(request.todoId, "todoId")) };
        return gatewayOk(data, { requestId, principalId });
      }
      const mutation = { expectedSessionRevision: integer(request.expectedSessionRevision, "expectedSessionRevision"), operationId: id(request.operationId, "operationId"), actorId: memberId, identity };
      let todo: GatewayTodoTaskV1;
      switch (request.action) {
        case "create": todo = await this.options.store.create(sessionId, { id: request.todoId as string | undefined, subject: id(request.subject, "subject"), description: request.description as string | undefined, dependencyIds: request.dependencyIds === undefined ? undefined : array(request.dependencyIds, "dependencyIds") }, mutation); break;
        case "update": todo = await this.options.store.update(sessionId, id(request.todoId, "todoId"), { subject: request.subject as string | undefined, description: request.description as string | null | undefined, dependencyIds: request.dependencyIds === undefined ? undefined : array(request.dependencyIds, "dependencyIds") }, mutation); break;
        case "delete": todo = await this.options.store.delete(sessionId, id(request.todoId, "todoId"), mutation); break;
        case "claim": todo = await this.options.store.claim(sessionId, id(request.todoId, "todoId"), mutation); break;
        case "release": todo = await this.options.store.release(sessionId, id(request.todoId, "todoId"), mutation); break;
        case "advance": {
          const status = request.status; if (status !== "pending" && status !== "blocked" && status !== "completed" && status !== "cancelled") throw new Error("status must be pending, blocked, completed, or cancelled");
          todo = await this.options.store.advance(sessionId, id(request.todoId, "todoId"), status, mutation); break;
        }
        default: throw new Error("Unsupported todo action");
      }
      return gatewayOk({ todo }, { requestId, principalId });
    } catch (error) {
      const denied = error && typeof error === "object" && (error as { name?: string }).name === "SessionAuthorizationError";
      return gatewayError({ code: denied ? "session_scope_denied" : "todo_action_failed", message: error instanceof Error ? error.message : String(error) }, { requestId, principalId });
    }
  }
}

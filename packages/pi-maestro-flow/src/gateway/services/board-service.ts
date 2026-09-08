/** Principal-aware Board service exposed through the shared Gateway catalog. */
import { randomUUID } from "node:crypto";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { principalHasScope, principalKey, isAuthenticatedPrincipal } from "../principal.ts";
import type { GatewayPolicy } from "../policy.ts";
import type { GatewayHandoffV1 } from "../handoff-contracts.ts";
import { gatewayHandoffOriginForTransport } from "../handoff-record-contracts.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import type { SessionStore } from "../session-store.ts";
import type { GatewayTodoStore } from "../todo-store.ts";
import {
  BoardAuthorizationError,
  BoardClaimError,
  BoardConflictError,
  BoardNotFoundError,
  BoardReplayMismatchError,
  BoardStore,
  BoardStoreError,
  boardActorForPrincipal,
  type BoardMutationOptions,
} from "../board-store.ts";
import type { BoardCompletionPolicyV1, BoardEndpointBindingV1, BoardTaskV1 } from "../board-contracts.ts";

export type GatewayBoardAction =
  | "create" | "list" | "get" | "update" | "claim" | "renew" | "release"
  | "takeover" | "attach-endpoint" | "detach-endpoint" | "bind-session" | "link-plan" | "handoff" | "transition" | "search" | "observe";

export interface GatewayBoardRequest {
  action: GatewayBoardAction;
  requestId?: string;
  workspaceId?: unknown;
  workspace?: unknown;
  workspacePath?: unknown;
  path?: unknown;
  [key: string]: unknown;
}

export interface GatewayBoardServiceOptions {
  policy: GatewayPolicy;
  sessions: SessionStore;
  todos: GatewayTodoStore;
  boardRoot?: string;
  maxTasks?: number;
  maxOperations?: number;
  maxEvents?: number;
  maxLeaseTtlMs?: number;
  taskRetentionMs?: number;
  operationRetentionMs?: number;
  eventRetentionMs?: number;
  now?: () => number;
}

class HiddenBoardResourceError extends Error {
  constructor() { super("Board resource was not found"); this.name = "HiddenBoardResourceError"; }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
  return value.trim();
}

function content(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value as number;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : integer(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${label} must be an array of non-empty strings`);
  return value.map((item) => String(item).trim());
}

function endpointKind(principal: GatewayPrincipal): BoardEndpointBindingV1["kind"] {
  return principal.transport === "stdio" ? "pi" : "web";
}

export class BoardService {
  private readonly stores = new Map<string, BoardStore>();

  constructor(private readonly options: GatewayBoardServiceOptions) {}

  async handle(principal: GatewayPrincipal, request: GatewayBoardRequest): Promise<GatewayResult<unknown>> {
    const requestId = request.requestId ?? randomUUID();
    const principalId = principalKey(principal);
    const resultOptions = { requestId, principalId };
    try {
      const store = await this.resolveStore(principal, request);
      if (request.action === "list") {
        const tasks = await store.list({
          ...(request.status === undefined ? {} : { status: request.status as BoardTaskV1["status"] }),
          ...(request.phase === undefined ? {} : { phase: request.phase as BoardTaskV1["phase"] }),
          ...(request.limit === undefined ? {} : { limit: integer(request.limit, "limit") }),
        });
        const orphaned = request.orphaned;
        const visible = orphaned === undefined ? tasks : tasks.filter((task) => store.isOrphaned(task) === orphaned);
        return gatewayOk({ workspaceId: store.workspaceId, tasks: visible }, resultOptions);
      }
      if (request.action === "get") {
        const task = await store.get(text(request.taskId, "taskId"));
        if (!task) throw new HiddenBoardResourceError();
        return gatewayOk({ task, orphaned: store.isOrphaned(task) }, resultOptions);
      }
      if (request.action === "search") {
        const tasks = await store.search({
          query: text(request.query, "query"),
          ...(request.status === undefined ? {} : { status: request.status as BoardTaskV1["status"] }),
          ...(request.phase === undefined ? {} : { phase: request.phase as BoardTaskV1["phase"] }),
          ...(request.limit === undefined ? {} : { limit: integer(request.limit, "limit") }),
        });
        return gatewayOk({ workspaceId: store.workspaceId, tasks }, resultOptions);
      }
      if (request.action === "observe") {
        const page = await store.observe(optionalInteger(request.cursor, "cursor") ?? 0, optionalInteger(request.limit, "limit") ?? 128);
        return gatewayOk({ workspaceId: store.workspaceId, ...page }, resultOptions);
      }

      if (!isAuthenticatedPrincipal(principal)) {
        return gatewayError({ code: "board_mutation_denied", message: "Board mutations require an authenticated principal" }, resultOptions);
      }
      const mutation = this.mutation(request, principal);
      let task: BoardTaskV1;
      switch (request.action) {
        case "create":
          task = await store.create({
            ...(request.taskId === undefined ? {} : { id: text(request.taskId, "taskId") }),
            title: text(request.title, "title"),
            ...(request.description === undefined ? {} : { description: content(request.description, "description") }),
            ...(request.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: stringArray(request.acceptanceCriteria, "acceptanceCriteria") }),
            ...(request.priority === undefined ? {} : { priority: request.priority as BoardTaskV1["priority"] }),
            ...(request.labels === undefined ? {} : { labels: stringArray(request.labels, "labels") }),
            ...(request.dependencyIds === undefined ? {} : { dependencyIds: stringArray(request.dependencyIds, "dependencyIds") }),
            ...(request.completionPolicy === undefined ? {} : { completionPolicy: request.completionPolicy as Partial<BoardCompletionPolicyV1> }),
          }, mutation);
          break;
        case "update": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "update");
          task = await store.update(taskId, {
            ...(request.title === undefined ? {} : { title: text(request.title, "title") }),
            ...(request.description === undefined ? {} : { description: request.description === null ? null : content(request.description, "description") }),
            ...(request.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: stringArray(request.acceptanceCriteria, "acceptanceCriteria") }),
            ...(request.priority === undefined ? {} : { priority: request.priority as BoardTaskV1["priority"] }),
            ...(request.labels === undefined ? {} : { labels: stringArray(request.labels, "labels") }),
            ...(request.dependencyIds === undefined ? {} : { dependencyIds: stringArray(request.dependencyIds, "dependencyIds") }),
            ...(request.completionPolicy === undefined ? {} : { completionPolicy: request.completionPolicy as BoardCompletionPolicyV1 }),
          }, mutation);
          break;
        }
        case "claim":
          task = await store.claim(text(request.taskId, "taskId"), {
            ...(request.leaseTtlMs === undefined ? {} : { leaseTtlMs: integer(request.leaseTtlMs, "leaseTtlMs") }),
            ...(request.sessionId === undefined ? {} : { sessionId: text(request.sessionId, "sessionId") }),
            ...(request.memberId === undefined ? {} : { memberId: text(request.memberId, "memberId") }),
          }, mutation);
          break;
        case "renew": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "claim-owner");
          task = await store.renew(taskId, {
            claimGeneration: integer(request.claimGeneration, "claimGeneration"),
            ...(request.leaseTtlMs === undefined ? {} : { leaseTtlMs: integer(request.leaseTtlMs, "leaseTtlMs") }),
          }, mutation);
          break;
        }
        case "release": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "claim-owner");
          task = await store.release(taskId, { claimGeneration: integer(request.claimGeneration, "claimGeneration") }, mutation);
          break;
        }
        case "takeover":
          task = await store.takeover(text(request.taskId, "taskId"), {
            reason: text(request.reason, "reason"),
            ...(request.leaseTtlMs === undefined ? {} : { leaseTtlMs: integer(request.leaseTtlMs, "leaseTtlMs") }),
          }, mutation);
          break;
        case "attach-endpoint":
          task = await store.attachEndpoint(text(request.taskId, "taskId"), {
            endpointId: text(request.endpointId, "endpointId"),
            kind: endpointKind(principal),
          }, mutation);
          break;
        case "detach-endpoint":
          task = await store.detachEndpoint(text(request.taskId, "taskId"), {
            endpointId: text(request.endpointId, "endpointId"),
            kind: endpointKind(principal),
          }, mutation);
          break;
        case "bind-session": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "claim-owner");
          task = await store.bindSession(taskId, {
            sessionId: text(request.sessionId, "sessionId"),
            memberId: text(request.memberId, "memberId"),
            claimGeneration: integer(request.claimGeneration, "claimGeneration"),
          }, mutation);
          break;
        }
        case "link-plan": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "claim-owner");
          task = await store.linkPlan(taskId, {
            sessionId: text(request.sessionId, "sessionId"),
            todoIds: stringArray(request.todoIds, "todoIds"),
            claimGeneration: integer(request.claimGeneration, "claimGeneration"),
          }, mutation);
          break;
        }
        case "handoff": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "handoff");
          task = await store.handoff(taskId, request.handoff as GatewayHandoffV1, mutation, gatewayHandoffOriginForTransport(principal.transport));
          break;
        }
        case "transition": {
          const taskId = text(request.taskId, "taskId");
          await this.assertMutationVisible(store, taskId, principal, "transition");
          task = await store.transition(taskId, {
            ...(request.status === undefined ? {} : { status: request.status as BoardTaskV1["status"] }),
            ...(request.phase === undefined ? {} : { phase: request.phase as BoardTaskV1["phase"] }),
            ...(request.claimGeneration === undefined ? {} : { claimGeneration: integer(request.claimGeneration, "claimGeneration") }),
            ...(request.summary === undefined ? {} : { summary: text(request.summary, "summary") }),
            ...(request.resourceUris === undefined ? {} : { resourceUris: stringArray(request.resourceUris, "resourceUris") }),
            ...(request.handoff === undefined ? {} : {
              handoff: request.handoff as GatewayHandoffV1,
              handoffOrigin: gatewayHandoffOriginForTransport(principal.transport),
            }),
          }, mutation);
          break;
        }
        default:
          return gatewayError({ code: "invalid_action", message: "Unsupported board action" }, resultOptions);
      }
      return gatewayOk({ task, orphaned: store.isOrphaned(task) }, resultOptions);
    } catch (error) {
      if (error instanceof HiddenBoardResourceError || error instanceof BoardNotFoundError || error instanceof BoardAuthorizationError) {
        return gatewayError({ code: "not_found", message: "Board resource was not found" }, resultOptions);
      }
      if (error instanceof BoardConflictError || error instanceof BoardClaimError || error instanceof BoardReplayMismatchError) {
        return gatewayError({ code: "board_conflict", message: error.message }, resultOptions);
      }
      return gatewayError({ code: "board_action_failed", message: error instanceof Error ? error.message : String(error) }, resultOptions);
    }
  }

  private mutation(request: GatewayBoardRequest, principal: GatewayPrincipal): BoardMutationOptions {
    return {
      principal,
      operationId: text(request.operationId, "operationId"),
      expectedRevision: integer(request.expectedRevision, "expectedRevision"),
    };
  }

  /** Reuse the authoritative per-workspace store for derived read-model projection. */
  storeForWorkspace(workspacePath: string): BoardStore {
    let store = this.stores.get(workspacePath);
    if (!store) {
      store = new BoardStore({
        workspacePath,
        sessionStore: this.options.sessions,
        todoStore: this.options.todos,
        ...(this.options.boardRoot === undefined ? {} : { boardRoot: this.options.boardRoot }),
        ...(this.options.maxTasks === undefined ? {} : { maxTasks: this.options.maxTasks }),
        ...(this.options.maxOperations === undefined ? {} : { maxOperations: this.options.maxOperations }),
        ...(this.options.maxEvents === undefined ? {} : { maxEvents: this.options.maxEvents }),
        ...(this.options.maxLeaseTtlMs === undefined ? {} : { maxLeaseTtlMs: this.options.maxLeaseTtlMs }),
        ...(this.options.taskRetentionMs === undefined ? {} : { taskRetentionMs: this.options.taskRetentionMs }),
        ...(this.options.operationRetentionMs === undefined ? {} : { operationRetentionMs: this.options.operationRetentionMs }),
        ...(this.options.eventRetentionMs === undefined ? {} : { eventRetentionMs: this.options.eventRetentionMs }),
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.stores.set(workspacePath, store);
    }
    return store;
  }

  private async resolveStore(principal: GatewayPrincipal, request: GatewayBoardRequest): Promise<BoardStore> {
    const references = [request.workspaceId, request.workspace, request.workspacePath, request.path]
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map((value) => value.trim());
    if (references.length === 0) throw new Error("workspaceId or workspace path is required");
    const primary = await this.options.policy.authorizeWorkspace(principal, references[0]!);
    if (!primary.allowed || !primary.workspacePath) throw new HiddenBoardResourceError();
    for (const reference of references.slice(1)) {
      const decision = await this.options.policy.authorizeWorkspace(principal, reference);
      if (!decision.allowed || decision.workspacePath !== primary.workspacePath) throw new HiddenBoardResourceError();
    }
    return this.storeForWorkspace(primary.workspacePath);
  }

  private async assertMutationVisible(
    store: BoardStore,
    taskId: string,
    principal: GatewayPrincipal,
    mode: "update" | "claim-owner" | "transition" | "handoff",
  ): Promise<void> {
    const task = await store.get(taskId);
    if (!task) throw new HiddenBoardResourceError();
    const principalId = principalKey(principal);
    const actorId = boardActorForPrincipal(principal).actorId;
    const administrator = principalHasScope(principal, "board.admin");
    const allowed = mode === "claim-owner"
      ? task.claim?.principalId === principalId
      : mode === "update" || mode === "handoff"
        ? task.createdBy.actorId === actorId || task.claim?.principalId === principalId
        : task.claim ? task.claim.principalId === principalId || administrator : task.createdBy.actorId === actorId || administrator;
    if (!allowed) throw new HiddenBoardResourceError();
  }
}

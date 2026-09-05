/** Independent Gateway Todo authority. Never reads or writes Pi todo-state. */
import { randomUUID } from "node:crypto";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import { parseGatewayTodoTask, type GatewayTodoTaskV1 } from "./session-contracts.ts";
import { SessionConflictError, SessionStore, type AuthorizedSessionMutationOptions } from "./session-store.ts";

export class GatewayTodoStoreError extends Error { constructor(message: string) { super(message); this.name = "GatewayTodoStoreError"; } }
export class GatewayTodoDependencyError extends GatewayTodoStoreError { constructor(message: string) { super(message); this.name = "GatewayTodoDependencyError"; } }
export class GatewayTodoClaimError extends GatewayTodoStoreError { constructor(message: string) { super(message); this.name = "GatewayTodoClaimError"; } }
export interface GatewayTodoStoreOptions { sessionStore: SessionStore; allowMultipleClaimsPerMember?: boolean; }
export interface CreateGatewayTodoInput { id?: string; subject: string; description?: string; dependencyIds?: string[]; }

function assertActor(options: AuthorizedSessionMutationOptions): void {
  if (options.actorId !== options.identity.memberId) throw new GatewayTodoStoreError("actorId must equal the authorized member id");
}
function assertAcyclic(todos: readonly GatewayTodoTaskV1[]): void {
  const ids = new Set(todos.map((todo) => todo.id));
  for (const todo of todos) for (const dependency of todo.dependencyIds) if (!ids.has(dependency)) throw new GatewayTodoDependencyError(`Unknown dependency ${dependency}`);
  const visiting = new Set<string>(); const visited = new Set<string>(); const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new GatewayTodoDependencyError("Todo dependency cycle detected");
    if (visited.has(id)) return; visiting.add(id);
    for (const dependency of byId.get(id)?.dependencyIds ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const todo of todos) visit(todo.id);
}

export class GatewayTodoStore {
  private readonly sessionStore: SessionStore;
  private readonly allowMultipleClaims: boolean;
  constructor(options: GatewayTodoStoreOptions | SessionStore) {
    if (options instanceof SessionStore) { this.sessionStore = options; this.allowMultipleClaims = false; }
    else { this.sessionStore = options.sessionStore; this.allowMultipleClaims = options.allowMultipleClaimsPerMember ?? false; }
  }
  async list(sessionId: string): Promise<GatewayTodoTaskV1[]> { return (await this.sessionStore.require(sessionId)).todos; }
  async get(sessionId: string, todoId: string): Promise<GatewayTodoTaskV1 | undefined> { return (await this.list(sessionId)).find((todo) => todo.id === todoId); }

  async create(sessionId: string, input: CreateGatewayTodoInput, options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options); const todoId = input.id ?? randomUUID();
    return this.sessionStore.mutateAuthorized(sessionId, "todo.create", { ...input, id: todoId }, options, "todo:write", ({ state, now, emit }, member) => {
      if (state.session.status !== "active") throw new SessionConflictError("Todos can only be created in an active session");
      if (state.todos.some((todo) => todo.id === todoId)) throw new GatewayTodoStoreError(`Todo already exists: ${todoId}`);
      const todo = parseGatewayTodoTask({ version: GATEWAY_STATE_VERSION, id: todoId, sessionId, revision: 1, subject: input.subject, ...(input.description === undefined ? {} : { description: input.description }), status: "pending", dependencyIds: input.dependencyIds ?? [], creatorId: member.id, createdAt: now, updatedAt: now });
      assertAcyclic([...state.todos, todo]); state.todos.push(todo); emit("todo.created", { todoId }); return todo;
    });
  }

  async update(sessionId: string, todoId: string, patch: { subject?: string; description?: string | null; dependencyIds?: string[] }, options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options);
    return this.sessionStore.mutateAuthorized(sessionId, "todo.update", { todoId, patch }, options, "todo:write", ({ state, now, emit }, member) => {
      const index = state.todos.findIndex((todo) => todo.id === todoId); if (index < 0) throw new GatewayTodoStoreError("Todo not found");
      const current = state.todos[index]!;
      if (current.status === "completed" || current.status === "cancelled") throw new GatewayTodoStoreError("Terminal todo cannot be changed");
      if (member.role !== "owner" && current.creatorId !== member.id && current.assigneeId !== member.id) throw new GatewayTodoClaimError("Only an owner, creator, or assignee may update a todo");
      const nextValue: Record<string, unknown> = { ...current, revision: current.revision + 1, updatedAt: now };
      if (patch.subject !== undefined) nextValue.subject = patch.subject;
      if (patch.description === null) delete nextValue.description; else if (patch.description !== undefined) nextValue.description = patch.description;
      if (patch.dependencyIds !== undefined) nextValue.dependencyIds = patch.dependencyIds;
      const next = parseGatewayTodoTask(nextValue); const candidate = [...state.todos]; candidate[index] = next; assertAcyclic(candidate);
      state.todos[index] = next; emit("todo.updated", { todoId }); return next;
    });
  }

  async delete(sessionId: string, todoId: string, options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options);
    return this.sessionStore.mutateAuthorized(sessionId, "todo.delete", { todoId }, options, "todo:write", ({ state, emit }, member) => {
      const index = state.todos.findIndex((todo) => todo.id === todoId); if (index < 0) throw new GatewayTodoStoreError("Todo not found");
      const current = state.todos[index]!;
      if (current.status === "in_progress" || current.status === "completed") throw new GatewayTodoStoreError("In-progress or completed todo cannot be deleted");
      if (member.role !== "owner" && current.creatorId !== member.id) throw new GatewayTodoClaimError("Only an owner or creator may delete a todo");
      if (state.todos.some((todo) => todo.id !== todoId && todo.dependencyIds.includes(todoId))) throw new GatewayTodoDependencyError("Todo is still referenced as a dependency");
      state.todos.splice(index, 1); emit("todo.deleted", { todoId }); return current;
    });
  }

  async setDependencies(sessionId: string, todoId: string, dependencyIds: string[], options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options);
    return this.sessionStore.mutateAuthorized(sessionId, "todo.dependencies", { todoId, dependencyIds }, options, "todo:write", ({ state, now, emit }) => {
      const index = state.todos.findIndex((todo) => todo.id === todoId); if (index < 0) throw new GatewayTodoStoreError("Todo not found");
      const current = state.todos[index]!; if (current.status === "completed" || current.status === "cancelled") throw new GatewayTodoStoreError("Terminal todo cannot be changed");
      const next = parseGatewayTodoTask({ ...current, dependencyIds, revision: current.revision + 1, updatedAt: now }); const candidate = [...state.todos]; candidate[index] = next; assertAcyclic(candidate); state.todos[index] = next; emit("todo.advanced", { todoId, dependenciesChanged: true }); return next;
    });
  }

  async claim(sessionId: string, todoId: string, options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options);
    return this.sessionStore.mutateAuthorized(sessionId, "todo.claim", { todoId }, options, "todo:write", ({ state, now, emit }, member) => {
      if (state.session.status !== "active") throw new GatewayTodoClaimError("Session is not active");
      if (member.leaseExpiresAt <= now || member.status !== "active") throw new GatewayTodoClaimError("Member lease is not active");
      const index = state.todos.findIndex((todo) => todo.id === todoId); if (index < 0) throw new GatewayTodoClaimError("Todo not found");
      const current = state.todos[index]!; if (current.status !== "pending") throw new GatewayTodoClaimError("Only pending todos may be claimed");
      const dependencies = current.dependencyIds.map((id) => state.todos.find((todo) => todo.id === id));
      if (dependencies.some((dependency) => dependency?.status !== "completed")) throw new GatewayTodoClaimError("Todo dependencies are not completed");
      if (!this.allowMultipleClaims && state.todos.some((todo) => todo.status === "in_progress" && todo.assigneeId === member.id)) throw new GatewayTodoClaimError("Member already has an in-progress todo");
      const next = parseGatewayTodoTask({ ...current, status: "in_progress", assigneeId: member.id, revision: current.revision + 1, updatedAt: now }); state.todos[index] = next; emit("todo.claimed", { todoId, assigneeId: member.id }); return next;
    });
  }

  async release(sessionId: string, todoId: string, options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options);
    return this.sessionStore.mutateAuthorized(sessionId, "todo.release", { todoId }, options, "todo:write", ({ state, now, emit }, member) => {
      const index = state.todos.findIndex((todo) => todo.id === todoId); if (index < 0) throw new GatewayTodoClaimError("Todo not found");
      const current = state.todos[index]!; if (current.status !== "in_progress" || current.assigneeId !== member.id) throw new GatewayTodoClaimError("Only the current assignee may release an in-progress todo");
      const { assigneeId: _assigneeId, completedAt: _completedAt, ...rest } = current;
      const next = parseGatewayTodoTask({ ...rest, status: "pending", revision: current.revision + 1, updatedAt: now }); state.todos[index] = next; emit("todo.released", { todoId }); return next;
    });
  }

  async advance(sessionId: string, todoId: string, status: "pending" | "blocked" | "completed" | "cancelled", options: AuthorizedSessionMutationOptions): Promise<GatewayTodoTaskV1> {
    assertActor(options);
    return this.sessionStore.mutateAuthorized(sessionId, "todo.advance", { todoId, status }, options, "todo:write", ({ state, now, emit }, member) => {
      const index = state.todos.findIndex((todo) => todo.id === todoId); if (index < 0) throw new GatewayTodoStoreError("Todo not found");
      const current = state.todos[index]!; if (current.status === "completed" || current.status === "cancelled") throw new GatewayTodoStoreError("Terminal todo cannot advance");
      if (status === "completed" && (current.status !== "in_progress" || current.assigneeId !== member.id)) throw new GatewayTodoClaimError("Only the current assignee may complete an in-progress todo");
      if (status === "blocked" && current.status === "in_progress" && current.assigneeId !== member.id) throw new GatewayTodoClaimError("Only the current assignee may block an in-progress todo");
      if (status === "blocked" && current.status !== "in_progress" && member.role !== "owner" && current.creatorId !== member.id) throw new GatewayTodoClaimError("Only an owner or creator may block an unclaimed todo");
      if (status === "pending" && current.status !== "blocked") throw new GatewayTodoStoreError("Only a blocked todo may return to pending");
      if (status === "pending" && member.role !== "owner" && current.creatorId !== member.id && current.assigneeId !== member.id) throw new GatewayTodoClaimError("Only an owner, creator, or assignee may unblock a todo");
      if (status === "cancelled" && member.role !== "owner" && current.assigneeId !== member.id) throw new GatewayTodoClaimError("Only an owner or current assignee may cancel a todo");
      const next = parseGatewayTodoTask({ ...current, status, revision: current.revision + 1, updatedAt: now, ...(status === "completed" ? { completedAt: now } : {}) }); state.todos[index] = next; emit("todo.advanced", { todoId, status }); return next;
    });
  }
}

export const TodoStore = GatewayTodoStore;
export const createGatewayTodoStore = (options: GatewayTodoStoreOptions | SessionStore) => new GatewayTodoStore(options);
export { assertAcyclic as validateGatewayTodoDependencies };

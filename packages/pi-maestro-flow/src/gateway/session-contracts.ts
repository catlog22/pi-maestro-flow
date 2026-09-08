/** Strict versioned contracts for the independent Gateway collaboration data plane. */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GATEWAY_COLLABORATION_LIMITS, GATEWAY_ID_PATTERN, GATEWAY_STATE_VERSION, GATEWAY_WORKSPACE_ID_PATTERN } from "./contracts.ts";
import { GATEWAY_HANDOFF_SCHEMA } from "./handoff-contracts.ts";
import { GATEWAY_HANDOFF_ORIGIN_SCHEMA } from "./handoff-record-contracts.ts";

export const COLLABORATIVE_SESSION_STATES = ["creating", "active", "closing", "closed"] as const;
export const SESSION_MEMBER_ROLES = ["owner", "agent", "web", "observer"] as const;
export const SESSION_MEMBER_STATES = ["joining", "active", "disconnected", "left", "lost"] as const;
export const GATEWAY_TODO_STATES = ["pending", "in_progress", "blocked", "completed", "cancelled"] as const;
export const SESSION_EVENT_TYPES = ["session.created", "session.transitioned", "session.handoff", "member.joined", "member.renewed", "member.state", "todo.created", "todo.updated", "todo.deleted", "todo.claimed", "todo.released", "todo.advanced"] as const;

const id = Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const state = <T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: "string", enum: [...values] });

export const COLLABORATIVE_SESSION_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION), id, status: state(COLLABORATIVE_SESSION_STATES), revision,
  workspaceId: Type.String({ minLength: 64, maxLength: 64, pattern: GATEWAY_WORKSPACE_ID_PATTERN.source }),
  workspacePath: Type.String({ minLength: 1, maxLength: 4096 }),
  handoff: Type.Optional(GATEWAY_HANDOFF_SCHEMA),
  /** Server-derived on new writes; absent on legacy records and normalized as unknown. */
  handoffOrigin: Type.Optional(GATEWAY_HANDOFF_ORIGIN_SCHEMA),
  createdAt: timestamp, updatedAt: timestamp, closedAt: Type.Optional(timestamp),
}, { additionalProperties: false });
export type CollaborativeSessionV1 = Static<typeof COLLABORATIVE_SESSION_SCHEMA>;

export const SESSION_MEMBER_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION), id, sessionId: id, principalId: Type.String({ minLength: 1, maxLength: 256 }),
  role: state(SESSION_MEMBER_ROLES), status: state(SESSION_MEMBER_STATES),
  capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }), { maxItems: 64, uniqueItems: true }),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  leaseExpiresAt: timestamp, joinedAt: timestamp, updatedAt: timestamp,
}, { additionalProperties: false });
export type SessionMemberV1 = Static<typeof SESSION_MEMBER_SCHEMA>;

export const GATEWAY_TODO_TASK_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION), id, sessionId: id, revision,
  subject: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  description: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  status: state(GATEWAY_TODO_STATES), assigneeId: Type.Optional(id),
  dependencyIds: Type.Array(id, { maxItems: 256, uniqueItems: true }), creatorId: id,
  createdAt: timestamp, updatedAt: timestamp, completedAt: Type.Optional(timestamp),
}, { additionalProperties: false });
export type GatewayTodoTaskV1 = Static<typeof GATEWAY_TODO_TASK_SCHEMA>;

export const SESSION_OPERATION_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION), id, sessionId: id, actorId: id,
  kind: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
  payloadHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  baseRevision: revision, committedRevision: revision, createdAt: timestamp, result: Type.Unknown(),
}, { additionalProperties: false });
export type SessionOperationV1 = Static<typeof SESSION_OPERATION_SCHEMA>;

export const SESSION_EVENT_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION), id, sessionId: id, revision,
  type: state(SESSION_EVENT_TYPES), actorId: id, createdAt: timestamp, data: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
export type SessionEventV1 = Static<typeof SESSION_EVENT_SCHEMA>;

export const COLLABORATIVE_SESSION_STATE_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION), session: COLLABORATIVE_SESSION_SCHEMA,
  members: Type.Array(SESSION_MEMBER_SCHEMA, { maxItems: GATEWAY_COLLABORATION_LIMITS.maxMembersPerSession }),
  todos: Type.Array(GATEWAY_TODO_TASK_SCHEMA, { maxItems: GATEWAY_COLLABORATION_LIMITS.maxTodosPerSession }),
  operations: Type.Array(SESSION_OPERATION_SCHEMA, { maxItems: GATEWAY_COLLABORATION_LIMITS.maxOperationsPerSession }),
  events: Type.Array(SESSION_EVENT_SCHEMA, { maxItems: GATEWAY_COLLABORATION_LIMITS.maxEventsPerSession }),
}, { additionalProperties: false });
export type CollaborativeSessionStateV1 = Static<typeof COLLABORATIVE_SESSION_STATE_SCHEMA>;

/** Public schema aliases matching the versioned contract type names. */
export const CollaborativeSessionV1Schema = COLLABORATIVE_SESSION_SCHEMA;
export const SessionMemberV1Schema = SESSION_MEMBER_SCHEMA;
export const GatewayTodoTaskV1Schema = GATEWAY_TODO_TASK_SCHEMA;
export const SessionOperationV1Schema = SESSION_OPERATION_SCHEMA;
export const SessionEventV1Schema = SESSION_EVENT_SCHEMA;
export const CollaborativeSessionStateV1Schema = COLLABORATIVE_SESSION_STATE_SCHEMA;
export const GATEWAY_SESSION_STATE_SCHEMA = COLLABORATIVE_SESSION_STATE_SCHEMA;

export class SessionContractError extends Error {
  constructor(message: string) { super(message); this.name = "SessionContractError"; }
}
function parse<T>(schema: unknown, value: unknown, label: string): T {
  const errors = [...Value.Errors(schema as never, value)];
  if (errors.length) throw new SessionContractError(`Invalid ${label}: ${errors.map((e) => `${(e as { path?: string }).path || "$"}: ${e.message}`).join("; ")}`);
  return value as T;
}
export const parseCollaborativeSession = (value: unknown) => parse<CollaborativeSessionV1>(COLLABORATIVE_SESSION_SCHEMA, value, "CollaborativeSessionV1");
export const parseSessionMember = (value: unknown) => parse<SessionMemberV1>(SESSION_MEMBER_SCHEMA, value, "SessionMemberV1");
export const parseGatewayTodoTask = (value: unknown) => parse<GatewayTodoTaskV1>(GATEWAY_TODO_TASK_SCHEMA, value, "GatewayTodoTaskV1");
export const parseSessionOperation = (value: unknown) => parse<SessionOperationV1>(SESSION_OPERATION_SCHEMA, value, "SessionOperationV1");
export const parseSessionEvent = (value: unknown) => parse<SessionEventV1>(SESSION_EVENT_SCHEMA, value, "SessionEventV1");
export function parseCollaborativeSessionState(value: unknown): CollaborativeSessionStateV1 {
  const parsed = parse<CollaborativeSessionStateV1>(COLLABORATIVE_SESSION_STATE_SCHEMA, value, "CollaborativeSessionStateV1");
  if (parsed.session.version !== GATEWAY_STATE_VERSION) throw new SessionContractError("Unsupported session state version");
  for (const [label, records] of [["member", parsed.members], ["todo", parsed.todos], ["operation", parsed.operations], ["event", parsed.events]] as const) {
    const seen = new Set<string>();
    for (const record of records) {
      if (record.sessionId !== parsed.session.id) throw new SessionContractError(`${label} belongs to a different session`);
      if (seen.has(record.id)) throw new SessionContractError(`Duplicate ${label} id ${record.id}`);
      seen.add(record.id);
    }
  }
  if (parsed.session.updatedAt < parsed.session.createdAt) throw new SessionContractError("Session updatedAt precedes createdAt");
  if (parsed.session.status === "closed" && parsed.session.closedAt === undefined) throw new SessionContractError("Closed session requires closedAt");
  const todoIds = new Set(parsed.todos.map((todo) => todo.id));
  const byTodo = new Map(parsed.todos.map((todo) => [todo.id, todo]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (todoId: string): void => {
    if (visiting.has(todoId)) throw new SessionContractError("Todo dependency cycle detected");
    if (visited.has(todoId)) return; visiting.add(todoId);
    for (const dependencyId of byTodo.get(todoId)?.dependencyIds ?? []) {
      if (!todoIds.has(dependencyId)) throw new SessionContractError(`Unknown todo dependency ${dependencyId}`);
      visit(dependencyId);
    }
    visiting.delete(todoId); visited.add(todoId);
  };
  for (const todo of parsed.todos) {
    if (todo.revision < 1) throw new SessionContractError("Todo revision must be positive");
    if (todo.updatedAt < todo.createdAt) throw new SessionContractError("Todo updatedAt precedes createdAt");
    if (todo.status === "in_progress" && todo.assigneeId === undefined) throw new SessionContractError("In-progress todo requires assigneeId");
    if (todo.status === "completed" && todo.completedAt === undefined) throw new SessionContractError("Completed todo requires completedAt");
    visit(todo.id);
  }
  for (const operation of parsed.operations) {
    if (operation.committedRevision !== operation.baseRevision + 1 || operation.committedRevision > parsed.session.revision) throw new SessionContractError("Operation revision invariant failed");
  }
  for (const event of parsed.events) if (event.revision < 1 || event.revision > parsed.session.revision) throw new SessionContractError("Event revision invariant failed");
  const latest = parsed.operations.reduce((maximum, operation) => Math.max(maximum, operation.committedRevision), 0);
  if (latest !== parsed.session.revision) throw new SessionContractError("Session revision does not match durable operations");
  return parsed;
}

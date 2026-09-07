/** Strict, versioned contracts for the workspace-level Gateway Board. */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  GATEWAY_HARD_LIMITS,
  GATEWAY_ID_PATTERN,
  GATEWAY_STATE_VERSION,
  GATEWAY_WORKSPACE_ID_PATTERN,
} from "./contracts.ts";

export const BOARD_TASK_STATUSES = ["open", "active", "blocked", "completed", "cancelled"] as const;
export const BOARD_TASK_PHASES = ["intake", "planning", "execution", "review"] as const;
export const BOARD_ACTOR_TYPES = ["pi", "web", "service"] as const;
export const BOARD_ENDPOINT_KINDS = ["pi", "web"] as const;
export const BOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const BOARD_EVENT_TYPES = [
  "task.created", "task.updated", "task.claimed", "task.claim.renewed", "task.released",
  "task.taken_over", "endpoint.attached", "endpoint.detached", "session.bound", "plan.linked",
  "status.changed", "task.completed", "task.cancelled",
] as const;

const strict = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source });
const workspaceId = Type.String({ minLength: 64, maxLength: 64, pattern: GATEWAY_WORKSPACE_ID_PATTERN.source });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveRevision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const cursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });
const state = <T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: "string", enum: [...values] });

export const BOARD_ACTOR_SCHEMA = Type.Object({
  actorId: Type.String({ minLength: 1, maxLength: 256 }),
  actorType: state(BOARD_ACTOR_TYPES),
}, strict);
export type BoardActorV1 = Static<typeof BOARD_ACTOR_SCHEMA>;

/** An authenticated Pi or Web participation endpoint; it never grants execution ownership. */
export const BOARD_ENDPOINT_BINDING_SCHEMA = Type.Object({
  kind: state(BOARD_ENDPOINT_KINDS),
  endpointId: id,
  principalId: Type.String({ minLength: 1, maxLength: 256 }),
  attachedAt: timestamp,
}, strict);
export type BoardEndpointBindingV1 = Static<typeof BOARD_ENDPOINT_BINDING_SCHEMA>;

/** A fenced, renewable claim. Generation is incremented whenever ownership changes. */
export const BOARD_TASK_CLAIM_SCHEMA = Type.Object({
  claimantId: Type.String({ minLength: 1, maxLength: 256 }),
  principalId: Type.String({ minLength: 1, maxLength: 256 }),
  actorType: state(BOARD_ACTOR_TYPES),
  generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  claimedAt: timestamp,
  leaseExpiresAt: timestamp,
}, strict);
export type BoardTaskClaimV1 = Static<typeof BOARD_TASK_CLAIM_SCHEMA>;

/** References collaboration state; it never embeds a Session or Todo record. */
export const BOARD_SESSION_BINDING_SCHEMA = Type.Object({
  sessionId: id,
  memberId: id,
  generation: positiveRevision,
  boundAt: timestamp,
}, strict);
export type BoardSessionBindingV1 = Static<typeof BOARD_SESSION_BINDING_SCHEMA>;

/** References only Todo ids from the bound Session; Todo remains the plan authority. */
export const BOARD_PLAN_BINDING_SCHEMA = Type.Object({
  sessionId: id,
  todoIds: Type.Array(id, { maxItems: 256, uniqueItems: true }),
  linkedAt: timestamp,
}, strict);
export type BoardPlanBindingV1 = Static<typeof BOARD_PLAN_BINDING_SCHEMA>;

/** Completion gates are explicit and independently composable. */
export const BOARD_COMPLETION_POLICY_SCHEMA = Type.Object({
  requireLinkedTodosCompleted: Type.Boolean(),
  requireReview: Type.Boolean(),
}, strict);
export type BoardCompletionPolicyV1 = Static<typeof BOARD_COMPLETION_POLICY_SCHEMA>;

export const BOARD_TASK_RESULT_SCHEMA = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  resourceUris: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 16, uniqueItems: true }),
  completedAt: timestamp,
}, strict);
export type BoardTaskResultV1 = Static<typeof BOARD_TASK_RESULT_SCHEMA>;

export const BOARD_TASK_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id,
  workspaceId,
  revision: positiveRevision,
  status: state(BOARD_TASK_STATUSES),
  phase: state(BOARD_TASK_PHASES),
  title: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
  description: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 8 * 1024 }), { maxItems: 32 }),
  priority: state(BOARD_PRIORITIES),
  labels: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true }),
  dependencyIds: Type.Array(id, { maxItems: 256, uniqueItems: true }),
  createdBy: BOARD_ACTOR_SCHEMA,
  /** Monotonic ownership fence retained even while the task is unclaimed. */
  claimGeneration: Type.Optional(positiveRevision),
  claim: Type.Optional(BOARD_TASK_CLAIM_SCHEMA),
  endpointBindings: Type.Optional(Type.Array(BOARD_ENDPOINT_BINDING_SCHEMA, { maxItems: 256 })),
  sessionBinding: Type.Optional(BOARD_SESSION_BINDING_SCHEMA),
  planBinding: Type.Optional(BOARD_PLAN_BINDING_SCHEMA),
  completionPolicy: BOARD_COMPLETION_POLICY_SCHEMA,
  result: Type.Optional(BOARD_TASK_RESULT_SCHEMA),
  createdAt: timestamp,
  updatedAt: timestamp,
  cancelledAt: Type.Optional(timestamp),
}, strict);
export type BoardTaskV1 = Static<typeof BOARD_TASK_SCHEMA>;

export const BOARD_OPERATION_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id,
  workspaceId,
  taskId: id,
  actorId: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
  payloadHash: hash,
  baseRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  committedRevision: positiveRevision,
  createdAt: timestamp,
  result: Type.Unknown(),
}, strict);
export type BoardOperationV1 = Static<typeof BOARD_OPERATION_SCHEMA>;

export const BOARD_EVENT_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id,
  workspaceId,
  taskId: id,
  revision: positiveRevision,
  cursor: positiveRevision,
  type: state(BOARD_EVENT_TYPES),
  actorId: Type.String({ minLength: 1, maxLength: 256 }),
  createdAt: timestamp,
  claimGeneration: Type.Optional(positiveRevision),
  endpointKind: Type.Optional(state(BOARD_ENDPOINT_KINDS)),
  endpointId: Type.Optional(id),
  sessionId: Type.Optional(id),
  todoIds: Type.Optional(Type.Array(id, { maxItems: 256, uniqueItems: true })),
  fromStatus: Type.Optional(state(BOARD_TASK_STATUSES)),
  toStatus: Type.Optional(state(BOARD_TASK_STATUSES)),
  fromPhase: Type.Optional(state(BOARD_TASK_PHASES)),
  toPhase: Type.Optional(state(BOARD_TASK_PHASES)),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4 * 1024 })),
}, strict);
export type BoardEventV1 = Static<typeof BOARD_EVENT_SCHEMA>;

/** Durable Board snapshot. Tasks are authoritative; bindings are references only. */
export const BOARD_ENVELOPE_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  workspaceId,
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  cursor,
  tasks: Type.Array(BOARD_TASK_SCHEMA, { maxItems: GATEWAY_HARD_LIMITS.maxBoardTasks }),
  operations: Type.Array(BOARD_OPERATION_SCHEMA, { maxItems: GATEWAY_HARD_LIMITS.maxBoardOperations }),
  events: Type.Array(BOARD_EVENT_SCHEMA, { maxItems: GATEWAY_HARD_LIMITS.maxBoardEvents }),
  createdAt: timestamp,
  updatedAt: timestamp,
}, strict);
export type BoardEnvelopeV1 = Static<typeof BOARD_ENVELOPE_SCHEMA>;

export class BoardContractError extends Error {
  constructor(message: string) { super(message); this.name = "BoardContractError"; }
}

function parse<T>(schema: unknown, value: unknown, label: string): T {
  const errors = [...Value.Errors(schema as never, value)];
  if (errors.length) throw new BoardContractError(`Invalid ${label}: ${errors.map((error) => `${(error as { path?: string }).path || "$"}: ${error.message}`).join("; ")}`);
  return value as T;
}

export function parseBoardTask(value: unknown): BoardTaskV1 {
  const task = parse<BoardTaskV1>(BOARD_TASK_SCHEMA, value, "BoardTaskV1");
  if (task.updatedAt < task.createdAt) throw new BoardContractError("Board task updatedAt precedes createdAt");
  if (task.claim && task.claim.leaseExpiresAt <= task.claim.claimedAt) throw new BoardContractError("Board claim leaseExpiresAt must follow claimedAt");
  if (task.claimGeneration !== undefined && task.claim && task.claim.generation !== task.claimGeneration) throw new BoardContractError("Board claim generation does not match its monotonic fence");
  if (task.status === "active" && !task.claim) throw new BoardContractError("Active board task requires a claim");
  if (task.status === "completed" && task.result === undefined) throw new BoardContractError("Completed board task requires result");
  if (task.status !== "completed" && task.result !== undefined) throw new BoardContractError("Only completed board tasks may have result");
  if (task.status === "cancelled" && task.cancelledAt === undefined) throw new BoardContractError("Cancelled board task requires cancelledAt");
  if (task.status !== "cancelled" && task.cancelledAt !== undefined) throw new BoardContractError("Only cancelled board tasks may have cancelledAt");
  if (task.result !== undefined && task.result.completedAt < task.createdAt) throw new BoardContractError("Board task result precedes createdAt");
  if (task.cancelledAt !== undefined && task.cancelledAt < task.createdAt) throw new BoardContractError("Board task cancelledAt precedes createdAt");
  const endpointKeys = new Set<string>();
  for (const binding of task.endpointBindings ?? []) {
    if (binding.attachedAt < task.createdAt || binding.attachedAt > task.updatedAt) throw new BoardContractError("Board endpoint attachedAt is outside the task lifetime");
    const expectedTransport = binding.kind === "pi" ? "stdio:" : "http:";
    if (!binding.principalId.startsWith(expectedTransport)) throw new BoardContractError("Board endpoint kind does not match its principal transport");
    const key = `${binding.kind}:${binding.endpointId}`;
    if (endpointKeys.has(key)) throw new BoardContractError(`Duplicate board endpoint binding ${key}`);
    endpointKeys.add(key);
  }
  if (task.sessionBinding && task.planBinding && task.sessionBinding.sessionId !== task.planBinding.sessionId) throw new BoardContractError("Board plan must belong to the bound Session");
  return task;
}

export function parseBoardTaskClaim(value: unknown): BoardTaskClaimV1 {
  const claim = parse<BoardTaskClaimV1>(BOARD_TASK_CLAIM_SCHEMA, value, "BoardTaskClaimV1");
  if (claim.leaseExpiresAt <= claim.claimedAt) throw new BoardContractError("Board claim leaseExpiresAt must follow claimedAt");
  return claim;
}
export const parseBoardSessionBinding = (value: unknown) => parse<BoardSessionBindingV1>(BOARD_SESSION_BINDING_SCHEMA, value, "BoardSessionBindingV1");
export const parseBoardPlanBinding = (value: unknown) => parse<BoardPlanBindingV1>(BOARD_PLAN_BINDING_SCHEMA, value, "BoardPlanBindingV1");
export const parseBoardCompletionPolicy = (value: unknown) => parse<BoardCompletionPolicyV1>(BOARD_COMPLETION_POLICY_SCHEMA, value, "BoardCompletionPolicyV1");
export const parseBoardEvent = (value: unknown) => parse<BoardEventV1>(BOARD_EVENT_SCHEMA, value, "BoardEventV1");
export function parseBoardOperation(value: unknown): BoardOperationV1 {
  const operation = parse<BoardOperationV1>(BOARD_OPERATION_SCHEMA, value, "BoardOperationV1");
  if (operation.committedRevision !== operation.baseRevision + 1) throw new BoardContractError("Board operation revision invariant failed");
  return operation;
}

export function parseBoardEnvelope(value: unknown): BoardEnvelopeV1 {
  const envelope = parse<BoardEnvelopeV1>(BOARD_ENVELOPE_SCHEMA, value, "BoardEnvelopeV1");
  if (envelope.updatedAt < envelope.createdAt) throw new BoardContractError("Board envelope updatedAt precedes createdAt");
  const tasks = new Map<string, BoardTaskV1>();
  for (const rawTask of envelope.tasks) {
    const task = parseBoardTask(rawTask);
    if (task.workspaceId !== envelope.workspaceId) throw new BoardContractError("Board task belongs to a different workspace");
    if (tasks.has(task.id)) throw new BoardContractError(`Duplicate board task id ${task.id}`);
    tasks.set(task.id, task);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new BoardContractError("Board task dependency cycle detected");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependencyId of tasks.get(taskId)?.dependencyIds ?? []) {
      if (!tasks.has(dependencyId)) throw new BoardContractError(`Unknown board task dependency ${dependencyId}`);
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of tasks.keys()) visit(taskId);

  const operationIds = new Set<string>();
  for (const rawOperation of envelope.operations) {
    const operation = parseBoardOperation(rawOperation);
    if (operation.workspaceId !== envelope.workspaceId || !tasks.has(operation.taskId)) throw new BoardContractError("Board operation references a different board");
    if (operationIds.has(operation.id)) throw new BoardContractError(`Duplicate board operation id ${operation.id}`);
    operationIds.add(operation.id);
    if (operation.committedRevision > tasks.get(operation.taskId)!.revision) throw new BoardContractError("Board operation revision exceeds task revision");
  }
  const eventIds = new Set<string>();
  let previousCursor = 0;
  for (const event of envelope.events) {
    if (event.workspaceId !== envelope.workspaceId || !tasks.has(event.taskId)) throw new BoardContractError("Board event references a different board");
    if (eventIds.has(event.id)) throw new BoardContractError(`Duplicate board event id ${event.id}`);
    eventIds.add(event.id);
    if (event.cursor <= previousCursor || event.cursor > envelope.cursor) throw new BoardContractError("Board event cursor invariant failed");
    if (event.revision > tasks.get(event.taskId)!.revision) throw new BoardContractError("Board event revision exceeds task revision");
    previousCursor = event.cursor;
  }
  if ((envelope.events.at(-1)?.cursor ?? 0) !== envelope.cursor) throw new BoardContractError("Board cursor does not match the latest event");
  const latestRevision = envelope.tasks.reduce((maximum, task) => Math.max(maximum, task.revision), 0);
  if (latestRevision > envelope.revision) throw new BoardContractError("Board revision precedes a task revision");
  return envelope;
}

export const BoardActorV1Schema = BOARD_ACTOR_SCHEMA;
export const BoardEndpointBindingV1Schema = BOARD_ENDPOINT_BINDING_SCHEMA;
export const BoardTaskClaimV1Schema = BOARD_TASK_CLAIM_SCHEMA;
export const BoardSessionBindingV1Schema = BOARD_SESSION_BINDING_SCHEMA;
export const BoardPlanBindingV1Schema = BOARD_PLAN_BINDING_SCHEMA;
export const BoardCompletionPolicyV1Schema = BOARD_COMPLETION_POLICY_SCHEMA;
export const BoardTaskResultV1Schema = BOARD_TASK_RESULT_SCHEMA;
export const BoardTaskV1Schema = BOARD_TASK_SCHEMA;
export const BoardOperationV1Schema = BOARD_OPERATION_SCHEMA;
export const BoardEventV1Schema = BOARD_EVENT_SCHEMA;
export const BoardEnvelopeV1Schema = BOARD_ENVELOPE_SCHEMA;

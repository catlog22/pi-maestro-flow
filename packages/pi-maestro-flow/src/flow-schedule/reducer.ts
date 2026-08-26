import type {
  ExactWindowIdentity,
  FlowScheduleAcceptedRecord,
  FlowScheduleCompletionRecord,
  FlowScheduleDispatch,
  FlowSchedulePublishedRecord,
  FlowScheduleRecord,
  FlowScheduleTodoBinding,
  FlowScheduleTodoOutcome,
} from "./types.ts";

export const FLOW_SCHEDULE_ACTOR_VERSION = 2 as const;

export type FlowScheduleActorKind = "schedule" | "dispatch";

export interface FlowScheduleTodoCapabilities {
  rootProjection: boolean;
  backendMutation: boolean;
  report: boolean;
}

export interface FlowScheduleActorEvent<TPayload = unknown> {
  version: typeof FLOW_SCHEDULE_ACTOR_VERSION;
  eventId: string;
  streamId: string;
  revision: number;
  /** Revision assigned by the Runtime Broker stream. */
  brokerRevision?: number;
  producerEpoch: number;
  eventType: FlowScheduleActorEventType;
  occurredAt: number;
  payload: TPayload;
}

export type FlowScheduleActorEventType =
  | "schedule.migrated.v1"
  | "schedule.created"
  | "schedule.started"
  | "schedule.paused"
  | "schedule.resumed"
  | "schedule.appended"
  | "schedule.retry_requested"
  | "schedule.cancelled"
  | "schedule.dispatch_admitted"
  | "schedule.dispatch_accepted"
  | "schedule.dispatch_completed"
  | "schedule.admission_deferred"
  | "schedule.admission_failed"
  | "schedule.projection_applied"
  | "schedule.projection_repaired"
  | "dispatch.prepared"
  | "dispatch.published"
  | "dispatch.accepted"
  | "dispatch.rejected"
  | "dispatch.retired"
  | "dispatch.binding_recorded"
  | "todo.capabilities_recorded"
  | "outbox.prepared"
  | "outbox.published"
  | "outbox.accepted"
  | "work.generic_terminal_observed"
  | "work.reported.completed"
  | "work.reported.failed"
  | "work.unreported_terminal";

export interface ScheduleActorState {
  kind: "schedule";
  scheduleId: string;
  streamId: string;
  revision: number;
  brokerRevision: number;
  producerEpoch: number;
  projection?: FlowScheduleRecord;
  migration: "none" | "v1-lazy" | "native-v2";
  projectionState: "none" | "pending" | "applied" | "repaired";
  projectionRevision?: number;
  lastEventAt?: number;
}

export interface DispatchActorState {
  kind: "dispatch";
  dispatchId: string;
  scheduleId?: string;
  stepId?: string;
  streamId: string;
  revision: number;
  brokerRevision: number;
  producerEpoch: number;
  transport: "none" | "prepared" | "published" | "accepted" | "rejected";
  business: "pending" | "reported" | "completed" | "failed" | "ambiguous" | "retired";
  targetIdentity?: ExactWindowIdentity;
  completionCorrelationKey?: string;
  intent?: FlowScheduleDispatch;
  published?: FlowSchedulePublishedRecord;
  accepted?: FlowScheduleAcceptedRecord;
  completion?: FlowScheduleCompletionRecord;
  binding?: FlowScheduleTodoBinding;
  capabilities?: FlowScheduleTodoCapabilities;
  todoOutcome?: FlowScheduleTodoOutcome;
  exactReportedAt?: number;
  genericTerminalAt?: number;
  genericGraceDeadline?: number;
  outbox: "none" | "prepared" | "published" | "accepted";
  outboxMessageId?: string;
  lastEventAt?: number;
}

export function initialScheduleActorState(scheduleId: string): ScheduleActorState {
  return {
    kind: "schedule",
    scheduleId,
    streamId: scheduleStreamId(scheduleId),
    revision: 0,
    brokerRevision: 0,
    producerEpoch: 0,
    migration: "none",
    projectionState: "none",
  };
}

export function initialDispatchActorState(dispatchId: string): DispatchActorState {
  return {
    kind: "dispatch",
    dispatchId,
    streamId: dispatchStreamId(dispatchId),
    revision: 0,
    brokerRevision: 0,
    producerEpoch: 0,
    transport: "none",
    business: "pending",
    outbox: "none",
  };
}

export function scheduleStreamId(scheduleId: string): string {
  return `flow-schedule/schedule/${scheduleId}`;
}

export function dispatchStreamId(dispatchId: string): string {
  return `flow-schedule/dispatch/${dispatchId}`;
}

export function todoCapabilitiesNegotiated(capabilities: FlowScheduleTodoCapabilities | undefined): boolean {
  return capabilities?.rootProjection === true
    && capabilities.backendMutation === true
    && capabilities.report === true;
}

export function reduceSchedule(
  state: ScheduleActorState,
  event: FlowScheduleActorEvent,
): ScheduleActorState {
  assertNextEvent(state.streamId, state.revision, state.producerEpoch, event);
  const next: ScheduleActorState = {
    ...state,
    revision: event.revision,
    brokerRevision: event.brokerRevision ?? state.brokerRevision,
    producerEpoch: event.producerEpoch,
    lastEventAt: event.occurredAt,
  };
  switch (event.eventType) {
    case "schedule.migrated.v1":
      return {
        ...next,
        projection: scheduleProjection(event.payload, state.scheduleId),
        migration: "v1-lazy",
        projectionState: "applied",
        projectionRevision: event.revision,
      };
    case "schedule.created":
      return {
        ...next,
        projection: scheduleProjection(event.payload, state.scheduleId),
        migration: "native-v2",
        projectionState: "pending",
      };
    case "schedule.started":
    case "schedule.paused":
    case "schedule.resumed":
    case "schedule.appended":
    case "schedule.retry_requested":
    case "schedule.cancelled":
    case "schedule.dispatch_admitted":
    case "schedule.dispatch_accepted":
    case "schedule.dispatch_completed":
    case "schedule.admission_deferred":
    case "schedule.admission_failed":
      return {
        ...next,
        projection: scheduleProjection(event.payload, state.scheduleId),
        projectionState: "pending",
      };
    case "schedule.projection_applied":
      return {
        ...next,
        ...(eventPayload(event.payload).projection ? { projection: scheduleProjection(event.payload, state.scheduleId) } : {}),
        projectionState: "applied",
        projectionRevision: event.revision,
      };
    case "schedule.projection_repaired":
      return {
        ...next,
        projection: scheduleProjection(event.payload, state.scheduleId),
        projectionState: "repaired",
        projectionRevision: event.revision,
      };
    default:
      throw new Error(`Event ${event.eventType} does not belong to a schedule actor`);
  }
}

export function reduceDispatch(
  state: DispatchActorState,
  event: FlowScheduleActorEvent,
): DispatchActorState {
  assertNextEvent(state.streamId, state.revision, state.producerEpoch, event);
  const next: DispatchActorState = {
    ...state,
    revision: event.revision,
    brokerRevision: event.brokerRevision ?? state.brokerRevision,
    producerEpoch: event.producerEpoch,
    lastEventAt: event.occurredAt,
  };
  const payload = eventPayload(event.payload);
  switch (event.eventType) {
    case "dispatch.prepared":
      if (state.transport !== "none") return next;
      return {
        ...next,
        scheduleId: requiredText(payload.scheduleId ?? dispatchRecord(payload.intent)?.scheduleId, "scheduleId"),
        stepId: requiredText(payload.stepId ?? dispatchRecord(payload.intent)?.stepId, "stepId"),
        targetIdentity: exactIdentity(payload.targetIdentity ?? dispatchRecord(payload.intent)?.targetIdentity),
        completionCorrelationKey: optionalText(payload.completionCorrelationKey),
        ...(dispatchRecord(payload.intent) ? { intent: structuredClone(dispatchRecord(payload.intent)!) } : {}),
        transport: "prepared",
      };
    case "dispatch.published":
      return state.transport === "prepared" ? {
        ...next,
        transport: "published",
        ...(publishedRecord(payload.published) ? { published: structuredClone(publishedRecord(payload.published)!) } : {}),
      } : next;
    case "dispatch.accepted":
      return state.transport === "prepared" || state.transport === "published"
        ? {
          ...next,
          transport: "accepted",
          ...(acceptedRecord(payload.accepted) ? { accepted: structuredClone(acceptedRecord(payload.accepted)!) } : {}),
        }
        : next;
    case "dispatch.rejected":
      return isTerminalBusiness(state.business) ? next : { ...next, transport: "rejected" };
    case "dispatch.retired":
      return {
        ...next,
        business: "retired",
        ...(completionRecord(payload.completion) ? { completion: structuredClone(completionRecord(payload.completion)!) } : {}),
      };
    case "dispatch.binding_recorded":
      return { ...next, binding: structuredClone(requiredBinding(payload.binding)) };
    case "todo.capabilities_recorded":
      return { ...next, capabilities: todoCapabilities(payload) };
    case "outbox.prepared":
      return {
        ...next,
        outbox: state.outbox === "none" ? "prepared" : state.outbox,
        outboxMessageId: requiredText(payload.messageId, "messageId"),
      };
    case "outbox.published":
      return state.outbox === "prepared" ? { ...next, outbox: "published" } : next;
    case "outbox.accepted":
      return state.outbox === "prepared" || state.outbox === "published"
        ? { ...next, outbox: "accepted" }
        : next;
    case "work.generic_terminal_observed": {
      if (isTerminalBusiness(state.business) || state.exactReportedAt !== undefined) return next;
      const terminalAt = requiredInteger(payload.terminalAt, "terminalAt");
      const graceDeadline = requiredInteger(payload.graceDeadline, "graceDeadline");
      if (graceDeadline < terminalAt) throw new Error("Generic terminal grace deadline precedes evidence");
      return {
        ...next,
        genericTerminalAt: state.genericTerminalAt ?? terminalAt,
        genericGraceDeadline: state.genericGraceDeadline ?? graceDeadline,
      };
    }
    case "work.reported.completed":
    case "work.reported.failed": {
      if (isTerminalBusiness(state.business)) return next;
      assertExactReport(state, payload);
      return {
        ...next,
        business: event.eventType === "work.reported.completed" ? "completed" : "failed",
        exactReportedAt: requiredInteger(payload.reportedAt, "reportedAt"),
        todoOutcome: parseTodoOutcome(payload.todoOutcome),
        ...(completionRecord(payload.completion) ? { completion: structuredClone(completionRecord(payload.completion)!) } : {}),
      };
    }
    case "work.unreported_terminal": {
      if (isTerminalBusiness(state.business) || state.exactReportedAt !== undefined) return next;
      const deadline = state.genericGraceDeadline;
      const expiredAt = requiredInteger(payload.expiredAt, "expiredAt");
      if (deadline === undefined || expiredAt < deadline) {
        throw new Error("Unreported terminal cannot commit before generic grace expires");
      }
      return {
        ...next,
        business: "ambiguous",
        ...(completionRecord(payload.completion) ? { completion: structuredClone(completionRecord(payload.completion)!) } : {}),
      };
    }
    default:
      throw new Error(`Event ${event.eventType} does not belong to a dispatch actor`);
  }
}

export function replaySchedule(scheduleId: string, events: readonly FlowScheduleActorEvent[]): ScheduleActorState {
  return events.reduce(reduceSchedule, initialScheduleActorState(scheduleId));
}

export function replayDispatch(dispatchId: string, events: readonly FlowScheduleActorEvent[]): DispatchActorState {
  return events.reduce(reduceDispatch, initialDispatchActorState(dispatchId));
}

function assertNextEvent(
  streamId: string,
  revision: number,
  producerEpoch: number,
  event: FlowScheduleActorEvent,
): void {
  if (event.version !== FLOW_SCHEDULE_ACTOR_VERSION || event.streamId !== streamId) {
    throw new Error("Flow actor event identity does not match its stream");
  }
  if (event.revision !== revision + 1) {
    throw new Error(`Flow actor revision conflict: expected ${revision + 1}, received ${event.revision}`);
  }
  if (!Number.isSafeInteger(event.producerEpoch) || event.producerEpoch < 1 || event.producerEpoch < producerEpoch) {
    throw new Error("Flow actor event producer epoch is stale");
  }
}

function scheduleProjection(value: unknown, scheduleId: string): FlowScheduleRecord {
  const payload = eventPayload(value);
  const projection = payload.projection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    throw new Error("Schedule actor event has no projection");
  }
  const record = structuredClone(projection) as FlowScheduleRecord;
  if (record.scheduleId !== scheduleId) throw new Error("Schedule projection identity mismatch");
  return record;
}

function assertExactReport(state: DispatchActorState, payload: Record<string, unknown>): void {
  if (payload.exact !== true
    || payload.dispatchId !== state.dispatchId
    || payload.identityMatches !== true
    || payload.completionCorrelationMatches !== true) {
    throw new Error("Work report is not exact and dispatch-bound");
  }
  if (state.capabilities && state.capabilities.report !== true) {
    throw new Error("Work report capability was not negotiated");
  }
}

function eventPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Flow actor event payload");
  return value as Record<string, unknown>;
}

function dispatchRecord(value: unknown): FlowScheduleDispatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as FlowScheduleDispatch;
}

function publishedRecord(value: unknown): FlowSchedulePublishedRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as FlowSchedulePublishedRecord;
}

function acceptedRecord(value: unknown): FlowScheduleAcceptedRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as FlowScheduleAcceptedRecord;
}

function completionRecord(value: unknown): FlowScheduleCompletionRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as FlowScheduleCompletionRecord;
}

function requiredBinding(value: unknown): FlowScheduleTodoBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dispatch actor event has no binding");
  return value as FlowScheduleTodoBinding;
}

function exactIdentity(value: unknown): ExactWindowIdentity {
  const payload = eventPayload(value);
  return {
    workspaceId: requiredText(payload.workspaceId, "workspaceId"),
    endpointId: requiredText(payload.endpointId, "endpointId"),
    ownerId: requiredText(payload.ownerId, "ownerId"),
    ownerNonce: requiredText(payload.ownerNonce, "ownerNonce"),
    ...(payload.sessionId === undefined ? {} : { sessionId: requiredText(payload.sessionId, "sessionId") }),
  };
}

function todoCapabilities(payload: Record<string, unknown>): FlowScheduleTodoCapabilities {
  return {
    rootProjection: payload.rootProjection === true,
    backendMutation: payload.backendMutation === true,
    report: payload.report === true,
  };
}

function parseTodoOutcome(value: unknown): FlowScheduleTodoOutcome | undefined {
  if (value === undefined) return undefined;
  const payload = eventPayload(value);
  const todoStatus = payload.todoStatus;
  if (todoStatus !== "pending" && todoStatus !== "in_progress" && todoStatus !== "completed"
    && todoStatus !== "blocked" && todoStatus !== "failed") {
    throw new Error("Invalid Todo outcome status");
  }
  return { todoId: requiredText(payload.todoId, "todoId"), todoStatus };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`Invalid ${label}`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredText(value, "optional text");
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

function isTerminalBusiness(state: DispatchActorState["business"]): boolean {
  return state === "completed" || state === "failed" || state === "ambiguous" || state === "retired";
}

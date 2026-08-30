import {
  projectSessionEndpoints,
  type SessionEndpoint,
  type SessionEndpointCapability,
  type SessionEndpointTransport,
  type SessionOwnerProjection,
} from "../sessions/session-core.ts";
import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
  type RuntimeDomainEventV2,
  type RuntimeEventDraftV2,
} from "./contracts.ts";
import { parseActorAddressV2 } from "./validation.ts";

export const SESSION_DOMAIN_VERSION_V2 = 1 as const;
export const SESSION_WINDOW_ADVERTISED_EVENT_V2 = "session.window.advertised" as const;
export const SESSION_WINDOW_HEARTBEAT_EVENT_V2 = "session.window.heartbeat" as const;
export const SESSION_WINDOW_WITHDRAWN_EVENT_V2 = "session.window.withdrawn" as const;
export const SESSION_MESSAGE_ACCEPTED_EVENT_V2 = "session.message.accepted" as const;
export const SESSION_MESSAGE_INJECTED_EVENT_V2 = "session.message.injected" as const;
export const SESSION_MESSAGE_REPLIED_EVENT_V2 = "session.message.replied" as const;

export type SessionDomainEventTypeV2 =
  | typeof SESSION_WINDOW_ADVERTISED_EVENT_V2
  | typeof SESSION_WINDOW_HEARTBEAT_EVENT_V2
  | typeof SESSION_WINDOW_WITHDRAWN_EVENT_V2
  | typeof SESSION_MESSAGE_ACCEPTED_EVENT_V2
  | typeof SESSION_MESSAGE_INJECTED_EVENT_V2
  | typeof SESSION_MESSAGE_REPLIED_EVENT_V2;

export interface SessionRouteAuthorityV2 {
  kind: "local" | "ssh";
  authorityId: string;
  instanceNonce?: string;
}

export interface SessionRouteCaptureV2 {
  version: typeof SESSION_DOMAIN_VERSION_V2;
  authority: SessionRouteAuthorityV2;
  actor: ActorAddressV2;
  transport: Extract<SessionEndpointTransport, "workspace-peer-v1" | "remote-workspace-rpc-v1" | "local-root"> | "runtime-broker-v2";
  capabilities: readonly SessionEndpointCapability[];
  workspaceRef?: string;
  target?: string;
  ownerId: string;
  ownerNonce: string;
  cancel: false;
}

export interface SessionWindowDomainPayloadV2 {
  version: typeof SESSION_DOMAIN_VERSION_V2;
  route: SessionRouteCaptureV2;
  status: "running" | "sleeping" | "unavailable";
  sessionId?: string;
  sessionName?: string;
  agentCount: number;
  reason?: "owner-replaced" | "gateway-replaced" | "monitor-exited" | "expired";
}

export interface SessionMessageDomainPayloadV2 {
  version: typeof SESSION_DOMAIN_VERSION_V2;
  route: SessionRouteCaptureV2;
  messageId: string;
  direction: "incoming" | "outgoing";
  mode: "steer" | "follow_up";
  inReplyTo?: string;
}

export type SessionDomainPayloadV2 = SessionWindowDomainPayloadV2 | SessionMessageDomainPayloadV2;

export interface SessionWindowReadEntityV2 extends SessionWindowDomainPayloadV2 {
  updatedAt: number;
  lastSequence: number;
}

export interface SessionMessageReadEntityV2 extends SessionMessageDomainPayloadV2 {
  stage: "accepted" | "injected" | "replied";
  updatedAt: number;
  lastSequence: number;
}

export interface SessionDomainReadModelSnapshotV2 {
  version: typeof SESSION_DOMAIN_VERSION_V2;
  cursor: number;
  windows: readonly SessionWindowReadEntityV2[];
  messages: readonly SessionMessageReadEntityV2[];
}

const CAPABILITIES = new Set<SessionEndpointCapability>([
  "inspect", "message", "steer", "follow_up", "interrupt", "abort", "wake", "receipt", "reply",
  "monitor-workspace-aggregation", "flow-schedule-todo-binding", "flow-schedule-todo-projection",
  "flow-schedule-todo-mutation", "flow-schedule-report",
]);
const TRANSPORTS = new Set<SessionRouteCaptureV2["transport"]>([
  "workspace-peer-v1", "remote-workspace-rpc-v1", "local-root", "runtime-broker-v2",
]);
const WINDOW_EVENTS = new Set<SessionDomainEventTypeV2>([
  SESSION_WINDOW_ADVERTISED_EVENT_V2,
  SESSION_WINDOW_HEARTBEAT_EVENT_V2,
  SESSION_WINDOW_WITHDRAWN_EVENT_V2,
]);
const MESSAGE_EVENTS = new Set<SessionDomainEventTypeV2>([
  SESSION_MESSAGE_ACCEPTED_EVENT_V2,
  SESSION_MESSAGE_INJECTED_EVENT_V2,
  SESSION_MESSAGE_REPLIED_EVENT_V2,
]);
const MESSAGE_STAGE = {
  [SESSION_MESSAGE_ACCEPTED_EVENT_V2]: "accepted",
  [SESSION_MESSAGE_INJECTED_EVENT_V2]: "injected",
  [SESSION_MESSAGE_REPLIED_EVENT_V2]: "replied",
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum = 1024): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseSessionRouteCaptureV2(value: unknown): SessionRouteCaptureV2 {
  if (!record(value)
    || !knownKeys(value, [
      "version", "authority", "actor", "transport", "capabilities", "workspaceRef",
      "target", "ownerId", "ownerNonce", "cancel",
    ])
    || value.version !== SESSION_DOMAIN_VERSION_V2
    || !record(value.authority)
    || !knownKeys(value.authority, ["kind", "authorityId", "instanceNonce"])
    || (value.authority.kind !== "local" && value.authority.kind !== "ssh")
    || !text(value.authority.authorityId)
    || (value.authority.instanceNonce !== undefined && !text(value.authority.instanceNonce))
    || !TRANSPORTS.has(value.transport as SessionRouteCaptureV2["transport"])
    || !Array.isArray(value.capabilities)
    || value.capabilities.length < 1
    || value.capabilities.some((capability) => !CAPABILITIES.has(capability as SessionEndpointCapability))
    || new Set(value.capabilities).size !== value.capabilities.length
    || (value.workspaceRef !== undefined && !text(value.workspaceRef))
    || (value.target !== undefined && !text(value.target))
    || !text(value.ownerId)
    || !text(value.ownerNonce)
    || value.cancel !== false) {
    throw new Error("Invalid Runtime V2 session route capture");
  }
  const actor = parseActorAddressV2(value.actor);
  if (actor.workspaceId.length === 0) throw new Error("Invalid Runtime V2 session route actor");
  return Object.freeze({
    version: SESSION_DOMAIN_VERSION_V2,
    authority: Object.freeze({
      kind: value.authority.kind,
      authorityId: value.authority.authorityId,
      ...(value.authority.instanceNonce === undefined ? {} : { instanceNonce: value.authority.instanceNonce }),
    }),
    actor,
    transport: value.transport as SessionRouteCaptureV2["transport"],
    capabilities: Object.freeze([...value.capabilities] as SessionEndpointCapability[]),
    ...(value.workspaceRef === undefined ? {} : { workspaceRef: value.workspaceRef }),
    ...(value.target === undefined ? {} : { target: value.target }),
    ownerId: value.ownerId,
    ownerNonce: value.ownerNonce,
    cancel: false,
  });
}

export function sessionRouteCaptureV2FromEndpoint(endpoint: SessionEndpoint): SessionRouteCaptureV2 {
  return parseSessionRouteCaptureV2({
    version: SESSION_DOMAIN_VERSION_V2,
    authority: endpoint.routeAuthority ?? {
      kind: "local",
      authorityId: endpoint.workspaceId,
      instanceNonce: endpoint.sourceId,
    },
    actor: {
      version: RUNTIME_V2_VERSION,
      revision: RUNTIME_V2_REVISION,
      workspaceId: endpoint.workspaceId,
      actorKind: "root",
      actorId: endpoint.ownerId,
      generation: endpoint.generation ?? 1,
    },
    transport: endpoint.transport === "remote-workspace-rpc-v1" ? endpoint.transport
      : endpoint.transport === "local-root" ? endpoint.transport
      : "workspace-peer-v1",
    capabilities: endpoint.capabilities,
    ...(endpoint.workspaceRef === undefined ? {} : { workspaceRef: endpoint.workspaceRef }),
    ...(endpoint.target === undefined ? {} : { target: endpoint.target }),
    ownerId: endpoint.ownerId,
    ownerNonce: endpoint.ownerNonce,
    cancel: false,
  });
}

export function parseSessionDomainPayloadV2(
  eventType: SessionDomainEventTypeV2,
  value: unknown,
): SessionDomainPayloadV2 {
  if (!record(value) || value.version !== SESSION_DOMAIN_VERSION_V2) throw new Error("Invalid Runtime V2 session payload");
  const route = parseSessionRouteCaptureV2(value.route);
  if (WINDOW_EVENTS.has(eventType)) {
    if (!knownKeys(value, ["version", "route", "status", "sessionId", "sessionName", "agentCount", "reason"])
      || (value.status !== "running" && value.status !== "sleeping" && value.status !== "unavailable")
      || (value.sessionId !== undefined && !text(value.sessionId))
      || (value.sessionName !== undefined && !text(value.sessionName))
      || !integer(value.agentCount)
      || (value.reason !== undefined && !["owner-replaced", "gateway-replaced", "monitor-exited", "expired"].includes(String(value.reason)))) {
      throw new Error("Invalid Runtime V2 session window payload");
    }
    if (eventType === SESSION_WINDOW_WITHDRAWN_EVENT_V2 && value.status !== "unavailable") {
      throw new Error("Withdrawn Runtime V2 session window must be unavailable");
    }
    return Object.freeze({
      version: SESSION_DOMAIN_VERSION_V2,
      route,
      status: value.status,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      ...(value.sessionName === undefined ? {} : { sessionName: value.sessionName }),
      agentCount: value.agentCount,
      ...(value.reason === undefined ? {} : { reason: value.reason as SessionWindowDomainPayloadV2["reason"] }),
    });
  }
  if (!MESSAGE_EVENTS.has(eventType)
    || !knownKeys(value, ["version", "route", "messageId", "direction", "mode", "inReplyTo"])
    || !text(value.messageId)
    || (value.direction !== "incoming" && value.direction !== "outgoing")
    || (value.mode !== "steer" && value.mode !== "follow_up")
    || (value.inReplyTo !== undefined && !text(value.inReplyTo))) {
    throw new Error("Invalid Runtime V2 session message payload");
  }
  return Object.freeze({
    version: SESSION_DOMAIN_VERSION_V2,
    route,
    messageId: value.messageId,
    direction: value.direction,
    mode: value.mode,
    ...(value.inReplyTo === undefined ? {} : { inReplyTo: value.inReplyTo }),
  });
}

export function createSessionDomainEventDraftV2(input: {
  eventType: SessionDomainEventTypeV2;
  streamId: string;
  actor: ActorAddressV2;
  eventId: string;
  occurredAt: number;
  payload: SessionDomainPayloadV2;
}): RuntimeEventDraftV2 {
  const actor = parseActorAddressV2(input.actor);
  if (!text(input.streamId) || !text(input.eventId) || !integer(input.occurredAt)) throw new Error("Invalid Runtime V2 session event header");
  const payload = parseSessionDomainPayloadV2(input.eventType, input.payload);
  return Object.freeze({
    version: RUNTIME_V2_VERSION,
    revision: RUNTIME_V2_REVISION,
    streamId: input.streamId,
    actor,
    occurredAt: input.occurredAt,
    kind: "domain.event",
    eventType: input.eventType,
    eventId: input.eventId,
    payload,
  });
}

function routeKey(route: SessionRouteCaptureV2): string {
  return `${route.authority.kind}:${route.authority.authorityId}:${route.authority.instanceNonce ?? ""}:${route.actor.workspaceId}:${route.ownerId}:${route.ownerNonce}`;
}

function messageKey(payload: SessionMessageDomainPayloadV2): string {
  return `${routeKey(payload.route)}:${payload.direction}:${payload.messageId}`;
}

function isSessionDomainEventType(value: string): value is SessionDomainEventTypeV2 {
  return WINDOW_EVENTS.has(value as SessionDomainEventTypeV2) || MESSAGE_EVENTS.has(value as SessionDomainEventTypeV2);
}

export class SessionDomainProjectionV2 {
  readonly #windows = new Map<string, SessionWindowReadEntityV2>();
  readonly #messages = new Map<string, SessionMessageReadEntityV2>();
  readonly #streamSequences = new Map<string, number>();
  #cursor = 0;

  apply(event: RuntimeDomainEventV2, cursor = this.#cursor + 1): boolean {
    if (!isSessionDomainEventType(event.eventType) || !integer(cursor, 1) || cursor <= this.#cursor) return false;
    const previousSequence = this.#streamSequences.get(event.streamId) ?? 0;
    if (event.sequence !== previousSequence + 1) return false;
    let payload: SessionDomainPayloadV2;
    try {
      payload = parseSessionDomainPayloadV2(event.eventType, event.payload);
    } catch {
      return false;
    }
    if (WINDOW_EVENTS.has(event.eventType)) {
      const window = payload as SessionWindowDomainPayloadV2;
      const key = routeKey(window.route);
      if (event.eventType === SESSION_WINDOW_WITHDRAWN_EVENT_V2) this.#windows.delete(key);
      else this.#windows.set(key, { ...window, updatedAt: event.occurredAt, lastSequence: event.sequence });
    } else {
      const message = payload as SessionMessageDomainPayloadV2;
      const key = messageKey(message);
      const stage = MESSAGE_STAGE[event.eventType as keyof typeof MESSAGE_STAGE];
      const previous = this.#messages.get(key);
      const ranks = { accepted: 0, injected: 1, replied: 2 } as const;
      if (previous && ranks[stage] < ranks[previous.stage]) return false;
      this.#messages.set(key, { ...message, stage, updatedAt: event.occurredAt, lastSequence: event.sequence });
    }
    this.#streamSequences.set(event.streamId, event.sequence);
    this.#cursor = cursor;
    return true;
  }

  snapshot(): SessionDomainReadModelSnapshotV2 {
    return {
      version: SESSION_DOMAIN_VERSION_V2,
      cursor: this.#cursor,
      windows: Object.freeze([...this.#windows.values()].sort((left, right) => routeKey(left.route).localeCompare(routeKey(right.route)))),
      messages: Object.freeze([...this.#messages.values()].sort((left, right) => messageKey(left).localeCompare(messageKey(right)))),
    };
  }
}

export function sessionEndpointsFromReadModelV2(
  snapshot: SessionDomainReadModelSnapshotV2,
): readonly SessionEndpoint[] {
  const owners: SessionOwnerProjection[] = snapshot.windows.map((window) => {
    const route = window.route;
    const scope = route.authority.kind === "ssh"
      ? "ssh-window" as const
      : route.transport === "local-root" ? "local" as const : "workspace-peer" as const;
    const transport: SessionEndpointTransport = route.authority.kind === "ssh"
      ? "remote-workspace-rpc-v1"
      : route.transport === "workspace-peer-v1" ? "workspace-peer-v1" : "local-root";
    return {
      workspaceId: route.actor.workspaceId,
      ownerId: route.ownerId,
      ownerNonce: route.ownerNonce,
      scope,
      transport,
      status: window.status === "unavailable" ? "sleeping" : window.status,
      ...(window.sessionId === undefined ? {} : { sessionId: window.sessionId }),
      ...(window.sessionName === undefined ? {} : { sessionName: window.sessionName }),
      sourceId: route.actor.actorId,
      generation: route.actor.generation,
      ...(route.workspaceRef === undefined ? {} : { workspaceRef: route.workspaceRef }),
      ...(route.target === undefined ? {} : { target: route.target }),
      routeAuthority: { ...route.authority },
      capabilities: route.capabilities,
      agentCount: window.agentCount,
      agents: [],
    };
  });
  return projectSessionEndpoints(owners);
}

export interface SessionShadowComparisonV2 {
  matches: boolean;
  missingFromV2: readonly string[];
  unexpectedInV2: readonly string[];
  changed: readonly string[];
}

export function compareSessionEndpointShadowV2(
  endpoints: readonly SessionEndpoint[],
  snapshot: SessionDomainReadModelSnapshotV2,
): SessionShadowComparisonV2 {
  const expected = new Map(endpoints.filter((endpoint) => endpoint.kind === "root").map((endpoint) => {
    const route = sessionRouteCaptureV2FromEndpoint(endpoint);
    return [routeKey(route), {
      status: endpoint.status === "settled" ? "sleeping" : endpoint.status,
      capabilities: [...endpoint.capabilities],
      target: endpoint.target,
    }];
  }));
  const actual = new Map(snapshot.windows.map((window) => [routeKey(window.route), {
    status: window.status,
    capabilities: [...window.route.capabilities],
    target: window.route.target,
  }]));
  const missingFromV2 = [...expected.keys()].filter((key) => !actual.has(key));
  const unexpectedInV2 = [...actual.keys()].filter((key) => !expected.has(key));
  const changed = [...expected.keys()].filter((key) => actual.has(key) && JSON.stringify(expected.get(key)) !== JSON.stringify(actual.get(key)));
  return Object.freeze({
    matches: missingFromV2.length === 0 && unexpectedInV2.length === 0 && changed.length === 0,
    missingFromV2: Object.freeze(missingFromV2),
    unexpectedInV2: Object.freeze(unexpectedInV2),
    changed: Object.freeze(changed),
  });
}

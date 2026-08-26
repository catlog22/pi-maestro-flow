import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createRuntimeActorHost,
  getRuntimeWorkspaceIdentity,
  type RuntimeActorHostClient,
  type RuntimeActorLease,
} from "pi-maestro-teammate/v2/runtime-broker";
import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
  type RuntimeDomainEventV2,
  type RuntimeEventDraftV2,
  type RuntimeEventV2,
} from "pi-maestro-teammate/v2/runtime";
import {
  FLOW_SCHEDULE_ACTOR_VERSION,
  dispatchStreamId,
  initialDispatchActorState,
  initialScheduleActorState,
  reduceDispatch,
  reduceSchedule,
  replayDispatch,
  replaySchedule,
  scheduleStreamId,
  type DispatchActorState,
  type FlowScheduleActorEvent,
  type FlowScheduleActorEventType,
  type ScheduleActorState,
} from "./reducer.ts";
import {
  FLOW_SCHEDULE_DISPATCH_ID_PATTERN,
  FLOW_SCHEDULE_ID_PATTERN,
  type FlowScheduleRecord,
} from "./types.ts";

export interface FlowScheduleActorRuntimeOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  actorHost?: RuntimeActorHostClient;
  holderId?: string;
  now?: () => number;
}

export interface FlowScheduleActorStatus {
  kind: "schedule" | "dispatch";
  id: string;
  streamId: string;
  revision: number;
  brokerRevision: number;
  leaseEpoch?: number;
  leaseNonce?: string;
  exactReportedAt?: number;
  genericTerminalAt?: number;
  genericGraceDeadline?: number;
  outboxState?: DispatchActorState["outbox"];
  outboxMessageId?: string;
  migration?: ScheduleActorState["migration"];
  projectionState?: ScheduleActorState["projectionState"];
}

type ActorState = ScheduleActorState | DispatchActorState;

export class FlowScheduleLeaseUnavailableError extends Error {
  constructor(readonly streamId: string) {
    super(`Flow schedule actor lease is owned elsewhere: ${streamId}`);
    this.name = "FlowScheduleLeaseUnavailableError";
  }
}

export class FlowScheduleActorRuntime {
  readonly projectRoot: string;
  readonly rootDir: string;
  readonly host: RuntimeActorHostClient;
  readonly workspaceId: string;
  readonly legacyWorkspaceIds: readonly string[];
  private readonly holderId: string;
  private readonly now: () => number;
  private readonly actors = new Map<string, DurableFlowActor>();
  private readonly acquisitions = new Map<string, Promise<DurableFlowActor>>();
  private readonly retirements = new Map<string, Promise<void>>();
  private stopped = false;
  private stopPromise: Promise<void> | undefined;

  constructor(options: FlowScheduleActorRuntimeOptions) {
    const workspaceIdentity = getRuntimeWorkspaceIdentity(options.projectRoot);
    this.projectRoot = workspaceIdentity.canonicalPath;
    this.rootDir = join(this.projectRoot, ".pi", "flow-schedule", "v2");
    this.host = options.actorHost ?? createRuntimeActorHost({ cwd: this.projectRoot, env: options.env });
    this.workspaceId = workspaceIdentity.workspaceId;
    this.legacyWorkspaceIds = workspaceIdentity.legacyWorkspaceIds;
    this.holderId = options.holderId ?? `flow-schedule:${process.pid}:${randomUUID()}`;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.host.mode !== "off";
  }

  async ensureSchedule(
    schedule: FlowScheduleRecord,
    allowAcquire = true,
  ): Promise<ScheduleActorState> {
    const actor = await this.scheduleActor(schedule.scheduleId, allowAcquire);
    const state = actor.state as ScheduleActorState;
    if (state.revision === 0) {
      return actor.commit("schedule.migrated.v1", { projection: schedule }) as Promise<ScheduleActorState>;
    }
    return state;
  }

  async scheduleState(scheduleId: string, allowAcquire = true): Promise<ScheduleActorState> {
    const actor = await this.scheduleActor(scheduleId, allowAcquire);
    return actor.state as ScheduleActorState;
  }

  hasScheduleLease(scheduleId: string): boolean {
    const key = `schedule:${scheduleId}`;
    const actor = this.actors.get(key);
    if (!actor) return false;
    if (actor.active) return true;
    this.actors.delete(key);
    void this.retire(key, actor).catch(() => undefined);
    return false;
  }

  async discoverScheduleIds(): Promise<string[]> {
    return this.discoverIds("schedule");
  }

  async discoverDispatchIds(): Promise<string[]> {
    return this.discoverIds("dispatch");
  }

  async commitSchedule(
    scheduleId: string,
    eventType: Extract<FlowScheduleActorEventType, `schedule.${string}`>,
    projection: FlowScheduleRecord,
  ): Promise<ScheduleActorState> {
    const actor = await this.scheduleActor(scheduleId);
    const state = actor.state as ScheduleActorState;
    if (sameProjection(state.projection, projection)) {
      if (eventType === "schedule.projection_applied"
        && state.projectionState !== "pending") return state;
      if (eventType !== "schedule.projection_applied"
        && eventType !== "schedule.projection_repaired") return state;
    }
    return actor.commit(eventType, { projection }) as Promise<ScheduleActorState>;
  }

  async commitDispatch(
    dispatchId: string,
    eventType: Exclude<FlowScheduleActorEventType, `schedule.${string}`>,
    payload: Record<string, unknown>,
    eventId?: string,
  ): Promise<DispatchActorState> {
    const actor = await this.dispatchActor(dispatchId);
    const state = actor.state as DispatchActorState;
    if (dispatchTransitionAlreadyApplied(state, eventType, payload)) return state;
    return actor.commit(eventType, payload, eventId) as Promise<DispatchActorState>;
  }

  async dispatchState(dispatchId: string): Promise<DispatchActorState> {
    const actor = await this.dispatchActor(dispatchId);
    return actor.state as DispatchActorState;
  }

  async releaseDispatch(dispatchId: string): Promise<void> {
    const key = `dispatch:${dispatchId}`;
    const actor = this.actors.get(key);
    if (!actor) {
      await this.retirements.get(key);
      return;
    }
    this.actors.delete(key);
    await this.retire(key, actor);
  }

  async status(kind: "schedule" | "dispatch", id: string): Promise<FlowScheduleActorStatus | undefined> {
    const key = `${kind}:${id}`;
    const actor = this.actors.get(key);
    if (!actor) return undefined;
    if (actor.active) return actor.status(id);
    this.actors.delete(key);
    await this.retire(key, actor).catch(() => undefined);
    return undefined;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = this.drainAndStop();
    return this.stopPromise;
  }

  private async drainAndStop(): Promise<void> {
    await Promise.allSettled([...this.acquisitions.values()]);
    const actors = [...this.actors.entries()];
    this.actors.clear();
    await Promise.allSettled(actors.map(([key, actor]) => this.retire(key, actor)));
    await Promise.allSettled([...this.retirements.values()]);
    await this.host.stop();
  }

  private scheduleActor(scheduleId: string, allowAcquire = true): Promise<DurableFlowActor> {
    return this.actor("schedule", scheduleId, allowAcquire);
  }

  private async discoverIds(kind: "schedule" | "dispatch"): Promise<string[]> {
    if (!this.host.listStreams) return [];
    const prefix = `flow-schedule/${kind}/`;
    const ids = new Set<string>();
    for (const workspaceId of [this.workspaceId, ...this.legacyWorkspaceIds]) {
      let afterStreamId = "";
      for (;;) {
        const page = await this.host.listStreams({
          workspaceId,
          prefix,
          afterStreamId,
          limit: 128,
        });
        for (const streamId of page) {
          if (!streamId.startsWith(prefix) || streamId <= afterStreamId) {
            throw new Error("Runtime actor host returned an invalid stream page");
          }
          const id = streamId.slice(prefix.length);
          const valid = kind === "schedule"
            ? FLOW_SCHEDULE_ID_PATTERN.test(id)
            : FLOW_SCHEDULE_DISPATCH_ID_PATTERN.test(id);
          if (!valid) throw new Error(`Invalid discovered Flow ${kind} stream: ${streamId}`);
          ids.add(id);
        }
        if (page.length < 128) break;
        afterStreamId = page.at(-1)!;
      }
    }
    return [...ids].sort();
  }

  private dispatchActor(dispatchId: string): Promise<DurableFlowActor> {
    return this.actor("dispatch", dispatchId);
  }

  private async actor(
    kind: "schedule" | "dispatch",
    id: string,
    allowAcquire = true,
  ): Promise<DurableFlowActor> {
    if (this.stopped) throw new Error("Flow schedule actor runtime is stopped");
    if (!this.enabled) throw new Error("PI_FLOW_SCHEDULE_V2 requires PI_RUNTIME_BROKER=file|sqlite");
    const key = `${kind}:${id}`;
    const existing = this.actors.get(key);
    if (existing?.active) return existing;
    if (existing) {
      this.actors.delete(key);
      await this.retire(key, existing).catch(() => undefined);
    } else {
      await this.retirements.get(key)?.catch(() => undefined);
    }
    const streamId = kind === "schedule" ? scheduleStreamId(id) : dispatchStreamId(id);
    if (!allowAcquire) throw new FlowScheduleLeaseUnavailableError(streamId);
    const pending = this.acquisitions.get(key);
    if (pending) return pending;
    const acquisition = this.acquireActor(key, kind, id, streamId);
    this.acquisitions.set(key, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.acquisitions.get(key) === acquisition) this.acquisitions.delete(key);
    }
  }

  private async acquireActor(
    key: string,
    kind: "schedule" | "dispatch",
    id: string,
    streamId: string,
  ): Promise<DurableFlowActor> {
    const actorAddress: ActorAddressV2 = {
      version: RUNTIME_V2_VERSION,
      revision: RUNTIME_V2_REVISION,
      workspaceId: this.workspaceId,
      actorKind: kind,
      actorId: streamId,
      generation: 1,
    };
    const lease = await this.host.acquire({
      leaseActorId: streamId,
      holderId: this.holderId,
      streamId,
      actor: actorAddress,
      workspaceAliases: this.legacyWorkspaceIds,
      correlationId: id,
    });
    if (!lease) throw new FlowScheduleLeaseUnavailableError(streamId);
    try {
      if (this.stopped) throw new Error("Flow schedule actor runtime stopped during lease acquisition");
      const runtimeEvents = await lease.replay();
      if (this.stopped) throw new Error("Flow schedule actor runtime stopped during replay");
      const events = flowEventsFromRuntime(runtimeEvents);
      const state = kind === "schedule" ? replaySchedule(id, events) : replayDispatch(id, events);
      const streamWorkspaceId = runtimeEvents[0]?.actor.workspaceId ?? this.workspaceId;
      const actor = new DurableFlowActor(kind, state, lease, this.now, streamWorkspaceId);
      if (this.stopped) throw new Error("Flow schedule actor runtime stopped during construction");
      this.actors.set(key, actor);
      return actor;
    } catch (error) {
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  private retire(key: string, actor: DurableFlowActor): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const retirement = actor.release().finally(() => {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    });
    this.retirements.set(key, retirement);
    return retirement;
  }
}

class DurableFlowActor {
  readonly kind: "schedule" | "dispatch";
  private current: ActorState;
  private readonly lease: RuntimeActorLease;
  private readonly now: () => number;
  private readonly streamWorkspaceId: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    kind: "schedule" | "dispatch",
    state: ActorState,
    lease: RuntimeActorLease,
    now: () => number,
    streamWorkspaceId: string,
  ) {
    this.kind = kind;
    this.current = state;
    this.lease = lease;
    this.now = now;
    this.streamWorkspaceId = streamWorkspaceId;
  }

  get active(): boolean {
    return this.lease.active;
  }

  get state(): ActorState {
    return structuredClone(this.current);
  }

  commit(eventType: FlowScheduleActorEventType, payload: unknown, suppliedEventId?: string): Promise<ActorState> {
    let result!: Promise<ActorState>;
    const run = this.tail.catch(() => undefined).then(async () => {
      if (!this.lease.active) throw new Error("Flow actor lease is stale");
      const revision = this.current.revision + 1;
      const occurredAt = this.now();
      const eventId = suppliedEventId ?? deterministicEventId(this.current.streamId, revision, eventType, payload);
      const credential = this.lease.credential;
      const brokerRevision = this.current.brokerRevision + 1;
      const event: FlowScheduleActorEvent = {
        version: FLOW_SCHEDULE_ACTOR_VERSION,
        eventId,
        streamId: this.current.streamId,
        revision,
        brokerRevision,
        producerEpoch: credential.epoch,
        eventType,
        occurredAt,
        payload,
      };
      const prevalidated = this.kind === "schedule"
        ? reduceSchedule(this.current as ScheduleActorState, event)
        : reduceDispatch(this.current as DispatchActorState, event);
      const draft: RuntimeEventDraftV2 = {
        version: RUNTIME_V2_VERSION,
        revision: RUNTIME_V2_REVISION,
        streamId: event.streamId,
        actor: { ...this.lease.registration.actor, workspaceId: this.streamWorkspaceId },
        occurredAt: event.occurredAt,
        kind: "domain.event",
        eventType: event.eventType,
        eventId: event.eventId,
        payload: event.payload,
      } satisfies Omit<RuntimeDomainEventV2, "sequence">;
      const committed = await this.lease.append([draft]);
      const persisted = committed[0];
      if (committed.length !== 1
        || !persisted
        || persisted.kind !== "domain.event"
        || persisted.streamId !== draft.streamId
        || persisted.eventId !== eventId
        || persisted.actor.workspaceId !== this.streamWorkspaceId
        || persisted.actor.actorId !== draft.actor.actorId
        || persisted.actor.actorKind !== draft.actor.actorKind
        || persisted.actor.generation !== draft.actor.generation
        || persisted.producerEpoch !== credential.epoch
        || persisted.sequence !== brokerRevision) {
        throw new Error("Runtime Broker returned an invalid or stale Flow actor commit receipt");
      }
      this.current = prevalidated;
      return structuredClone(prevalidated);
    });
    result = run;
    this.tail = run.then(() => undefined, () => undefined);
    return result;
  }

  status(id: string): FlowScheduleActorStatus {
    return {
      ...stateStatus(this.current, id),
      leaseEpoch: this.lease.credential.epoch,
      leaseNonce: this.lease.credential.nonce,
    };
  }

  async release(): Promise<void> {
    await this.tail.catch(() => undefined);
    await this.lease.release();
  }
}

function flowEventsFromRuntime(events: readonly RuntimeEventV2[]): FlowScheduleActorEvent[] {
  const flowEvents: FlowScheduleActorEvent[] = [];
  for (const event of events) {
    if (event.kind !== "domain.event") continue;
    flowEvents.push({
      version: FLOW_SCHEDULE_ACTOR_VERSION,
      eventId: event.eventId,
      streamId: event.streamId,
      revision: flowEvents.length + 1,
      brokerRevision: event.sequence,
      producerEpoch: runtimeProducerEpoch(event),
      eventType: event.eventType as FlowScheduleActorEventType,
      occurredAt: event.occurredAt,
      payload: event.payload,
    });
  }
  return flowEvents;
}

function runtimeProducerEpoch(event: RuntimeEventV2): number {
  if ("producerEpoch" in event) {
    const producerEpoch = event.producerEpoch;
    if (typeof producerEpoch === "number") return producerEpoch;
    return Number.NaN;
  }
  return event.actor.generation;
}

function sameProjection(
  left: FlowScheduleRecord | undefined,
  right: FlowScheduleRecord,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function dispatchTransitionAlreadyApplied(
  state: DispatchActorState,
  eventType: Exclude<FlowScheduleActorEventType, `schedule.${string}`>,
  payload: Record<string, unknown>,
): boolean {
  switch (eventType) {
    case "dispatch.prepared":
      return state.transport !== "none";
    case "dispatch.published":
      return state.transport === "published" || state.transport === "accepted";
    case "dispatch.accepted":
      return state.transport === "accepted";
    case "dispatch.rejected":
      return state.transport === "rejected";
    case "dispatch.retired":
      return state.business === "retired";
    case "dispatch.binding_recorded":
      return JSON.stringify(state.binding) === JSON.stringify(payload.binding);
    case "todo.capabilities_recorded":
      return state.capabilities?.rootProjection === (payload.rootProjection === true)
        && state.capabilities.backendMutation === (payload.backendMutation === true)
        && state.capabilities.report === (payload.report === true);
    case "outbox.prepared":
      return state.outbox !== "none";
    case "outbox.published":
      return state.outbox === "published" || state.outbox === "accepted";
    case "outbox.accepted":
      return state.outbox === "accepted";
    case "work.generic_terminal_observed":
      return state.genericTerminalAt !== undefined;
    case "work.reported.completed":
      return state.business === "completed";
    case "work.reported.failed":
      return state.business === "failed";
    case "work.unreported_terminal":
      return state.business === "ambiguous";
  }
}

function deterministicEventId(streamId: string, revision: number, eventType: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${streamId}\0${revision}\0${eventType}\0${JSON.stringify(payload)}`)
    .digest("hex");
}

function stateStatus(state: ActorState, id: string): FlowScheduleActorStatus {
  return {
    kind: state.kind,
    id,
    streamId: state.streamId,
    revision: state.revision,
    brokerRevision: state.brokerRevision,
    ...(state.kind === "schedule" ? {
      migration: state.migration,
      projectionState: state.projectionState,
    } : {
      exactReportedAt: state.exactReportedAt,
      genericTerminalAt: state.genericTerminalAt,
      genericGraceDeadline: state.genericGraceDeadline,
      outboxState: state.outbox,
      outboxMessageId: state.outboxMessageId,
    }),
  };
}

import { randomUUID } from "node:crypto";
import {
  getSessionHostRegistry,
  type SessionEndpoint,
  type SessionHostRegistry,
  type SessionHostSnapshot,
  type SessionMessageResult,
  type WindowThreadEntry,
} from "pi-maestro-teammate/v1/sessions";
import {
  observeTargets,
  type ObserveParams,
  type ObserveResult,
} from "pi-maestro-teammate/v1/observation";
import { SchedulerCore, type SchedulerCoreOptions } from "pi-maestro-teammate/v1/scheduler";
import {
  cancelFlowSchedule,
  pauseFlowSchedule,
  resumeFlowSchedule,
  selectNextFlowScheduleStep,
  startFlowSchedule,
} from "./machine.ts";
import {
  createFlowScheduleDispatchEnvelope,
  createFlowScheduleResult,
  decodeFlowScheduleDispatch,
  decodeFlowScheduleResult,
  encodeFlowScheduleDispatch,
  encodeFlowScheduleResult,
  flowScheduleResultMessageId,
} from "./protocol.ts";
import {
  createFlowScheduleDispatchId,
  FlowScheduleConflictError,
  type FlowScheduleDispatchBundle,
} from "./store.ts";
import {
  FLOW_SCHEDULE_VERSION,
  isTerminalScheduleState,
  type ExactWindowIdentity,
  type FlowScheduleAcceptedRecord,
  type FlowScheduleCompletionRecord,
  type FlowSchedulePublishedRecord,
  type FlowScheduleRecord,
  type FlowScheduleResultOutcome,
} from "./types.ts";

const MIN_RECONCILE_INTERVAL_MS = 250;
const MAX_RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_TASK_ID = "flow-schedule-reconcile-v1";

type RegistryProvider = () => SessionHostRegistry | undefined;
type Observer = (params: ObserveParams, signal?: AbortSignal) => Promise<ObserveResult>;

export interface FlowScheduleRuntimeStore {
  readSchedule(scheduleId: string): Promise<FlowScheduleRecord | undefined>;
  listSchedules(): Promise<FlowScheduleRecord[]>;
  updateSchedule(
    scheduleId: string,
    update: (current: FlowScheduleRecord) => FlowScheduleRecord | Promise<FlowScheduleRecord>,
  ): Promise<FlowScheduleRecord>;
  prepareRetry(scheduleId: string, stepId: string, reason: string): Promise<FlowScheduleRecord>;
  createDispatchIntent(
    input: {
      dispatchId: string;
      scheduleId: string;
      stepId: string;
      targetIdentity: ExactWindowIdentity;
    },
    authorize?: () => boolean,
  ): Promise<{ created: boolean; dispatch: FlowScheduleDispatchBundle["intent"]; schedule: FlowScheduleRecord }>;
  readDispatch(dispatchId: string): Promise<FlowScheduleDispatchBundle | undefined>;
  recordPublished(record: FlowSchedulePublishedRecord): Promise<FlowSchedulePublishedRecord>;
  recordAccepted(record: FlowScheduleAcceptedRecord): Promise<FlowScheduleAcceptedRecord>;
  recordCompletion(record: FlowScheduleCompletionRecord): Promise<FlowScheduleCompletionRecord>;
}

export type FlowScheduleRuntimeEventType =
  | "reconcile-start"
  | "reconcile-finish"
  | "dispatch-published"
  | "dispatch-accepted"
  | "dispatch-completed"
  | "dispatch-ambiguous"
  | "diagnostic";

export interface FlowScheduleRuntimeEvent {
  type: FlowScheduleRuntimeEventType;
  scheduleId?: string;
  dispatchId?: string;
  detail?: string;
}

export interface FlowScheduleRuntimeOptions {
  store: FlowScheduleRuntimeStore;
  getRegistry?: RegistryProvider;
  observe?: Observer;
  now?: () => number;
  createDispatchId?: () => string;
  reconcileIntervalMs?: number;
  schedulerOptions?: SchedulerCoreOptions;
}

interface EndpointCapture {
  registry: SessionHostRegistry;
  snapshot: SessionHostSnapshot;
  selector: string;
  endpoint: SessionEndpoint;
  localRoot: SessionEndpoint;
}

function exactIdentity(endpoint: SessionEndpoint): ExactWindowIdentity {
  return {
    workspaceId: endpoint.workspaceId,
    endpointId: endpoint.id,
    ownerId: endpoint.ownerId,
    ownerNonce: endpoint.ownerNonce,
    ...(endpoint.sessionId === undefined ? {} : { sessionId: endpoint.sessionId }),
  };
}

function sameIdentity(endpoint: SessionEndpoint, identity: ExactWindowIdentity): boolean {
  return endpoint.id === identity.endpointId
    && endpoint.workspaceId === identity.workspaceId
    && endpoint.ownerId === identity.ownerId
    && endpoint.ownerNonce === identity.ownerNonce
    && endpoint.sessionId === identity.sessionId;
}

function peerRoot(endpoint: SessionEndpoint): boolean {
  return endpoint.kind === "root"
    && endpoint.scope === "workspace-peer"
    && endpoint.transport === "workspace-peer-v1"
    && endpoint.status !== "settled"
    && endpoint.capabilities.includes("message")
    && endpoint.capabilities.includes("follow_up");
}

function localRoot(snapshot: SessionHostSnapshot): SessionEndpoint | undefined {
  const roots = snapshot.endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.scope === "local");
  return roots.length === 1 ? roots[0] : undefined;
}

function captureTarget(
  getRegistry: RegistryProvider,
  selector: string,
  expected?: ExactWindowIdentity,
): EndpointCapture | undefined {
  const registry = getRegistry();
  if (!registry) return undefined;
  const snapshot = registry.snapshot();
  const resolution = registry.resolve(selector, { includeSettled: true, localFirst: false });
  const endpoint = resolution.code === "resolved" ? resolution.endpoint : undefined;
  const ownRoot = localRoot(snapshot);
  if (!endpoint || !ownRoot || !peerRoot(endpoint) || (expected && !sameIdentity(endpoint, expected))) return undefined;
  return { registry, snapshot, selector, endpoint, localRoot: ownRoot };
}

function captureStillValid(getRegistry: RegistryProvider, capture: EndpointCapture): boolean {
  const registry = getRegistry();
  if (registry !== capture.registry) return false;
  const snapshot = registry.snapshot();
  if (snapshot.endpointContentRevision !== capture.snapshot.endpointContentRevision) return false;
  const resolution = registry.resolve(capture.selector, { includeSettled: true, localFirst: false });
  const endpoint = resolution.code === "resolved" ? resolution.endpoint : undefined;
  const ownRoot = localRoot(snapshot);
  return endpoint !== undefined
    && ownRoot !== undefined
    && peerRoot(endpoint)
    && sameIdentity(endpoint, exactIdentity(capture.endpoint))
    && sameIdentity(ownRoot, exactIdentity(capture.localRoot));
}

function handshakeStillValid(getRegistry: RegistryProvider, capture: EndpointCapture): boolean {
  return captureStillValid(getRegistry, capture);
}

function consumed(entry: WindowThreadEntry | undefined): boolean {
  return entry?.status === "injected" || entry?.status === "accepted";
}

function published(entry: WindowThreadEntry | undefined): boolean {
  return entry !== undefined && ["queued", "injected", "accepted", "rejected", "timeout"].includes(entry.status);
}

function exactOutgoing(
  entry: WindowThreadEntry | undefined,
  identity: ExactWindowIdentity,
  dispatchId: string,
  body: string,
): entry is WindowThreadEntry {
  return entry?.direction === "outgoing"
    && entry.messageId === dispatchId
    && entry.traceId === dispatchId
    && entry.workspaceId === identity.workspaceId
    && entry.peerOwnerId === identity.ownerId
    && entry.peerOwnerNonce === identity.ownerNonce
    && entry.mode === "follow_up"
    && entry.body === body;
}

function exactIncomingResult(
  entry: WindowThreadEntry | undefined,
  identity: ExactWindowIdentity,
  dispatchId: string,
): entry is WindowThreadEntry {
  const messageId = flowScheduleResultMessageId(dispatchId);
  return consumed(entry)
    && entry?.direction === "incoming"
    && entry.messageId === messageId
    && entry.traceId === dispatchId
    && entry.workspaceId === identity.workspaceId
    && entry.peerOwnerId === identity.ownerId
    && entry.peerOwnerNonce === identity.ownerNonce
    && entry.messageKind === "status";
}

function observationIsLive(result: ObserveResult): boolean {
  const observation = result.observations[0];
  return observation?.found === true
    && observation.phase !== "settled"
    && observation.terminalStatus === undefined
    && observation.capabilities?.message === true;
}

export class FlowScheduleRuntime {
  private readonly store: FlowScheduleRuntimeStore;
  private readonly getRegistry: RegistryProvider;
  private readonly observe: Observer;
  private readonly now: () => number;
  private readonly createDispatchId: () => string;
  private readonly scheduler: SchedulerCore;
  private readonly controller = new AbortController();
  private readonly intervalMs: number;
  private readonly listeners = new Set<(event: FlowScheduleRuntimeEvent) => void>();
  private registryUnsubscribe?: () => void;
  private reconcilePromise?: Promise<void>;
  private reconcileRequested = false;
  private started = false;
  private disposed = false;

  constructor(options: FlowScheduleRuntimeOptions) {
    this.store = options.store;
    this.getRegistry = options.getRegistry ?? (() => getSessionHostRegistry());
    this.observe = options.observe ?? observeTargets;
    this.now = options.now ?? Date.now;
    this.createDispatchId = options.createDispatchId ?? (() => createFlowScheduleDispatchId(randomUUID));
    this.intervalMs = options.reconcileIntervalMs ?? 2_000;
    if (!Number.isInteger(this.intervalMs)
      || this.intervalMs < MIN_RECONCILE_INTERVAL_MS
      || this.intervalMs > MAX_RECONCILE_INTERVAL_MS) {
      throw new Error(`Flow schedule reconcileIntervalMs must be between ${MIN_RECONCILE_INTERVAL_MS} and ${MAX_RECONCILE_INTERVAL_MS}`);
    }
    this.scheduler = new SchedulerCore({
      ...options.schedulerOptions,
      onError: (error, id) => {
        options.schedulerOptions?.onError?.(error, id);
        this.emit({ type: "diagnostic", detail: error instanceof Error ? error.message : String(error) });
      },
    });
  }

  subscribe(listener: (event: FlowScheduleRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.disposed) throw new Error("Flow schedule runtime is disposed");
    if (!this.started) {
      this.started = true;
      this.registryUnsubscribe = this.getRegistry()?.subscribe(() => { this.requestReconcile(); }, { emitCurrent: false });
      this.scheduler.schedule({
        id: RECONCILE_TASK_ID,
        intervalMs: this.intervalMs,
        run: ({ signal }) => signal.aborted ? undefined : this.reconcileReady(),
      });
    }
    return this.reconcileReady();
  }

  async startSchedule(scheduleId: string): Promise<FlowScheduleRecord> {
    const updated = await this.store.updateSchedule(scheduleId, startFlowSchedule);
    await this.reconcileReady();
    return updated;
  }

  pauseSchedule(scheduleId: string): Promise<FlowScheduleRecord> {
    return this.store.updateSchedule(scheduleId, pauseFlowSchedule);
  }

  async resumeSchedule(scheduleId: string, target?: string): Promise<FlowScheduleRecord> {
    const updated = await this.store.updateSchedule(scheduleId, (schedule) => resumeFlowSchedule(schedule, target));
    await this.reconcileReady();
    return updated;
  }

  async cancelSchedule(scheduleId: string, reason: string): Promise<FlowScheduleRecord> {
    const current = await this.store.readSchedule(scheduleId);
    if (!current) throw new Error(`Unknown Flow schedule: ${scheduleId}`);
    if (current.activeStepId !== undefined) {
      const step = current.steps[current.activeStepId];
      const dispatchId = step.currentDispatchId;
      const bundle = dispatchId ? await this.store.readDispatch(dispatchId) : undefined;
      if (bundle && !bundle.completion) {
        try {
          await this.store.recordCompletion({
            version: FLOW_SCHEDULE_VERSION,
            type: "flow-schedule-completion",
            dispatchId: bundle.intent.dispatchId,
            scheduleId: bundle.intent.scheduleId,
            stepId: bundle.intent.stepId,
            targetIdentity: bundle.intent.targetIdentity,
            state: "retired",
            reason: `Schedule cancelled: ${reason}`,
            completedAt: this.now(),
          });
        } catch (error) {
          if (!(error instanceof FlowScheduleConflictError)) throw error;
        }
      }
    }
    return this.store.updateSchedule(scheduleId, (schedule) => cancelFlowSchedule(schedule, reason));
  }

  async retrySchedule(scheduleId: string, stepId: string, reason: string): Promise<FlowScheduleRecord> {
    const updated = await this.store.prepareRetry(scheduleId, stepId, reason);
    await this.reconcileReady();
    return updated;
  }

  private requestReconcile(): void {
    void this.reconcileReady().catch((error) => {
      this.emit({ type: "diagnostic", detail: error instanceof Error ? error.message : String(error) });
    });
  }

  reconcileReady(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.reconcileRequested = true;
    if (!this.reconcilePromise) {
      this.reconcilePromise = (async () => {
        while (this.reconcileRequested && !this.disposed) {
          this.reconcileRequested = false;
          this.emit({ type: "reconcile-start" });
          try {
            await this.reconcile();
          } finally {
            this.emit({ type: "reconcile-finish" });
          }
        }
      })().finally(() => { this.reconcilePromise = undefined; });
    }
    return this.reconcilePromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.registryUnsubscribe?.();
    this.registryUnsubscribe = undefined;
    this.scheduler.shutdown();
    this.listeners.clear();
  }

  private emit(event: FlowScheduleRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async reconcile(): Promise<void> {
    const schedules = await this.store.listSchedules();
    for (const schedule of schedules) {
      if (this.disposed) return;
      if (schedule.activeStepId !== undefined) {
        await this.reconcileAttempt(schedule);
      } else if (!isTerminalScheduleState(schedule.state) && schedule.state === "active") {
        await this.admitNext(schedule);
      }
    }
  }

  private async admitNext(schedule: FlowScheduleRecord): Promise<void> {
    const stepId = selectNextFlowScheduleStep(schedule);
    if (!stepId) return;
    const capture = captureTarget(this.getRegistry, schedule.targetSelector);
    if (!capture) return;
    const observation = await this.observe({
      action: "status",
      targets: [{ kind: "workspace", id: schedule.targetSelector }],
      detail: "summary",
      lines: 1,
    }, this.controller.signal);
    if (this.disposed || !observationIsLive(observation) || !handshakeStillValid(this.getRegistry, capture)) return;

    const dispatchId = this.createDispatchId();
    const intent = await this.store.createDispatchIntent({
      dispatchId,
      scheduleId: schedule.scheduleId,
      stepId,
      targetIdentity: exactIdentity(capture.endpoint),
    }, () => !this.disposed && handshakeStillValid(this.getRegistry, capture));
    if (this.disposed) return;
    await this.publishAttempt(intent.schedule, { intent: intent.dispatch });
  }

  private async reconcileAttempt(schedule: FlowScheduleRecord): Promise<void> {
    const step = schedule.steps[schedule.activeStepId!];
    const dispatchId = step.currentDispatchId;
    if (!dispatchId) return;
    const bundle = await this.store.readDispatch(dispatchId);
    if (!bundle) return;
    if (bundle.completion) {
      if (bundle.completion.state !== "ignored") await this.store.recordCompletion(bundle.completion);
      return;
    }
    if (await this.acceptResult(schedule, bundle)) return;

    const capture = captureTarget(this.getRegistry, schedule.targetSelector, bundle.intent.targetIdentity);
    if (!capture) {
      if (await this.acceptResult(schedule, bundle)) return;
      await this.completeAmbiguous(bundle, "Target endpoint was replaced or became terminal without a report");
      return;
    }
    const observation = await this.observe({
      action: "status",
      targets: [{ kind: "workspace", id: schedule.targetSelector }],
      detail: "summary",
      lines: 1,
    }, this.controller.signal);
    if (this.disposed) return;
    if (await this.acceptResult(schedule, bundle)) return;
    if (!observationIsLive(observation) || !captureStillValid(this.getRegistry, capture)) {
      await this.completeAmbiguous(bundle, "Target endpoint was replaced or became terminal without a report");
      return;
    }
    await this.publishAttempt(schedule, bundle);
  }

  private async acceptResult(schedule: FlowScheduleRecord, bundle: FlowScheduleDispatchBundle): Promise<boolean> {
    if (this.disposed) return false;
    const registry = this.getRegistry();
    if (!registry) return false;
    const entry = registry.thread.get(flowScheduleResultMessageId(bundle.intent.dispatchId), "incoming");
    const ownRoot = localRoot(registry.snapshot());
    if (!ownRoot || entry?.targetSessionId !== ownRoot.sessionId) return false;
    if (!exactIncomingResult(entry, bundle.intent.targetIdentity, bundle.intent.dispatchId)) return false;
    let result;
    try {
      result = decodeFlowScheduleResult(entry.body);
    } catch {
      return false;
    }
    if (result.dispatchId !== bundle.intent.dispatchId
      || result.scheduleId !== bundle.intent.scheduleId
      || result.stepId !== bundle.intent.stepId
      || schedule.activeStepId !== bundle.intent.stepId
      || schedule.steps[bundle.intent.stepId]?.currentDispatchId !== bundle.intent.dispatchId
      || this.disposed) return false;
    await this.store.recordCompletion({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      targetIdentity: bundle.intent.targetIdentity,
      state: result.outcome,
      result,
      completedAt: this.now(),
    });
    this.emit({ type: "dispatch-completed", scheduleId: result.scheduleId, dispatchId: result.dispatchId });
    return true;
  }

  private async publishAttempt(schedule: FlowScheduleRecord, initial: FlowScheduleDispatchBundle): Promise<void> {
    let bundle = await this.store.readDispatch(initial.intent.dispatchId) ?? initial;
    if (this.disposed || bundle.completion) return;
    const step = schedule.steps[bundle.intent.stepId];
    if (!step) return;
    const body = encodeFlowScheduleDispatch(createFlowScheduleDispatchEnvelope({
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      dispatchId: bundle.intent.dispatchId,
      instruction: step.prompt,
    }));
    let capture = captureTarget(this.getRegistry, schedule.targetSelector, bundle.intent.targetIdentity);
    if (!capture) return;
    let outgoing = capture.registry.thread.get(bundle.intent.dispatchId, "outgoing");
    if (outgoing && !exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body)) {
      await this.completeAmbiguous(bundle, "Dispatch message ID is bound to a different durable thread entry");
      return;
    }
    if (published(outgoing) && !bundle.published) {
      await this.recordPublished(bundle);
      bundle = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    }
    if (consumed(outgoing) && !bundle.accepted) {
      await this.recordAccepted(bundle, outgoing!.status === "injected" ? "injected" : "accepted");
      return;
    }
    if (outgoing?.status === "queued") return;
    if (outgoing?.status === "rejected") {
      await this.completeAmbiguous(bundle, "Target rejected the dispatch without a report");
      return;
    }

    capture = captureTarget(this.getRegistry, schedule.targetSelector, bundle.intent.targetIdentity);
    if (!capture) return;
    const fence = capture;
    let delivery: SessionMessageResult | undefined;
    try {
      delivery = await capture.registry.send({
        selector: capture.endpoint.id,
        message: body,
        mode: "follow_up",
        messageId: bundle.intent.dispatchId,
        traceId: bundle.intent.dispatchId,
        source: "system",
        messageKind: "request",
        replyTo: `owner:${capture.localRoot.ownerId}`,
        authorize: () => !this.disposed && captureStillValid(this.getRegistry, fence),
        signal: this.controller.signal,
      });
    } catch (error) {
      this.emit({ type: "diagnostic", scheduleId: schedule.scheduleId, dispatchId: bundle.intent.dispatchId, detail: error instanceof Error ? error.message : String(error) });
    }

    if (this.disposed) return;
    const registry = this.getRegistry();
    outgoing = registry?.thread.get(bundle.intent.dispatchId, "outgoing");
    const hasPublishedReceipt = delivery?.receipt?.publicationStage === "published"
      || delivery?.receipt?.publicationStage === "accepted"
      || (exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body) && published(outgoing));
    if (hasPublishedReceipt && !bundle.published) {
      await this.recordPublished(bundle);
      bundle = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    }
    const accepted = delivery?.receipt?.deliveryStage === "injected"
      || (exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body) && consumed(outgoing));
    if (accepted && !bundle.accepted) {
      const state = outgoing?.status === "accepted" ? "accepted" : "injected";
      await this.recordAccepted(bundle, state);
    }
  }

  private async recordPublished(bundle: FlowScheduleDispatchBundle): Promise<void> {
    await this.store.recordPublished({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-published",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      messageId: bundle.intent.dispatchId,
      traceId: bundle.intent.dispatchId,
      publishedAt: this.now(),
    });
    this.emit({ type: "dispatch-published", scheduleId: bundle.intent.scheduleId, dispatchId: bundle.intent.dispatchId });
  }

  private async recordAccepted(
    bundle: FlowScheduleDispatchBundle,
    deliveryState: FlowScheduleAcceptedRecord["deliveryState"],
  ): Promise<void> {
    await this.store.recordAccepted({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-accepted",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      messageId: bundle.intent.dispatchId,
      acceptedAt: this.now(),
      deliveryState,
    });
    this.emit({ type: "dispatch-accepted", scheduleId: bundle.intent.scheduleId, dispatchId: bundle.intent.dispatchId });
  }

  private async completeAmbiguous(bundle: FlowScheduleDispatchBundle, reason: string): Promise<void> {
    const current = await this.store.readDispatch(bundle.intent.dispatchId);
    if (this.disposed || !current || current.completion) return;
    await this.store.recordCompletion({
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      targetIdentity: bundle.intent.targetIdentity,
      state: "ambiguous",
      reason,
      completedAt: this.now(),
    });
    this.emit({ type: "dispatch-ambiguous", scheduleId: bundle.intent.scheduleId, dispatchId: bundle.intent.dispatchId, detail: reason });
  }
}

export interface PublishFlowScheduleReportOptions {
  registry?: SessionHostRegistry;
  getRegistry?: RegistryProvider;
  inbound: WindowThreadEntry;
  outcome: FlowScheduleResultOutcome;
  summary: string;
  resources?: string[];
}

export async function publishFlowScheduleReport(options: PublishFlowScheduleReportOptions): Promise<{
  resultMessageId: string;
  delivery: SessionMessageResult;
}> {
  const getRegistry = options.getRegistry ?? (() => options.registry ?? getSessionHostRegistry());
  const registry = getRegistry();
  if (!registry || (options.registry && registry !== options.registry)) throw new Error("Session host registry is unavailable");
  const inbound = registry.thread.get(options.inbound.messageId, "incoming");
  if (inbound !== options.inbound && inbound?.contentRevision !== options.inbound.contentRevision) {
    throw new Error("Flow schedule dispatch is not the current durable inbound thread entry");
  }
  const ownRoot = localRoot(registry.snapshot());
  if (!ownRoot
    || inbound?.targetSessionId !== ownRoot.sessionId
    || !consumed(inbound)
    || inbound.direction !== "incoming"
    || inbound.messageKind !== "request"
    || inbound.traceId !== inbound.messageId
    || inbound.replyTo !== `owner:${inbound.peerOwnerId}`) {
    throw new Error("Flow schedule report requires a trusted inbound dispatch thread entry");
  }
  const envelope = decodeFlowScheduleDispatch(inbound.body);
  if (envelope.dispatchId !== inbound.messageId) throw new Error("Flow schedule dispatch trace and envelope do not match");
  const capture = captureTarget(getRegistry, inbound.replyTo);
  if (!capture
    || capture.registry !== registry
    || capture.endpoint.ownerId !== inbound.peerOwnerId
    || capture.endpoint.ownerNonce !== inbound.peerOwnerNonce
    || capture.endpoint.workspaceId !== inbound.workspaceId) {
    throw new Error("Flow schedule reply endpoint no longer matches the trusted dispatch sender");
  }
  const result = createFlowScheduleResult({
    scheduleId: envelope.scheduleId,
    stepId: envelope.stepId,
    dispatchId: envelope.dispatchId,
    outcome: options.outcome,
    summary: options.summary,
    resources: options.resources,
  });
  const resultMessageId = flowScheduleResultMessageId(envelope.dispatchId);
  const delivery = await registry.send({
    selector: capture.endpoint.id,
    message: encodeFlowScheduleResult(result),
    mode: "follow_up",
    messageId: resultMessageId,
    traceId: envelope.dispatchId,
    source: "system",
    messageKind: "status",
    trustedStatus: true,
    authorize: () => captureStillValid(getRegistry, capture),
  });
  if (!delivery.delivered && delivery.receipt?.publicationStage !== "published") {
    throw new Error(delivery.error ?? "Flow schedule result publication failed");
  }
  return { resultMessageId, delivery };
}

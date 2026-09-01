import { randomUUID } from "node:crypto";
import {
  bindWorkspaceCompletionHandle,
  decodeWorkspaceWindowTerminalResult,
  validateWorkspaceCompletionCorrelation,
  WORKSPACE_MAIN_SESSION_MARKER,
  workspaceWindowTerminalResultMessageId,
  type WorkspaceCompletionCorrelation,
} from "pi-maestro-teammate/v1/workspace-completion";
import {
  getSessionHostDirectoryRefresh,
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
  FlowScheduleLeaseUnavailableError,
} from "./actor.ts";
import {
  FlowScheduleBrokerRuntime,
  type FlowScheduleReportOutboxRecord,
} from "./broker-runtime.ts";
import {
  todoCapabilitiesNegotiated,
  type DispatchActorState,
} from "./reducer.ts";
import {
  cancelFlowSchedule,
  failFlowSchedule,
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
  flowScheduleDispatchMessageId,
  flowScheduleReportReminderMessageId,
  flowScheduleResultMessageId,
  flowScheduleResultTransportMessageId,
} from "./protocol.ts";
import {
  createFlowScheduleDispatchId,
  FlowScheduleConflictError,
  type FlowScheduleDispatchBundle,
} from "./store.ts";
import {
  FLOW_SCHEDULE_VERSION,
  isTerminalBindingState,
  isTerminalScheduleState,
  type ExactWindowIdentity,
  type FlowScheduleAcceptedRecord,
  type FlowScheduleCompletionRecord,
  type FlowSchedulePublishedRecord,
  type FlowScheduleRecord,
  type FlowScheduleResultOutcome,
  type FlowScheduleTodoBinding,
  type FlowScheduleTodoBindingSpec,
  type FlowScheduleTodoOutcome,
} from "./types.ts";

const MIN_RECONCILE_INTERVAL_MS = 250;
const MAX_RECONCILE_INTERVAL_MS = 60_000;
const MIN_TODO_GATE_TIMEOUT_MS = 1;
const MAX_TODO_GATE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_TODO_GATE_TIMEOUT_MS = 30_000;
const DEFAULT_GENERIC_TERMINAL_GRACE_MS = 5_000;
const MIN_GENERIC_TERMINAL_GRACE_MS = 1;
const MAX_GENERIC_TERMINAL_GRACE_MS = 5 * 60_000;
const RECONCILE_TASK_ID = "flow-schedule-reconcile-v1";

type RegistryProvider = () => SessionHostRegistry | undefined;
type Observer = (params: ObserveParams, signal?: AbortSignal) => Promise<ObserveResult>;

const DEFAULT_ADMIT_FAILURE_THRESHOLD = 5;
const MIN_ADMIT_FAILURE_THRESHOLD = 1;
const MAX_ADMIT_FAILURE_THRESHOLD = 100;

export interface FlowScheduleRuntimeStore {
  readSchedule(scheduleId: string): Promise<FlowScheduleRecord | undefined>;
  listSchedules(): Promise<FlowScheduleRecord[]>;
  updateSchedule(
    scheduleId: string,
    update: (current: FlowScheduleRecord) => FlowScheduleRecord | Promise<FlowScheduleRecord>,
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<FlowScheduleRecord>;
  prepareRetry(
    scheduleId: string,
    stepId: string,
    reason: string,
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<FlowScheduleRecord>;
  createDispatchIntent(
    input: {
      dispatchId: string;
      scheduleId: string;
      stepId: string;
      targetIdentity: ExactWindowIdentity;
      completionCorrelation?: WorkspaceCompletionCorrelation;
      createdAt?: number;
    },
    authorize?: () => boolean,
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<{ created: boolean; dispatch: FlowScheduleDispatchBundle["intent"]; schedule: FlowScheduleRecord }>;
  readDispatch(dispatchId: string): Promise<FlowScheduleDispatchBundle | undefined>;
  recordPublished(record: FlowSchedulePublishedRecord): Promise<FlowSchedulePublishedRecord>;
  recordAccepted(
    record: FlowScheduleAcceptedRecord,
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<FlowScheduleAcceptedRecord>;
  recordCompletion(
    record: FlowScheduleCompletionRecord,
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<FlowScheduleCompletionRecord>;
  recordBinding(record: FlowScheduleTodoBinding): Promise<FlowScheduleTodoBinding>;
  createSchedule(
    input: import("./types.ts").FlowScheduleCreateInput,
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<FlowScheduleRecord>;
  appendSteps(
    scheduleId: string,
    afterStepId: string,
    steps: import("./types.ts").FlowScheduleCreateStepInput[],
    beforePersist?: (projection: FlowScheduleRecord) => void | Promise<void>,
  ): Promise<FlowScheduleRecord>;
  repairScheduleProjection?(projection: FlowScheduleRecord): Promise<FlowScheduleRecord>;
  repairDispatchProjection?(projection: FlowScheduleDispatchBundle): Promise<FlowScheduleDispatchBundle>;
}

export type FlowScheduleRuntimeEventType =
  | "reconcile-start"
  | "reconcile-finish"
  | "dispatch-published"
  | "dispatch-accepted"
  | "dispatch-completed"
  | "dispatch-ambiguous"
  | "admit-deferred"
  | "diagnostic";

export interface FlowScheduleRuntimeEvent {
  type: FlowScheduleRuntimeEventType;
  scheduleId?: string;
  dispatchId?: string;
  detail?: string;
}

export interface FlowScheduleMonitorAuthority {
  readonly generation: number;
}

export interface FlowScheduleRuntimeOptions {
  store: FlowScheduleRuntimeStore;
  getRegistry?: RegistryProvider;
  observe?: Observer;
  now?: () => number;
  createDispatchId?: () => string;
  reconcileIntervalMs?: number;
  /** Maximum wait after an exact result lacks required Todo gate evidence. */
  todoGateTimeoutMs?: number;
  /** Explicit exact-vs-generic grace. Generic terminal evidence is provisional until this expires. */
  genericTerminalGraceMs?: number;
  /** Flow V2 actor/outbox runtime. Absent means the Phase0 v1 path. */
  brokerRuntime?: FlowScheduleBrokerRuntime;
  /** Number of consecutive admitNext deferrals without a dispatch before an active schedule is marked failed. */
  admitFailureThreshold?: number;
  /** Pulls fresh workspace-peer discovery into the session host directory; invoked once when target capture fails before the admission is deferred. */
  refreshRegistryTargets?: () => Promise<void>;
  /** Captures the active Monitor generation immediately before dispatch publication. */
  captureMonitorAuthority?: () => FlowScheduleMonitorAuthority | undefined;
  /** Revalidates a captured Monitor generation at the transport publication boundary. */
  isMonitorAuthorityCurrent?: (authority: FlowScheduleMonitorAuthority) => boolean;
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

/** Legacy aggregate capability retained for Phase0 readers. */
export const FLOW_SCHEDULE_TODO_BINDING_CAPABILITY = "flow-schedule-todo-binding" as const;
export const FLOW_SCHEDULE_TODO_PROJECTION_CAPABILITY = "flow-schedule-todo-projection" as const;
export const FLOW_SCHEDULE_TODO_MUTATION_CAPABILITY = "flow-schedule-todo-mutation" as const;
export const FLOW_SCHEDULE_REPORT_CAPABILITY = "flow-schedule-report" as const;

function todoCapabilities(endpoint: SessionEndpoint): import("./reducer.ts").FlowScheduleTodoCapabilities {
  return {
    rootProjection: endpoint.capabilities.includes(FLOW_SCHEDULE_TODO_PROJECTION_CAPABILITY),
    backendMutation: endpoint.capabilities.includes(FLOW_SCHEDULE_TODO_MUTATION_CAPABILITY),
    report: endpoint.capabilities.includes(FLOW_SCHEDULE_REPORT_CAPABILITY),
  };
}

/** Whether the captured target endpoint supports the active execution path. */
function supportsTodoBinding(endpoint: SessionEndpoint, v2: boolean): boolean {
  if (!v2) return endpoint.capabilities.includes(FLOW_SCHEDULE_TODO_BINDING_CAPABILITY);
  const capabilities = todoCapabilities(endpoint);
  return capabilities.rootProjection && capabilities.backendMutation && capabilities.report;
}

/**
 * Compose the dispatch instruction text. When the step carries a todoBinding,
 * append a bounded contract telling the worker root session to create a Todo,
 * track the dispatchId, and report the Todo id/status back. This is a prompt-layer
 * contract for the worker LLM, NOT an automatic sub-agent dispatch (review P0-4).
 */
function composeDispatchInstruction(prompt: string, binding: FlowScheduleTodoBindingSpec | undefined): string {
  if (!binding) return prompt;
  const label = binding.label ? ` (label: ${binding.label})` : "";
  const gates = [
    binding.requireCompleted ? "require-completed" : null,
    binding.conflictCheck ? "conflict-check" : null,
  ].filter(Boolean).join("+");
  const gateText = gates ? ` with gate ${gates}` : "";
  return `${prompt}

[flow-schedule todo binding${label}${gateText}] This dispatch is bound to a Flow schedule. Create a Todo task for this work, then report its id and final status via flow-schedule report's todoOutcome field (todoId + todoStatus). Use the dispatchId carried in this message when reporting.`;
}

function composeFlowScheduleReportReminder(
  dispatchId: string,
  binding: FlowScheduleTodoBindingSpec | undefined,
): string {
  const todo = binding === undefined
    ? ""
    : " This dispatch is Todo-bound: report the actual todoId and current todoStatus in todoOutcome."
      + (binding.requireCompleted ? " The actual Todo must be completed for requireCompleted." : "")
      + (binding.conflictCheck ? " Preserve the actual Todo state for conflictCheck." : "");
  return `[flow-schedule report reminder] Before finishing, call the flow-schedule tool with action=report and dispatchId=${dispatchId}. Choose completed or failed from the work actually performed and provide the real summary/resources; this reminder does not report an outcome for you.${todo}`;
}

function localRoot(snapshot: SessionHostSnapshot): SessionEndpoint | undefined {
  const roots = snapshot.endpoints.filter((endpoint) => endpoint.kind === "root" && endpoint.scope === "local");
  return roots.length === 1 ? roots[0] : undefined;
}

interface CaptureOutcome {
  capture?: EndpointCapture;
  /** Precise failure diagnosis for deferral reasons and live debugging. */
  reason?: string;
}

function describeRootEndpoints(snapshot: SessionHostSnapshot): string {
  const roots = snapshot.endpoints.filter((endpoint) => endpoint.kind === "root");
  const summary = roots.slice(0, 5).map((endpoint) =>
    `${endpoint.id}(scope=${endpoint.scope},transport=${endpoint.transport},status=${endpoint.status})`
  ).join(", ");
  return `${roots.length} root endpoint(s)${summary ? `: ${summary}` : ""}${roots.length > 5 ? ", …" : ""}`;
}

function captureTarget(
  getRegistry: RegistryProvider,
  selector: string,
  expected?: ExactWindowIdentity,
): EndpointCapture | undefined {
  return captureTargetDetailed(getRegistry, selector, expected).capture;
}

function captureTargetDetailed(
  getRegistry: RegistryProvider,
  selector: string,
  expected?: ExactWindowIdentity,
): CaptureOutcome {
  const registry = getRegistry();
  if (!registry) return { reason: "session host registry is unavailable in this window" };
  const snapshot = registry.snapshot();
  const resolution = registry.resolve(selector, { includeSettled: true, localFirst: false });
  const endpoint = resolution.code === "resolved" ? resolution.endpoint : undefined;
  if (!endpoint) {
    return {
      reason: `target selector ${JSON.stringify(selector)} did not resolve (${resolution.code}${resolution.message ? `: ${resolution.message}` : ""}); directory contains ${describeRootEndpoints(snapshot)}`,
    };
  }
  const ownRoot = localRoot(snapshot);
  if (!ownRoot) {
    const count = snapshot.endpoints.filter((candidate) => candidate.kind === "root" && candidate.scope === "local").length;
    return { reason: `expected exactly one local root endpoint, found ${count}` };
  }
  if (!peerRoot(endpoint)) {
    return {
      reason: `resolved endpoint ${endpoint.id} is not a live workspace-peer root (kind=${endpoint.kind}, scope=${endpoint.scope}, transport=${endpoint.transport}, status=${endpoint.status}, capabilities=${endpoint.capabilities.join("+") || "none"})`,
    };
  }
  if (expected && !sameIdentity(endpoint, expected)) {
    return { reason: `resolved endpoint ${endpoint.id} identity differs from the dispatch target identity` };
  }
  return { capture: { registry, snapshot, selector, endpoint, localRoot: ownRoot } };
}

function captureStillValid(getRegistry: RegistryProvider, capture: EndpointCapture): boolean {
  const registry = getRegistry();
  if (registry !== capture.registry) return false;
  const snapshot = registry.snapshot();
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

function exactReportReminderOutgoing(
  entry: WindowThreadEntry | undefined,
  identity: ExactWindowIdentity,
  dispatchId: string,
  body: string,
): entry is WindowThreadEntry {
  return entry?.direction === "outgoing"
    && entry.messageId === flowScheduleReportReminderMessageId(dispatchId)
    && entry.traceId === dispatchId
    && entry.workspaceId === identity.workspaceId
    && entry.peerOwnerId === identity.ownerId
    && entry.peerOwnerNonce === identity.ownerNonce
    && entry.source === "monitor"
    && entry.messageKind === "request"
    && entry.mode === "follow_up"
    && entry.body === body;
}

function exactOutgoing(
  entry: WindowThreadEntry | undefined,
  identity: ExactWindowIdentity,
  dispatchId: string,
  body: string,
): entry is WindowThreadEntry {
  return entry?.direction === "outgoing"
    && entry.messageId === flowScheduleDispatchMessageId(dispatchId)
    && entry.traceId === dispatchId
    && entry.workspaceId === identity.workspaceId
    && entry.peerOwnerId === identity.ownerId
    && entry.peerOwnerNonce === identity.ownerNonce
    && entry.mode === "follow_up"
    && entry.body === body;
}

function outgoingCarriesTodoBinding(
  entry: WindowThreadEntry,
  bundle: FlowScheduleDispatchBundle,
): boolean {
  try {
    const envelope = decodeFlowScheduleDispatch(entry.body);
    return envelope.dispatchId === bundle.intent.dispatchId
      && envelope.scheduleId === bundle.intent.scheduleId
      && envelope.stepId === bundle.intent.stepId
      && envelope.todoBinding !== undefined;
  } catch {
    return false;
  }
}

function exactIncomingResult(
  entry: WindowThreadEntry | undefined,
  identity: ExactWindowIdentity,
  dispatchId: string,
): entry is WindowThreadEntry {
  const messageId = flowScheduleResultTransportMessageId(dispatchId);
  return consumed(entry)
    && entry?.direction === "incoming"
    && entry.messageId === messageId
    && entry.traceId === dispatchId
    && entry.workspaceId === identity.workspaceId
    && entry.peerOwnerId === identity.ownerId
    && entry.peerOwnerNonce === identity.ownerNonce
    && entry.messageKind === "status";
}

export function sameCompletionCorrelation(
  left: WorkspaceCompletionCorrelation | undefined,
  right: WorkspaceCompletionCorrelation | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.messageId === right.messageId
    && left.requestMessageId === right.requestMessageId
    && left.correlationId === right.correlationId
    && left.dispatchId === right.dispatchId
    && left.deliveryGroupId === right.deliveryGroupId
    && left.reservationId === right.reservationId
    && left.publicationId === right.publicationId
    && left.resource === right.resource
    && left.owner.workspaceId === right.owner.workspaceId
    && left.owner.ownerId === right.owner.ownerId
    && left.owner.ownerNonce === right.owner.ownerNonce;
}

function outgoingCompletionCorrelation(capture: EndpointCapture): WorkspaceCompletionCorrelation | undefined {
  const requests = capture.registry.thread.list().filter((entry) =>
    entry.direction === "outgoing"
    && entry.terminalResultRequested === true
    && entry.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER
    && entry.messageKind === "request"
    && entry.workspaceId === capture.endpoint.workspaceId
    && entry.peerOwnerId === capture.endpoint.ownerId
    && entry.peerOwnerNonce === capture.endpoint.ownerNonce
    && (entry.targetSessionId === undefined || entry.targetSessionId === capture.localRoot.sessionId)
    && consumed(entry)
  );
  if (requests.length !== 1) return undefined;
  try {
    return bindWorkspaceCompletionHandle(requests[0]!.messageId, {
      workspaceId: capture.localRoot.workspaceId,
      ownerId: capture.localRoot.ownerId,
      ownerNonce: capture.localRoot.ownerNonce,
    });
  } catch {
    return undefined;
  }
}

function inboundCompletionCorrelation(
  registry: SessionHostRegistry,
  inbound: WindowThreadEntry,
  ownRoot: SessionEndpoint,
): WorkspaceCompletionCorrelation | undefined {
  const requests = registry.thread.list().filter((entry) =>
    entry.direction === "incoming"
    && entry.terminalResultRequested === true
    && entry.targetCorrelationId === WORKSPACE_MAIN_SESSION_MARKER
    && entry.messageKind === "request"
    && entry.workspaceId === inbound.workspaceId
    && entry.peerOwnerId === inbound.peerOwnerId
    && entry.peerOwnerNonce === inbound.peerOwnerNonce
    && entry.targetSessionId === ownRoot.sessionId
    && consumed(entry)
  );
  if (requests.length !== 1) return undefined;
  try {
    return bindWorkspaceCompletionHandle(requests[0]!.messageId, {
      workspaceId: inbound.workspaceId,
      ownerId: inbound.peerOwnerId,
      ownerNonce: inbound.peerOwnerNonce,
    });
  } catch {
    return undefined;
  }
}

interface GenericTerminalEvidence {
  reason: string;
  terminalAt: number;
}

function genericTerminalEvidence(
  registry: SessionHostRegistry,
  bundle: FlowScheduleDispatchBundle,
): GenericTerminalEvidence | undefined {
  const correlation = bundle.intent.completionCorrelation;
  if (!correlation) return undefined;
  const entry = registry.thread.get(workspaceWindowTerminalResultMessageId(correlation.messageId), "incoming");
  if (!entry) return undefined;
  const ownRoot = localRoot(registry.snapshot());
  if (!ownRoot
    || !consumed(entry)
    || entry.messageKind !== "status"
    || entry.source !== "system"
    || entry.targetCorrelationId !== WORKSPACE_MAIN_SESSION_MARKER
    || entry.traceId !== correlation.messageId
    || entry.workspaceId !== bundle.intent.targetIdentity.workspaceId
    || entry.peerOwnerId !== bundle.intent.targetIdentity.ownerId
    || entry.peerOwnerNonce !== bundle.intent.targetIdentity.ownerNonce
    || entry.targetSessionId !== ownRoot.sessionId) {
    return { terminalAt: entry.updatedAt, reason: "Generic workspace terminal evidence did not match the persisted owner binding" };
  }
  try {
    const terminal = decodeWorkspaceWindowTerminalResult(entry.body);
    if (terminal.requestMessageId !== correlation.messageId) {
      return { terminalAt: entry.updatedAt, reason: "Generic workspace terminal result did not match its persisted message correlation" };
    }
    return {
      terminalAt: terminal.settledAt,
      reason: [
        `Generic workspace lifecycle ${terminal.outcome} before an exact Flow schedule report`,
        `settledAt=${terminal.settledAt}`,
        ...(terminal.error ? [`error=${terminal.error}`] : []),
      ].join("; "),
    };
  } catch (error) {
    return {
      terminalAt: entry.updatedAt,
      reason: `Generic workspace terminal result was invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function observationIsLive(result: ObserveResult): boolean {
  const observation = result.observations[0];
  return observation?.found === true
    && observation.capabilities?.message === true;
}

export class FlowScheduleRuntime {
  private readonly store: FlowScheduleRuntimeStore;
  private readonly getRegistry: RegistryProvider;
  private readonly refreshRegistryTargets?: () => Promise<void>;
  private readonly captureMonitorAuthority: () => FlowScheduleMonitorAuthority | undefined;
  private readonly isMonitorAuthorityCurrent: (authority: FlowScheduleMonitorAuthority) => boolean;
  private readonly monitorAuthorityRequired: boolean;
  private readonly observe: Observer;
  private readonly now: () => number;
  private readonly createDispatchId: () => string;
  private readonly scheduler: SchedulerCore;
  private readonly controller = new AbortController();
  private readonly intervalMs: number;
  private readonly todoGateTimeoutMs: number;
  private readonly genericTerminalGraceMs: number;
  private readonly admitFailureThreshold: number;
  readonly brokerRuntime?: FlowScheduleBrokerRuntime;
  private readonly listeners = new Set<(event: FlowScheduleRuntimeEvent) => void>();
  private readonly reportReminderAttempts = new Map<string, "attempting" | "receipt-recorded">();
  private registryUnsubscribe?: () => void;
  private reconcilePromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private reconcileRequested = false;
  private lastTargetRefreshAt?: number;
  private scheduleCursor = 0;
  private started = false;
  private disposed = false;

  constructor(options: FlowScheduleRuntimeOptions) {
    this.store = options.store;
    this.getRegistry = options.getRegistry ?? (() => getSessionHostRegistry());
    this.refreshRegistryTargets = options.refreshRegistryTargets ?? (async () => { await getSessionHostDirectoryRefresh()?.(); });
    if ((options.captureMonitorAuthority === undefined) !== (options.isMonitorAuthorityCurrent === undefined)) {
      throw new Error("Flow schedule Monitor authority callbacks must be configured together");
    }
    this.monitorAuthorityRequired = options.captureMonitorAuthority !== undefined;
    this.captureMonitorAuthority = options.captureMonitorAuthority ?? (() => undefined);
    this.isMonitorAuthorityCurrent = options.isMonitorAuthorityCurrent ?? (() => false);
    this.observe = options.observe ?? observeTargets;
    this.now = options.now ?? Date.now;
    this.createDispatchId = options.createDispatchId ?? (() => createFlowScheduleDispatchId(randomUUID));
    this.intervalMs = options.reconcileIntervalMs ?? 2_000;
    if (!Number.isInteger(this.intervalMs)
      || this.intervalMs < MIN_RECONCILE_INTERVAL_MS
      || this.intervalMs > MAX_RECONCILE_INTERVAL_MS) {
      throw new Error(`Flow schedule reconcileIntervalMs must be between ${MIN_RECONCILE_INTERVAL_MS} and ${MAX_RECONCILE_INTERVAL_MS}`);
    }
    this.todoGateTimeoutMs = options.todoGateTimeoutMs ?? DEFAULT_TODO_GATE_TIMEOUT_MS;
    if (!Number.isInteger(this.todoGateTimeoutMs)
      || this.todoGateTimeoutMs < MIN_TODO_GATE_TIMEOUT_MS
      || this.todoGateTimeoutMs > MAX_TODO_GATE_TIMEOUT_MS) {
      throw new Error(`Flow schedule todoGateTimeoutMs must be between ${MIN_TODO_GATE_TIMEOUT_MS} and ${MAX_TODO_GATE_TIMEOUT_MS}`);
    }
    this.genericTerminalGraceMs = options.genericTerminalGraceMs ?? DEFAULT_GENERIC_TERMINAL_GRACE_MS;
    if (!Number.isInteger(this.genericTerminalGraceMs)
      || this.genericTerminalGraceMs < MIN_GENERIC_TERMINAL_GRACE_MS
      || this.genericTerminalGraceMs > MAX_GENERIC_TERMINAL_GRACE_MS) {
      throw new Error(`Flow schedule genericTerminalGraceMs must be between ${MIN_GENERIC_TERMINAL_GRACE_MS} and ${MAX_GENERIC_TERMINAL_GRACE_MS}`);
    }
    this.brokerRuntime = options.brokerRuntime;
    this.brokerRuntime?.assertAvailable();
    this.admitFailureThreshold = options.admitFailureThreshold ?? DEFAULT_ADMIT_FAILURE_THRESHOLD;
    if (!Number.isInteger(this.admitFailureThreshold)
      || this.admitFailureThreshold < MIN_ADMIT_FAILURE_THRESHOLD
      || this.admitFailureThreshold > MAX_ADMIT_FAILURE_THRESHOLD) {
      throw new Error(`Flow schedule admitFailureThreshold must be between ${MIN_ADMIT_FAILURE_THRESHOLD} and ${MAX_ADMIT_FAILURE_THRESHOLD}`);
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

  async createSchedule(input: import("./types.ts").FlowScheduleCreateInput): Promise<FlowScheduleRecord> {
    const schedule = await this.store.createSchedule(
      input,
      this.beforeSchedulePersist("schedule.created"),
    );
    await this.markScheduleProjectionApplied(schedule);
    return schedule;
  }

  async appendSchedule(scheduleId: string, afterStepId: string, steps: import("./types.ts").FlowScheduleCreateStepInput[]): Promise<FlowScheduleRecord> {
    await this.ensureScheduleAuthority(scheduleId);
    const schedule = await this.store.appendSteps(
      scheduleId,
      afterStepId,
      steps,
      this.beforeSchedulePersist("schedule.appended"),
    );
    await this.markScheduleProjectionApplied(schedule);
    await this.reconcileReady();
    return schedule;
  }

  async startSchedule(scheduleId: string): Promise<FlowScheduleRecord> {
    await this.ensureScheduleAuthority(scheduleId);
    const updated = await this.store.updateSchedule(
      scheduleId,
      startFlowSchedule,
      this.beforeSchedulePersist("schedule.started"),
    );
    await this.markScheduleProjectionApplied(updated);
    await this.reconcileReady();
    return updated;
  }

  async pauseSchedule(scheduleId: string): Promise<FlowScheduleRecord> {
    await this.ensureScheduleAuthority(scheduleId);
    const updated = await this.store.updateSchedule(
      scheduleId,
      pauseFlowSchedule,
      this.beforeSchedulePersist("schedule.paused"),
    );
    await this.markScheduleProjectionApplied(updated);
    return updated;
  }

  async resumeSchedule(scheduleId: string, target?: string): Promise<FlowScheduleRecord> {
    await this.ensureScheduleAuthority(scheduleId);
    const updated = await this.store.updateSchedule(
      scheduleId,
      (schedule) => resumeFlowSchedule(schedule, target),
      this.beforeSchedulePersist("schedule.resumed"),
    );
    await this.markScheduleProjectionApplied(updated);
    await this.reconcileReady();
    return updated;
  }

  async cancelSchedule(scheduleId: string, reason: string): Promise<FlowScheduleRecord> {
    const current = await this.ensureScheduleAuthority(scheduleId);
    const activeDispatchId = current.activeStepId === undefined
      ? undefined
      : current.steps[current.activeStepId].currentDispatchId;
    const activeBundle = activeDispatchId ? await this.store.readDispatch(activeDispatchId) : undefined;

    let cancelled = await this.store.updateSchedule(
      scheduleId,
      (schedule) => cancelFlowSchedule(schedule, reason),
      this.beforeSchedulePersist("schedule.cancelled"),
    );
    await this.markScheduleProjectionApplied(cancelled);

    if (activeBundle && !activeBundle.completion) {
      try {
        await this.retireCancelledDispatch(cancelled, activeBundle);
      } catch (error) {
        if (!(error instanceof FlowScheduleConflictError)) throw error;
      }
      cancelled = await this.store.readSchedule(scheduleId) ?? cancelled;
    }
    return await this.finalizeCancelledProjection(cancelled);
  }

  async retrySchedule(scheduleId: string, stepId: string, reason: string): Promise<FlowScheduleRecord> {
    await this.ensureScheduleAuthority(scheduleId);
    const updated = await this.store.prepareRetry(
      scheduleId,
      stepId,
      reason,
      this.beforeSchedulePersist("schedule.retry_requested"),
    );
    await this.markScheduleProjectionApplied(updated);
    await this.reconcileReady();
    return updated;
  }

  private async ensureScheduleAuthority(
    scheduleId: string,
    knownSchedule?: FlowScheduleRecord,
    allowAcquire = true,
  ): Promise<FlowScheduleRecord> {
    const schedule = knownSchedule ?? await this.store.readSchedule(scheduleId);
    const actors = this.brokerRuntime?.actors;
    if (!actors) {
      if (!schedule) throw new Error(`Unknown Flow schedule: ${scheduleId}`);
      return schedule;
    }
    const state = schedule
      ? await actors.ensureSchedule(schedule, allowAcquire)
      : await actors.scheduleState(scheduleId, allowAcquire);
    const authoritative = state.projection;
    if (!authoritative) throw new Error(`Flow schedule actor has no projection: ${scheduleId}`);
    if (!schedule || JSON.stringify(authoritative) !== JSON.stringify(schedule)) {
      if (!this.store.repairScheduleProjection) {
        throw new Error("Flow schedule store does not support authoritative projection repair");
      }
      const repaired = await this.store.repairScheduleProjection(authoritative);
      await actors.commitSchedule(
        scheduleId,
        state.projectionState === "pending" ? "schedule.projection_applied" : "schedule.projection_repaired",
        repaired,
      );
      return repaired;
    }
    if (state.projectionState === "pending") {
      await actors.commitSchedule(scheduleId, "schedule.projection_applied", schedule);
    }
    return schedule;
  }

  private beforeSchedulePersist(
    eventType: Extract<import("./reducer.ts").FlowScheduleActorEventType, `schedule.${string}`>,
  ): ((projection: FlowScheduleRecord) => Promise<void>) | undefined {
    const actors = this.brokerRuntime?.actors;
    if (!actors) return undefined;
    return async (projection) => {
      await actors.commitSchedule(projection.scheduleId, eventType, projection);
    };
  }

  private async markScheduleProjectionApplied(schedule: FlowScheduleRecord): Promise<void> {
    await this.brokerRuntime?.actors?.commitSchedule(
      schedule.scheduleId,
      "schedule.projection_applied",
      schedule,
    );
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
    void this.shutdown();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.controller.abort();
    this.registryUnsubscribe?.();
    this.registryUnsubscribe = undefined;
    this.scheduler.shutdown();
    const reconcile = this.reconcilePromise;
    this.shutdownPromise = (async () => {
      await reconcile?.catch(() => undefined);
      await this.brokerRuntime?.stop();
      this.listeners.clear();
    })();
    return this.shutdownPromise;
  }

  private emit(event: FlowScheduleRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async reconcile(): Promise<void> {
    const actors = this.brokerRuntime?.actors;
    const listed = await this.store.listSchedules();
    const discoveredIds = actors ? await actors.discoverScheduleIds() : [];
    const listedById = new Map(listed.map((schedule) => [schedule.scheduleId, schedule]));
    const scheduleIds = [...new Set([...listedById.keys(), ...discoveredIds])].sort();
    const orderedIds = actors && scheduleIds.length > 1
      ? [...scheduleIds.slice(this.scheduleCursor), ...scheduleIds.slice(0, this.scheduleCursor)]
      : scheduleIds;
    if (actors && scheduleIds.length > 0) {
      this.scheduleCursor = (this.scheduleCursor + 1) % scheduleIds.length;
    }

    const authoritative = new Map<string, FlowScheduleRecord>();
    let acquiredSchedules = 0;
    for (const scheduleId of orderedIds) {
      if (this.disposed) return;
      const schedule = listedById.get(scheduleId);
      if (!actors) {
        if (schedule) authoritative.set(scheduleId, schedule);
        continue;
      }
      const alreadyOwned = actors.hasScheduleLease(scheduleId);
      try {
        const repaired = await this.ensureScheduleAuthority(
          scheduleId,
          schedule,
          alreadyOwned || acquiredSchedules < 1,
        );
        authoritative.set(scheduleId, repaired);
      } catch (error) {
        if (error instanceof FlowScheduleLeaseUnavailableError) continue;
        throw error;
      }
      if (!alreadyOwned) acquiredSchedules += 1;
    }

    if (actors && authoritative.size > 0) {
      await this.rebuildDispatchProjections(authoritative);
      for (const scheduleId of authoritative.keys()) {
        const repaired = await this.store.readSchedule(scheduleId);
        if (repaired) authoritative.set(scheduleId, repaired);
      }
    }

    for (const schedule of authoritative.values()) {
      if (this.disposed) return;
      try {
        if (schedule.activeStepId !== undefined) {
          await this.reconcileAttempt(schedule);
        } else if (!isTerminalScheduleState(schedule.state) && schedule.state === "active") {
          await this.admitNext(schedule);
        }
      } catch (error) {
        if (error instanceof FlowScheduleLeaseUnavailableError) continue;
        throw error;
      }
    }
  }

  private async rebuildDispatchProjections(schedules: Map<string, FlowScheduleRecord>): Promise<void> {
    const actors = this.brokerRuntime?.actors;
    if (!actors || !this.store.repairDispatchProjection) return;
    const knownIds = [...schedules.values()].flatMap((schedule) =>
      schedule.stepIds.flatMap((stepId) => schedule.steps[stepId].attempts));
    const dispatchIds = [...new Set([...knownIds, ...await actors.discoverDispatchIds()])].sort();
    for (const dispatchId of dispatchIds) {
      let state: DispatchActorState;
      try {
        state = await actors.dispatchState(dispatchId);
      } catch (error) {
        if (error instanceof FlowScheduleLeaseUnavailableError) continue;
        throw error;
      }
      const schedule = state.scheduleId ? schedules.get(state.scheduleId) : undefined;
      if (!schedule || !state.intent) {
        await actors.releaseDispatch(dispatchId);
        continue;
      }
      const intent = state.intent;
      if (schedule.state === "cancelled" && dispatchIsCurrent(schedule, dispatchId) && !state.completion) {
        const completion = cancelledDispatchCompletion(schedule, intent);
        state = await actors.commitDispatch(dispatchId, "dispatch.retired", {
          reason: schedule.reason,
          completion,
        });
      }
      const bundle = dispatchBundleFromState(state, schedule);
      await this.store.repairDispatchProjection(bundle);
      const admitted = await this.store.createDispatchIntent({
        dispatchId: intent.dispatchId,
        scheduleId: intent.scheduleId,
        stepId: intent.stepId,
        targetIdentity: intent.targetIdentity,
        ...(intent.completionCorrelation ? { completionCorrelation: intent.completionCorrelation } : {}),
        createdAt: intent.createdAt,
      }, undefined, this.beforeSchedulePersist("schedule.dispatch_admitted"));
      schedules.set(admitted.schedule.scheduleId, admitted.schedule);
      if (state.accepted && !state.completion && dispatchIsCurrent(admitted.schedule, dispatchId)) {
        await this.store.recordAccepted(state.accepted, this.beforeSchedulePersist("schedule.dispatch_accepted"));
      }
      if (state.completion && dispatchIsCurrent(await this.store.readSchedule(intent.scheduleId), dispatchId)) {
        await this.store.recordCompletion(state.completion, this.beforeSchedulePersist("schedule.dispatch_completed"));
      }
      if (state.completion?.state === "retired") {
        const projected = await this.store.readSchedule(intent.scheduleId);
        if (projected?.state === "cancelled") {
          schedules.set(projected.scheduleId, await this.finalizeCancelledProjection(projected));
        }
      }
    }
  }

  private async retireCancelledDispatch(
    schedule: FlowScheduleRecord,
    bundle: FlowScheduleDispatchBundle,
  ): Promise<void> {
    const completion = cancelledDispatchCompletion(schedule, bundle.intent);
    if (this.brokerRuntime?.enabled) {
      await this.ensureDispatchAuthority(bundle);
      const state = await this.brokerRuntime.actors!.dispatchState(bundle.intent.dispatchId);
      if (!state.completion) {
        await this.brokerRuntime.actors!.commitDispatch(bundle.intent.dispatchId, "dispatch.retired", {
          reason: schedule.reason,
          completion,
        });
      }
    }
    await this.store.recordCompletion(completion, this.beforeSchedulePersist("schedule.dispatch_completed"));
    const projected = await this.store.readSchedule(schedule.scheduleId);
    if (projected) await this.markScheduleProjectionApplied(projected);
  }

  private async finalizeCancelledProjection(schedule: FlowScheduleRecord): Promise<FlowScheduleRecord> {
    if (schedule.state !== "cancelled" || schedule.activeStepId !== undefined) return schedule;
    const cancellable = schedule.stepIds.filter((stepId) => {
      const state = schedule.steps[stepId].state;
      return state === "pending" || state === "failed" || state === "ambiguous";
    });
    if (cancellable.length === 0) return schedule;
    const finalized = await this.store.updateSchedule(schedule.scheduleId, (current) => ({
      ...current,
      steps: Object.fromEntries(current.stepIds.map((stepId) => {
        const step = current.steps[stepId];
        const state = step.state;
        const cancel = state === "pending" || state === "failed" || state === "ambiguous";
        return [stepId, cancel ? { ...step, state: "cancelled" as const } : step];
      })),
    }), this.beforeSchedulePersist("schedule.cancelled"));
    await this.markScheduleProjectionApplied(finalized);
    return finalized;
  }

  private async admitNext(schedule: FlowScheduleRecord): Promise<void> {
    const stepId = selectNextFlowScheduleStep(schedule);
    if (!stepId) return;
    let outcome = captureTargetDetailed(this.getRegistry, schedule.targetSelector);
    if (!outcome.capture && this.refreshRegistryTargets) {
      // The endpoint directory is refreshed on demand by other tools; admission
      // must not depend on that. Pull fresh peer discovery once per failure
      // streak before concluding the target is unreachable.
      if (this.lastTargetRefreshAt === undefined || this.now() - this.lastTargetRefreshAt >= this.intervalMs) {
        this.lastTargetRefreshAt = this.now();
        try {
          await this.refreshRegistryTargets();
        } catch (error) {
          this.emit({ type: "diagnostic", scheduleId: schedule.scheduleId, detail: `Workspace peer refresh before admission failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (this.disposed) return;
        outcome = captureTargetDetailed(this.getRegistry, schedule.targetSelector);
      }
    }
    const capture = outcome.capture;
    if (!capture) {
      await this.deferAdmission(schedule, `Flow schedule target endpoint is not resolvable as a live workspace-peer root: ${outcome.reason ?? "unknown capture failure"}`);
      return;
    }
    this.lastTargetRefreshAt = undefined;
    const observation = await this.observe({
      action: "status",
      targets: [{ kind: "workspace", id: schedule.targetSelector }],
      detail: "summary",
      lines: 1,
    }, this.controller.signal);
    if (this.disposed) return;
    if (!observationIsLive(observation)) {
      await this.deferAdmission(schedule, "Flow schedule target observation is not live; the window is unavailable or Monitor observation authority is stale");
      return;
    }
    if (!handshakeStillValid(this.getRegistry, capture)) {
      await this.deferAdmission(schedule, "Flow schedule target endpoint handshake changed before dispatch; peer incarnation rotated or was replaced");
      return;
    }

    const completionCorrelation = outgoingCompletionCorrelation(capture);
    if (!completionCorrelation) {
      this.emit({
        type: "diagnostic",
        scheduleId: schedule.scheduleId,
        detail: "Managed target has no unique owner-bound generic completion handle; dispatching without canonical completion correlation",
      });
    }
    const dispatchId = this.createDispatchId();
    const createdAt = this.now();
    const dispatchIntent = {
      version: FLOW_SCHEDULE_VERSION,
      dispatchId,
      scheduleId: schedule.scheduleId,
      stepId,
      targetIdentity: exactIdentity(capture.endpoint),
      ...(completionCorrelation ? { completionCorrelation } : {}),
      state: "prepared" as const,
      createdAt,
    };
    if (this.brokerRuntime?.enabled) {
      const actors = this.brokerRuntime.actors!;
      await actors.commitDispatch(dispatchId, "dispatch.prepared", {
        scheduleId: schedule.scheduleId,
        stepId,
        targetIdentity: dispatchIntent.targetIdentity,
        ...(completionCorrelation ? { completionCorrelationKey: completionCorrelation.resource } : {}),
        intent: dispatchIntent,
      });
      await actors.commitDispatch(dispatchId, "todo.capabilities_recorded", { ...todoCapabilities(capture.endpoint) });
    }
    const intent = await this.store.createDispatchIntent({
      dispatchId,
      scheduleId: schedule.scheduleId,
      stepId,
      targetIdentity: dispatchIntent.targetIdentity,
      ...(completionCorrelation ? { completionCorrelation } : {}),
      createdAt,
    }, () => !this.disposed && handshakeStillValid(this.getRegistry, capture),
    this.beforeSchedulePersist("schedule.dispatch_admitted"));
    await this.markScheduleProjectionApplied(intent.schedule);
    if (this.disposed) return;
    await this.publishAttempt(intent.schedule, { intent: intent.dispatch });
  }

  private async deferAdmission(schedule: FlowScheduleRecord, reason: string): Promise<void> {
    if (this.disposed) return;
    const at = this.now();
    let attempts = (schedule.admitAttempts ?? 0) + 1;
    this.emit({ type: "admit-deferred", scheduleId: schedule.scheduleId, detail: reason });
    let deferred: FlowScheduleRecord;
    try {
      deferred = await this.store.updateSchedule(schedule.scheduleId, (current) => {
        if (isTerminalScheduleState(current.state)) return current;
        attempts = (current.admitAttempts ?? 0) + 1;
        return {
          ...current,
          lastAdmitReason: reason,
          lastAdmitAt: at,
          admitAttempts: attempts,
        };
      }, this.beforeSchedulePersist("schedule.admission_deferred"));
    } catch {
      // A concurrent completion/cancel/terminal transition owns the schedule; deferral counters are no longer relevant.
      return;
    }
    await this.markScheduleProjectionApplied(deferred);
    if (attempts >= this.admitFailureThreshold) {
      const failureReason = `Target not reachable after ${attempts} admission attempts: ${reason}`;
      try {
        const failed = await this.store.updateSchedule(schedule.scheduleId, (current) =>
          isTerminalScheduleState(current.state) || current.activeStepId !== undefined
            ? current
            : failFlowSchedule(current, failureReason),
        this.beforeSchedulePersist("schedule.admission_failed"));
        await this.markScheduleProjectionApplied(failed);
      } catch {
        // A concurrent transition won ownership; the schedule is no longer our responsibility.
      }
    }
  }

  private async ensureDispatchAuthority(bundle: FlowScheduleDispatchBundle): Promise<void> {
    const actors = this.brokerRuntime?.actors;
    if (!actors) return;
    let state = await actors.dispatchState(bundle.intent.dispatchId);
    if (state.revision !== 0) return;
    state = await actors.commitDispatch(bundle.intent.dispatchId, "dispatch.prepared", {
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      targetIdentity: bundle.intent.targetIdentity,
      ...(bundle.intent.completionCorrelation
        ? { completionCorrelationKey: bundle.intent.completionCorrelation.resource }
        : {}),
      intent: bundle.intent,
    });
    if (bundle.binding) {
      state = await actors.commitDispatch(bundle.intent.dispatchId, "dispatch.binding_recorded", {
        binding: bundle.binding,
      });
    }
    if (bundle.published) {
      state = await actors.commitDispatch(bundle.intent.dispatchId, "dispatch.published", {
        publishedAt: bundle.published.publishedAt,
        published: bundle.published,
      });
    }
    if (bundle.accepted) {
      state = await actors.commitDispatch(bundle.intent.dispatchId, "dispatch.accepted", {
        acceptedAt: bundle.accepted.acceptedAt,
        deliveryState: bundle.accepted.deliveryState,
        accepted: bundle.accepted,
      });
    }
    const completion = bundle.completion;
    if (!completion || completion.state === "ignored") return;
    if (completion.state === "retired") {
      await actors.commitDispatch(bundle.intent.dispatchId, "dispatch.retired", {
        reason: completion.reason,
        completion,
      });
      return;
    }
    if (completion.state === "ambiguous") {
      state = await actors.commitDispatch(bundle.intent.dispatchId, "work.generic_terminal_observed", {
        terminalAt: completion.completedAt,
        graceDeadline: completion.completedAt,
        reason: completion.reason,
      });
      await actors.commitDispatch(bundle.intent.dispatchId, "work.unreported_terminal", {
        expiredAt: state.genericGraceDeadline ?? completion.completedAt,
        reason: completion.reason,
        completion,
      });
      return;
    }
    await actors.commitDispatch(
      bundle.intent.dispatchId,
      completion.state === "completed" ? "work.reported.completed" : "work.reported.failed",
      {
        exact: true,
        dispatchId: bundle.intent.dispatchId,
        identityMatches: true,
        completionCorrelationMatches: true,
        reportedAt: completion.completedAt,
        ...(completion.result?.todoOutcome ? { todoOutcome: completion.result.todoOutcome } : {}),
        completion,
      },
      completion.result ? flowScheduleResultMessageId(bundle.intent.dispatchId) : undefined,
    );
  }

  private async reconcileAttempt(schedule: FlowScheduleRecord): Promise<void> {
    const step = schedule.steps[schedule.activeStepId!];
    const dispatchId = step.currentDispatchId;
    if (!dispatchId) return;
    const bundle = await this.store.readDispatch(dispatchId);
    if (!bundle) return;
    await this.ensureDispatchAuthority(bundle);
    if (bundle.completion) {
      if (bundle.completion.state !== "ignored") {
        await this.store.recordCompletion(
          bundle.completion,
          this.beforeSchedulePersist("schedule.dispatch_completed"),
        );
        const projected = await this.store.readSchedule(bundle.intent.scheduleId);
        if (projected) await this.markScheduleProjectionApplied(projected);
      }
      return;
    }
    if (bundle.accepted) {
      await this.store.recordAccepted(
        bundle.accepted,
        this.beforeSchedulePersist("schedule.dispatch_accepted"),
      );
      schedule = await this.store.readSchedule(schedule.scheduleId) ?? schedule;
      await this.markScheduleProjectionApplied(schedule);
    }
    if (await this.acceptResult(schedule, bundle)) return;
    const registry = this.getRegistry();
    const terminal = registry ? genericTerminalEvidence(registry, bundle) : undefined;
    if (terminal) {
      if (!this.brokerRuntime?.enabled) {
        await this.completeAmbiguous(bundle, terminal.reason);
        return;
      }
      const actors = this.brokerRuntime.actors!;
      let actorState = await actors.dispatchState(bundle.intent.dispatchId);
      if (actorState.genericTerminalAt === undefined) {
        actorState = await actors.commitDispatch(bundle.intent.dispatchId, "work.generic_terminal_observed", {
          terminalAt: terminal.terminalAt,
          graceDeadline: this.now() + this.genericTerminalGraceMs,
          reason: terminal.reason,
        });
      }
      if (this.now() < (actorState.genericGraceDeadline ?? Number.MAX_SAFE_INTEGER)) return;
      if (await this.acceptResult(schedule, bundle)) return;
      await this.completeAmbiguous(bundle, terminal.reason);
      return;
    }

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
    const current = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    if (current.binding?.state === "ambiguous") {
      await this.completeAmbiguous(current, current.binding.reason ?? "Todo binding became ambiguous before result completion");
      return;
    }
    if (this.todoReportTimedOut(current)) {
      await this.completeAmbiguous(current, "Todo-bound dispatch did not publish an exact result before timeout");
      return;
    }
    await this.publishAttempt(schedule, current);
  }

  private async acceptResult(schedule: FlowScheduleRecord, bundle: FlowScheduleDispatchBundle): Promise<boolean> {
    if (this.disposed) return false;
    const registry = this.getRegistry();
    if (!registry) return false;
    const entry = registry.thread.get(flowScheduleResultTransportMessageId(bundle.intent.dispatchId), "incoming");
    const ownRoot = localRoot(registry.snapshot());
    if (!ownRoot || entry?.targetSessionId !== ownRoot.sessionId) return false;
    if (!exactIncomingResult(entry, bundle.intent.targetIdentity, bundle.intent.dispatchId)) return false;
    let result;
    try {
      result = decodeFlowScheduleResult(entry.body);
    } catch {
      return false;
    }
    const step = schedule.steps[bundle.intent.stepId];
    const reportedCorrelation = result.completionCorrelation === undefined
      ? undefined
      : validateWorkspaceCompletionCorrelation(result.completionCorrelation);
    const correlationRequired = bundle.intent.completionCorrelation !== undefined
      || result.completionCorrelation !== undefined;
    if ((correlationRequired
      && (!reportedCorrelation
        || !sameCompletionCorrelation(reportedCorrelation, bundle.intent.completionCorrelation)))
      || result.dispatchId !== bundle.intent.dispatchId
      || result.scheduleId !== bundle.intent.scheduleId
      || result.stepId !== bundle.intent.stepId
      || schedule.activeStepId !== bundle.intent.stepId
      || step?.currentDispatchId !== bundle.intent.dispatchId
      || this.disposed) return false;

    const currentBundle = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    const bindingSpec = currentBundle.binding ? step.todoBinding : undefined;
    const requireCompleted = bindingSpec?.requireCompleted === true;
    const conflictCheck = bindingSpec?.conflictCheck === true;
    const reportedTodo = result.todoOutcome;
    if (this.brokerRuntime?.enabled) {
      const actorState = await this.brokerRuntime.actors!.dispatchState(bundle.intent.dispatchId);
      if (reportedTodo && (!currentBundle.binding || !todoCapabilitiesNegotiated(actorState.capabilities))) {
        await this.completeAmbiguous(currentBundle, "Todo outcome was reported without negotiated projection, backend mutation, and report capabilities");
        return true;
      }
    }
    const bindingMatches = currentBundle.binding && reportedTodo
      ? await this.bindReportedTodo(currentBundle, reportedTodo)
      : reportedTodo === undefined;

    if (result.outcome === "completed" && (requireCompleted || conflictCheck)) {
      if (!reportedTodo || !bindingMatches) {
        if (!this.todoGateTimedOut(entry)) return false;
        await this.completeAmbiguous(
          currentBundle,
          "Todo gate evidence was missing or did not match the durable binding before timeout",
        );
        return true;
      }
      if (conflictCheck && reportedTodo.todoStatus !== "completed") {
        await this.completeAmbiguous(
          currentBundle,
          `Worker reported completion while Todo ${reportedTodo.todoId} was ${reportedTodo.todoStatus}`,
        );
        return true;
      }
      if (requireCompleted && reportedTodo.todoStatus !== "completed") {
        if (!this.todoGateTimedOut(entry)) return false;
        await this.completeAmbiguous(
          currentBundle,
          `Todo ${reportedTodo.todoId} did not reach completed before the gate timeout`,
        );
        return true;
      }
    }

    const completedAt = this.now();
    const completion: FlowScheduleCompletionRecord = {
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      targetIdentity: bundle.intent.targetIdentity,
      state: result.outcome,
      result,
      completedAt,
    };
    if (this.brokerRuntime?.enabled) {
      await this.syncReportOutboxActor(bundle.intent.dispatchId);
      await this.brokerRuntime.actors!.commitDispatch(
        bundle.intent.dispatchId,
        result.outcome === "completed" ? "work.reported.completed" : "work.reported.failed",
        {
          exact: true,
          dispatchId: bundle.intent.dispatchId,
          identityMatches: true,
          completionCorrelationMatches: true,
          reportedAt: completedAt,
          ...(result.todoOutcome ? { todoOutcome: result.todoOutcome } : {}),
          completion,
        },
        flowScheduleResultMessageId(bundle.intent.dispatchId),
      );
    }
    await this.store.recordCompletion(completion, this.beforeSchedulePersist("schedule.dispatch_completed"));
    const completedSchedule = await this.store.readSchedule(bundle.intent.scheduleId);
    if (completedSchedule) await this.markScheduleProjectionApplied(completedSchedule);
    this.emit({ type: "dispatch-completed", scheduleId: result.scheduleId, dispatchId: result.dispatchId });
    return true;
  }

  private async syncReportOutboxActor(dispatchId: string): Promise<void> {
    const broker = this.brokerRuntime;
    if (!broker?.enabled) return;
    const messageId = flowScheduleResultTransportMessageId(dispatchId);
    const record = await broker.outbox!.read(messageId);
    if (!record) return;
    let state = await broker.actors!.dispatchState(dispatchId);
    if (state.outbox === "none") {
      state = await broker.actors!.commitDispatch(dispatchId, "outbox.prepared", { messageId });
    }
    if ((record.state === "published" || record.state === "accepted") && state.outbox === "prepared") {
      state = await broker.actors!.commitDispatch(dispatchId, "outbox.published", { messageId });
    }
    if (record.state === "accepted" && state.outbox !== "accepted") {
      await broker.actors!.commitDispatch(dispatchId, "outbox.accepted", { messageId });
    }
  }

  private todoGateTimedOut(entry: WindowThreadEntry): boolean {
    return this.now() - entry.createdAt >= this.todoGateTimeoutMs;
  }

  private todoReportTimedOut(bundle: FlowScheduleDispatchBundle): boolean {
    const binding = bundle.binding;
    if (!binding || isTerminalBindingState(binding.state)) return false;
    const waitingSince = bundle.accepted?.acceptedAt ?? bundle.published?.publishedAt ?? binding.createdAt;
    return this.now() - waitingSince >= this.todoGateTimeoutMs;
  }

  private async bindReportedTodo(
    bundle: FlowScheduleDispatchBundle,
    outcome: FlowScheduleTodoOutcome,
  ): Promise<boolean> {
    const current = (await this.store.readDispatch(bundle.intent.dispatchId))?.binding ?? bundle.binding;
    if (!current) return false;
    if (current.todoId !== undefined && current.todoId !== outcome.todoId) return false;
    if (current.state !== "pending") return current.todoId === outcome.todoId;
    const bound: FlowScheduleTodoBinding = {
      ...current,
      todoId: outcome.todoId,
      todoStatus: outcome.todoStatus,
      state: "bound",
      updatedAt: this.now(),
    };
    await this.brokerRuntime?.actors?.commitDispatch(bundle.intent.dispatchId, "dispatch.binding_recorded", {
      binding: bound,
    });
    await this.store.recordBinding(bound);
    return true;
  }

  private async publishAttempt(schedule: FlowScheduleRecord, initial: FlowScheduleDispatchBundle): Promise<void> {
    let bundle = await this.store.readDispatch(initial.intent.dispatchId) ?? initial;
    if (this.disposed || bundle.completion) return;
    const step = schedule.steps[bundle.intent.stepId];
    if (!step) return;
    if (bundle.accepted) {
      await this.queueReportReminder(schedule, bundle, bundle.binding ? step.todoBinding : undefined);
      return;
    }
    let capture = captureTarget(this.getRegistry, schedule.targetSelector, bundle.intent.targetIdentity);
    if (!capture) return;
    const dispatchMessageId = flowScheduleDispatchMessageId(bundle.intent.dispatchId);
    let outgoing = capture.registry.thread.get(dispatchMessageId, "outgoing");
    const todoBindingNegotiated = step.todoBinding !== undefined
      && (bundle.binding !== undefined
        || (outgoing !== undefined
          ? outgoingCarriesTodoBinding(outgoing, bundle)
          : supportsTodoBinding(capture.endpoint, this.brokerRuntime?.enabled === true)));
    if (todoBindingNegotiated && !bundle.binding) {
      const createdAt = this.now();
      const binding: FlowScheduleTodoBinding = {
        version: FLOW_SCHEDULE_VERSION,
        type: "flow-schedule-binding",
        dispatchId: bundle.intent.dispatchId,
        scheduleId: bundle.intent.scheduleId,
        stepId: bundle.intent.stepId,
        state: "pending",
        createdAt,
        updatedAt: createdAt,
      };
      await this.brokerRuntime?.actors?.commitDispatch(bundle.intent.dispatchId, "dispatch.binding_recorded", {
        binding,
      });
      await this.store.recordBinding(binding);
      bundle = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    }
    const effectiveTodoBinding = todoBindingNegotiated ? step.todoBinding : undefined;
    const body = encodeFlowScheduleDispatch(createFlowScheduleDispatchEnvelope({
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      dispatchId: bundle.intent.dispatchId,
      instruction: composeDispatchInstruction(step.prompt, effectiveTodoBinding),
      todoBinding: effectiveTodoBinding,
    }));
    if (outgoing && !exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body)) {
      await this.completeAmbiguous(bundle, "Dispatch message ID is bound to a different durable thread entry");
      return;
    }
    if (published(outgoing) && !bundle.published) {
      await this.recordPublished(bundle);
      bundle = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    }
    if (consumed(outgoing)) {
      if (!bundle.accepted) {
        await this.recordAccepted(bundle, outgoing!.status === "injected" ? "injected" : "accepted");
      }
      await this.queueReportReminder(schedule, bundle, effectiveTodoBinding);
      return;
    }
    if (outgoing?.status === "queued") {
      await this.queueReportReminder(schedule, bundle, effectiveTodoBinding);
      return;
    }
    if (outgoing?.status === "rejected") {
      await this.completeAmbiguous(bundle, "Target rejected the dispatch without a report");
      return;
    }

    capture = captureTarget(this.getRegistry, schedule.targetSelector, bundle.intent.targetIdentity);
    if (!capture) return;
    const monitorAuthority = this.monitorAuthorityRequired ? this.captureMonitorAuthority() : undefined;
    if (this.monitorAuthorityRequired
      && (!monitorAuthority || !this.isMonitorAuthorityCurrent(monitorAuthority))) return;
    const fence = capture;
    let delivery: SessionMessageResult | undefined;
    try {
      delivery = await capture.registry.send({
        selector: capture.endpoint.id,
        message: body,
        mode: "follow_up",
        messageId: dispatchMessageId,
        traceId: bundle.intent.dispatchId,
        source: this.monitorAuthorityRequired ? "monitor" : "system",
        messageKind: "request",
        replyTo: `owner:${capture.localRoot.ownerId}`,
        authorize: () => !this.disposed
          && captureStillValid(this.getRegistry, fence)
          && (!this.monitorAuthorityRequired
            || monitorAuthority !== undefined && this.isMonitorAuthorityCurrent(monitorAuthority)),
        signal: this.controller.signal,
      });
    } catch (error) {
      this.emit({ type: "diagnostic", scheduleId: schedule.scheduleId, dispatchId: bundle.intent.dispatchId, detail: error instanceof Error ? error.message : String(error) });
    }

    if (this.disposed) return;
    const registry = this.getRegistry();
    outgoing = registry?.thread.get(dispatchMessageId, "outgoing");
    const hasPublishedReceipt = delivery?.receipt?.publicationStage === "published"
      || delivery?.receipt?.publicationStage === "accepted"
      || (exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body) && published(outgoing));
    if (hasPublishedReceipt && !bundle.published) {
      await this.recordPublished(bundle);
      bundle = await this.store.readDispatch(bundle.intent.dispatchId) ?? bundle;
    }
    const reminderEligible = delivery?.delivered === true
      || delivery?.receipt?.publicationStage === "accepted"
      || (exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body)
        && (outgoing.status === "queued" || consumed(outgoing)));
    if (reminderEligible) {
      await this.queueReportReminder(schedule, bundle, effectiveTodoBinding);
    }
    const accepted = delivery?.receipt?.deliveryStage === "injected"
      || (exactOutgoing(outgoing, bundle.intent.targetIdentity, bundle.intent.dispatchId, body) && consumed(outgoing));
    if (accepted) {
      if (!bundle.accepted) {
        const state = outgoing?.status === "accepted" ? "accepted" : "injected";
        await this.recordAccepted(bundle, state);
      }
      return;
    }
  }

  private async queueReportReminder(
    schedule: FlowScheduleRecord,
    bundle: FlowScheduleDispatchBundle,
    todoBinding: FlowScheduleTodoBindingSpec | undefined,
  ): Promise<void> {
    if (!this.monitorAuthorityRequired) return;
    const dispatchId = bundle.intent.dispatchId;
    const messageId = flowScheduleReportReminderMessageId(dispatchId);
    const body = composeFlowScheduleReportReminder(dispatchId, todoBinding);
    const registry = this.getRegistry();
    const existing = registry?.thread.get(messageId, "outgoing");
    if (existing && !exactReportReminderOutgoing(existing, bundle.intent.targetIdentity, dispatchId, body)) {
      this.emit({
        type: "diagnostic",
        scheduleId: schedule.scheduleId,
        dispatchId,
        detail: "Flow report reminder message ID is bound to a different durable thread entry",
      });
      return;
    }
    if (existing?.status === "rejected") {
      this.emit({
        type: "diagnostic",
        scheduleId: schedule.scheduleId,
        dispatchId,
        detail: "Target rejected the Flow report reminder",
      });
      return;
    }
    if (this.reportReminderAttempts.has(messageId)) return;
    if (existing && existing.status !== "timeout") return;

    const capture = captureTarget(this.getRegistry, schedule.targetSelector, bundle.intent.targetIdentity);
    const monitorAuthority = this.captureMonitorAuthority();
    if (!capture || !monitorAuthority || !this.isMonitorAuthorityCurrent(monitorAuthority)) return;
    const priorRevision = existing?.contentRevision;
    this.reportReminderAttempts.set(messageId, "attempting");
    try {
      const delivery = await capture.registry.send({
        selector: capture.endpoint.id,
        message: body,
        mode: "follow_up",
        messageId,
        traceId: dispatchId,
        source: "monitor",
        messageKind: "request",
        replyTo: `owner:${capture.localRoot.ownerId}`,
        authorize: () => !this.disposed
          && captureStillValid(this.getRegistry, capture)
          && this.isMonitorAuthorityCurrent(monitorAuthority),
        signal: this.controller.signal,
      });
      if (delivery.receipt?.publicationStage !== undefined) {
        this.reportReminderAttempts.set(messageId, "receipt-recorded");
      }
    } catch (error) {
      this.emit({
        type: "diagnostic",
        scheduleId: schedule.scheduleId,
        dispatchId,
        detail: `Flow report reminder publication failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      const current = this.getRegistry()?.thread.get(messageId, "outgoing");
      const journalAdvanced = exactReportReminderOutgoing(
        current,
        bundle.intent.targetIdentity,
        dispatchId,
        body,
      ) && current.contentRevision !== priorRevision;
      if (this.reportReminderAttempts.get(messageId) === "attempting" && !journalAdvanced) {
        this.reportReminderAttempts.delete(messageId);
      }
    }
  }

  private async recordPublished(bundle: FlowScheduleDispatchBundle): Promise<void> {
    const publishedAt = this.now();
    const published: FlowSchedulePublishedRecord = {
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-published",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      messageId: flowScheduleDispatchMessageId(bundle.intent.dispatchId),
      traceId: bundle.intent.dispatchId,
      publishedAt,
    };
    if (this.brokerRuntime?.enabled) {
      await this.brokerRuntime.actors!.commitDispatch(bundle.intent.dispatchId, "dispatch.published", {
        publishedAt,
        published,
      });
    }
    await this.store.recordPublished(published);
    this.emit({ type: "dispatch-published", scheduleId: bundle.intent.scheduleId, dispatchId: bundle.intent.dispatchId });
  }

  private async recordAccepted(
    bundle: FlowScheduleDispatchBundle,
    deliveryState: FlowScheduleAcceptedRecord["deliveryState"],
  ): Promise<void> {
    const acceptedAt = this.now();
    const accepted: FlowScheduleAcceptedRecord = {
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-accepted",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      messageId: flowScheduleDispatchMessageId(bundle.intent.dispatchId),
      acceptedAt,
      deliveryState,
    };
    if (this.brokerRuntime?.enabled) {
      await this.brokerRuntime.actors!.commitDispatch(bundle.intent.dispatchId, "dispatch.accepted", {
        acceptedAt,
        deliveryState,
        accepted,
      });
    }
    await this.store.recordAccepted(accepted, this.beforeSchedulePersist("schedule.dispatch_accepted"));
    const schedule = await this.store.readSchedule(bundle.intent.scheduleId);
    if (schedule) await this.markScheduleProjectionApplied(schedule);
    this.emit({ type: "dispatch-accepted", scheduleId: bundle.intent.scheduleId, dispatchId: bundle.intent.dispatchId });
  }

  private async completeAmbiguous(
    bundle: FlowScheduleDispatchBundle,
    reason: string,
  ): Promise<void> {
    const current = await this.store.readDispatch(bundle.intent.dispatchId);
    if (this.disposed || !current || current.completion) return;
    const completedAt = this.now();
    const completion: FlowScheduleCompletionRecord = {
      version: FLOW_SCHEDULE_VERSION,
      type: "flow-schedule-completion",
      dispatchId: bundle.intent.dispatchId,
      scheduleId: bundle.intent.scheduleId,
      stepId: bundle.intent.stepId,
      targetIdentity: bundle.intent.targetIdentity,
      state: "ambiguous",
      reason,
      completedAt,
    };
    if (this.brokerRuntime?.enabled) {
      const actors = this.brokerRuntime.actors!;
      let actorState = await actors.dispatchState(bundle.intent.dispatchId);
      if (actorState.business !== "completed" && actorState.business !== "failed"
        && actorState.business !== "ambiguous" && actorState.business !== "retired") {
        if (actorState.genericTerminalAt === undefined) {
          actorState = await actors.commitDispatch(bundle.intent.dispatchId, "work.generic_terminal_observed", {
            terminalAt: completedAt,
            graceDeadline: completedAt,
            reason,
          });
        }
        if (actorState.business !== "ambiguous") {
          await actors.commitDispatch(bundle.intent.dispatchId, "work.unreported_terminal", {
            expiredAt: completedAt,
            reason,
            completion,
          });
        }
      }
    }
    await this.store.recordCompletion(completion, this.beforeSchedulePersist("schedule.dispatch_completed"));
    const ambiguousSchedule = await this.store.readSchedule(bundle.intent.scheduleId);
    if (ambiguousSchedule) await this.markScheduleProjectionApplied(ambiguousSchedule);
    this.emit({ type: "dispatch-ambiguous", scheduleId: bundle.intent.scheduleId, dispatchId: bundle.intent.dispatchId, detail: reason });
  }
}

function cancelledDispatchCompletion(
  schedule: FlowScheduleRecord,
  intent: FlowScheduleDispatchBundle["intent"],
): FlowScheduleCompletionRecord {
  return {
    version: FLOW_SCHEDULE_VERSION,
    type: "flow-schedule-completion",
    dispatchId: intent.dispatchId,
    scheduleId: intent.scheduleId,
    stepId: intent.stepId,
    targetIdentity: intent.targetIdentity,
    state: "retired",
    reason: `Schedule cancelled: ${schedule.reason ?? "cancelled"}`,
    completedAt: schedule.updatedAt,
  };
}

function dispatchBundleFromState(
  state: DispatchActorState,
  schedule: FlowScheduleRecord,
): FlowScheduleDispatchBundle {
  if (!state.intent) throw new Error(`Dispatch actor has no canonical intent: ${state.dispatchId}`);
  let binding = state.binding ? structuredClone(state.binding) : undefined;
  const completion = state.completion;
  if (binding && completion && !isTerminalBindingState(binding.state)) {
    const outcome = completion.result?.todoOutcome;
    if ((completion.state === "ambiguous" || completion.state === "retired") && completion.reason) {
      binding = {
        ...binding,
        state: "ambiguous",
        reason: completion.reason,
        updatedAt: completion.completedAt,
      };
    } else if (completion.state === "failed" && outcome) {
      binding = {
        ...binding,
        todoId: outcome.todoId,
        todoStatus: outcome.todoStatus,
        state: "failed",
        reason: completion.result?.summary,
        updatedAt: completion.completedAt,
      };
    } else if (completion.state === "completed" && outcome?.todoStatus === "completed") {
      binding = {
        ...binding,
        todoId: outcome.todoId,
        todoStatus: outcome.todoStatus,
        state: "completed",
        updatedAt: completion.completedAt,
      };
    }
  }
  const step = schedule.steps[state.intent.stepId];
  if (binding && step?.state === "pending" && step.attempts.at(-1) === state.intent.dispatchId
    && !isTerminalBindingState(binding.state)) {
    binding = {
      ...binding,
      state: "ambiguous",
      reason: `Retry requested: ${schedule.reason ?? "retry"}`,
      updatedAt: schedule.updatedAt,
    };
  }
  return {
    intent: structuredClone(state.intent),
    ...(state.published ? { published: structuredClone(state.published) } : {}),
    ...(state.accepted ? { accepted: structuredClone(state.accepted) } : {}),
    ...(completion ? { completion: structuredClone(completion) } : {}),
    ...(binding ? { binding } : {}),
  };
}

function dispatchIsCurrent(schedule: FlowScheduleRecord | undefined, dispatchId: string): boolean {
  if (!schedule?.activeStepId) return false;
  return schedule.steps[schedule.activeStepId]?.currentDispatchId === dispatchId;
}

export interface PublishFlowScheduleReportOptions {
  registry?: SessionHostRegistry;
  getRegistry?: RegistryProvider;
  inbound: WindowThreadEntry;
  outcome: FlowScheduleResultOutcome;
  summary: string;
  resources?: string[];
  todoOutcome?: FlowScheduleTodoOutcome;
  brokerRuntime?: FlowScheduleBrokerRuntime;
}

export async function publishFlowScheduleReport(options: PublishFlowScheduleReportOptions): Promise<{
  resultMessageId: string;
  completionCorrelation?: WorkspaceCompletionCorrelation;
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
    || inbound.traceId === undefined
    || inbound.replyTo !== `owner:${inbound.peerOwnerId}`) {
    throw new Error("Flow schedule report requires a trusted inbound dispatch thread entry");
  }
  const envelope = decodeFlowScheduleDispatch(inbound.body);
  if (envelope.dispatchId !== inbound.traceId
    || inbound.messageId !== flowScheduleDispatchMessageId(envelope.dispatchId)) {
    throw new Error("Flow schedule dispatch trace and envelope do not match");
  }
  const capture = captureTarget(getRegistry, inbound.replyTo);
  if (!capture
    || capture.registry !== registry
    || capture.endpoint.ownerId !== inbound.peerOwnerId
    || capture.endpoint.ownerNonce !== inbound.peerOwnerNonce
    || capture.endpoint.workspaceId !== inbound.workspaceId) {
    throw new Error("Flow schedule reply endpoint no longer matches the trusted dispatch sender");
  }
  const completionCorrelation = inboundCompletionCorrelation(registry, inbound, ownRoot);
  const result = createFlowScheduleResult({
    scheduleId: envelope.scheduleId,
    stepId: envelope.stepId,
    dispatchId: envelope.dispatchId,
    outcome: options.outcome,
    summary: options.summary,
    resources: options.resources,
    ...(completionCorrelation ? { completionCorrelation } : {}),
    todoOutcome: options.todoOutcome,
  });
  const resultMessageId = flowScheduleResultMessageId(envelope.dispatchId);
  const transportMessageId = flowScheduleResultTransportMessageId(envelope.dispatchId);
  const body = encodeFlowScheduleResult(result);
  const broker = options.brokerRuntime;
  let outboxRecord: FlowScheduleReportOutboxRecord | undefined;
  if (broker?.enabled) {
    broker.assertAvailable();
    outboxRecord = await broker.outbox!.prepare({
      messageId: transportMessageId,
      resultMessageId,
      dispatchId: envelope.dispatchId,
      scheduleId: envelope.scheduleId,
      stepId: envelope.stepId,
      selector: capture.endpoint.id,
      targetIdentity: exactIdentity(capture.endpoint),
      body,
    });
    if (outboxRecord.state === "accepted") {
      return {
        resultMessageId,
        completionCorrelation,
        delivery: acceptedReplayDelivery(capture.endpoint.id, transportMessageId, envelope.dispatchId),
      };
    }
    await broker.outbox!.recordAttempt(transportMessageId);
  }
  const delivery = await registry.send({
    selector: capture.endpoint.id,
    message: body,
    mode: "follow_up",
    messageId: transportMessageId,
    traceId: envelope.dispatchId,
    source: "system",
    messageKind: "status",
    trustedStatus: true,
    authorize: () => captureStillValid(getRegistry, capture),
  });
  if (broker?.enabled) await applyReportReceipt(broker, outboxRecord!, delivery);
  if (!delivery.delivered && delivery.receipt?.publicationStage !== "published") {
    throw new Error(delivery.error ?? "Flow schedule result publication failed");
  }
  return { resultMessageId, completionCorrelation, delivery };
}

async function applyReportReceipt(
  broker: FlowScheduleBrokerRuntime,
  record: FlowScheduleReportOutboxRecord,
  delivery: SessionMessageResult,
): Promise<void> {
  const publishedReceipt = delivery.receipt?.publicationStage === "published"
    || delivery.receipt?.publicationStage === "accepted";
  const acceptedReceipt = delivery.receipt?.publicationStage === "accepted"
    || delivery.receipt?.deliveryStage === "injected";
  if (publishedReceipt) await broker.outbox!.markPublished(record.messageId);
  if (acceptedReceipt) await broker.outbox!.markAccepted(record.messageId);
}

function acceptedReplayDelivery(endpointId: string, messageId: string, traceId: string): SessionMessageResult {
  return {
    delivered: true,
    endpointId,
    transport: "workspace-peer-v1",
    receipt: { publicationStage: "accepted", deliveryStage: "injected", messageId, traceId },
  };
}

/** Replays worker reports that were durable before a crash but lack an accepted receipt. */
export async function replayFlowScheduleReportOutbox(
  broker: FlowScheduleBrokerRuntime,
  getRegistry: RegistryProvider = () => getSessionHostRegistry(),
): Promise<{ replayed: number; pending: number }> {
  if (!broker.enabled) return { replayed: 0, pending: 0 };
  broker.assertAvailable();
  const records = await broker.outbox!.listPending();
  let replayed = 0;
  for (const record of records) {
    const capture = captureTarget(getRegistry, record.selector, record.targetIdentity);
    if (!capture) continue;
    await broker.outbox!.recordAttempt(record.messageId);
    let delivery: SessionMessageResult;
    try {
      delivery = await capture.registry.send({
        selector: capture.endpoint.id,
        message: record.body,
        mode: "follow_up",
        messageId: record.messageId,
        traceId: record.dispatchId,
        source: "system",
        messageKind: "status",
        trustedStatus: true,
        authorize: () => captureStillValid(getRegistry, capture),
      });
    } catch {
      continue;
    }
    await applyReportReceipt(broker, record, delivery);
    if (delivery.delivered || delivery.receipt?.publicationStage === "published"
      || delivery.receipt?.publicationStage === "accepted") replayed += 1;
  }
  return { replayed, pending: (await broker.outbox!.listPending()).length };
}

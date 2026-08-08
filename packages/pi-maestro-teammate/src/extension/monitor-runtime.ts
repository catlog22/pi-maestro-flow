import { SchedulerCore, type SchedulerCoreOptions, type SchedulerRunContext } from "../scheduler/scheduler-core.ts";
import type { SessionEndpoint, SessionHostRegistry } from "../sessions/session-core.ts";
import {
  buildAnalysisTrendBlock,
  engineTick,
  formatEngineStatusBar,
  type EngineAgentInfo,
  type EngineCallbacks,
  type MonitorBinding,
  type MonitorEngineConfig,
  type MonitorEngineState,
} from "./monitor.ts";
import type { MonitorLedgerRecord } from "./monitor-ledger.ts";
import { MonitorLeaseAdapter, type MonitorLeaseCapture } from "./monitor-lease.ts";
import {
  MonitorSessionEvaluator,
  createMonitorEvaluationRequest,
  type MonitorEvaluationTarget,
} from "./monitor-session.ts";

export const MONITOR_SCHEDULER_TASK_ID = "monitor-runtime";

export interface MonitorRuntimeCaptureInput {
  endpoint: SessionEndpoint;
  info: EngineAgentInfo;
  activeBackgroundJobs?: readonly string[];
}

export interface MonitorRuntimeTargetCapture extends MonitorRuntimeCaptureInput {
  key: string;
  binding: MonitorBinding;
  lease: MonitorLeaseCapture;
  controllerGeneration: number;
  runtimeGeneration: number;
  callbacks: EngineCallbacks;
}

export interface MonitorRuntimeOptions {
  engine: MonitorEngineState;
  config: () => MonitorEngineConfig;
  registry: SessionHostRegistry;
  leases: MonitorLeaseAdapter;
  evaluator: MonitorSessionEvaluator;
  getControllerGeneration: () => number;
  captureTarget: (
    key: string,
    binding: MonitorBinding,
  ) => MonitorRuntimeCaptureInput | undefined | Promise<MonitorRuntimeCaptureInput | undefined>;
  loadGoalContext?: (binding: MonitorBinding) => Promise<string>;
  onStatusUpdate: (status: string | undefined) => void;
  notifyMain: (message: string, target?: string) => void;
  recordLedger?: (record: MonitorLedgerRecord) => void | Promise<void>;
  postGoalObjection?: (goalId: string, summary: string, peerId: string) => void | Promise<void>;
  onIntervention?: (target: string, message: string) => void;
  onEvaluationError?: (reason: string) => void;
  onBindingMissing?: (key: string, binding: MonitorBinding) => void;
  schedulerOptions?: SchedulerCoreOptions;
}

interface MonitorTickState {
  controllerGeneration: number;
  runtimeGeneration: number;
  callbacks: EngineCallbacks;
  captures: Map<string, MonitorRuntimeTargetCapture>;
  analyses: ReadonlyMap<string, import("./monitor.ts").AnalysisResult>;
}

/** Scheduler-owned deterministic Monitor execution runtime. */
export class MonitorRuntime {
  readonly engine: MonitorEngineState;
  readonly options: MonitorRuntimeOptions;
  #scheduler: SchedulerCore | undefined;
  #generation = 0;
  #running = false;
  #inFlight: Promise<void> | undefined;
  #tick: MonitorTickState | undefined;
  #callbacks: EngineCallbacks | undefined;

  constructor(options: MonitorRuntimeOptions) {
    this.options = options;
    this.engine = options.engine;
  }

  get generation(): number { return this.#generation; }
  get running(): boolean { return this.#running; }
  get callbacks(): EngineCallbacks | undefined { return this.#callbacks; }
  get inFlight(): Promise<void> | undefined { return this.#inFlight; }

  start(): void {
    if (this.#running || this.engine.bindings.size === 0) return;
    const generation = ++this.#generation;
    const controllerGeneration = this.options.getControllerGeneration();
    this.#running = true;
    const config = this.options.config();
    const callbacks = this.#createCallbacks(generation, controllerGeneration);
    this.#callbacks = callbacks;
    this.engine.running = true;
    this.engine.ticking = false;
    this.engine.startedAt = Date.now();
    this.engine.config = { ...this.engine.config, ...config };
    this.engine.callbacks = callbacks;
    this.engine.abortController = new AbortController();
    const scheduler = new SchedulerCore(this.options.schedulerOptions);
    this.#scheduler = scheduler;
    scheduler.schedule({
      id: MONITOR_SCHEDULER_TASK_ID,
      intervalMs: config.tickMs,
      immediate: true,
      run: (context) => this.#runScheduledTick(context, generation, controllerGeneration, callbacks),
    });
    this.options.onStatusUpdate(formatEngineStatusBar(this.engine));
  }

  async restart(): Promise<void> {
    if (this.engine.bindings.size === 0) return;
    await this.stop({ stopSession: false });
    this.start();
  }

  async stop(options: { stopSession?: boolean } = {}): Promise<void> {
    const callbacks = this.#callbacks;
    this.#running = false;
    ++this.#generation;
    this.#scheduler?.shutdown();
    this.#scheduler = undefined;
    this.engine.abortController?.abort();
    const inFlight = this.#inFlight;
    if (inFlight) await inFlight;
    await this.options.evaluator.quiesce();
    if (options.stopSession !== false) {
      await this.options.evaluator.host.stop(new AbortController().signal);
    }
    if (this.engine.callbacks === callbacks) this.engine.callbacks = undefined;
    this.engine.abortController = undefined;
    this.engine.running = false;
    this.engine.ticking = false;
    this.#callbacks = undefined;
    this.#tick = undefined;
    this.options.onStatusUpdate(undefined);
  }

  isCaptureCurrent(capture: MonitorRuntimeTargetCapture): boolean {
    if (!this.#running
      || this.#generation !== capture.runtimeGeneration
      || this.options.getControllerGeneration() !== capture.controllerGeneration
      || this.#callbacks !== capture.callbacks
      || this.engine.callbacks !== capture.callbacks
      || this.engine.bindings.get(capture.key) !== capture.binding
      || this.#tick?.captures.get(capture.key) !== capture
      || !this.options.leases.isCurrent(capture.lease)) return false;
    const endpoint = this.options.registry.directory.get(capture.endpoint.id);
    return endpoint?.ownerId === capture.endpoint.ownerId
      && endpoint.ownerNonce === capture.endpoint.ownerNonce
      && capture.lease.ownerId === capture.endpoint.ownerId
      && capture.lease.ownerNonce === capture.endpoint.ownerNonce
      && capture.lease.monitorOwnerId === capture.lease.identity.ownerId
      && capture.lease.monitorOwnerNonce === capture.lease.identity.ownerNonce;
  }

  #createCallbacks(
    runtimeGeneration: number,
    controllerGeneration: number,
  ): EngineCallbacks {
    const callbacks: EngineCallbacks = {
      getAgentInfo: (key) => this.#tick?.captures.get(key)?.info,
      analyze: async (binding) => {
        const capture = this.#tick?.captures.get(binding.correlationId);
        if (!capture || !this.isCaptureCurrent(capture)) return undefined;
        return this.#tick?.analyses.get(binding.correlationId);
      },
      sendIntervention: async (key, message, mode) => {
        const capture = this.#tick?.captures.get(key);
        if (!capture || !this.isCaptureCurrent(capture)) return false;
        const leaseValid = await this.options.leases.verify(capture.lease);
        if (!this.isCaptureCurrent(capture) || !leaseValid) return false;
        const delivery = await this.options.registry.send({
          selector: key,
          message,
          mode,
          source: "monitor",
          signal: this.engine.abortController?.signal,
        });
        if (!this.isCaptureCurrent(capture)) return false;
        const leaseStillValid = await this.options.leases.verify(capture.lease);
        if (!this.isCaptureCurrent(capture) || !leaseStillValid) return false;
        if (delivery.delivered) this.options.onIntervention?.(key, message);
        return delivery.delivered;
      },
      isCurrent: (key, binding) => {
        const capture = this.#tick?.captures.get(key);
        return Boolean(
          capture
          && capture.binding === binding
          && capture.runtimeGeneration === runtimeGeneration
          && capture.controllerGeneration === controllerGeneration
          && this.isCaptureCurrent(capture),
        );
      },
      onBindingMissing: (key, binding) => this.options.onBindingMissing?.(key, binding),
      onStatusUpdate: this.options.onStatusUpdate,
      notifyMain: this.options.notifyMain,
      ...(this.options.recordLedger ? { recordLedger: this.options.recordLedger } : {}),
      ...(this.options.postGoalObjection ? { postGoalObjection: this.options.postGoalObjection } : {}),
    };
    return callbacks;
  }

  async #runScheduledTick(
    context: SchedulerRunContext,
    runtimeGeneration: number,
    controllerGeneration: number,
    callbacks: EngineCallbacks,
  ): Promise<void> {
    const invocation = this.#runTick(context, runtimeGeneration, controllerGeneration, callbacks);
    this.#inFlight = invocation;
    try {
      await invocation;
    } finally {
      if (this.#inFlight === invocation) this.#inFlight = undefined;
    }
  }

  async #runTick(
    context: SchedulerRunContext,
    runtimeGeneration: number,
    controllerGeneration: number,
    callbacks: EngineCallbacks,
  ): Promise<void> {
    if (!this.#runtimeIdentityCurrent(runtimeGeneration, controllerGeneration, callbacks)) return;
    const captures = new Map<string, MonitorRuntimeTargetCapture>();
    const bindings = [...this.engine.bindings];
    const inputs = await Promise.all(bindings.map(async ([key, binding]) => ({
      key,
      binding,
      input: await this.options.captureTarget(key, binding),
    })));
    if (!this.#runtimeIdentityCurrent(runtimeGeneration, controllerGeneration, callbacks)
      || context.signal.aborted) return;
    for (const { key, binding, input } of inputs) {
      const lease = this.options.leases.get(key);
      if (!input
        || !lease
        || this.engine.bindings.get(key) !== binding
        || !this.options.leases.isCurrent(lease)) continue;
      captures.set(key, {
        key,
        binding,
        lease,
        endpoint: input.endpoint,
        info: cloneAgentInfo(input.info),
        ...(input.activeBackgroundJobs ? { activeBackgroundJobs: [...input.activeBackgroundJobs] } : {}),
        controllerGeneration,
        runtimeGeneration,
        callbacks,
      });
    }
    const tick: MonitorTickState = {
      controllerGeneration,
      runtimeGeneration,
      callbacks,
      captures,
      analyses: new Map(),
    };
    this.#tick = tick;
    const capturesCurrent = (): boolean => this.#tick === tick
      && this.#runtimeIdentityCurrent(runtimeGeneration, controllerGeneration, callbacks)
      && [...captures.values()].every((capture) => this.isCaptureCurrent(capture));

    try {
      for (const capture of captures.values()) {
        const leaseValid = await this.options.leases.verify(capture.lease);
        if (!capturesCurrent() || !leaseValid || context.signal.aborted) return;
      }

      const evaluationTargets: MonitorEvaluationTarget[] = [];
      for (const capture of captures.values()) {
        let goalContext: string | undefined;
        if (capture.binding.goalId && this.options.loadGoalContext) {
          goalContext = await this.options.loadGoalContext(capture.binding).catch(() => "");
          if (!capturesCurrent() || context.signal.aborted) return;
        }
        evaluationTargets.push({
          key: capture.key,
          endpointId: capture.endpoint.id,
          ownerId: capture.endpoint.ownerId,
          ownerNonce: capture.endpoint.ownerNonce,
          displayName: capture.binding.displayName,
          mode: capture.binding.mode,
          ...(capture.binding.customPrompt ? { customPrompt: capture.binding.customPrompt } : {}),
          ...(capture.binding.goalId ? { goalId: capture.binding.goalId } : {}),
          ...(goalContext ? { goalContext } : {}),
          ...(capture.binding.analysisHistory.length > 0
            ? { trend: buildAnalysisTrendBlock(capture.binding.analysisHistory, capture.binding.driftScore) }
            : {}),
          status: capture.info.status,
          idleSeconds: capture.info.idleSeconds,
          objective: capture.info.objective,
          outputTail: [...capture.info.outputTail],
          hasPendingInteractions: capture.info.hasPendingInteractions,
          ...(capture.info.contextPressure === undefined ? {} : { contextPressure: capture.info.contextPressure }),
          ...(capture.activeBackgroundJobs ? { activeBackgroundJobs: [...capture.activeBackgroundJobs] } : {}),
        });
      }

      if (evaluationTargets.length > 0) {
        const request = createMonitorEvaluationRequest(evaluationTargets);
        const evaluation = await this.options.evaluator.evaluate(request, context.signal, capturesCurrent);
        if (!capturesCurrent() || context.signal.aborted) return;
        if (evaluation.status === "ok") tick.analyses = evaluation.analyses;
        else if (evaluation.status === "invalid") this.options.onEvaluationError?.(evaluation.reason);
      }

      await engineTick(this.engine);
      if (!this.#runtimeIdentityCurrent(runtimeGeneration, controllerGeneration, callbacks)) return;
      this.options.onStatusUpdate(formatEngineStatusBar(this.engine));
    } finally {
      if (this.#tick === tick) this.#tick = undefined;
    }
  }

  #runtimeIdentityCurrent(
    runtimeGeneration: number,
    controllerGeneration: number,
    callbacks: EngineCallbacks,
  ): boolean {
    return this.#running
      && this.#generation === runtimeGeneration
      && this.options.getControllerGeneration() === controllerGeneration
      && this.#callbacks === callbacks
      && this.engine.callbacks === callbacks;
  }
}

function cloneAgentInfo(info: EngineAgentInfo): EngineAgentInfo {
  return {
    ...info,
    outputTail: [...info.outputTail],
  };
}

import { type SchedulerCoreOptions } from "../scheduler/scheduler-core.ts";
import type { SessionEndpoint, SessionHostRegistry } from "../sessions/session-core.ts";
import { type EngineAgentInfo, type EngineCallbacks, type MonitorBinding, type MonitorEngineConfig, type MonitorEngineState } from "./monitor.ts";
import type { MonitorLedgerRecord } from "./monitor-ledger.ts";
import { MonitorLeaseAdapter, type MonitorLeaseCapture } from "./monitor-lease.ts";
import { MonitorSessionEvaluator } from "./monitor-session.ts";
export declare const MONITOR_SCHEDULER_TASK_ID = "monitor-runtime";
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
    captureTarget: (key: string, binding: MonitorBinding) => MonitorRuntimeCaptureInput | undefined | Promise<MonitorRuntimeCaptureInput | undefined>;
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
/**
 * @deprecated Legacy compatibility runtime for target-bound `/monitor` commands.
 * Monitor control sessions are agent-operated and should choose LLM-callable
 * tools such as `observe`, `teammate-send`, and `loop` instead.
 */
export declare class MonitorRuntime {
    #private;
    readonly engine: MonitorEngineState;
    readonly options: MonitorRuntimeOptions;
    constructor(options: MonitorRuntimeOptions);
    get generation(): number;
    get running(): boolean;
    get callbacks(): EngineCallbacks | undefined;
    get inFlight(): Promise<void> | undefined;
    start(): void;
    restart(): Promise<void>;
    stop(options?: {
        stopSession?: boolean;
    }): Promise<void>;
    isCaptureCurrent(capture: MonitorRuntimeTargetCapture): boolean;
}

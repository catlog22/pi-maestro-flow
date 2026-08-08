import { type MonitorEngineState, type MonitorSupervisionMode } from "./monitor.ts";
import { MonitorLeaseAdapter } from "./monitor-lease.ts";
import { MonitorRuntime, type MonitorRuntimeOptions } from "./monitor-runtime.ts";
import type { SessionEndpoint } from "../sessions/session-core.ts";
import type { MonitorLedgerRecord } from "./monitor-ledger.ts";
export interface MonitorControllerBindingRequest {
    key: string;
    endpoint: SessionEndpoint;
    displayName: string;
    mode: MonitorSupervisionMode;
    customPrompt?: string;
    goalId?: string;
    resumed?: boolean;
}
export interface MonitorControllerBindResult {
    bound: string[];
    errors: Array<{
        key: string;
        error: string;
    }>;
}
export interface MonitorControllerOptions {
    engine?: MonitorEngineState;
    leases: MonitorLeaseAdapter;
    runtime: Omit<MonitorRuntimeOptions, "engine" | "leases" | "getControllerGeneration" | "onBindingMissing">;
    endpointIsCurrent: (endpoint: SessionEndpoint) => boolean;
    flushLedger?: (emit: (record: MonitorLedgerRecord) => void | Promise<void>) => void;
    awaitLedger?: () => Promise<void>;
    onBindingsChanged?: () => void;
}
/** Owns Monitor generations, bindings, scheduler quiescence, ledger exits, and leases. */
export declare class MonitorController {
    #private;
    readonly engine: MonitorEngineState;
    readonly leases: MonitorLeaseAdapter;
    readonly runtime: MonitorRuntime;
    readonly options: MonitorControllerOptions;
    constructor(options: MonitorControllerOptions);
    get generation(): number;
    get running(): boolean;
    bind(requests: readonly MonitorControllerBindingRequest[]): Promise<MonitorControllerBindResult>;
    remove(key: string, status?: string, reason?: string): Promise<boolean>;
    resume(): Promise<boolean>;
    exit(status?: string, reason?: string): Promise<void>;
    shutdown(): Promise<void>;
}

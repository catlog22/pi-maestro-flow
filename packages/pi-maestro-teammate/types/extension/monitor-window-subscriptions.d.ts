import type { MonitorQueryAuthorityFence, MonitorQuerySnapshot, MonitorQueryTargetSnapshot, MonitorQueryWindow } from "./monitor.ts";
import type { MonitorWindowIdentityV1 } from "../public/v1/monitor-window-state.ts";
export declare const MONITOR_WINDOW_EVENTS: readonly ["running", "settled", "completed", "failed", "disconnected"];
export type MonitorWindowEventKind = typeof MONITOR_WINDOW_EVENTS[number];
export declare const DEFAULT_MONITOR_WINDOW_EVENTS: readonly MonitorWindowEventKind[];
export declare const MAX_MONITOR_WINDOW_SUBSCRIPTIONS = 64;
export interface MonitorWindowSubscription {
    subscriptionId: string;
    target: string;
    identity: MonitorWindowIdentityV1;
    sessionId: string;
    sourceId: string;
    generation: number;
    events: readonly MonitorWindowEventKind[];
}
export interface MonitorWindowEvent {
    version: 1;
    eventId: string;
    event: MonitorWindowEventKind;
    subscription: MonitorWindowSubscription;
    cursor: string;
    observedAt: number;
    sourceRevision?: string;
    window: MonitorQueryWindow["window"];
    reason?: string;
}
export interface MonitorWindowSubscriptionDependencies {
    captureAuthority(): MonitorQueryAuthorityFence | undefined;
    isAuthorityCurrent(authority: MonitorQueryAuthorityFence): boolean;
    read(authority: MonitorQueryAuthorityFence, signal: AbortSignal): Promise<MonitorQuerySnapshot>;
    /** Synchronous final exact owner/session sweep after every asynchronous read. */
    isTargetCurrent(target: MonitorQueryTargetSnapshot): boolean;
    notify(event: MonitorWindowEvent): void;
    onError(error: unknown): void;
}
/** Process-local hooks, not persisted configuration. Registry signals are wake hints only. */
export declare class MonitorWindowSubscriptions {
    #private;
    private readonly dependencies;
    constructor(dependencies: MonitorWindowSubscriptionDependencies);
    list(): MonitorWindowSubscription[];
    unsubscribe(id: string): boolean;
    clear(): void;
    subscribe(target: string, events?: readonly MonitorWindowEventKind[]): Promise<MonitorWindowSubscription>;
    /** Coalesce signals into one read plus a trailing read; no stale async commit. */
    refresh(): Promise<void>;
}

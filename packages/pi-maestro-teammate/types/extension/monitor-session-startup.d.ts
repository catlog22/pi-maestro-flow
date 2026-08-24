export interface MonitorSessionStartupTimer {
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface MonitorSessionStartupDispatchResult {
    isError?: boolean;
    content?: readonly unknown[];
}
export interface MonitorSessionStartupOptions<TInvocation> {
    dispatch: () => Promise<MonitorSessionStartupDispatchResult>;
    isRootFenceCurrent: () => boolean;
    onDispatchError?: (result: MonitorSessionStartupDispatchResult) => Error;
    onRootFenceChanged?: () => Error;
    onIdentityMissing?: () => Error;
    timer?: MonitorSessionStartupTimer;
    timeoutMs?: number;
}
export interface MonitorSessionStartup<TInvocation> {
    readonly promise: Promise<TInvocation>;
    start(): void;
    accept(invocation: TInvocation): boolean;
    reject(error: Error): void;
}
/**
 * Coordinates the async gap between accepting a background dispatch and
 * publishing the host-owned evaluator identity.
 */
export declare function createMonitorSessionStartup<TInvocation>(options: MonitorSessionStartupOptions<TInvocation>): MonitorSessionStartup<TInvocation>;

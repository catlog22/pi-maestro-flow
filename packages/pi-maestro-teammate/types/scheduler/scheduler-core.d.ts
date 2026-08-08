export type SchedulerTimerHandle = ReturnType<typeof setTimeout>;
export interface SchedulerRunContext {
    id: string;
    signal: AbortSignal;
    scheduledAt: number;
    startedAt: number;
}
export interface SchedulerTask {
    id: string;
    intervalMs: number;
    immediate?: boolean;
    run(context: SchedulerRunContext): void | Promise<void>;
}
export interface SchedulerCoreOptions {
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => SchedulerTimerHandle;
    clearTimer?: (timer: SchedulerTimerHandle) => void;
    onError?: (error: unknown, id: string) => void;
}
/**
 * Dependency-free fixed-delay scheduler mechanics for long-lived runtimes.
 * Domain state, retry policy, persistence, and result handling stay with the
 * caller. Each task ID is single-flight, including across pause/resume.
 */
export declare class SchedulerCore {
    private readonly entries;
    private readonly inFlightIds;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly onError?;
    private paused;
    private stopped;
    constructor(options?: SchedulerCoreOptions);
    schedule(task: SchedulerTask): void;
    has(id: string): boolean;
    cancel(id: string): boolean;
    pause(): void;
    resume(): void;
    shutdown(): void;
    get isPaused(): boolean;
    get isShutdown(): boolean;
    private arm;
    private run;
}

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

interface ScheduledEntry {
  task: SchedulerTask;
  generation: number;
  pendingDelayMs: number;
  timer?: SchedulerTimerHandle;
  controller?: AbortController;
  resumePending: boolean;
}

/**
 * Dependency-free fixed-delay scheduler mechanics for long-lived runtimes.
 * Domain state, retry policy, persistence, and result handling stay with the
 * caller. Each task ID is single-flight, including across pause/resume.
 */
export class SchedulerCore {
  private readonly entries = new Map<string, ScheduledEntry>();
  private readonly inFlightIds = new Set<string>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<SchedulerCoreOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<SchedulerCoreOptions["clearTimer"]>;
  private readonly onError?: SchedulerCoreOptions["onError"];
  private paused = false;
  private stopped = false;

  constructor(options: SchedulerCoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
  }

  schedule(task: SchedulerTask): void {
    if (this.stopped) throw new Error("SchedulerCore is shut down.");
    if (!task.id.trim()) throw new Error("Scheduler task id is required.");
    if (!Number.isFinite(task.intervalMs) || task.intervalMs < 0) {
      throw new Error("Scheduler task intervalMs must be a finite non-negative number.");
    }
    if (this.entries.has(task.id) || this.inFlightIds.has(task.id)) {
      throw new Error(`Scheduler task already exists: ${task.id}`);
    }

    const entry: ScheduledEntry = {
      task,
      generation: 0,
      pendingDelayMs: task.immediate ? 0 : task.intervalMs,
      resumePending: false,
    };
    this.entries.set(task.id, entry);
    if (!this.paused) this.arm(entry, entry.pendingDelayMs);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    entry.generation++;
    entry.resumePending = false;
    if (entry.timer !== undefined) {
      this.clearTimer(entry.timer);
      entry.timer = undefined;
    }
    entry.controller?.abort();
    return true;
  }

  pause(): void {
    if (this.paused || this.stopped) return;
    this.paused = true;
    for (const entry of this.entries.values()) {
      entry.generation++;
      entry.resumePending = false;
      entry.pendingDelayMs = entry.task.intervalMs;
      if (entry.timer !== undefined) {
        this.clearTimer(entry.timer);
        entry.timer = undefined;
      }
      entry.controller?.abort();
    }
  }

  resume(): void {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    for (const entry of this.entries.values()) {
      if (this.inFlightIds.has(entry.task.id)) {
        entry.resumePending = true;
      } else {
        this.arm(entry, entry.pendingDelayMs);
      }
    }
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.paused = false;
    for (const entry of this.entries.values()) {
      entry.generation++;
      entry.resumePending = false;
      if (entry.timer !== undefined) this.clearTimer(entry.timer);
      entry.controller?.abort();
    }
    this.entries.clear();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isShutdown(): boolean {
    return this.stopped;
  }

  private arm(entry: ScheduledEntry, delayMs: number): void {
    if (this.paused || this.stopped || this.entries.get(entry.task.id) !== entry) return;
    const generation = ++entry.generation;
    const scheduledAt = this.now();
    entry.pendingDelayMs = entry.task.intervalMs;
    entry.timer = this.setTimer(() => {
      if (
        this.paused
        || this.stopped
        || this.entries.get(entry.task.id) !== entry
        || entry.generation !== generation
      ) return;
      entry.timer = undefined;
      void this.run(entry, generation, scheduledAt);
    }, delayMs);
    (entry.timer as SchedulerTimerHandle & { unref?: () => void }).unref?.();
  }

  private async run(entry: ScheduledEntry, generation: number, scheduledAt: number): Promise<void> {
    const id = entry.task.id;
    if (this.inFlightIds.has(id)) return;
    const controller = new AbortController();
    entry.controller = controller;
    this.inFlightIds.add(id);
    try {
      await entry.task.run({ id, signal: controller.signal, scheduledAt, startedAt: this.now() });
    } catch (error) {
      this.onError?.(error, id);
    } finally {
      this.inFlightIds.delete(id);
      if (entry.controller === controller) entry.controller = undefined;

      const current = this.entries.get(id);
      if (current !== entry || this.stopped || this.paused) return;
      if (entry.resumePending) {
        entry.resumePending = false;
        this.arm(entry, entry.pendingDelayMs);
        return;
      }
      if (entry.generation === generation) this.arm(entry, entry.task.intervalMs);
    }
  }
}

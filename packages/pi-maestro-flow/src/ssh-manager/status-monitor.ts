import type { SshConnectionSource, SshExecutor } from "./executor.ts";
import type { SshHost } from "./model.ts";

export const SSH_STATUS_MONITOR_INTERVAL_MS = 60_000;
export const SSH_STATUS_MONITOR_TIMEOUT_MS = 30_000;
export const SSH_STATUS_MONITOR_MAX_CONCURRENCY = 5;

export type SshHostOperationalState = "disabled" | "untrusted" | "checking" | "online" | "offline";

/** Process-local, intentionally non-persistent health state. */
export interface SshHostOperationalStatus {
  status: SshHostOperationalState;
  checkedAt: string | null;
}

export interface SshStatusMonitorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SshStatusMonitorOptions {
  intervalMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  clock?: SshStatusMonitorClock;
}

interface ProbeSnapshot {
  generation: number;
  hostId: string;
  effectiveDigest: string;
}

const systemClock: SshStatusMonitorClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Monitors configured SSH hosts without changing the encrypted store. Call
 * reconcile() after unlock or a successful configuration change, and lock()
 * before locking the store. shutdown() permanently stops this instance.
 */
export class SshStatusMonitor {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly clock: SshStatusMonitorClock;
  private readonly statuses = new Map<string, SshHostOperationalStatus>();
  private readonly active = new Map<string, AbortController>();
  private readonly queue: ProbeSnapshot[] = [];
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private timer: unknown;
  private stopped = false;
  private unlocked = false;
  private running = 0;

  constructor(
    private readonly source: SshConnectionSource & { readonly locked: boolean },
    private readonly executor: Pick<SshExecutor, "testConnection">,
    options: SshStatusMonitorOptions = {},
  ) {
    this.intervalMs = positiveInteger(options.intervalMs ?? SSH_STATUS_MONITOR_INTERVAL_MS, "intervalMs");
    this.timeoutMs = positiveInteger(options.timeoutMs ?? SSH_STATUS_MONITOR_TIMEOUT_MS, "timeoutMs");
    this.concurrency = positiveInteger(options.concurrency ?? SSH_STATUS_MONITOR_MAX_CONCURRENCY, "concurrency");
    if (this.concurrency > SSH_STATUS_MONITOR_MAX_CONCURRENCY) throw new Error("SSH status monitor concurrency cannot exceed 5");
    this.clock = options.clock ?? systemClock;
  }

  getStatus(hostId: string): SshHostOperationalStatus | undefined {
    const value = this.statuses.get(hostId);
    return value ? { ...value } : undefined;
  }

  getStatuses(): ReadonlyMap<string, SshHostOperationalStatus> {
    return new Map([...this.statuses].map(([id, value]) => [id, { ...value }]));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rebuild state from one unlocked-store generation and start an immediate tick. */
  reconcile(): void {
    if (this.stopped) return;
    this.generation++;
    this.cancelTimer();
    this.abortActive();
    this.queue.length = 0;
    if (this.source.locked) {
      this.unlocked = false;
      this.clearStatuses();
      return;
    }

    let hosts: SshHost[];
    try { hosts = this.source.getHosts(); }
    catch {
      this.unlocked = false;
      this.clearStatuses();
      return;
    }
    this.unlocked = true;
    this.statuses.clear();
    for (const host of hosts) {
      this.statuses.set(host.id, host.monitorEnabled
        ? host.hostKey === null ? { status: "untrusted", checkedAt: null } : { status: "checking", checkedAt: null }
        : { status: "disabled", checkedAt: null });
    }
    this.emit();
    this.enqueueTick(hosts);
    this.scheduleTick();
  }

  /** Abort probes and clear all process-local state. The monitor may be reconciled again after unlock. */
  lock(): void {
    if (this.stopped) return;
    this.generation++;
    this.unlocked = false;
    this.cancelTimer();
    this.abortActive();
    this.queue.length = 0;
    this.clearStatuses();
  }

  /** Permanently stop the monitor, aborting probes and clearing all state. */
  shutdown(): void {
    if (this.stopped) return;
    this.lock();
    this.stopped = true;
    this.listeners.clear();
  }

  private tick(): void {
    this.timer = undefined;
    if (this.stopped || !this.unlocked || this.source.locked) {
      this.lock();
      return;
    }
    let hosts: SshHost[];
    try { hosts = this.source.getHosts(); }
    catch { this.lock(); return; }
    this.enqueueTick(hosts);
    this.scheduleTick();
  }

  private enqueueTick(hosts: readonly SshHost[]): void {
    const queuedIds = new Set(this.queue.map((probe) => probe.hostId));
    for (const host of hosts) {
      if (!host.monitorEnabled || host.hostKey === null || queuedIds.has(host.id)) continue;
      let effectiveDigest: string;
      try { effectiveDigest = this.source.getEffectiveHostDigest(host.id); }
      catch { continue; }
      this.statuses.set(host.id, { status: "checking", checkedAt: this.statuses.get(host.id)?.checkedAt ?? null });
      this.queue.push({ generation: this.generation, hostId: host.id, effectiveDigest });
      queuedIds.add(host.id);
    }
    this.emit();
    this.drain();
  }

  private drain(): void {
    if (this.stopped || !this.unlocked) return;
    while (this.running < this.concurrency) {
      const index = this.queue.findIndex((probe) => probe.generation === this.generation && !this.active.has(probe.hostId));
      if (index < 0) break;
      const [snapshot] = this.queue.splice(index, 1);
      if (!snapshot) break;
      this.startProbe(snapshot);
    }
  }

  private startProbe(snapshot: ProbeSnapshot): void {
    const controller = new AbortController();
    this.active.set(snapshot.hostId, controller);
    this.running++;
    void this.runProbe(snapshot, controller).finally(() => {
      if (this.active.get(snapshot.hostId) === controller) this.active.delete(snapshot.hostId);
      this.running--;
      this.drain();
    });
  }

  private async runProbe(snapshot: ProbeSnapshot, controller: AbortController): Promise<void> {
    let timeoutHandle: unknown;
    let timedOut = false;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = this.clock.setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve("timeout");
      }, this.timeoutMs);
    });
    const connection = Promise.resolve()
      .then(() => this.executor.testConnection(snapshot.hostId, { signal: controller.signal }))
      .then((result) => ({ kind: "result" as const, digest: result.effectiveDigest }))
      .catch(() => ({ kind: "error" as const }));
    const outcome = await Promise.race([connection, timeout]);
    if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);

    if (outcome === "timeout") {
      this.publish(snapshot, "offline");
      // Retain the concurrency slot and per-host exclusion until the executor
      // acknowledges abort; a late result is never published.
      await connection;
      return;
    }
    if (timedOut) return;
    if (outcome.kind === "result" && outcome.digest !== undefined && outcome.digest !== snapshot.effectiveDigest) return;
    this.publish(snapshot, outcome.kind === "result" ? "online" : "offline");
  }

  private publish(snapshot: ProbeSnapshot, status: "online" | "offline"): void {
    if (!this.isCurrent(snapshot)) return;
    this.statuses.set(snapshot.hostId, { status, checkedAt: new Date(this.clock.now()).toISOString() });
    this.emit();
  }

  private isCurrent(snapshot: ProbeSnapshot): boolean {
    if (this.stopped || !this.unlocked || this.source.locked || snapshot.generation !== this.generation) return false;
    try {
      const host = this.source.getHosts().find((candidate) => candidate.id === snapshot.hostId);
      return host !== undefined
        && host.id === snapshot.hostId
        && host.monitorEnabled
        && host.hostKey !== null
        && this.source.getEffectiveHostDigest(host.id) === snapshot.effectiveDigest;
    } catch {
      return false;
    }
  }

  private scheduleTick(): void {
    if (this.stopped || !this.unlocked) return;
    this.timer = this.clock.setTimeout(() => this.tick(), this.intervalMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private abortActive(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  private clearStatuses(): void {
    if (this.statuses.size === 0) return;
    this.statuses.clear();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* observers cannot disrupt monitoring */ }
    }
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`SSH status monitor ${name} must be a positive integer`);
  return value;
}

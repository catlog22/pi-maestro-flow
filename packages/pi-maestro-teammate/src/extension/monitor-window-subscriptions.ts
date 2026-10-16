import { randomUUID } from "node:crypto";
import type { MonitorQueryAuthorityFence, MonitorQuerySnapshot, MonitorQueryTargetSnapshot, MonitorQueryWindow } from "./monitor.ts";
import { windowForTarget, sameMonitorIdentity } from "./monitor.ts";
import type { MonitorWindowIdentityV1 } from "../public/v1/monitor-window-state.ts";

export const MONITOR_WINDOW_EVENTS = ["running", "settled", "completed", "failed", "disconnected"] as const;
export type MonitorWindowEventKind = typeof MONITOR_WINDOW_EVENTS[number];
export const DEFAULT_MONITOR_WINDOW_EVENTS: readonly MonitorWindowEventKind[] = ["settled", "completed", "failed", "disconnected"];
export const MAX_MONITOR_WINDOW_SUBSCRIPTIONS = 64;

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
interface Entry {
  subscription: MonitorWindowSubscription;
  authority: MonitorQueryAuthorityFence;
  previous: MonitorQueryWindow;
  settleAt?: number;
  runningRevision?: string;
  settlementRevision?: string;
  completionKeys: Set<string>;
  sequence: number;
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
export class MonitorWindowSubscriptions {
  #entries = new Map<string, Entry>();
  #epoch = 0;
  #flight?: Promise<void>;
  #pending = false;
  #abort = new AbortController();
  constructor(private readonly dependencies: MonitorWindowSubscriptionDependencies) {}

  list(): MonitorWindowSubscription[] {
    for (const [id, entry] of this.#entries) {
      if (!this.dependencies.isAuthorityCurrent(entry.authority)) this.#entries.delete(id);
    }
    return [...this.#entries.values()].map((entry) => structuredClone(entry.subscription));
  }
  unsubscribe(id: string): boolean { return this.#entries.delete(id); }
  clear(): void {
    this.#epoch++;
    this.#entries.clear();
    this.#pending = false;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#flight = undefined;
  }

  async subscribe(target: string, events: readonly MonitorWindowEventKind[] = DEFAULT_MONITOR_WINDOW_EVENTS): Promise<MonitorWindowSubscription> {
    const authority = this.dependencies.captureAuthority();
    if (!authority) throw new Error("Active root Monitor authority is required.");
    if (!events.length || events.some((event) => !MONITOR_WINDOW_EVENTS.includes(event))) throw new Error("Select supported lifecycle events.");
    if (this.list().length >= MAX_MONITOR_WINDOW_SUBSCRIPTIONS) throw new Error("Monitor subscription limit reached.");
    const epoch = this.#epoch;
    const snapshot = await this.dependencies.read(authority, this.#abort.signal);
    if (epoch !== this.#epoch || !this.dependencies.isAuthorityCurrent(authority)) throw new Error("Monitor subscription authority changed.");
    // Registration requires the exact returned address, never an ambiguous name/alias.
    const selected = snapshot.targets.find((item) => item.target === target);
    const window = selected && windowForTarget(snapshot, selected, false);
    if (!selected || !window || !this.dependencies.isTargetCurrent(selected)) throw new Error("Exact workspace owner target was not found; list again. Remote subscriptions are not supported.");
    if (!selected.sessionId || !selected.sourceId || !Number.isSafeInteger(selected.generation) || selected.generation! < 1) {
      throw new Error("Exact target session/generation identity is unavailable; lifecycle subscription refused.");
    }
    // Recheck admission after await (concurrent registrations share the same bound).
    if (this.list().length >= MAX_MONITOR_WINDOW_SUBSCRIPTIONS) throw new Error("Monitor subscription limit reached.");
    const subscription: MonitorWindowSubscription = {
      subscriptionId: randomUUID(), target, identity: { ...selected.identity },
      sessionId: selected.sessionId, sourceId: selected.sourceId, generation: selected.generation!,
      events: [...new Set(events)],
    };
    this.#entries.set(subscription.subscriptionId, {
      subscription, authority, previous: window,
      settleAt: window.window.window.lifecycle.lastSettle?.at,
      runningRevision: selected.runningRevision, settlementRevision: selected.settlementRevision,
      completionKeys: new Set(completionKey(window) ? [completionKey(window)!] : []), sequence: 0,
    });
    // Baseline is deliberately silent, including already completed work.
    return structuredClone(subscription);
  }

  /** Coalesce signals into one read plus a trailing read; no stale async commit. */
  refresh(): Promise<void> {
    if (!this.list().length) return Promise.resolve();
    this.#pending = true;
    if (this.#flight) return this.#flight;
    const epoch = this.#epoch;
    const signal = this.#abort.signal;
    const flight = Promise.resolve().then(async () => {
      while (this.#pending && epoch === this.#epoch) {
        this.#pending = false;
        const authority = this.dependencies.captureAuthority();
        if (!authority) return;
        const admitted = [...this.#entries.values()];
        const snapshot = await this.dependencies.read(authority, signal);
        if (epoch !== this.#epoch || !this.dependencies.isAuthorityCurrent(authority)) return;
        for (const entry of admitted) {
          if (this.#entries.get(entry.subscription.subscriptionId) !== entry
            || !this.dependencies.isAuthorityCurrent(entry.authority)) continue;
          this.#observe(entry, snapshot);
        }
      }
    }).catch((error: unknown) => {
      // Read failures are not disconnections; report them without committing stale state.
      if (epoch === this.#epoch && !signal.aborted) this.dependencies.onError(error);
    }).finally(() => {
      if (this.#flight === flight) this.#flight = undefined;
    });
    this.#flight = flight;
    return flight;
  }

  #observe(entry: Entry, snapshot: MonitorQuerySnapshot): void {
    const sub = entry.subscription;
    const selected = snapshot.targets.find((item) => item.target === sub.target && sameMonitorIdentity(item.identity, sub.identity)
      && item.sessionId === sub.sessionId && item.sourceId === sub.sourceId && item.generation === sub.generation);
    const next = selected && this.dependencies.isTargetCurrent(selected) ? windowForTarget(snapshot, selected, false) : undefined;
    if (!next || next.window.window.lifecycle.status === "disconnected") {
      // Retire first: reentrant callbacks and later replacement owners cannot follow this hook.
      this.#entries.delete(sub.subscriptionId);
      this.#emit(entry, "disconnected", next ?? entry.previous, snapshot.state.observedAt, "Exact owner/session disappeared or was replaced.");
      return;
    }
    const before = entry.previous.window.window.lifecycle.status;
    const lifecycle = next.window.window.lifecycle;
    const settleAt = lifecycle.lastSettle?.at;
    const key = completionKey(next);
    const events: MonitorWindowEventKind[] = [];
    if ((selected!.runningRevision !== undefined && selected!.runningRevision !== entry.runningRevision)
      || (lifecycle.status === "running" && before !== "running")) events.push("running");
    if ((selected!.settlementRevision !== undefined && selected!.settlementRevision !== entry.settlementRevision)
      || (settleAt !== undefined && settleAt !== entry.settleAt)
      || (lifecycle.status === "settled" && before !== "settled")) events.push("settled");
    if (key !== undefined && !entry.completionKeys.has(key)) {
      if (next.window.work.completion.outcome === "completed") events.push("completed");
      if (next.window.work.completion.outcome === "failed") events.push("failed");
    }
    if (lifecycle.status === "failed" && before !== "failed" && !events.includes("failed")) events.push("failed");
    entry.previous = next;
    if (selected!.runningRevision !== undefined) entry.runningRevision = selected!.runningRevision;
    if (selected!.settlementRevision !== undefined) entry.settlementRevision = selected!.settlementRevision;
    if (settleAt !== undefined) entry.settleAt = settleAt;
    if (key !== undefined) entry.completionKeys.add(key);
    for (const event of events) {
      if (this.#entries.get(sub.subscriptionId) !== entry) break;
      this.#emit(entry, event, next, snapshot.state.observedAt, undefined,
        event === "settled" ? selected!.settlementRevision ?? String(settleAt) : event === "running" ? selected!.runningRevision : key);
    }
  }
  #emit(entry: Entry, event: MonitorWindowEventKind, window: MonitorQueryWindow, observedAt: number, reason?: string, sourceRevision?: string): void {
    if (!entry.subscription.events.includes(event) || !this.dependencies.isAuthorityCurrent(entry.authority)) return;
    this.dependencies.notify({
      version: 1, eventId: `${entry.subscription.subscriptionId}:${++entry.sequence}`, event,
      subscription: structuredClone(entry.subscription), cursor: window.cursor, observedAt,
      window: structuredClone(window.window), ...(reason ? { reason } : {}),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
    });
  }
}
function completionKey(window: MonitorQueryWindow): string | undefined {
  const work = window.window.work;
  if (!work.ref || work.completion.source === "unknown" || !work.completion.revision) return undefined;
  return JSON.stringify([work.ref.kind, work.ref.id, work.completion.source, work.completion.revision, work.completion.outcome]);
}

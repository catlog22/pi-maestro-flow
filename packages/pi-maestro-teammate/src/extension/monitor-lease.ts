import {
  acquireMonitorLease,
  readMonitorLease,
  releaseMonitorLease,
  type WorkspacePeerIdentity,
} from "./workspace-peers.ts";

export interface MonitorLeaseTarget {
  key: string;
  ownerId: string;
  ownerNonce: string;
}

export interface MonitorLeaseCapture extends MonitorLeaseTarget {
  monitorOwnerId: string;
  monitorOwnerNonce: string;
  identity: WorkspacePeerIdentity;
}

export interface MonitorLeaseAcquireResult {
  ok: boolean;
  capture?: MonitorLeaseCapture;
  error?: string;
}

export interface MonitorLeaseAdapterOptions {
  getIdentity: () => WorkspacePeerIdentity | undefined;
  getSessionName?: () => string | undefined;
}

/** Narrow ownership adapter over the workspace-peer v1 monitor lease files. */
export class MonitorLeaseAdapter {
  readonly captures = new Map<string, MonitorLeaseCapture>();
  readonly options: MonitorLeaseAdapterOptions;

  constructor(options: MonitorLeaseAdapterOptions) {
    this.options = options;
  }

  get(key: string): MonitorLeaseCapture | undefined {
    return this.captures.get(key);
  }

  isCurrent(capture: MonitorLeaseCapture): boolean {
    const identity = this.options.getIdentity();
    return this.captures.get(capture.key) === capture
      && identity === capture.identity
      && identity.ownerId === capture.monitorOwnerId
      && identity.ownerNonce === capture.monitorOwnerNonce;
  }

  async acquire(target: MonitorLeaseTarget): Promise<MonitorLeaseAcquireResult> {
    const existing = this.captures.get(target.key);
    if (existing) {
      return existing.ownerId === target.ownerId && existing.ownerNonce === target.ownerNonce && this.isCurrent(existing)
        ? { ok: true, capture: existing }
        : { ok: false, error: `Monitor lease capture already exists for ${target.key}.` };
    }
    const identity = this.options.getIdentity();
    if (!identity) return { ok: false, error: "workspace peer publisher unavailable" };
    const result = await acquireMonitorLease(identity, target.ownerId, {
      sessionName: this.options.getSessionName?.(),
    }).catch((error) => ({
      ok: false as const,
      error: `lease error: ${error instanceof Error ? error.message : String(error)}`,
    }));
    const currentIdentity = this.options.getIdentity();
    if (!result.ok || !result.lease) return { ok: false, error: result.error ?? "monitor lease acquisition failed" };
    if (currentIdentity !== identity
      || currentIdentity.ownerId !== identity.ownerId
      || currentIdentity.ownerNonce !== identity.ownerNonce
      || result.lease.monitorOwnerId !== identity.ownerId
      || result.lease.targetOwnerId !== target.ownerId) {
      await releaseMonitorLease(identity, target.ownerId, identity.ownerId).catch(() => undefined);
      return { ok: false, error: "Monitor owner changed while acquiring the supervision lease." };
    }
    const capture: MonitorLeaseCapture = {
      ...target,
      monitorOwnerId: identity.ownerId,
      monitorOwnerNonce: identity.ownerNonce,
      identity,
    };
    this.captures.set(target.key, capture);
    return { ok: true, capture };
  }

  async verify(capture: MonitorLeaseCapture): Promise<boolean> {
    if (!this.isCurrent(capture)) return false;
    const lease = await readMonitorLease(capture.identity, capture.ownerId).catch(() => undefined);
    const valid = this.isCurrent(capture)
      && lease?.monitorOwnerId === capture.monitorOwnerId
      && lease.targetOwnerId === capture.ownerId;
    if (!valid && this.captures.get(capture.key) === capture) this.captures.delete(capture.key);
    return valid;
  }

  async release(capture: MonitorLeaseCapture): Promise<boolean> {
    if (this.captures.get(capture.key) !== capture) return false;
    this.captures.delete(capture.key);
    return releaseMonitorLease(capture.identity, capture.ownerId, capture.monitorOwnerId).catch(() => false);
  }

  async releaseAll(): Promise<void> {
    for (const capture of [...this.captures.values()]) {
      await this.release(capture);
    }
  }
}

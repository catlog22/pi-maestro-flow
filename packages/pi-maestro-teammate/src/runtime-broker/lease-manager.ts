import type {
  AcquireLeaseRequest,
  ActorLease,
  CompareAndSwapLeaseRequest,
  HeartbeatLeaseRequest,
  ReleaseLeaseRequest,
  TakeoverLeaseRequest,
} from "./contracts.ts";
import { RuntimeBrokerSqliteStore } from "./sqlite-store.ts";

/** Lease-only facade for the future JSONL server dispatch table. */
export class RuntimeBrokerLeaseManager {
  #store: RuntimeBrokerSqliteStore;

  constructor(store: RuntimeBrokerSqliteStore) {
    this.#store = store;
  }

  acquire(request: AcquireLeaseRequest, requestId?: string): ActorLease {
    return this.#store.acquireLease(request, requestId);
  }

  heartbeat(request: HeartbeatLeaseRequest, requestId?: string): ActorLease {
    return this.#store.heartbeatLease(request, requestId);
  }

  compareAndSwap(request: CompareAndSwapLeaseRequest, requestId?: string): ActorLease {
    return this.#store.compareAndSwapLease(request, requestId);
  }

  takeover(request: TakeoverLeaseRequest, requestId?: string): ActorLease {
    return this.#store.takeoverLease(request, requestId);
  }

  release(request: ReleaseLeaseRequest, requestId?: string): void {
    this.#store.releaseLease(request, requestId);
  }

  current(actorId: string): ActorLease | undefined {
    return this.#store.getLease(actorId);
  }
}

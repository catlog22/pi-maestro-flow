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

  acquire(request: AcquireLeaseRequest): ActorLease {
    return this.#store.acquireLease(request);
  }

  heartbeat(request: HeartbeatLeaseRequest): ActorLease {
    return this.#store.heartbeatLease(request);
  }

  compareAndSwap(request: CompareAndSwapLeaseRequest): ActorLease {
    return this.#store.compareAndSwapLease(request);
  }

  takeover(request: TakeoverLeaseRequest): ActorLease {
    return this.#store.takeoverLease(request);
  }

  release(request: ReleaseLeaseRequest): void {
    this.#store.releaseLease(request);
  }

  current(actorId: string): ActorLease | undefined {
    return this.#store.getLease(actorId);
  }
}

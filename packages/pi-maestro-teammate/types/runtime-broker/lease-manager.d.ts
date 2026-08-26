import type { AcquireLeaseRequest, ActorLease, CompareAndSwapLeaseRequest, HeartbeatLeaseRequest, ReleaseLeaseRequest, TakeoverLeaseRequest } from "./contracts.ts";
import { RuntimeBrokerSqliteStore } from "./sqlite-store.ts";
/** Lease-only facade for the future JSONL server dispatch table. */
export declare class RuntimeBrokerLeaseManager {
    #private;
    constructor(store: RuntimeBrokerSqliteStore);
    acquire(request: AcquireLeaseRequest): ActorLease;
    heartbeat(request: HeartbeatLeaseRequest): ActorLease;
    compareAndSwap(request: CompareAndSwapLeaseRequest): ActorLease;
    takeover(request: TakeoverLeaseRequest): ActorLease;
    release(request: ReleaseLeaseRequest): void;
    current(actorId: string): ActorLease | undefined;
}

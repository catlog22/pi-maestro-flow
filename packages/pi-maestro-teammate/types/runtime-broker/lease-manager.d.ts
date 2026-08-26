import type { AcquireLeaseRequest, ActorLease, CompareAndSwapLeaseRequest, HeartbeatLeaseRequest, ReleaseLeaseRequest, TakeoverLeaseRequest } from "./contracts.ts";
import { RuntimeBrokerSqliteStore } from "./sqlite-store.ts";
/** Lease-only facade for the future JSONL server dispatch table. */
export declare class RuntimeBrokerLeaseManager {
    #private;
    constructor(store: RuntimeBrokerSqliteStore);
    acquire(request: AcquireLeaseRequest, requestId?: string): ActorLease;
    heartbeat(request: HeartbeatLeaseRequest, requestId?: string): ActorLease;
    compareAndSwap(request: CompareAndSwapLeaseRequest, requestId?: string): ActorLease;
    takeover(request: TakeoverLeaseRequest, requestId?: string): ActorLease;
    release(request: ReleaseLeaseRequest, requestId?: string): void;
    current(actorId: string): ActorLease | undefined;
}

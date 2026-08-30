import type { RuntimeEventDraftV2 } from "../runtime-v2/contracts.ts";
import { type LeaseCredential, type RuntimeBrokerCommitRequest, type RuntimeBrokerCommitResult } from "./contracts.ts";
import { type SessionDomainReadModelSnapshotV2 } from "../runtime-v2/session-domain.ts";
export interface SessionDomainBrokerCommitPort {
    commit(request: RuntimeBrokerCommitRequest, requestId?: string): Promise<RuntimeBrokerCommitResult>;
}
export interface SessionDomainOutboxDraft {
    outboxId: string;
    destination: string;
    payload: unknown;
    availableAt?: number;
}
export interface SessionDomainBrokerCommitterOptions {
    port: SessionDomainBrokerCommitPort;
    actorId: string;
    lease: LeaseCredential;
    streamId: string;
    revision?: number;
    projectionId?: string;
}
/** Atomically commits one validated session event, its projection, and optional transport outbox. */
export declare class SessionDomainBrokerCommitter {
    #private;
    constructor(options: SessionDomainBrokerCommitterOptions);
    get revision(): number;
    commit(input: {
        messageId: string;
        event: RuntimeEventDraftV2;
        projection: SessionDomainReadModelSnapshotV2;
        outbox?: readonly SessionDomainOutboxDraft[];
        requestId?: string;
    }): Promise<RuntimeBrokerCommitResult>;
}

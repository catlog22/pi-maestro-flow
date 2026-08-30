import type { RuntimeBrokerReadModelSourceState, StoredRuntimeBrokerCursorEvent } from "../runtime-broker/contracts.ts";
import { type SessionDomainReadModelSnapshotV2 } from "./session-domain.ts";
export interface SessionDomainBrokerReadPortV2 {
    readRuntimeReadModelSources(workspaceId: string, afterStreamId?: string, limit?: number, requestId?: string): Promise<RuntimeBrokerReadModelSourceState[]>;
    readRuntimeReadModelEvents(workspaceId: string, afterCursor?: number, limit?: number, requestId?: string): Promise<StoredRuntimeBrokerCursorEvent[]>;
}
export declare class SessionDomainBrokerReadModelV2 {
    #private;
    constructor(options: {
        port: SessionDomainBrokerReadPortV2;
        workspaceId: string;
    });
    snapshot(): SessionDomainReadModelSnapshotV2;
    /** Cold rebuild is intentional: active lease sources are authoritative and expired streams must disappear. */
    refresh(): Promise<SessionDomainReadModelSnapshotV2>;
}

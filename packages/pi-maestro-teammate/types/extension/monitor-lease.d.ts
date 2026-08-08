import { type WorkspacePeerIdentity } from "./workspace-peers.ts";
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
export declare class MonitorLeaseAdapter {
    readonly captures: Map<string, MonitorLeaseCapture>;
    readonly options: MonitorLeaseAdapterOptions;
    constructor(options: MonitorLeaseAdapterOptions);
    get(key: string): MonitorLeaseCapture | undefined;
    isCurrent(capture: MonitorLeaseCapture): boolean;
    acquire(target: MonitorLeaseTarget): Promise<MonitorLeaseAcquireResult>;
    verify(capture: MonitorLeaseCapture): Promise<boolean>;
    release(capture: MonitorLeaseCapture): Promise<boolean>;
    releaseAll(): Promise<void>;
}

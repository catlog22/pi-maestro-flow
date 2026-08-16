/** Capability negotiation for remote bridges and CLI drivers. */
export declare const REMOTE_CAPABILITIES: readonly ["streaming", "follow-up", "steer", "cancel", "usage", "tool-events", "structured-output", "session-resume"];
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];
export interface RemoteCapabilityNegotiation {
    capabilities: readonly RemoteCapability[];
    missing: readonly RemoteCapability[];
}
export declare class RemoteCapabilityError extends Error {
    readonly missing: readonly RemoteCapability[];
    constructor(missing: readonly RemoteCapability[]);
}
export declare function isRemoteCapability(value: unknown): value is RemoteCapability;
export declare function negotiateRemoteCapabilities(local: readonly RemoteCapability[], remote: readonly RemoteCapability[], required?: readonly RemoteCapability[]): RemoteCapabilityNegotiation;
export declare function requireRemoteCapabilities(available: readonly RemoteCapability[], required: readonly RemoteCapability[]): void;

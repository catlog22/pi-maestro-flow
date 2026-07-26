export type SessionOwner = "child" | "main" | "none";
export type HandoffState = "active" | "parking" | "parked" | "handoff_pending" | "main_active" | "reloading" | "fenced" | "recovery";
export interface SessionLease {
    owner: SessionOwner;
    state: HandoffState;
    epoch: number;
    nonce: string;
}
export interface LeaseToken {
    owner: SessionOwner;
    epoch: number;
    nonce: string;
}
export interface LeaseSelection extends LeaseToken {
    state: HandoffState;
}
export declare function wrapLeasedMessage(message: string, token?: LeaseToken): string;
export declare function unwrapLeasedMessage(message: string): {
    message: string;
    token?: LeaseToken;
    malformed?: boolean;
};
export declare function sameLeaseToken(expected: LeaseToken | undefined, actual: LeaseToken | undefined): boolean;
export declare function createChildLease(): SessionLease;
export declare function leaseToken(lease: SessionLease): LeaseToken;
export declare function leaseSelection(lease: SessionLease): LeaseSelection;
export declare function sameLeaseSelection(current: SessionLease | undefined, expected: LeaseSelection | undefined): boolean;
export declare function transitionLeaseIfCurrent(current: SessionLease | undefined, expected: LeaseSelection | undefined, transition: (lease: SessionLease) => SessionLease): SessionLease | undefined;
export declare function ownsLease(lease: SessionLease, token: LeaseToken): boolean;
export declare function canChildWrite(lease: SessionLease | undefined): boolean;
export declare function handoffBarrierReached(requiredPromptSeq: number, completedPromptSeq: number, idleStableTicks: number): boolean;
export declare function isSessionPathContained(sessionDir: string | undefined, sessionFile: string | undefined): boolean;
export declare function buildFenceRecoveryMessages(lease: SessionLease, cancelNonce?: string): Record<string, unknown>[];
export declare function requestPark(lease: SessionLease): SessionLease;
export declare function cancelPark(lease: SessionLease): SessionLease;
export declare function confirmParked(lease: SessionLease): SessionLease;
export declare function transferToMain(lease: SessionLease): SessionLease;
export declare function requestHandback(lease: SessionLease): SessionLease;
export declare function confirmChildReloaded(lease: SessionLease): SessionLease;
export declare function restoreMainOwnership(lease: SessionLease): SessionLease;
export declare function fenceLease(lease: SessionLease): SessionLease;
export declare function recoverChild(lease: SessionLease): SessionLease;

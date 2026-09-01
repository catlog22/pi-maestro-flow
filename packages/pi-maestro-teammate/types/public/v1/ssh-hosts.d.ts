import type { SshHostProfile, SshHostReferenceSummary } from "pi-maestro-backend-core/v1/ssh";
/** Runtime provider owned by the system that stores SSH host references. */
export interface SshHostProvider {
    list(): Promise<readonly SshHostReferenceSummary[]>;
    resolve(hostRef: string): Promise<SshHostProfile>;
}
export type SshHostProviderErrorCode = "provider-unavailable" | "manager-locked" | "host-not-found" | "host-incompatible" | "refresh-failed" | "invalid-provider-result";
/** A safe diagnostic whose message never contains provider credential values. */
export declare class SshHostProviderError extends Error {
    readonly code: SshHostProviderErrorCode;
    constructor(code: SshHostProviderErrorCode, message: string);
}
export interface SshHostProviderRegistration {
    /** Remove this provider if it is still the active registration. */
    dispose(): void;
}
/** Register the process-local SSH provider. A newer registration replaces the old one. */
export declare function registerSshHostProvider(provider: SshHostProvider): SshHostProviderRegistration;
/** Return the active provider without invoking it. */
export declare function getSshHostProvider(): SshHostProvider | undefined;
/** List bounded, cloned reference metadata suitable for a trusted configuration UI. */
export declare function listSshHostRefs(): Promise<readonly SshHostReferenceSummary[]>;
/** Resolve and validate one host reference immediately before connection use. */
export declare function resolveSshHostRef(hostRef: string): Promise<SshHostProfile>;

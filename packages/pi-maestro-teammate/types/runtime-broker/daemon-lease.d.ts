export declare const RUNTIME_BROKER_DAEMON_STARTUP_GRACE_MS = 1000;
export interface RuntimeBrokerDaemonIdentity {
    readonly pid: number;
    readonly token: string;
    readonly generation: string;
    readonly startedAt: number;
}
export interface RuntimeBrokerDaemonLease extends RuntimeBrokerDaemonIdentity {
    readonly lockPath: string;
    assertOwned(): void;
    release(): void;
}
export interface RuntimeBrokerDaemonLeaseOptions {
    pid?: number;
    now?: () => number;
    token?: () => string;
    generation?: () => string;
    processExists?: (pid: number) => boolean;
    proveAuthority?: (identity: RuntimeBrokerDaemonIdentity) => boolean | Promise<boolean>;
    startupGraceMs?: number;
}
export declare function runtimeBrokerProcessExists(pid: number): boolean;
export declare function acquireRuntimeBrokerDaemonLease(stateDirectory: string, options?: RuntimeBrokerDaemonLeaseOptions): Promise<RuntimeBrokerDaemonLease>;

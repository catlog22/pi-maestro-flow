export interface RuntimeBrokerDaemonLease {
    readonly lockPath: string;
    readonly pid: number;
    readonly token: string;
    release(): void;
}
export interface RuntimeBrokerDaemonLeaseOptions {
    pid?: number;
    now?: () => number;
    token?: () => string;
    processExists?: (pid: number) => boolean;
}
export declare function runtimeBrokerProcessExists(pid: number): boolean;
export declare function acquireRuntimeBrokerDaemonLease(stateDirectory: string, options?: RuntimeBrokerDaemonLeaseOptions): RuntimeBrokerDaemonLease;

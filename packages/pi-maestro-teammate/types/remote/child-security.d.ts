export { IMMUTABLE_ENV_NAMES, SECRET_ENV_NAME, sanitizedChildEnvironment, targetChildEnvironment, type SanitizedChildEnvironmentOptions, } from "pi-maestro-backends/child-env";
export declare function utf8ByteLength(value: string): number;
/** Truncate at a UTF-8 boundary and append a deterministic marker. */
export declare function truncateUtf8(value: string, maximumBytes: number, marker?: string): string;
export interface RedactRemoteErrorOptions {
    environment?: NodeJS.ProcessEnv;
    maximumBytes?: number;
}
/** Remove known environment secrets and common inline credential forms. */
export declare function redactRemoteError(error: unknown, options?: RedactRemoteErrorOptions): string;
export interface ProcessTreeIdentity {
    readonly pid: number;
    readonly processGroupId: number;
}
export interface WindowsTaskkillCommand {
    executable: string;
    args: string[];
}
export interface ProcessTreeDependencies {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    runTaskkill?: (command: WindowsTaskkillCommand) => {
        status: number | null;
        error?: Error;
        signal?: NodeJS.Signals | null;
    };
}
export declare function captureProcessTree(pid: number | undefined): ProcessTreeIdentity | undefined;
export declare function buildWindowsTaskkillCommand(identity: ProcessTreeIdentity, force: boolean, environment?: NodeJS.ProcessEnv): WindowsTaskkillCommand;
/** Signal a captured process tree without consulting the leader's current state. */
export declare function signalProcessTree(identity: ProcessTreeIdentity | undefined, signal: NodeJS.Signals, dependencies?: ProcessTreeDependencies): void;
/** Gracefully terminate, then always escalate the captured tree after the grace period. */
export declare function terminateProcessTree(identity: ProcessTreeIdentity | undefined, graceMs: number, dependencies?: ProcessTreeDependencies): Promise<void>;

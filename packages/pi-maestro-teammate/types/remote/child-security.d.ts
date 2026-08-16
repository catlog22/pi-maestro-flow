export declare const IMMUTABLE_ENV_NAMES: Set<string>;
export interface SanitizedChildEnvironmentOptions {
    source?: NodeJS.ProcessEnv;
    allow?: readonly string[];
    additions?: Readonly<Record<string, string | undefined>>;
    /**
     * Permit secret-bearing names (e.g. CODEX_API_KEY) in `additions`.
     * Only for values sourced from an explicitly trusted target configuration;
     * launch-policy variables stay rejected regardless.
     */
    allowSecretAdditions?: boolean;
}
/**
 * Build the child environment for a trusted target's CLI: the standard
 * allowlist plus the target-declared `env` names forwarded from the daemon
 * process environment (explicit opt-in; secret names allowed here because the
 * declaration itself lives in the trusted, private remote config).
 */
export declare function targetChildEnvironment(envNames: readonly string[] | undefined, additions?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv;
/** Build a minimal child environment without allowing launch policy overrides. */
export declare function sanitizedChildEnvironment(options?: SanitizedChildEnvironmentOptions): NodeJS.ProcessEnv;
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
    };
}
export declare function captureProcessTree(pid: number | undefined): ProcessTreeIdentity | undefined;
export declare function buildWindowsTaskkillCommand(identity: ProcessTreeIdentity, force: boolean, environment?: NodeJS.ProcessEnv): WindowsTaskkillCommand;
/** Signal a captured process tree without consulting the leader's current state. */
export declare function signalProcessTree(identity: ProcessTreeIdentity | undefined, signal: NodeJS.Signals, dependencies?: ProcessTreeDependencies): void;
/** Gracefully terminate, then always escalate the captured tree after the grace period. */
export declare function terminateProcessTree(identity: ProcessTreeIdentity | undefined, graceMs: number, dependencies?: ProcessTreeDependencies): Promise<void>;

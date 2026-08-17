/**
 * Direct SSH exec backend for ssh-mode `cli/<tool>` tools.
 *
 * Each run opens its own ssh2 connection and exec's the remote ACP CLI over a
 * channel. The channel is adapted to the small child-process surface that
 * AcpRunHandle consumes (stdin/stdout/stderr, kill, error/close events), so the
 * full ACP client pipeline — initialize, session/new, prompt loop, result
 * settlement — is reused exactly as for local CLIs. A pinned host-key verifier
 * and the same auth rules as the remote gateway (identity file or ssh-agent)
 * apply; environment variables are forwarded to the remote process only from
 * the whitelisted set the AcpDriver already computed.
 *
 * The ssh2 surface is typed through minimal structural interfaces (SshExecClient
 * / SshExecChannel) so the exec path is unit-testable with in-process mocks;
 * the default factory casts the real ssh2 Client onto that surface.
 */
import { type ConnectConfig } from "ssh2";
import type { RemoteHostConfig } from "./types.ts";
/** Minimal writable channel surface consumed by the adapter (duplex in practice). */
export interface SshExecChannel extends NodeJS.WritableStream {
    readonly stderr: NodeJS.ReadableStream;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
    signal(name: string): void;
    destroy(error?: Error): this;
}
/** Minimal ssh2 client surface used by the direct-exec backend. */
export interface SshExecClient {
    connect(config: ConnectConfig): unknown;
    once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    removeAllListeners(event?: string | symbol): unknown;
    exec(command: string, options: {
        env?: NodeJS.ProcessEnv;
    }, callback: (error: Error | undefined, channel: SshExecChannel) => void): unknown;
    end(): unknown;
    destroy(): unknown;
}
export interface SshDirectExecOptions {
    /** Injectable client factory (tests). */
    createClient?: () => SshExecClient;
    /** Injectable identity-file reader (tests). */
    readIdentityFile?: (filePath: string) => Buffer;
    /** ssh-agent socket; defaults to $SSH_AUTH_SOCK. */
    agentSocket?: string;
    connectTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    keepaliveIntervalMs?: number;
    keepaliveCountMax?: number;
    /** Timeout for a CLI-availability probe round trip. */
    probeTimeoutMs?: number;
}
export interface SshCliProbeResult {
    ok: boolean;
    error?: string;
}
/**
 * Probe whether a remote CLI is reachable: connect to the host and check that
 * the executable resolves (command -v / which). No ACP traffic is sent.
 */
export declare function probeSshCliExecutable(host: RemoteHostConfig, command: string, options?: SshDirectExecOptions): Promise<SshCliProbeResult>;
/**
 * Create a spawn function that launches the remote CLI over a fresh ssh2
 * connection, adapted to the child-process surface AcpRunHandle consumes.
 * `remoteCwd` becomes the remote working directory (cd wrapper); when omitted,
 * the AcpDriver-supplied spawnOptions.cwd is used. The whitelisted `env` set in
 * spawnOptions is forwarded to the remote process via exec options.
 */
export declare function spawnSshChild(host: RemoteHostConfig, options?: SshDirectExecOptions, remoteCwd?: string): (command: string, args: readonly string[], spawnOptions: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}) => ChildProcessLike;
/** Minimal child-process surface consumed by AcpRunHandle. */
export interface ChildProcessLike {
    readonly pid: number | undefined;
    exitCode: number | null;
    signalCode: string | null;
    stdin: NodeJS.WritableStream;
    stdout: NodeJS.ReadableStream;
    stderr: NodeJS.ReadableStream;
    kill(signal?: NodeJS.Signals | number): boolean;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

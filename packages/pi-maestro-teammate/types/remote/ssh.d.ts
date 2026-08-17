import type { RemoteConnection, RemoteConnectionFactory } from "./driver.ts";
import type { ResolvedRemoteTarget } from "./types.ts";
export declare const REMOTE_GATEWAY_COMMAND: "pi-teammate-remote connect --stdio";
export declare const SSH_DEFAULT_CONNECT_TIMEOUT_MS = 10000;
export declare const SSH_DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;
export declare const SSH_DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export declare const SSH_DEFAULT_KEEPALIVE_MS = 10000;
export declare const SSH_DEFAULT_KEEPALIVE_COUNT = 3;
export declare const SSH_DEFAULT_MAX_STDERR_BYTES: number;
export declare const SSH_DEFAULT_MAX_BUFFERED_OUTPUT_BYTES: number;
export type SshTransportErrorCode = "authentication" | "connect-timeout" | "handshake-timeout" | "host-key" | "identity" | "output-limit" | "pool-limit" | "protocol" | "request-timeout" | "transport";
export declare class SshTransportError extends Error {
    readonly code: SshTransportErrorCode;
    constructor(code: SshTransportErrorCode, message: string, options?: ErrorOptions);
}
export declare class RemoteRpcResponseError extends Error {
    readonly code: number;
    readonly data?: unknown;
    constructor(code: number, message: string, data?: unknown);
}
export interface SshClientConnectConfig {
    host: string;
    port: number;
    username: string;
    hostVerifier: (presentedKey: Buffer) => boolean;
    privateKey?: Buffer;
    agent?: string;
    authHandler: readonly ["publickey"] | readonly ["agent"];
    keepaliveInterval: number;
    keepaliveCountMax: number;
    timeout: number;
    readyTimeout: number;
    strictVendor: boolean;
    tryKeyboard: false;
}
export interface SshChannelLike extends NodeJS.ReadWriteStream {
    readonly stderr: NodeJS.ReadableStream;
    destroy(error?: Error): this;
}
export interface SshClientLike {
    connect(config: SshClientConnectConfig): unknown;
    exec(command: string, callback: (error: Error | undefined, channel: SshChannelLike) => void): unknown;
    on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    off(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    end(): unknown;
    destroy(): unknown;
}
export interface SshRemoteConnectionFactoryOptions {
    createClient?: () => SshClientLike;
    readIdentityFile?: (filePath: string) => Buffer;
    agentSocket?: string;
    connectTimeoutMs?: number;
    handshakeTimeoutMs?: number;
    requestTimeoutMs?: number;
    keepaliveIntervalMs?: number;
    keepaliveCountMax?: number;
    maxConnectionsPerHost?: number;
    maxChannelsPerConnection?: number;
    maxPendingPerHost?: number;
    maxStderrBytes?: number;
    maxBufferedOutputBytes?: number;
}
export declare function expandIdentityPath(filePath: string): string;
export declare function readPrivateIdentityFile(filePath: string): Buffer;
/** Creates a fail-closed verifier for the OpenSSH SHA256 host-key fingerprint form. */
export declare function createPinnedHostKeyVerifier(expectedFingerprint: string): (presentedKey: Buffer) => boolean;
/** Pooled SSH factory for configured POSIX remote targets. */
export declare class SshRemoteConnectionFactory implements RemoteConnectionFactory {
    #private;
    constructor(options?: SshRemoteConnectionFactoryOptions);
    connect(target: ResolvedRemoteTarget, signal?: AbortSignal): Promise<RemoteConnection>;
    close(): Promise<void>;
}

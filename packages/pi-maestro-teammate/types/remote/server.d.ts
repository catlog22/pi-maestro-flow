import * as net from "node:net";
import type { RemoteDriver } from "./driver.ts";
import { RemoteRunJournal } from "./journal.ts";
import { type ResolvedRemoteTarget } from "./types.ts";
export declare const REMOTE_SOCKET_FILE = "bridge.sock";
export declare const REMOTE_DAEMON_LOCK_FILE = "daemon.lock";
export declare const REMOTE_HEARTBEAT_MS = 15000;
export declare const REMOTE_CLIENT_EGRESS_BYTES: number;
export interface RemoteBridgeServerOptions {
    stateDirectory?: string;
    journal?: RemoteRunJournal;
    targets: readonly ResolvedRemoteTarget[];
    drivers?: readonly RemoteDriver[];
    concurrency?: number;
    heartbeatMs?: number;
    clientEgressBytes?: number;
}
export declare function getRemoteSocketPath(stateDirectory?: string): string;
export declare class RemoteBridgeServer {
    #private;
    readonly journal: RemoteRunJournal;
    readonly socketPath: string;
    constructor(options: RemoteBridgeServerOptions);
    listen(): Promise<void>;
    close(): Promise<void>;
}
export declare function connectRemoteSocket(stateDirectory?: string): Promise<net.Socket>;
export declare function relayBoundedRemoteStream(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void>;

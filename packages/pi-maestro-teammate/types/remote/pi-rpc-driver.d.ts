import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { RemoteDriver, RemoteDriverContext, RemoteRunHandle } from "./driver.ts";
import { type RemoteRunAttachParams, type RemoteRunStartParams } from "./protocol.ts";
import type { RemoteRunSnapshot } from "./types.ts";
export declare const PI_RPC_STDERR_LIMIT: number;
export declare const PI_RPC_EVENT_TEXT_LIMIT: number;
export declare const PI_RPC_RESULT_LIMIT: number;
export declare const PI_RPC_CANCEL_GRACE_MS = 2000;
export declare const PI_RPC_EVENT_QUEUE_BYTES: number;
export declare const PI_RPC_PENDING_INPUT_LIMIT = 64;
export declare const PI_RPC_PENDING_INPUT_BYTES: number;
type SpawnChild = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
}) => ChildProcessWithoutNullStreams;
export interface PiRpcDriverOptions {
    scratchRoot?: string;
    cancelGraceMs?: number;
    eventQueueBytes?: number;
    spawnChild?: SpawnChild;
}
export declare class PiRpcDriver implements RemoteDriver {
    #private;
    readonly id: "pi-rpc";
    constructor(options?: PiRpcDriverOptions);
    start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle>;
    attach(request: RemoteRunAttachParams, context: RemoteDriverContext): Promise<RemoteRunHandle>;
    list(context: RemoteDriverContext): Promise<readonly RemoteRunSnapshot[]>;
    close(): Promise<void>;
}
export {};

import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { RemoteDriver, RemoteDriverContext, RemoteRunHandle } from "./driver.ts";
import { type RemoteRunStartParams } from "./protocol.ts";
export declare const ACP_STDERR_LIMIT: number;
export declare const ACP_EVENT_TEXT_LIMIT: number;
export declare const ACP_RESULT_LIMIT: number;
export declare const ACP_CANCEL_GRACE_MS = 2000;
export declare const ACP_STARTUP_TIMEOUT_MS = 15000;
export declare const ACP_PENDING_INPUT_LIMIT = 64;
export declare const ACP_PENDING_INPUT_BYTES: number;
export declare const ACP_EVENT_QUEUE_BYTES: number;
type SpawnChild = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
}) => ChildProcessWithoutNullStreams;
export interface AcpDriverOptions {
    cancelGraceMs?: number;
    startupTimeoutMs?: number;
    eventQueueBytes?: number;
    spawnChild?: SpawnChild;
}
export declare class AcpDriver implements RemoteDriver {
    #private;
    readonly id: "acp";
    constructor(options?: AcpDriverOptions);
    start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle>;
    close(): Promise<void>;
}
export {};

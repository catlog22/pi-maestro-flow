import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { RemoteDriver, RemoteDriverContext, RemoteRunHandle } from "./driver.ts";
import { type RemoteRunAttachParams, type RemoteRunStartParams } from "./protocol.ts";
import type { RemoteRunSnapshot } from "./types.ts";
export declare const ACP_STDERR_LIMIT: number;
export declare const ACP_EVENT_TEXT_LIMIT: number;
export declare const ACP_RESULT_LIMIT: number;
export declare const ACP_CANCEL_GRACE_MS = 2000;
export declare const ACP_STARTUP_TIMEOUT_MS = 15000;
export declare const ACP_PENDING_INPUT_LIMIT = 64;
export declare const ACP_PENDING_INPUT_BYTES: number;
export declare const ACP_EVENT_QUEUE_BYTES: number;
export declare const ACP_CAPABILITIES: readonly ("cancel" | "streaming" | "follow-up" | "tool-events")[];
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
    readonly capabilities: readonly ("cancel" | "streaming" | "follow-up" | "tool-events")[];
    constructor(options?: AcpDriverOptions);
    start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle>;
    attach(request: RemoteRunAttachParams, context: RemoteDriverContext): Promise<RemoteRunHandle>;
    list(context: RemoteDriverContext): Promise<readonly RemoteRunSnapshot[]>;
    close(): Promise<void>;
}
export {};

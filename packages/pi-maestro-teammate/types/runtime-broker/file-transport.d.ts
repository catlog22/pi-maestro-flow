import type { MailboxAuthority } from "../extension/mailbox/router.ts";
import type { RuntimeTransport, RuntimeTransportDeliveryState, RuntimeTransportDispatch, RuntimeTransportEnqueueRequest, RuntimeTransportEnqueueResult } from "./transport.ts";
export interface FileRuntimeTransportOptions {
    rootDir: string;
    authority: MailboxAuthority;
    recipientCorrelationId: string;
    workspaceId: string;
    teamId: string;
    ownerId: string;
    pollMs?: number;
    now?: () => number;
}
/** File-backed compatibility adapter. It does not alter mailbox production wiring. */
export declare class FileRuntimeTransport implements RuntimeTransport {
    #private;
    readonly driver: "file";
    constructor(options: FileRuntimeTransportOptions);
    enqueue(request: RuntimeTransportEnqueueRequest): Promise<RuntimeTransportEnqueueResult>;
    consume(dispatch: RuntimeTransportDispatch): Promise<void>;
    acknowledge(messageId: string): Promise<boolean>;
    state(messageId: string): Promise<RuntimeTransportDeliveryState | undefined>;
    hasPendingMessages(): Promise<boolean>;
    stop(): Promise<void>;
}
export declare function createFileRuntimeTransport(options: FileRuntimeTransportOptions): FileRuntimeTransport;

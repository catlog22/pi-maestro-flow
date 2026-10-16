import { type WindowThreadEntry, type WindowThreadStore } from "../sessions/session-core.ts";
import { finalizeWorkspacePeerResponse, readWorkspacePeerResponse, readWorkspacePeerResponseForOwner, type WorkspacePeerIdentity, type WorkspacePeerCommand } from "../sessions/workspace-peer-core.ts";
export interface WorkspaceRootDeliveryAuthority {
    /** Exact root session + workspace publisher generation, not elapsed time. */
    key: string;
    sessionId: string | null;
    identity: WorkspacePeerIdentity;
}
export declare function workspaceRootMessageMode(entry: WindowThreadEntry): "steer" | "follow_up";
/** One host queue admission, actual custom-message consumption, and durable receipts. */
export declare class WorkspaceRootDelivery {
    #private;
    private readonly dependencies;
    constructor(dependencies: {
        thread: () => WindowThreadStore | undefined;
        authority: () => WorkspaceRootDeliveryAuthority | undefined;
        onError: (error: unknown) => void;
        sessionEntries?: () => readonly unknown[];
        readResponse?: typeof readWorkspacePeerResponse;
        readFinalizedResponse?: typeof readWorkspacePeerResponseForOwner;
        finalize?: typeof finalizeWorkspacePeerResponse;
    });
    /** A real workspace/session replacement loses the host queue; a generation/reload alone does not. */
    bindSession(workspaceId: string, sessionId: string | null): void;
    wasAccepted(entry: WindowThreadEntry): boolean;
    /** Caller decides whether this is a new command or an actual recovery. No age-based redrive. */
    enqueue(entry: WindowThreadEntry, send: (token: string, mode: "steer" | "follow_up") => boolean): boolean;
    /** Missing response after a crash: authorize only exact, already accepted root work. */
    recoveryReceipt(command: WorkspacePeerCommand): {
        effectiveAction: "steer" | "follow_up";
        deliveryStage: "queued" | "injected" | "replied";
    } | undefined;
    consume(message: {
        role: string;
        customType?: string;
        details?: unknown;
    }): void;
    reconcile(): Promise<void>;
}

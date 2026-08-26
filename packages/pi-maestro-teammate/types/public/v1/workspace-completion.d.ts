export declare const WORKSPACE_COMPLETION_VERSION: 1;
export declare const WORKSPACE_MAIN_SESSION_MARKER: "window-main-session";
export declare const WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE: "workspace-window-terminal-result";
export type WorkspaceWindowTerminalOutcome = "completed" | "failed" | "cancelled" | "no-result";
export interface WorkspaceWindowTerminalResult {
    version: typeof WORKSPACE_COMPLETION_VERSION;
    type: typeof WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE;
    requestMessageId: string;
    outcome: WorkspaceWindowTerminalOutcome;
    settledAt: number;
    finalText?: string;
    error?: string;
}
export interface WorkspaceWindowTerminalResultDraft {
    outcome: WorkspaceWindowTerminalOutcome;
    finalText?: string;
    error?: string;
}
/** Stable caller-facing identity for one Monitor-owned workspace request. */
export interface WorkspaceWindowCompletionHandle {
    messageId: string;
    requestMessageId: string;
    correlationId: string;
    dispatchId: string;
    deliveryGroupId: string;
    reservationId: string;
    publicationId: string;
    resource: `agent://${string}`;
}
export interface WorkspaceCompletionOwnerBinding {
    workspaceId: string;
    ownerId: string;
    ownerNonce: string;
}
/** Owner-fenced handle used to correlate a child request with its canonical terminal resource. */
export interface WorkspaceCompletionCorrelation extends WorkspaceWindowCompletionHandle {
    owner: WorkspaceCompletionOwnerBinding;
}
export declare function workspaceWindowTerminalResultMessageId(requestMessageId: string): string;
export declare function workspaceWindowTerminalPublicationId(requestMessageId: string): string;
export declare function workspaceWindowTerminalReservationId(requestMessageId: string): string;
export declare function workspaceWindowCompletionHandle(requestMessageId: string): WorkspaceWindowCompletionHandle;
export declare function bindWorkspaceCompletionHandle(requestMessageId: string, owner: WorkspaceCompletionOwnerBinding): WorkspaceCompletionCorrelation;
export declare function validateWorkspaceCompletionCorrelation(value: unknown): WorkspaceCompletionCorrelation | undefined;
export declare function createWorkspaceWindowTerminalResult(input: {
    requestMessageId: string;
    outcome: WorkspaceWindowTerminalOutcome;
    settledAt?: number;
    finalText?: string;
    error?: string;
}): WorkspaceWindowTerminalResult;
export declare function validateWorkspaceWindowTerminalResult(value: unknown): WorkspaceWindowTerminalResult | undefined;
export declare function encodeWorkspaceWindowTerminalResult(result: WorkspaceWindowTerminalResult): string;
export declare function decodeWorkspaceWindowTerminalResult(text: string): WorkspaceWindowTerminalResult;

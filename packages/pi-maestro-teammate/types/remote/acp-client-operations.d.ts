import { type CreateTerminalRequest, type CreateTerminalResponse, type KillTerminalRequest, type ReadTextFileRequest, type ReadTextFileResponse, type ReleaseTerminalRequest, type RequestPermissionRequest, type RequestPermissionResponse, type TerminalOutputRequest, type TerminalOutputResponse, type WaitForTerminalExitRequest, type WaitForTerminalExitResponse, type WriteTextFileRequest } from "@agentclientprotocol/sdk";
import type { RemoteAcpPolicy } from "./types.ts";
export interface AcpClientOperationsOptions {
    targetRoot: string;
    policy?: RemoteAcpPolicy;
    signal: AbortSignal;
    isCancelling: () => boolean;
    sessionId: () => string | undefined;
    /** Deterministic test hook invoked after the parent handle is captured. */
    beforeFileOpen?: (operation: "read" | "write") => Promise<void>;
}
/** Implements only explicitly configured ACP client operations on the bridge host. */
export declare class AcpClientOperations {
    #private;
    constructor(options: AcpClientOperationsOptions);
    get capabilities(): {
        fs?: {
            readTextFile?: boolean;
            writeTextFile?: boolean;
        };
        terminal?: boolean;
    };
    requestPermission(request: RequestPermissionRequest, signal: AbortSignal): RequestPermissionResponse;
    readTextFile(request: ReadTextFileRequest, signal: AbortSignal): Promise<ReadTextFileResponse>;
    writeTextFile(request: WriteTextFileRequest, signal: AbortSignal): Promise<Record<string, never>>;
    createTerminal(request: CreateTerminalRequest, signal: AbortSignal): Promise<CreateTerminalResponse>;
    terminalOutput(request: TerminalOutputRequest): TerminalOutputResponse;
    waitForTerminalExit(request: WaitForTerminalExitRequest, signal: AbortSignal): Promise<WaitForTerminalExitResponse>;
    killTerminal(request: KillTerminalRequest): Record<string, never>;
    releaseTerminal(request: ReleaseTerminalRequest): Record<string, never>;
    close(): void;
}

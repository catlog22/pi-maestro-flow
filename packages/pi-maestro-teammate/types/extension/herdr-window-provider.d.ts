import { type ExecFileException } from "node:child_process";
import type { Duplex } from "node:stream";
export declare const HERDR_VERSION = "0.8.2";
export declare const HERDR_PROTOCOL = 20;
export declare const HERDR_METADATA_SOURCE = "pi-maestro-teammate";
export declare const HERDR_RESOURCE_TOKEN = "pi_maestro_resource";
type JsonRecord = Record<string, unknown>;
export type HerdrProviderErrorCode = "binary_missing" | "status_probe_failed" | "status_timeout" | "status_too_large" | "malformed_status" | "server_down" | "version_mismatch" | "protocol_mismatch" | "incompatible" | "aborted" | "timeout" | "response_too_large" | "transport" | "malformed_response" | "response_boundary" | "verification_failed" | "authority_lost" | "rollback_failed";
export declare class HerdrProviderError extends Error {
    readonly code: HerdrProviderErrorCode;
    constructor(code: HerdrProviderErrorCode, message: string, options?: ErrorOptions);
}
export declare class HerdrRollbackError extends HerdrProviderError {
    readonly capture: HerdrWindowCapture;
    constructor(capture: HerdrWindowCapture, options?: ErrorOptions);
}
/** A server error with a deliberately redacted message. Request parameters and server text are never retained. */
export declare class HerdrApiError extends Error {
    readonly code: string;
    constructor(code: string);
}
export interface HerdrStatus {
    running: true;
    version: string;
    protocol: number;
    socket: string;
    session: string;
    compatible: true;
}
interface ExecOptions {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: true;
}
export type HerdrExecFile = (file: string, args: readonly string[], options: ExecOptions, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => void;
export interface HerdrStatusProbeOptions {
    execFile?: HerdrExecFile;
    timeoutMs?: number;
    maxBytes?: number;
    binary?: string;
}
/** Probes only an already-running named local session. It never starts Herdr and has no SSH path. */
export declare function probeHerdrStatus(session: string, options?: HerdrStatusProbeOptions): Promise<HerdrStatus>;
export type HerdrSocketFactory = (socketPath: string) => Duplex;
export interface HerdrRequestClientOptions {
    connect?: HerdrSocketFactory;
    timeoutMs?: number;
    maxResponseBytes?: number;
    idFactory?: () => string;
}
export interface HerdrWorkspaceInfo {
    workspaceId: string;
    activeTabId: string;
    focused: boolean;
    tokens: Readonly<Record<string, string>>;
}
export interface HerdrPaneInfo {
    workspaceId: string;
    tabId: string;
    paneId: string;
    terminalId: string;
    focused: boolean;
    agent: string | null;
    tokens: Readonly<Record<string, string>>;
}
export interface HerdrAgentInfo {
    workspaceId: string;
    tabId: string;
    paneId: string;
    terminalId: string;
    name: string | null;
    agent: string | null;
}
export interface HerdrWorkspaceCreated {
    workspace: HerdrWorkspaceInfo;
    tabId: string;
    rootPane: HerdrPaneInfo;
}
export interface HerdrWindowClient {
    createWorkspace(input: {
        cwd: string;
        label: string;
        env: Readonly<Record<string, string>>;
    }, signal?: AbortSignal): Promise<HerdrWorkspaceCreated>;
    getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<HerdrWorkspaceInfo>;
    getPane(paneId: string, signal?: AbortSignal): Promise<HerdrPaneInfo>;
    reportWorkspaceMetadata(workspaceId: string, resourceNonce: string, signal?: AbortSignal): Promise<void>;
    reportPaneMetadata(paneId: string, resourceNonce: string, signal?: AbortSignal): Promise<void>;
    startAgent(input: {
        paneId: string;
        name: string;
        args: readonly string[];
        timeoutMs?: number;
    }, signal?: AbortSignal): Promise<HerdrAgentInfo>;
    closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void>;
}
export declare class HerdrRequestClient implements HerdrWindowClient {
    #private;
    constructor(socketPath: string, options?: HerdrRequestClientOptions);
    request(method: string, params: JsonRecord, signal?: AbortSignal): Promise<JsonRecord>;
    createWorkspace(input: {
        cwd: string;
        label: string;
        env: Readonly<Record<string, string>>;
    }, signal?: AbortSignal): Promise<HerdrWorkspaceCreated>;
    getWorkspace(workspaceId: string, signal?: AbortSignal): Promise<HerdrWorkspaceInfo>;
    getPane(paneId: string, signal?: AbortSignal): Promise<HerdrPaneInfo>;
    reportWorkspaceMetadata(workspaceId: string, resourceNonce: string, signal?: AbortSignal): Promise<void>;
    reportPaneMetadata(paneId: string, resourceNonce: string, signal?: AbortSignal): Promise<void>;
    startAgent(input: {
        paneId: string;
        name: string;
        args: readonly string[];
        timeoutMs?: number;
    }, signal?: AbortSignal): Promise<HerdrAgentInfo>;
    closeWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void>;
}
export interface HerdrWindowCapture {
    herdrSession: string;
    herdrSocket: string;
    herdrVersion: string;
    herdrProtocol: number;
    workspaceId: string;
    tabId: string;
    paneId: string;
    terminalId: string;
    agentName: string;
    sessionName: string;
    resourceNonce: string;
}
export interface CreateHerdrWindowInput {
    herdrSession: string;
    cwd: string;
    agentName: string;
    sessionName: string;
    piArgs: readonly string[];
    /** Generation/root fence. Checked before and after every await until the capture is returned. */
    authorize: () => boolean;
    signal?: AbortSignal;
}
export interface HerdrWindowProviderDependencies {
    statusProbe?: (session: string) => Promise<HerdrStatus>;
    clientFactory?: (status: HerdrStatus) => HerdrWindowClient;
    nonceFactory?: () => string;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    busyAttempts?: number;
    busyDelayMs?: number;
}
export interface CreateHerdrWindowResult {
    capture: HerdrWindowCapture;
}
export declare function createHerdrWindow(input: CreateHerdrWindowInput, dependencies?: HerdrWindowProviderDependencies): Promise<CreateHerdrWindowResult>;
export interface CloseHerdrWindowOptions {
    authorize: () => boolean;
    signal?: AbortSignal;
    onCloseStarted?: () => void;
}
export interface CloseHerdrWindowResult {
    status: "closed" | "already-exited";
    closed: boolean;
}
/** Closes only workspace.close after re-proving the nonce and every captured Herdr ID. */
export declare function closeHerdrWindowExact(capture: HerdrWindowCapture, options: CloseHerdrWindowOptions, dependencies?: HerdrWindowProviderDependencies): Promise<CloseHerdrWindowResult>;
export {};

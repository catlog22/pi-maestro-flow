/** remote/2 JSON-RPC 2.0 envelopes carried as bounded NDJSON records. */
import type { RemoteCommandArgv, RemoteDriverId, RemoteInputMode, RemoteProtocolVersion, RemoteRunCapture, RemoteRunEvent, RemoteRunIdentity, RemoteRunSnapshot, RemoteStatus, RemoteWorkerHeartbeat, RemoteWorkerIdentity } from "./types.ts";
import { REMOTE_PROTOCOL_VERSION } from "./types.ts";
export declare const REMOTE_JSONRPC_VERSION: "2.0";
export declare const REMOTE_MAX_LINE_BYTES: number;
export declare const REMOTE_MAX_ID_LENGTH = 128;
export declare const REMOTE_MAX_OBJECTIVE_BYTES: number;
export type RemoteJsonRpcId = string | number;
export type RemoteRequestMethod = "remote/initialize" | "run/start" | "run/attach" | "run/input" | "run/cancel" | "run/list";
export type RemoteNotificationMethod = RemoteRunEvent["type"] | RemoteWorkerHeartbeat["type"];
export interface RemoteJsonRpcRequest<Method extends string = string, Params = unknown> {
    jsonrpc: typeof REMOTE_JSONRPC_VERSION;
    id: RemoteJsonRpcId;
    method: Method;
    params: Params;
}
export interface RemoteJsonRpcNotification<Method extends string = string, Params = unknown> {
    jsonrpc: typeof REMOTE_JSONRPC_VERSION;
    method: Method;
    params: Params;
}
export interface RemoteJsonRpcSuccess<Result = unknown> {
    jsonrpc: typeof REMOTE_JSONRPC_VERSION;
    id: RemoteJsonRpcId;
    result: Result;
}
export interface RemoteJsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}
export interface RemoteJsonRpcFailure {
    jsonrpc: typeof REMOTE_JSONRPC_VERSION;
    id: RemoteJsonRpcId | null;
    error: RemoteJsonRpcErrorObject;
}
export type RemoteJsonRpcEnvelope = RemoteJsonRpcRequest | RemoteJsonRpcNotification | RemoteJsonRpcSuccess | RemoteJsonRpcFailure;
export interface RemoteInitializeParams {
    commandId: string;
    protocolVersions: readonly RemoteProtocolVersion[];
    monitorOwnerNonce: string;
}
export interface RemoteInitializeResult extends RemoteWorkerIdentity {
    protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
    concurrency: number;
    activeRuns: number;
    status: Extract<RemoteStatus, "ready" | "running" | "waiting">;
}
export interface RemoteRunStartParams {
    commandId: string;
    targetId: string;
    monitorOwnerNonce: string;
    name: string;
    objective: string;
    cwd: string;
    driver: RemoteDriverId;
    command: RemoteCommandArgv;
    outputSchema?: unknown;
}
export interface RemoteRunStartResult extends RemoteRunIdentity {
    status: Extract<RemoteStatus, "running" | "waiting">;
    firstSequence: number;
}
export interface RemoteRunAttachParams {
    commandId: string;
    runId: string;
    generation: number;
    monitorOwnerNonce: string;
    lastSequence: number;
}
export interface RemoteRunAttachResult extends RemoteRunIdentity {
    status: RemoteStatus;
    replayFromSequence: number;
    lastSequence: number;
}
export interface RemoteRunInputParams {
    commandId: string;
    runId: string;
    generation: number;
    monitorOwnerNonce: string;
    mode: RemoteInputMode;
    message: string;
}
export interface RemoteRunInputResult {
    accepted: boolean;
    effectiveMode: RemoteInputMode;
    receipt: "queued" | "accepted" | "injected";
}
export interface RemoteRunCancelParams {
    commandId: string;
    runId: string;
    generation: number;
    monitorOwnerNonce: string;
    reason?: string;
}
export interface RemoteRunCancelResult {
    accepted: boolean;
    status: RemoteStatus;
}
export interface RemoteRunListParams {
    commandId: string;
    monitorOwnerNonce: string;
}
export interface RemoteRunListResult {
    runs: readonly RemoteRunSnapshot[];
}
export interface RemoteRequestParamsByMethod {
    "remote/initialize": RemoteInitializeParams;
    "run/start": RemoteRunStartParams;
    "run/attach": RemoteRunAttachParams;
    "run/input": RemoteRunInputParams;
    "run/cancel": RemoteRunCancelParams;
    "run/list": RemoteRunListParams;
}
export interface RemoteResultByMethod {
    "remote/initialize": RemoteInitializeResult;
    "run/start": RemoteRunStartResult;
    "run/attach": RemoteRunAttachResult;
    "run/input": RemoteRunInputResult;
    "run/cancel": RemoteRunCancelResult;
    "run/list": RemoteRunListResult;
}
export type RemoteTypedRequest<Method extends RemoteRequestMethod> = RemoteJsonRpcRequest<Method, RemoteRequestParamsByMethod[Method]>;
export type RemoteProtocolNotification = RemoteJsonRpcNotification<"run/state", Extract<RemoteRunEvent, {
    type: "run/state";
}>> | RemoteJsonRpcNotification<"run/event", Extract<RemoteRunEvent, {
    type: "run/event";
}>> | RemoteJsonRpcNotification<"run/result", Extract<RemoteRunEvent, {
    type: "run/result";
}>> | RemoteJsonRpcNotification<"worker/heartbeat", RemoteWorkerHeartbeat>;
export type RemoteProtocolRequest = {
    [Method in RemoteRequestMethod]: RemoteTypedRequest<Method>;
}[RemoteRequestMethod];
export declare function parseRemoteEnvelopeLine(line: string): RemoteJsonRpcEnvelope;
export declare function encodeRemoteEnvelope(envelope: RemoteJsonRpcEnvelope): string;
export declare function createRemoteRequest<Method extends RemoteRequestMethod>(id: RemoteJsonRpcId, method: Method, params: RemoteRequestParamsByMethod[Method]): RemoteTypedRequest<Method>;
export declare function captureMatches(left: RemoteRunCapture, right: RemoteRunCapture): boolean;

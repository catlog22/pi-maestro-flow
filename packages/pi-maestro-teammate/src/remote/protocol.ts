/** remote/2 JSON-RPC 2.0 envelopes carried as bounded NDJSON records. */

import type {
  RemoteCommandArgv,
  RemoteDriverId,
  RemoteInputMode,
  RemoteProtocolVersion,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunIdentity,
  RemoteRunSnapshot,
  RemoteStatus,
  RemoteWorkerHeartbeat,
  RemoteWorkerIdentity,
  RemoteWorkspaceConfig,
} from "./types.ts";
import { REMOTE_PROTOCOL_VERSION } from "./types.ts";
import type {
  RemoteWindowListParams,
  RemoteWindowListResult,
  RemoteWindowMessageNotification,
  RemoteWindowObserveParams,
  RemoteWindowObserveResult,
  RemoteWindowReceiptParams,
  RemoteWindowReceiptResult,
  RemoteWindowSendParams,
  RemoteWindowSendResult,
  RemoteWindowStateNotification,
} from "./window-protocol.ts";

export * from "./window-protocol.ts";

export const REMOTE_JSONRPC_VERSION = "2.0" as const;
export const REMOTE_MAX_LINE_BYTES = 1024 * 1024;
export const REMOTE_MAX_ID_LENGTH = 128;
export const REMOTE_MAX_OBJECTIVE_BYTES = 256 * 1024;

export type RemoteJsonRpcId = string | number;
export type RemoteRequestMethod =
  | "remote/initialize"
  | "run/start"
  | "run/attach"
  | "run/input"
  | "run/cancel"
  | "run/list"
  | "window/list"
  | "window/observe"
  | "window/send"
  | "window/receipt";
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

export type RemoteJsonRpcEnvelope =
  | RemoteJsonRpcRequest
  | RemoteJsonRpcNotification
  | RemoteJsonRpcSuccess
  | RemoteJsonRpcFailure;

export interface RemoteWindowBridgeAdvertisement {
  pluginId: string;
  pluginVersion: string;
  workspacePeerVersions: readonly number[];
  relayVersions: readonly number[];
  runtimeVersions: readonly number[];
}

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
  /** Optional so upgraded clients and daemons remain compatible with run-only peers. */
  windowBridge?: RemoteWindowBridgeAdvertisement;
}

export type RemoteWindowBridgeDiagnosticCode =
  | "host-unreachable"
  | "daemon-incompatible"
  | "plugin-missing"
  | "protocol-too-old"
  | "no-active-window";

export type RemoteWindowBridgeNegotiation =
  | {
    status: "supported";
    advertisement: RemoteWindowBridgeAdvertisement;
    windowProtocolVersion: number;
  }
  | {
    status: "unsupported" | "upgrade-required";
    code: RemoteWindowBridgeDiagnosticCode;
    message: string;
  };

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
  "window/list": RemoteWindowListParams;
  "window/observe": RemoteWindowObserveParams;
  "window/send": RemoteWindowSendParams;
  "window/receipt": RemoteWindowReceiptParams;
}

export interface RemoteResultByMethod {
  "remote/initialize": RemoteInitializeResult;
  "run/start": RemoteRunStartResult;
  "run/attach": RemoteRunAttachResult;
  "run/input": RemoteRunInputResult;
  "run/cancel": RemoteRunCancelResult;
  "run/list": RemoteRunListResult;
  "window/list": RemoteWindowListResult;
  "window/observe": RemoteWindowObserveResult;
  "window/send": RemoteWindowSendResult;
  "window/receipt": RemoteWindowReceiptResult;
}

export type RemoteTypedRequest<Method extends RemoteRequestMethod> = RemoteJsonRpcRequest<
  Method,
  RemoteRequestParamsByMethod[Method]
>;

export type RemoteProtocolNotification =
  | RemoteJsonRpcNotification<"run/state", Extract<RemoteRunEvent, { type: "run/state" }>>
  | RemoteJsonRpcNotification<"run/event", Extract<RemoteRunEvent, { type: "run/event" }>>
  | RemoteJsonRpcNotification<"run/result", Extract<RemoteRunEvent, { type: "run/result" }>>
  | RemoteJsonRpcNotification<"window/state", RemoteWindowStateNotification>
  | RemoteJsonRpcNotification<"window/message", RemoteWindowMessageNotification>
  | RemoteJsonRpcNotification<"worker/heartbeat", RemoteWorkerHeartbeat>;

export type RemoteProtocolRequest = {
  [Method in RemoteRequestMethod]: RemoteTypedRequest<Method>;
}[RemoteRequestMethod];

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeBridgeVersionList(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`Invalid remote window bridge ${label}`);
  const versions: number[] = [];
  for (const version of value) {
    if (!Number.isInteger(version) || version < 1 || version > 65_535 || versions.includes(version)) {
      throw new Error(`Invalid remote window bridge ${label}`);
    }
    versions.push(version);
  }
  return Object.freeze(versions.sort((left, right) => left - right));
}

/** Strictly normalizes the daemon's optional, untrusted window-bridge advertisement. */
export function normalizeRemoteWindowBridgeAdvertisement(value: unknown): RemoteWindowBridgeAdvertisement {
  if (!plainObject(value)) throw new Error("Invalid remote window bridge advertisement");
  const allowed = new Set([
    "pluginId",
    "pluginVersion",
    "workspacePeerVersions",
    "relayVersions",
    "runtimeVersions",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Invalid remote window bridge advertisement");
  }
  if (typeof value.pluginId !== "string"
    || !value.pluginId
    || value.pluginId.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.pluginId)
    || typeof value.pluginVersion !== "string"
    || !value.pluginVersion
    || value.pluginVersion.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.pluginVersion)) {
    throw new Error("Invalid remote window bridge plugin identity");
  }
  return Object.freeze({
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    workspacePeerVersions: normalizeBridgeVersionList(value.workspacePeerVersions, "workspacePeerVersions"),
    relayVersions: normalizeBridgeVersionList(value.relayVersions, "relayVersions"),
    runtimeVersions: normalizeBridgeVersionList(value.runtimeVersions, "runtimeVersions"),
  });
}

/**
 * Negotiates only the optional window surface. A missing/old bridge never
 * invalidates the already-negotiated remote run protocol.
 */
export function negotiateRemoteWindowBridge(
  workspace: Pick<RemoteWorkspaceConfig, "requiredPlugin" | "minimumWindowProtocol">,
  result: RemoteInitializeResult,
  activeWindowCount?: number,
): RemoteWindowBridgeNegotiation {
  if (result.windowBridge === undefined) {
    return {
      status: "unsupported",
      code: "plugin-missing",
      message: `Remote daemon did not advertise required plugin ${workspace.requiredPlugin}`,
    };
  }
  let advertisement: RemoteWindowBridgeAdvertisement;
  try {
    advertisement = normalizeRemoteWindowBridgeAdvertisement(result.windowBridge);
  } catch (error) {
    return {
      status: "upgrade-required",
      code: "daemon-incompatible",
      message: error instanceof Error ? error.message : "Invalid remote window bridge advertisement",
    };
  }
  if (advertisement.pluginId !== workspace.requiredPlugin) {
    return {
      status: "unsupported",
      code: "plugin-missing",
      message: `Remote daemon advertised ${advertisement.pluginId}, not required plugin ${workspace.requiredPlugin}`,
    };
  }
  const windowProtocolVersion = [...advertisement.workspacePeerVersions]
    .filter((version) => version >= workspace.minimumWindowProtocol)
    .sort((left, right) => right - left)[0];
  if (windowProtocolVersion === undefined) {
    return {
      status: "upgrade-required",
      code: "protocol-too-old",
      message: `Remote window protocol is older than required version ${workspace.minimumWindowProtocol}`,
    };
  }
  if (activeWindowCount !== undefined
    && (!Number.isSafeInteger(activeWindowCount) || activeWindowCount < 0)) {
    return {
      status: "upgrade-required",
      code: "daemon-incompatible",
      message: "Remote daemon returned an invalid active window count",
    };
  }
  if (activeWindowCount === 0) {
    return {
      status: "unsupported",
      code: "no-active-window",
      message: "Remote workspace has no active compatible teammate window",
    };
  }
  return { status: "supported", advertisement, windowProtocolVersion };
}

function validId(value: unknown, nullable = false): value is RemoteJsonRpcId | null {
  if (nullable && value === null) return true;
  if (typeof value === "number") return Number.isSafeInteger(value);
  return typeof value === "string" && value.length > 0 && value.length <= REMOTE_MAX_ID_LENGTH;
}

function validateEnvelope(value: unknown): RemoteJsonRpcEnvelope {
  if (!plainObject(value) || value.jsonrpc !== REMOTE_JSONRPC_VERSION) {
    throw new Error("Invalid remote JSON-RPC 2.0 envelope");
  }
  if (typeof value.method === "string") {
    if (value.method.length === 0 || value.method.length > REMOTE_MAX_ID_LENGTH) {
      throw new Error("Invalid remote JSON-RPC method");
    }
    if (value.params !== undefined && !plainObject(value.params) && !Array.isArray(value.params)) {
      throw new Error("Invalid remote JSON-RPC params");
    }
    if (value.id === undefined) return value as unknown as RemoteJsonRpcNotification;
    if (!validId(value.id)) throw new Error("Invalid remote JSON-RPC request id");
    return value as unknown as RemoteJsonRpcRequest;
  }
  if (!("id" in value) || !validId(value.id, true)) throw new Error("Invalid remote JSON-RPC response id");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) throw new Error("Remote JSON-RPC response must contain exactly one of result or error");
  if (hasError) {
    if (!plainObject(value.error)
      || typeof value.error.code !== "number"
      || !Number.isInteger(value.error.code)
      || typeof value.error.message !== "string") {
      throw new Error("Invalid remote JSON-RPC error");
    }
    return value as unknown as RemoteJsonRpcFailure;
  }
  if (value.id === null) throw new Error("Successful remote JSON-RPC responses require a non-null id");
  return value as unknown as RemoteJsonRpcSuccess;
}

export function parseRemoteEnvelopeLine(line: string): RemoteJsonRpcEnvelope {
  let record = line;
  if (record.endsWith("\n")) record = record.slice(0, -1);
  if (record.endsWith("\r")) record = record.slice(0, -1);
  if (!record || record.includes("\n") || record.includes("\r")) {
    throw new Error("Remote protocol records must contain exactly one NDJSON line");
  }
  const bytes = Buffer.byteLength(record, "utf8");
  if (bytes > REMOTE_MAX_LINE_BYTES) {
    throw new Error(`Remote protocol record exceeds ${REMOTE_MAX_LINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch (error) {
    throw new Error("Invalid JSON in remote protocol record", { cause: error });
  }
  return validateEnvelope(parsed);
}

export function encodeRemoteEnvelope(envelope: RemoteJsonRpcEnvelope): string {
  validateEnvelope(envelope);
  const line = JSON.stringify(envelope);
  if (Buffer.byteLength(line, "utf8") > REMOTE_MAX_LINE_BYTES) {
    throw new Error(`Remote protocol record exceeds ${REMOTE_MAX_LINE_BYTES} bytes`);
  }
  return `${line}\n`;
}

export function createRemoteRequest<Method extends RemoteRequestMethod>(
  id: RemoteJsonRpcId,
  method: Method,
  params: RemoteRequestParamsByMethod[Method],
): RemoteTypedRequest<Method> {
  if (!validId(id)) throw new Error("Invalid remote JSON-RPC request id");
  return { jsonrpc: REMOTE_JSONRPC_VERSION, id, method, params };
}

export function captureMatches(left: RemoteRunCapture, right: RemoteRunCapture): boolean {
  return left.workerId === right.workerId
    && left.instanceNonce === right.instanceNonce
    && left.runId === right.runId
    && left.generation === right.generation
    && left.monitorOwnerNonce === right.monitorOwnerNonce
    && left.targetId === right.targetId;
}

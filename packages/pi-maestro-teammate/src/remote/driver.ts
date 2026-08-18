/** Driver-neutral boundaries implemented by bridge, SSH, Pi RPC, and ACP layers. */

import type {
  RemoteInitializeParams,
  RemoteInitializeResult,
  RemoteProtocolNotification,
  RemoteRequestMethod,
  RemoteRequestParamsByMethod,
  RemoteResultByMethod,
  RemoteRunAttachParams,
  RemoteRunAttachResult,
  RemoteRunCancelParams,
  RemoteRunCancelResult,
  RemoteRunInputParams,
  RemoteRunInputResult,
  RemoteRunListResult,
  RemoteRunStartParams,
  RemoteRunStartResult,
} from "./protocol.ts";
import type {
  RemoteDriverId,
  RemoteRunCapture,
  RemoteRunEvent,
  RemoteRunSnapshot,
  RemoteStatus,
  ResolvedRemoteTarget,
  RemoteWorkerIdentity,
} from "./types.ts";

export interface RemoteDriverContext extends RemoteWorkerIdentity {
  target: ResolvedRemoteTarget;
  signal: AbortSignal;
}

export interface RemoteRunHandle {
  readonly capture: RemoteRunCapture;
  snapshot(): RemoteRunSnapshot;
  events(): AsyncIterable<RemoteRunEvent>;
  input(request: RemoteRunInputParams): Promise<RemoteRunInputResult>;
  cancel(request: RemoteRunCancelParams): Promise<RemoteRunCancelResult>;
  close(): Promise<void>;
}

export interface RemoteDriver {
  readonly id: RemoteDriverId;
  start(request: RemoteRunStartParams, context: RemoteDriverContext): Promise<RemoteRunHandle>;
  close(): Promise<void>;
}

export interface RemoteConnection {
  readonly status: RemoteStatus;
  readonly identity?: RemoteWorkerIdentity;
  initialize(params: RemoteInitializeParams): Promise<RemoteInitializeResult>;
  request<Method extends RemoteRequestMethod>(
    method: Method,
    params: RemoteRequestParamsByMethod[Method],
  ): Promise<RemoteResultByMethod[Method]>;
  start(params: RemoteRunStartParams): Promise<RemoteRunStartResult>;
  attach(params: RemoteRunAttachParams): Promise<RemoteRunAttachResult>;
  input(params: RemoteRunInputParams): Promise<RemoteRunInputResult>;
  cancel(params: RemoteRunCancelParams): Promise<RemoteRunCancelResult>;
  list(commandId: string, monitorOwnerNonce: string): Promise<RemoteRunListResult>;
  notifications(): AsyncIterable<RemoteProtocolNotification>;
  close(): Promise<void>;
}

export interface RemoteConnectionFactory {
  connect(target: ResolvedRemoteTarget, signal?: AbortSignal): Promise<RemoteConnection>;
}

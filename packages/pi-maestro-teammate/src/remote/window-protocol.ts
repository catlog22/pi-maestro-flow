import {
  WORKSPACE_PEER_COMMAND_PROTOCOL_VERSION,
  WORKSPACE_PEER_PLUGIN_ID,
  WORKSPACE_PEER_PROTOCOL_VERSION,
  validateWorkspaceOwnerSnapshot,
  type WorkspaceOwnerSnapshot,
  type WorkspacePeerCommandAction,
  type WorkspacePeerDeliveryStage,
  type WorkspacePeerMessageKind,
  type WorkspacePeerMessageSource,
} from "../sessions/workspace-peer-core.ts";

export const REMOTE_WINDOW_TRANSPORT_VERSION = 1 as const;
export const REMOTE_WINDOW_MAX_MESSAGE_BYTES = 64 * 1024;
export const REMOTE_WINDOW_MAX_RECEIPT_DETAIL_BYTES = 8 * 1024;

export const REMOTE_WINDOW_CAPABILITIES = [
  "observe",
  "steer",
  "follow_up",
  "receipt",
  "reply",
] as const;

export type RemoteWindowCapability = typeof REMOTE_WINDOW_CAPABILITIES[number];
export type RemoteWindowMode = WorkspacePeerCommandAction;
export type RemoteWindowReceiptStatus =
  | "queued"
  | "injected"
  | "replied"
  | "rejected"
  | "expired"
  | "unknown";

/** Complete immutable route fence for one externally-owned Pi root window. */
export interface RemoteWindowCapture {
  workspaceRef: string;
  authorityId: string;
  gatewayWorkerId: string;
  gatewayInstanceNonce: string;
  monitorOwnerNonce: string;
  workspaceId: string;
  ownerId: string;
  ownerNonce: string;
  generation: number;
  transportVersion: typeof REMOTE_WINDOW_TRANSPORT_VERSION;
  capabilities: readonly RemoteWindowCapability[];
  /** External Pi windows are never lifecycle-owned by the SSH Monitor. */
  cancel: false;
}

export interface RemoteWindowListing {
  capture: RemoteWindowCapture;
  sessionId?: string;
  sessionName?: string;
  status: "running" | "sleeping";
  agentCount: number;
  publishedAt: number;
  cancel: false;
}

export interface RemoteWindowReceipt {
  capture: RemoteWindowCapture;
  messageId: string;
  requestedMode: RemoteWindowMode;
  effectiveMode?: RemoteWindowMode;
  status: RemoteWindowReceiptStatus;
  updatedAt: number;
  expiresAt: number;
  relayId?: string;
  detail?: string;
}

export interface RemoteWindowListParams {
  commandId: string;
  monitorOwnerNonce: string;
  workspaceRef: string;
  authorityId: string;
  transportVersion: typeof REMOTE_WINDOW_TRANSPORT_VERSION;
}

export interface RemoteWindowListResult {
  windows: readonly RemoteWindowListing[];
}

export interface RemoteWindowObserveParams {
  commandId: string;
  monitorOwnerNonce: string;
  capture: RemoteWindowCapture;
}

export interface RemoteWindowObserveResult {
  capture: RemoteWindowCapture;
  owner: WorkspaceOwnerSnapshot;
  observedAt: number;
}

export interface RemoteWindowSendParams {
  commandId: string;
  monitorOwnerNonce: string;
  capture: RemoteWindowCapture;
  messageId: string;
  mode: RemoteWindowMode;
  message: string;
  source: WorkspacePeerMessageSource;
  messageKind: WorkspacePeerMessageKind;
  ttlMs?: number;
}

export interface RemoteWindowSendResult {
  receipt: RemoteWindowReceipt;
}

export interface RemoteWindowReceiptParams {
  commandId: string;
  monitorOwnerNonce: string;
  capture: RemoteWindowCapture;
  messageId: string;
  direction?: "outgoing" | "incoming";
  /** Acknowledges that an inbound relay message reached the local Monitor ledger. */
  acknowledge?: Extract<WorkspacePeerDeliveryStage, "injected">;
}

export interface RemoteWindowReceiptResult {
  receipt?: RemoteWindowReceipt;
  acknowledged?: boolean;
}

export interface RemoteWindowStateNotification {
  type: "window/state";
  capture: RemoteWindowCapture;
  state: "available" | "updated" | "unavailable";
  observedAt: number;
  receipt?: RemoteWindowReceipt;
  reason?: "owner-replaced" | "gateway-replaced" | "monitor-exited" | "expired";
}

export interface RemoteWindowMessageNotification {
  type: "window/message";
  capture: RemoteWindowCapture;
  relayId: string;
  messageId: string;
  inReplyTo: string;
  mode: RemoteWindowMode;
  source: WorkspacePeerMessageSource;
  messageKind: WorkspacePeerMessageKind;
  message: string;
  createdAt: number;
  receivedAt: number;
}

export type RemoteWindowNotification = RemoteWindowStateNotification | RemoteWindowMessageNotification;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const OWNER_ID = /^[a-f0-9]{32}$/;
const WORKSPACE_ID = /^[a-f0-9]{64}$/;
const CAPABILITY_SET = new Set<string>(REMOTE_WINDOW_CAPABILITIES);
const CAPABILITY_ORDER = new Map<string, number>(REMOTE_WINDOW_CAPABILITIES.map((value, index) => [value, index]));

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeMessageId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function safeText(value: unknown, maximumBytes: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeCapabilities(value: unknown): readonly RemoteWindowCapability[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > REMOTE_WINDOW_CAPABILITIES.length
    || value.some((candidate) => typeof candidate !== "string" || !CAPABILITY_SET.has(candidate))
    || new Set(value).size !== value.length) {
    throw new Error("Invalid remote window capabilities");
  }
  return Object.freeze(
    [...value]
      .sort((left, right) => CAPABILITY_ORDER.get(left)! - CAPABILITY_ORDER.get(right)!) as RemoteWindowCapability[],
  );
}

export function normalizeRemoteWindowCapture(
  value: unknown,
  expected: Partial<Omit<RemoteWindowCapture, "capabilities">> = {},
): RemoteWindowCapture {
  if (!record(value)
    || !knownKeys(value, [
      "workspaceRef", "authorityId", "gatewayWorkerId", "gatewayInstanceNonce",
      "monitorOwnerNonce", "workspaceId", "ownerId", "ownerNonce", "generation",
      "transportVersion", "capabilities", "cancel",
    ])
    || !safeId(value.workspaceRef)
    || !safeId(value.authorityId)
    || !safeId(value.gatewayWorkerId)
    || !safeId(value.gatewayInstanceNonce)
    || !safeId(value.monitorOwnerNonce)
    || typeof value.workspaceId !== "string" || !WORKSPACE_ID.test(value.workspaceId)
    || typeof value.ownerId !== "string" || !OWNER_ID.test(value.ownerId)
    || typeof value.ownerNonce !== "string" || !OWNER_ID.test(value.ownerNonce)
    || !safeInteger(value.generation, 1)
    || value.transportVersion !== REMOTE_WINDOW_TRANSPORT_VERSION
    || value.cancel !== false) {
    throw new Error("Invalid remote window capture");
  }
  const capture: RemoteWindowCapture = {
    workspaceRef: value.workspaceRef,
    authorityId: value.authorityId,
    gatewayWorkerId: value.gatewayWorkerId,
    gatewayInstanceNonce: value.gatewayInstanceNonce,
    monitorOwnerNonce: value.monitorOwnerNonce,
    workspaceId: value.workspaceId,
    ownerId: value.ownerId,
    ownerNonce: value.ownerNonce,
    generation: value.generation,
    transportVersion: REMOTE_WINDOW_TRANSPORT_VERSION,
    capabilities: normalizeCapabilities(value.capabilities),
    cancel: false,
  };
  for (const [key, candidate] of Object.entries(expected)) {
    if (candidate !== undefined && capture[key as keyof RemoteWindowCapture] !== candidate) {
      throw new Error(`Remote window capture ${key} fence changed`);
    }
  }
  return Object.freeze(capture);
}

export function remoteWindowCaptureMatches(left: RemoteWindowCapture, right: RemoteWindowCapture): boolean {
  return left.workspaceRef === right.workspaceRef
    && left.authorityId === right.authorityId
    && left.gatewayWorkerId === right.gatewayWorkerId
    && left.gatewayInstanceNonce === right.gatewayInstanceNonce
    && left.monitorOwnerNonce === right.monitorOwnerNonce
    && left.workspaceId === right.workspaceId
    && left.ownerId === right.ownerId
    && left.ownerNonce === right.ownerNonce
    && left.generation === right.generation
    && left.transportVersion === right.transportVersion
    && left.cancel === false
    && left.capabilities.length === right.capabilities.length
    && left.capabilities.every((capability, index) => capability === right.capabilities[index]);
}

export function normalizeRemoteWindowListing(value: unknown): RemoteWindowListing {
  if (!record(value)
    || !knownKeys(value, ["capture", "sessionId", "sessionName", "status", "agentCount", "publishedAt", "cancel"])
    || (value.sessionId !== undefined && !safeText(value.sessionId, 256))
    || (value.sessionName !== undefined && !safeText(value.sessionName, 256))
    || (value.status !== "running" && value.status !== "sleeping")
    || !safeInteger(value.agentCount)
    || !safeInteger(value.publishedAt)
    || value.cancel !== false) throw new Error("Invalid remote window listing");
  return Object.freeze({
    capture: normalizeRemoteWindowCapture(value.capture),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.sessionName === undefined ? {} : { sessionName: value.sessionName }),
    status: value.status,
    agentCount: value.agentCount,
    publishedAt: value.publishedAt,
    cancel: false,
  });
}

export function normalizeRemoteWindowListParams(value: unknown): RemoteWindowListParams {
  if (!record(value)
    || !knownKeys(value, ["commandId", "monitorOwnerNonce", "workspaceRef", "authorityId", "transportVersion"])
    || !safeId(value.commandId)
    || !safeId(value.monitorOwnerNonce)
    || !safeId(value.workspaceRef)
    || !safeId(value.authorityId)
    || value.transportVersion !== REMOTE_WINDOW_TRANSPORT_VERSION) {
    throw new Error("Invalid remote window list params");
  }
  return Object.freeze({
    commandId: value.commandId,
    monitorOwnerNonce: value.monitorOwnerNonce,
    workspaceRef: value.workspaceRef,
    authorityId: value.authorityId,
    transportVersion: REMOTE_WINDOW_TRANSPORT_VERSION,
  });
}

export function normalizeRemoteWindowObserveParams(value: unknown): RemoteWindowObserveParams {
  if (!record(value)
    || !knownKeys(value, ["commandId", "monitorOwnerNonce", "capture"])
    || !safeId(value.commandId)
    || !safeId(value.monitorOwnerNonce)) {
    throw new Error("Invalid remote window observe params");
  }
  return Object.freeze({
    commandId: value.commandId,
    monitorOwnerNonce: value.monitorOwnerNonce,
    capture: normalizeRemoteWindowCapture(value.capture, { monitorOwnerNonce: value.monitorOwnerNonce }),
  });
}

export function normalizeRemoteWindowSendParams(value: unknown): RemoteWindowSendParams {
  if (!record(value)
    || !knownKeys(value, [
      "commandId", "monitorOwnerNonce", "capture", "messageId", "mode", "message",
      "source", "messageKind", "ttlMs",
    ])
    || !safeId(value.commandId)
    || !safeId(value.monitorOwnerNonce)
    || !safeMessageId(value.messageId)
    || (value.mode !== "steer" && value.mode !== "follow_up")
    || !safeText(value.message, REMOTE_WINDOW_MAX_MESSAGE_BYTES)
    || (value.source !== "user" && value.source !== "monitor" && value.source !== "system")
    || !["message", "coordination", "request", "status", "supervision"].includes(String(value.messageKind))
    || (value.ttlMs !== undefined && (!safeInteger(value.ttlMs, 1) || value.ttlMs > 10 * 60_000))) {
    throw new Error("Invalid remote window send params");
  }
  return Object.freeze({
    commandId: value.commandId,
    monitorOwnerNonce: value.monitorOwnerNonce,
    capture: normalizeRemoteWindowCapture(value.capture, { monitorOwnerNonce: value.monitorOwnerNonce }),
    messageId: value.messageId,
    mode: value.mode,
    message: value.message,
    source: value.source,
    messageKind: value.messageKind as WorkspacePeerMessageKind,
    ...(value.ttlMs === undefined ? {} : { ttlMs: value.ttlMs }),
  });
}

export function normalizeRemoteWindowReceiptParams(value: unknown): RemoteWindowReceiptParams {
  if (!record(value)
    || !knownKeys(value, ["commandId", "monitorOwnerNonce", "capture", "messageId", "direction", "acknowledge"])
    || !safeId(value.commandId)
    || !safeId(value.monitorOwnerNonce)
    || !safeMessageId(value.messageId)
    || (value.direction !== undefined && value.direction !== "outgoing" && value.direction !== "incoming")
    || (value.acknowledge !== undefined && value.acknowledge !== "injected")
    || (value.acknowledge !== undefined && value.direction !== "incoming")) {
    throw new Error("Invalid remote window receipt params");
  }
  return Object.freeze({
    commandId: value.commandId,
    monitorOwnerNonce: value.monitorOwnerNonce,
    capture: normalizeRemoteWindowCapture(value.capture, { monitorOwnerNonce: value.monitorOwnerNonce }),
    messageId: value.messageId,
    ...(value.direction === undefined ? {} : { direction: value.direction }),
    ...(value.acknowledge === undefined ? {} : { acknowledge: "injected" as const }),
  });
}

export function normalizeRemoteWindowListResult(value: unknown): RemoteWindowListResult {
  if (!record(value) || !knownKeys(value, ["windows"]) || !Array.isArray(value.windows) || value.windows.length > 256) {
    throw new Error("Invalid remote window list result");
  }
  return Object.freeze({ windows: Object.freeze(value.windows.map(normalizeRemoteWindowListing)) });
}

export function normalizeRemoteWindowObserveResult(value: unknown): RemoteWindowObserveResult {
  if (!record(value)
    || !knownKeys(value, ["capture", "owner", "observedAt"])
    || !safeInteger(value.observedAt)) throw new Error("Invalid remote window observation");
  const capture = normalizeRemoteWindowCapture(value.capture);
  const owner = validateWorkspaceOwnerSnapshot(value.owner, {
    workspaceId: capture.workspaceId,
    ownerId: capture.ownerId,
  });
  if (!owner
    || owner.ownerNonce !== capture.ownerNonce
    || (owner.ownerGeneration ?? 1) !== capture.generation
    || owner.plugin?.id !== WORKSPACE_PEER_PLUGIN_ID
    || owner.protocol?.workspacePeerVersion !== WORKSPACE_PEER_PROTOCOL_VERSION
    || owner.protocol.commandResponseVersion !== WORKSPACE_PEER_COMMAND_PROTOCOL_VERSION) {
    throw new Error("Remote window observation does not match its capture");
  }
  return Object.freeze({ capture, owner: Object.freeze(owner), observedAt: value.observedAt });
}

export function normalizeRemoteWindowReceipt(value: unknown): RemoteWindowReceipt {
  if (!record(value)
    || !knownKeys(value, [
      "capture", "messageId", "requestedMode", "effectiveMode", "status", "updatedAt",
      "expiresAt", "relayId", "detail",
    ])
    || !safeMessageId(value.messageId)
    || (value.requestedMode !== "steer" && value.requestedMode !== "follow_up")
    || (value.effectiveMode !== undefined && value.effectiveMode !== "steer" && value.effectiveMode !== "follow_up")
    || !["queued", "injected", "replied", "rejected", "expired", "unknown"].includes(String(value.status))
    || !safeInteger(value.updatedAt)
    || !safeInteger(value.expiresAt)
    || value.expiresAt < value.updatedAt
    || (value.relayId !== undefined && (typeof value.relayId !== "string" || !OWNER_ID.test(value.relayId)))
    || (value.detail !== undefined && !safeText(value.detail, REMOTE_WINDOW_MAX_RECEIPT_DETAIL_BYTES, true))) {
    throw new Error("Invalid remote window receipt");
  }
  return Object.freeze({
    capture: normalizeRemoteWindowCapture(value.capture),
    messageId: value.messageId,
    requestedMode: value.requestedMode,
    ...(value.effectiveMode === undefined ? {} : { effectiveMode: value.effectiveMode }),
    status: value.status as RemoteWindowReceiptStatus,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    ...(value.relayId === undefined ? {} : { relayId: value.relayId }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  });
}

export function normalizeRemoteWindowReceiptResult(value: unknown): RemoteWindowReceiptResult {
  if (!record(value)
    || !knownKeys(value, ["receipt", "acknowledged"])
    || (value.acknowledged !== undefined && typeof value.acknowledged !== "boolean")) {
    throw new Error("Invalid remote window receipt result");
  }
  return Object.freeze({
    ...(value.receipt === undefined ? {} : { receipt: normalizeRemoteWindowReceipt(value.receipt) }),
    ...(value.acknowledged === undefined ? {} : { acknowledged: value.acknowledged }),
  });
}

export function normalizeRemoteWindowStateNotification(value: unknown): RemoteWindowStateNotification {
  if (!record(value)
    || !knownKeys(value, ["type", "capture", "state", "observedAt", "receipt", "reason"])
    || value.type !== "window/state"
    || (value.state !== "available" && value.state !== "updated" && value.state !== "unavailable")
    || !safeInteger(value.observedAt)
    || (value.reason !== undefined
      && !["owner-replaced", "gateway-replaced", "monitor-exited", "expired"].includes(String(value.reason)))) {
    throw new Error("Invalid remote window state notification");
  }
  const capture = normalizeRemoteWindowCapture(value.capture);
  const receipt = value.receipt === undefined ? undefined : normalizeRemoteWindowReceipt(value.receipt);
  if (receipt && !remoteWindowCaptureMatches(receipt.capture, capture)) {
    throw new Error("Remote window state receipt capture mismatch");
  }
  const reason = value.reason as RemoteWindowStateNotification["reason"];
  return Object.freeze({
    type: "window/state",
    capture,
    state: value.state,
    observedAt: value.observedAt,
    ...(receipt === undefined ? {} : { receipt }),
    ...(reason === undefined ? {} : { reason }),
  });
}

export function normalizeRemoteWindowMessageNotification(value: unknown): RemoteWindowMessageNotification {
  if (!record(value)
    || !knownKeys(value, [
      "type", "capture", "relayId", "messageId", "inReplyTo", "mode", "source",
      "messageKind", "message", "createdAt", "receivedAt",
    ])
    || value.type !== "window/message"
    || typeof value.relayId !== "string" || !OWNER_ID.test(value.relayId)
    || !safeMessageId(value.messageId)
    || !safeMessageId(value.inReplyTo)
    || (value.mode !== "steer" && value.mode !== "follow_up")
    || (value.source !== "user" && value.source !== "monitor" && value.source !== "system")
    || !["message", "coordination", "request", "status", "supervision"].includes(String(value.messageKind))
    || !safeText(value.message, REMOTE_WINDOW_MAX_MESSAGE_BYTES)
    || !safeInteger(value.createdAt)
    || !safeInteger(value.receivedAt)
    || value.receivedAt < value.createdAt) throw new Error("Invalid remote window message notification");
  return Object.freeze({
    type: "window/message",
    capture: normalizeRemoteWindowCapture(value.capture),
    relayId: value.relayId,
    messageId: value.messageId,
    inReplyTo: value.inReplyTo,
    mode: value.mode,
    source: value.source,
    messageKind: value.messageKind as WorkspacePeerMessageKind,
    message: value.message,
    createdAt: value.createdAt,
    receivedAt: value.receivedAt,
  });
}

export function normalizeRemoteWindowNotification(value: unknown): RemoteWindowNotification {
  if (!record(value)) throw new Error("Invalid remote window notification");
  return value.type === "window/state"
    ? normalizeRemoteWindowStateNotification(value)
    : normalizeRemoteWindowMessageNotification(value);
}

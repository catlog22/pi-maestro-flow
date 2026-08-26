import { createHash } from "node:crypto";

export const WORKSPACE_COMPLETION_VERSION = 1 as const;
export const WORKSPACE_MAIN_SESSION_MARKER = "window-main-session" as const;
export const WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE = "workspace-window-terminal-result" as const;

const OWNER_ID_PATTERN = /^[a-f0-9]{32}$/;
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_FINAL_TEXT_BYTES = 48 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

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

export function workspaceWindowTerminalResultMessageId(requestMessageId: string): string {
  assertRequestMessageId(requestMessageId);
  return createHash("sha256").update(`workspace-window-terminal-result\0${requestMessageId}`, "utf8").digest("hex").slice(0, 32);
}

export function workspaceWindowTerminalPublicationId(requestMessageId: string): string {
  assertRequestMessageId(requestMessageId);
  return createHash("sha256").update(`workspace-window-terminal-publication\0${requestMessageId}`, "utf8").digest("hex");
}

export function workspaceWindowTerminalReservationId(requestMessageId: string): string {
  assertRequestMessageId(requestMessageId);
  return createHash("sha256").update(`workspace-window-terminal-reservation\0${requestMessageId}`, "utf8").digest("hex");
}

export function workspaceWindowCompletionHandle(requestMessageId: string): WorkspaceWindowCompletionHandle {
  const publicationId = workspaceWindowTerminalPublicationId(requestMessageId);
  return {
    messageId: requestMessageId,
    requestMessageId,
    correlationId: requestMessageId,
    dispatchId: requestMessageId,
    deliveryGroupId: requestMessageId,
    reservationId: workspaceWindowTerminalReservationId(requestMessageId),
    publicationId,
    resource: `agent://${publicationId}`,
  };
}

export function bindWorkspaceCompletionHandle(
  requestMessageId: string,
  owner: WorkspaceCompletionOwnerBinding,
): WorkspaceCompletionCorrelation {
  const normalized = validateWorkspaceCompletionOwnerBinding(owner);
  if (!normalized) throw new Error("invalid workspace completion owner binding");
  return { ...workspaceWindowCompletionHandle(requestMessageId), owner: normalized };
}

export function validateWorkspaceCompletionCorrelation(value: unknown): WorkspaceCompletionCorrelation | undefined {
  if (!isRecord(value)) return undefined;
  const requestMessageId = value.requestMessageId;
  if (typeof requestMessageId !== "string") return undefined;
  let expected: WorkspaceWindowCompletionHandle;
  try {
    expected = workspaceWindowCompletionHandle(requestMessageId);
  } catch {
    return undefined;
  }
  for (const key of ["messageId", "requestMessageId", "correlationId", "dispatchId", "deliveryGroupId", "reservationId", "publicationId", "resource"] as const) {
    if (value[key] !== expected[key]) return undefined;
  }
  const owner = validateWorkspaceCompletionOwnerBinding(value.owner);
  return owner ? { ...expected, owner } : undefined;
}

export function createWorkspaceWindowTerminalResult(input: {
  requestMessageId: string;
  outcome: WorkspaceWindowTerminalOutcome;
  settledAt?: number;
  finalText?: string;
  error?: string;
}): WorkspaceWindowTerminalResult {
  const result: WorkspaceWindowTerminalResult = {
    version: WORKSPACE_COMPLETION_VERSION,
    type: WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE,
    requestMessageId: input.requestMessageId,
    outcome: input.outcome,
    settledAt: input.settledAt ?? Date.now(),
    ...(input.finalText === undefined ? {} : { finalText: truncateText(input.finalText, MAX_FINAL_TEXT_BYTES) }),
    ...(input.error === undefined ? {} : { error: truncateText(input.error, MAX_ERROR_BYTES) }),
  };
  const validated = validateWorkspaceWindowTerminalResult(result);
  if (!validated) throw new Error("constructed workspace window terminal result failed protocol validation");
  return validated;
}

export function validateWorkspaceWindowTerminalResult(value: unknown): WorkspaceWindowTerminalResult | undefined {
  if (!isRecord(value)
    || value.version !== WORKSPACE_COMPLETION_VERSION
    || value.type !== WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE
    || typeof value.requestMessageId !== "string"
    || !OWNER_ID_PATTERN.test(value.requestMessageId)
    || !["completed", "failed", "cancelled", "no-result"].includes(String(value.outcome))
    || typeof value.settledAt !== "number"
    || !Number.isSafeInteger(value.settledAt)
    || value.settledAt < 0
    || (value.finalText !== undefined && (typeof value.finalText !== "string" || value.finalText.length === 0 || Buffer.byteLength(value.finalText, "utf8") > MAX_FINAL_TEXT_BYTES))
    || (value.error !== undefined && (typeof value.error !== "string" || value.error.length === 0 || Buffer.byteLength(value.error, "utf8") > MAX_ERROR_BYTES))
    || (value.outcome === "completed" && value.finalText === undefined)
    || (value.outcome === "no-result" && (value.finalText !== undefined || value.error !== undefined))
    || (value.outcome === "failed" && value.error === undefined)) return undefined;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MESSAGE_BYTES) return undefined;
  return {
    version: WORKSPACE_COMPLETION_VERSION,
    type: WORKSPACE_WINDOW_TERMINAL_RESULT_TYPE,
    requestMessageId: value.requestMessageId,
    outcome: value.outcome as WorkspaceWindowTerminalOutcome,
    settledAt: value.settledAt,
    ...(value.finalText === undefined ? {} : { finalText: value.finalText }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

export function encodeWorkspaceWindowTerminalResult(result: WorkspaceWindowTerminalResult): string {
  const validated = validateWorkspaceWindowTerminalResult(result);
  if (!validated) throw new Error("invalid workspace window terminal result");
  return JSON.stringify(validated);
}

export function decodeWorkspaceWindowTerminalResult(text: string): WorkspaceWindowTerminalResult {
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new Error("workspace window terminal result exceeds protocol bounds");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid workspace window terminal result JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = validateWorkspaceWindowTerminalResult(parsed);
  if (!result) throw new Error("invalid workspace window terminal result");
  return result;
}

function validateWorkspaceCompletionOwnerBinding(value: unknown): WorkspaceCompletionOwnerBinding | undefined {
  if (!isRecord(value)
    || typeof value.workspaceId !== "string"
    || !WORKSPACE_ID_PATTERN.test(value.workspaceId)
    || typeof value.ownerId !== "string"
    || !OWNER_ID_PATTERN.test(value.ownerId)
    || typeof value.ownerNonce !== "string"
    || !OWNER_ID_PATTERN.test(value.ownerNonce)
    || Object.keys(value).some((key) => !["workspaceId", "ownerId", "ownerNonce"].includes(key))) return undefined;
  return { workspaceId: value.workspaceId, ownerId: value.ownerId, ownerNonce: value.ownerNonce };
}

function assertRequestMessageId(requestMessageId: string): void {
  if (!OWNER_ID_PATTERN.test(requestMessageId)) {
    throw new Error("terminal result requestMessageId must be 32 lowercase hexadecimal characters");
  }
}

function truncateText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
  return value.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

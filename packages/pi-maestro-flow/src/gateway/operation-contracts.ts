/** Canonical durable contract for receipt-backed Gateway mutations. */
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GATEWAY_ID_PATTERN, GATEWAY_STATE_VERSION } from "./contracts.ts";

export const GATEWAY_OPERATION_RECEIPT_STATES = ["prepared", "dispatching", "accepted", "terminal", "outcome-unknown"] as const;
export type GatewayOperationReceiptState = typeof GATEWAY_OPERATION_RECEIPT_STATES[number];
export const GATEWAY_RECEIPT_TOOLS = ["session", "monitor"] as const;
export type GatewayReceiptTool = typeof GATEWAY_RECEIPT_TOOLS[number];
export const GATEWAY_RECEIPT_ACTIONS = ["start-pi", "message", "cancel"] as const;
export type GatewayReceiptAction = typeof GATEWAY_RECEIPT_ACTIONS[number];
export const GATEWAY_OPERATION_RECEIPT_MAX_RESULT_BYTES = 64 * 1024;

const id = Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });
const state = Type.Unsafe<GatewayOperationReceiptState>({ type: "string", enum: [...GATEWAY_OPERATION_RECEIPT_STATES] });

/** Secret-free evidence sufficient to replay the three receipt-backed responses. */
export const GATEWAY_OPERATION_RESULT_DATA_SCHEMA = Type.Object({
  taskId: Type.Optional(id),
  monitorHandle: Type.Optional(id),
  handle: Type.Optional(id),
  delivered: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.Unsafe<"steer" | "follow_up" | "interrupt">({ type: "string", enum: ["steer", "follow_up", "interrupt"] })),
  cancelled: Type.Optional(Type.Boolean()),
  alreadyTerminal: Type.Optional(Type.Boolean()),
  taskStatus: Type.Optional(Type.Unsafe<"queued" | "running" | "completed" | "failed" | "cancelled" | "lost">({ type: "string", enum: ["queued", "running", "completed", "failed", "cancelled", "lost"] })),
}, { additionalProperties: false });
export type GatewayOperationResultDataV1 = Static<typeof GATEWAY_OPERATION_RESULT_DATA_SCHEMA>;

export const GATEWAY_OPERATION_RESULT_SCHEMA = Type.Object({
  ok: Type.Boolean(),
  status: Type.Unsafe<"accepted" | "succeeded" | "failed" | "cancelled" | "lost">({ type: "string", enum: ["accepted", "succeeded", "failed", "cancelled", "lost"] }),
  data: Type.Optional(GATEWAY_OPERATION_RESULT_DATA_SCHEMA),
  error: Type.Optional(Type.Object({
    code: Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source }),
    retryable: Type.Boolean(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type GatewayOperationResultV1 = Static<typeof GATEWAY_OPERATION_RESULT_SCHEMA>;

export const GATEWAY_OPERATION_RECEIPT_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  id: hash,
  principalId: Type.String({ minLength: 1, maxLength: 256 }),
  workspaceId: Type.String({ minLength: 1, maxLength: 256 }),
  sessionId: id,
  memberId: id,
  memberGeneration: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  tool: Type.Unsafe<GatewayReceiptTool>({ type: "string", enum: [...GATEWAY_RECEIPT_TOOLS] }),
  action: Type.Unsafe<GatewayReceiptAction>({ type: "string", enum: [...GATEWAY_RECEIPT_ACTIONS] }),
  operationId: id,
  payloadHash: hash,
  state,
  createdAt: timestamp,
  updatedAt: timestamp,
  preparedAt: timestamp,
  dispatchingAt: Type.Optional(timestamp),
  acceptedAt: Type.Optional(timestamp),
  terminalAt: Type.Optional(timestamp),
  outcomeUnknownAt: Type.Optional(timestamp),
  result: Type.Optional(GATEWAY_OPERATION_RESULT_SCHEMA),
}, { additionalProperties: false });
export type GatewayOperationReceiptV1 = Static<typeof GATEWAY_OPERATION_RECEIPT_SCHEMA>;

export interface GatewayOperationReceiptKey {
  principalId: string;
  workspaceId: string;
  sessionId: string;
  memberId: string;
  memberGeneration: number;
  tool: GatewayReceiptTool;
  action: GatewayReceiptAction;
  operationId: string;
}

export interface GatewayOperationReceiptPrepareInput extends GatewayOperationReceiptKey {
  payloadHash: string;
}

export class GatewayOperationContractError extends Error {
  constructor(message: string) { super(message); this.name = "GatewayOperationContractError"; }
}

/** Stable JSON with object keys sorted and transport request ids removed at every depth. */
export function canonicalGatewayOperationPayload(value: unknown): string {
  const visit = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new GatewayOperationContractError("Operation payload contains a non-finite number");
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) return `[${candidate.map(visit).join(",")}]`;
    if (candidate && typeof candidate === "object") {
      const entries = Object.entries(candidate as Record<string, unknown>)
        .filter(([key, child]) => key !== "requestId" && child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${visit(child)}`).join(",")}}`;
    }
    throw new GatewayOperationContractError(`Unsupported operation payload value: ${typeof candidate}`);
  };
  return visit(value);
}

export function hashGatewayOperationPayload(value: unknown): string {
  return createHash("sha256").update(canonicalGatewayOperationPayload(value), "utf8").digest("hex");
}

export function buildGatewayOperationReceiptId(key: GatewayOperationReceiptKey): string {
  const canonicalKey: GatewayOperationReceiptKey = {
    principalId: key.principalId,
    workspaceId: key.workspaceId,
    sessionId: key.sessionId,
    memberId: key.memberId,
    memberGeneration: key.memberGeneration,
    tool: key.tool,
    action: key.action,
    operationId: key.operationId,
  };
  return createHash("sha256").update(canonicalGatewayOperationPayload(canonicalKey), "utf8").digest("hex");
}

export function parseGatewayOperationResult(value: unknown): GatewayOperationResultV1 {
  const errors = [...Value.Errors(GATEWAY_OPERATION_RESULT_SCHEMA, value)];
  if (errors.length) throw new GatewayOperationContractError(`Invalid operation result: ${errors.map((entry) => `${(entry as { path?: string }).path || "$"}: ${entry.message}`).join("; ")}`);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > GATEWAY_OPERATION_RECEIPT_MAX_RESULT_BYTES) throw new GatewayOperationContractError("Operation result exceeds its durable bound");
  return structuredClone(value as GatewayOperationResultV1);
}

export function parseGatewayOperationReceipt(value: unknown): GatewayOperationReceiptV1 {
  const errors = [...Value.Errors(GATEWAY_OPERATION_RECEIPT_SCHEMA, value)];
  if (errors.length) throw new GatewayOperationContractError(`Invalid operation receipt: ${errors.map((entry) => `${(entry as { path?: string }).path || "$"}: ${entry.message}`).join("; ")}`);
  const receipt = value as GatewayOperationReceiptV1;
  const expectedId = buildGatewayOperationReceiptId(receipt);
  if (receipt.id !== expectedId) throw new GatewayOperationContractError("Operation receipt id does not match its canonical key");
  if (receipt.updatedAt < receipt.createdAt || receipt.preparedAt !== receipt.createdAt) throw new GatewayOperationContractError("Operation receipt timestamp invariant failed");
  if (receipt.state !== "prepared" && receipt.dispatchingAt === undefined) throw new GatewayOperationContractError("Non-prepared receipt requires dispatchingAt");
  if ((receipt.state === "accepted" || receipt.state === "terminal") && (receipt.acceptedAt === undefined || receipt.result === undefined)) throw new GatewayOperationContractError("Accepted receipt requires durable result evidence");
  if (receipt.state === "terminal" && receipt.terminalAt === undefined) throw new GatewayOperationContractError("Terminal receipt requires terminalAt");
  if (receipt.state === "outcome-unknown" && receipt.outcomeUnknownAt === undefined) throw new GatewayOperationContractError("Outcome-unknown receipt requires outcomeUnknownAt");
  if (receipt.result !== undefined) parseGatewayOperationResult(receipt.result);
  return structuredClone(receipt);
}

/** Typed Maestro CLI Gateway contracts. Arbitrary commands, argv, env, and paths are intentionally absent. */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GATEWAY_ID_PATTERN, GATEWAY_STATE_VERSION } from "./contracts.ts";

export const GATEWAY_MAESTRO_SOURCES = ["knowledge", "handoff", "all"] as const;
export const GATEWAY_MAESTRO_KINDS = ["spec", "knowhow"] as const;
export const GATEWAY_MAESTRO_RECEIPT_STATES = ["pending", "committed", "uncertain", "failed"] as const;

const strict = { additionalProperties: false } as const;
const workspaceId = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });
const operationId = Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source });
const requestId = Type.Optional(Type.String({ minLength: 1, maxLength: 256 }));
const kind = Type.Unsafe<(typeof GATEWAY_MAESTRO_KINDS)[number]>({ type: "string", enum: [...GATEWAY_MAESTRO_KINDS] });
const source = Type.Unsafe<(typeof GATEWAY_MAESTRO_SOURCES)[number]>({ type: "string", enum: [...GATEWAY_MAESTRO_SOURCES] });

export const GATEWAY_MAESTRO_SEARCH_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("search"),
  requestId,
  workspaceId,
  query: Type.String({ minLength: 1, maxLength: 4096 }),
  source: Type.Optional(source),
  kind: Type.Optional(kind),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
}, strict);

export const GATEWAY_MAESTRO_LOAD_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("load"),
  requestId,
  workspaceId,
  source: Type.Optional(Type.Unsafe<"knowledge" | "handoff">({ type: "string", enum: ["knowledge", "handoff"] })),
  kind: Type.Optional(kind),
  id: Type.String({ minLength: 1, maxLength: 512 }),
}, strict);

export const GATEWAY_MAESTRO_STAGE_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("stage"),
  requestId,
  workspaceId,
  operationId,
  kind,
  title: Type.String({ minLength: 1, maxLength: 512 }),
  content: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
  workflowSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source })),
  evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32, uniqueItems: true })),
}, strict);

export const GATEWAY_MAESTRO_CLI_REQUEST_SCHEMA = Type.Union([
  GATEWAY_MAESTRO_SEARCH_REQUEST_SCHEMA,
  GATEWAY_MAESTRO_LOAD_REQUEST_SCHEMA,
  GATEWAY_MAESTRO_STAGE_REQUEST_SCHEMA,
]);
export type GatewayMaestroCliRequest = Static<typeof GATEWAY_MAESTRO_CLI_REQUEST_SCHEMA>;

export const GATEWAY_MAESTRO_RECEIPT_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  operationId,
  workspaceId,
  action: Type.Literal("stage"),
  state: Type.Unsafe<(typeof GATEWAY_MAESTRO_RECEIPT_STATES)[number]>({ type: "string", enum: [...GATEWAY_MAESTRO_RECEIPT_STATES] }),
  payloadHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  recordId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  createdAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  updatedAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);
export type GatewayMaestroReceiptV1 = Static<typeof GATEWAY_MAESTRO_RECEIPT_SCHEMA>;

export function parseGatewayMaestroReceipt(value: unknown): GatewayMaestroReceiptV1 {
  const errors = [...Value.Errors(GATEWAY_MAESTRO_RECEIPT_SCHEMA, value)];
  if (errors.length > 0) {
    throw new Error(`Invalid GatewayMaestroReceiptV1: ${errors.map((error) => `${(error as { path?: string }).path || "$"}: ${error.message}`).join("; ")}`);
  }
  return value as GatewayMaestroReceiptV1;
}

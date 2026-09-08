/** Versioned operational handoff record contracts. These records are not governing knowledge. */
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GATEWAY_ID_PATTERN, GATEWAY_STATE_VERSION, GATEWAY_WORKSPACE_ID_PATTERN } from "./contracts.ts";
import { GATEWAY_HANDOFF_SCHEMA } from "./handoff-contracts.ts";

export const GATEWAY_HANDOFF_RECORD_SCHEMA_ID = "gateway-handoff/1" as const;
export const GATEWAY_HANDOFF_AUTHORITIES = ["board", "session"] as const;
export const GATEWAY_HANDOFF_PROJECTIONS = ["incomplete", "completed", "cancelled", "unknown"] as const;
export const GATEWAY_HANDOFF_ORIGIN_SURFACES = ["pi", "web", "service", "unknown"] as const;
export const GATEWAY_HANDOFF_ORIGIN_TRANSPORTS = ["stdio", "http", "unknown"] as const;
export const GATEWAY_HANDOFF_EVIDENCE_KINDS = ["project", "web", "unknown"] as const;
export const GATEWAY_HANDOFF_GOVERNANCE_STATES = ["operational"] as const;

const strict = { additionalProperties: false } as const;
const enumString = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });
const id = Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });

export const GATEWAY_HANDOFF_SOURCE_SCHEMA = Type.Object({
  authority: enumString(GATEWAY_HANDOFF_AUTHORITIES),
  entityId: id,
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, strict);
export type GatewayHandoffSourceV1 = Static<typeof GATEWAY_HANDOFF_SOURCE_SCHEMA>;

export const GATEWAY_HANDOFF_ORIGIN_SCHEMA = Type.Object({
  surface: enumString(GATEWAY_HANDOFF_ORIGIN_SURFACES),
  transport: enumString(GATEWAY_HANDOFF_ORIGIN_TRANSPORTS),
  evidenceKind: enumString(GATEWAY_HANDOFF_EVIDENCE_KINDS),
  sourceUrls: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 16, uniqueItems: true })),
}, strict);
export type GatewayHandoffOriginV1 = Static<typeof GATEWAY_HANDOFF_ORIGIN_SCHEMA>;

/** Legacy handoffs did not carry provenance. Missing values must remain unknown, never inferred. */
export function normalizeGatewayHandoffOrigin(origin?: Partial<GatewayHandoffOriginV1>): GatewayHandoffOriginV1 {
  return {
    surface: origin?.surface ?? "unknown",
    transport: origin?.transport ?? "unknown",
    evidenceKind: origin?.evidenceKind ?? "unknown",
    ...(origin?.sourceUrls === undefined ? {} : { sourceUrls: [...origin.sourceUrls] }),
  };
}

export const GATEWAY_HANDOFF_RECORD_SCHEMA = Type.Object({
  version: Type.Literal(GATEWAY_STATE_VERSION),
  schema: Type.Literal(GATEWAY_HANDOFF_RECORD_SCHEMA_ID),
  kind: Type.Literal("handoff"),
  id,
  workspaceId: Type.String({ minLength: 64, maxLength: 64, pattern: GATEWAY_WORKSPACE_ID_PATTERN.source }),
  source: GATEWAY_HANDOFF_SOURCE_SCHEMA,
  origin: GATEWAY_HANDOFF_ORIGIN_SCHEMA,
  projection: enumString(GATEWAY_HANDOFF_PROJECTIONS),
  lifecycleStatus: Type.String({ minLength: 1, maxLength: 128 }),
  resumable: Type.Boolean(),
  governanceState: Type.Literal("operational"),
  createdAt: timestamp,
  updatedAt: timestamp,
  contentSha256: digest,
  content: GATEWAY_HANDOFF_SCHEMA,
}, strict);
export type GatewayHandoffRecordV1 = Static<typeof GATEWAY_HANDOFF_RECORD_SCHEMA>;

const handoffReadBase = {
  workspaceId: Type.String({ minLength: 64, maxLength: 64, pattern: GATEWAY_WORKSPACE_ID_PATTERN.source }),
  requestId: Type.Optional(id),
  /** Required to expose Session-owned records; Board records use workspace authorization. */
  memberId: Type.Optional(id),
};
export const GATEWAY_HANDOFF_LIST_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("list"),
  ...handoffReadBase,
  authority: Type.Optional(enumString(GATEWAY_HANDOFF_AUTHORITIES)),
  projection: Type.Optional(enumString(GATEWAY_HANDOFF_PROJECTIONS)),
  sourceId: Type.Optional(id),
  cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
}, strict);
export const GATEWAY_HANDOFF_GET_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("get"),
  ...handoffReadBase,
  id,
}, strict);
export const GATEWAY_HANDOFF_SEARCH_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("search"),
  ...handoffReadBase,
  query: Type.String({ minLength: 1, maxLength: 4096 }),
  authority: Type.Optional(enumString(GATEWAY_HANDOFF_AUTHORITIES)),
  projection: Type.Optional(enumString(GATEWAY_HANDOFF_PROJECTIONS)),
  cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
}, strict);
export const GATEWAY_HANDOFF_REQUEST_SCHEMA = Type.Union([
  GATEWAY_HANDOFF_LIST_REQUEST_SCHEMA,
  GATEWAY_HANDOFF_GET_REQUEST_SCHEMA,
  GATEWAY_HANDOFF_SEARCH_REQUEST_SCHEMA,
]);
export type GatewayHandoffRequest = Static<typeof GATEWAY_HANDOFF_REQUEST_SCHEMA>;

export function boardHandoffProjection(status: "open" | "active" | "blocked" | "completed" | "cancelled"): typeof GATEWAY_HANDOFF_PROJECTIONS[number] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "incomplete";
}

export function gatewayHandoffOriginForTransport(transport: "stdio" | "http"): GatewayHandoffOriginV1 {
  return transport === "http"
    ? { surface: "web", transport: "http", evidenceKind: "project" }
    : { surface: "pi", transport: "stdio", evidenceKind: "project" };
}

export function gatewayHandoffContentDigest(content: Static<typeof GATEWAY_HANDOFF_SCHEMA>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      : value;
  return createHash("sha256").update(JSON.stringify(canonical(content)), "utf8").digest("hex");
}

export class GatewayHandoffRecordContractError extends Error {
  constructor(message: string) { super(message); this.name = "GatewayHandoffRecordContractError"; }
}

export function parseGatewayHandoffRecord(value: unknown): GatewayHandoffRecordV1 {
  const errors = [...Value.Errors(GATEWAY_HANDOFF_RECORD_SCHEMA, value)];
  if (errors.length) throw new GatewayHandoffRecordContractError(`Invalid GatewayHandoffRecordV1: ${errors.map((error) => `${(error as { path?: string }).path || "$"}: ${error.message}`).join("; ")}`);
  const record = value as GatewayHandoffRecordV1;
  if (record.updatedAt < record.createdAt) throw new GatewayHandoffRecordContractError("handoff record updatedAt precedes createdAt");
  if (gatewayHandoffContentDigest(record.content) !== record.contentSha256) throw new GatewayHandoffRecordContractError("handoff record content digest does not match content");
  return record;
}

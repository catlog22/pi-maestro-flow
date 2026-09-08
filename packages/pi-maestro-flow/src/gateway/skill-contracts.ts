/** Policy-scoped Gateway skill discovery/load contracts. No action accepts a filesystem path. */
import { Type, type Static } from "typebox";
import { GATEWAY_ID_PATTERN } from "./contracts.ts";

export const GATEWAY_SKILL_RESOURCE_STATES = ["allowed", "denied", "missing", "deferred"] as const;
export const GATEWAY_SKILL_SOURCES = ["workspace", "external"] as const;

const strict = { additionalProperties: false } as const;
const source = Type.Unsafe<(typeof GATEWAY_SKILL_SOURCES)[number]>({ type: "string", enum: [...GATEWAY_SKILL_SOURCES] });
const resourceState = Type.Unsafe<(typeof GATEWAY_SKILL_RESOURCE_STATES)[number]>({ type: "string", enum: [...GATEWAY_SKILL_RESOURCE_STATES] });
const workspaceFields = {
  workspaceId: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: GATEWAY_ID_PATTERN.source })),
};

export const GATEWAY_SKILL_LIST_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("list"),
  ...workspaceFields,
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
}, strict);

export const GATEWAY_SKILL_LOAD_REQUEST_SCHEMA = Type.Object({
  action: Type.Literal("load"),
  ...workspaceFields,
  skillId: Type.String({ minLength: 1, maxLength: 256 }),
  resourceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, strict);

export const GATEWAY_SKILL_REQUEST_SCHEMA = Type.Union([
  GATEWAY_SKILL_LIST_REQUEST_SCHEMA,
  GATEWAY_SKILL_LOAD_REQUEST_SCHEMA,
]);
export type GatewaySkillRequest = Static<typeof GATEWAY_SKILL_REQUEST_SCHEMA>;

export const GATEWAY_SKILL_RESOURCE_DESCRIPTOR_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  state: resourceState,
}, strict);
export type GatewaySkillResourceDescriptorV1 = Static<typeof GATEWAY_SKILL_RESOURCE_DESCRIPTOR_SCHEMA>;

export const GATEWAY_SKILL_DESCRIPTOR_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 256 }),
  name: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.Optional(Type.String({ maxLength: 16 * 1024 })),
  source,
  resources: Type.Array(GATEWAY_SKILL_RESOURCE_DESCRIPTOR_SCHEMA, { maxItems: 64 }),
}, strict);
export type GatewaySkillDescriptorV1 = Static<typeof GATEWAY_SKILL_DESCRIPTOR_SCHEMA>;

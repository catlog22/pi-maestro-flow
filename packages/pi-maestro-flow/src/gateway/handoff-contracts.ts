/** Shared durable handoff content used by Gateway Sessions and Board records. */
import { Type, type Static } from "typebox";

export const GATEWAY_HANDOFF_FILE_VALUES = ["required", "conditional", "skip", "unknown"] as const;
export const GATEWAY_HANDOFF_MAX_NEXT_STEPS = 3;
export const GATEWAY_HANDOFF_MAX_FILES = 16;
export const GATEWAY_HANDOFF_MAX_RESOURCE_URIS = 16;

const fileValue = Type.Unsafe<(typeof GATEWAY_HANDOFF_FILE_VALUES)[number]>({
  type: "string",
  enum: [...GATEWAY_HANDOFF_FILE_VALUES],
});

export const GATEWAY_HANDOFF_FILE_SCHEMA = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 2048 }),
  value: fileValue,
  reason: Type.String({ minLength: 1, maxLength: 2048 }),
  when: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
}, { additionalProperties: false });

/** New writes require a reload condition for conditional files; persisted v1 payloads remain readable above. */
export const GATEWAY_HANDOFF_WRITE_FILE_SCHEMA = Type.Union([
  Type.Object({
    path: Type.String({ minLength: 1, maxLength: 2048 }),
    value: Type.Literal("conditional"),
    reason: Type.String({ minLength: 1, maxLength: 2048 }),
    when: Type.String({ minLength: 1, maxLength: 2048 }),
  }, { additionalProperties: false }),
  Type.Object({
    path: Type.String({ minLength: 1, maxLength: 2048 }),
    value: Type.Unsafe<"required" | "skip" | "unknown">({ type: "string", enum: ["required", "skip", "unknown"] }),
    reason: Type.String({ minLength: 1, maxLength: 2048 }),
    when: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  }, { additionalProperties: false }),
]);

export const GATEWAY_HANDOFF_SCHEMA = Type.Object({
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  nextSteps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: GATEWAY_HANDOFF_MAX_NEXT_STEPS,
  })),
  files: Type.Optional(Type.Array(GATEWAY_HANDOFF_FILE_SCHEMA, {
    maxItems: GATEWAY_HANDOFF_MAX_FILES,
  })),
  resourceUris: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: GATEWAY_HANDOFF_MAX_RESOURCE_URIS,
    uniqueItems: true,
  })),
}, { additionalProperties: false });
export type GatewayHandoffV1 = Static<typeof GATEWAY_HANDOFF_SCHEMA>;

export const GATEWAY_HANDOFF_WRITE_SCHEMA = Type.Object({
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  nextSteps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: GATEWAY_HANDOFF_MAX_NEXT_STEPS,
  })),
  files: Type.Optional(Type.Array(GATEWAY_HANDOFF_WRITE_FILE_SCHEMA, {
    maxItems: GATEWAY_HANDOFF_MAX_FILES,
  })),
  resourceUris: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: GATEWAY_HANDOFF_MAX_RESOURCE_URIS,
    uniqueItems: true,
  })),
}, { additionalProperties: false });
export type GatewayHandoffWriteV1 = Static<typeof GATEWAY_HANDOFF_WRITE_SCHEMA>;

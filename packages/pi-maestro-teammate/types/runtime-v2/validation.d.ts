import { type ActorAddressV2, type RuntimeCommandV2, type RuntimeEventV2, type RuntimeLeaseV2, type RuntimeProjectionV2 } from "./contracts.ts";
export declare function parseActorAddressV2(value: unknown): ActorAddressV2;
export declare function parseRuntimeCommandV2(value: unknown): RuntimeCommandV2;
export declare function parseRuntimeEventV2(value: unknown): RuntimeEventV2;
/**
 * Compatibility is intentionally confined to persisted V2 reads. Admission
 * and the public teammate tool schemas continue to use their existing strict
 * parsers and never call this function.
 */
export declare function normalizePersistedRuntimeEventV2(value: unknown): RuntimeEventV2;
export declare function parseRuntimeLeaseV2(value: unknown): RuntimeLeaseV2;
export declare function parseRuntimeProjectionV2(value: unknown): RuntimeProjectionV2;

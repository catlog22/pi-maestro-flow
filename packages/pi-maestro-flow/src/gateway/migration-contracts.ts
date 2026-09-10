/** Public, redacted contracts for the explicit legacy Gateway migration command. */
export const GATEWAY_LEGACY_MIGRATION_VERSION = 1 as const;

export type GatewayLegacyMigrationStatus = "ready" | "applied" | "already-applied" | "recovered";
export type GatewayLegacyArtifactDisposition = "migrate" | "snapshot-only" | "published" | "unchanged" | "not-present" | "excluded";

export interface GatewayLegacyArtifactReport {
  kind: "config" | "workspaces" | "pairings" | "tasks-snapshot" | "owner" | "resident-service" | "tunnel";
  disposition: GatewayLegacyArtifactDisposition;
  records?: number;
  sourceDigest?: string;
  targetDigest?: string;
  reason?: string;
}

export interface GatewayLegacyMigrationReport {
  version: typeof GATEWAY_LEGACY_MIGRATION_VERSION;
  mode: "dry-run" | "apply";
  status: GatewayLegacyMigrationStatus;
  sourceDigest: string;
  artifacts: GatewayLegacyArtifactReport[];
  warnings: string[];
}

export type GatewayLegacyMigrationErrorCode =
  | "LEGACY_MIGRATION_UNSAFE_SOURCE"
  | "LEGACY_MIGRATION_LIVE_PROCESS"
  | "LEGACY_MIGRATION_UNKNOWN_VERSION"
  | "LEGACY_MIGRATION_SOURCE_DRIFT"
  | "LEGACY_MIGRATION_COLLISION"
  | "LEGACY_MIGRATION_RECOVERY_REQUIRED";

export class GatewayLegacyMigrationError extends Error {
  readonly code: GatewayLegacyMigrationErrorCode;
  constructor(code: GatewayLegacyMigrationErrorCode, message: string) {
    super(message);
    this.name = "GatewayLegacyMigrationError";
    this.code = code;
  }
}

export function serializeGatewayLegacyMigrationError(error: unknown): string {
  const known = error instanceof GatewayLegacyMigrationError
    ? error
    : new GatewayLegacyMigrationError("LEGACY_MIGRATION_RECOVERY_REQUIRED", "Legacy Gateway migration failed");
  return JSON.stringify({ version: GATEWAY_LEGACY_MIGRATION_VERSION, ok: false, error: { code: known.code, message: known.message } });
}

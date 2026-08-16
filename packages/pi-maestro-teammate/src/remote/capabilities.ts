/** Capability negotiation for remote bridges and CLI drivers. */

export const REMOTE_CAPABILITIES = [
  "streaming",
  "follow-up",
  "steer",
  "cancel",
  "usage",
  "tool-events",
  "structured-output",
  "session-resume",
] as const;

export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];

export interface RemoteCapabilityNegotiation {
  capabilities: readonly RemoteCapability[];
  missing: readonly RemoteCapability[];
}

export class RemoteCapabilityError extends Error {
  readonly missing: readonly RemoteCapability[];

  constructor(missing: readonly RemoteCapability[]) {
    super(`Remote target does not support required capabilities: ${missing.join(", ")}`);
    this.name = "RemoteCapabilityError";
    this.missing = Object.freeze([...missing]);
  }
}

export function isRemoteCapability(value: unknown): value is RemoteCapability {
  return typeof value === "string" && (REMOTE_CAPABILITIES as readonly string[]).includes(value);
}

function normalizedCapabilities(values: readonly RemoteCapability[]): RemoteCapability[] {
  const available = new Set(values);
  return REMOTE_CAPABILITIES.filter((capability) => available.has(capability));
}

export function negotiateRemoteCapabilities(
  local: readonly RemoteCapability[],
  remote: readonly RemoteCapability[],
  required: readonly RemoteCapability[] = [],
): RemoteCapabilityNegotiation {
  const remoteSet = new Set(remote);
  const capabilities = normalizedCapabilities(local).filter((capability) => remoteSet.has(capability));
  const negotiated = new Set(capabilities);
  const missing = normalizedCapabilities(required).filter((capability) => !negotiated.has(capability));
  return { capabilities: Object.freeze(capabilities), missing: Object.freeze(missing) };
}

export function requireRemoteCapabilities(
  available: readonly RemoteCapability[],
  required: readonly RemoteCapability[],
): void {
  const availableSet = new Set(available);
  const missing = normalizedCapabilities(required).filter((capability) => !availableSet.has(capability));
  if (missing.length > 0) throw new RemoteCapabilityError(missing);
}

import type {
  SshHostProfile,
  SshHostProfileAuthentication,
  SshHostReferenceIssue,
  SshHostReferenceSummary,
} from "pi-maestro-backend-core/v1/ssh";

/** Runtime provider owned by the system that stores SSH host references. */
export interface SshHostProvider {
  list(): Promise<readonly SshHostReferenceSummary[]>;
  resolve(hostRef: string): Promise<SshHostProfile>;
}

export type SshHostProviderErrorCode =
  | "provider-unavailable"
  | "manager-locked"
  | "host-not-found"
  | "host-incompatible"
  | "refresh-failed"
  | "invalid-provider-result";

/** A safe diagnostic whose message never contains provider credential values. */
export class SshHostProviderError extends Error {
  constructor(
    readonly code: SshHostProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SshHostProviderError";
  }
}

export interface SshHostProviderRegistration {
  /** Remove this provider if it is still the active registration. */
  dispose(): void;
}

const PROVIDER_KEY = Symbol.for("pi-maestro.ssh-host-provider.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;
const REFERENCE_ISSUES = new Set<SshHostReferenceIssue>([
  "unsupported-shell",
  "unsupported-password-authentication",
  "unsupported-identity-passphrase",
]);

/** Register the process-local SSH provider. A newer registration replaces the old one. */
export function registerSshHostProvider(provider: SshHostProvider): SshHostProviderRegistration {
  if (!provider || typeof provider.list !== "function" || typeof provider.resolve !== "function") {
    throw new Error("Invalid SSH host provider");
  }
  globals[PROVIDER_KEY] = provider;
  return {
    dispose(): void {
      if (globals[PROVIDER_KEY] !== provider) return;
      delete globals[PROVIDER_KEY];
    },
  };
}

/** Return the active provider without invoking it. */
export function getSshHostProvider(): SshHostProvider | undefined {
  const candidate = globals[PROVIDER_KEY];
  if (!candidate || typeof candidate !== "object") return undefined;
  const provider = candidate as Partial<SshHostProvider>;
  return typeof provider.list === "function" && typeof provider.resolve === "function"
    ? provider as SshHostProvider
    : undefined;
}

/** List bounded, cloned reference metadata suitable for a trusted configuration UI. */
export async function listSshHostRefs(): Promise<readonly SshHostReferenceSummary[]> {
  const provider = requireProvider();
  let value: readonly SshHostReferenceSummary[];
  try {
    value = await provider.list();
  } catch (error) {
    throw safeProviderError(error, "SSH host references could not be listed");
  }
  if (!Array.isArray(value) || value.length > 256) {
    throw invalidProviderResult();
  }
  const result = value.map(validateSummary);
  if (new Set(result.map((entry) => entry.id)).size !== result.length) {
    throw invalidProviderResult();
  }
  return result;
}

/** Resolve and validate one host reference immediately before connection use. */
export async function resolveSshHostRef(hostRef: string): Promise<SshHostProfile> {
  if (!HOST_ID.test(hostRef)) throw new Error("SSH host reference is invalid");
  const provider = requireProvider();
  let value: SshHostProfile;
  try {
    value = await provider.resolve(hostRef);
  } catch (error) {
    throw safeProviderError(error, `SSH host reference ${JSON.stringify(hostRef)} could not be resolved`);
  }
  const profile = validateProfile(value);
  if (profile.id !== hostRef) throw invalidProviderResult();
  return profile;
}

function requireProvider(): SshHostProvider {
  const provider = getSshHostProvider();
  if (!provider) {
    throw new SshHostProviderError(
      "provider-unavailable",
      "SSH host provider is unavailable. Open /ssh in the host session before using an SSH host reference.",
    );
  }
  return provider;
}

function safeProviderError(error: unknown, fallback: string): Error {
  return error instanceof SshHostProviderError
    ? error
    : new SshHostProviderError("refresh-failed", fallback);
}

function invalidProviderResult(): SshHostProviderError {
  return new SshHostProviderError(
    "invalid-provider-result",
    "SSH host provider returned an invalid non-secret profile",
  );
}

function validateProfile(value: unknown): SshHostProfile {
  const profile = exactRecord(value, [
    "id",
    "label",
    "host",
    "user",
    "port",
    "shell",
    "hostKeySha256",
    "authentication",
  ]);
  const id = boundedString(profile.id, 1, 64);
  const label = boundedString(profile.label, 1, 128, true);
  const host = boundedString(profile.host, 1, 253);
  const user = boundedString(profile.user, 1, 128);
  if (!HOST_ID.test(id) || /\s|\p{Cc}/u.test(host) || /\s|\p{Cc}/u.test(user)) {
    throw invalidProviderResult();
  }
  if (!Number.isInteger(profile.port) || (profile.port as number) < 1 || (profile.port as number) > 65_535) {
    throw invalidProviderResult();
  }
  if (profile.shell !== "bash" || typeof profile.hostKeySha256 !== "string" || !HOST_KEY.test(profile.hostKeySha256)) {
    throw invalidProviderResult();
  }
  return {
    id,
    label,
    host,
    user,
    port: profile.port as number,
    shell: "bash",
    hostKeySha256: profile.hostKeySha256,
    authentication: validateAuthentication(profile.authentication),
  };
}

function validateAuthentication(value: unknown): SshHostProfileAuthentication {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProviderResult();
  const authentication = value as Record<string, unknown>;
  if (authentication.kind === "agent") {
    exactRecord(authentication, ["kind"]);
    return { kind: "agent" };
  }
  if (authentication.kind === "identity") {
    exactRecord(authentication, ["kind", "identityFile"]);
    return { kind: "identity", identityFile: boundedString(authentication.identityFile, 1, 4096, true) };
  }
  throw invalidProviderResult();
}

function validateSummary(value: unknown): SshHostReferenceSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProviderResult();
  const source = value as Record<string, unknown>;
  const allowed = source.compatible === true ? ["id", "label", "compatible"] : ["id", "label", "compatible", "issue"];
  const summary = exactRecord(source, allowed);
  const id = boundedString(summary.id, 1, 64);
  const label = boundedString(summary.label, 1, 128, true);
  if (!HOST_ID.test(id) || typeof summary.compatible !== "boolean") throw invalidProviderResult();
  if (summary.compatible) return { id, label, compatible: true };
  if (typeof summary.issue !== "string" || !REFERENCE_ISSUES.has(summary.issue as SshHostReferenceIssue)) {
    throw invalidProviderResult();
  }
  return { id, label, compatible: false, issue: summary.issue as SshHostReferenceIssue };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProviderResult();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalidProviderResult();
  return record;
}

function boundedString(value: unknown, minimum: number, maximum: number, allowWhitespace = false): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw invalidProviderResult();
  }
  if (!allowWhitespace && /\s/u.test(value)) throw invalidProviderResult();
  return value;
}

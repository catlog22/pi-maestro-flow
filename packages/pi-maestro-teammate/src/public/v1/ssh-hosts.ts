import type {
  SshHostProfile,
  SshHostProfileAuthentication,
  SshHostReferenceIssue,
  SshHostReferenceSummary,
} from "pi-maestro-backend-core/v1/ssh";

/** Shells that a picker may display without exposing authentication material. */
export type SshHostPickerShell = "bash" | "powershell";

/** Bounded, non-secret metadata suitable for a trusted local SSH host picker. */
export interface SshHostPickerEntry {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly shell: SshHostPickerShell;
  readonly selected: boolean;
}

/** Runtime provider owned by the system that stores SSH host references. */
export interface SshHostProvider {
  list(): Promise<readonly SshHostReferenceSummary[]>;
  resolve(hostRef: string): Promise<SshHostProfile>;
  /** Optional safe metadata surface for trusted local UI pickers. */
  listPickerEntries?(): Promise<readonly SshHostPickerEntry[]>;
  /** Optional process-local activation of one provider-owned host id. */
  activate?(hostId: string): Promise<void>;
}

export type SshHostProviderErrorCode =
  | "provider-unavailable"
  | "manager-locked"
  | "host-not-found"
  | "host-incompatible"
  | "refresh-failed"
  | "unsupported-capability"
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
const PICKER_SHELLS = new Set<SshHostPickerShell>(["bash", "powershell"]);
const PICKER_KEYS = ["id", "label", "host", "user", "port", "shell", "selected"] as const;
const REFERENCE_ISSUES = new Set<SshHostReferenceIssue>([
  "unsupported-shell",
  "unsupported-password-authentication",
  "unsupported-identity-passphrase",
  "unsupported-managed-key",
  "unsupported-jump-host",
  "untrusted-host",
]);

/** Register the process-local SSH provider. A newer registration replaces the old one. */
export function registerSshHostProvider(provider: SshHostProvider): SshHostProviderRegistration {
  let valid = false;
  try {
    valid = Boolean(provider)
      && typeof provider.list === "function"
      && typeof provider.resolve === "function"
      && (provider.listPickerEntries === undefined || typeof provider.listPickerEntries === "function")
      && (provider.activate === undefined || typeof provider.activate === "function");
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("Invalid SSH host provider");
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
  try {
    const candidate = globals[PROVIDER_KEY];
    if (!candidate || typeof candidate !== "object") return undefined;
    const provider = candidate as Partial<SshHostProvider>;
    return typeof provider.list === "function" && typeof provider.resolve === "function"
      && (provider.listPickerEntries === undefined || typeof provider.listPickerEntries === "function")
      && (provider.activate === undefined || typeof provider.activate === "function")
      ? provider as SshHostProvider
      : undefined;
  } catch {
    return undefined;
  }
}

/** List bounded, cloned reference metadata suitable for a trusted configuration UI. */
export async function listSshHostRefs(): Promise<readonly SshHostReferenceSummary[]> {
  let value: unknown;
  try {
    const provider = requireProvider();
    const list = provider.list;
    if (typeof list !== "function") throw invalidProviderResult();
    value = await Reflect.apply(list, provider, []);
  } catch (error) {
    throw safeProviderError(error, "SSH host references could not be listed");
  }
  try {
    if (!Array.isArray(value) || value.length > 256) throw invalidProviderResult();
    const result = value.map(validateSummary);
    if (new Set(result.map((entry) => entry.id)).size !== result.length) throw invalidProviderResult();
    return result;
  } catch (error) {
    throw safeValidationError(error, invalidProviderResult);
  }
}

/** List bounded, cloned metadata for a trusted local SSH host picker. */
export async function listSshHostPickerEntries(): Promise<readonly SshHostPickerEntry[]> {
  let value: unknown;
  try {
    const provider = requireProvider();
    const listPickerEntries = provider.listPickerEntries;
    if (typeof listPickerEntries !== "function") throw unsupportedCapability("listPickerEntries");
    value = await Reflect.apply(listPickerEntries, provider, []);
  } catch (error) {
    throw safeProviderError(error, "SSH host picker entries could not be listed");
  }

  try {
    return validatePickerEntries(value);
  } catch (error) {
    throw safeValidationError(error, invalidPickerResult);
  }
}

/** Activate one provider-owned SSH host by its stable id. */
export async function activateSshHost(hostId: string): Promise<void> {
  if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH host reference is invalid");
  try {
    const provider = requireProvider();
    const activate = provider.activate;
    if (typeof activate !== "function") throw unsupportedCapability("activate");
    await Reflect.apply(activate, provider, [hostId]);
  } catch (error) {
    throw safeProviderError(error, `SSH host ${JSON.stringify(hostId)} could not be activated`);
  }
}

/** Resolve and validate one host reference immediately before connection use. */
export async function resolveSshHostRef(hostRef: string): Promise<SshHostProfile> {
  if (typeof hostRef !== "string" || !HOST_ID.test(hostRef)) throw new Error("SSH host reference is invalid");
  let value: unknown;
  try {
    const provider = requireProvider();
    const resolve = provider.resolve;
    if (typeof resolve !== "function") throw invalidProviderResult();
    value = await Reflect.apply(resolve, provider, [hostRef]);
  } catch (error) {
    throw safeProviderError(error, `SSH host reference ${JSON.stringify(hostRef)} could not be resolved`);
  }
  try {
    const profile = validateProfile(value);
    if (profile.id !== hostRef) throw invalidProviderResult();
    return profile;
  } catch (error) {
    throw safeValidationError(error, invalidProviderResult);
  }
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

function unsupportedCapability(capability: "listPickerEntries" | "activate"): SshHostProviderError {
  return new SshHostProviderError(
    "unsupported-capability",
    `SSH host provider does not support the ${capability} capability.`,
  );
}

function safeProviderError(error: unknown, fallback: string): Error {
  try {
    if (error instanceof SshHostProviderError) return error;
  } catch {
    // Treat hostile proxy errors as untrusted provider failures.
  }
  return new SshHostProviderError("refresh-failed", fallback);
}

function safeValidationError(
  error: unknown,
  fallback: () => SshHostProviderError,
): SshHostProviderError {
  try {
    if (error instanceof SshHostProviderError) return error;
  } catch {
    // Treat hostile proxy errors as invalid provider results.
  }
  return fallback();
}

function invalidProviderResult(): SshHostProviderError {
  return new SshHostProviderError(
    "invalid-provider-result",
    "SSH host provider returned an invalid non-secret profile",
  );
}

function invalidPickerResult(): SshHostProviderError {
  return new SshHostProviderError(
    "invalid-provider-result",
    "SSH host provider returned invalid non-secret picker entries",
  );
}

function validatePickerEntries(value: unknown): readonly SshHostPickerEntry[] {
  if (!Array.isArray(value) || value.length > 256) throw invalidPickerResult();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => {
    if (key === "length") return false;
    return typeof key !== "string" || !arrayIndex(key, value.length);
  })) {
    throw invalidPickerResult();
  }

  const entries: SshHostPickerEntry[] = [];
  const ids = new Set<string>();
  let selectedCount = 0;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw invalidPickerResult();
    const entry = validatePickerEntry(descriptor.value);
    if (ids.has(entry.id)) throw invalidPickerResult();
    ids.add(entry.id);
    if (entry.selected && ++selectedCount > 1) throw invalidPickerResult();
    entries.push(entry);
  }
  return entries;
}

function validatePickerEntry(value: unknown): SshHostPickerEntry {
  const entry = exactPublicRecord(value, PICKER_KEYS);
  const id = boundedString(entry.id, 1, 64);
  const label = boundedString(entry.label, 1, 128, true);
  const host = boundedString(entry.host, 1, 253);
  const user = boundedString(entry.user, 1, 128);
  if (!HOST_ID.test(id) || /\s|\p{Cc}/u.test(host) || /\s|\p{Cc}/u.test(user)) {
    throw invalidPickerResult();
  }
  if (!Number.isInteger(entry.port) || (entry.port as number) < 1 || (entry.port as number) > 65_535) {
    throw invalidPickerResult();
  }
  if (typeof entry.shell !== "string" || !PICKER_SHELLS.has(entry.shell as SshHostPickerShell)
    || typeof entry.selected !== "boolean") {
    throw invalidPickerResult();
  }
  return {
    id,
    label,
    host,
    user,
    port: entry.port as number,
    shell: entry.shell as SshHostPickerShell,
    selected: entry.selected,
  };
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

function exactPublicRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidPickerResult();
  let prototype: object | null;
  let actual: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    actual = Reflect.ownKeys(value);
  } catch {
    throw invalidPickerResult();
  }
  if (prototype !== Object.prototype && prototype !== null) throw invalidPickerResult();
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw invalidPickerResult();
  }

  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw invalidPickerResult();
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw invalidPickerResult();
    record[key] = descriptor.value;
  }
  return record;
}

function arrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function boundedString(value: unknown, minimum: number, maximum: number, allowWhitespace = false): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw invalidProviderResult();
  }
  if (!allowWhitespace && /\s/u.test(value)) throw invalidProviderResult();
  return value;
}

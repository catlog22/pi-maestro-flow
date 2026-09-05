import { createHash, randomUUID } from "node:crypto";

export const SSH_MANAGER_DATA_VERSION = 2 as const;
export const SSH_MANAGER_LEGACY_DATA_VERSION = 1 as const;
export const SSH_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SSH_HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const SSH_KEY_FINGERPRINT_PATTERN = SSH_HOST_KEY_PATTERN;
export const SSH_MAX_HOSTS = 256;
export const SSH_MAX_KEYS = 64;
export const SSH_MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
export const SSH_MAX_PRIVATE_KEYS_BYTES = 4 * 1024 * 1024;

export type SshShell = "bash" | "powershell";

export type SshAuth =
  | { kind: "agent" }
  | { kind: "identity"; path: string; passphrase?: string }
  | { kind: "password"; password: string }
  | { kind: "key"; keyId: string };

export interface SshKey {
  id: string;
  label: string;
  privateKey: string;
  passphrase?: string;
  publicKeyFingerprint: string;
  createdAt: string;
}

export interface SshHost {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  shell: SshShell;
  hostKey: string | null;
  auth: SshAuth;
  tags: string[];
  jumpHostId: string | null;
  monitorEnabled: boolean;
}

/** Accepted by compatibility entry points; persisted v2 hosts are always fully materialized. */
export type SshHostInput = Omit<SshHost, "tags" | "jumpHostId" | "monitorEnabled"> &
  Partial<Pick<SshHost, "tags" | "jumpHostId" | "monitorEnabled">>;

export interface SshManagerData {
  version: typeof SSH_MANAGER_DATA_VERSION;
  revision: number;
  keys: SshKey[];
  hosts: SshHost[];
}

export interface LegacySshManagerData {
  version: typeof SSH_MANAGER_LEGACY_DATA_VERSION;
  revision: number;
  hosts: Array<Omit<SshHost, "tags" | "jumpHostId" | "monitorEnabled"> & { hostKey: string; auth: Exclude<SshAuth, { kind: "key" }> }>;
}

const HOST_KEYS = new Set(["id", "label", "host", "user", "port", "shell", "hostKey", "auth", "tags", "jumpHostId", "monitorEnabled"]);
const LEGACY_HOST_KEYS = new Set(["id", "label", "host", "user", "port", "shell", "hostKey", "auth"]);
const KEY_KEYS = new Set(["id", "label", "privateKey", "passphrase", "publicKeyFingerprint", "createdAt"]);
const AUTH_KEYS = new Map<string, ReadonlySet<string>>([
  ["agent", new Set(["kind"])],
  ["identity", new Set(["kind", "path", "passphrase"])],
  ["password", new Set(["kind", "password"])],
  ["key", new Set(["kind", "keyId"])],
]);
const DATA_KEYS = new Set(["version", "revision", "keys", "hosts"]);
const LEGACY_DATA_KEYS = new Set(["version", "revision", "hosts"]);

export function createSshHostId(): string { return randomUUID(); }
export function createSshKeyId(): string { return randomUUID(); }

export function validateSshHost(value: unknown): SshHost {
  const host = requireRecord(value, "SSH host");
  const legacyShape = !Object.hasOwn(host, "tags") && !Object.hasOwn(host, "jumpHostId") && !Object.hasOwn(host, "monitorEnabled");
  requireExactKeys(host, legacyShape ? LEGACY_HOST_KEYS : HOST_KEYS, "SSH host");
  return validateHostFields(host, legacyShape);
}

function validateStoredSshHost(value: unknown): SshHost {
  const host = requireRecord(value, "SSH host");
  requireExactKeys(host, HOST_KEYS, "SSH host");
  return validateHostFields(host, false);
}

function validateHostFields(host: Record<string, unknown>, legacyShape: boolean): SshHost {
  const id = requireId(host.id, "host");
  const label = requireCleanString(host.label, "label", 1, 128);
  const hostname = requireCleanString(host.host, "host", 1, 253, true);
  const user = requireCleanString(host.user, "user", 1, 128, true);
  if (!Number.isInteger(host.port) || (host.port as number) < 1 || (host.port as number) > 65_535) throw new Error("SSH host port must be an integer between 1 and 65535");
  if (host.shell !== "bash" && host.shell !== "powershell") throw new Error("SSH host shell must be bash or powershell");
  if (host.hostKey !== null && (typeof host.hostKey !== "string" || !SSH_HOST_KEY_PATTERN.test(host.hostKey))) throw new Error("SSH host key must be null or a pinned SHA256 fingerprint");
  const tags = legacyShape ? [] : validateTags(host.tags);
  if (!legacyShape && host.jumpHostId !== null && (typeof host.jumpHostId !== "string" || !SSH_HOST_ID_PATTERN.test(host.jumpHostId))) throw new Error("SSH jump host id is invalid");
  if (!legacyShape && typeof host.monitorEnabled !== "boolean") throw new Error("SSH monitorEnabled must be boolean");
  return { id, label, host: hostname, user, port: host.port as number, shell: host.shell, hostKey: host.hostKey as string | null, auth: validateSshAuth(host.auth), tags, jumpHostId: legacyShape ? null : host.jumpHostId as string | null, monitorEnabled: legacyShape ? false : host.monitorEnabled as boolean };
}

export function validateSshKey(value: unknown): SshKey {
  const key = requireRecord(value, "SSH key");
  requireExactKeys(key, KEY_KEYS, "SSH key", new Set(["passphrase"]));
  const id = requireId(key.id, "key");
  const label = requireCleanString(key.label, "key label", 1, 128);
  const privateKey = requireBoundedUtf8(key.privateKey, "private key", 1, SSH_MAX_PRIVATE_KEY_BYTES);
  rejectControlExceptNewlines(privateKey, "private key");
  let passphrase: string | undefined;
  if (key.passphrase !== undefined) passphrase = requireCleanString(key.passphrase, "key passphrase", 1, 4096);
  if (typeof key.publicKeyFingerprint !== "string" || !SSH_KEY_FINGERPRINT_PATTERN.test(key.publicKeyFingerprint)) throw new Error("SSH public key fingerprint must be SHA256");
  if (typeof key.createdAt !== "string" || !isCanonicalTimestamp(key.createdAt)) throw new Error("SSH key createdAt must be an ISO timestamp");
  return { id, label, privateKey, ...(passphrase === undefined ? {} : { passphrase }), publicKeyFingerprint: key.publicKeyFingerprint, createdAt: key.createdAt };
}

export function validateSshKeys(value: unknown): SshKey[] {
  if (!Array.isArray(value)) throw new Error("SSH keys must be an array");
  if (value.length > SSH_MAX_KEYS) throw new Error(`SSH key count exceeds ${SSH_MAX_KEYS}`);
  const keys = value.map(validateSshKey);
  requireUniqueIds(keys, "key");
  const bytes = keys.reduce((total, key) => total + Buffer.byteLength(key.privateKey, "utf8"), 0);
  if (bytes > SSH_MAX_PRIVATE_KEYS_BYTES) throw new Error("SSH aggregate private key size exceeds 4 MiB");
  return keys;
}

export function validateSshHosts(value: unknown): SshHost[] {
  if (!Array.isArray(value)) throw new Error("SSH hosts must be an array");
  if (value.length > SSH_MAX_HOSTS) throw new Error(`SSH host count exceeds ${SSH_MAX_HOSTS}`);
  const hosts = value.map(validateSshHost);
  requireUniqueIds(hosts, "host");
  return hosts;
}

function validateStoredSshHosts(value: unknown): SshHost[] {
  if (!Array.isArray(value)) throw new Error("SSH hosts must be an array");
  if (value.length > SSH_MAX_HOSTS) throw new Error(`SSH host count exceeds ${SSH_MAX_HOSTS}`);
  const hosts = value.map(validateStoredSshHost);
  requireUniqueIds(hosts, "host");
  return hosts;
}

export function validateSshManagerData(value: unknown): SshManagerData {
  const data = requireRecord(value, "SSH manager data");
  requireExactKeys(data, DATA_KEYS, "SSH manager data");
  if (data.version !== SSH_MANAGER_DATA_VERSION) throw new Error("Unsupported SSH manager data version");
  const revision = validateRevision(data.revision);
  const keys = validateSshKeys(data.keys);
  const hosts = validateStoredSshHosts(data.hosts);
  validateReferencesAndGraph(hosts, keys);
  return { version: SSH_MANAGER_DATA_VERSION, revision, keys, hosts };
}

export function validateLegacySshManagerData(value: unknown): LegacySshManagerData {
  const data = requireRecord(value, "legacy SSH manager data");
  requireExactKeys(data, LEGACY_DATA_KEYS, "legacy SSH manager data");
  if (data.version !== SSH_MANAGER_LEGACY_DATA_VERSION) throw new Error("Unsupported legacy SSH manager data version");
  const revision = validateRevision(data.revision);
  if (!Array.isArray(data.hosts) || data.hosts.length > SSH_MAX_HOSTS) throw new Error("Invalid legacy SSH hosts");
  const hosts = data.hosts.map((value) => {
    const host = requireRecord(value, "legacy SSH host");
    requireExactKeys(host, LEGACY_HOST_KEYS, "legacy SSH host");
    const normalized = validateHostFields(host, true);
    if (normalized.hostKey === null || normalized.auth.kind === "key") throw new Error("Invalid legacy SSH host");
    return { id: normalized.id, label: normalized.label, host: normalized.host, user: normalized.user, port: normalized.port, shell: normalized.shell, hostKey: normalized.hostKey, auth: normalized.auth };
  });
  requireUniqueIds(hosts, "host");
  return { version: SSH_MANAGER_LEGACY_DATA_VERSION, revision, hosts };
}

export function migrateLegacySshManagerData(data: LegacySshManagerData): SshManagerData {
  return validateSshManagerData({ version: SSH_MANAGER_DATA_VERSION, revision: data.revision + 1, keys: [], hosts: data.hosts.map((host) => ({ ...host, tags: [], jumpHostId: null, monitorEnabled: false })) });
}

export function replaceSshHost(hosts: readonly SshHost[], id: string, replacement: unknown): SshHost[] {
  const index = hosts.findIndex((host) => host.id === id);
  if (index < 0) throw new Error("SSH host was not found");
  const next = validateSshHost(replacement);
  if (next.id !== id) throw new Error("SSH host id cannot change during edit");
  const copy = hosts.map(cloneSshHost); copy[index] = next; return validateSshHosts(copy);
}

export function replaceSshKey(keys: readonly SshKey[], id: string, replacement: unknown): SshKey[] {
  const index = keys.findIndex((key) => key.id === id);
  if (index < 0) throw new Error("SSH key was not found");
  const next = validateSshKey(replacement);
  if (next.id !== id) throw new Error("SSH key id cannot change during edit");
  const copy = keys.map(cloneSshKey); copy[index] = next; return validateSshKeys(copy);
}

export function cloneSshHost(host: SshHost): SshHost { return structuredClone(host); }
export function cloneSshKey(key: SshKey): SshKey { return structuredClone(key); }

export function reverseSshHostDependencyClosure(hosts: readonly SshHost[], hostId: string): string[] {
  if (!hosts.some((host) => host.id === hostId)) throw new Error("SSH host was not found");
  const closure = new Set([hostId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const host of hosts) if (host.jumpHostId && closure.has(host.jumpHostId) && !closure.has(host.id)) { closure.add(host.id); changed = true; }
  }
  return hosts.filter((host) => closure.has(host.id)).map((host) => host.id);
}

export function effectiveSshHostDigest(data: SshManagerData, hostId: string): string {
  const hosts = new Map(data.hosts.map((host) => [host.id, host]));
  const keys = new Map(data.keys.map((key) => [key.id, key]));
  const chain: unknown[] = [];
  let current = hosts.get(hostId);
  if (!current) throw new Error("SSH host was not found");
  while (current) {
    const auth = current.auth.kind === "key" ? { kind: "key", keyId: current.auth.keyId, publicKeyFingerprint: keys.get(current.auth.keyId)!.publicKeyFingerprint } : { kind: current.auth.kind };
    chain.push({ id: current.id, host: current.host, user: current.user, port: current.port, shell: current.shell, hostKey: current.hostKey, auth });
    current = current.jumpHostId ? hosts.get(current.jumpHostId) : undefined;
  }
  return createHash("sha256").update(JSON.stringify(chain)).digest("hex");
}
export const sshHostEffectiveDigest = effectiveSshHostDigest;

function validateReferencesAndGraph(hosts: SshHost[], keys: SshKey[]): void {
  const hostIds = new Set(hosts.map((host) => host.id));
  const keyIds = new Set(keys.map((key) => key.id));
  for (const host of hosts) {
    if (host.auth.kind === "key" && !keyIds.has(host.auth.keyId)) throw new Error("SSH host references a missing key");
    if (host.jumpHostId !== null && !hostIds.has(host.jumpHostId)) throw new Error("SSH host references a missing jump host");
    const seen = new Set([host.id]);
    let ancestor = host.jumpHostId;
    let depth = 0;
    while (ancestor !== null) {
      if (seen.has(ancestor)) throw new Error("SSH jump host graph contains a cycle");
      seen.add(ancestor); depth++;
      if (depth > 5) throw new Error("SSH jump host ancestor depth exceeds 5");
      ancestor = hosts.find((candidate) => candidate.id === ancestor)!.jumpHostId;
    }
  }
}

function validateSshAuth(value: unknown): SshAuth {
  const auth = requireRecord(value, "SSH authentication");
  if (typeof auth.kind !== "string" || !AUTH_KEYS.has(auth.kind)) throw new Error("SSH authentication kind must be agent, identity, password, or key");
  requireExactKeys(auth, AUTH_KEYS.get(auth.kind)!, "SSH authentication", new Set(["passphrase"]));
  if (auth.kind === "agent") return { kind: "agent" };
  if (auth.kind === "key") return { kind: "key", keyId: requireId(auth.keyId, "key") };
  if (auth.kind === "identity") {
    const path = requireCleanString(auth.path, "identity path", 1, 4096);
    if (auth.passphrase === undefined) return { kind: "identity", path };
    return { kind: "identity", path, passphrase: requireCleanString(auth.passphrase, "identity passphrase", 1, 4096) };
  }
  return { kind: "password", password: requireCleanString(auth.password, "password", 1, 4096) };
}

function validateTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("SSH host tags must contain at most 16 entries");
  const tags = value.map((tag) => requireCleanString(tag, "tag", 1, 32));
  if (new Set(tags).size !== tags.length) throw new Error("SSH host tags must be unique");
  return tags;
}
function validateRevision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("SSH manager revision is invalid"); return value as number; }
function requireId(value: unknown, kind: string): string { const id = requireBoundedString(value, `${kind} id`, 1, 64); if (!SSH_HOST_ID_PATTERN.test(id)) throw new Error(`SSH ${kind} id is invalid`); return id; }
function requireUniqueIds(values: Array<{ id: string }>, kind: string): void { const ids = new Set<string>(); for (const value of values) { if (ids.has(value.id)) throw new Error(`Duplicate SSH ${kind} id: ${value.id}`); ids.add(value.id); } }
function requireRecord(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as Record<string, unknown>; }
function requireExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string, optional = new Set<string>()): void { for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name} contains unsupported field: ${key}`); for (const key of allowed) if (!(key in value) && !optional.has(key)) throw new Error(`${name} is missing field: ${key}`); }
function requireBoundedString(value: unknown, name: string, minimum: number, maximum: number): string { if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new Error(`SSH ${name} must contain ${minimum}-${maximum} characters`); return value; }
function requireBoundedUtf8(value: unknown, name: string, minimum: number, maximum: number): string { if (typeof value !== "string") throw new Error(`SSH ${name} must be a string`); const size = Buffer.byteLength(value, "utf8"); if (size < minimum || size > maximum) throw new Error(`SSH ${name} must contain ${minimum}-${maximum} UTF-8 bytes`); return value; }
function requireCleanString(value: unknown, name: string, minimum: number, maximum: number, whitespace = false): string { const result = requireBoundedString(value, name, minimum, maximum); if (whitespace ? /\s|\p{Cc}/u.test(result) : /\p{Cc}/u.test(result)) throw new Error(`SSH ${name} contains ${whitespace ? "whitespace or " : ""}control characters`); return result; }
function rejectControlExceptNewlines(value: string, name: string): void { if (/[^\P{Cc}\r\n\t]/u.test(value)) throw new Error(`SSH ${name} contains unsupported control characters`); }
function isCanonicalTimestamp(value: string): boolean { const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value; }

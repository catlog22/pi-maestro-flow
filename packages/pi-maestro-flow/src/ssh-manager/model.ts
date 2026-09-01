import { randomUUID } from "node:crypto";

export const SSH_MANAGER_DATA_VERSION = 1 as const;
export const SSH_HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SSH_HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

export type SshShell = "bash" | "powershell";

export type SshAuth =
  | { kind: "agent" }
  | { kind: "identity"; path: string; passphrase?: string }
  | { kind: "password"; password: string };

export interface SshHost {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  shell: SshShell;
  hostKey: string;
  auth: SshAuth;
}

export interface SshManagerData {
  version: typeof SSH_MANAGER_DATA_VERSION;
  revision: number;
  hosts: SshHost[];
}

const HOST_KEYS = new Set(["id", "label", "host", "user", "port", "shell", "hostKey", "auth"]);
const AUTH_KEYS = new Map<string, ReadonlySet<string>>([
  ["agent", new Set(["kind"])],
  ["identity", new Set(["kind", "path", "passphrase"])],
  ["password", new Set(["kind", "password"])],
]);
const DATA_KEYS = new Set(["version", "revision", "hosts"]);

export function createSshHostId(): string {
  return randomUUID();
}

export function validateSshHost(value: unknown): SshHost {
  const host = requireRecord(value, "SSH host");
  requireExactKeys(host, HOST_KEYS, "SSH host");
  const id = requireBoundedString(host.id, "id", 1, 64);
  if (!SSH_HOST_ID_PATTERN.test(id)) throw new Error("SSH host id is invalid");
  const label = requireBoundedString(host.label, "label", 1, 128);
  rejectControl(label, "label");
  const hostname = requireBoundedString(host.host, "host", 1, 253);
  const user = requireBoundedString(host.user, "user", 1, 128);
  rejectControlOrWhitespace(hostname, "host");
  rejectControlOrWhitespace(user, "user");
  if (!Number.isInteger(host.port) || (host.port as number) < 1 || (host.port as number) > 65_535) {
    throw new Error("SSH host port must be an integer between 1 and 65535");
  }
  if (host.shell !== "bash" && host.shell !== "powershell") {
    throw new Error("SSH host shell must be bash or powershell");
  }
  if (typeof host.hostKey !== "string" || !SSH_HOST_KEY_PATTERN.test(host.hostKey)) {
    throw new Error("SSH host key must be a pinned SHA256 fingerprint");
  }
  const hostKey = host.hostKey;
  const auth = validateSshAuth(host.auth);
  return {
    id,
    label,
    host: hostname,
    user,
    port: host.port as number,
    shell: host.shell,
    hostKey,
    auth,
  };
}

export function validateSshHosts(value: unknown): SshHost[] {
  if (!Array.isArray(value)) throw new Error("SSH hosts must be an array");
  if (value.length > 256) throw new Error("SSH host count exceeds 256");
  const hosts = value.map(validateSshHost);
  const ids = new Set<string>();
  for (const host of hosts) {
    if (ids.has(host.id)) throw new Error(`Duplicate SSH host id: ${host.id}`);
    ids.add(host.id);
  }
  return hosts;
}

export function validateSshManagerData(value: unknown): SshManagerData {
  const data = requireRecord(value, "SSH manager data");
  requireExactKeys(data, DATA_KEYS, "SSH manager data");
  if (data.version !== SSH_MANAGER_DATA_VERSION) throw new Error("Unsupported SSH manager data version");
  if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 0) {
    throw new Error("SSH manager revision is invalid");
  }
  return {
    version: SSH_MANAGER_DATA_VERSION,
    revision: data.revision as number,
    hosts: validateSshHosts(data.hosts),
  };
}

export function replaceSshHost(hosts: readonly SshHost[], id: string, replacement: unknown): SshHost[] {
  const index = hosts.findIndex((host) => host.id === id);
  if (index < 0) throw new Error("SSH host was not found");
  const next = validateSshHost(replacement);
  if (next.id !== id) throw new Error("SSH host id cannot change during edit");
  const copy = hosts.map(cloneSshHost);
  copy[index] = next;
  return validateSshHosts(copy);
}

export function cloneSshHost(host: SshHost): SshHost {
  return structuredClone(host);
}

function validateSshAuth(value: unknown): SshAuth {
  const auth = requireRecord(value, "SSH authentication");
  if (typeof auth.kind !== "string" || !AUTH_KEYS.has(auth.kind)) {
    throw new Error("SSH authentication kind must be agent, identity, or password");
  }
  requireExactKeys(auth, AUTH_KEYS.get(auth.kind)!, "SSH authentication");
  if (auth.kind === "agent") return { kind: "agent" };
  if (auth.kind === "identity") {
    const path = requireBoundedString(auth.path, "identity path", 1, 4096);
    rejectControl(path, "identity path");
    if (auth.passphrase === undefined) return { kind: "identity", path };
    const passphrase = requireBoundedString(auth.passphrase, "identity passphrase", 1, 4096);
    rejectControl(passphrase, "identity passphrase");
    return { kind: "identity", path, passphrase };
  }
  const password = requireBoundedString(auth.password, "password", 1, 4096);
  rejectControl(password, "password");
  return { kind: "password", password };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${name} contains unsupported field: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value) && !(name === "SSH authentication" && key === "passphrase")) {
      throw new Error(`${name} is missing field: ${key}`);
    }
  }
}

function requireBoundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`SSH ${name} must contain ${minimum}-${maximum} characters`);
  }
  return value;
}

function rejectControl(value: string, name: string): void {
  if (/\p{Cc}/u.test(value)) throw new Error(`SSH ${name} contains control characters`);
}

function rejectControlOrWhitespace(value: string, name: string): void {
  if (/\s|\p{Cc}/u.test(value)) throw new Error(`SSH ${name} contains whitespace or control characters`);
}

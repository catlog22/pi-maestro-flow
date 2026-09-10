import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
} from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SSH_MANAGER_DATA_VERSION,
  cloneSshGatewayBinding,
  cloneSshHost,
  cloneSshKey,
  effectiveSshHostDigest,
  migrateLegacySshManagerData,
  migrateSshManagerDataV2,
  migrateSshManagerDataV3,
  replaceSshHost,
  replaceSshKey,
  reverseSshHostDependencyClosure,
  validateLegacySshManagerData,
  validateSshGatewayBinding,
  validateSshGatewayLaunchBinding,
  validateSshHost,
  validateSshHosts,
  validateSshKey,
  validateSshKeys,
  validateSshManagerData,
  validateSshManagerDataV2,
  validateSshManagerDataV3,
  type LegacySshManagerData,
  type SshGatewayBinding,
  type SshGatewayLaunchBinding,
  type SshHost,
  type SshKey,
  type SshManagerData,
  type SshManagerDataV2,
  type SshManagerDataV3,
} from "./model.ts";

const ENVELOPE_VERSION = 1 as const;
const KDF_NAME = "scrypt" as const;
const CIPHER_NAME = "aes-256-gcm" as const;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30_000;
const ENVELOPE_KEYS = new Set(["version", "kdf", "cipher", "salt", "iv", "tag", "ciphertext"]);
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: { realpath: boolean; stale: number; update: number }): Promise<() => Promise<void>>;
};
const KDF_KEYS = new Set(["name", "N", "r", "p", "keyLength"]);
const CIPHER_KEYS = new Set(["name"]);

interface StoreEnvelope {
  version: typeof ENVELOPE_VERSION;
  kdf: {
    name: typeof KDF_NAME;
    N: typeof SCRYPT_N;
    r: typeof SCRYPT_R;
    p: typeof SCRYPT_P;
    keyLength: typeof KEY_BYTES;
  };
  cipher: { name: typeof CIPHER_NAME };
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedSshStoreOptions {
  path?: string;
}

export type MasterPassword = string | Uint8Array;

export function defaultSshManagerStorePath(): string {
  return join(homedir(), ".pi", "agent", "ssh-manager", "hosts.enc.json");
}

export class EncryptedSshStore {
  readonly path: string;
  private key: Buffer | undefined;
  private salt: Buffer | undefined;
  private data: SshManagerData | undefined;
  private lifecycleGeneration = 0;

  constructor(options: EncryptedSshStoreOptions = {}) {
    this.path = options.path ?? defaultSshManagerStorePath();
  }

  get locked(): boolean {
    return !this.key || !this.data || !this.salt;
  }

  async create(masterPassword: MasterPassword, hosts: unknown[] = []): Promise<void> {
    if (!this.locked) throw new Error("SSH manager store is already unlocked");
    const generation = ++this.lifecycleGeneration;
    const salt = randomBytes(SALT_BYTES);
    let key: Buffer | undefined;
    let data: SshManagerData | undefined;
    try {
      key = await deriveKey(masterPassword, salt);
      data = validateSshManagerData({
        version: SSH_MANAGER_DATA_VERSION,
        revision: 0,
        keys: [],
        hosts: validateSshHosts(hosts),
        gatewayBindings: [],
        gatewayLaunchBindings: [],
      });
      const envelope = encryptData(data, key, salt);
      await withStoreLock(this.path, async () => {
        await assertMissing(this.path);
        await atomicPrivateWrite(this.path, serializeEnvelope(envelope), false);
      });
      if (generation !== this.lifecycleGeneration) throw new Error("SSH manager lifecycle changed during creation");
      this.key = key;
      this.salt = Buffer.from(salt);
      this.data = data;
      key = undefined;
      data = undefined;
    } finally {
      key?.fill(0);
      salt.fill(0);
      if (data) clearDataSecrets(data);
    }
  }

  async unlock(masterPassword: MasterPassword): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.clearResidentState();
    let key: Buffer | undefined;
    let salt: Buffer | undefined;
    let initial: SshManagerData | SshManagerDataV3 | SshManagerDataV2 | LegacySshManagerData | undefined;
    let data: SshManagerData | undefined;
    try {
      const envelope = await readEnvelope(this.path);
      salt = decodeFixedBase64(envelope.salt, SALT_BYTES, "salt");
      key = await deriveKey(masterPassword, salt);
      initial = decryptDataAnyVersion(envelope, key);
      if (initial.version === SSH_MANAGER_DATA_VERSION) {
        data = initial;
        initial = undefined;
      } else {
        data = await this.migrateUnderLock(initial, key, salt);
      }
      if (generation !== this.lifecycleGeneration) throw new Error("SSH manager lifecycle changed during unlock");
      this.key = key;
      this.salt = salt;
      this.data = data;
      key = undefined;
      salt = undefined;
      data = undefined;
    } catch {
      if (generation === this.lifecycleGeneration) this.clearResidentState();
      throw new Error("Unable to unlock SSH manager store");
    } finally {
      key?.fill(0);
      salt?.fill(0);
      if (initial) clearDataSecrets(initial);
      if (data) clearDataSecrets(data);
    }
  }

  lock(): void {
    this.lifecycleGeneration++;
    this.clearResidentState();
  }

  private clearResidentState(): void {
    this.key?.fill(0);
    this.salt?.fill(0);
    this.key = undefined;
    this.salt = undefined;
    if (this.data) clearDataSecrets(this.data);
    this.data = undefined;
  }

  getHosts(): SshHost[] { return this.requireData().hosts.map(cloneSshHost); }
  getKeys(): SshKey[] { return this.requireData().keys.map(cloneSshKey); }
  getGatewayBinding(hostId: string): SshGatewayBinding | undefined {
    const binding = this.requireData().gatewayBindings.find((candidate) => candidate.hostId === hostId);
    return binding ? cloneSshGatewayBinding(binding) : undefined;
  }
  getGatewayLaunchBinding(hostId: string, bindingId: string): SshGatewayLaunchBinding | undefined {
    const binding = this.requireData().gatewayLaunchBindings.find((candidate) => candidate.hostId === hostId && candidate.bindingId === bindingId);
    return binding ? { ...binding } : undefined;
  }
  getGatewayBindingFence(hostId: string): string {
    const binding = this.getGatewayBinding(hostId);
    return binding ? createHash("sha256").update(JSON.stringify(binding)).digest("hex") : "stdio";
  }
  getConnectionConfigFence(hostId: string): string {
    const data = this.requireData();
    if (!this.key) throw new Error("SSH manager is locked");
    const hosts = new Map(data.hosts.map((host) => [host.id, host]));
    const keys = new Map(data.keys.map((key) => [key.id, key]));
    const chain: unknown[] = [];
    let current = hosts.get(hostId);
    if (!current) throw new Error("SSH host was not found");
    while (current) {
      const authentication = current.auth.kind === "key"
        ? { ...current.auth, key: keys.get(current.auth.keyId) }
        : current.auth;
      chain.push({
        id: current.id,
        host: current.host,
        user: current.user,
        port: current.port,
        shell: current.shell,
        hostKey: current.hostKey,
        authentication,
      });
      current = current.jumpHostId ? hosts.get(current.jumpHostId) : undefined;
    }
    const binding = data.gatewayBindings.find((candidate) => candidate.hostId === hostId) ?? null;
    return createHmac("sha256", this.key).update(JSON.stringify({ chain, binding })).digest("hex");
  }
  checkoutKey(id: string): SshKey {
    const key = this.requireData().keys.find((candidate) => candidate.id === id);
    if (!key) throw new Error("SSH key was not found");
    return cloneSshKey(key);
  }
  getReverseDependencyClosure(hostId: string): string[] { return reverseSshHostDependencyClosure(this.requireData().hosts, hostId); }
  getEffectiveHostDigest(hostId: string): string { return effectiveSshHostDigest(this.requireData(), hostId); }

  get revision(): number { return this.requireData().revision; }

  async save(hosts: unknown = this.requireData().hosts): Promise<void> {
    await this.saveConfiguration(hosts, this.requireData().keys);
  }

  async saveKeys(keys: unknown): Promise<void> { await this.saveConfiguration(this.requireData().hosts, keys); }
  async saveConfiguration(hosts: unknown, keys: unknown): Promise<void> { await this.saveData(hosts, keys); }
  async saveGatewayBinding(hostId: string, binding: unknown, expectedRevision: number, expectedDigest: string): Promise<void> {
    const current = this.requireData();
    if (current.revision !== expectedRevision || effectiveSshHostDigest(current, hostId) !== expectedDigest) throw new Error("SSH configuration changed during Gateway pairing");
    const nextBinding = validateSshGatewayBinding(binding);
    if (nextBinding.hostId !== hostId || nextBinding.effectiveHostDigest !== expectedDigest) throw new Error("SSH Gateway binding does not match the pinned host configuration");
    await this.saveData(
      current.hosts,
      current.keys,
      [...current.gatewayBindings.filter((item) => item.hostId !== hostId), nextBinding],
      current.gatewayLaunchBindings.filter((item) => item.hostId !== hostId),
    );
  }
  async removeGatewayBinding(hostId: string): Promise<boolean> {
    const current = this.requireData();
    const bindings = current.gatewayBindings.filter((binding) => binding.hostId !== hostId);
    if (bindings.length === current.gatewayBindings.length) return false;
    await this.saveData(current.hosts, current.keys, bindings, current.gatewayLaunchBindings.filter((binding) => binding.hostId !== hostId));
    return true;
  }
  async saveGatewayLaunchBinding(binding: unknown): Promise<void> {
    const current = this.requireData();
    const next = validateSshGatewayLaunchBinding(binding);
    if (effectiveSshHostDigest(current, next.hostId) !== next.effectiveHostDigest) throw new Error("SSH Gateway launch binding does not match the pinned host configuration");
    await this.saveData(current.hosts, current.keys, current.gatewayBindings, [
      ...current.gatewayLaunchBindings.filter((item) => item.bindingId !== next.bindingId),
      next,
    ]);
  }
  async removeGatewayLaunchBinding(hostId: string, bindingId: string): Promise<boolean> {
    const current = this.requireData();
    const bindings = current.gatewayLaunchBindings.filter((binding) => binding.hostId !== hostId || binding.bindingId !== bindingId);
    if (bindings.length === current.gatewayLaunchBindings.length) return false;
    await this.saveData(current.hosts, current.keys, current.gatewayBindings, bindings);
    return true;
  }
  async addHost(host: unknown): Promise<void> { await this.save([...this.requireData().hosts, validateSshHost(host)]); }
  async updateHost(id: string, host: unknown): Promise<void> { await this.save(replaceSshHost(this.requireData().hosts, id, host)); }
  async deleteHost(id: string): Promise<void> {
    const data = this.requireData();
    if (!data.hosts.some((host) => host.id === id)) throw new Error("SSH host was not found");
    if (data.hosts.some((host) => host.jumpHostId === id)) throw new Error("SSH host is referenced as a jump host");
    await this.save(data.hosts.filter((host) => host.id !== id));
  }
  async addKey(key: unknown): Promise<void> { await this.saveKeys([...this.requireData().keys, validateSshKey(key)]); }
  async updateKey(id: string, key: unknown): Promise<void> { await this.saveKeys(replaceSshKey(this.requireData().keys, id, key)); }
  async deleteKey(id: string): Promise<void> {
    const data = this.requireData();
    if (!data.keys.some((key) => key.id === id)) throw new Error("SSH key was not found");
    if (data.hosts.some((host) => host.auth.kind === "key" && host.auth.keyId === id)) throw new Error("SSH key is referenced by a host");
    await this.saveKeys(data.keys.filter((key) => key.id !== id));
  }

  private async saveData(
    hosts: unknown,
    keys: unknown,
    gatewayBindings: readonly SshGatewayBinding[] = this.requireData().gatewayBindings,
    gatewayLaunchBindings: readonly SshGatewayLaunchBinding[] = this.requireData().gatewayLaunchBindings,
  ): Promise<void> {
    const generation = this.lifecycleGeneration;
    const current = this.requireData();
    const key = this.requireKey();
    const salt = this.requireSalt();
    const nextHosts = validateSshHosts(hosts);
    const nextKeys = validateSshKeys(keys);
    const candidate = { version: SSH_MANAGER_DATA_VERSION, revision: current.revision + 1, hosts: nextHosts, keys: nextKeys, gatewayBindings, gatewayLaunchBindings };
    const isCurrentHost = (binding: { hostId: string; effectiveHostDigest: string }): boolean => {
      try { return nextHosts.some((host) => host.id === binding.hostId) && effectiveSshHostDigest(candidate as SshManagerData, binding.hostId) === binding.effectiveHostDigest; }
      catch { return false; }
    };
    const next = validateSshManagerData({
      ...candidate,
      gatewayBindings: gatewayBindings.filter(isCurrentHost),
      gatewayLaunchBindings: gatewayLaunchBindings.filter(isCurrentHost),
    });
    try {
      await withStoreLock(this.path, async () => {
        const envelope = await readEnvelope(this.path);
        const diskSalt = decodeFixedBase64(envelope.salt, SALT_BYTES, "salt");
        let diskData: SshManagerData | undefined;
        try {
          if (!diskSalt.equals(salt)) throw new Error("SSH manager changed while unlocked");
          diskData = decryptData(envelope, key);
          if (diskData.revision !== current.revision) {
            throw new Error(`SSH manager revision conflict: expected ${current.revision}, found ${diskData.revision}`);
          }
          await atomicPrivateWrite(this.path, serializeEnvelope(encryptData(next, key, salt)), true);
        } finally {
          diskSalt.fill(0);
          if (diskData) clearDataSecrets(diskData);
        }
      });
    } catch (error) {
      clearDataSecrets(next);
      throw error;
    }
    if (generation !== this.lifecycleGeneration || this.data !== current) {
      clearDataSecrets(next);
      throw new Error("SSH manager lifecycle changed during save");
    }
    clearDataSecrets(current);
    this.data = next;
  }

  async reload(): Promise<void> {
    const generation = this.lifecycleGeneration;
    const key = this.requireKey();
    const currentSalt = this.requireSalt();
    let envelopeSalt: Buffer | undefined;
    try {
      const envelope = await readEnvelope(this.path);
      envelopeSalt = decodeFixedBase64(envelope.salt, SALT_BYTES, "salt");
      if (!envelopeSalt.equals(currentSalt)) throw new Error("SSH manager salt changed while unlocked");
      const next = decryptData(envelope, key);
      if (generation !== this.lifecycleGeneration) {
        clearDataSecrets(next);
        throw new Error("SSH manager lifecycle changed during reload");
      }
      if (next.revision < this.requireData().revision) throw new Error("SSH manager revision moved backwards");
      clearDataSecrets(this.requireData());
      this.data = next;
    } catch (error) {
      if (generation === this.lifecycleGeneration) this.lock();
      throw error;
    } finally {
      envelopeSalt?.fill(0);
    }
  }

  private async migrateUnderLock(initial: LegacySshManagerData | SshManagerDataV2 | SshManagerDataV3, key: Buffer, salt: Buffer): Promise<SshManagerData> {
    return withStoreLock(this.path, async () => {
      const artifact = await readEnvelopeArtifact(this.path);
      let diskSalt: Buffer | undefined;
      let diskData: SshManagerData | SshManagerDataV3 | SshManagerDataV2 | LegacySshManagerData | undefined;
      let migrated: SshManagerData | undefined;
      let published = false;
      try {
        diskSalt = decodeFixedBase64(artifact.envelope.salt, SALT_BYTES, "salt");
        if (!diskSalt.equals(salt)) throw new Error("SSH manager changed during migration");
        diskData = decryptDataAnyVersion(artifact.envelope, key);
        if (diskData.version !== initial.version || diskData.revision !== initial.revision) throw new Error("SSH manager changed during migration");
        migrated = diskData.version === 1 ? migrateLegacySshManagerData(diskData)
          : diskData.version === 2 ? migrateSshManagerDataV2(diskData)
            : migrateSshManagerDataV3(diskData);
        const backupPath = `${this.path}.v${initial.version}.bak`;
        const existingBackup = await readOptionalEnvelopeArtifact(backupPath);
        try {
          if (existingBackup) {
            if (!existingBackup.content.equals(artifact.content)) throw new Error("SSH manager v1 backup does not match the current store");
          } else {
            await atomicPrivateWrite(backupPath, artifact.content, false);
          }
        } finally {
          existingBackup?.content.fill(0);
        }
        await atomicPrivateWrite(this.path, serializeEnvelope(encryptData(migrated, key, salt)), true);
        published = true;
        return migrated;
      } finally {
        artifact.content.fill(0);
        diskSalt?.fill(0);
        if (diskData) clearDataSecrets(diskData);
        if (migrated && !published) clearDataSecrets(migrated);
      }
    });
  }

  private requireData(): SshManagerData {
    if (!this.data) throw new Error("SSH manager store is locked");
    return this.data;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error("SSH manager store is locked");
    return this.key;
  }

  private requireSalt(): Buffer {
    if (!this.salt) throw new Error("SSH manager store is locked");
    return this.salt;
  }
}

async function deriveKey(password: MasterPassword, salt: Buffer): Promise<Buffer> {
  const passwordBytes = typeof password === "string" ? Buffer.from(password, "utf8") : Buffer.from(password);
  if (passwordBytes.length === 0 || passwordBytes.length > 4096) {
    passwordBytes.fill(0);
    throw new Error("Master password must contain 1-4096 UTF-8 bytes");
  }
  try {
    return await deriveScryptKey(passwordBytes, salt);
  } finally {
    passwordBytes.fill(0);
  }
}

function deriveScryptKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function encryptData(data: SshManagerData, key: Buffer, salt: Buffer): StoreEnvelope {
  const iv = randomBytes(IV_BYTES);
  try {
    const envelope = baseEnvelope(salt, iv);
    const cipher = createCipheriv(CIPHER_NAME, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(authenticatedHeader(envelope), "utf8"));
    const plaintext = Buffer.from(JSON.stringify(data), "utf8");
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        ...envelope,
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    } finally {
      plaintext.fill(0);
    }
  } finally {
    iv.fill(0);
  }
}

function decryptData(envelope: StoreEnvelope, key: Buffer): SshManagerData {
  const data = decryptDataAnyVersion(envelope, key);
  if (data.version !== SSH_MANAGER_DATA_VERSION) {
    clearDataSecrets(data);
    throw new Error("Legacy SSH manager data requires migration");
  }
  return data;
}

function decryptDataAnyVersion(envelope: StoreEnvelope, key: Buffer): SshManagerData | SshManagerDataV3 | SshManagerDataV2 | LegacySshManagerData {
  const iv = decodeFixedBase64(envelope.iv, IV_BYTES, "iv");
  const tag = decodeFixedBase64(envelope.tag, TAG_BYTES, "tag");
  const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CIPHER_NAME, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(authenticatedHeader(envelope), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
    return version === SSH_MANAGER_DATA_VERSION ? validateSshManagerData(parsed)
      : version === 3 ? validateSshManagerDataV3(parsed)
        : version === 2 ? validateSshManagerDataV2(parsed)
          : validateLegacySshManagerData(parsed);
  } finally {
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
    plaintext?.fill(0);
  }
}

function baseEnvelope(salt: Buffer, iv: Buffer): Omit<StoreEnvelope, "tag" | "ciphertext"> {
  return {
    version: ENVELOPE_VERSION,
    kdf: { name: KDF_NAME, N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLength: KEY_BYTES },
    cipher: { name: CIPHER_NAME },
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
  };
}

function authenticatedHeader(envelope: Omit<StoreEnvelope, "tag" | "ciphertext"> | StoreEnvelope): string {
  return JSON.stringify({
    version: envelope.version,
    kdf: envelope.kdf,
    cipher: envelope.cipher,
    salt: envelope.salt,
    iv: envelope.iv,
  });
}

function serializeEnvelope(envelope: StoreEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

async function readEnvelope(path: string): Promise<StoreEnvelope> {
  const artifact = await readEnvelopeArtifact(path);
  try { return artifact.envelope; }
  finally { artifact.content.fill(0); }
}

async function readOptionalEnvelopeArtifact(path: string): Promise<{ envelope: StoreEnvelope; content: Buffer } | undefined> {
  try {
    return await readEnvelopeArtifact(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readEnvelopeArtifact(path: string): Promise<{ envelope: StoreEnvelope; content: Buffer }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("SSH manager store must be a regular non-symlink file");
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  let file: Buffer | undefined;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_STORE_BYTES) {
      throw new Error("Invalid SSH manager envelope size");
    }
    file = Buffer.alloc(Number(metadata.size));
    let offset = 0;
    while (offset < file.length) {
      const { bytesRead } = await handle.read(file, offset, file.length - offset, offset);
      if (bytesRead === 0) throw new Error("SSH manager store changed during read");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    try {
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
        throw new Error("SSH manager store changed during read");
      }
    } finally {
      extra.fill(0);
    }
    const envelope = validateEnvelope(JSON.parse(file.toString("utf8")));
    return { envelope, content: file };
  } catch (error) {
    file?.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

function validateEnvelope(value: unknown): StoreEnvelope {
  const envelope = requireRecord(value, "envelope");
  requireExactKeys(envelope, ENVELOPE_KEYS, "envelope");
  if (envelope.version !== ENVELOPE_VERSION) throw new Error("Unsupported SSH manager envelope version");
  const kdf = requireRecord(envelope.kdf, "kdf");
  requireExactKeys(kdf, KDF_KEYS, "kdf");
  if (kdf.name !== KDF_NAME || kdf.N !== SCRYPT_N || kdf.r !== SCRYPT_R || kdf.p !== SCRYPT_P || kdf.keyLength !== KEY_BYTES) {
    throw new Error("Unsupported SSH manager KDF configuration");
  }
  const cipher = requireRecord(envelope.cipher, "cipher");
  requireExactKeys(cipher, CIPHER_KEYS, "cipher");
  if (cipher.name !== CIPHER_NAME) throw new Error("Unsupported SSH manager cipher configuration");
  for (const field of ["salt", "iv", "tag", "ciphertext"] as const) {
    if (typeof envelope[field] !== "string" || envelope[field].length === 0) throw new Error(`Invalid ${field}`);
  }
  decodeFixedBase64(envelope.salt as string, SALT_BYTES, "salt").fill(0);
  decodeFixedBase64(envelope.iv as string, IV_BYTES, "iv").fill(0);
  decodeFixedBase64(envelope.tag as string, TAG_BYTES, "tag").fill(0);
  decodeBase64(envelope.ciphertext as string, "ciphertext").fill(0);
  return envelope as unknown as StoreEnvelope;
}

function decodeFixedBase64(value: string, bytes: number, name: string): Buffer {
  const decoded = decodeBase64(value, name);
  if (decoded.length !== bytes) {
    decoded.fill(0);
    throw new Error(`Invalid ${name} length`);
  }
  return decoded;
}

function decodeBase64(value: string, name: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${name} encoding`);
  }
  return Buffer.from(value, "base64");
}

async function atomicPrivateWrite(path: string, content: string | Uint8Array, replaceExisting: boolean): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforcePrivateDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await enforcePrivateFile(temporary);
    if (replaceExisting) {
      await rename(temporary, path);
    } else {
      await link(temporary, path);
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    const directoryHandle = await open(directory, "r").catch(() => undefined);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close().catch(() => undefined);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function withStoreLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await enforcePrivateDirectory(dirname(path));
  const startedAt = Date.now();
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try {
      release = await properLockfile.lock(resolve(path), {
        realpath: false,
        stale: LOCK_STALE_MS,
        update: LOCK_STALE_MS / 3,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() - startedAt >= LOCK_WAIT_MS) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
  try {
    return await action();
  } finally {
    await release().catch(() => {
      process.emitWarning("SSH manager lock cleanup failed; stale-lock recovery will apply", {
        code: "SSH_MANAGER_LOCK_RELEASE_FAILED",
      });
    });
  }
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("SSH manager store already exists");
}

async function enforcePrivateDirectory(path: string): Promise<void> {
  await chmod(path, 0o700);
  if (process.platform === "win32") {
    const sid = await currentWindowsSid();
    await replaceWindowsAcl(path, `*${sid}:(OI)(CI)(F)`);
  }
}

async function enforcePrivateFile(path: string): Promise<void> {
  await chmod(path, 0o600);
  if (process.platform === "win32") {
    const sid = await currentWindowsSid();
    await replaceWindowsAcl(path, `*${sid}:(F)`);
  }
}

async function replaceWindowsAcl(path: string, ownerRule: string): Promise<void> {
  const icacls = windowsSystemExecutable("icacls.exe");
  await runWindowsCommand(icacls, [path, "/reset"]);
  await runWindowsCommand(icacls, [path, "/inheritance:r", "/grant:r", ownerRule]);
  await runWindowsCommand(icacls, [path, "/verify"]);
}

let windowsSid: Promise<string> | undefined;
function currentWindowsSid(): Promise<string> {
  windowsSid ??= runWindowsCommand(windowsSystemExecutable("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).then((output) => {
    const match = output.match(/S-\d-(?:\d+-)+\d+/u);
    if (!match) throw new Error("Unable to determine the current Windows user SID");
    return match[0];
  });
  return windowsSid;
}

function windowsSystemExecutable(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

function runWindowsCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error) rejectCommand(error);
      else resolveCommand(stdout);
    });
  });
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid SSH manager ${name}`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, name: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw new Error(`Invalid SSH manager ${name} fields`);
  }
}

function clearDataSecrets(data: SshManagerData | SshManagerDataV3 | SshManagerDataV2 | LegacySshManagerData): void {
  clearHostSecrets(data.hosts);
  if ("keys" in data) {
    for (const key of data.keys) {
      key.privateKey = "";
      if (key.passphrase) key.passphrase = "";
    }
  }
  if ("gatewayBindings" in data) for (const binding of data.gatewayBindings) binding.token = "";
}

function clearHostSecrets(hosts: Array<{ auth: SshHost["auth"] }>): void {
  for (const host of hosts) {
    if (host.auth.kind === "password") host.auth.password = "";
    if (host.auth.kind === "identity" && host.auth.passphrase) host.auth.passphrase = "";
  }
}

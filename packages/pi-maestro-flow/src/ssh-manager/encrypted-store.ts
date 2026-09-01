import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
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
  cloneSshHost,
  validateSshHosts,
  validateSshManagerData,
  type SshHost,
  type SshManagerData,
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

  constructor(options: EncryptedSshStoreOptions = {}) {
    this.path = options.path ?? defaultSshManagerStorePath();
  }

  get locked(): boolean {
    return !this.key || !this.data || !this.salt;
  }

  async create(masterPassword: MasterPassword, hosts: unknown[] = []): Promise<void> {
    if (!this.locked) throw new Error("SSH manager store is already unlocked");
    const validatedHosts = validateSshHosts(hosts);
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(masterPassword, salt);
    const data: SshManagerData = { version: SSH_MANAGER_DATA_VERSION, revision: 0, hosts: validatedHosts };
    try {
      const envelope = encryptData(data, key, salt);
      await withStoreLock(this.path, async () => {
        await assertMissing(this.path);
        await atomicPrivateWrite(this.path, serializeEnvelope(envelope), false);
      });
      this.key = key;
      this.salt = salt;
      this.data = data;
    } catch (error) {
      key.fill(0);
      salt.fill(0);
      throw error;
    }
  }

  async unlock(masterPassword: MasterPassword): Promise<void> {
    this.lock();
    let key: Buffer | undefined;
    let salt: Buffer | undefined;
    try {
      const envelope = await readEnvelope(this.path);
      salt = decodeFixedBase64(envelope.salt, SALT_BYTES, "salt");
      key = await deriveKey(masterPassword, salt);
      const data = decryptData(envelope, key);
      this.key = key;
      this.salt = salt;
      this.data = data;
    } catch {
      key?.fill(0);
      salt?.fill(0);
      this.lock();
      throw new Error("Unable to unlock SSH manager store");
    }
  }

  lock(): void {
    this.key?.fill(0);
    this.salt?.fill(0);
    this.key = undefined;
    this.salt = undefined;
    if (this.data) clearHostSecrets(this.data.hosts);
    this.data = undefined;
  }

  getHosts(): SshHost[] {
    return this.requireData().hosts.map(cloneSshHost);
  }

  get revision(): number {
    return this.requireData().revision;
  }

  async save(hosts: unknown = this.requireData().hosts): Promise<void> {
    const current = this.requireData();
    const key = this.requireKey();
    const salt = this.requireSalt();
    const validatedHosts = validateSshHosts(hosts);
    const next: SshManagerData = {
      version: SSH_MANAGER_DATA_VERSION,
      revision: current.revision + 1,
      hosts: validatedHosts,
    };
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
        if (diskData) clearHostSecrets(diskData.hosts);
      }
    });
    clearHostSecrets(current.hosts);
    this.data = next;
  }

  async reload(): Promise<void> {
    const key = this.requireKey();
    const currentSalt = this.requireSalt();
    let envelopeSalt: Buffer | undefined;
    try {
      const envelope = await readEnvelope(this.path);
      envelopeSalt = decodeFixedBase64(envelope.salt, SALT_BYTES, "salt");
      if (!envelopeSalt.equals(currentSalt)) throw new Error("SSH manager salt changed while unlocked");
      const next = decryptData(envelope, key);
      if (next.revision < this.requireData().revision) throw new Error("SSH manager revision moved backwards");
      clearHostSecrets(this.requireData().hosts);
      this.data = next;
    } catch (error) {
      this.lock();
      throw error;
    } finally {
      envelopeSalt?.fill(0);
    }
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
  const iv = decodeFixedBase64(envelope.iv, IV_BYTES, "iv");
  const tag = decodeFixedBase64(envelope.tag, TAG_BYTES, "tag");
  const ciphertext = decodeBase64(envelope.ciphertext, "ciphertext");
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(CIPHER_NAME, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(authenticatedHeader(envelope), "utf8"));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validateSshManagerData(JSON.parse(plaintext.toString("utf8")));
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
    return validateEnvelope(JSON.parse(file.toString("utf8")));
  } finally {
    file?.fill(0);
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

async function atomicPrivateWrite(path: string, content: string, replaceExisting: boolean): Promise<void> {
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

function clearHostSecrets(hosts: SshHost[]): void {
  for (const host of hosts) {
    if (host.auth.kind === "password") host.auth.password = "";
    if (host.auth.kind === "identity" && host.auth.passphrase) host.auth.passphrase = "";
  }
}

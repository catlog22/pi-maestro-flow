/** Persistent one-time-issued pairing credentials. Raw bearer tokens are never stored. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import { gatewayPairingPath, readGatewayJson, writeGatewayJsonAtomic } from "./state-paths.ts";

const MAX_PAIRING_BYTES = 1024 * 1024;
const MAX_PAIRINGS = 256;

export interface GatewayPairingRecord {
  version: typeof GATEWAY_STATE_VERSION;
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  label?: string;
}
interface PairingDocument { version: typeof GATEWAY_STATE_VERSION; pairings: GatewayPairingRecord[] }
export interface GatewayPairingIssue { id: string; token: string; createdAt: number; expiresAt: number; label?: string }

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
function publicRecord(record: GatewayPairingRecord): Omit<GatewayPairingRecord, "tokenHash"> {
  const { tokenHash: _secret, ...value } = record;
  return value;
}

export class GatewayPairingStore {
  readonly path: string;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { path?: string; now?: () => number } = {}) {
    this.path = options.path ?? gatewayPairingPath();
    this.now = options.now ?? (() => Date.now());
  }

  async issue(options: { ttlMs?: number; label?: string } = {}): Promise<GatewayPairingIssue> {
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 365 * 24 * 60 * 60 * 1000) throw new Error("pairing ttlMs is out of range");
    if (options.label !== undefined && (options.label.trim() === "" || Buffer.byteLength(options.label, "utf8") > 256)) throw new Error("pairing label is invalid");
    return this.mutate(async () => {
      const document = await this.load();
      const now = this.now();
      document.pairings = document.pairings.filter((entry) => entry.expiresAt > now);
      if (document.pairings.length >= MAX_PAIRINGS) throw new Error(`pairing limit ${MAX_PAIRINGS} reached`);
      const token = randomBytes(32).toString("base64url");
      const record: GatewayPairingRecord = {
        version: GATEWAY_STATE_VERSION,
        id: `pair-${randomUUID()}`,
        tokenHash: hashToken(token).toString("hex"),
        createdAt: now,
        expiresAt: now + ttlMs,
        ...(options.label === undefined ? {} : { label: options.label }),
      };
      document.pairings.push(record);
      await this.save(document);
      return { ...publicRecord(record), token };
    });
  }

  async list(): Promise<Array<Omit<GatewayPairingRecord, "tokenHash">>> {
    const document = await this.load();
    const now = this.now();
    return document.pairings.filter((entry) => entry.expiresAt > now).map(publicRecord);
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const document = await this.load();
      const before = document.pairings.length;
      document.pairings = document.pairings.filter((entry) => entry.id !== id);
      if (document.pairings.length === before) return false;
      await this.save(document);
      return true;
    });
  }

  async authenticate(token: string): Promise<Omit<GatewayPairingRecord, "tokenHash"> | undefined> {
    if (!token) return undefined;
    const candidate = hashToken(token);
    const now = this.now();
    for (const record of (await this.load()).pairings) {
      if (record.expiresAt <= now) continue;
      const stored = Buffer.from(record.tokenHash, "hex");
      if (stored.byteLength === candidate.byteLength && timingSafeEqual(stored, candidate)) return publicRecord(record);
    }
    return undefined;
  }

  private async load(): Promise<PairingDocument> {
    const raw = await readGatewayJson<unknown>(this.path, MAX_PAIRING_BYTES);
    if (raw === undefined) return { version: GATEWAY_STATE_VERSION, pairings: [] };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Gateway pairing store");
    const value = raw as { version?: unknown; pairings?: unknown };
    if (value.version !== GATEWAY_STATE_VERSION || !Array.isArray(value.pairings) || value.pairings.length > MAX_PAIRINGS) throw new Error("Invalid Gateway pairing store");
    const pairings = value.pairings.map((item): GatewayPairingRecord => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Gateway pairing record");
      const entry = item as Record<string, unknown>;
      if (entry.version !== GATEWAY_STATE_VERSION || typeof entry.id !== "string" || typeof entry.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.tokenHash) || !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.expiresAt) || (entry.label !== undefined && typeof entry.label !== "string")) throw new Error("Invalid Gateway pairing record");
      return entry as unknown as GatewayPairingRecord;
    });
    return { version: GATEWAY_STATE_VERSION, pairings };
  }

  private async save(document: PairingDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeGatewayJsonAtomic(this.path, document, { mode: 0o600, maximumBytes: MAX_PAIRING_BYTES });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

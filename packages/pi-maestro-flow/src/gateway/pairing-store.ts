/** Persistent least-privilege pairing credentials. Raw bearer tokens are never stored. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import { isPrimaryGatewayScope } from "./capabilities.ts";
import { gatewayPairingPath, readGatewayJson, writeGatewayJsonAtomic } from "./state-paths.ts";

const MAX_PAIRING_BYTES = 1024 * 1024;
const MAX_PAIRINGS = 256;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const GATEWAY_PRIMARY_AUDIENCE = "gateway";

export interface GatewayPairingRecord {
  version: typeof GATEWAY_STATE_VERSION;
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  scopes: string[];
  audience: string;
  generation: number;
  workspaceId?: string;
  provider?: string;
  instance?: string;
  label?: string;
  replacesId?: string;
  replacedById?: string;
  revokedAt?: number;
  revokedBy?: string;
}
interface PairingDocument { version: typeof GATEWAY_STATE_VERSION; pairings: GatewayPairingRecord[] }
export type GatewayPairingPublicRecord = Omit<GatewayPairingRecord, "tokenHash">;
export interface GatewayPairingIssue extends GatewayPairingPublicRecord { token: string }
export interface GatewayPairingIssueOptions {
  ttlMs?: number;
  label?: string;
  scopes?: readonly string[];
  audience?: string;
  workspaceId?: string;
  /** Compatibility alias accepted at the control boundary. */
  workspace?: string;
  provider?: string;
  instance?: string;
  generation?: number;
  replacesId?: string;
}
export interface GatewayPairingAuthenticationContext {
  audience?: string;
  workspaceId?: string;
  provider?: string;
  instance?: string;
  generation?: number;
}
export interface GatewayPairingRevokeOptions {
  revokedBy?: string;
  replacementId?: string;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
function publicRecord(record: GatewayPairingRecord): GatewayPairingPublicRecord {
  const { tokenHash: _secret, ...value } = record;
  return structuredClone(value);
}
function boundedString(value: unknown, label: string, maximum = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} is invalid`);
  return value.trim();
}
function normalizedScopes(value: readonly string[] | undefined, audience: string): string[] {
  const scopes = value === undefined ? (audience === GATEWAY_PRIMARY_AUDIENCE ? ["gateway"] : []) : [...value];
  if (scopes.length > 64 || new Set(scopes).size !== scopes.length || scopes.some((scope) => scope !== "*" && !/^[A-Za-z0-9][A-Za-z0-9.*:_-]{0,127}$/.test(scope))) {
    throw new Error("pairing scopes are invalid");
  }
  if (audience !== GATEWAY_PRIMARY_AUDIENCE && (scopes.length === 0 || scopes.some(isPrimaryGatewayScope))) {
    throw new Error("non-primary pairing requires narrow scopes and cannot receive a primary Gateway umbrella scope");
  }
  return scopes;
}

export class GatewayPairingStore {
  readonly path: string;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { path?: string; now?: () => number } = {}) {
    this.path = options.path ?? gatewayPairingPath();
    this.now = options.now ?? (() => Date.now());
  }

  async issue(options: GatewayPairingIssueOptions = {}): Promise<GatewayPairingIssue> {
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new Error("pairing ttlMs is out of range");
    const label = boundedString(options.label, "pairing label");
    const audience = boundedString(options.audience ?? GATEWAY_PRIMARY_AUDIENCE, "pairing audience", 128)!;
    const workspaceId = boundedString(options.workspaceId ?? options.workspace, "pairing workspace", 256);
    const provider = boundedString(options.provider, "pairing provider", 128);
    const instance = boundedString(options.instance, "pairing instance", 256);
    const replacesId = boundedString(options.replacesId, "pairing replacesId", 256);
    const generation = options.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("pairing generation is invalid");
    const scopes = normalizedScopes(options.scopes, audience);
    return this.mutate(async () => {
      const document = await this.load();
      if (document.pairings.length >= MAX_PAIRINGS) throw new Error(`pairing limit ${MAX_PAIRINGS} reached`);
      const now = this.now();
      const token = randomBytes(32).toString("base64url");
      const record: GatewayPairingRecord = {
        version: GATEWAY_STATE_VERSION,
        id: `pair-${randomUUID()}`,
        tokenHash: hashToken(token).toString("hex"),
        createdAt: now,
        expiresAt: now + ttlMs,
        scopes,
        audience,
        generation,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(provider === undefined ? {} : { provider }),
        ...(instance === undefined ? {} : { instance }),
        ...(label === undefined ? {} : { label }),
        ...(replacesId === undefined ? {} : { replacesId }),
      };
      if (replacesId !== undefined) {
        const replaced = document.pairings.find((entry) => entry.id === replacesId);
        if (!replaced) throw new Error("pairing replacement target was not found");
        if (replaced.revokedAt !== undefined) throw new Error("pairing replacement target is already revoked");
        replaced.revokedAt = now;
        replaced.replacedById = record.id;
      }
      document.pairings.push(record);
      await this.save(document);
      return { ...publicRecord(record), token };
    });
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<GatewayPairingPublicRecord[]> {
    const document = await this.load();
    const now = this.now();
    return document.pairings
      .filter((entry) => options.includeInactive === true || (entry.expiresAt > now && entry.revokedAt === undefined))
      .map(publicRecord);
  }

  async revoke(id: string, options: GatewayPairingRevokeOptions = {}): Promise<boolean> {
    const revokedBy = boundedString(options.revokedBy, "pairing revokedBy", 256);
    const replacementId = boundedString(options.replacementId, "pairing replacementId", 256);
    return this.mutate(async () => {
      const document = await this.load();
      const record = document.pairings.find((entry) => entry.id === id);
      if (!record || record.revokedAt !== undefined) return false;
      if (replacementId !== undefined && !document.pairings.some((entry) => entry.id === replacementId)) throw new Error("pairing replacement was not found");
      record.revokedAt = this.now();
      if (revokedBy !== undefined) record.revokedBy = revokedBy;
      if (replacementId !== undefined) record.replacedById = replacementId;
      await this.save(document);
      return true;
    });
  }

  async authenticate(token: string, context: GatewayPairingAuthenticationContext = {}): Promise<GatewayPairingPublicRecord | undefined> {
    if (!token) return undefined;
    const candidate = hashToken(token);
    const now = this.now();
    const expectedAudience = context.audience ?? GATEWAY_PRIMARY_AUDIENCE;
    for (const record of (await this.load()).pairings) {
      if (record.expiresAt <= now || record.revokedAt !== undefined) continue;
      const stored = Buffer.from(record.tokenHash, "hex");
      if (stored.byteLength !== candidate.byteLength || !timingSafeEqual(stored, candidate)) continue;
      if (record.audience !== expectedAudience) return undefined;
      if (context.workspaceId !== undefined && record.workspaceId !== context.workspaceId) return undefined;
      if (context.provider !== undefined && record.provider !== context.provider) return undefined;
      if (context.instance !== undefined && record.instance !== context.instance) return undefined;
      if (context.generation !== undefined && record.generation !== context.generation) return undefined;
      return publicRecord(record);
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
      if (entry.version !== GATEWAY_STATE_VERSION || typeof entry.id !== "string" || typeof entry.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.tokenHash) || !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.expiresAt)) throw new Error("Invalid Gateway pairing record");
      const audience = boundedString(entry.audience ?? GATEWAY_PRIMARY_AUDIENCE, "pairing audience", 128)!;
      const scopes = normalizedScopes(Array.isArray(entry.scopes) ? entry.scopes as string[] : undefined, audience);
      const generation = entry.generation ?? 1;
      if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw new Error("Invalid Gateway pairing record");
      const normalized: GatewayPairingRecord = {
        version: GATEWAY_STATE_VERSION,
        id: entry.id,
        tokenHash: entry.tokenHash,
        createdAt: entry.createdAt as number,
        expiresAt: entry.expiresAt as number,
        scopes,
        audience,
        generation: generation as number,
      };
      for (const key of ["workspaceId", "provider", "instance", "label", "replacesId", "replacedById", "revokedBy"] as const) {
        const result = boundedString(entry[key], `pairing ${key}`, key === "workspaceId" || key === "instance" ? 256 : 128);
        if (result !== undefined) normalized[key] = result;
      }
      if (entry.revokedAt !== undefined) {
        if (!Number.isSafeInteger(entry.revokedAt) || (entry.revokedAt as number) < 0) throw new Error("Invalid Gateway pairing record");
        normalized.revokedAt = entry.revokedAt as number;
      }
      return normalized;
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

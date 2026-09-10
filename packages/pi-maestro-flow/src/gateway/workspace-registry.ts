/** Durable workspace registrations with TTL and generation fencing. */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  GATEWAY_HARD_LIMITS,
  GATEWAY_STATE_VERSION,
  type GatewayWorkspace,
  type GatewayWorkspaceRegistry as GatewayWorkspaceRegistryRecord,
} from "./contracts.ts";
import { parseGatewayWorkspace, parseGatewayWorkspaceRegistry } from "./validation.ts";
import {
  canonicalizeWorkspacePath,
  gatewayWorkspaceRegistryPath,
  readGatewayJson,
  utf8Bytes,
  workspaceIdForPath,
  writeGatewayJsonAtomic,
} from "./state-paths.ts";

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(filePath: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
  }): Promise<() => Promise<void>>;
};

export class WorkspaceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}
export class WorkspaceLeaseConflictError extends WorkspaceRegistryError {
  constructor(message = "Workspace lease generation or owner token is stale") {
    super(message);
    this.name = "WorkspaceLeaseConflictError";
  }
}
export class WorkspaceNotFoundError extends WorkspaceRegistryError {
  constructor(pathOrId: string) {
    super(`Workspace is not registered: ${pathOrId}`);
    this.name = "WorkspaceNotFoundError";
  }
}

export interface WorkspaceRegistryOptions {
  /** Durable registry path; defaults to the native Pi agent Gateway state root. */
  path?: string;
  registryPath?: string;
  now?: () => number;
  maxEntries?: number;
  maxTtlMs?: number;
}

export interface WorkspaceRegistrationOptions {
  ttlMs?: number;
  ttlSeconds?: number;
  mode?: "lease" | "permanent";
  /** Legacy read-boundary alias; canonical records use mode. */
  permanent?: boolean;
  ownerToken?: string;
  expectedGeneration?: number;
  generation?: number;
  id?: string;
  /** Legacy read-boundary alias; canonical records use id. */
  workspaceId?: string;
}

export interface WorkspaceRenewOptions {
  ttlMs?: number;
  ttlSeconds?: number;
  mode?: "lease" | "permanent";
  /** Legacy read-boundary alias; canonical records use mode. */
  permanent?: boolean;
  ownerToken?: string;
  expectedGeneration?: number;
  generation?: number;
}

export interface WorkspaceUnregisterOptions {
  expectedGeneration?: number;
  generation?: number;
  ownerToken?: string;
}

export interface WorkspaceSeedEntry {
  path: string;
  options?: WorkspaceRegistrationOptions;
}

interface LegacyWorkspaceRecord {
  path?: unknown;
  workspacePath?: unknown;
  canonicalPath?: unknown;
  id?: unknown;
  workspaceId?: unknown;
  generation?: unknown;
  registeredAt?: unknown;
  updatedAt?: unknown;
  expiresAt?: unknown;
  mode?: unknown;
  permanent?: unknown;
  ttl?: unknown;
  ttlMs?: unknown;
  ttlSeconds?: unknown;
  ownerToken?: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new WorkspaceRegistryError(`${label} must be a positive safe integer`);
  return value as number;
}

function parseTtl(options: { ttlMs?: number; ttlSeconds?: number }, fallback: number, max: number): number {
  const raw = options.ttlMs ?? (options.ttlSeconds === undefined ? fallback : options.ttlSeconds * 1000);
  if (!Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw <= 0) throw new WorkspaceRegistryError("workspace TTL must be a positive safe integer");
  if (raw > max) throw new WorkspaceRegistryError(`workspace TTL must be <= ${max}ms`);
  return raw;
}

function asTimestamp(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

/** Normalize one legacy entry without ever writing the legacy shape back. */
function normalizeLegacyWorkspace(raw: LegacyWorkspaceRecord, now: number, maxTtlMs: number): GatewayWorkspace {
  const path = typeof raw.path === "string"
    ? raw.path
    : typeof raw.workspacePath === "string" ? raw.workspacePath
      : typeof raw.canonicalPath === "string" ? raw.canonicalPath : "";
  const canonicalPath = canonicalizeWorkspacePath(path);
  const id = typeof raw.id === "string" ? raw.id
    : typeof raw.workspaceId === "string" ? raw.workspaceId
      : workspaceIdForPath(canonicalPath);
  const registeredAt = asTimestamp(raw.registeredAt, now);
  const updatedAt = asTimestamp(raw.updatedAt, registeredAt);
  const mode = raw.permanent === true || raw.expiresAt === null || raw.mode === "permanent" ? "permanent" : "lease";
  let expiresAt: number | undefined;
  if (mode === "permanent") expiresAt = undefined;
  else if (Number.isSafeInteger(raw.expiresAt) && (raw.expiresAt as number) >= 0) expiresAt = raw.expiresAt as number;
  else {
    const ttl = raw.ttlMs ?? (typeof raw.ttlSeconds === "number" ? raw.ttlSeconds * 1000 : raw.ttl);
    if (Number.isFinite(ttl) && Number.isSafeInteger(ttl) && (ttl as number) > 0) expiresAt = Math.min(now + (ttl as number), now + maxTtlMs);
    else expiresAt = now;
  }
  return parseGatewayWorkspace({
    version: GATEWAY_STATE_VERSION,
    id,
    path: canonicalPath,
    canonicalPath,
    mode,
    generation: Number.isSafeInteger(raw.generation) && (raw.generation as number) > 0 ? raw.generation : 1,
    registeredAt,
    updatedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof raw.ownerToken === "string" ? { ownerToken: raw.ownerToken } : {}),
  });
}

export class WorkspaceRegistry {
  readonly registryPath: string;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxTtlMs: number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceRegistryOptions | string = {}) {
    const normalized = typeof options === "string" ? { path: options } : options;
    this.registryPath = normalized.path ?? normalized.registryPath ?? gatewayWorkspaceRegistryPath();
    this.now = normalized.now ?? (() => Date.now());
    this.maxEntries = normalized.maxEntries ?? GATEWAY_HARD_LIMITS.maxWorkspaceCount;
    this.maxTtlMs = normalized.maxTtlMs ?? GATEWAY_HARD_LIMITS.maxLeaseTtlMs;
    positiveInteger(this.maxEntries, "maxEntries");
    positiveInteger(this.maxTtlMs, "maxTtlMs");
    if (this.maxEntries > GATEWAY_HARD_LIMITS.maxWorkspaceCount) throw new WorkspaceRegistryError("maxEntries exceeds Gateway hard limit");
    if (this.maxTtlMs > GATEWAY_HARD_LIMITS.maxLeaseTtlMs) throw new WorkspaceRegistryError("maxTtlMs exceeds Gateway hard limit");
  }

  async load(): Promise<GatewayWorkspaceRegistryRecord> {
    const raw = await readGatewayJson<unknown>(this.registryPath, MAX_REGISTRY_BYTES);
    if (raw === undefined) return { version: GATEWAY_STATE_VERSION, workspaces: [] };
    const normalized = this.normalizeEnvelope(raw);
    return clone(normalized);
  }
  async read(): Promise<GatewayWorkspaceRegistryRecord> { return this.load(); }

  async list(options: { includeExpired?: boolean } = {}): Promise<GatewayWorkspace[]> {
    const envelope = await this.load();
    const now = this.now();
    return clone(envelope.workspaces.filter((workspace) => options.includeExpired || !this.expired(workspace, now)));
  }

  async get(pathOrId: string): Promise<GatewayWorkspace | undefined> {
    const envelope = await this.load();
    const found = this.find(envelope.workspaces, pathOrId);
    if (!found || this.expired(found, this.now())) return undefined;
    return clone(found);
  }

  async register(pathOrInput: string | { path: string; options?: WorkspaceRegistrationOptions }, options: WorkspaceRegistrationOptions = {}): Promise<GatewayWorkspace> {
    const inputPath = typeof pathOrInput === "string" ? pathOrInput : pathOrInput.path;
    const merged = typeof pathOrInput === "string" ? options : { ...(pathOrInput.options ?? {}), ...options };
    const canonicalPath = canonicalizeWorkspacePath(inputPath);
    return this.mutate((envelope) => {
      const now = this.now();
      const existingIndex = envelope.workspaces.findIndex((entry) => (entry.canonicalPath ?? entry.path) === canonicalPath);
      const existing = existingIndex >= 0 ? envelope.workspaces[existingIndex] : undefined;
      if (merged.expectedGeneration !== undefined && (existing === undefined || existing.generation !== merged.expectedGeneration)) {
        throw new WorkspaceLeaseConflictError(`Workspace generation ${String(merged.expectedGeneration)} is stale`);
      }
      if (existing?.mode === "lease" && existing.ownerToken !== undefined && existing.ownerToken !== merged.ownerToken) {
        throw new WorkspaceLeaseConflictError("Workspace owner token is stale");
      }
      const mode = merged.mode ?? (merged.permanent === true ? "permanent" : "lease");
      const generation = existing === undefined ? (merged.generation ?? 1) : existing.generation + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) throw new WorkspaceRegistryError("workspace generation must be a positive safe integer");
      const id = merged.id ?? merged.workspaceId ?? existing?.id ?? workspaceIdForPath(canonicalPath);
      const expiresAt = mode === "permanent" ? undefined : now + parseTtl(merged, 5 * 60 * 1000, this.maxTtlMs);
      const next = parseGatewayWorkspace({
        version: GATEWAY_STATE_VERSION,
        id,
        path: canonicalPath,
        canonicalPath,
        mode,
        generation,
        registeredAt: existing?.registeredAt ?? now,
        updatedAt: now,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(mode === "permanent" ? {} : {
          ownerToken: merged.ownerToken ?? existing?.ownerToken ?? randomUUID(),
        }),
      });
      if (existingIndex >= 0) envelope.workspaces[existingIndex] = next;
      else {
        if (envelope.workspaces.length >= this.maxEntries) throw new WorkspaceRegistryError(`workspace registry is full (${this.maxEntries})`);
        envelope.workspaces.push(next);
      }
      return clone(next);
    });
  }

  async renew(pathOrId: string, options: WorkspaceRenewOptions | number = {}): Promise<GatewayWorkspace> {
    const normalized: WorkspaceRenewOptions = typeof options === "number" ? { expectedGeneration: options } : options;
    return this.mutate((envelope) => {
      const index = this.indexOf(envelope.workspaces, pathOrId);
      if (index < 0) throw new WorkspaceNotFoundError(pathOrId);
      const current = envelope.workspaces[index]!;
      if (this.expired(current, this.now())) throw new WorkspaceLeaseConflictError("Workspace lease has expired");
      const expected = normalized.expectedGeneration ?? normalized.generation;
      if (expected !== undefined && current.generation !== expected) throw new WorkspaceLeaseConflictError();
      if (normalized.ownerToken !== undefined && current.ownerToken !== normalized.ownerToken) throw new WorkspaceLeaseConflictError("Workspace owner token is stale");
      const now = this.now();
      const mode = normalized.mode ?? (normalized.permanent === undefined ? current.mode : normalized.permanent ? "permanent" : "lease");
      const expiresAt = mode === "permanent" ? undefined : now + parseTtl(normalized, Math.max(1, (current.expiresAt ?? now) - now), this.maxTtlMs);
      const next = parseGatewayWorkspace({
        ...current,
        version: GATEWAY_STATE_VERSION,
        mode,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        updatedAt: now,
      });
      envelope.workspaces[index] = next;
      return clone(next);
    });
  }

  async unregister(pathOrId: string, options?: WorkspaceUnregisterOptions | number, legacyOwnerToken?: string): Promise<boolean> {
    const normalized: WorkspaceUnregisterOptions = typeof options === "number"
      ? { expectedGeneration: options, ownerToken: legacyOwnerToken }
      : (options ?? {});
    return this.mutate((envelope) => {
      const index = this.indexOf(envelope.workspaces, pathOrId);
      if (index < 0) return false;
      const current = envelope.workspaces[index]!;
      const expected = normalized.expectedGeneration ?? normalized.generation;
      if (expected !== undefined && current.generation !== expected) throw new WorkspaceLeaseConflictError();
      if (normalized.ownerToken !== undefined && current.ownerToken !== normalized.ownerToken) throw new WorkspaceLeaseConflictError("Workspace owner token is stale");
      if (current.mode === "lease" && current.ownerToken !== undefined && (expected === undefined || normalized.ownerToken === undefined)) {
        throw new WorkspaceLeaseConflictError("Leased workspace removal requires its generation and owner token");
      }
      envelope.workspaces.splice(index, 1);
      return true;
    });
  }
  async remove(pathOrId: string, options?: WorkspaceUnregisterOptions | number, ownerToken?: string): Promise<boolean> {
    return this.unregister(pathOrId, options, ownerToken);
  }

  /** Atomically import initial entries only when no registry has been published. */
  async seedIfMissing(entries: readonly WorkspaceSeedEntry[]): Promise<boolean> {
    return this.mutate((envelope, existed) => {
      if (existed) return false;
      for (const entry of entries) this.registerIntoEnvelope(envelope, entry.path, entry.options ?? {});
      return true;
    });
  }

  async pruneExpired(): Promise<string[]> {
    return this.mutate((envelope) => {
      const now = this.now();
      const removed = envelope.workspaces.filter((entry) => this.expired(entry, now)).map((entry) => entry.id || entry.path);
      envelope.workspaces = envelope.workspaces.filter((entry) => !this.expired(entry, now));
      return removed;
    });
  }

  private expired(workspace: GatewayWorkspace, now: number): boolean {
    return workspace.mode === "lease" && workspace.expiresAt !== undefined && workspace.expiresAt <= now;
  }

  private find(workspaces: GatewayWorkspace[], pathOrId: string): GatewayWorkspace | undefined {
    const index = this.indexOf(workspaces, pathOrId);
    return index < 0 ? undefined : workspaces[index];
  }

  private indexOf(workspaces: GatewayWorkspace[], pathOrId: string): number {
    const byId = workspaces.findIndex((entry) => entry.id === pathOrId);
    if (byId >= 0) return byId;
    let canonical: string;
    try { canonical = canonicalizeWorkspacePath(pathOrId); } catch { return -1; }
    return workspaces.findIndex((entry) => (entry.canonicalPath ?? entry.path) === canonical);
  }

  private normalizeEnvelope(raw: unknown): GatewayWorkspaceRegistryRecord {
    if (Array.isArray(raw)) {
      const workspaces = raw.map((entry) => normalizeLegacyWorkspace(entry as LegacyWorkspaceRecord, this.now(), this.maxTtlMs));
      return this.assertEnvelope({ version: GATEWAY_STATE_VERSION, workspaces });
    }
    if (typeof raw !== "object" || raw === null) throw new WorkspaceRegistryError("Gateway workspace registry must be an object");
    const candidate = raw as Record<string, unknown>;
    if (candidate.version === GATEWAY_STATE_VERSION) return this.assertEnvelope(candidate);
    if (Array.isArray(candidate.workspaces)) {
      const workspaces = candidate.workspaces.map((entry) => normalizeLegacyWorkspace(entry as LegacyWorkspaceRecord, this.now(), this.maxTtlMs));
      return this.assertEnvelope({ version: GATEWAY_STATE_VERSION, workspaces });
    }
    throw new WorkspaceRegistryError("Unsupported Gateway workspace registry version");
  }

  private assertEnvelope(raw: unknown): GatewayWorkspaceRegistryRecord {
    const envelope = parseGatewayWorkspaceRegistry(raw);
    if (envelope.workspaces.length > this.maxEntries) throw new WorkspaceRegistryError(`workspace registry exceeds ${this.maxEntries} entries`);
    for (const workspace of envelope.workspaces) {
      if (workspace.path !== workspace.canonicalPath && workspace.canonicalPath !== undefined) throw new WorkspaceRegistryError("workspace path is not canonical");
      if (utf8Bytes(workspace.path) > 4096) throw new WorkspaceRegistryError("workspace path exceeds UTF-8 limit");
    }
    return envelope;
  }

  private registerIntoEnvelope(envelope: GatewayWorkspaceRegistryRecord, inputPath: string, options: WorkspaceRegistrationOptions): GatewayWorkspace {
    const canonicalPath = canonicalizeWorkspacePath(inputPath);
    const now = this.now();
    const existingIndex = envelope.workspaces.findIndex((entry) => (entry.canonicalPath ?? entry.path) === canonicalPath);
    const existing = existingIndex >= 0 ? envelope.workspaces[existingIndex] : undefined;
    if (existing) return existing;
    if (envelope.workspaces.length >= this.maxEntries) throw new WorkspaceRegistryError(`workspace registry is full (${this.maxEntries})`);
    const mode = options.mode ?? (options.permanent === true ? "permanent" : "lease");
    const expiresAt = mode === "permanent" ? undefined : now + parseTtl(options, 5 * 60 * 1000, this.maxTtlMs);
    const next = parseGatewayWorkspace({
      version: GATEWAY_STATE_VERSION,
      id: options.id ?? options.workspaceId ?? workspaceIdForPath(canonicalPath),
      path: canonicalPath,
      canonicalPath,
      mode,
      generation: options.generation ?? 1,
      registeredAt: now,
      updatedAt: now,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(mode === "permanent" ? {} : { ownerToken: options.ownerToken ?? randomUUID() }),
    });
    envelope.workspaces.push(next);
    return next;
  }

  private async mutate<T>(operation: (envelope: GatewayWorkspaceRegistryRecord, existed: boolean) => T | Promise<T>): Promise<T> {
    let resolveTail!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => { resolveTail = resolve; });
    await previous;
    await mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    let releaseFile: (() => Promise<void>) | undefined;
    try {
      releaseFile = await properLockfile.lock(this.registryPath, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true },
      });
      const raw = await readGatewayJson<unknown>(this.registryPath, MAX_REGISTRY_BYTES);
      const envelope = raw === undefined
        ? { version: GATEWAY_STATE_VERSION, workspaces: [] }
        : this.normalizeEnvelope(raw);
      // Keep expired entries through the mutation so a re-registration can
      // advance the generation fence rather than silently resetting it. Reads
      // hide expired entries; explicit pruneExpired removes them durably.
      const result = await operation(envelope, raw !== undefined);
      const canonical = this.assertEnvelope(envelope);
      await writeGatewayJsonAtomic(this.registryPath, canonical, { mode: 0o600, maximumBytes: MAX_REGISTRY_BYTES });
      return result;
    } finally {
      try { if (releaseFile) await releaseFile(); }
      finally { resolveTail(); }
    }
  }
}

let defaultRegistry: WorkspaceRegistry | undefined;
export function getGatewayWorkspaceRegistry(options?: WorkspaceRegistryOptions | string): WorkspaceRegistry {
  if (options !== undefined) return new WorkspaceRegistry(options);
  return defaultRegistry ?? (defaultRegistry = new WorkspaceRegistry());
}

export async function loadWorkspaceRegistry(options?: WorkspaceRegistryOptions | string): Promise<GatewayWorkspace[]> {
  return getGatewayWorkspaceRegistry(options).list();
}
export async function registerWorkspace(path: string, options: WorkspaceRegistrationOptions = {}, registry?: WorkspaceRegistry): Promise<GatewayWorkspace> {
  return (registry ?? getGatewayWorkspaceRegistry()).register(path, options);
}
export async function renewWorkspace(pathOrId: string, options: WorkspaceRenewOptions | number = {}, registry?: WorkspaceRegistry): Promise<GatewayWorkspace> {
  return (registry ?? getGatewayWorkspaceRegistry()).renew(pathOrId, options);
}
export async function unregisterWorkspace(pathOrId: string, options?: WorkspaceUnregisterOptions | number, ownerToken?: string, registry?: WorkspaceRegistry): Promise<boolean> {
  return (registry ?? getGatewayWorkspaceRegistry()).unregister(pathOrId, options, ownerToken);
}
export const createWorkspaceRegistry = (options?: WorkspaceRegistryOptions | string): WorkspaceRegistry => new WorkspaceRegistry(options);
export const GatewayWorkspaceRegistry = WorkspaceRegistry;

/** Atomic durable CollaborativeSession state with CAS and payload-bound idempotency. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { GatewayAuthMode } from "./config.ts";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import type { GatewayHandoffV1 } from "./handoff-contracts.ts";
import type { GatewayHandoffOriginV1 } from "./handoff-record-contracts.ts";
import { assertSessionScope, defaultSessionCapabilities, type SessionIdentityContext, type SessionScope } from "./identity-store.ts";
import { principalKey } from "./principal.ts";
import { createSessionEvent } from "./session-events.ts";
import {
  parseCollaborativeSessionState, parseSessionMember,
  type CollaborativeSessionStateV1, type CollaborativeSessionV1, type SessionEventV1, type SessionMemberV1,
} from "./session-contracts.ts";
import { containedPath, gatewaySessionPath, gatewaySessionsRoot, readGatewayJson, writeGatewayJsonAtomic, workspaceIdForPath, canonicalizeWorkspacePath } from "./state-paths.ts";

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as { lock(path: string, options: { realpath: boolean; stale: number; update: number; retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean } }): Promise<() => Promise<void>> };
const tails = new Map<string, Promise<void>>();

export class SessionStoreError extends Error { constructor(message: string) { super(message); this.name = "SessionStoreError"; } }
export class SessionNotFoundError extends SessionStoreError { constructor(id: string) { super(`Collaborative session not found: ${id}`); this.name = "SessionNotFoundError"; } }
export class SessionConflictError extends SessionStoreError { constructor(message = "Session revision is stale") { super(message); this.name = "SessionConflictError"; } }
export class SessionReplayMismatchError extends SessionStoreError { constructor() { super("Operation id was already used with a different payload"); this.name = "SessionReplayMismatchError"; } }
export class SessionLeaseError extends SessionStoreError { constructor(message: string) { super(message); this.name = "SessionLeaseError"; } }

export interface SessionStoreOptions { cwd?: string; sessionsRoot?: string; now?: () => number; maxLeaseTtlMs?: number; }
export interface SessionMutationOptions { expectedSessionRevision: number; operationId: string; actorId: string; }
export interface AuthorizedSessionMutationOptions extends SessionMutationOptions { identity: SessionIdentityContext; }
export interface CreateSessionInput {
  id?: string; workspacePath: string; ownerId: string; ownerPrincipalId: string; ownerCapabilities?: string[]; leaseTtlMs?: number;
}
export interface SessionMutationContext {
  state: CollaborativeSessionStateV1; revision: number; now: number;
  emit(type: SessionEventV1["type"], data?: Record<string, unknown>): void;
}

function clone<T>(value: T): T { return structuredClone(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function requiredOptions(options: SessionMutationOptions): void {
  if (!Number.isSafeInteger(options.expectedSessionRevision) || options.expectedSessionRevision < 0) throw new SessionConflictError("expectedSessionRevision is required and must be non-negative");
  if (!options.operationId || !options.actorId) throw new SessionStoreError("operationId and actorId are required");
}

export class SessionStore {
  readonly sessionsRoot?: string;
  private readonly cwd: string;
  private readonly now: () => number;
  private readonly maxLeaseTtlMs: number;
  constructor(options: SessionStoreOptions = {}) {
    this.cwd = canonicalizeWorkspacePath(options.cwd ?? process.cwd()); this.sessionsRoot = options.sessionsRoot;
    this.now = options.now ?? (() => Date.now()); this.maxLeaseTtlMs = options.maxLeaseTtlMs ?? 24 * 60 * 60 * 1000;
  }
  path(id: string): string { return gatewaySessionPath(id, this.cwd, this.sessionsRoot); }
  async load(id: string): Promise<CollaborativeSessionStateV1 | undefined> {
    try {
      const raw = await readGatewayJson<unknown>(this.path(id), MAX_SESSION_BYTES);
      if (raw === undefined) return undefined;
      return clone(parseCollaborativeSessionState(raw));
    } catch (error) {
      throw new SessionStoreError(`Corrupt CollaborativeSession state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async require(id: string): Promise<CollaborativeSessionStateV1> { const state = await this.load(id); if (!state) throw new SessionNotFoundError(id); return state; }
  /** Bounded discovery of durable sessions. Corrupt records fail closed instead of being hidden. */
  async list(limit = 256): Promise<CollaborativeSessionStateV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new SessionStoreError("limit must be in [1, 256]");
    const root = this.sessionsRoot ?? gatewaySessionsRoot(this.cwd);
    let names: string[];
    try { names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort().slice(0, limit); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const states: CollaborativeSessionStateV1[] = [];
    for (const name of names) {
      const raw = await readGatewayJson<unknown>(containedPath(root, name), MAX_SESSION_BYTES);
      if (raw !== undefined) states.push(clone(parseCollaborativeSessionState(raw)));
    }
    return states;
  }

  async create(input: CreateSessionInput, options: SessionMutationOptions): Promise<CollaborativeSessionStateV1> {
    requiredOptions(options);
    if (options.expectedSessionRevision !== 0) throw new SessionConflictError("New sessions require expectedSessionRevision=0");
    const id = input.id ?? randomUUID(); const path = this.path(id);
    const payloadHash = hash({ sessionId: id, kind: "session.create", input });
    return this.serialized(path, async () => {
      const existing = await this.load(id);
      if (existing) {
        const replay = existing.operations.find((operation) => operation.id === options.operationId);
        if (!replay) throw new SessionConflictError(`Collaborative session already exists: ${id}`);
        if (replay.payloadHash !== payloadHash || replay.actorId !== options.actorId) throw new SessionReplayMismatchError();
        return existing;
      }
      const now = this.now(); const workspacePath = canonicalizeWorkspacePath(input.workspacePath);
      const lease = this.leaseExpiry(input.leaseTtlMs, now);
      const session: CollaborativeSessionV1 = { version: GATEWAY_STATE_VERSION, id, status: "active", revision: 1, workspaceId: workspaceIdForPath(workspacePath), workspacePath, createdAt: now, updatedAt: now };
      const owner = parseSessionMember({ version: GATEWAY_STATE_VERSION, id: input.ownerId, sessionId: id, principalId: input.ownerPrincipalId, role: "owner", status: "active", capabilities: input.ownerCapabilities ?? defaultSessionCapabilities("owner"), generation: 1, leaseExpiresAt: lease, joinedAt: now, updatedAt: now });
      const event = createSessionEvent({ sessionId: id, revision: 1, type: "session.created", actorId: options.actorId, createdAt: now, data: {} });
      const state: CollaborativeSessionStateV1 = { version: GATEWAY_STATE_VERSION, session, members: [owner], todos: [], events: [event], operations: [{ version: GATEWAY_STATE_VERSION, id: options.operationId, sessionId: id, actorId: options.actorId, kind: "session.create", payloadHash, baseRevision: 0, committedRevision: 1, createdAt: now, result: { sessionId: id } }] };
      await this.persist(path, state); return clone(state);
    });
  }

  async mutate<T>(sessionId: string, kind: string, payload: unknown, options: SessionMutationOptions, operation: (context: SessionMutationContext) => T, authorizeReplay?: (state: CollaborativeSessionStateV1, now: number) => void): Promise<T> {
    requiredOptions(options); const path = this.path(sessionId); const payloadHash = hash({ sessionId, kind, payload });
    return this.serialized(path, async () => {
      const state = await this.require(sessionId); const now = this.now();
      const replay = state.operations.find((entry) => entry.id === options.operationId);
      if (replay) {
        if (replay.payloadHash !== payloadHash || replay.kind !== kind || replay.actorId !== options.actorId) throw new SessionReplayMismatchError();
        authorizeReplay?.(state, now);
        return clone(replay.result as T);
      }
      if (state.session.revision !== options.expectedSessionRevision) throw new SessionConflictError(`Expected session revision ${options.expectedSessionRevision}, found ${state.session.revision}`);
      const nextRevision = state.session.revision + 1; const pendingEvents: SessionEventV1[] = [];
      state.session = { ...state.session, revision: nextRevision, updatedAt: now };
      const context: SessionMutationContext = { state, revision: nextRevision, now, emit: (type, data = {}) => pendingEvents.push(createSessionEvent({ sessionId, revision: nextRevision, type, actorId: options.actorId, createdAt: now, data })) };
      const result = operation(context);
      state.events.push(...pendingEvents);
      state.operations.push({ version: GATEWAY_STATE_VERSION, id: options.operationId, sessionId, actorId: options.actorId, kind, payloadHash, baseRevision: options.expectedSessionRevision, committedRevision: nextRevision, createdAt: now, result: clone(result) });
      const validated = parseCollaborativeSessionState(state); await this.persist(path, validated); return clone(result);
    });
  }

  async mutateAuthorized<T>(sessionId: string, kind: string, payload: unknown, options: AuthorizedSessionMutationOptions, scope: SessionScope, operation: (context: SessionMutationContext, member: SessionMemberV1) => T): Promise<T> {
    return this.mutate(
      sessionId,
      kind,
      payload,
      options,
      (context) => operation(context, assertSessionScope(context.state.session, context.state.members, options.identity, scope, context.now)),
      (state, now) => { assertSessionScope(state.session, state.members, options.identity, scope, now); },
    );
  }

  async joinMember(sessionId: string, input: { id: string; principalId: string; role: SessionMemberV1["role"]; capabilities?: string[]; leaseTtlMs?: number }, options: AuthorizedSessionMutationOptions): Promise<SessionMemberV1> {
    return this.mutateAuthorized(sessionId, "member.join", input, options, "member:manage", ({ state, now, emit }) => {
      if (state.members.some((member) => member.id === input.id)) throw new SessionConflictError(`Member already exists: ${input.id}`);
      const member = parseSessionMember({ version: GATEWAY_STATE_VERSION, id: input.id, sessionId, principalId: input.principalId, role: input.role, status: "active", capabilities: input.capabilities ?? defaultSessionCapabilities(input.role), generation: 1, leaseExpiresAt: this.leaseExpiry(input.leaseTtlMs, now), joinedAt: now, updatedAt: now });
      state.members.push(member); emit("member.joined", { memberId: member.id }); return member;
    });
  }

  async renewMember(sessionId: string, memberId: string, expectedGeneration: number, leaseTtlMs: number, options: AuthorizedSessionMutationOptions): Promise<SessionMemberV1> {
    if (options.identity.authMode === "open") throw new SessionLeaseError("auth.mode=open is read-only");
    if (options.identity.memberId !== memberId || options.actorId !== memberId) throw new SessionLeaseError("Member lease identity is stale");
    return this.mutate(sessionId, "member.renew", { memberId, expectedGeneration, leaseTtlMs }, options, ({ state, now, emit }) => {
      const index = state.members.findIndex((member) => member.id === memberId); if (index < 0) throw new SessionLeaseError("Member not found");
      const member = state.members[index]!; if (member.principalId !== principalKey(options.identity.principal) || member.generation !== expectedGeneration || member.status === "left" || member.status === "lost") throw new SessionLeaseError("Member lease generation or identity is stale");
      const next = parseSessionMember({ ...member, status: "active", generation: member.generation + 1, leaseExpiresAt: this.leaseExpiry(leaseTtlMs, now), updatedAt: now });
      state.members[index] = next; emit("member.renewed", { memberId, generation: next.generation }); return next;
    }, (state) => {
      const member = state.members.find((candidate) => candidate.id === memberId);
      if (!member || member.principalId !== principalKey(options.identity.principal) || member.status === "left" || member.status === "lost") throw new SessionLeaseError("Member lease identity is stale");
    });
  }

  async setMemberStatus(sessionId: string, memberId: string, status: "disconnected" | "left" | "lost", expectedGeneration: number, options: AuthorizedSessionMutationOptions): Promise<SessionMemberV1> {
    return this.mutateAuthorized(sessionId, "member.state", { memberId, status, expectedGeneration }, options, "member:manage", ({ state, now, emit }) => {
      const index = state.members.findIndex((member) => member.id === memberId); if (index < 0) throw new SessionLeaseError("Member not found");
      const member = state.members[index]!; if (member.generation !== expectedGeneration) throw new SessionLeaseError("Member lease generation is stale");
      const next = parseSessionMember({ ...member, status, generation: member.generation + 1, updatedAt: now }); state.members[index] = next; emit("member.state", { memberId, status }); return next;
    });
  }

  async transition(sessionId: string, status: CollaborativeSessionV1["status"], options: AuthorizedSessionMutationOptions): Promise<CollaborativeSessionV1> {
    return this.mutateAuthorized(sessionId, "session.transition", { status }, options, "session:write", ({ state, now, emit }) => {
      const current = state.session.status; const allowed = (current === "creating" && status === "active") || (current === "active" && status === "closing") || (current === "closing" && status === "closed");
      if (!allowed) throw new SessionConflictError(`Invalid session transition ${current} -> ${status}`);
      state.session = { ...state.session, status, ...(status === "closed" ? { closedAt: now } : {}) }; emit("session.transitioned", { status }); return state.session;
    });
  }

  async handoff(sessionId: string, handoff: GatewayHandoffV1, options: AuthorizedSessionMutationOptions, origin?: GatewayHandoffOriginV1): Promise<CollaborativeSessionV1> {
    return this.mutateAuthorized(sessionId, "session.handoff", origin === undefined ? handoff : { handoff, origin }, options, "session:write", ({ state, emit }) => {
      if (state.session.status === "closed") throw new SessionConflictError("Cannot hand off a closed session");
      state.session = {
        ...state.session,
        handoff: structuredClone(handoff),
        ...(origin === undefined ? {} : { handoffOrigin: structuredClone(origin) }),
      };
      emit("session.handoff", { handoff: structuredClone(handoff) });
      return state.session;
    });
  }

  /** Close is one durable operation; callers never have to race two CAS transitions. */
  async close(sessionId: string, options: AuthorizedSessionMutationOptions, handoff?: GatewayHandoffV1, origin?: GatewayHandoffOriginV1): Promise<CollaborativeSessionV1> {
    const payload = handoff === undefined ? {} : origin === undefined ? { handoff } : { handoff, origin };
    return this.mutateAuthorized(sessionId, "session.close", payload, options, "session:write", ({ state, now, emit }) => {
      if (state.session.status !== "active" && state.session.status !== "closing") throw new SessionConflictError(`Cannot close session in state ${state.session.status}`);
      if (handoff !== undefined) {
        state.session = {
          ...state.session,
          handoff: structuredClone(handoff),
          ...(origin === undefined ? {} : { handoffOrigin: structuredClone(origin) }),
        };
        emit("session.handoff", { handoff: structuredClone(handoff) });
      }
      state.session = { ...state.session, status: "closed", closedAt: now };
      emit("session.transitioned", { status: "closed" });
      return state.session;
    });
  }

  private leaseExpiry(ttl: number | undefined, now: number): number { const value = ttl ?? Math.min(90_000, this.maxLeaseTtlMs); if (!Number.isSafeInteger(value) || value < 1 || value > this.maxLeaseTtlMs) throw new SessionLeaseError(`leaseTtlMs must be in [1, ${this.maxLeaseTtlMs}]`); return now + value; }
  private async persist(path: string, state: CollaborativeSessionStateV1): Promise<void> { await writeGatewayJsonAtomic(path, state, { mode: 0o600, maximumBytes: MAX_SESSION_BYTES }); }
  private async serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
    let releaseLocal!: () => void; const previous = tails.get(path) ?? Promise.resolve(); const current = new Promise<void>((resolve) => { releaseLocal = resolve; }); tails.set(path, current); await previous;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); let releaseFile: (() => Promise<void>) | undefined;
    try { releaseFile = await properLockfile.lock(path, { realpath: false, stale: 10_000, update: 2_000, retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true } }); return await operation(); }
    finally { try { if (releaseFile) await releaseFile(); } finally { releaseLocal(); if (tails.get(path) === current) tails.delete(path); } }
  }
}

export const createSessionStore = (options?: SessionStoreOptions) => new SessionStore(options);
export function openModeIdentity(principal: SessionIdentityContext["principal"], memberId: string): SessionIdentityContext { return { principal, memberId, authMode: "open" as GatewayAuthMode }; }

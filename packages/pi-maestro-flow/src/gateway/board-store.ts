/** Workspace-scoped Board authority for work intake, claims, and collaboration bindings. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  BOARD_EVENT_TYPES,
  parseBoardEnvelope,
  parseBoardEvent,
  parseBoardOperation,
  parseBoardTask,
  type BoardActorV1,
  type BoardCompletionPolicyV1,
  type BoardEndpointBindingV1,
  type BoardEnvelopeV1,
  type BoardEventV1,
  type BoardPlanBindingV1,
  type BoardSessionBindingV1,
  type BoardTaskResultV1,
  type BoardTaskV1,
} from "./board-contracts.ts";
import type { GatewayHandoffV1 } from "./handoff-contracts.ts";
import type { GatewayHandoffOriginV1 } from "./handoff-record-contracts.ts";
import { GATEWAY_HARD_LIMITS, GATEWAY_STATE_VERSION, type GatewayPrincipal } from "./contracts.ts";
import { principalHasScope, principalKey } from "./principal.ts";
import { SessionStore } from "./session-store.ts";
import { GatewayTodoStore } from "./todo-store.ts";
import {
  canonicalizeWorkspacePath,
  gatewayBoardPath,
  readGatewayJson,
  workspaceIdForPath,
  writeGatewayJsonAtomic,
} from "./state-paths.ts";

const MAX_BOARD_BYTES = 16 * 1024 * 1024;
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(path: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
  }): Promise<() => Promise<void>>;
};
const tails = new Map<string, Promise<void>>();

export class BoardStoreError extends Error {
  constructor(message: string) { super(message); this.name = "BoardStoreError"; }
}
export class BoardNotFoundError extends BoardStoreError {
  constructor(id: string) { super(`Board task not found: ${id}`); this.name = "BoardNotFoundError"; }
}
export class BoardConflictError extends BoardStoreError {
  constructor(message: string) { super(message); this.name = "BoardConflictError"; }
}
export class BoardAuthorizationError extends BoardStoreError {
  constructor(message = "Board task is not available") { super(message); this.name = "BoardAuthorizationError"; }
}
export class BoardReplayMismatchError extends BoardConflictError {
  constructor() { super("Board operation id was already used with a different payload or actor"); this.name = "BoardReplayMismatchError"; }
}
export class BoardClaimError extends BoardConflictError {
  constructor(message: string) { super(message); this.name = "BoardClaimError"; }
}

export interface BoardStoreOptions {
  workspacePath: string;
  boardRoot?: string;
  sessionStore: SessionStore;
  todoStore: GatewayTodoStore;
  now?: () => number;
  maxTasks?: number;
  maxOperations?: number;
  maxEvents?: number;
  maxLeaseTtlMs?: number;
  taskRetentionMs?: number;
  operationRetentionMs?: number;
  eventRetentionMs?: number;
}

export interface BoardMutationOptions {
  principal: GatewayPrincipal;
  operationId: string;
  expectedRevision: number;
}

export interface CreateBoardTaskInput {
  id?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: BoardTaskV1["priority"];
  labels?: string[];
  dependencyIds?: string[];
  completionPolicy?: Partial<BoardCompletionPolicyV1>;
}

export interface UpdateBoardTaskInput {
  title?: string;
  description?: string | null;
  acceptanceCriteria?: string[];
  priority?: BoardTaskV1["priority"];
  labels?: string[];
  dependencyIds?: string[];
  completionPolicy?: BoardCompletionPolicyV1;
}

export interface BoardEventPage {
  events: BoardEventV1[];
  oldestCursor: number;
  nextCursor: number;
  hasMore: boolean;
  gap: boolean;
}

interface MutationContext {
  state: BoardEnvelopeV1;
  task?: BoardTaskV1;
  now: number;
  actor: BoardActorV1;
  principalId: string;
  emit: (type: BoardEventV1["type"], task: BoardTaskV1, details?: Partial<BoardEventV1>) => void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

export function boardActorForPrincipal(principal: GatewayPrincipal): BoardActorV1 {
  const opaque = `actor-${createHash("sha256").update(principalKey(principal), "utf8").digest("hex").slice(0, 24)}`;
  const actorType: BoardActorV1["actorType"] = principal.transport === "stdio"
    ? "pi"
    : principal.transport === "http"
      ? "web"
      : "service";
  return { actorId: opaque, actorType };
}

function requiredMutationOptions(options: BoardMutationOptions): void {
  if (!options.operationId?.trim()) throw new BoardStoreError("operationId must be non-empty");
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) throw new BoardStoreError("expectedRevision must be a non-negative safe integer");
}

function terminal(task: BoardTaskV1): boolean {
  return task.status === "completed" || task.status === "cancelled";
}

export class BoardStore {
  readonly workspacePath: string;
  readonly workspaceId: string;
  readonly path: string;
  private readonly sessionStore: SessionStore;
  private readonly todoStore: GatewayTodoStore;
  private readonly now: () => number;
  private readonly maxTasks: number;
  private readonly maxOperations: number;
  private readonly maxEvents: number;
  private readonly maxLeaseTtlMs: number;
  private readonly taskRetentionMs?: number;
  private readonly operationRetentionMs?: number;
  private readonly eventRetentionMs?: number;

  constructor(options: BoardStoreOptions) {
    this.workspacePath = canonicalizeWorkspacePath(options.workspacePath);
    this.workspaceId = workspaceIdForPath(this.workspacePath);
    this.path = gatewayBoardPath(this.workspacePath, options.boardRoot);
    this.sessionStore = options.sessionStore;
    this.todoStore = options.todoStore;
    this.now = options.now ?? Date.now;
    this.maxTasks = options.maxTasks ?? 512;
    this.maxOperations = options.maxOperations ?? 2048;
    this.maxEvents = options.maxEvents ?? 4096;
    this.maxLeaseTtlMs = options.maxLeaseTtlMs ?? GATEWAY_HARD_LIMITS.maxLeaseTtlMs;
    this.taskRetentionMs = options.taskRetentionMs;
    this.operationRetentionMs = options.operationRetentionMs;
    this.eventRetentionMs = options.eventRetentionMs;
    if (this.maxTasks < 1 || this.maxTasks > GATEWAY_HARD_LIMITS.maxBoardTasks) throw new BoardStoreError("maxTasks is outside the board hard limit");
    if (this.maxOperations < 1 || this.maxOperations > GATEWAY_HARD_LIMITS.maxBoardOperations) throw new BoardStoreError("maxOperations is outside the board hard limit");
    if (this.maxEvents < 1 || this.maxEvents > GATEWAY_HARD_LIMITS.maxBoardEvents) throw new BoardStoreError("maxEvents is outside the board hard limit");
  }

  async load(): Promise<BoardEnvelopeV1> {
    const raw = await readGatewayJson<unknown>(this.path, MAX_BOARD_BYTES);
    return raw === undefined ? this.empty(this.now()) : clone(parseBoardEnvelope(raw));
  }

  async list(options: { status?: BoardTaskV1["status"]; phase?: BoardTaskV1["phase"]; limit?: number } = {}): Promise<BoardTaskV1[]> {
    const limit = options.limit ?? this.maxTasks;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxTasks) throw new BoardStoreError(`limit must be in [1, ${this.maxTasks}]`);
    return (await this.load()).tasks
      .filter((task) => options.status === undefined || task.status === options.status)
      .filter((task) => options.phase === undefined || task.phase === options.phase)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }

  async search(options: { query: string; status?: BoardTaskV1["status"]; phase?: BoardTaskV1["phase"]; limit?: number }): Promise<BoardTaskV1[]> {
    const query = options.query.trim().toLocaleLowerCase();
    if (!query) throw new BoardStoreError("query must be non-empty");
    if (Buffer.byteLength(query, "utf8") > 4096) throw new BoardStoreError("query is too large");
    const terms = query.split(/\s+/u);
    const limit = options.limit ?? this.maxTasks;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxTasks) throw new BoardStoreError(`limit must be in [1, ${this.maxTasks}]`);
    return (await this.load()).tasks
      .filter((task) => options.status === undefined || task.status === options.status)
      .filter((task) => options.phase === undefined || task.phase === options.phase)
      .filter((task) => {
        const searchable = JSON.stringify({
          id: task.id,
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          labels: task.labels,
          sessionBinding: task.sessionBinding,
          planBinding: task.planBinding,
          handoff: task.handoff,
          result: task.result,
        }).toLocaleLowerCase();
        return terms.every((term) => searchable.includes(term));
      })
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(clone);
  }

  async get(taskId: string): Promise<BoardTaskV1 | undefined> {
    const task = (await this.load()).tasks.find((entry) => entry.id === taskId);
    return task === undefined ? undefined : clone(task);
  }

  async create(input: CreateBoardTaskInput, options: BoardMutationOptions): Promise<BoardTaskV1> {
    const taskId = input.id ?? randomUUID();
    return this.mutate("board.create", taskId, input, options, async ({ state, now, actor, emit }) => {
      if (options.expectedRevision !== 0) throw new BoardConflictError("New board tasks require expectedRevision=0");
      if (state.tasks.some((task) => task.id === taskId)) throw new BoardConflictError(`Board task already exists: ${taskId}`);
      if (state.tasks.length >= this.maxTasks) throw new BoardConflictError("Board task capacity reached");
      const task = parseBoardTask({
        version: GATEWAY_STATE_VERSION,
        id: taskId,
        workspaceId: this.workspaceId,
        revision: 1,
        status: "open",
        phase: "intake",
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        priority: input.priority ?? "normal",
        labels: input.labels ?? [],
        dependencyIds: input.dependencyIds ?? [],
        createdBy: actor,
        completionPolicy: {
          requireLinkedTodosCompleted: input.completionPolicy?.requireLinkedTodosCompleted ?? true,
          requireReview: input.completionPolicy?.requireReview ?? false,
        },
        createdAt: now,
        updatedAt: now,
      });
      state.tasks.push(task);
      parseBoardEnvelope({ ...state, tasks: state.tasks, revision: Math.max(state.revision, task.revision) });
      emit("task.created", task);
      return task;
    });
  }

  async update(taskId: string, patch: UpdateBoardTaskInput, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.update", taskId, patch, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      if (this.isOrphaned(current, context.now)) throw new BoardClaimError("Expired active claim is orphaned and requires takeover");
      this.assertMutableBy(current, context.principalId, context.actor.actorId, context.now);
      if (terminal(current)) throw new BoardConflictError("Terminal board task cannot be updated");
      const nextValue: Record<string, unknown> = { ...current, revision: current.revision + 1, updatedAt: context.now };
      if (patch.title !== undefined) nextValue.title = patch.title;
      if (patch.description === null) delete nextValue.description;
      else if (patch.description !== undefined) nextValue.description = patch.description;
      if (patch.acceptanceCriteria !== undefined) nextValue.acceptanceCriteria = patch.acceptanceCriteria;
      if (patch.priority !== undefined) nextValue.priority = patch.priority;
      if (patch.labels !== undefined) nextValue.labels = patch.labels;
      if (patch.dependencyIds !== undefined) nextValue.dependencyIds = patch.dependencyIds;
      if (patch.completionPolicy !== undefined) nextValue.completionPolicy = patch.completionPolicy;
      const next = parseBoardTask(nextValue);
      this.replace(context.state, next);
      parseBoardEnvelope({ ...context.state, revision: Math.max(context.state.revision, next.revision) });
      context.emit("task.updated", next);
      return next;
    });
  }

  async claim(taskId: string, input: { leaseTtlMs?: number; sessionId?: string; memberId?: string }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.claim", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      const existing = current.claim;
      if (existing && existing.leaseExpiresAt > context.now) throw new BoardClaimError("Board task is already claimed");
      if (existing && (current.sessionBinding || current.status === "active")) throw new BoardClaimError("Expired active claim is orphaned and requires takeover");
      if (current.status !== "open") throw new BoardClaimError("Only open board tasks may be claimed");
      const generation = Math.max(current.claimGeneration ?? 0, existing?.generation ?? 0) + 1;
      const claim = {
        claimantId: context.actor.actorId,
        principalId: context.principalId,
        actorType: context.actor.actorType,
        generation,
        claimedAt: context.now,
        leaseExpiresAt: this.leaseExpiry(input.leaseTtlMs, context.now),
      };
      let sessionBinding = current.sessionBinding;
      if (input.sessionId !== undefined || input.memberId !== undefined) {
        if (!input.sessionId || !input.memberId) throw new BoardClaimError("sessionId and memberId must be supplied together");
        sessionBinding = await this.validSessionBinding(input.sessionId, input.memberId, options.principal, current.sessionBinding, context.now);
      }
      const next = parseBoardTask({ ...current, claimGeneration: generation, claim, ...(sessionBinding ? { sessionBinding } : {}), revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("task.claimed", next, { claimGeneration: generation, ...(sessionBinding ? { sessionId: sessionBinding.sessionId } : {}) });
      return next;
    });
  }

  async renew(taskId: string, input: { claimGeneration: number; leaseTtlMs?: number }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.renew", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      const claim = this.requireLiveOwnedClaim(current, context.principalId, input.claimGeneration, context.now);
      const nextClaim = { ...claim, leaseExpiresAt: this.leaseExpiry(input.leaseTtlMs, context.now) };
      const next = parseBoardTask({ ...current, claim: nextClaim, revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("task.claim.renewed", next, { claimGeneration: claim.generation });
      return next;
    });
  }

  async release(taskId: string, input: { claimGeneration: number }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.release", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      this.requireOwnedClaim(current, context.principalId, input.claimGeneration);
      if (!terminal(current) && (current.status === "active" || current.sessionBinding)) throw new BoardClaimError("Active or Session-bound work must be handed off with takeover, not released");
      const { claim: _claim, ...rest } = current;
      const next = parseBoardTask({ ...rest, claimGeneration: current.claimGeneration ?? input.claimGeneration, revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("task.released", next, { claimGeneration: input.claimGeneration });
      return next;
    });
  }

  async takeover(taskId: string, input: { leaseTtlMs?: number; reason: string }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.takeover", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      if (!current.claim || current.claim.leaseExpiresAt > context.now) throw new BoardClaimError("Only an expired claim may be taken over");
      if (!await this.canTakeover(current, options.principal, context.now)) throw new BoardAuthorizationError();
      const generation = current.claim.generation + 1;
      const claim = {
        claimantId: context.actor.actorId,
        principalId: context.principalId,
        actorType: context.actor.actorType,
        generation,
        claimedAt: context.now,
        leaseExpiresAt: this.leaseExpiry(input.leaseTtlMs, context.now),
      };
      const next = parseBoardTask({ ...current, claimGeneration: generation, claim, revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("task.taken_over", next, { claimGeneration: generation, reason: input.reason });
      return next;
    });
  }

  async attachEndpoint(taskId: string, input: { endpointId: string; kind: BoardEndpointBindingV1["kind"] }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.attach-endpoint", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      const bindings = current.endpointBindings ?? [];
      if (bindings.some((binding) => binding.kind === input.kind && binding.endpointId === input.endpointId)) {
        throw new BoardConflictError("Board endpoint is already attached");
      }
      const binding: BoardEndpointBindingV1 = {
        kind: input.kind,
        endpointId: input.endpointId,
        principalId: context.principalId,
        attachedAt: context.now,
      };
      const next = parseBoardTask({ ...current, endpointBindings: [...bindings, binding], revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("endpoint.attached", next, { endpointKind: binding.kind, endpointId: binding.endpointId });
      return next;
    });
  }

  async detachEndpoint(taskId: string, input: { endpointId: string; kind: BoardEndpointBindingV1["kind"] }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.detach-endpoint", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      const bindings = current.endpointBindings ?? [];
      const binding = bindings.find((candidate) => candidate.kind === input.kind && candidate.endpointId === input.endpointId);
      if (!binding) throw new BoardConflictError("Board endpoint is not attached");
      if (binding.principalId !== context.principalId && !principalHasScope(options.principal, "board.admin")) throw new BoardAuthorizationError();
      const remaining = bindings.filter((candidate) => candidate !== binding);
      const { endpointBindings: _endpointBindings, ...rest } = current;
      const next = parseBoardTask({
        ...rest,
        ...(remaining.length === 0 ? {} : { endpointBindings: remaining }),
        revision: current.revision + 1,
        updatedAt: context.now,
      });
      this.replace(context.state, next);
      context.emit("endpoint.detached", next, { endpointKind: binding.kind, endpointId: binding.endpointId });
      return next;
    });
  }

  async bindSession(taskId: string, input: { sessionId: string; memberId: string; claimGeneration: number }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.bind-session", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      this.requireLiveOwnedClaim(current, context.principalId, input.claimGeneration, context.now);
      const binding = await this.validSessionBinding(input.sessionId, input.memberId, options.principal, current.sessionBinding, context.now);
      const next = parseBoardTask({ ...current, sessionBinding: binding, revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("session.bound", next, { sessionId: binding.sessionId, claimGeneration: input.claimGeneration });
      return next;
    });
  }

  async linkPlan(taskId: string, input: { sessionId: string; todoIds: string[]; claimGeneration: number }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.link-plan", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      this.requireLiveOwnedClaim(current, context.principalId, input.claimGeneration, context.now);
      if (!current.sessionBinding || current.sessionBinding.sessionId !== input.sessionId) throw new BoardConflictError("Plan must belong to the bound Session");
      await this.assertTodos(input.sessionId, input.todoIds);
      const planBinding: BoardPlanBindingV1 = { sessionId: input.sessionId, todoIds: [...input.todoIds], linkedAt: context.now };
      const next = parseBoardTask({ ...current, planBinding, revision: current.revision + 1, updatedAt: context.now });
      this.replace(context.state, next);
      context.emit("plan.linked", next, { sessionId: input.sessionId, todoIds: [...input.todoIds], claimGeneration: input.claimGeneration });
      return next;
    });
  }

  async handoff(taskId: string, handoff: GatewayHandoffV1, options: BoardMutationOptions, origin?: GatewayHandoffOriginV1): Promise<BoardTaskV1> {
    return this.mutate("board.handoff", taskId, origin === undefined ? handoff : { handoff, origin }, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      if (terminal(current)) throw new BoardConflictError("Terminal board task cannot receive a handoff");
      if (this.isOrphaned(current, context.now)) throw new BoardClaimError("Expired active claim is orphaned and requires takeover");
      this.assertMutableBy(current, context.principalId, context.actor.actorId, context.now);
      const next = parseBoardTask({
        ...current,
        handoff: structuredClone(handoff),
        ...(origin === undefined ? {} : { handoffOrigin: structuredClone(origin) }),
        revision: current.revision + 1,
        updatedAt: context.now,
      });
      this.replace(context.state, next);
      context.emit("handoff.updated", next, { handoff: structuredClone(handoff) });
      return next;
    });
  }

  async transition(taskId: string, input: {
    status?: BoardTaskV1["status"];
    phase?: BoardTaskV1["phase"];
    claimGeneration?: number;
    summary?: string;
    resourceUris?: string[];
    handoff?: GatewayHandoffV1;
    /** Internal server-derived provenance; never accepted from Gateway request input. */
    handoffOrigin?: GatewayHandoffOriginV1;
  }, options: BoardMutationOptions): Promise<BoardTaskV1> {
    return this.mutate("board.transition", taskId, input, options, async (context) => {
      const current = this.requireTask(context.task, taskId);
      if (terminal(current)) throw new BoardConflictError("Terminal board task cannot transition");
      if (this.isOrphaned(current, context.now)) throw new BoardClaimError("Expired active claim is orphaned and requires takeover");
      if (input.status === undefined && input.phase === undefined) throw new BoardConflictError("status or phase is required");
      const claimant = current.claim?.principalId === context.principalId;
      const creator = current.createdBy.actorId === context.actor.actorId;
      const administrator = principalHasScope(options.principal, "board.admin");
      if (current.claim ? !claimant && !administrator : !creator && !administrator) throw new BoardAuthorizationError();
      if (claimant && current.claim!.leaseExpiresAt <= context.now) throw new BoardClaimError("Board claim lease is expired");
      if ((input.status === "active" || input.status === "completed" || input.phase === "execution" || input.phase === "review")) {
        if (input.claimGeneration === undefined) throw new BoardClaimError("claimGeneration is required for active work");
        this.requireLiveOwnedClaim(current, context.principalId, input.claimGeneration, context.now);
      }
      const status = input.status ?? current.status;
      const phase = input.phase ?? current.phase;
      this.assertTransition(current, status, phase);
      if (status === "active") this.assertDependenciesCompleted(context.state, current);
      let result: BoardTaskResultV1 | undefined;
      const handoff = input.handoff ?? current.handoff;
      if (status === "completed") {
        if (current.completionPolicy.requireReview && current.phase !== "review") throw new BoardConflictError("Board task must enter the review phase before completion");
        const summary = input.summary?.trim() || handoff?.summary?.trim();
        if (!summary) throw new BoardConflictError("Completed board task requires a summary");
        if (current.completionPolicy.requireLinkedTodosCompleted) await this.assertLinkedTodosCompleted(current);
        result = {
          summary,
          resourceUris: input.resourceUris ?? handoff?.resourceUris ?? [],
          ...(handoff === undefined ? {} : { handoff: structuredClone(handoff) }),
          completedAt: context.now,
        };
      }
      const next = parseBoardTask({
        ...current,
        status,
        phase,
        revision: current.revision + 1,
        updatedAt: context.now,
        ...(input.handoff === undefined ? {} : {
          handoff: structuredClone(input.handoff),
          ...(input.handoffOrigin === undefined ? {} : { handoffOrigin: structuredClone(input.handoffOrigin) }),
        }),
        ...(result ? { result } : {}),
        ...(status === "cancelled" ? { cancelledAt: context.now } : {}),
      });
      this.replace(context.state, next);
      const type: BoardEventV1["type"] = status === "completed" ? "task.completed" : status === "cancelled" ? "task.cancelled" : "status.changed";
      context.emit(type, next, {
        fromStatus: current.status,
        toStatus: status,
        fromPhase: current.phase,
        toPhase: phase,
        ...(input.claimGeneration === undefined ? {} : { claimGeneration: input.claimGeneration }),
        ...(handoff === undefined ? {} : { handoff: structuredClone(handoff) }),
      });
      return next;
    });
  }

  async observe(afterCursor = 0, limit = 128): Promise<BoardEventPage> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) throw new BoardStoreError("cursor must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new BoardStoreError("limit must be in [1, 512]");
    const state = await this.load();
    if (afterCursor > state.cursor) throw new BoardStoreError("cursor is ahead of the Board event stream");
    const oldestCursor = state.events[0]?.cursor ?? state.cursor + 1;
    const gap = afterCursor < oldestCursor - 1;
    const eligible = state.events.filter((event) => event.cursor > afterCursor);
    const events = eligible.slice(0, limit).map(clone);
    return {
      events,
      oldestCursor,
      nextCursor: events.at(-1)?.cursor ?? afterCursor,
      hasMore: eligible.length > events.length,
      gap,
    };
  }

  isOrphaned(task: BoardTaskV1, now = this.now()): boolean {
    return Boolean(task.claim && task.claim.leaseExpiresAt <= now && (task.sessionBinding || task.status === "active"));
  }

  private async mutate<T>(
    kind: string,
    taskId: string,
    payload: unknown,
    options: BoardMutationOptions,
    operation: (context: MutationContext) => Promise<T>,
  ): Promise<T> {
    requiredMutationOptions(options);
    const actor = boardActorForPrincipal(options.principal);
    const principalId = principalKey(options.principal);
    const hash = payloadHash({ workspaceId: this.workspaceId, kind, taskId, payload });
    return this.serialized(async () => {
      const state = await this.load();
      const now = this.now();
      this.prune(state, now);
      const replay = state.operations.find((entry) => entry.id === options.operationId);
      if (replay) {
        if (replay.payloadHash !== hash || replay.kind !== kind || replay.actorId !== actor.actorId || replay.taskId !== taskId) throw new BoardReplayMismatchError();
        return clone(replay.result as T);
      }
      const task = state.tasks.find((entry) => entry.id === taskId);
      const currentRevision = task?.revision ?? 0;
      if (currentRevision !== options.expectedRevision) throw new BoardConflictError(`Expected board task revision ${options.expectedRevision}, found ${currentRevision}`);
      const emit: MutationContext["emit"] = (type, eventTask, details = {}) => {
        if (!BOARD_EVENT_TYPES.includes(type)) throw new BoardStoreError(`Unsupported board event: ${type}`);
        state.cursor += 1;
        state.events.push(parseBoardEvent({
          version: GATEWAY_STATE_VERSION,
          id: randomUUID(),
          workspaceId: this.workspaceId,
          taskId: eventTask.id,
          revision: eventTask.revision,
          cursor: state.cursor,
          type,
          actorId: actor.actorId,
          createdAt: now,
          ...details,
        }));
      };
      const result = await operation({ state, task, now, actor, principalId, emit });
      const committedRevision = options.expectedRevision + 1;
      state.revision += 1;
      state.updatedAt = now;
      state.operations.push(parseBoardOperation({
        version: GATEWAY_STATE_VERSION,
        id: options.operationId,
        workspaceId: this.workspaceId,
        taskId,
        actorId: actor.actorId,
        kind,
        payloadHash: hash,
        baseRevision: options.expectedRevision,
        committedRevision,
        createdAt: now,
        result: clone(result),
      }));
      this.prune(state, now);
      const validated = parseBoardEnvelope(state);
      await writeGatewayJsonAtomic(this.path, validated, { mode: 0o600, maximumBytes: MAX_BOARD_BYTES });
      return clone(result);
    });
  }

  private empty(now: number): BoardEnvelopeV1 {
    return { version: GATEWAY_STATE_VERSION, workspaceId: this.workspaceId, revision: 0, cursor: 0, tasks: [], operations: [], events: [], createdAt: now, updatedAt: now };
  }

  private replace(state: BoardEnvelopeV1, next: BoardTaskV1): void {
    const index = state.tasks.findIndex((task) => task.id === next.id);
    if (index < 0) throw new BoardNotFoundError(next.id);
    state.tasks[index] = next;
  }

  private requireTask(task: BoardTaskV1 | undefined, id: string): BoardTaskV1 {
    if (!task) throw new BoardNotFoundError(id);
    return task;
  }

  private assertMutableBy(task: BoardTaskV1, principalId: string, actorId: string, now: number): void {
    if (task.createdBy.actorId === actorId) return;
    if (task.claim?.principalId !== principalId || task.claim.leaseExpiresAt <= now) throw new BoardAuthorizationError();
  }

  private requireOwnedClaim(task: BoardTaskV1, principalId: string, generation: number) {
    const claim = task.claim;
    if (!claim || claim.principalId !== principalId || claim.generation !== generation) throw new BoardClaimError("Board claim identity or generation is stale");
    return claim;
  }

  private requireLiveOwnedClaim(task: BoardTaskV1, principalId: string, generation: number, now: number) {
    const claim = this.requireOwnedClaim(task, principalId, generation);
    if (claim.leaseExpiresAt <= now) throw new BoardClaimError("Board claim lease is expired");
    return claim;
  }

  private leaseExpiry(ttl: number | undefined, now: number): number {
    const value = ttl ?? Math.min(300_000, this.maxLeaseTtlMs);
    if (!Number.isSafeInteger(value) || value < 1 || value > this.maxLeaseTtlMs) throw new BoardClaimError(`leaseTtlMs must be in [1, ${this.maxLeaseTtlMs}]`);
    return now + value;
  }

  private async validSessionBinding(
    sessionId: string,
    memberId: string,
    principal: GatewayPrincipal,
    current: BoardSessionBindingV1 | undefined,
    now: number,
  ): Promise<BoardSessionBindingV1> {
    const state = await this.sessionStore.require(sessionId);
    if (state.session.workspaceId !== this.workspaceId) throw new BoardConflictError("Session belongs to a different workspace");
    if (state.session.status !== "active") throw new BoardConflictError("Session is not active");
    const member = state.members.find((candidate) => candidate.id === memberId);
    if (!member || member.principalId !== principalKey(principal) || member.status !== "active" || member.leaseExpiresAt <= now) throw new BoardAuthorizationError();
    return { sessionId, memberId, generation: (current?.generation ?? 0) + 1, boundAt: now };
  }

  private async assertTodos(sessionId: string, todoIds: readonly string[]): Promise<void> {
    const todos = await this.todoStore.list(sessionId);
    const known = new Set(todos.map((todo) => todo.id));
    for (const todoId of todoIds) if (!known.has(todoId)) throw new BoardConflictError(`Todo does not belong to the bound Session: ${todoId}`);
  }

  private async assertLinkedTodosCompleted(task: BoardTaskV1): Promise<void> {
    if (!task.planBinding || task.planBinding.todoIds.length === 0) throw new BoardConflictError("Board task requires a linked Todo plan");
    const todos = await this.todoStore.list(task.planBinding.sessionId);
    const byId = new Map(todos.map((todo) => [todo.id, todo]));
    for (const todoId of task.planBinding.todoIds) {
      if (byId.get(todoId)?.status !== "completed") throw new BoardConflictError(`Linked Todo is not completed: ${todoId}`);
    }
  }

  private async canTakeover(task: BoardTaskV1, principal: GatewayPrincipal, now: number): Promise<boolean> {
    if (principalHasScope(principal, "board.admin")) return true;
    if (!task.sessionBinding) return false;
    const state = await this.sessionStore.require(task.sessionBinding.sessionId);
    return state.members.some((member) => member.role === "owner"
      && member.principalId === principalKey(principal)
      && member.status === "active"
      && member.leaseExpiresAt > now);
  }

  private assertTransition(current: BoardTaskV1, status: BoardTaskV1["status"], phase: BoardTaskV1["phase"]): void {
    const allowed = current.status === status
      || (current.status === "open" && ["active", "blocked", "cancelled"].includes(status))
      || (current.status === "active" && ["blocked", "completed", "cancelled"].includes(status))
      || (current.status === "blocked" && ["open", "active", "cancelled"].includes(status));
    if (!allowed) throw new BoardConflictError(`Invalid board transition ${current.status} -> ${status}`);
    if (phase === "intake" && status === "active") throw new BoardConflictError("Active board task cannot remain in intake");
  }

  private assertDependenciesCompleted(state: BoardEnvelopeV1, task: BoardTaskV1): void {
    const byId = new Map(state.tasks.map((entry) => [entry.id, entry]));
    for (const dependencyId of task.dependencyIds) {
      if (byId.get(dependencyId)?.status !== "completed") throw new BoardConflictError(`Board dependency is not completed: ${dependencyId}`);
    }
  }

  private prune(state: BoardEnvelopeV1, now: number): void {
    if (this.operationRetentionMs !== undefined) state.operations = state.operations.filter((entry) => entry.createdAt > now - this.operationRetentionMs!);
    if (this.eventRetentionMs !== undefined) state.events = state.events.filter((entry) => entry.createdAt > now - this.eventRetentionMs!);
    state.operations = state.operations.slice(-this.maxOperations);
    state.events = state.events.slice(-this.maxEvents);
    if (this.taskRetentionMs !== undefined) {
      const referenced = new Set(state.tasks.flatMap((task) => task.dependencyIds));
      const removed = new Set(state.tasks
        .filter((task) => terminal(task) && !referenced.has(task.id))
        .filter((task) => (task.result?.completedAt ?? task.cancelledAt ?? task.updatedAt) <= now - this.taskRetentionMs!)
        .map((task) => task.id));
      if (removed.size > 0) {
        state.tasks = state.tasks.filter((task) => !removed.has(task.id));
        state.operations = state.operations.filter((entry) => !removed.has(entry.taskId));
        state.events = state.events.filter((entry) => !removed.has(entry.taskId));
      }
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let releaseLocal!: () => void;
    const previous = tails.get(this.path) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => { releaseLocal = resolve; });
    tails.set(this.path, current);
    await previous;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let releaseFile: (() => Promise<void>) | undefined;
    try {
      releaseFile = await properLockfile.lock(this.path, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true },
      });
      return await operation();
    } finally {
      try { if (releaseFile) await releaseFile(); }
      finally {
        releaseLocal();
        if (tails.get(this.path) === current) tails.delete(this.path);
      }
    }
  }
}

export const createBoardStore = (options: BoardStoreOptions): BoardStore => new BoardStore(options);

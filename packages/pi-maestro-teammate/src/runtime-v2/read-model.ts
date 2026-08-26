import { runtimeBrokerModeFromEnv } from "../runtime-broker/rollout.ts";
import type {
  AgentProgressSnapshot,
  AgentRunOutcome,
  AgentRuntimeProjection,
  AgentStatus,
  AgentTurnSnapshot,
  SessionProjectionIdentity,
} from "../shared/types.ts";

export const RUNTIME_READ_MODEL_VERSION = 2 as const;
export const RUNTIME_READ_MODEL_REVISION = 1 as const;
/** Broker domain event carrying a discardable per-window read-model frame. */
export const RUNTIME_READ_MODEL_FRAME_EVENT = "teammate.runtime-read-model.frame.v2";
export const RUNTIME_READ_MODEL_QUERY_EVENT = "teammate:runtime-read-model-query-v2";
export const RUNTIME_READ_MODEL_SNAPSHOT_EVENT = "teammate:runtime-read-model-snapshot-v2";
export const RUNTIME_READ_MODEL_DELTA_EVENT = "teammate:runtime-read-model-delta-v2";
export const RUNTIME_READ_MODEL_UNAVAILABLE_EVENT = "teammate:runtime-read-model-unavailable-v2";

export interface RuntimeReadModelOwnershipV2 extends SessionProjectionIdentity {}

export interface RuntimeReadModelSourceV2 {
  streamId: string;
  revision: number;
  generation: number;
  /** Exact producer owner. Absent only on pre-isolation V2 records. */
  projection?: RuntimeReadModelOwnershipV2;
}

export interface RuntimeAgentReadEntityV2 {
  correlationId: string;
  /** Exact producer owner. The broker bridge installs this on every new row. */
  projection?: RuntimeReadModelOwnershipV2;
  generation: number;
  agent: string;
  name?: string;
  task?: string;
  /** Spawn attribution and visible hierarchy are intentionally independent. */
  spawnedBy?: string;
  parentCorrelationId?: string;
  status: AgentStatus;
  phase?: string;
  startedAt: number;
  lastActivityAt: number;
  resultReadyAt?: number;
  runtime?: AgentRuntimeProjection;
  turn?: AgentTurnSnapshot;
  lastOutcome?: AgentRunOutcome;
  taskIndex?: number;
  /** Graph ordering only. Never interpreted as a parent relationship. */
  dependencies?: number[];
  recentTools?: AgentProgressSnapshot["recentTools"];
  toolCount?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestedModel?: string;
  resolvedModel?: string;
  attemptedModels?: string[];
  lastMessage?: string;
  error?: string;
}

export type RuntimeReadModelChangeV2 =
  | { kind: "upsert"; entity: RuntimeAgentReadEntityV2 }
  | { kind: "tombstone"; correlationId: string; generation: number };

export interface RuntimeReadModelDeltaV2 {
  version: typeof RUNTIME_READ_MODEL_VERSION;
  revision: typeof RUNTIME_READ_MODEL_REVISION;
  kind: "agent-runs-delta";
  baseCursor: number;
  nextCursor: number;
  source: RuntimeReadModelSourceV2;
  changes: RuntimeReadModelChangeV2[];
}

export interface RuntimeReadModelSnapshotV2 {
  version: typeof RUNTIME_READ_MODEL_VERSION;
  revision: typeof RUNTIME_READ_MODEL_REVISION;
  kind: "agent-runs-snapshot";
  cursor: number;
  source: RuntimeReadModelSourceV2;
  agents: RuntimeAgentReadEntityV2[];
}

export interface RuntimeReadModelSourceFrameV2 {
  version: typeof RUNTIME_READ_MODEL_VERSION;
  revision: typeof RUNTIME_READ_MODEL_REVISION;
  kind: "agent-runs-source-frame";
  source: RuntimeReadModelSourceV2;
  batchId: string;
  batchIndex: number;
  batchCount: number;
  reset: boolean;
  changes: RuntimeReadModelChangeV2[];
}

export interface RuntimeReadModelBrokerFrameV2 {
  cursor: number;
  frame: RuntimeReadModelSourceFrameV2;
}

export interface RuntimeReadModelFoldResultV2 {
  projection: RuntimeReadModelProjectionV2;
  accepted: number;
  discarded: number;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
}

function cloneEntity(entity: RuntimeAgentReadEntityV2): RuntimeAgentReadEntityV2 {
  return structuredClone(entity);
}

export function parseRuntimeReadModelOwnershipV2(value: unknown): RuntimeReadModelOwnershipV2 | undefined {
  if (!plainObject(value)
    || !identifier(value.workspaceId)
    || !identifier(value.sessionId)
    || !identifier(value.sourceId)
    || !safeInteger(value.generation, 1)) return undefined;
  return {
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    sourceId: value.sourceId,
    generation: value.generation,
  };
}

function parseSource(value: unknown): RuntimeReadModelSourceV2 | undefined {
  if (!plainObject(value)
    || !identifier(value.streamId)
    || !safeInteger(value.revision, 1)
    || !safeInteger(value.generation, 1)) return undefined;
  const projection = value.projection === undefined
    ? undefined
    : parseRuntimeReadModelOwnershipV2(value.projection);
  if (value.projection !== undefined && !projection) return undefined;
  return {
    streamId: value.streamId,
    revision: value.revision,
    generation: value.generation,
    ...(projection ? { projection } : {}),
  };
}

const AGENT_STATUSES = new Set<AgentStatus>([
  "pending",
  "running",
  "retrying",
  "sleeping",
  "completed",
  "failed",
  "terminated",
]);

function parseEntity(value: unknown): RuntimeAgentReadEntityV2 | undefined {
  if (!plainObject(value)
    || !identifier(value.correlationId)
    || !safeInteger(value.generation, 1)
    || !identifier(value.agent)
    || !AGENT_STATUSES.has(value.status as AgentStatus)
    || !safeInteger(value.startedAt)
    || !safeInteger(value.lastActivityAt)) return undefined;
  for (const key of ["name", "task", "spawnedBy", "parentCorrelationId", "phase", "requestedModel", "resolvedModel", "lastMessage", "error"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return undefined;
  }
  if (value.dependencies !== undefined
    && (!Array.isArray(value.dependencies) || value.dependencies.some((item) => !safeInteger(item)))) return undefined;
  if (value.attemptedModels !== undefined
    && (!Array.isArray(value.attemptedModels) || value.attemptedModels.some((item) => typeof item !== "string"))) return undefined;
  if (value.projection !== undefined && !parseRuntimeReadModelOwnershipV2(value.projection)) return undefined;
  return structuredClone(value) as unknown as RuntimeAgentReadEntityV2;
}

export function parseRuntimeReadModelDeltaV2(value: unknown): RuntimeReadModelDeltaV2 | undefined {
  if (!plainObject(value)
    || value.version !== RUNTIME_READ_MODEL_VERSION
    || value.revision !== RUNTIME_READ_MODEL_REVISION
    || value.kind !== "agent-runs-delta"
    || !safeInteger(value.baseCursor)
    || !safeInteger(value.nextCursor, 1)
    || value.nextCursor <= value.baseCursor
    || !Array.isArray(value.changes)) return undefined;
  const source = parseSource(value.source);
  if (!source) return undefined;
  const changes: RuntimeReadModelChangeV2[] = [];
  for (const change of value.changes) {
    if (!plainObject(change)) return undefined;
    if (change.kind === "upsert") {
      const entity = parseEntity(change.entity);
      if (!entity) return undefined;
      changes.push({ kind: "upsert", entity });
      continue;
    }
    if (change.kind === "tombstone"
      && identifier(change.correlationId)
      && safeInteger(change.generation, 1)) {
      changes.push({ kind: "tombstone", correlationId: change.correlationId, generation: change.generation });
      continue;
    }
    return undefined;
  }
  return {
    version: RUNTIME_READ_MODEL_VERSION,
    revision: RUNTIME_READ_MODEL_REVISION,
    kind: "agent-runs-delta",
    baseCursor: value.baseCursor,
    nextCursor: value.nextCursor,
    source,
    changes,
  };
}

export function parseRuntimeReadModelSourceFrameV2(value: unknown): RuntimeReadModelSourceFrameV2 | undefined {
  if (!plainObject(value)
    || value.version !== RUNTIME_READ_MODEL_VERSION
    || value.revision !== RUNTIME_READ_MODEL_REVISION
    || value.kind !== "agent-runs-source-frame"
    || !identifier(value.batchId)
    || !safeInteger(value.batchIndex)
    || !safeInteger(value.batchCount, 1)
    || value.batchIndex >= value.batchCount
    || (value.reset === true && value.batchIndex !== 0)
    || typeof value.reset !== "boolean"
    || !Array.isArray(value.changes)) return undefined;
  const source = parseSource(value.source);
  if (!source) return undefined;
  const delta = parseRuntimeReadModelDeltaV2({
    version: RUNTIME_READ_MODEL_VERSION,
    revision: RUNTIME_READ_MODEL_REVISION,
    kind: "agent-runs-delta",
    baseCursor: 0,
    nextCursor: 1,
    source,
    changes: value.changes,
  });
  if (!delta) return undefined;
  return {
    version: RUNTIME_READ_MODEL_VERSION,
    revision: RUNTIME_READ_MODEL_REVISION,
    kind: "agent-runs-source-frame",
    source,
    batchId: value.batchId,
    batchIndex: value.batchIndex,
    batchCount: value.batchCount,
    reset: value.reset,
    changes: delta.changes,
  };
}

export function parseRuntimeReadModelSnapshotV2(value: unknown): RuntimeReadModelSnapshotV2 | undefined {
  if (!plainObject(value)
    || value.version !== RUNTIME_READ_MODEL_VERSION
    || value.revision !== RUNTIME_READ_MODEL_REVISION
    || value.kind !== "agent-runs-snapshot"
    || !safeInteger(value.cursor)
    || !Array.isArray(value.agents)) return undefined;
  const source = parseSource(value.source);
  if (!source) return undefined;
  const agents = value.agents.map(parseEntity);
  if (agents.some((agent) => agent === undefined)) return undefined;
  return {
    version: RUNTIME_READ_MODEL_VERSION,
    revision: RUNTIME_READ_MODEL_REVISION,
    kind: "agent-runs-snapshot",
    cursor: value.cursor,
    source,
    agents: agents as RuntimeAgentReadEntityV2[],
  };
}

/**
 * Discardable canonical projection. Live anomalies return false without
 * mutation so callers can reload a full journal-derived snapshot.
 */
export class RuntimeReadModelProjectionV2 {
  readonly #agents = new Map<string, RuntimeAgentReadEntityV2>();
  #cursor = 0;
  #source: RuntimeReadModelSourceV2 = { streamId: "uninitialized", revision: 1, generation: 1 };
  #initialized = false;

  get cursor(): number { return this.#cursor; }
  get source(): RuntimeReadModelSourceV2 { return { ...this.#source }; }

  applySnapshot(input: unknown): boolean {
    const snapshot = parseRuntimeReadModelSnapshotV2(input);
    if (!snapshot) return false;
    if (this.#initialized && snapshot.source.streamId === this.#source.streamId) {
      if (snapshot.source.generation < this.#source.generation) return false;
      if (snapshot.source.generation === this.#source.generation && snapshot.cursor < this.#cursor) return false;
    }
    const next = new Map<string, RuntimeAgentReadEntityV2>();
    for (const agent of snapshot.agents) {
      const existing = next.get(agent.correlationId);
      if (existing && existing.generation > agent.generation) continue;
      next.set(agent.correlationId, cloneEntity(agent));
    }
    this.#agents.clear();
    for (const [id, agent] of next) this.#agents.set(id, agent);
    this.#cursor = snapshot.cursor;
    this.#source = { ...snapshot.source };
    this.#initialized = true;
    return true;
  }

  applyDelta(input: unknown): boolean {
    const delta = parseRuntimeReadModelDeltaV2(input);
    if (!delta
      || delta.baseCursor !== this.#cursor
      || delta.nextCursor <= this.#cursor
      || delta.source.streamId !== this.#source.streamId
      || delta.source.generation !== this.#source.generation
      || JSON.stringify(delta.source.projection) !== JSON.stringify(this.#source.projection)
      || delta.source.revision !== delta.nextCursor) return false;
    const next = new Map([...this.#agents].map(([id, agent]) => [id, cloneEntity(agent)]));
    for (const change of delta.changes) {
      if (change.kind === "upsert") {
        const current = next.get(change.entity.correlationId);
        if (current && change.entity.generation < current.generation) return false;
        next.set(change.entity.correlationId, cloneEntity(change.entity));
        continue;
      }
      const current = next.get(change.correlationId);
      if (current && change.generation < current.generation) return false;
      if (!current || change.generation === current.generation) next.delete(change.correlationId);
    }
    this.#agents.clear();
    for (const [id, agent] of next) this.#agents.set(id, agent);
    this.#cursor = delta.nextCursor;
    this.#source = { ...delta.source };
    return true;
  }

  agent(correlationId: string): RuntimeAgentReadEntityV2 | undefined {
    const agent = this.#agents.get(correlationId);
    return agent ? cloneEntity(agent) : undefined;
  }

  snapshot(): RuntimeReadModelSnapshotV2 {
    return {
      version: RUNTIME_READ_MODEL_VERSION,
      revision: RUNTIME_READ_MODEL_REVISION,
      kind: "agent-runs-snapshot",
      cursor: this.#cursor,
      source: { ...this.#source },
      agents: [...this.#agents.values()]
        .sort((left, right) => left.correlationId.localeCompare(right.correlationId))
        .map(cloneEntity),
    };
  }
}

interface RuntimeReadModelBrokerSourceStateV2 {
  generation: number;
  revision: number;
  projection?: RuntimeReadModelOwnershipV2;
  ids: Set<string>;
}

interface RuntimeReadModelPendingBatchV2 {
  batchId: string;
  generation: number;
  batchCount: number;
  frames: RuntimeReadModelSourceFrameV2[];
}

function sourceEntityKey(sourceId: string, correlationId: string): string {
  return `${sourceId}\0${correlationId}`;
}

export class RuntimeReadModelBrokerAccumulatorV2 {
  readonly #agents = new Map<string, { entity: RuntimeAgentReadEntityV2; sourceId: string }>();
  readonly #sources = new Map<string, RuntimeReadModelBrokerSourceStateV2>();
  readonly #pending = new Map<string, RuntimeReadModelPendingBatchV2>();
  #cursor = 0;
  #accepted = 0;

  get cursor(): number { return this.#cursor; }
  get accepted(): number { return this.#accepted; }

  apply(record: RuntimeReadModelBrokerFrameV2): boolean {
    const frame = parseRuntimeReadModelSourceFrameV2(record.frame);
    if (!safeInteger(record.cursor, 1) || record.cursor <= this.#cursor || !frame) return false;
    const sourceId = frame.source.streamId;
    const previousSource = this.#sources.get(sourceId);
    const pending = this.#pending.get(sourceId);
    const latestGeneration = Math.max(previousSource?.generation ?? 0, pending?.generation ?? 0);
    if (frame.source.generation < latestGeneration) {
      this.#cursor = record.cursor;
      this.#accepted += 1;
      return true;
    }
    if (previousSource && frame.source.generation === previousSource.generation
      && JSON.stringify(frame.source.projection) !== JSON.stringify(previousSource.projection)) return false;

    let batch = pending;
    if (batch && frame.source.generation > batch.generation) {
      this.#pending.delete(sourceId);
      batch = undefined;
    }
    if (!batch) {
      if (frame.batchIndex !== 0) return false;
      const generationReset = !previousSource || frame.source.generation > previousSource.generation;
      if ((generationReset && (!frame.reset || frame.source.revision !== 1))
        || (previousSource && frame.source.generation === previousSource.generation
          && frame.source.revision !== previousSource.revision + 1)) return false;
      batch = {
        batchId: frame.batchId,
        generation: frame.source.generation,
        batchCount: frame.batchCount,
        frames: [frame],
      };
      if (frame.batchCount > 1) this.#pending.set(sourceId, batch);
    } else {
      const previousFrame = batch.frames.at(-1)!;
      if (frame.batchId !== batch.batchId
        || frame.source.generation !== batch.generation
        || JSON.stringify(frame.source.projection) !== JSON.stringify(previousFrame.source.projection)
        || frame.batchCount !== batch.batchCount
        || frame.batchIndex !== batch.frames.length
        || frame.source.revision !== previousFrame.source.revision + 1
        || frame.reset) return false;
      batch.frames.push(frame);
    }

    if (batch.frames.length === batch.batchCount) {
      if (!this.#commitBatch(batch.frames)) return false;
      this.#pending.delete(sourceId);
    }
    this.#cursor = record.cursor;
    this.#accepted += 1;
    return true;
  }

  #commitBatch(frames: readonly RuntimeReadModelSourceFrameV2[]): boolean {
    const first = frames[0]!;
    const last = frames.at(-1)!;
    const sourceId = first.source.streamId;
    const previousSource = this.#sources.get(sourceId);
    const generationReset = !previousSource || first.source.generation > previousSource.generation;
    const nextAgents = new Map(this.#agents);
    const nextIds = generationReset ? new Set<string>() : new Set(previousSource!.ids);
    if (generationReset && previousSource) {
      for (const id of previousSource.ids) nextAgents.delete(sourceEntityKey(sourceId, id));
    }
    for (const change of frames.flatMap((frame) => frame.changes)) {
      if (change.kind === "upsert") {
        const key = sourceEntityKey(sourceId, change.entity.correlationId);
        const current = nextAgents.get(key);
        if (current && change.entity.generation < current.entity.generation) return false;
        const entity = cloneEntity(change.entity);
        if (first.source.projection) entity.projection = { ...first.source.projection };
        nextAgents.set(key, { entity, sourceId });
        nextIds.add(change.entity.correlationId);
        continue;
      }
      const key = sourceEntityKey(sourceId, change.correlationId);
      const current = nextAgents.get(key);
      if (current && change.generation !== current.entity.generation) return false;
      if (current) nextAgents.delete(key);
      nextIds.delete(change.correlationId);
    }
    this.#agents.clear();
    for (const [id, value] of nextAgents) this.#agents.set(id, value);
    this.#sources.set(sourceId, {
      generation: last.source.generation,
      revision: last.source.revision,
      ...(last.source.projection ? { projection: { ...last.source.projection } } : {}),
      ids: nextIds,
    });
    return true;
  }

  snapshot(
    workspaceId: string,
    activeSources?: ReadonlyMap<string, number>,
    projectionSource?: RuntimeReadModelSourceV2,
  ): RuntimeReadModelSnapshotV2 {
    const collapsed = new Map<string, RuntimeAgentReadEntityV2>();
    for (const { entity, sourceId } of this.#agents.values()) {
      if (activeSources) {
        const source = this.#sources.get(sourceId);
        if (!source || activeSources.get(sourceId) !== source.generation) continue;
      }
      if (collapsed.has(entity.correlationId)) {
        throw new Error(`Runtime read-model correlationId is ambiguous across active sources: ${entity.correlationId}`);
      }
      collapsed.set(entity.correlationId, cloneEntity(entity));
    }
    const agents = [...collapsed.values()]
      .sort((left, right) => left.correlationId.localeCompare(right.correlationId));
    return {
      version: RUNTIME_READ_MODEL_VERSION,
      revision: RUNTIME_READ_MODEL_REVISION,
      kind: "agent-runs-snapshot",
      cursor: this.#cursor,
      source: projectionSource
        ? {
          ...projectionSource,
          revision: Math.max(1, this.#cursor),
          ...(projectionSource.projection ? { projection: { ...projectionSource.projection } } : {}),
        }
        : {
          streamId: `workspace:${workspaceId}`,
          revision: Math.max(1, this.#cursor),
          generation: 1,
        },
      agents,
    };
  }
}

export function rebuildRuntimeReadModelFromBrokerFramesV2(
  workspaceId: string,
  records: readonly RuntimeReadModelBrokerFrameV2[],
  activeSources?: ReadonlyMap<string, number>,
): RuntimeReadModelFoldResultV2 {
  const projection = new RuntimeReadModelProjectionV2();
  const accumulator = new RuntimeReadModelBrokerAccumulatorV2();
  for (const record of records) {
    if (!accumulator.apply(record)) {
      return { projection, accepted: accumulator.accepted, discarded: 1 };
    }
  }
  if (!projection.applySnapshot(accumulator.snapshot(workspaceId, activeSources))) {
    return { projection, accepted: 0, discarded: 1 };
  }
  return { projection, accepted: accumulator.accepted, discarded: 0 };
}

export function createRuntimeReadModelDeltaV2(input: {
  previous: RuntimeReadModelSnapshotV2;
  agents: readonly RuntimeAgentReadEntityV2[];
  source: RuntimeReadModelSourceV2;
  nextCursor?: number;
}): RuntimeReadModelDeltaV2 {
  const previous = new Map(input.previous.agents.map((agent) => [agent.correlationId, agent]));
  const next = new Map(input.agents.map((agent) => [agent.correlationId, agent]));
  const changes: RuntimeReadModelChangeV2[] = [];
  for (const agent of next.values()) {
    const before = previous.get(agent.correlationId);
    if (!before || JSON.stringify(before) !== JSON.stringify(agent)) {
      changes.push({ kind: "upsert", entity: cloneEntity(agent) });
    }
  }
  for (const agent of previous.values()) {
    if (!next.has(agent.correlationId)) {
      changes.push({ kind: "tombstone", correlationId: agent.correlationId, generation: agent.generation });
    }
  }
  return {
    version: RUNTIME_READ_MODEL_VERSION,
    revision: RUNTIME_READ_MODEL_REVISION,
    kind: "agent-runs-delta",
    baseCursor: input.previous.cursor,
    nextCursor: input.nextCursor ?? input.previous.cursor + 1,
    source: { ...input.source },
    changes,
  };
}

/** Canonical reads default on with SQLite authority; explicit or invalid overrides fall back to v1. */
export function runtimeV2ReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (runtimeBrokerModeFromEnv(env) !== "sqlite") return false;
  const configured = env.PI_RUNTIME_V2_READ;
  return configured === undefined || configured === "1";
}

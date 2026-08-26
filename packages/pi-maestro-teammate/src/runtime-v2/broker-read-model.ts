import { createHash, randomUUID } from "node:crypto";
import type { AgentStatus } from "../shared/types.ts";
import {
  DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS,
  DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
} from "../runtime-broker/actor-host.ts";
import { RuntimeBrokerClient } from "../runtime-broker/client.ts";
import { assertJsonValue, type ActorLease, type JsonValue } from "../runtime-broker/contracts.ts";
import { canonicalizeRuntimeBrokerWorkspace } from "../runtime-broker/private-state.ts";
import { runtimeBrokerModeFromEnv } from "../runtime-broker/rollout.ts";
import {
  RUNTIME_V2_REVISION,
  RUNTIME_V2_VERSION,
  type ActorAddressV2,
  type RuntimeDomainEventV2,
} from "./contracts.ts";
import {
  RUNTIME_READ_MODEL_FRAME_EVENT,
  RUNTIME_READ_MODEL_REVISION,
  RUNTIME_READ_MODEL_VERSION,
  RuntimeReadModelBrokerAccumulatorV2,
  parseRuntimeReadModelSourceFrameV2,
  type RuntimeAgentReadEntityV2,
  type RuntimeReadModelChangeV2,
  type RuntimeReadModelSnapshotV2,
  type RuntimeReadModelSourceFrameV2,
} from "./read-model.ts";
import { normalizePersistedRuntimeEventV2 } from "./validation.ts";

const RUNTIME_READ_MODEL_FRAME_MAX_BYTES = 128 * 1024;

export interface RuntimeReadModelBrokerBridgeOptions {
  cwd: string;
  sourceId: string;
  mode?: "sqlite";
  client?: RuntimeBrokerClient;
}

/**
 * V1 lifecycle events are admitted through this bridge, but only the broker
 * journal is authoritative for V2 reads. Cockpit and Observe never own its
 * lease or reconciliation lifecycle.
 */
export class RuntimeReadModelBrokerBridge {
  readonly workspaceId: string;
  readonly sourceStreamId: string;
  readonly #actor: ActorAddressV2;
  readonly #client: RuntimeBrokerClient;
  readonly #ownsClient: boolean;
  readonly #lease: ActorLease;
  #streamRevision: number;
  #sourceRevision = 0;
  #previousAgents = new Map<string, RuntimeAgentReadEntityV2>();
  readonly #accumulator = new RuntimeReadModelBrokerAccumulatorV2();
  #cachedSnapshot: RuntimeReadModelSnapshotV2 | undefined;
  #sourceStateSignature = "";
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #disposed = false;

  private constructor(input: {
    workspaceId: string;
    sourceStreamId: string;
    actor: ActorAddressV2;
    client: RuntimeBrokerClient;
    ownsClient: boolean;
    lease: ActorLease;
    streamRevision: number;
  }) {
    this.workspaceId = input.workspaceId;
    this.sourceStreamId = input.sourceStreamId;
    this.#actor = input.actor;
    this.#client = input.client;
    this.#ownsClient = input.ownsClient;
    this.#lease = input.lease;
    this.#streamRevision = input.streamRevision;
    this.#heartbeatTimer = setInterval(() => {
      void this.#client.heartbeatLease({
        actorId: this.#lease.actorId,
        lease: this.#lease,
        ttlMs: DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
      }).catch(() => {
        this.#closed = true;
      });
    }, DEFAULT_RUNTIME_ACTOR_HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  static async connect(options: RuntimeReadModelBrokerBridgeOptions): Promise<RuntimeReadModelBrokerBridge> {
    if ((options.mode ?? runtimeBrokerModeFromEnv()) !== "sqlite") {
      throw new Error("Runtime V2 canonical reads require the sqlite Runtime Broker");
    }
    const workspaceId = createHash("sha256")
      .update(canonicalizeRuntimeBrokerWorkspace(options.cwd), "utf8")
      .digest("hex");
    const sourceKey = createHash("sha256").update(options.sourceId, "utf8").digest("hex").slice(0, 24);
    const sourceStreamId = `runtime-read-model:${workspaceId}:${sourceKey}`;
    const actor: ActorAddressV2 = {
      version: RUNTIME_V2_VERSION,
      revision: RUNTIME_V2_REVISION,
      workspaceId,
      actorKind: "root",
      actorId: `runtime-read-model:${sourceKey}`,
      generation: 1,
    };
    const client = options.client ?? await RuntimeBrokerClient.connectOrStart();
    const ownsClient = options.client === undefined;
    try {
      const lease = await client.acquireLease({
        actorId: sourceStreamId,
        holderId: `process-${process.pid}:${randomUUID()}`,
        ttlMs: DEFAULT_RUNTIME_ACTOR_LEASE_TTL_MS,
      });
      actor.generation = lease.epoch;
      const streamRevision = await client.getStreamRevision(sourceStreamId);
      return new RuntimeReadModelBrokerBridge({
        workspaceId,
        sourceStreamId,
        actor,
        client,
        ownsClient,
        lease,
        streamRevision,
      });
    } catch (error) {
      if (ownsClient) await client.close().catch(() => undefined);
      throw error;
    }
  }

  get generation(): number {
    return this.#lease.epoch;
  }

  async publish(
    agents: readonly RuntimeAgentReadEntityV2[],
    options: { reset?: boolean } = {},
  ): Promise<RuntimeReadModelSnapshotV2> {
    let snapshot: RuntimeReadModelSnapshotV2 | undefined;
    try {
      await this.#enqueue(async () => {
        this.#assertOpen();
        const reset = options.reset === true;
        const frames = this.#createFrames(agents, reset);
        if (frames.length === 0) {
          snapshot = await this.#loadSnapshot();
          return;
        }
        for (const frame of frames) {
          const sequence = this.#streamRevision + 1;
          const event: RuntimeDomainEventV2 = {
            version: RUNTIME_V2_VERSION,
            revision: RUNTIME_V2_REVISION,
            streamId: this.sourceStreamId,
            sequence,
            actor: this.#actor,
            producerEpoch: this.#lease.epoch,
            occurredAt: Date.now(),
            kind: "domain.event",
            eventType: RUNTIME_READ_MODEL_FRAME_EVENT,
            eventId: randomUUID(),
            payload: frame,
          };
          assertJsonValue(event, "runtimeReadModelEvent");
          const result = await this.#client.commit({
            messageId: randomUUID(),
            actorId: this.#lease.actorId,
            lease: this.#lease,
            streamId: this.sourceStreamId,
            expectedRevision: this.#streamRevision,
            events: [{
              eventId: event.eventId,
              eventType: event.kind,
              payload: event as JsonValue,
              occurredAt: event.occurredAt,
            }],
          });
          this.#streamRevision = result.revision;
          this.#sourceRevision = frame.source.revision;
        }
        this.#previousAgents = new Map(agents.map((agent) => [agent.correlationId, structuredClone(agent)]));
        snapshot = await this.#loadSnapshot();
      });
    } catch (error) {
      await this.#dispose();
      throw error;
    }
    return snapshot!;
  }

  async snapshot(): Promise<RuntimeReadModelSnapshotV2> {
    let snapshot: RuntimeReadModelSnapshotV2 | undefined;
    await this.#enqueue(async () => {
      this.#assertOpen();
      snapshot = await this.#loadSnapshot();
    });
    return snapshot!;
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    await this.#dispose();
  }

  async #dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closed = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    await this.#client.releaseLease({ actorId: this.#lease.actorId, lease: this.#lease }).catch(() => undefined);
    if (this.#ownsClient) await this.#client.close();
  }

  #createFrames(
    agents: readonly RuntimeAgentReadEntityV2[],
    reset: boolean,
  ): RuntimeReadModelSourceFrameV2[] {
    const next = new Map(agents.map((agent) => [agent.correlationId, agent]));
    const changes: RuntimeReadModelChangeV2[] = [];
    for (const entity of next.values()) {
      const previous = reset ? undefined : this.#previousAgents.get(entity.correlationId);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(entity)) {
        changes.push({ kind: "upsert", entity: structuredClone(entity) });
      }
    }
    if (!reset) {
      for (const previous of this.#previousAgents.values()) {
        if (!next.has(previous.correlationId)) {
          changes.push({
            kind: "tombstone",
            correlationId: previous.correlationId,
            generation: previous.generation,
          });
        }
      }
    }
    if (!reset && changes.length === 0) return [];

    const batchId = randomUUID();
    const makeFrame = (
      frameChanges: RuntimeReadModelChangeV2[],
      index: number,
      batchCount: number,
    ): RuntimeReadModelSourceFrameV2 => ({
      version: RUNTIME_READ_MODEL_VERSION,
      revision: RUNTIME_READ_MODEL_REVISION,
      kind: "agent-runs-source-frame",
      source: {
        streamId: this.sourceStreamId,
        revision: this.#sourceRevision + index + 1,
        generation: this.#lease.epoch,
      },
      batchId,
      batchIndex: index,
      batchCount,
      reset: reset && index === 0,
      changes: frameChanges,
    });

    if (changes.length === 0) return [makeFrame([], 0, 1)];
    const chunks: RuntimeReadModelChangeV2[][] = [];
    for (const change of changes) {
      const current = chunks.at(-1) ?? [];
      const candidate = [...current, change];
      const frame = makeFrame(candidate, Math.max(0, chunks.length - 1), changes.length);
      if (Buffer.byteLength(JSON.stringify(frame), "utf8") <= RUNTIME_READ_MODEL_FRAME_MAX_BYTES) {
        if (chunks.length === 0) chunks.push(candidate);
        else chunks[chunks.length - 1] = candidate;
        continue;
      }
      if (current.length === 0) throw new Error("Runtime read-model entity exceeds the frame byte budget");
      const nextFrame = makeFrame([change], chunks.length, changes.length);
      if (Buffer.byteLength(JSON.stringify(nextFrame), "utf8") > RUNTIME_READ_MODEL_FRAME_MAX_BYTES) {
        throw new Error("Runtime read-model entity exceeds the frame byte budget");
      }
      chunks.push([change]);
    }
    return chunks.map((chunk, index) => makeFrame(chunk, index, chunks.length));
  }

  async #loadSnapshot(): Promise<RuntimeReadModelSnapshotV2> {
    let afterCursor = this.#accumulator.cursor;
    let added = false;
    while (true) {
      const events = await this.#client.readRuntimeReadModelEvents(this.workspaceId, afterCursor, 128);
      if (events.length === 0) break;
      for (const stored of events) {
        const event = normalizePersistedRuntimeEventV2(stored.payload);
        if (event.kind !== "domain.event" || event.eventType !== RUNTIME_READ_MODEL_FRAME_EVENT) {
          throw new Error("Runtime broker returned a non-read-model event from the read-model query");
        }
        const frame = parseRuntimeReadModelSourceFrameV2(event.payload);
        if (!frame) throw new Error("Runtime broker returned an invalid read-model frame");
        if (!this.#accumulator.apply({ cursor: stored.cursor, frame })) {
          throw new Error("Runtime broker read-model journal is discontinuous");
        }
        afterCursor = stored.cursor;
        added = true;
      }
    }
    const sourceStates = [];
    let afterStreamId: string | undefined;
    while (true) {
      const page = await this.#client.readRuntimeReadModelSources(this.workspaceId, afterStreamId, 128);
      if (page.length === 0) break;
      sourceStates.push(...page);
      afterStreamId = page.at(-1)!.streamId;
    }
    const sourceStateSignature = JSON.stringify(sourceStates);
    if (!added && this.#cachedSnapshot && sourceStateSignature === this.#sourceStateSignature) {
      return structuredClone(this.#cachedSnapshot);
    }
    const activeSources = new Map(
      sourceStates
        .filter((source) => source.active)
        .map((source) => [source.streamId, source.generation]),
    );
    this.#sourceStateSignature = sourceStateSignature;
    this.#cachedSnapshot = this.#accumulator.snapshot(this.workspaceId, activeSources);
    return structuredClone(this.#cachedSnapshot);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(operation);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Runtime read-model broker bridge is closed");
  }
}

export function runtimeAgentStatusFromBrokerOutcome(
  outcome: "completed" | "failed" | "cancelled" | "lost",
): AgentStatus {
  if (outcome === "completed") return "completed";
  if (outcome === "cancelled") return "terminated";
  return "failed";
}

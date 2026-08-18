/** Sequence, idempotency, and lifecycle helpers for remote run state. */

import type { RemoteRunCapture, RemoteRunEvent, RemoteRunSnapshot, RemoteStatus } from "./types.ts";

export const REMOTE_COMMAND_DEDUP_LIMIT = 4096;

export type RemoteSequenceDecision =
  | { accepted: true; expectedSequence: number }
  | { accepted: false; reason: "duplicate" | "gap"; expectedSequence: number };

export class RemoteCommandDeduplicator {
  readonly #limit: number;
  readonly #seen = new Map<string, true>();

  constructor(limit = REMOTE_COMMAND_DEDUP_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Remote command dedup limit must be positive");
    this.#limit = limit;
  }

  accept(commandId: string): boolean {
    if (!commandId || commandId.length > 128) throw new Error("Invalid remote command id");
    if (this.#seen.has(commandId)) return false;
    this.#seen.set(commandId, true);
    while (this.#seen.size > this.#limit) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
    return true;
  }

  get size(): number { return this.#seen.size; }
}

export class RemoteEventSequenceTracker {
  #lastSequence: number;

  constructor(lastSequence = 0) {
    if (!Number.isInteger(lastSequence) || lastSequence < 0) throw new Error("Invalid remote event sequence");
    this.#lastSequence = lastSequence;
  }

  accept(sequence: number): RemoteSequenceDecision {
    const expectedSequence = this.#lastSequence + 1;
    if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid remote event sequence");
    if (sequence <= this.#lastSequence) return { accepted: false, reason: "duplicate", expectedSequence };
    if (sequence !== expectedSequence) return { accepted: false, reason: "gap", expectedSequence };
    this.#lastSequence = sequence;
    return { accepted: true, expectedSequence: sequence + 1 };
  }

  get lastSequence(): number { return this.#lastSequence; }
}

export function createRemoteRunSnapshot(
  capture: RemoteRunCapture,
  status: RemoteStatus = "connecting",
  updatedAt = Date.now(),
): RemoteRunSnapshot {
  return {
    workerId: capture.workerId,
    instanceNonce: capture.instanceNonce,
    runId: capture.runId,
    generation: capture.generation,
    targetId: capture.targetId,
    status,
    lastSequence: 0,
    updatedAt,
  };
}

export function applyRemoteRunEvent(snapshot: RemoteRunSnapshot, event: RemoteRunEvent): RemoteRunSnapshot {
  if (snapshot.workerId !== event.workerId
    || snapshot.instanceNonce !== event.instanceNonce
    || snapshot.runId !== event.runId
    || snapshot.generation !== event.generation) {
    throw new Error("Remote event does not match the captured run identity");
  }
  const tracker = new RemoteEventSequenceTracker(snapshot.lastSequence);
  const decision = tracker.accept(event.sequence);
  if (!decision.accepted) {
    throw new Error(decision.reason === "duplicate"
      ? `Duplicate remote event sequence ${event.sequence}`
      : `Remote event sequence gap: expected ${decision.expectedSequence}, received ${event.sequence}`);
  }
  if (event.type === "run/event") {
    return { ...snapshot, lastSequence: event.sequence, updatedAt: event.updatedAt };
  }
  return {
    ...snapshot,
    status: event.status,
    lastSequence: event.sequence,
    updatedAt: event.updatedAt,
    ...(event.nativeStatus === undefined ? {} : { nativeStatus: event.nativeStatus }),
    ...(event.degradedReason === undefined ? {} : { degradedReason: event.degradedReason }),
    ...(event.type === "run/state" && event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.type === "run/result" && event.result !== undefined ? { summary: event.result } : {}),
  };
}
